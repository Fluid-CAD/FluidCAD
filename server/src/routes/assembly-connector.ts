import { Router } from 'express';
import { basename } from 'path';
import type { FluidCadServer } from '../fluidcad-server.ts';
import type { FeatureEditDispatcher } from '../edit-dispatch.ts';
import type { ApplyFeatureEditSpec } from '../apply-feature-edit.ts';
import { isExpressionText } from '../apply-feature-edit.ts';
import {
  getAssemblyConnectorExpressions, listAssemblyConnectorNames, validateAssemblyConnectorSpec,
  type AssemblyConnectorEditSpec,
} from '../assembly-connector-edit.ts';
import { normalizePath } from '../normalize-path.ts';
import { detectKind } from '../file-kind.ts';

function isVec3(v: unknown): v is [number, number, number] {
  return Array.isArray(v) && v.length === 3 && v.every(n => typeof n === 'number' && Number.isFinite(n));
}

function isAxisExprs(v: unknown): v is [string | null, string | null, string | null] {
  return Array.isArray(v) && v.length === 3 && v.every(e => e === null || typeof e === 'string');
}

function isNewVariables(v: unknown): v is { name: string; initializer: string }[] {
  return Array.isArray(v) && v.every(nv =>
    nv !== null && typeof nv === 'object'
    && typeof (nv as any).name === 'string'
    && typeof (nv as any).initializer === 'string');
}

/**
 * The assembly-connector dialog's endpoints: `/assembly-connector` writes
 * or rewrites a `connector('name', [x, y, z])<rotates>` statement through
 * the shared edit dispatcher; `/assembly-connector-expressions` reads the
 * exact tuple and angle texts to seed the dialog; `/assembly-connector-names`
 * lists the declared names for default-name allocation.
 */
export function createAssemblyConnectorRouter(
  fluidCadServer: FluidCadServer,
  dispatcher: FeatureEditDispatcher,
): Router {
  const router = Router();

  router.post('/assembly-connector', async (req, res) => {
    const { filePath, create, edit, position, rotateXYZ, positionExprs, rotateExprs, newVariables } = req.body ?? {};
    const createValid = create === undefined
      || (create !== null && typeof create === 'object' && typeof create.name === 'string');
    const editValid = edit === undefined
      || (edit !== null && typeof edit === 'object' && typeof edit.name === 'string'
        && Number.isInteger(edit.sourceLine) && edit.sourceLine >= 1);
    if (
      typeof filePath !== 'string' || filePath.length === 0
      || (create === undefined) === (edit === undefined)
      || !createValid || !editValid
      || !isVec3(position)
      || (rotateXYZ !== null && !isVec3(rotateXYZ))
      || (positionExprs !== undefined && positionExprs !== null && !isAxisExprs(positionExprs))
      || (rotateExprs !== undefined && rotateExprs !== null && !isAxisExprs(rotateExprs))
      || (newVariables !== undefined && newVariables !== null && !isNewVariables(newVariables))
    ) {
      res.status(400).json({ error: 'Invalid request body' });
      return;
    }
    const spec: AssemblyConnectorEditSpec = {
      create,
      edit,
      position,
      rotateXYZ,
      positionExprs: positionExprs ?? null,
      rotateExprs: rotateExprs ?? null,
    };
    const invalid = validateAssemblyConnectorSpec(spec);
    if (invalid) {
      res.status(400).json({ error: invalid });
      return;
    }
    for (const expr of [...(spec.positionExprs ?? []), ...(spec.rotateExprs ?? [])]) {
      if (expr !== null && !isExpressionText(expr)) {
        res.status(400).json({ error: 'malformed connector expression' });
        return;
      }
    }
    const currentFile = fluidCadServer.getCurrentFileName();
    if (!currentFile) {
      res.status(404).json({ error: 'No active scene' });
      return;
    }
    if (detectKind(currentFile) !== 'assembly') {
      res.status(422).json({ success: false, reason: 'Assembly connectors target an assembly — open a *.assembly.js file first.' });
      return;
    }
    if (normalizePath(filePath) !== normalizePath(currentFile)) {
      res.status(422).json({
        success: false,
        reason: `this connector belongs to ${basename(filePath)} — open that file to edit it there.`,
      });
      return;
    }
    const edit_spec: ApplyFeatureEditSpec = {
      // Placeholder feature, exactly as instancePose rides the round trip:
      // the assemblyConnector side-channel supersedes every other field.
      feature: 'sketch',
      filePath: currentFile,
      producers: [],
      parts: [],
      imports: [],
      assemblyConnector: spec,
      newVariables: newVariables ?? undefined,
    };
    await dispatcher.dispatch(res, edit_spec, { success: true });
  });

  router.post('/assembly-connector-expressions', async (req, res) => {
    const { filePath, sourceLine } = req.body ?? {};
    if (
      typeof filePath !== 'string' || filePath.length === 0
      || !Number.isInteger(sourceLine) || sourceLine < 1
    ) {
      res.status(400).json({ error: 'Invalid request body' });
      return;
    }
    const currentFile = fluidCadServer.getCurrentFileName();
    const code = fluidCadServer.getCurrentCode();
    if (!currentFile || !code || normalizePath(filePath) !== normalizePath(currentFile)) {
      res.json({ expressions: null });
      return;
    }
    try {
      const expressions = await getAssemblyConnectorExpressions(code, sourceLine);
      if (!expressions) {
        res.json({ expressions: null });
        return;
      }
      const safe = (s: string | null) => (s !== null && isExpressionText(s) ? s : null);
      res.json({
        expressions: {
          position: expressions.position
            ? { x: safe(expressions.position.x), y: safe(expressions.position.y), z: safe(expressions.position.z) }
            : null,
          rotate: expressions.rotate
            ? { x: safe(expressions.rotate.x), y: safe(expressions.rotate.y), z: safe(expressions.rotate.z) }
            : null,
        },
      });
    } catch (err: any) {
      res.status(500).json({ error: err?.message || String(err) });
    }
  });

  router.post('/assembly-connector-names', async (req, res) => {
    const { filePath } = req.body ?? {};
    const currentFile = fluidCadServer.getCurrentFileName();
    const code = fluidCadServer.getCurrentCode();
    if (typeof filePath !== 'string' || !currentFile || !code || normalizePath(filePath) !== normalizePath(currentFile)) {
      res.json({ names: [] });
      return;
    }
    try {
      res.json({ names: await listAssemblyConnectorNames(code) });
    } catch (err: any) {
      res.status(500).json({ error: err?.message || String(err) });
    }
  });

  return router;
}
