import { createBrand } from '../ui/brand';
import { shortenPath } from './format';

export type StartTopBarHandlers = {
  openProject(): Promise<void>;
  newProject(): Promise<void>;
};

/**
 * The start screen's top bar, built like the product's: the same height,
 * surface and border, with the brand where the product's sits. Where a
 * project's bar names the workspace, this one says what to do; the two
 * project actions sit at the right.
 */
export class StartTopBar {
  readonly element: HTMLElement;
  private readonly buttons: HTMLButtonElement[];
  private readonly hint: HTMLSpanElement;
  private readonly openButton: HTMLButtonElement;

  constructor(private readonly handlers: StartTopBarHandlers) {
    this.element = document.createElement('header');
    this.element.className =
      'relative z-10 h-12 shrink-0 flex items-center gap-2 px-3 panel-bg border-b border-base-content/10 select-none';

    const divider = document.createElement('div');
    divider.className = 'w-px h-5 bg-base-content/15 mx-1 shrink-0';
    const hint = document.createElement('span');
    hint.className = 'text-sm text-base-content/60 truncate';
    hint.textContent = 'Pick a project to open.';
    const spacer = document.createElement('div');
    spacer.className = 'flex-1';

    const open = this.button('Open Project', 'btn btn-sm btn-outline', () => this.handlers.openProject());
    const create = this.button('New Project', 'btn btn-sm btn-primary', () => this.handlers.newProject());
    this.buttons = [open, create];
    this.hint = hint;
    this.openButton = open;

    this.element.append(createBrand().element, divider, hint, spacer, open, create);
  }

  /**
   * With a projects folder, every project is on the page already, so there is
   * nothing for Open Project to find; the bar names the folder instead.
   */
  setProjectsRoot(root: string | null, home: string): void {
    this.openButton.classList.toggle('hidden', root !== null);
    this.hint.textContent = root === null ? 'Pick a project to open.' : `Projects in ${shortenPath(root, home)}.`;
    this.hint.title = root ?? '';
  }

  private button(label: string, className: string, action: () => Promise<void>): HTMLButtonElement {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = className;
    button.textContent = label;
    button.addEventListener('click', () => void this.busyWhile(action));
    return button;
  }

  /** One native dialog at a time: both buttons wait while either one's dialog is up. */
  private async busyWhile(action: () => Promise<void>): Promise<void> {
    for (const button of this.buttons) {
      button.disabled = true;
    }
    try {
      await action();
    } finally {
      for (const button of this.buttons) {
        button.disabled = false;
      }
    }
  }
}
