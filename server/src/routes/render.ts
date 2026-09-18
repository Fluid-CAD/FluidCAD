import { Router } from 'express';
import type { CompileError } from '../ws-protocol.ts';
import type { ObjectBuildError } from '../fluidcad-server.ts';
import type { RenderChanges } from '../../../lib/dist/index.js';

/**
 * How long a caller that asked for `uiApplied` waits for a page to put the
 * render on screen before the answer is "not yet".
 */
export const UI_APPLY_WAIT_MS = 10_000;

export type RenderOutcome =
  | { state: 'rendered'; version: number; absPath: string; durationMs: number; changes?: RenderChanges; uiApplied?: boolean }
  | {
      state: 'build-error';
      version: number;
      absPath: string;
      durationMs: number;
      objectErrors: ObjectBuildError[];
      changes?: RenderChanges;
      uiApplied?: boolean;
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
 * `changes` asks for the render's change summary (`RenderChanges`: the scene
 * objects rebuilt / added / removed, with exact bounds, and the reused
 * count) under `changes` of a `rendered` / `build-error` outcome. Only the
 * MCP's write tools set it; the in-page host never does, and a render
 * without it is byte-for-byte the render it always was.
 *
 * `awaitUi` (MCP only) holds the response until a connected viewer has the
 * render on screen, and reports it as `uiApplied` — "built" and "visible"
 * are different moments, and an agent about to look at the model needs the
 * second. False when no viewer is connected or it is still applying the
 * scene after `UI_APPLY_WAIT_MS`.
 *
 * Whoever invokes this is responsible for the on-disk write — we only run
 * the render. Pairing both in one HTTP round-trip is what lets MCP
 * `write_file` return a synchronous { written, render } to the agent.
 */
export function createRenderRouter(
  runLiveRender: (fileName: string, code: string, keepCurrent: boolean, changes: boolean) => Promise<RenderOutcome>,
  awaitSceneApplied: (timeoutMs: number) => Promise<boolean> = async () => false,
): Router {
  const router = Router();

  router.post('/render', async (req, res) => {
    const { filePath, code, keepCurrent, changes, awaitUi } = req.body ?? {};
    if (typeof filePath !== 'string' || filePath.length === 0) {
      res.status(400).json({ error: '`filePath` must be a non-empty string.' });
      return;
    }
    if (typeof code !== 'string') {
      res.status(400).json({ error: '`code` must be a string.' });
      return;
    }

    try {
      const outcome = await runLiveRender(filePath, code, keepCurrent === true, changes === true);
      if (awaitUi === true && (outcome.state === 'rendered' || outcome.state === 'build-error')) {
        outcome.uiApplied = await awaitSceneApplied(UI_APPLY_WAIT_MS);
      }
      res.json(outcome);
    } catch (err: any) {
      res.status(500).json({ error: err?.message ?? String(err) });
    }
  });

  return router;
}
