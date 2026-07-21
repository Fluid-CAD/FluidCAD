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
    this.viewer.resumeSketchEditing(immediate);
    if (immediate) {
      this.hooks.onResumeSketchUI?.();
    }
  }
}
