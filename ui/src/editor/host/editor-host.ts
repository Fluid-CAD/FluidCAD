import { monaco } from '../monaco-setup';
import type { WorkspaceModels, ModelEntry } from '../models';
import { ackEdit } from '../editor-api';
import { TRANSFORMS, postCodeEdit, targetPathOf } from './transforms';

/**
 * The third implementation of the host contract — the one that lives in the
 * page (`docs/desktop/00-architecture.md`). The VS Code extension and the
 * Neovim bridge do the same job over IPC and keep working unchanged; this is
 * an addition, not a replacement (Invariant 5).
 *
 * What a host owes the server:
 *
 * - apply the source transforms it dispatches, against the *live buffer*,
 * - re-render after each one,
 * - settle the acked ones (`apply-feature-edit`, `undo`, `redo`) with the
 *   real outcome instead of silence,
 * - reveal a line when asked.
 */

/** Match VS Code's `initLiveRender`, so both hosts feel the same. */
const LIVE_RENDER_DEBOUNCE_MS = 300;

export interface EditorHostDeps {
  models: WorkspaceModels;
  /** Absolute path of the model the scene is rendered from. */
  currentModelPath(): string | null;
  /**
   * Make `absPath` the visible buffer, loading it if needed. `revealPane`
   * false is a passive navigation (a timeline row click): move the caret in
   * an open pane, but leave a hidden one hidden.
   */
  reveal(absPath: string, line?: number, column?: number, revealPane?: boolean): Promise<void>;
  /** A breakpoint marker moved — the gutter is a view of the code. */
  onBreakpointsChanged?(absPath: string): void;
  /** Surface a refusal to the user (an apply that the transform rejected). */
  onError?(message: string): void;
}

