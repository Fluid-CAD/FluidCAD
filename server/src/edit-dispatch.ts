import type { Response } from 'express';
import type { FluidCadServer } from './fluidcad-server/index.ts';
import { EditAckRegistry } from './edit-acks.ts';
import { applyFeatureEdit, type ApplyFeatureEditSpec, type FeatureCalleeSource } from './apply-feature-edit/index.ts';
import type { PackageEditGuard } from './packages/package-edit-guard.ts';

/** Why a dispatch's {@link FeatureEditDispatcher.dispatch} `beforeSend` step refused the edit. */
export type DispatchRefusal = { status: number; reason: string; code?: string };

export type EditDispatcherOptions = {
  /**
   * Dry-run every outgoing edit spec against the server's copy of the file
   * before dispatching it to the editor (default true). Tests that relay
   * synthetic specs turn this off.
   */
  preflight?: boolean;
  /** How long to wait for the editor's transform round-trip (default 5000ms). */
  ackTimeoutMs?: number;
  /** The workspace's custom features, for the preflight's producer gates (the feature catalog). */
  callees?: FeatureCalleeSource;
  /**
   * Refuses an edit aimed at an installed package's file (K8) before
   * anything is sent. Omitted (tests), nothing is refused.
   */
  packages?: PackageEditGuard;
};

/**
 * Hands an edit spec to the editor host and answers the waiting request with
 * the transform's true outcome, closing the old fire-and-forget gap where a
 * refusal died in the editor's log while the dialog reported success.
 *
 * Two layers: a preflight dry-runs the transform against the server's copy of
 * the file (fast, synchronous refusals — stale lines, unbindable producers),
 * then the editor's round-trip through `/code/apply-feature` acks the real
 * transform against the live buffer (catches drift the preflight can't see).
 * A host that never round-trips within the timeout reports failure instead of
 * silent success; a send with no host process at all (standalone server,
 * tests) keeps the legacy immediate success.
 *
 * One instance is shared by every router that writes source, because the ack
 * correlation only works if the router that dispatched and the endpoint the
 * host round-trips through look at the same pending set.
 */
export class FeatureEditDispatcher {
  private readonly acks: EditAckRegistry;
  private readonly preflightEnabled: boolean;
  private readonly ackTimeoutMs: number;
  private readonly callees: FeatureCalleeSource | undefined;
  private readonly packages: PackageEditGuard | undefined;

  constructor(
    private readonly fluidCadServer: FluidCadServer,
    private readonly sendToExtension: (msg: any) => boolean | void,
    options: EditDispatcherOptions = {},
  ) {
    this.preflightEnabled = options.preflight !== false;
    this.ackTimeoutMs = options.ackTimeoutMs ?? 5000;
    this.callees = options.callees;
    this.packages = options.packages;
    this.acks = new EditAckRegistry(this.ackTimeoutMs);
  }

  /**
   * Answer 403 when one of `files` belongs to an installed package (K8),
   * for a route that must refuse before its first side effect; true when
   * it did. Every dispatch checks its own spec anyway.
   */
  refuseReadOnly(res: Response, ...files: (string | null | undefined)[]): boolean {
    return this.packages?.refuse(res, ...files) ?? false;
  }

  /**
   * Preflight `spec`, hand it to the editor, and answer `res` with the
   * editor's outcome. `options.beforeSend` runs once the preflight has
   * accepted the edit and before the editor writes it — a write the edit
   * depends on, such as the pin a library package's statement needs
   * (`PackageAdoption`), so the ack answers for both; a refusal it returns
   * answers the request and nothing is sent.
   */
  async dispatch(
    res: Response,
    spec: ApplyFeatureEditSpec,
    successBody: Record<string, unknown>,
    options: { beforeSend?: () => Promise<DispatchRefusal | null> } = {},
  ): Promise<void> {
    if (this.refuseReadOnly(res, spec.filePath)) {
      return;
    }
    if (this.preflightEnabled && spec.filePath === this.fluidCadServer.getCurrentFileName()) {
      const code = this.fluidCadServer.getCurrentCode();
      if (code !== null) {
        try {
          const dryRun = await applyFeatureEdit(code, spec, { callees: this.callees });
          if (dryRun.error) {
            res.status(422).json({ success: false, reason: dryRun.error });
            return;
          }
        } catch {
          // A preflight crash is not a verdict — the editor round-trip decides.
        }
      }
    }
    if (options.beforeSend) {
      const refusal = await options.beforeSend();
      if (refusal) {
        res.status(refusal.status).json({ success: false, reason: refusal.reason, ...(refusal.code ? { code: refusal.code } : {}) });
        return;
      }
    }
    const { editId, result } = this.acks.register();
    const delivered = this.sendToExtension({ type: 'apply-feature-edit', spec: { ...spec, editId } }) === true;
    if (!delivered) {
      this.acks.cancel(editId);
      res.json(successBody);
      return;
    }
    const ack = await result;
    if (ack === null) {
      res.status(504).json({
        success: false,
        reason: `the editor did not apply the edit within ${this.ackTimeoutMs}ms — check the editor for errors`,
      });
    } else if (ack.error) {
      res.status(422).json({ success: false, reason: ack.error });
    } else {
      res.json(successBody);
    }
  }

