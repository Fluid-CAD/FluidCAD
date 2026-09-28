import type { StartProject } from './host';
import { projectCard, type ProjectCardContext, type ProjectCardHandlers } from './project-card';
import { sectionHeading } from './section-heading';

/** What the grid shows: the recents, or every project in a projects folder. */
export type ProjectGridView = {
  home: string;
  /** The launcher keeps every project in one folder, and this is that folder's listing. */
  rooted: boolean;
};

export type ProjectGridOptions = {
  /** How many projects one page holds. */
  pageSize?: number;
};

/** A page of projects: enough to fill two rows on a wide window without scrolling past the next section. */
export const DEFAULT_PAGE_SIZE = 8;

const COPY = {
  recents: {
    heading: 'Recent projects',
    empty: 'Create a new project in an empty folder, or open a folder that already holds one.',
  },
  rooted: {
    heading: 'Projects',
    empty: 'Create a new project: it is set up in your projects folder and opens here.',
  },
};

const PAGE_BUTTON = 'btn btn-sm btn-ghost';

/** Whether `project` is one the filter's text names: a case-insensitive part of its name. */
function matches(project: StartProject, query: string): boolean {
  return query === '' || project.name.toLowerCase().includes(query);
}

/** Most recently opened first; projects never opened (an empty date) after every opened one, in the order given. */
function byMostRecent(projects: StartProject[]): StartProject[] {
  return [...projects].sort((a, b) => (a.lastOpenedAt === b.lastOpenedAt ? 0 : b.lastOpenedAt.localeCompare(a.lastOpenedAt)));
}

/**
 * "Recent projects": every stored recent (the shell keeps at most twelve) in a
 * grid that reflows with the window, or a short empty state before the first.
 * With a projects folder, "Projects": everything in that folder.
 *
 * The grid shows one page at a time, most recently opened first, with a pager
 * under it once there is more than a page. A filter box in the heading row
 * narrows the grid by name and goes back to the first page; what is typed, and
 * the page turned to, stay put while the list is re-read behind them.
 */
export class ProjectGrid {
  readonly element: HTMLElement;
  private readonly pageSize: number;
  private readonly heading: HTMLHeadingElement;
  private readonly filter: HTMLInputElement;
  private readonly grid: HTMLDivElement;
  private readonly empty: HTMLDivElement;
  private readonly emptyHint: Text;
  private readonly noMatch: HTMLDivElement;
  private readonly pager: HTMLDivElement;
  private readonly pageRange: HTMLSpanElement;
  private readonly prevBtn: HTMLButtonElement;
  private readonly nextBtn: HTMLButtonElement;
  private projects: StartProject[] = [];
  private view: ProjectGridView = { home: '', rooted: false };
  /** The page on show, from 0. */
  private page = 0;

