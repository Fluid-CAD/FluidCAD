import { ICON_SCROLL_LEFT, ICON_SCROLL_RIGHT } from '../icons';

/** One arrow click travels this fraction of the visible width. */
const PAGE_FRACTION = 0.8;
/** Sub-pixel slack, so a rounding remainder never reads as "there is more". */
const EPSILON = 1;
/** Pixels per notch for wheels that report line deltas (`DOM_DELTA_LINE`). */
const PIXELS_PER_LINE = 40;

// Opaque, so the tools scrolling underneath do not bleed through the chip.
const ARROW_BASE =
  'btn btn-circle btn-sm absolute top-1/2 -translate-y-1/2 z-10 '
  + 'bg-base-300 border border-base-content/20 text-base-content/80 shadow-lg';

/**
 * Horizontal scrolling for the {@link Navbar}. The tool groups sit on a track
 * inside a clipped viewport, and two arrows float over the ends of the bar,
 * each shown only while there is something to scroll to in its direction — so
 * on a window wide enough for every tool the bar looks exactly as it always
 * did.
 *
 * The viewport clips with `overflow-x: clip` instead of scrolling with
 * `overflow-x: auto`, because a scroll container would also clip *vertically*
 * (CSS forces `overflow-y: visible` to `auto` alongside a scrolling axis) and
 * cut off everything the toolbar hangs below itself: button tooltips, the
 * Rectangle options menu, the Finish Sketch grid. `clip` beside `visible` is
 * the one combination that leaves the vertical axis unclipped, which makes the
 * scroll offset ours to own — a relative `left` on the track.
 */
export class ToolbarScroller {
  /** Where the bar's content lives: the group hosts and their dividers. */
  readonly track: HTMLDivElement;

  private readonly viewport: HTMLDivElement;
  private readonly prevArrow: HTMLButtonElement;
  private readonly nextArrow: HTMLButtonElement;
  /** How far the track is pulled left of its resting position, in pixels. */
  private offset = 0;
  /** The largest useful offset: the width the track overruns the viewport by. */
  private maxOffset = 0;
  private pendingMeasure = 0;

  constructor(bar: HTMLElement) {
    this.viewport = document.createElement('div');
    this.viewport.className = 'flex-1 min-w-0 overflow-x-clip overflow-y-visible';

    // `w-max` keeps the track at its natural width inside the narrower
    // viewport (that overrun is what there is to scroll); `relative` + `left`
    // moves it without the stacking context a transform would introduce.
    this.track = document.createElement('div');
    this.track.className = 'relative flex items-center w-max transition-[left] ease-out';
    this.viewport.appendChild(this.track);
    bar.appendChild(this.viewport);

    this.prevArrow = this.addArrow(bar, -1);
    this.nextArrow = this.addArrow(bar, 1);

    bar.addEventListener('wheel', this.onWheel, { passive: false });
    // Both sides of the comparison move on their own: the viewport with the
    // window, the track as groups and buttons come and go.
    const resize = new ResizeObserver(() => this.scheduleMeasure());
    resize.observe(this.viewport);
    resize.observe(this.track);
  }

  /** Re-measure after the bar's contents changed. */
  refresh(): void {
    this.scheduleMeasure();
  }

  /** Re-measure and return to the start — the bar is showing a new tool set. */
  reset(): void {
    this.offset = 0;
    this.scheduleMeasure();
  }

  private addArrow(bar: HTMLElement, direction: -1 | 1): HTMLButtonElement {
    const back = direction < 0;
    const arrow = document.createElement('button');
    arrow.className = `${ARROW_BASE} ${back ? 'left-1' : 'right-1'} hidden`;
    arrow.setAttribute('aria-label', back ? 'Scroll tools left' : 'Scroll tools right');
    arrow.innerHTML = `<span class="[&>svg]:size-4">${back ? ICON_SCROLL_LEFT : ICON_SCROLL_RIGHT}</span>`;
    arrow.addEventListener('click', () => this.page(direction));
    bar.appendChild(arrow);
    return arrow;
  }

  /**
   * Coalesce measurement into one pass per frame: resize notifications arrive
   * in bursts (a window resize moves the viewport, and the track's own reflow
   * follows), and measuring straight from the observer callback would read a
   * layout that same batch is still settling.
   */
  private scheduleMeasure(): void {
    if (this.pendingMeasure) {
      return;
    }
    this.pendingMeasure = requestAnimationFrame(() => {
      this.pendingMeasure = 0;
      this.measure();
    });
  }

  private measure(): void {
    this.maxOffset = Math.max(0, this.track.scrollWidth - this.viewport.clientWidth);
    // Re-apply the current offset so a viewport that just grew (or content
    // that just shrank) pulls the track back into range.
    this.scrollTo(this.offset, false);
  }

  private page(direction: -1 | 1): void {
    this.scrollTo(this.offset + direction * this.viewport.clientWidth * PAGE_FRACTION, true);
  }

  /** Move the track, clamped to the scrollable range, and sync the arrows. */
  private scrollTo(target: number, animate: boolean): void {
    this.offset = Math.round(Math.min(Math.max(target, 0), this.maxOffset));
    this.track.style.transitionDuration = animate ? '180ms' : '0s';
    this.track.style.left = `${-this.offset}px`;
    this.prevArrow.classList.toggle('hidden', this.offset <= EPSILON);
    this.nextArrow.classList.toggle('hidden', this.offset >= this.maxOffset - EPSILON);
  }

  /**
   * A wheel over the bar scrolls it. Trackpads report a sideways gesture on
   * `deltaX` while a plain mouse only ever reports `deltaY`, so whichever axis
   * moved further drives the one direction this bar can go.
   */
  private readonly onWheel = (event: WheelEvent): void => {
    if (this.maxOffset <= EPSILON) {
      return;
    }
    const delta = Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY;
    if (delta === 0) {
      return;
    }
    event.preventDefault();
    this.scrollTo(this.offset + delta * this.wheelStep(event.deltaMode), false);
  };

  /** Wheel deltas arrive in pixels, lines or pages depending on the device. */
  private wheelStep(deltaMode: number): number {
    if (deltaMode === WheelEvent.DOM_DELTA_LINE) {
      return PIXELS_PER_LINE;
    }
    if (deltaMode === WheelEvent.DOM_DELTA_PAGE) {
      return this.viewport.clientWidth * PAGE_FRACTION;
    }
    return 1;
  }
}