export class EditorHost {
  private liveRenderTimer: number | undefined;
  /** Tail of the serialized edit queue — see {@link handle}. */
  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly deps: EditorHostDeps) {}

  /**
   * Route one server→host message.
   *
   * **Serialized, deliberately.** Every transform POSTs the buffer's current
   * text and applies what comes back, so two overlapping ones both read the
   * pre-edit text and the second silently discards the first — and the flows
   * that dispatch in bursts (an edit session clearing breakpoints and setting
   * a new one) are exactly the ones that hit it. Queueing costs a round-trip
   * of latency per message and removes the whole class.
   */
  handle(msg: { type: string; [key: string]: any }): Promise<void> {
    this.queue = this.queue.then(() => this.route(msg)).catch((err) => {
      // One failed edit must not wedge the queue for the rest of the session.
      console.warn(`FluidCAD: ${msg.type} failed:`, err);
    });
    return this.queue;
  }

  /**
   * Unknown types are ignored on purpose: an engine newer than this page may
   * dispatch a transform it has never heard of, and dropping it is better
   * than throwing inside the socket handler.
   */
  private async route(msg: { type: string; [key: string]: any }): Promise<void> {
    switch (msg.type) {
      case 'apply-feature-edit':
        await this.applyFeatureEdit(msg);
        return;
      case 'undo':
      case 'redo':
        await this.stepHistory(msg.type, msg.filePath, msg.editId);
        return;
      case 'goto-source':
        await this.deps.reveal(msg.filePath, msg.line, msg.column, msg.revealEditor !== false);
        return;
      default:
        await this.applyTransform(msg);
    }
  }

  // ---------------------------------------------------------------------------
  // Transforms
  // ---------------------------------------------------------------------------

  private async applyTransform(msg: { type: string; [key: string]: any }): Promise<void> {
    const spec = TRANSFORMS[msg.type];
    if (!spec) {
      return;
    }
    const entry = await this.resolveOrLoad(targetPathOf(spec, msg));
    if (!entry) {
      console.warn(`FluidCAD: no buffer to apply ${msg.type} to`);
      return;
    }

    let body: Record<string, unknown>;
    try {
      body = spec.body(msg);
    } catch (err) {
      console.warn(`FluidCAD: malformed ${msg.type} message:`, err);
      return;
    }

    const result = await postCodeEdit(spec.endpoint, { code: entry.model.getValue(), ...body });
    if (!result || typeof result.newCode !== 'string') {
      return;
    }
    this.applyResult(entry, result.newCode);

    if (spec.endpoint.includes('breakpoint')) {
      this.deps.onBreakpointsChanged?.(entry.absPath);
    }
  }

  /**
   * `apply-feature-edit` is the one transform whose ack the server is waiting
   * on — and it settles through `POST /api/code/apply-feature` itself, because
   * the spec carries the `editId`. So this deliberately does *not* call
   * `/api/editor/ack`: the round-trip is the ack.
   *
   * The spec names its target file. Usually that is the rendered model, but a
   * cross-file edit — the assembly mate dialog creating or editing a
   * `connector()` in a PART file — must land there, never in whatever the
   * viewport shows (the IPC hosts do the same: `code-edits.ts`, `bridge.lua`).
   */
  private async applyFeatureEdit(msg: { type: string; spec?: unknown }): Promise<void> {
    const specPath = (msg.spec as { filePath?: unknown } | null)?.filePath;
    const entry = await this.resolveOrLoad(typeof specPath === 'string' && specPath.length > 0 ? specPath : null);
    if (!entry) {
      return;
    }
    const result = await postCodeEdit('apply-feature', {
      code: entry.model.getValue(),
      spec: msg.spec,
    });
    if (!result) {
      return;
    }
    if (result.error) {
      this.deps.onError?.(result.error);
      return;
    }
    this.applyResult(entry, result.newCode);
  }

  // ---------------------------------------------------------------------------
  // Editor-native history
  // ---------------------------------------------------------------------------

  /**
   * The reason the in-page host declares `capabilities.undoRedo`. Every
   * UI-driven edit lands as exactly one entry on Monaco's stack (see
   * `applyTextAsSingleEdit`), so one step reverts one *feature edit* rather
   * than one character.
   */
  private async stepHistory(action: 'undo' | 'redo', filePath: string, editId: string): Promise<void> {
    let error: string | undefined;
    try {
      const entry = this.resolveTarget(filePath) ?? await this.load(filePath);
      if (!entry) {
        error = 'That file is not open in the editor.';
      } else {
        const before = entry.model.getVersionId();
        // The model's own stack, not the focused editor's: an undo dispatched
        // from the toolbar must work whether or not the pane is even open.
        entry.model[action]();
        if (entry.model.getVersionId() === before) {
          error = action === 'undo' ? 'Nothing to undo.' : 'Nothing to redo.';
        } else {
          this.afterBufferChanged(entry);
        }
      }
    } catch (err: any) {
      error = err?.message ?? String(err);
    }
    await ackEdit(editId, error).catch(() => undefined);
  }

  // ---------------------------------------------------------------------------
  // Shared
  // ---------------------------------------------------------------------------

  private resolveTarget(filePath: string | null): ModelEntry | undefined {
    const absPath = filePath || this.deps.currentModelPath();
    return absPath ? this.deps.models.get(absPath) : undefined;
  }

  private async load(filePath: string): Promise<ModelEntry | undefined> {
    return this.deps.models.ensure(filePath).catch(() => undefined);
  }

  /**
   * The buffer an edit names, loading it when the workspace scan didn't (a
   * file outside the editable kinds, or one that appeared since). A named
   * target is never silently swapped for the current model — that would
   * splice the transform into the wrong file.
   */
  private async resolveOrLoad(filePath: string | null): Promise<ModelEntry | undefined> {
    const entry = this.resolveTarget(filePath);
    if (entry || !filePath) {
      return entry;
    }
    return this.load(filePath);
  }

  /**
   * Apply a transform result the host didn't dispatch itself — a breakpoint
   * toggled from the gutter. Same path as every server-driven edit, so it
   * saves and re-renders identically.
   */
  applyExternalResult(absPath: string, newCode: string): void {
    const entry = this.deps.models.get(absPath);
    if (entry) {
      this.applyResult(entry, newCode);
    }
  }

  private applyResult(entry: ModelEntry, newCode: string): void {
    if (!this.deps.models.setContentAsEdit(entry.absPath, newCode)) {
      return;
    }
    this.afterBufferChanged(entry);
  }

  /**
   * Persist and re-render. Saving is what makes the in-page host behave like
   * an editor host that saves: the transform is a committed change, not a
   * draft, and the next reader of the file — MCP, git, another editor — has to
   * see it.
   */
  private afterBufferChanged(entry: ModelEntry): void {
    void this.deps.models.save(entry.absPath).catch((err) => {
      console.warn(`FluidCAD: could not save ${entry.relPath}:`, err);
    });
    // Immediate, not debounced: the edit came from a click on the viewport and
    // the viewport is what has to answer it. VS Code's `updateLiveCode` clears
    // its debounce for the same reason.
    this.renderNow(entry);
  }

  /**
   * A keystroke in the editor. Debounced, and only for the model the scene is
   * rendered from — typing in a helper re-renders through its importer, which
   * the engine picks up on the next render of the model itself.
   */
  scheduleLiveRender(absPath: string): void {
    if (absPath !== this.deps.currentModelPath()) {
      return;
    }
    const entry = this.deps.models.get(absPath);
    if (!entry) {
      return;
    }
    window.clearTimeout(this.liveRenderTimer);
    this.liveRenderTimer = window.setTimeout(() => this.renderNow(entry), LIVE_RENDER_DEBOUNCE_MS);
  }

  private renderNow(entry: ModelEntry): void {
    window.clearTimeout(this.liveRenderTimer);
    // `POST /api/render` already is the `live-update` route — the in-page host
    // needs no new channel for it. An edit that landed in a file other than
    // the rendered model (a cross-file connector, a feature in an imported
    // part) is `keepCurrent`: the server folds it in as a dependency of the
    // current model instead of switching the viewport to the edited file —
    // the same rule the Neovim bridge applies to every non-current buffer.
    const keepCurrent = entry.absPath !== this.deps.currentModelPath();
    void fetch('/api/render', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ filePath: entry.absPath, code: entry.model.getValue(), keepCurrent }),
    }).catch((err) => {
      console.warn('FluidCAD: live render failed:', err);
    });
  }
}

export { monaco };
