import { ApplyFeatureResponse, GhostSolid } from '../../api';

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
export class ApplyRunner<R extends object, G = GhostSolid[]> {
  private applying = false;
  private timer: number | null = null;
  private abort: AbortController | null = null;
  private seq = 0;

  constructor(private readonly opts: {
    panel: RunnerPanel;
    isArmed: () => boolean;
    /**
     * The dialog's edit session, when it has one: previews (and the ghost
     * chained onto them) only run while the session is `settled` — the view
     * at the pre-statement boundary, or no session at all. The service
     * re-schedules at the boundary, so a preview held back here is not lost.
     */
    session?: { readonly settled: boolean };
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
    /**
     * Runs on every {@link schedulePreview} — the form changed. Pickers that
     * derive from the form re-sync here before the preview reads them (the
     * region picker re-reads its profile).
     */
    onSchedule?: () => void;
    /** Gate preview refusal messages (default on) — extrude keeps create-mode
     * distance previews quiet so transient failures don't flash while
     * sketching. */
    surfacePreviewReasons?: () => boolean;
    /** A successful preview landed — loft clears refusals that no longer
     * apply (scene-driven previews rerun without a user action), and the
     * dialogs with an expression row read the synthesized args off `result`. */
    onPreviewSuccess?: (result: ApplyFeatureResponse) => void;
    /**
     * Live viewport geometry for the request just previewed (the "ghost"),
     * chained onto the statement preview under the same debounce, abort and
     * sequence guards. Dialogs without one are untouched. `G` is what one
     * answer draws — the bodies, for most dialogs; a copy's also carries the
     * connector frames it places.
     */
    ghost?: {
      /** What the request would build; null when there is none to draw. */
      fetch: (request: R, signal: AbortSignal) => Promise<G | null>;
      /** Deliver the result; null clears the overlay. */
      apply: (ghost: G | null) => void;
    };
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
    if (!this.opts.isArmed() || !this.settled) {
      return;
    }
    this.opts.onSchedule?.();
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

  /** Whether the view is one a preview may be drawn against (see `opts.session`). */
  private get settled(): boolean {
    return this.opts.session?.settled ?? true;
  }

  private async runPreview(): Promise<void> {
    const { panel } = this.opts;
    // The view can move off the boundary during the debounce — a render
    // landing mid-session re-asserts the rollback, and the boundary
    // re-schedules.
    if (!this.opts.isArmed() || this.applying || !this.settled) {
      return;
    }
    const request = this.opts.build();
    if ('error' in request) {
      panel.setPreview(null);
      this.opts.ghost?.apply(null);
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
      this.opts.onPreviewSuccess?.(result);
    }
    if (!result.success && result.reason && (this.opts.surfacePreviewReasons?.() ?? true)) {
      // Pre-Apply refusals (an unsynthesizable pick, a statement that changed
      // shape under the dialog) surface immediately.
      panel.setMessage(result.reason);
    }

    const ghost = this.opts.ghost;
    if (!ghost) {
      return;
    }
    if (!result.success) {
      ghost.apply(null);
      return;
    }
    let drawn: G | null;
    try {
      drawn = await ghost.fetch(request, abort.signal);
    } catch {
      return; // aborted
    }
    // The ghost fetch awaited too — re-check that this is still the newest
    // preview before drawing what it returned.
    if (seq !== this.seq || !this.opts.isArmed()) {
      return;
    }
    ghost.apply(drawn);
  }
}
