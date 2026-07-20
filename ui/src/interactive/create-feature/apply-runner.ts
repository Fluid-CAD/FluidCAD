import { ApplyFeatureResponse } from '../../api';

const PREVIEW_DEBOUNCE_MS = 250;

/** The panel surface the runner reports through. */
type RunnerPanel = {
  setPreview(text: string | null): void;
  setMessage(text: string | null): void;
  setApplyEnabled(enabled: boolean): void;
};

/**
 * The apply + debounced-statement-preview machinery every feature service
 * shares. The service supplies `build` (its current request, edit or create,
 * or the message blocking it) and `send` (the matching API call); the runner
 * owns the applying flag, the debounce timer, and the abort/sequence dance
 * that drops stale preview responses.
 *
 * Apply: a blocked request surfaces its message; a successful apply calls
 * `onApplied` (the service exits — the editor round-trip re-renders the
 * scene, that render is the preview and editor undo the rollback); a refusal
 * surfaces its reason. Preview: a blocked request just clears the preview;
 * refusals surface their reason immediately (pre-Apply validation).
 */
export class ApplyRunner<R extends object> {
  private applying = false;
  private timer: number | null = null;
  private abort: AbortController | null = null;
  private seq = 0;

  constructor(private readonly opts: {
    panel: RunnerPanel;
    isArmed: () => boolean;
    /** The current request (edit or create), or the message blocking it. */
    build: () => R | { error: string };
    /** The matching API call; `extras` carries the preview flag + signal. */
    send: (request: R, extras: { preview?: true; signal?: AbortSignal }) => Promise<ApplyFeatureResponse>;
    /** A successful (non-preview) apply — the service exits. */
    onApplied: () => void;
    /** The fallback failure message ("Could not apply the revolve."). */
    failMessage: () => string;
    /** Extra apply-only gate after `build` (checks previews tolerate). */
    validateApply?: () => { error: string } | null;
    /** Gate preview refusal messages (default on) — extrude keeps create-mode
     * distance previews quiet so transient failures don't flash while
     * sketching. */
    surfacePreviewReasons?: () => boolean;
    /** A successful preview landed — loft clears refusals that no longer
     * apply (scene-driven previews rerun without a user action). */
    onPreviewSuccess?: () => void;
  }) {}

  get isApplying(): boolean {
    return this.applying;
  }

  async apply(): Promise<void> {
    const { panel } = this.opts;
    if (!this.opts.isArmed() || this.applying) {
      return;
    }
    const request = this.opts.build();
    if ('error' in request) {
      panel.setMessage(request.error as string);
      return;
    }
    const blocked = this.opts.validateApply?.();
    if (blocked) {
      panel.setMessage(blocked.error);
      return;
    }
    this.applying = true;
    panel.setApplyEnabled(false);
    try {
      const result = await this.opts.send(request, {});
      if (result.success) {
        this.opts.onApplied();
      } else {
        panel.setMessage(result.reason ?? this.opts.failMessage());
      }
    } finally {
      this.applying = false;
      panel.setApplyEnabled(true);
    }
  }

  schedulePreview(): void {
    this.cancelPreview();
    if (!this.opts.isArmed()) {
      return;
    }
    this.timer = window.setTimeout(() => {
      this.timer = null;
      void this.runPreview();
    }, PREVIEW_DEBOUNCE_MS);
  }

  cancelPreview(): void {
    if (this.timer !== null) {
      window.clearTimeout(this.timer);
      this.timer = null;
    }
    this.abort?.abort();
    this.abort = null;
    this.seq++;
  }

  private async runPreview(): Promise<void> {
    const { panel } = this.opts;
    if (!this.opts.isArmed() || this.applying) {
      return;
    }
    const request = this.opts.build();
    if ('error' in request) {
      panel.setPreview(null);
      return;
    }
    const seq = ++this.seq;
    this.abort?.abort();
    const abort = new AbortController();
    this.abort = abort;

    let result: ApplyFeatureResponse;
    try {
      result = await this.opts.send(request, { preview: true, signal: abort.signal });
    } catch {
      return; // aborted
    }
    if (seq !== this.seq || !this.opts.isArmed()) {
      return;
    }
    panel.setPreview(result.success ? result.preview ?? null : null);
    if (result.success) {
      this.opts.onPreviewSuccess?.();
    }
    if (!result.success && result.reason && (this.opts.surfacePreviewReasons?.() ?? true)) {
      // Pre-Apply refusals (an unsynthesizable pick, a statement that changed
      // shape under the dialog) surface immediately.
      panel.setMessage(result.reason);
    }
  }
}
