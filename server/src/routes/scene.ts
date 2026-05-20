import { Router } from 'express';
import type { FluidCadServer } from '../fluidcad-server.ts';
import type { CameraStateMessage } from '../ws-protocol.ts';

export type CameraStateGetter = () => CameraStateMessage | null;

export function createSceneRouter(
  fluidCadServer: FluidCadServer,
  getCameraState: CameraStateGetter = () => null,
): Router {
  const router = Router();

  router.get('/scene/summary', (_req, res) => {
    try {
      const summary = fluidCadServer.getSceneSummary();
      if (!summary) {
        res.status(404).json({ error: 'No scene available — the workspace has not rendered a file yet.' });
        return;
      }
      res.json(summary);
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
