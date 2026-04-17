import { Router } from 'express';
import { loadPreferences, savePreferences } from '../preferences.ts';

export function createPreferencesRouter(): Router {
  const router = Router();

  router.get('/preferences', async (_req, res) => {
    try {
      const prefs = await loadPreferences();
      res.json(prefs);
    } catch (err: any) {
      res.status(500).json({ error: err.message || String(err) });
    }
  });

  router.post('/preferences', async (req, res) => {
    try {
      const body = req.body;
      const current = await loadPreferences();
      if (body.theme && typeof body.theme === 'string') {
        current.theme = body.theme;
      }
      if (typeof body.showGrid === 'boolean') {
        current.showGrid = body.showGrid;
      }
      if (body.cameraMode === 'perspective' || body.cameraMode === 'orthographic') {
        current.cameraMode = body.cameraMode;
      }
      if (typeof body.showBuildTimings === 'boolean') {
        current.showBuildTimings = body.showBuildTimings;
      }
      await savePreferences(current);
      res.json(current);
    } catch (err: any) {
      res.status(500).json({ error: err.message || String(err) });
    }
  });

  return router;
}
