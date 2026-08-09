import { Router } from 'express';
import { basename } from 'path';
import { readFile } from 'fs/promises';
import type { FluidCadServer } from '../fluidcad-server.ts';
import type { FeatureEditDispatcher } from '../edit-dispatch.ts';
import { parseFeatureStatement, type ApplyFeatureEditSpec } from '../apply-feature-edit.ts';
import {
  ASSEMBLY_MATE_TYPES,
  type AssemblyMateOptions,
  type AssemblyMateType,
  type MateConnectorRef,
} from '../assembly-mate-edit.ts';
import { normalizePath } from '../normalize-path.ts';
import { detectKind } from '../file-kind.ts';

function isConnectorRef(v: unknown): v is MateConnectorRef {
  return v !== null && typeof v === 'object'
    && Number.isInteger((v as any).instanceLine) && (v as any).instanceLine >= 1
    && typeof (v as any).connectorName === 'string' && (v as any).connectorName.length > 0
    && ((v as any).scope === undefined || (v as any).scope === 'part' || (v as any).scope === 'instance');
}

function isPair(v: unknown): v is [number, number] {
  return Array.isArray(v) && v.length === 2 && v.every(n => typeof n === 'number' && Number.isFinite(n));
}

function isVec3(v: unknown): v is [number, number, number] {
  return Array.isArray(v) && v.length === 3 && v.every(n => typeof n === 'number' && Number.isFinite(n));
}

function isMateOptions(v: unknown): v is AssemblyMateOptions {
  if (v === undefined) {
    return true;
  }
  if (v === null || typeof v !== 'object') {
    return false;
  }
  const o = v as any;
  return (o.flip === undefined || typeof o.flip === 'boolean')
    && (o.rotate === undefined || (typeof o.rotate === 'number' && Number.isFinite(o.rotate)))
    && (o.offset === undefined || o.offset === null || isVec3(o.offset))
    && (o.limits === undefined || o.limits === null || isPair(o.limits));
}

function isMatePayload(v: unknown): v is {
  type: AssemblyMateType;
  connectorA: MateConnectorRef;
  connectorB: MateConnectorRef;
  options?: AssemblyMateOptions;
} {
  return v !== null && typeof v === 'object'
    && ASSEMBLY_MATE_TYPES.includes((v as any).type)
    && isConnectorRef((v as any).connectorA)
    && isConnectorRef((v as any).connectorB)
    && isMateOptions((v as any).options);
}

/**
 * The mate dialog's commit endpoint: write a fresh `mate()` statement (create)
 * or re-render an existing one in place (edit), through the shared edit
 * dispatcher — preflight refusals (unresolvable insert bindings, option/type
 * conflicts) answer 422 before the editor is touched; the host ack settles
 * the response.
 */
export function createAssemblyMateRouter(
  fluidCadServer: FluidCadServer,
  dispatcher: FeatureEditDispatcher,
): Router {
  const router = Router();

  router.post('/assembly-mate', async (req, res) => {
    const { filePath, create, edit } = req.body ?? {};
    const editValid = edit === undefined
      || (isMatePayload(edit) && Number.isInteger((edit as any).sourceLine) && (edit as any).sourceLine >= 1);
    if (
      typeof filePath !== 'string' || filePath.length === 0
      || (create === undefined) === (edit === undefined)
      || (create !== undefined && !isMatePayload(create))
      || !editValid
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
      res.status(422).json({ success: false, reason: 'Mates target an assembly — open a *.assembly.js file first.' });
      return;
    }
    if (normalizePath(filePath) !== normalizePath(currentFile)) {
      // Sub-assembly mates live in the factory's file, and the editor host
      // applies edits against the current buffer only.
      res.status(422).json({
        success: false,
        reason: `this mate belongs to ${basename(filePath)} — open that file to edit it there.`,
      });
      return;
    }
    const spec: ApplyFeatureEditSpec = {
      // Placeholder feature, exactly as insertPart rides the round trip: the
      // assemblyMate side-channel supersedes every other field.
      feature: 'sketch',
      filePath: currentFile,
      producers: [],
      parts: [],
      imports: [],
      assemblyMate: create !== undefined ? { create } : { edit },
    };
    await dispatcher.dispatch(res, spec, { success: true });
  });

  // The mate dialog's pen button: read the connector statement's dialog-
  // editable properties from its part file. The current buffer serves the
  // open file; other files read from disk (an unsaved part buffer can be
  // stale here — the write path's editor round-trip is what verifies).
  router.post('/assembly-connector-properties', async (req, res) => {
    const { filePath, sourceLine } = req.body ?? {};
    if (
      typeof filePath !== 'string' || filePath.length === 0
      || !Number.isInteger(sourceLine) || sourceLine < 1
    ) {
      res.status(400).json({ error: 'Invalid request body' });
      return;
    }
    let code: string | null = null;
    if (normalizePath(filePath) === normalizePath(fluidCadServer.getCurrentFileName() ?? '')) {
      code = fluidCadServer.getCurrentCode();
    }
    if (code === null) {
      try {
        code = await readFile(filePath, 'utf8');
      } catch {
        res.status(404).json({ error: `could not read ${basename(filePath)}` });
        return;
      }
    }
    const result = await parseFeatureStatement(code, sourceLine);
    if (result.ok !== true) {
      res.status(422).json({ error: result.reason });
      return;
    }
    if (result.parsed.feature !== 'connector') {
      res.status(422).json({ error: `the statement on line ${sourceLine} is not a connector()` });
      return;
    }
    const { name, rotate, offset } = result.parsed;
    res.json({ name, rotate, offset });
  });

  // The pen button's apply: rewrite the connector statement in its part
  // file through the shared dispatcher. The spec's filePath is the part
  // file, so the dispatcher's current-file preflight self-skips and the
  // editor host's round-trip applies and verifies the transform.
  router.post('/assembly-connector', async (req, res) => {
    const { filePath, sourceLine, name, rotate, offset } = req.body ?? {};
    const rotateValid = rotate === null
      || (rotate !== undefined && typeof rotate === 'object' && rotate !== null
        && ['x', 'y', 'z'].includes((rotate as any).axis)
        && typeof (rotate as any).angle === 'number' && Number.isFinite((rotate as any).angle));
    if (
      typeof filePath !== 'string' || filePath.length === 0
      || !Number.isInteger(sourceLine) || sourceLine < 1
      || typeof name !== 'string' || name.length === 0
      || !rotateValid
      || (offset !== null && !isVec3(offset))
    ) {
      res.status(400).json({ error: 'Invalid request body' });
      return;
    }
    if (!fluidCadServer.getCurrentFileName()) {
      res.status(404).json({ error: 'No active scene' });
      return;
    }
    const spec: ApplyFeatureEditSpec = {
      feature: 'sketch',
      filePath,
      producers: [],
      parts: [],
      imports: [],
      connectorProps: { sourceLine, name, rotate, offset },
    };
    await dispatcher.dispatch(res, spec, { success: true });
  });

  return router;
}
