import { Router } from 'express';
import { basename } from 'path';
import type { FluidCadServer } from '../fluidcad-server.ts';
import type { FeatureEditDispatcher } from '../edit-dispatch.ts';
import type { ApplyFeatureEditSpec } from '../apply-feature-edit.ts';
import type { AssemblyReplicatePayload, ReplicateSideRef } from '../assembly-replicate-edit.ts';
import { isReplicateSide, makeSidePreparer, type ReplicateSideBody } from '../assembly-side-refs.ts';
import { normalizePath } from '../normalize-path.ts';
import { detectKind } from '../file-kind.ts';

/**
 * The wire payload of one `replicate()` statement: the seed's `insert()`
 * line, the target sides (each a mate-side body — connector with optional
 * `viaParts`/`replicaRow`, assembly connector, or exposure by name) and one
 * row of replacement sides per replica.
 */
export type ReplicatePayloadBody = {
  seed: { instanceLine: number };
  targets: ReplicateSideBody[];
  rows: ReplicateSideBody[][];
};

function isReplicatePayload(v: unknown): v is ReplicatePayloadBody {
  if (v === null || typeof v !== 'object') {
    return false;
  }
  const o = v as any;
  return o.seed !== null && typeof o.seed === 'object'
    && Number.isInteger(o.seed.instanceLine) && o.seed.instanceLine >= 1
    && Array.isArray(o.targets) && o.targets.every(isReplicateSide)
    && Array.isArray(o.rows) && o.rows.every((r: unknown) => Array.isArray(r) && r.every(isReplicateSide));
}

/**
 * The replicate dialog's commit endpoint: write a fresh `replicate()`
 * statement (create), re-render one in place (edit), or drop one replica
 * (removeRow) through the shared edit dispatcher — preflight refusals
 * (unresolvable bindings, malformed rows) answer 422 before the editor is
 * touched; the host ack settles the response. Occurrence-chain sides whose
 * sub-assembly doesn't export the handle yet get that export written first,
 * exactly as the mate route sequences them.
 */
export function createAssemblyReplicateRouter(
  fluidCadServer: FluidCadServer,
  dispatcher: FeatureEditDispatcher,
): Router {
  const router = Router();
  const prepareSides = makeSidePreparer(fluidCadServer, dispatcher);

  router.post('/assembly-replicate', async (req, res) => {
    const { filePath, create, edit, removeRow } = req.body ?? {};
    const modes = [create, edit, removeRow].filter(m => m !== undefined).length;
    const editValid = edit === undefined
      || (isReplicatePayload(edit) && Number.isInteger((edit as any).sourceLine) && (edit as any).sourceLine >= 1);
    const removeValid = removeRow === undefined
      || (removeRow !== null && typeof removeRow === 'object'
        && Number.isInteger((removeRow as any).sourceLine) && (removeRow as any).sourceLine >= 1
        && Number.isInteger((removeRow as any).row) && (removeRow as any).row >= 0);
    if (
      typeof filePath !== 'string' || filePath.length === 0
      || modes !== 1
      || (create !== undefined && !isReplicatePayload(create))
      || !editValid
      || !removeValid
    ) {
      res.status(400).json({ error: 'Invalid request body' });
      return;
    }
    const currentFile = fluidCadServer.getCurrentFileName();
    if (!currentFile) {
      res.status(404).json({ error: 'No active scene' });
      return;
    }
    if (detectKind(currentFile) !== 'assembly') {
      res.status(422).json({ success: false, reason: 'Replicate targets an assembly — open a *.assembly.js file first.' });
      return;
    }
    if (normalizePath(filePath) !== normalizePath(currentFile)) {
      // Sub-assembly statements live in the definition's file, and the
      // editor host applies edits against the current buffer only.
      res.status(422).json({
        success: false,
        reason: `this replicate belongs to ${basename(filePath)} — open that file to edit it there.`,
      });
      return;
    }

    let assemblyReplicate: NonNullable<ApplyFeatureEditSpec['assemblyReplicate']>;
    if (removeRow !== undefined) {
      assemblyReplicate = { removeRow: { sourceLine: removeRow.sourceLine, row: removeRow.row } };
    } else {
      const payload = (create ?? edit) as ReplicatePayloadBody;
      // One preparation pass over every side — targets first, then rows in
      // order — so a sub-assembly export needed by several cells is written
      // once and every cell resolves to the same key.
      const flat: ReplicateSideBody[] = [...payload.targets, ...payload.rows.flat()];
      const prepared = await prepareSides(flat);
      if ('status' in prepared) {
        res.status(prepared.status).json(prepared.body);
        return;
      }
      const resolved = prepared.resolved as ReplicateSideRef[];
      const targets = resolved.slice(0, payload.targets.length);
      const rows: ReplicateSideRef[][] = [];
      let cursor = payload.targets.length;
      for (const row of payload.rows) {
        rows.push(resolved.slice(cursor, cursor + row.length));
        cursor += row.length;
      }
      const resolvedPayload: AssemblyReplicatePayload = { seed: payload.seed, targets, rows };
      assemblyReplicate = create !== undefined
        ? { create: resolvedPayload }
        : { edit: { ...resolvedPayload, sourceLine: (edit as any).sourceLine } };
    }

    const spec: ApplyFeatureEditSpec = {
      // Placeholder feature, exactly as assemblyMate rides the round trip:
      // the assemblyReplicate side-channel supersedes every other field.
      feature: 'sketch',
      filePath: currentFile,
      producers: [],
      parts: [],
      imports: [],
      assemblyReplicate,
    };
    await dispatcher.dispatch(res, spec, { success: true });
  });

  return router;
}
