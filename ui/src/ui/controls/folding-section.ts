import { ICON_CHEVRON_RIGHT } from '../icons';

export interface FoldingSectionOptions {
  title: string;
  /** Starts folded. */
  folded?: boolean;
  /** The classes the heading wears beside its own layout — the caller's heading look. */
  headingClass?: string;
  /** The classes of the root and of the body it folds — the caller's column. */
  columnClass?: string;
}

/**
 * Items under a heading that folds them away: the heading is a button
 * (`aria-expanded`) with a caret, the body hides while folded. DOM only —
 * the caller fills {@link body} and hears {@link onToggle}.
 */
export class FoldingSection {
  readonly root: HTMLDivElement;
  readonly body: HTMLDivElement;
  /** The user folded or unfolded the section. */
  onToggle?: (folded: boolean) => void;

  private readonly heading: HTMLButtonElement;
  private readonly caret: HTMLSpanElement;
  private isFolded = false;

  constructor(opts: FoldingSectionOptions) {
    this.root = document.createElement('div');
    this.root.className = opts.columnClass ?? '';
    this.heading = document.createElement('button');
    this.heading.type = 'button';
    this.heading.dataset.role = 'section-toggle';
    this.heading.className = `flex items-center gap-1 w-full text-left cursor-pointer ${opts.headingClass ?? ''}`.trim();
    this.caret = document.createElement('span');
    this.caret.className = 'flex items-center justify-center transition-transform [&>svg]:size-2.5';
    this.caret.setAttribute('aria-hidden', 'true');
    this.caret.innerHTML = ICON_CHEVRON_RIGHT;
    const title = document.createElement('span');
    title.textContent = opts.title;
    this.heading.append(this.caret, title);
    this.heading.addEventListener('click', () => {
      this.setFolded(!this.isFolded);
      this.onToggle?.(this.isFolded);
    });
    this.body = document.createElement('div');
    this.body.dataset.role = 'section-body';
    this.body.className = opts.columnClass ?? '';
    this.root.append(this.heading, this.body);
    this.setFolded(opts.folded === true);
  }

  get folded(): boolean {
    return this.isFolded;
  }

  /** Fold or unfold without telling {@link onToggle} — the caller's own move. */
  setFolded(folded: boolean): void {
    this.isFolded = folded;
    this.heading.setAttribute('aria-expanded', String(!folded));
    this.caret.classList.toggle('rotate-90', !folded);
    this.body.classList.toggle('hidden', folded);
  }
}
