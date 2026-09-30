import { Router } from 'express';
import type { FluidCadServer } from '../fluidcad-server/index.ts';
import type { FeatureEditDispatcher } from '../edit-dispatch.ts';
import type { ApplyFeatureEditSpec } from '../apply-feature-edit/index.ts';
import { normalizePath } from '../normalize-path.ts';

/**
 * The section arrow's commit endpoint: rewrite the `offset` (and `flip`) of
 * the `section()` statement at `sourceLine` in place, through the shared
 * edit dispatcher (preflight refusals answer 422 before the editor is
 * touched; the host ack settles the response).
 */
export function createSectionRouter(
  fluidCadServer: FluidCadServer,
  dispatcher: FeatureEditDispatcher,
): Router {
  const router = Router();

  router.post('/section-options', async (req, res) => {
    const { filePath, sourceLine, offset, flip } = req.body ?? {};
    if (
      typeof filePath !== 'string' || filePath.length === 0
      || !Number.isInteger(sourceLine) || sourceLine < 1
      || typeof offset !== 'number' || !Number.isFinite(offset)
      || typeof flip !== 'boolean'
    ) {
      res.status(400).json({ error: 'Invalid request body: { filePath, sourceLine, offset, flip }' });
      return;
    }
    const currentFile = fluidCadServer.getCurrentFileName();
    if (!currentFile) {
      res.status(404).json({ error: 'No active scene' });
      return;
    }
    if (normalizePath(filePath) !== normalizePath(currentFile)) {
      res.status(422).json({ success: false, reason: 'that section lives in a different file than the one being edited' });
      return;
    }
    const spec: ApplyFeatureEditSpec = {
      // Placeholder feature, exactly as instancePose rides the round trip:
      // the sectionOptions side-channel supersedes every other field.
      feature: 'section',
      filePath: currentFile,
      producers: [],
      parts: [],
      imports: [],
      sectionOptions: { sourceLine, offset, flip },
    };
    await dispatcher.dispatch(res, spec, { success: true });
  });

  return router;
}
