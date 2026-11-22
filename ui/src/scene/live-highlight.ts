import type { Object3D } from 'three';
import { ScreenshotHighlightOverlay, type ScreenshotHighlightRef } from '../screenshot-overlays';

/** A face or edge to keep highlighted in the live viewport; `dim` draws it faint. */
export type LiveHighlightEntry = ScreenshotHighlightRef & { dim?: boolean };

/** The scene the highlight is drawn in, and how to ask for a frame. */
type LiveHighlightScene = { scene: Object3D; requestRender(): void };

/**
 * Faces and edges kept highlighted in the live viewport: what the Agent
 * points at with `show_user` (docs/agent-chat-plan.md §27). The drawing is
 * the captures' own ({@link ScreenshotHighlightOverlay}: a translucent fill
 * on faces, a thick line on edges, each in its entry's colour, through
 * whatever occludes it), left in the scene instead of taken out after one
 * frame.
 *
 * The overlay hangs off the model's meshes and borrows their geometry, so it
 * is one render's: the owner calls {@link draw} again after every render
 * (with the new render's entries, or none), which lets go of the old one.
 * {@link hidden} takes it out for a capture that must show only its own
 * highlight.
 */
export class LiveHighlight {

  /** How faint the entries marked `dim` are drawn. */
  static readonly DIM_OPACITY = 0.14;

  private overlays: ScreenshotHighlightOverlay[] = [];

  constructor(private readonly context: () => LiveHighlightScene) {}

  /** Draw `entries` in place of whatever was drawn; none clears the viewport of it. */
  draw(entries: readonly LiveHighlightEntry[]): void {
    const had = this.overlays.length > 0;
    this.dispose();
    const context = this.context();
    const scene = context.scene;
    const strong = entries.filter((entry) => !entry.dim);
    const dim = entries.filter((entry) => entry.dim);
    if (strong.length > 0) {
      this.overlays.push(ScreenshotHighlightOverlay.build(scene, strong));
    }
    if (dim.length > 0) {
      const overlay = ScreenshotHighlightOverlay.build(scene, dim);
      overlay.fade(LiveHighlight.DIM_OPACITY);
      this.overlays.push(overlay);
    }
    if (had || this.overlays.length > 0) {
      context.requestRender();
    }
  }

  /** Runs `fn` with the highlight out of the picture, and puts it back right after, in the same task. */
  hidden<T>(fn: () => T): T {
    for (const overlay of this.overlays) {
      overlay.setVisible(false);
    }
    try {
      return fn();
    } finally {
      for (const overlay of this.overlays) {
        overlay.setVisible(true);
      }
    }
  }

  private dispose(): void {
    for (const overlay of this.overlays) {
      overlay.dispose();
    }
    this.overlays = [];
  }
}
