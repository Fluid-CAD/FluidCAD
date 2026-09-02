/**
 * Drag-to-reorder for the file tabs.
 *
 * Pointer events rather than HTML5 drag-and-drop: the native API paints its
 * own ghost, reports no pointer position on `drag` in Firefox and does nothing
 * on touch. Here the pressed tab follows the pointer with a transform while
 * the DOM order updates live underneath it — a tab is moved into the slot
 * whose midpoint the pointer has crossed, exactly as a browser's tab strip
 * behaves — and the new order is reported once on release.
 *
 * Owns no tab state: the strip re-renders from its owner after
 * {@link TabReorderHandlers.onReorder}, so the live DOM shuffle is only ever a
 * preview of what the owner is about to confirm.
 */

export interface TabReorderHandlers {
  /** The strip's keys in their new order. Only fires when the order changed. */
  onReorder(keys: string[]): void;
}

/** A press that travels this far starts a drag; anything shorter is a click. */
const DRAG_THRESHOLD_PX = 4;

const DRAGGING_CLASSES = ['shadow-lg', 'opacity-80', 'z-10'];

type Drag = {
  el: HTMLElement;
  pointerId: number;
  startX: number;
  /** Where inside the tab the pointer grabbed it, so the tab doesn't jump to the cursor. */
  grabOffsetX: number;
  translate: number;
  active: boolean;
  /** The order at press time, restored if the gesture is cancelled. */
  original: HTMLElement[];
};

export class TabReorder {
  private drag: Drag | null = null;
  /** Set when a drag just ended — the click that follows it is not a tab click. */
  private clickSuppressed = false;

  constructor(private readonly track: HTMLElement, private readonly handlers: TabReorderHandlers) {}

  /** Make `el` draggable within the track under `key`. */
  attach(el: HTMLElement, key: string): void {
    el.dataset.tabKey = key;
    el.classList.add('touch-none');
    el.addEventListener('pointerdown', (event) => this.onPointerDown(event, el));
  }

  /**
   * Whether the click now being handled is the tail of a drag. Reading it
   * clears it, so the next real click goes through.
   */
  consumeClick(): boolean {
    const suppressed = this.clickSuppressed;
    this.clickSuppressed = false;
    return suppressed;
  }

  private onPointerDown(event: PointerEvent, el: HTMLElement): void {
    this.clickSuppressed = false;
    if (event.button !== 0 || this.drag) {
      return;
    }
    // A press on the close button, or inside a rename field, is theirs.
    const target = event.target as HTMLElement;
    if (target.closest('button, input')) {
      return;
    }
    this.drag = {
      el,
      pointerId: event.pointerId,
      startX: event.clientX,
      grabOffsetX: event.clientX - el.getBoundingClientRect().left,
      translate: 0,
      active: false,
      original: this.tabs(),
    };
    window.addEventListener('pointermove', this.onPointerMove);
    window.addEventListener('pointerup', this.onPointerUp);
    window.addEventListener('pointercancel', this.onPointerCancel);
  }

  private readonly onPointerMove = (event: PointerEvent): void => {
    const drag = this.drag;
    if (!drag || event.pointerId !== drag.pointerId) {
      return;
    }
    if (!drag.active) {
      if (Math.abs(event.clientX - drag.startX) < DRAG_THRESHOLD_PX) {
        return;
      }
      drag.active = true;
      drag.el.classList.add(...DRAGGING_CLASSES);
      drag.el.style.cursor = 'grabbing';
      // Capture keeps the moves coming when the pointer leaves the window;
      // the window listeners above already cover a browser without it.
      try {
        drag.el.setPointerCapture(drag.pointerId);
      } catch {
        // Not every environment implements capture.
      }
    }
    event.preventDefault();
    this.placeInSlot(drag, event.clientX);
    // The tab rides with the pointer: its slot moved with the DOM, so the
    // offset is measured from wherever the slot now is.
    const slotLeft = drag.el.getBoundingClientRect().left - drag.translate;
    drag.translate = event.clientX - drag.grabOffsetX - slotLeft;
    drag.el.style.transform = `translateX(${drag.translate}px)`;
  };

  /** Move the dragged tab before the first sibling whose midpoint the pointer hasn't passed. */
  private placeInSlot(drag: Drag, clientX: number): void {
    const siblings = this.tabs().filter((tab) => tab !== drag.el);
    const next = siblings.find((tab) => {
      const rect = tab.getBoundingClientRect();
      return clientX < rect.left + rect.width / 2;
    });
    if (next) {
      if (drag.el.nextElementSibling !== next) {
        this.track.insertBefore(drag.el, next);
      }
    } else if (this.track.lastElementChild !== drag.el) {
      this.track.appendChild(drag.el);
    }
  }

  private readonly onPointerUp = (event: PointerEvent): void => {
    const drag = this.drag;
    if (!drag || event.pointerId !== drag.pointerId) {
      return;
    }
    const wasActive = drag.active;
    this.finish(drag);
    if (!wasActive) {
      return;
    }
    this.clickSuppressed = true;
    const keys = this.tabs().map((tab) => tab.dataset.tabKey!);
    const before = drag.original.map((tab) => tab.dataset.tabKey!);
    if (keys.some((key, index) => key !== before[index])) {
      this.handlers.onReorder(keys);
    }
  };

  private readonly onPointerCancel = (event: PointerEvent): void => {
    const drag = this.drag;
    if (!drag || event.pointerId !== drag.pointerId) {
      return;
    }
    if (drag.active) {
      for (const tab of drag.original) {
        this.track.appendChild(tab);
      }
    }
    this.finish(drag);
  };

  private finish(drag: Drag): void {
    this.drag = null;
    window.removeEventListener('pointermove', this.onPointerMove);
    window.removeEventListener('pointerup', this.onPointerUp);
    window.removeEventListener('pointercancel', this.onPointerCancel);
    drag.el.classList.remove(...DRAGGING_CLASSES);
    drag.el.style.cursor = '';
    drag.el.style.transform = '';
    try {
      drag.el.releasePointerCapture(drag.pointerId);
    } catch {
      // Never captured, or the environment has no capture at all.
    }
  }

  private tabs(): HTMLElement[] {
    return Array.from(this.track.children).filter(
      (child): child is HTMLElement => child instanceof HTMLElement && child.dataset.tabKey !== undefined,
    );
  }
}
