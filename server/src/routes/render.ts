import { Router } from 'express';
import type { CompileError } from '../ws-protocol.ts';
import type { ObjectBuildError } from '../fluidcad-server.ts';

export type RenderOutcome =
  | { state: 'rendered'; version: number; absPath: string; durationMs: number }
  | {
      state: 'build-error';
      version: number;
      absPath: string;
      durationMs: number;
      objectErrors: ObjectBuildError[];
    }
  | { state: 'compile-error'; version: number; durationMs: number; compileError: CompileError }
  | { state: 'superseded'; version: number; durationMs: number }
  | { state: 'no-scene-manager'; version: number; durationMs: number };

/**
 * `POST /api/render` — synchronous render trigger used by the MCP server
 * after it writes a `.fluid.js` file, and by the in-page editor host as its
 * `live-update`. The body carries the post-write contents so the server
 * doesn't need to re-read disk and so dedup against `lastRendered` is exact.
 * Returns the render outcome (rendered / build-error / compile-error /
 * superseded / no-scene-manager) once the OCC pass settles.
 *
 * `keepCurrent` mirrors the IPC `live-update` flag: a host that just applied
 * an edit to a file other than the rendered one (the mate dialog writing a
 * connector() into a PART file while the assembly is on screen) passes true,
 * and the file folds in as a dependency of the current model instead of the
 * viewport switching to it.
 *
 * `compile-error` and `build-error` are different failures: the module didn't
 * run at all vs. it ran and one of its features failed to build. The second
 * still produces a scene, just not the one the source describes.
 *
 * Whoever invokes this is responsible for the on-disk write — we only run
 * the render. Pairing both in one HTTP round-trip is what lets MCP
 * `write_file` return a synchronous { written, render } to the agent.
 */
export function createRenderRouter(
  runLiveRender: (fileName: string, code: string, keepCurrent: boolean) => Promise<RenderOutcome>,
): Router {
  const router = Router();

  router.post('/render', async (req, res) => {
    const { filePath, code, keepCurrent } = req.body ?? {};
    if (typeof filePath !== 'string' || filePath.length === 0) {
      res.status(400).json({ error: '`filePath` must be a non-empty string.' });
      return;
    }
    if (typeof code !== 'string') {
      res.status(400).json({ error: '`code` must be a string.' });
      return;
    }

    try {
      const outcome = await runLiveRender(filePath, code, keepCurrent === true);
      res.json(outcome);
    } catch (err: any) {
      res.status(500).json({ error: err?.message ?? String(err) });
    }
  });

  return router;
}
