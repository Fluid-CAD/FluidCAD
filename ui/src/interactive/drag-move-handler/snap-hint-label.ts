/**
 * A cursor-following one-line hint badge (the end-drag's "Tangent arc up to
 * intersection" tooltip). The element exists only while shown, so the label
 * needs no teardown hook beyond {@link hide}.
 */
export class SnapHintLabel {
  private el: HTMLDivElement | null = null;

  constructor(private readonly container: HTMLElement) {}

  show(text: string, clientX: number, clientY: number): void {
    if (!this.el) {
      this.el = document.createElement('div');
      this.el.className = 'absolute z-[999] pointer-events-none '
        + 'panel-bg border border-base-content/10 rounded-md px-2 py-0.5 '
        + 'shadow-sm text-xs text-warning whitespace-nowrap';
      this.container.appendChild(this.el);
    }
    this.el.textContent = text;
    this.el.style.left = `${clientX + 16}px`;
    this.el.style.top = `${clientY + 16}px`;
  }

  hide(): void {
    if (this.el) {
      this.el.remove();
      this.el = null;
    }
  }
}
