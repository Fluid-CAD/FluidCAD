import { Router } from 'express';
import type { FluidCadServer } from '../fluidcad-server.ts';

export function createSceneRouter(fluidCadServer: FluidCadServer): Router {
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

  return router;
}
