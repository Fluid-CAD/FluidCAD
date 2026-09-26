import type { FeedTutorial } from './host';
import { PREVIEW_BOX, PREVIEW_IMAGE, previewPlaceholder } from './project-card';
import { sectionHeading } from './section-heading';

const CARD =
  'group relative flex flex-col min-w-0 bg-base-200 border border-base-content/10 rounded-lg overflow-hidden ' +
  'cursor-pointer outline-none transition-colors hover:border-base-content/25 ' +
  'focus-visible:border-primary focus-visible:ring-2 focus-visible:ring-primary/40';

/**
 * "Learn FluidCAD": the feed's tutorials, a little smaller than the project
 * cards. A click leaves for the browser. Hidden while the feed has none — an
 * offline first run shows no empty section.
 */
export class LearnPanel {
  readonly element: HTMLElement;
  private readonly list: HTMLDivElement;

  constructor(private readonly openLink: (url: string) => void) {
    this.element = document.createElement('section');
    this.element.className = 'hidden mt-8';
    this.element.setAttribute('aria-label', 'Learn FluidCAD');
    this.list = document.createElement('div');
    this.list.className = 'grid gap-3.5 grid-cols-[repeat(auto-fill,minmax(170px,1fr))]';
    this.element.append(sectionHeading('Learn FluidCAD'), this.list);
  }

  render(tutorials: FeedTutorial[]): void {
    this.list.replaceChildren(...tutorials.map((entry) => this.card(entry)));
    this.element.classList.toggle('hidden', tutorials.length === 0);
  }

  private card(entry: FeedTutorial): HTMLElement {
    const card = document.createElement('div');
    card.className = CARD;
    card.tabIndex = 0;
    card.setAttribute('role', 'link');
    card.title = entry.url;

    // The feed's pictures are composed square already; show them whole.
    const box = document.createElement('div');
    box.className = PREVIEW_BOX;
    if (entry.thumbnail) {
      const img = document.createElement('img');
      img.className = PREVIEW_IMAGE;
      img.src = entry.thumbnail;
      img.alt = '';
      img.draggable = false;
      box.appendChild(img);
    } else {
      box.appendChild(previewPlaceholder(null));
    }

    const body = document.createElement('div');
    body.className = 'px-3 pt-2 pb-2.5 grid gap-0.5 min-w-0';
    const title = document.createElement('div');
    title.className = 'font-semibold text-[13px] text-base-content';
    title.textContent = entry.title;
    body.appendChild(title);
    if (entry.description) {
      const description = document.createElement('div');
      description.className = 'text-xs text-base-content/60 line-clamp-2';
      description.textContent = entry.description;
      body.appendChild(description);
    }

    card.addEventListener('click', () => this.openLink(entry.url));
    card.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        this.openLink(entry.url);
      }
    });
    card.append(box, body);
    return card;
  }
}
