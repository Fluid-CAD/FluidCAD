import { Router } from 'express';
import type { AssemblyPreviews } from '../assembly-preview/assembly-previews.ts';

/**
 * The assembly dialog's live preview (generators G4; the rules are
 * `AssemblyPreviews`'):
 *
 * `POST /api/assembly-preview` — `{ token, mode: 'create' | 'edit',
 * filePath, detail?: 'preview' | 'full', values, newVariables?,
 * definition: { file, exportName } (create), line, unset?, row? (edit) }`.
 * Renders the file on screen with the edit applied in memory as the
 * session's scene (`scene-rendered` with `preview: { token }`); nothing is
 * written. Answers `{ state: 'rendered' | 'build-error', token, version,
 * absPath, objectErrors?, timings, generated }`, `{ state: 'compile-error',
 * token, version, compileError, timings }` or `{ state: 'superseded', token,
 * reason }`; 400 for a malformed body, 404 with no scene, 422/403/409 as the
 * writer (or the pin its Apply writes) would refuse the edit.
 *
 * `POST /api/assembly-preview/end` — `{ token }`. Ends the preview and
 * renders the file's own code again: that render's outcome (`/api/render`'s
 * shape) with `token`, or `{ state: 'inactive', token }` when the preview's
 * scene was no longer the session's.
 */
export function createAssemblyPreviewRouter(previews: AssemblyPreviews): Router {
  const router = Router();

  router.post('/assembly-preview', async (req, res) => {
    const answer = await previews.request(req.body);
    res.status(answer.status).json(answer.body);
  });

  router.post('/assembly-preview/end', async (req, res) => {
    const answer = await previews.end(req.body);
    res.status(answer.status).json(answer.body);
  });

  return router;
}
