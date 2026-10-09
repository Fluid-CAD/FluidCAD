/**
 * Calls `fit` each time an element's width changes — it shows, or the box
 * it sits in widens or narrows — so a control can measure itself and choose
 * a layout that cuts nothing short. Nothing happens where the page has no
 * `ResizeObserver`.
 */
export class WidthWatch {
  private readonly observer: ResizeObserver | null = null;
  /** The width last fitted to; 0 while hidden, so showing again fits again. */
  private width = 0;

  constructor(private readonly element: HTMLElement, private readonly fit: () => void) {
    if (typeof ResizeObserver === 'undefined') {
      return;
    }
    this.observer = new ResizeObserver(entries => {
      const width = Math.round(entries[entries.length - 1].contentRect.width);
      if (width === this.width) {
        return;
      }
      this.width = width;
      if (width > 0) {
        this.fit();
      }
    });
    this.observer.observe(element);
  }

  /** Fit again at the width it has: what it holds changed. */
  refit(): void {
    if (this.element.clientWidth > 0) {
      this.fit();
    }
  }

  disconnect(): void {
    this.observer?.disconnect();
  }
}
