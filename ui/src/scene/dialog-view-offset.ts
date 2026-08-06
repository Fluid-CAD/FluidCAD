import { viewportChrome } from '../ui/viewport-chrome';
import { SceneContext } from './scene-context';

/**
 * On the phone layout an open feature dialog is a full-width bottom sheet
 * (DIALOG_DOCK_CLASS) covering the lower part of the viewport, right where the
 * model sits after the sketch-close camera restore. When one opens, shift the
 * rendered view up by half the covered height so the origin stays visible in
 * the strip above the sheet; when the last one closes, shift back. Nothing is
 * tracked in between — the adjustment happens only on the open/close edges.
 *
 * The shift is a pixel-space projection offset (SceneContext.setViewShift),
 * not a camera move: zoom, orbit, fit-to-view and the sketch-close setLookAt
 * restore all compose with it untouched. A world-space camera offset would
 * scale with zoom and slide the scene on every wheel tick. From `sm:` up
 * (Tailwind's 40rem) dialogs float top-right and no shift applies.
 */
export class DialogViewOffset {
  private target = 0;
  private current = 0;
  private rafId = 0;

  constructor(private ctx: SceneContext) {
    viewportChrome.subscribe(() => this.scheduleSync());
    // Rotating past the sm breakpoint re-docks the sheet top-right — an
    // active shift must clear. Only re-checked while one is in effect.
    window.addEventListener('resize', () => {
      if (this.target !== 0 || this.current !== 0) {
        this.scheduleSync();
      }
    });
  }

  /**
   * Measure on the next frame — the open notification fires inside show(),
   * before the panel finishes seeding its rows for the feature at hand.
   */
  private scheduleSync(): void {
    requestAnimationFrame(() => this.sync());
  }

  private sync(): void {
    // jsdom has no matchMedia — treat a missing implementation as the
    // desktop layout (no shift).
    const phoneLayout = !(window.matchMedia?.('(min-width: 40rem)').matches ?? true);

    // Half the tallest open sheet centers the view in the strip it leaves
    // visible. offsetHeight, not getBoundingClientRect — the sheet slides in
    // with a translate animation and the layout height is what it will cover
    // once settled.
    let coverage = 0;
    if (phoneLayout && viewportChrome.dialogOpen) {
      for (const dialog of viewportChrome.openDialogElements) {
        coverage = Math.max(coverage, dialog.offsetHeight);
      }
    }
    this.animateTo(coverage / 2);
  }

  /** Ease the shift over ~200ms, in step with the sheet's slide-up. */
  private animateTo(target: number): void {
    if (target === this.target) {
      return;
    }
    this.target = target;
    cancelAnimationFrame(this.rafId);

    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false) {
      this.apply(target);
      return;
    }

    const from = this.current;
    const start = performance.now();
    const DURATION = 200;
    const step = (now: number): void => {
      const t = Math.min(1, (now - start) / DURATION);
      const eased = 1 - (1 - t) ** 3;
      this.apply(from + (target - from) * eased);
      if (t < 1) {
        this.rafId = requestAnimationFrame(step);
      }
    };
    this.rafId = requestAnimationFrame(step);
  }

  private apply(px: number): void {
    this.current = px;
    this.ctx.setViewShift(Math.round(px));
  }
}
