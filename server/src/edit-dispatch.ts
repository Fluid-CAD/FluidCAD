import type { Response } from 'express';
import type { FluidCadServer } from './fluidcad-server.ts';
import { EditAckRegistry } from './edit-acks.ts';
import { applyFeatureEdit, type ApplyFeatureEditSpec } from './apply-feature-edit.ts';

export type EditDispatcherOptions = {
  /**
   * Dry-run every outgoing edit spec against the server's copy of the file
   * before dispatching it to the editor (default true). Tests that relay
   * synthetic specs turn this off.
   */
  preflight?: boolean;
  /** How long to wait for the editor's transform round-trip (default 5000ms). */
  ackTimeoutMs?: number;
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

  constructor(
    private readonly fluidCadServer: FluidCadServer,
    private readonly sendToExtension: (msg: any) => boolean | void,
    options: EditDispatcherOptions = {},
  ) {
    this.preflightEnabled = options.preflight !== false;
    this.ackTimeoutMs = options.ackTimeoutMs ?? 5000;
    this.acks = new EditAckRegistry(this.ackTimeoutMs);
  }

  async dispatch(
    res: Response,
    spec: ApplyFeatureEditSpec,
    successBody: Record<string, unknown>,
  ): Promise<void> {
    if (this.preflightEnabled && spec.filePath === this.fluidCadServer.getCurrentFileName()) {
      const code = this.fluidCadServer.getCurrentCode();
      if (code !== null) {
        try {
          const dryRun = await applyFeatureEdit(code, spec);
          if (dryRun.error) {
            res.status(422).json({ success: false, reason: dryRun.error });
            return;
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
   */
  async send(spec: ApplyFeatureEditSpec): Promise<{ error?: string }> {
    if (this.preflightEnabled && spec.filePath === this.fluidCadServer.getCurrentFileName()) {
      const code = this.fluidCadServer.getCurrentCode();
      if (code !== null) {
        try {
          const dryRun = await applyFeatureEdit(code, spec);
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
    return ack.error ? { error: ack.error } : {};
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

  /** The host round-tripped a dispatched spec — settle the waiting request. */
  settle(editId: string, error: string | undefined): void {
    this.acks.resolve(editId, error);
  }
}
