import { Router } from 'express';
import { basename } from 'path';
import type { FluidCadServer } from '../fluidcad-server.ts';
import type { FeatureEditDispatcher } from '../edit-dispatch.ts';
import type { ApplyFeatureEditSpec } from '../apply-feature-edit.ts';
import { isExpressionText } from '../apply-feature-edit.ts';
import { getInsertRotateExpressions, getInsertTranslateExpressions } from '../insert-chain-edit.ts';
import { normalizePath } from '../normalize-path.ts';
import { detectKind } from '../file-kind.ts';

function isVec3(v: unknown): v is [number, number, number] {
  return Array.isArray(v) && v.length === 3 && v.every(n => typeof n === 'number' && Number.isFinite(n));
}

/** `[string|null, string|null, string|null]` of safe expression texts. */
function isAxisExprs(v: unknown): v is [string | null, string | null, string | null] {
  return Array.isArray(v) && v.length === 3
    && v.every(e => e === null || isExpressionText(e));
}

function isNewVariables(v: unknown): v is { name: string; initializer: string }[] {
  return Array.isArray(v) && v.every(nv =>
    nv !== null && typeof nv === 'object'
    && typeof (nv as any).name === 'string'
    && typeof (nv as any).initializer === 'string');
}

/**
 * The assembly transform gizmo's commit endpoint: rewrite an `insert()`
 * chain's `.translate()`/`.rotate()` calls to the instance's final world
 * pose, through the shared edit dispatcher (preflight refusals answer 422
 * before the editor is touched; the host ack settles the response).
 * `translateExprs` carries per-axis source text — a typed expression on the
 * edited axis, echoed existing text on untouched ones — and `newVariables`
 * the declarations an expression commit introduced.
 */
export function createInstancePoseRouter(
  fluidCadServer: FluidCadServer,
  dispatcher: FeatureEditDispatcher,
): Router {
  const router = Router();

  router.post('/instance-pose', async (req, res) => {
    const { filePath, sourceLine, position, rotateXYZ, translateExprs, rotateExprs, newVariables } = req.body ?? {};
    if (
      typeof filePath !== 'string' || filePath.length === 0
      || !Number.isInteger(sourceLine) || sourceLine < 1
      || !isVec3(position)
      || (rotateXYZ !== null && !isVec3(rotateXYZ))
      || (translateExprs !== undefined && translateExprs !== null && !isAxisExprs(translateExprs))
      || (rotateExprs !== undefined && rotateExprs !== null && !isAxisExprs(rotateExprs))
      || (newVariables !== undefined && newVariables !== null && !isNewVariables(newVariables))
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
      res.status(422).json({ success: false, reason: 'Moving instances targets an assembly — open a *.assembly.js file first.' });
      return;
    }
    if (normalizePath(filePath) !== normalizePath(currentFile)) {
      // Sub-assembly instances: their insert() lives in the factory's file,
      // and the editor host applies edits against the current buffer only.
      res.status(422).json({
        success: false,
        reason: `this instance's insert() lives in ${basename(filePath)} — open that file to move it there.`,
      });
      return;
    }
    const spec: ApplyFeatureEditSpec = {
      // Placeholder feature, exactly as insertPart rides the round trip: the
      // instancePose side-channel supersedes every other field.
      feature: 'sketch',
      filePath: currentFile,
      producers: [],
      parts: [],
      imports: [],
      instancePose: {
        sourceLine,
        position,
        rotateXYZ,
        translateExprs: translateExprs ?? null,
        rotateExprs: rotateExprs ?? null,
      },
      newVariables: newVariables ?? undefined,
    };
    await dispatcher.dispatch(res, spec, { success: true });
  });

  // Edit-parameters commit: merge the dialog's changed values into the
  // insert() statement's second argument. Same shape as /instance-pose —
  // cross-file targets 422 (a sub-assembly's insert() lives in its own file).
  router.post('/update-insert-params', async (req, res) => {
    const { filePath, sourceLine, set } = req.body ?? {};
    if (
      typeof filePath !== 'string' || filePath.length === 0
      || !Number.isInteger(sourceLine) || sourceLine < 1
      || set === null || typeof set !== 'object' || Array.isArray(set)
      || Object.keys(set).length === 0
    ) {
      res.status(400).json({ error: 'Invalid request body' });
      return;
    }
    const currentFile = fluidCadServer.getCurrentFileName();
    if (!currentFile) {
      res.status(404).json({ error: 'No active scene' });
      return;
    }
    if (normalizePath(filePath) !== normalizePath(currentFile)) {
      res.status(422).json({
        success: false,
        reason: `this insert() lives in ${basename(filePath)} — open that file to edit its parameters.`,
      });
      return;
    }
    const spec: ApplyFeatureEditSpec = {
      feature: 'sketch',
      filePath: currentFile,
      producers: [],
      parts: [],
      imports: [],
      insertParams: { line: sourceLine, set },
    };
    await dispatcher.dispatch(res, spec, { success: true });
  });

  // The gizmo's absolute-value inputs read the exact `.translate()` argument
  // and `.rotate()` angle texts to seed the field and to echo untouched axes
  // back on commit. Each block is null when the chain shape doesn't equate
  // its args with the world pose (translate: not exactly one translate-last;
  // rotate: calls not in canonical x→y→z literal-axis order) or the insert()
  // lives in another file; per-axis null for unsafe or absent argument text.
  router.post('/instance-pose-expressions', async (req, res) => {
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
      const [translate, rotate] = await Promise.all([
        getInsertTranslateExpressions(code, sourceLine),
        getInsertRotateExpressions(code, sourceLine),
      ]);
      const safe = (s: string | null) => (s !== null && isExpressionText(s) ? s : null);
      res.json({
        expressions: {
          translate: translate
            ? { x: safe(translate.x), y: safe(translate.y), z: safe(translate.z) }
            : null,
          rotate: rotate
            ? { x: safe(rotate.x), y: safe(rotate.y), z: safe(rotate.z) }
            : null,
        },
      });
    } catch (err: any) {
      res.status(500).json({ error: err?.message || String(err) });
    }
  });

  return router;
}
