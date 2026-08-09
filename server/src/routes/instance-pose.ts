import { Router } from 'express';
import { basename } from 'path';
import type { FluidCadServer } from '../fluidcad-server.ts';
import type { FeatureEditDispatcher } from '../edit-dispatch.ts';
import type { ApplyFeatureEditSpec } from '../apply-feature-edit.ts';
import { normalizePath } from '../normalize-path.ts';
import { detectKind } from '../file-kind.ts';

function isVec3(v: unknown): v is [number, number, number] {
  return Array.isArray(v) && v.length === 3 && v.every(n => typeof n === 'number' && Number.isFinite(n));
}

/**
 * The assembly transform gizmo's commit endpoint: rewrite an `insert()`
 * chain's `.translate()`/`.rotate()` calls to the instance's final world
 * pose, through the shared edit dispatcher (preflight refusals answer 422
 * before the editor is touched; the host ack settles the response).
 */
export function createInstancePoseRouter(
  fluidCadServer: FluidCadServer,
  dispatcher: FeatureEditDispatcher,
): Router {
  const router = Router();

  router.post('/instance-pose', async (req, res) => {
    const { filePath, sourceLine, position, rotateXYZ } = req.body ?? {};
    if (
      typeof filePath !== 'string' || filePath.length === 0
      || !Number.isInteger(sourceLine) || sourceLine < 1
      || !isVec3(position)
      || (rotateXYZ !== null && !isVec3(rotateXYZ))
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
      instancePose: { sourceLine, position, rotateXYZ },
    };
    await dispatcher.dispatch(res, spec, { success: true });
  });

  return router;
}