  constructor(
    private readonly handlers: ProjectCardHandlers,
    private readonly menuHost: HTMLElement,
    options: ProjectGridOptions = {},
  ) {
    this.pageSize = Math.max(1, Math.floor(options.pageSize ?? DEFAULT_PAGE_SIZE));
    this.element = document.createElement('section');
    this.element.setAttribute('aria-label', COPY.recents.heading);

    this.heading = sectionHeading(COPY.recents.heading);
    this.heading.classList.remove('mb-3');
    this.filter = document.createElement('input');
    this.filter.type = 'search';
    this.filter.className = 'input input-sm w-56 max-w-full';
    this.filter.placeholder = 'Filter projects';
    this.filter.setAttribute('aria-label', 'Filter projects by name');
    this.filter.spellcheck = false;
    this.filter.dataset.projectFilter = '';
    this.filter.addEventListener('input', () => {
      this.page = 0;
      this.apply();
    });
    this.filter.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && this.filter.value !== '') {
        event.stopPropagation();
        this.filter.value = '';
        this.page = 0;
        this.apply();
      }
    });
    const headingRow = document.createElement('div');
    headingRow.className = 'flex items-center justify-between gap-3 mb-3';
    headingRow.append(this.heading, this.filter);

    this.grid = document.createElement('div');
    this.grid.className = 'grid gap-4 grid-cols-[repeat(auto-fill,minmax(200px,1fr))]';
    this.grid.dataset.projectGrid = '';

    this.empty = document.createElement('div');
    this.empty.className =
      'hidden text-center text-sm text-base-content/60 px-5 py-16 border border-dashed border-base-content/15 rounded-lg';
    this.empty.dataset.empty = '';
    const title = document.createElement('strong');
    title.className = 'block text-[15px] text-base-content mb-1';
    title.textContent = 'No projects yet';
    this.emptyHint = document.createTextNode(COPY.recents.empty);
    this.empty.append(title, this.emptyHint);

    this.noMatch = document.createElement('div');
    this.noMatch.className = 'hidden text-sm text-base-content/60 px-1 py-6';
    this.noMatch.dataset.noMatch = '';
    this.noMatch.setAttribute('aria-live', 'polite');

    this.pager = document.createElement('div');
    this.pager.className = 'hidden flex items-center justify-end gap-2 mt-4';
    this.pager.dataset.pager = '';
    this.pager.setAttribute('role', 'navigation');
    this.pager.setAttribute('aria-label', 'Project pages');
    this.pageRange = document.createElement('span');
    this.pageRange.className = 'text-xs text-base-content/60 mr-1';
    this.pageRange.dataset.pageRange = '';
    this.pageRange.setAttribute('aria-live', 'polite');
    this.prevBtn = this.pageButton('Previous', -1);
    this.prevBtn.dataset.pagePrev = '';
    this.nextBtn = this.pageButton('Next', 1);
    this.nextBtn.dataset.pageNext = '';
    this.pager.append(this.pageRange, this.prevBtn, this.nextBtn);

    this.element.append(headingRow, this.grid, this.empty, this.noMatch, this.pager);
  }

  private pageButton(label: string, step: number): HTMLButtonElement {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = PAGE_BUTTON;
    button.textContent = label;
    button.addEventListener('click', () => {
      this.page += step;
      this.apply();
      // The cards changed under the pointer; the page's top is where reading starts again.
      this.element.scrollIntoView({ block: 'start' });
    });
    return button;
  }

  render(projects: StartProject[], view: ProjectGridView): void {
    const copy = view.rooted ? COPY.rooted : COPY.recents;
    this.heading.textContent = copy.heading;
    this.element.setAttribute('aria-label', copy.heading);
    this.emptyHint.textContent = copy.empty;
    this.projects = byMostRecent(projects);
    this.view = view;
    this.apply();
  }

  /** Draw the page of projects the filter lets through, from the last list rendered. */
  private apply(): void {
    const query = this.filter.value.trim().toLowerCase();
    const matching = this.projects.filter((project) => matches(project, query));
    const pages = Math.max(1, Math.ceil(matching.length / this.pageSize));
    // A list that shrank behind the page turned to still shows its last page, never an empty one.
    this.page = Math.min(Math.max(0, this.page), pages - 1);
    const first = this.page * this.pageSize;
    const shown = matching.slice(first, first + this.pageSize);

    const context: ProjectCardContext = { home: this.view.home, menuHost: this.menuHost, rooted: this.view.rooted };
    this.grid.replaceChildren(...shown.map((project) => projectCard(project, context, this.handlers)));
    // Nothing to filter before the first project; the box stays while a filter hides them all.
    this.filter.classList.toggle('hidden', this.projects.length === 0);
    this.grid.classList.toggle('hidden', shown.length === 0);
    this.empty.classList.toggle('hidden', this.projects.length > 0);
    const noMatch = this.projects.length > 0 && matching.length === 0;
    this.noMatch.textContent = noMatch ? `No project is named "${this.filter.value.trim()}". Clear the filter to see every project.` : '';
    this.noMatch.classList.toggle('hidden', !noMatch);

    this.pager.classList.toggle('hidden', pages < 2);
    this.pageRange.textContent = `${first + 1}–${first + shown.length} of ${matching.length}`;
    this.prevBtn.disabled = this.page === 0;
    this.nextBtn.disabled = this.page >= pages - 1;
  }
}
