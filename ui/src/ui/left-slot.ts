/**
 * The left slot: one resizable area beside the panel rail that the code
 * editor, the Hub panel and whatever docks there next take turns in. Only
 * one occupant holds it at a time.
 *
 * Each occupant {@link register}s a `close()`. {@link take} closes every
 * other occupant first, then sizes the taker; {@link release} hands the
 * width back to the scene. An occupant closed because another one took the
 * slot calls `release` like any close, and that is a no-op: the slot is no
 * longer its to release, so the scene's edge goes straight from one width
 * to the next.
 *
 * The geometry is one CSS custom property on `<html>`,
 * `--fluidcad-editor-width` (registered in `styles.css`, so it animates),
 * which `--fluidcad-dock-left` and `--fluidcad-scene-left` fold in: the
 * slot takes width from the scene rather than covering it, except below
 * 640 px, where the holder covers the scene instead. The width is shared:
 * whoever drags the edge sets it for everyone, clamped to keep 280 px of
 * scene.
 */

export interface LeftSlotOccupant {
  /**
   * Leave the slot: another occupant takes it. Hide, say so (onOpenChange),
   * and call {@link LeftSlot.release} as any close does. Called whether or
   * not this occupant is open, so it must be idempotent.
   */
  close(): void;
}

/** What {@link LeftSlot.take} sizes: the occupant's element, and the narrowest it goes. */
export type LeftSlotPanel = {
  el: HTMLElement;
  minWidth: number;
};

export type LeftSlotOptions = {
  /** The width before any is set (the saved preference arrives later, through {@link LeftSlot.setWidth}). */
  width?: number;
  /** The user dragged the slot's edge to `width` (the page saves it). */
  onResize?(width: number): void;
};

type Holder = LeftSlotPanel & { occupant: LeftSlotOccupant };

const WIDTH_VARIABLE = '--fluidcad-editor-width';
const ANIMATING_CLASS = 'fluidcad-editor-animating';
const DEFAULT_WIDTH = 420;
/** Leave at least this much scene visible, however hard the edge is dragged. */
const MIN_SCENE_WIDTH = 280;
/** Below this the split stops making sense and the holder covers the scene instead. */
const MOBILE_BREAKPOINT = 640;

export class LeftSlot {
  private readonly occupants = new Set<LeftSlotOccupant>();
  private holder: Holder | null = null;
  private current: number;
  /** The width the holder was last given, clamped for it. */
  private applied = 0;

  constructor(private readonly options: LeftSlotOptions = {}) {
    this.current = options.width ?? DEFAULT_WIDTH;
  }

  /** Join the slot; the returned function leaves it (a destroyed panel). */
  register(occupant: LeftSlotOccupant): () => void {
    this.occupants.add(occupant);
    return () => {
      this.occupants.delete(occupant);
      if (this.holder?.occupant === occupant) {
        this.holder = null;
      }
    };
  }

  /**
   * `occupant` takes the slot: every other occupant closes, then `panel`
   * takes the shared width (animated), clamped to its own minimum.
   */
  take(occupant: LeftSlotOccupant, panel: LeftSlotPanel): void {
    this.holder = { occupant, ...panel };
    for (const other of [...this.occupants]) {
      if (other !== occupant) {
        other.close();
      }
    }
    this.applied = LeftSlot.clamp(this.current, panel.minWidth);
    this.fit(true);
  }

  /** `occupant` closed: if it held the slot, the width goes back to the scene. */
  release(occupant: LeftSlotOccupant): void {
    if (this.holder?.occupant !== occupant) {
      return;
    }
    this.holder = null;
    LeftSlot.setWidthVariable(0, true);
  }

  /** Whether `occupant` holds the slot. */
  holds(occupant: LeftSlotOccupant): boolean {
    return this.holder?.occupant === occupant;
  }

  /** The shared width: what the next occupant to take the slot opens at. */
  width(): number {
    return this.current;
  }

  /** Set the shared width; the holder, if any, follows at once. Not reported to `onResize`. */
  setWidth(width: number): void {
    if (!Number.isFinite(width)) {
      return;
    }
    this.current = width;
    if (this.holder) {
      this.applied = LeftSlot.clamp(width, this.holder.minWidth);
      this.fit(false);
    }
  }

  /** The window changed size: the holder covers the scene or stops covering it. */
  layout(): void {
    if (this.holder) {
      this.fit(false);
    }
  }

  /** The drag handle for an occupant's right edge: it resizes whoever holds the slot. */
  resizeHandle(): HTMLElement {
    const handle = document.createElement('div');
    handle.dataset.ref = 'resize';
    handle.className =
      'absolute top-0 right-0 bottom-0 w-1 cursor-col-resize hover:bg-primary/40 active:bg-primary/60 transition-colors';
    handle.title = 'Drag to resize';
    handle.addEventListener('pointerdown', (event) => {
      event.preventDefault();
      handle.setPointerCapture?.(event.pointerId);
      const startX = event.clientX;
      const startWidth = this.applied;
      const onMove = (move: PointerEvent) => this.drag(startWidth + (move.clientX - startX));
      const onUp = () => {
        handle.removeEventListener('pointermove', onMove);
        handle.removeEventListener('pointerup', onUp);
        handle.removeEventListener('pointercancel', onUp);
      };
      handle.addEventListener('pointermove', onMove);
      handle.addEventListener('pointerup', onUp);
      handle.addEventListener('pointercancel', onUp);
    });
    return handle;
  }

  // ---------------------------------------------------------------------------

  private drag(width: number): void {
    if (!this.holder) {
      return;
    }
    const clamped = LeftSlot.clamp(width, this.holder.minWidth);
    this.setWidth(clamped);
    this.options.onResize?.(clamped);
  }

  /** Size the holder: its own element, and the room it takes from the scene. */
  private fit(animate: boolean): void {
    const el = this.holder!.el;
    if (window.innerWidth < MOBILE_BREAKPOINT) {
      // Everything the rail hasn't taken: `100%` would hang off the right
      // edge by exactly the rail's width.
      el.style.width = 'calc(100% - var(--fluidcad-rail-width, 0px))';
      LeftSlot.setWidthVariable(0, animate);
      return;
    }
    el.style.width = `${this.applied}px`;
    LeftSlot.setWidthVariable(this.applied, animate);
  }

  /**
   * The whole geometry mechanism, in one line. Animated on open and close,
   * instant while dragging, because a transition mid-drag lags the pointer.
   */
  private static setWidthVariable(value: number, animate: boolean): void {
    const root = document.documentElement;
    root.classList.toggle(ANIMATING_CLASS, animate);
    root.style.setProperty(WIDTH_VARIABLE, `${value}px`);
    if (animate) {
      window.setTimeout(() => root.classList.remove(ANIMATING_CLASS), 220);
    }
  }

  /** `width` within `[minWidth, what leaves 280 px of scene]`. */
  static clamp(width: number, minWidth: number): number {
    // The rail is chrome the slot can never borrow from, so it comes off the
    // budget before the scene's own minimum does.
    const rail = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--fluidcad-rail-width')) || 0;
    const max = Math.max(minWidth, window.innerWidth - rail - MIN_SCENE_WIDTH);
    return Math.round(Math.min(max, Math.max(minWidth, Number.isFinite(width) ? width : DEFAULT_WIDTH)));
  }
}