  /**
   * Dispatch a spec WITHOUT answering an HTTP response — the first stage of a
   * two-file edit sequence (a cross-file exposure created before the consumer
   * statement lands in the current buffer). Same preflight/ack semantics as
   * {@link dispatch}; the caller folds the returned error into its own
   * response. A send with no host process keeps the legacy immediate success.
   * `changed` reports whether the host's buffer was rewritten (a render
   * follows) when the host says; absent otherwise.
   */
  async send(spec: ApplyFeatureEditSpec): Promise<{ error?: string; changed?: boolean }> {
    const readOnly = this.packages?.refusal(spec.filePath);
    if (readOnly) {
      return { error: readOnly.message };
    }
    if (this.preflightEnabled && spec.filePath === this.fluidCadServer.getCurrentFileName()) {
      const code = this.fluidCadServer.getCurrentCode();
      if (code !== null) {
        try {
          const dryRun = await applyFeatureEdit(code, spec, { callees: this.callees });
          if (dryRun.error) {
            return { error: dryRun.error };
          }
        } catch {
          // A preflight crash is not a verdict — the editor round-trip decides.
        }
      }
    }
    const { editId, result } = this.acks.register();
    const delivered = this.sendToExtension({ type: 'apply-feature-edit', spec: { ...spec, editId } }) === true;
    if (!delivered) {
      this.acks.cancel(editId);
      return {};
    }
    const ack = await result;
    if (ack === null) {
      return { error: `the editor did not apply the edit within ${this.ackTimeoutMs}ms — check the editor for errors` };
    }
    if (ack.error) {
      return { error: ack.error };
    }
    // Whether the host's buffer changed (and a render follows) — absent from
    // a host that predates the field.
    return ack.changed === undefined ? {} : { changed: ack.changed };
  }

  /**
   * Dispatch a plain editor action (undo/redo) and answer the waiting request
   * with the host's IPC `edit-ack`. Unlike {@link dispatch} there is no
   * transform to preflight and no HTTP round-trip to carry the ack, and a
   * send with no host process is an honest failure rather than legacy
   * success — without an editor there is no history to step.
   */
  async dispatchAction(
    res: Response,
    buildMessage: (editId: string) => Record<string, unknown>,
  ): Promise<void> {
    if (this.packages && this.refuseReadOnly(res, ...this.packages.targetsOf(buildMessage('')))) {
      return;
    }
    const { editId, result } = this.acks.register();
    const delivered = this.sendToExtension(buildMessage(editId)) === true;
    if (!delivered) {
      this.acks.cancel(editId);
      res.status(503).json({ success: false, reason: 'no editor is attached to this server' });
      return;
    }
    const ack = await result;
    if (ack === null) {
      res.status(504).json({
        success: false,
        reason: `the editor did not answer within ${this.ackTimeoutMs}ms — check the editor for errors`,
      });
    } else if (ack.error) {
      res.status(422).json({ success: false, reason: ack.error });
    } else {
      res.json({ success: true });
    }
  }

  /**
   * The host round-tripped a dispatched spec — settle the waiting request.
   * `changed` says whether the transform rewrote the buffer (see
   * {@link EditAck.changed}).
   */
  settle(editId: string, error: string | undefined, changed?: boolean): void {
    this.acks.resolve(editId, error, changed);
  }
}
