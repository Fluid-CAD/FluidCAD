import { ICON_CHEVRON_RIGHT } from './icons';

/**
 * The card the header reads as — the same surface the docked column's other
 * chrome uses, so the sections stack as one column of cards over the scene.
 */
const HEADER_CLASS =
  'flex items-center gap-2 px-3 py-2 panel-bg border border-base-content/10 rounded-md cursor-pointer select-none shrink-0';
/** Bodies float bare over the scene under their header, and scroll in place. */
const BODY_CLASS = 'py-1 overflow-y-auto min-h-0';

export interface AccordionSectionOptions {
  /** Whether the section starts open. Default true. */
  expanded?: boolean;
  /** Whether the section is on screen at all, header included. Default true. */
  visible?: boolean;
  /** Markup placed in the header after the title — counts, menu buttons. */
  trailing?: string;
  /** Extra body classes on top of the shared scroll behaviour. */
  bodyClass?: string;
}

/**
 * One collapsible section of a docked panel column: History, Shapes and
 * Parameters are all this shape.
 *
 * The collapse is published rather than kept private ({@link onToggle},
 * {@link setExpanded}) because the column, not the section, owns the policy:
 * Shapes and Parameters are mutually exclusive, so one opening has to close
 * the other, and the two are also driven from outside their own headers.
 *
 * Visibility is a second, independent axis — a section can be off screen
 * entirely without losing which state it would come back in.
 */
export class AccordionSection {
  /** The clickable header card. Mount it directly above {@link body}. */
  readonly header: HTMLDivElement;
  /** The section's scrolling content. */
  readonly body: HTMLDivElement;

  /** Fired after every real expand/collapse, a header click included. */
  onToggle?: (section: AccordionSection) => void;

  private readonly chevron: HTMLSpanElement;
  private expanded: boolean;
  private visible: boolean;

  constructor(title: string, options: AccordionSectionOptions = {}) {
    this.expanded = options.expanded !== false;
    this.visible = options.visible !== false;

    this.header = document.createElement('div');
    this.header.className = HEADER_CLASS;
    this.header.innerHTML = `
      <span data-ref="chevron" class="flex items-center justify-center w-5 h-5 opacity-50 transition-transform">${ICON_CHEVRON_RIGHT}</span>
      <span class="text-sm font-medium text-base-content/70">${title}</span>
      ${options.trailing ?? ''}
    `;
    this.chevron = this.header.querySelector<HTMLSpanElement>('[data-ref="chevron"]')!;

    this.body = document.createElement('div');
    this.body.className = options.bodyClass ? `${BODY_CLASS} ${options.bodyClass}` : BODY_CLASS;

    this.header.addEventListener('click', () => {
      this.setExpanded(!this.expanded);
    });
    this.apply();
  }

  /** Append the section's header and body, in order, to the end of `host`. */
  mount(host: HTMLElement): void {
    host.appendChild(this.header);
    host.appendChild(this.body);
  }

  get isExpanded(): boolean {
    return this.expanded;
  }

  /** Open or close the section. A real change notifies {@link onToggle}. */
  setExpanded(expanded: boolean): void {
    if (this.expanded === expanded) {
      return;
    }
    this.expanded = expanded;
    this.apply();
    this.onToggle?.(this);
  }

  get isVisible(): boolean {
    return this.visible;
  }

  /** Show or hide the whole section — the header goes with the body. */
  setVisible(visible: boolean): void {
    if (this.visible === visible) {
      return;
    }
    this.visible = visible;
    this.apply();
  }

  private apply(): void {
    this.header.classList.toggle('hidden', !this.visible);
    this.body.classList.toggle('hidden', !this.visible || !this.expanded);
    this.chevron.classList.toggle('rotate-90', this.expanded);
  }
}
