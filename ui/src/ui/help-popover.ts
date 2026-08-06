/**
 * The "?" affordance beside a dialog field, and the panel it opens on hover:
 * the long-form explanation a `title` tooltip cannot carry — headings, worked
 * examples, the code the field ends up writing.
 *
 * It renders into a HOST OUTSIDE the dialog body on purpose. A create-feature
 * panel's body is a fixed-width scroller (`w-60 overflow-y-auto`, see
 * PanelShell), so anything laid out inside it is clipped at the dialog's own
 * edges; the popover is appended to the viewport container instead and
 * positioned from the icon's screen rect, which leaves it free to open into the
 * viewport beside the dialog.
 */
export class HelpPopover {
  private el: HTMLDivElement | null = null;

  /**
   * @param host  Where the popover is appended — the viewport container, not
   *              the scrolling dialog body (see the class note).
   * @param anchor The "?" element; hover and keyboard focus both open it.
   * @param contentHtml Static markup — this never interpolates user text.
   * @param opts.clearOf An element the popover must open clear of — the dialog
   *        the icon sits in. Without it the icon's own left edge is the only
   *        thing cleared, which leaves the popover lying over the dialog's
   *        left margin (the icon sits a label's width inside it).
   */
  constructor(
    private readonly host: HTMLElement,
    private readonly anchor: HTMLElement,
    private readonly contentHtml: string,
    private readonly opts: { clearOf?: HTMLElement } = {},
  ) {
    this.anchor.addEventListener('mouseenter', () => this.show());
    this.anchor.addEventListener('mouseleave', () => this.hide());
    // Keyboard reaches it too: the icon is focusable, and a click focuses it,
    // which is what opens the panel for anyone not hovering (touch included).
    this.anchor.addEventListener('focus', () => this.show());
    this.anchor.addEventListener('blur', () => this.hide());
  }

  get isOpen(): boolean {
    return this.el !== null;
  }

  show(): void {
    if (this.el) {
      return;
    }
    const el = document.createElement('div');
    el.className = 'absolute z-[1002] w-[300px] max-w-[calc(100%-16px)] bg-base-100 border border-base-300 '
      + 'text-base-content rounded-lg shadow-lg px-3 py-2.5 text-[11px] leading-snug '
      + 'select-none pointer-events-none';
    el.setAttribute('role', 'tooltip');
    el.innerHTML = this.contentHtml;
    this.host.appendChild(el);
    this.el = el;
    this.place();
  }

  hide(): void {
    this.el?.remove();
    this.el = null;
  }

  /** Drop the popover and stop answering the icon (panel teardown). */
  destroy(): void {
    this.hide();
  }

  /**
   * Beside the dialog, never over it: the popover's right edge sits just left
   * of whatever it has to clear, and its top tracks the icon — pulled back
   * inside the viewport when the panel is tall enough to run off the bottom.
   */
  private place(): void {
    const el = this.el;
    if (!el) {
      return;
    }
    const anchor = this.anchor.getBoundingClientRect();
    const clear = (this.opts.clearOf ?? this.anchor).getBoundingClientRect();
    const host = this.host.getBoundingClientRect();
    // On the bottom-sheet layout (see DIALOG_DOCK_CLASS) the dialog spans the
    // full width, so there is no room beside it — open above the sheet instead.
    if (Math.min(anchor.left, clear.left) - host.left < el.offsetWidth + 16) {
      el.style.right = '8px';
      el.style.top = `${Math.max(8, clear.top - host.top - el.offsetHeight - 10)}px`;
      return;
    }
    el.style.right = `${Math.max(8, host.right - Math.min(anchor.left, clear.left) + 10)}px`;
    const top = anchor.top - host.top - 6;
    const maxTop = Math.max(8, host.height - el.offsetHeight - 8);
    el.style.top = `${Math.max(8, Math.min(top, maxTop))}px`;
  }
}

/**
 * The icon's markup, for panels that build their body from an HTML string. It
 * is a real button so focus reaches it; `data-role` is how the panel finds it
 * to wire up its {@link HelpPopover}.
 */
export function helpIconHtml(role: string, label: string): string {
  return `<button type="button" data-role="${role}" aria-label="${label}"
    class="shrink-0 w-3.5 h-3.5 leading-none rounded-full border border-base-content/30
      text-[9px] font-semibold text-base-content/50 hover:text-primary hover:border-primary
      cursor-help flex items-center justify-center">?</button>`;
}
