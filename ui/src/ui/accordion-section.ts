import { ICON_CHEVRON_RIGHT } from './icons';

/**
 * The card the header reads as — the same surface the docked column's other
 * chrome uses, so the sections stack as one column of cards over the scene.
 */
const HEADER_CLASS =
  'flex items-center gap-2 px-3 py-2 panel-bg border border-base-content/10 rounded-md cursor-pointer select-none shrink-0';
/** Bodies float bare over the scene under their header, and scroll in place. */
const BODY_CLASS = 'py-1 overflow-y-auto min-h-0';
/**
 * A sheet body instead ({@link AccordionSectionOptions.sheet}): the header's
 * own surface carried on below it, so a section whose rows are controls
 * reads as one panel rather than as fields floating over the model.
 *
 * `-mt-1` cancels the column's `gap-1` so the two halves actually meet, and
 * the header drops its bottom edge while this is showing (see
 * {@link HEADER_JOINED}) so no hairline crosses the middle of the card.
 */
const BODY_SHEET_CLASS =
  '-mt-1 pt-1 pb-2 overflow-y-auto min-h-0 panel-bg border border-t-0 '
  + 'border-base-content/10 rounded-b-md';
/**
 * What the header gives up while its sheet body is open. The background is
 * painted under the transparent border, not clipped to it, so the seam
 * closes rather than opening a gap onto the scene.
 */
const HEADER_JOINED = ['rounded-b-none', 'border-b-transparent'];

export interface AccordionSectionOptions {
  /** Whether the section starts open. Default true. */
  expanded?: boolean;
  /** Whether the section is on screen at all, header included. Default true. */
  visible?: boolean;
  /** Markup placed in the header after the title — counts, menu buttons. */
  trailing?: string;
  /** Extra body classes on top of the shared scroll behaviour. */
  bodyClass?: string;
  /**
   * Draw the body as a continuation of the header card rather than bare over
   * the scene. For sections whose rows are controls, not text: a field needs
   * a surface to read as something you can type into, and the whole point of
   * the transparent body is that a list of names does not. Default false.
   */
  sheet?: boolean;
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
 *
 * {@link AccordionSectionOptions.sheet} is a third: whether the body floats
 * bare over the scene (History, Shapes) or continues the header's card
 * (Parameters).
 */
export class AccordionSection {
  /** The clickable header card. Mount it directly above {@link body}. */
  readonly header: HTMLDivElement;
  /** The section's scrolling content. */
  readonly body: HTMLDivElement;

  /** Fired after every real expand/collapse, a header click included. */
  onToggle?: (section: AccordionSection) => void;

  private readonly chevron: HTMLSpanElement;
  private readonly sheet: boolean;
  private expanded: boolean;
  private visible: boolean;

  constructor(title: string, options: AccordionSectionOptions = {}) {
    this.expanded = options.expanded !== false;
    this.visible = options.visible !== false;
    this.sheet = options.sheet === true;

    this.header = document.createElement('div');
    this.header.className = HEADER_CLASS;
    this.header.innerHTML = `
      <span data-ref="chevron" class="flex items-center justify-center w-5 h-5 opacity-50 transition-transform">${ICON_CHEVRON_RIGHT}</span>
      <span class="text-sm font-medium text-base-content/70">${title}</span>
      ${options.trailing ?? ''}
    `;
    this.chevron = this.header.querySelector<HTMLSpanElement>('[data-ref="chevron"]')!;

    this.body = document.createElement('div');
    const bodyBase = this.sheet ? BODY_SHEET_CLASS : BODY_CLASS;
    this.body.className = options.bodyClass ? `${bodyBase} ${options.bodyClass}` : bodyBase;

    this.header.addEventListener('click', () => {
      this.setExpanded(!this.expanded);
    });
    this.apply();
  }

  /**
   * What a section shows in place of rows when it has none: the thing that is
   * missing, then the call that would make one. Italic and dimmed so it reads
   * as a note about the section rather than as its first row — the same
   * surface the assembly rail's Parts and Joints sections use, kept here so
   * every empty column looks like the same column.
   */
  static emptyState(message: string): string {
    return `<div class="px-3 py-2 text-xs text-base-content/40 italic">${message}</div>`;
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
    const showingBody = this.visible && this.expanded;
    this.header.classList.toggle('hidden', !this.visible);
    this.body.classList.toggle('hidden', !showingBody);
    this.chevron.classList.toggle('rotate-90', this.expanded);
    // Only while there is a sheet under it: closed, the header is a card
    // like every other one in the column.
    if (this.sheet) {
      this.header.classList.toggle(HEADER_JOINED[0], showingBody);
      this.header.classList.toggle(HEADER_JOINED[1], showingBody);
    }
  }
}
