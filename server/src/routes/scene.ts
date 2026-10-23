import { Router } from 'express';
import type { FluidCadServer } from '../fluidcad-server/index.ts';
import type { CameraStateMessage } from '../ws-protocol.ts';

export type CameraStateGetter = () => CameraStateMessage | null;

/**
 * One project parameter as `GET /scene/summary` lists it under
 * `globalParams` — enough for an agent to read the project's dimensions
 * without opening the `*.params.js` files (`docs/global-parameters-plan.md`
 * §3.6). `file` is workspace-relative: what an import of the value names.
 */
export type SceneSummaryGlobalParam = {
  name: string;
  label: string;
  value: string | number | boolean | (string | number)[] | null;
  file: string;
};

/** The catalog's rows, in file then source order; absent when the server has no catalog. */
export type GlobalParamsGetter = () => Promise<SceneSummaryGlobalParam[]>;

export function createSceneRouter(
  fluidCadServer: FluidCadServer,
  getCameraState: CameraStateGetter = () => null,
  getGlobalParams?: GlobalParamsGetter,
): Router {
  const router = Router();

  router.get('/scene/summary', async (_req, res) => {
    try {
      const summary = fluidCadServer.getSceneSummary();
      if (!summary) {
        res.status(404).json({ error: 'No scene available — the workspace has not rendered a file yet.' });
        return;
      }
      // The file's `configurations()` table and the row on screen, as the
      // last render declared them — left out of a file without a table.
      // (Optional: a server predating configurations has no accessor.)
      const table = fluidCadServer.getConfigurations?.(summary.file);
      const configurations = table && table.names.length > 0
        ? { configurations: { active: table.active, names: table.names, rows: table.rows, modified: table.modified } }
        : {};
      if (!getGlobalParams) {
        res.json({ ...summary, ...configurations });
        return;
      }
      // The catalog is a static scan of the params files, so a row is listed
      // whether or not the open model imports it; a scan failure must not
      // take the feature tree down with it.
      const globalParams = await getGlobalParams().catch((): SceneSummaryGlobalParam[] => []);
      res.json({ ...summary, ...configurations, globalParams });
    } catch (err: any) {
      res.status(500).json({ error: err?.message ?? String(err) });
    }
  });

  router.get('/scene/shapes', (_req, res) => {
    try {
      const shapes = fluidCadServer.getShapesList();
      if (!shapes) {
        res.status(404).json({ error: 'No scene available — the workspace has not rendered a file yet.' });
        return;
      }
      res.json(shapes);
    } catch (err: any) {
      res.status(500).json({ error: err?.message ?? String(err) });
    }
  });

  router.get('/scene/compile-error', (_req, res) => {
    try {
      const compileError = fluidCadServer.getCompileError();
      res.json({ compileError });
    } catch (err: any) {
      res.status(500).json({ error: err?.message ?? String(err) });
    }
  });

  router.get('/camera/state', (_req, res) => {
    const state = getCameraState();
    if (!state) {
      res.status(404).json({ error: 'No camera state available yet — the UI has not connected, or no view change has been observed.' });
      return;
    }
    res.json(state);
  });

  return router;
}
