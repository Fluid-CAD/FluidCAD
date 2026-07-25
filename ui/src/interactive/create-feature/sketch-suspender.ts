import { Viewer } from '../../viewer';

/**
 * The sketch-editing suspension every armed feature dialog shares: composing
 * a feature means looking at the whole scene, not down the active sketch
 * plane, so arming suspends sketch editing and exiting resumes it —
 * `immediate` forces the mode transition right away (user cancels), lazy
 * resumes let the next render take over (apply-success and scene-driven
 * exits).
 */
export class SketchUISuspender {
  private suspendedFlag = false;

  constructor(
    private readonly viewer: Viewer,
    private readonly hooks: { onSuspendSketchUI?: () => void; onResumeSketchUI?: () => void },
  ) {}

  get suspended(): boolean {
    return this.suspendedFlag;
  }

  suspend(): void {
    if (this.suspendedFlag) {
      return;
    }
    this.suspendedFlag = true;
    this.viewer.suspendSketchEditing();
    this.hooks.onSuspendSketchUI?.();
  }

  resume(immediate: boolean): void {
    if (!this.suspendedFlag) {
      return;
    }
    this.suspendedFlag = false;
    // A lazy resume leaves the transition to the render it knows is coming —
    // but an apply's render can land BEFORE the apply's own response (two
    // channels), and a render that arrives suspended draws the sketch as a
    // plain 3D scene. Nothing revisits that, so a missed render makes the
    // resume immediate: the sketch view (and the sketch toolbar) come back now.
    const now = immediate || this.viewer.missedSketchRender;
    this.viewer.resumeSketchEditing(now);
    if (now) {
      this.hooks.onResumeSketchUI?.();
    }
  }
}
