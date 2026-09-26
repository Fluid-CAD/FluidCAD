import type { StartProject } from './host';
import { projectCard, type ProjectCardContext, type ProjectCardHandlers } from './project-card';
import { sectionHeading } from './section-heading';

/**
 * "Recent projects": every stored recent (the shell keeps at most twelve) in a
 * grid that reflows with the window, or a short empty state before the first.
 */
export class ProjectGrid {
  readonly element: HTMLElement;
  private readonly grid: HTMLDivElement;
  private readonly empty: HTMLDivElement;

  constructor(
    private readonly handlers: ProjectCardHandlers,
    private readonly menuHost: HTMLElement,
  ) {
    this.element = document.createElement('section');
    this.element.setAttribute('aria-label', 'Recent projects');

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
    this.empty.append(title, 'Create a new project in an empty folder, or open a folder that already holds one.');

    this.element.append(sectionHeading('Recent projects'), this.grid, this.empty);
  }

  render(projects: StartProject[], home: string): void {
    const context: ProjectCardContext = { home, menuHost: this.menuHost };
    this.grid.replaceChildren(...projects.map((project) => projectCard(project, context, this.handlers)));
    this.grid.classList.toggle('hidden', projects.length === 0);
    this.empty.classList.toggle('hidden', projects.length > 0);
  }
}
