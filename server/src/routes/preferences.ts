import { Router } from 'express';
import {
  GRID_MAJOR_EVERY_RANGE,
  GRID_MIN_CELL_PX_RANGE,
  MEASURE_LENGTH_UNITS,
  loadPreferences,
  savePreferences,
} from '../preferences.ts';

/** A finite number clamped into `[min, max]`, or null when not a number. */
function clampedNumber(value: unknown, [min, max]: [number, number]): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return null;
  }
  return Math.min(max, Math.max(min, value));
}

export function createPreferencesRouter(): Router {
  const router = Router();
  // Writes are read-modify-write on one file, so two POSTs in flight at once
  // (the grid chip persists a pitch and the lock back to back) would each
  // load the pre-edit file and the later `writeFile` could land mid-way
  // through the earlier one — a torn, unparseable preferences.json. One
  // chain serializes them; each request still answers with its own result.
  let writes: Promise<unknown> = Promise.resolve();
  const serialized = <T>(task: () => Promise<T>): Promise<T> => {
    const run = writes.then(task, task);
    writes = run.catch((): undefined => undefined);
    return run;
  };

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
      const saved = await serialized(async () => {
        const current = await loadPreferences();
        if (body.theme && typeof body.theme === 'string') {
          current.theme = body.theme;
        }
        if (typeof body.showGrid === 'boolean') {
          current.showGrid = body.showGrid;
        }
        if (typeof body.showConnectors === 'boolean') {
          current.showConnectors = body.showConnectors;
        }
        if (body.cameraMode === 'perspective' || body.cameraMode === 'orthographic') {
          current.cameraMode = body.cameraMode;
        }
        if (typeof body.showBuildTimings === 'boolean') {
          current.showBuildTimings = body.showBuildTimings;
        }
        if (MEASURE_LENGTH_UNITS.includes(body.measureLengthUnit)) {
          current.measureLengthUnit = body.measureLengthUnit;
        }
        if (typeof body.gridAdaptive === 'boolean') {
          current.gridAdaptive = body.gridAdaptive;
        }
        const minCellPx = clampedNumber(body.gridMinCellPx, GRID_MIN_CELL_PX_RANGE);
        if (minCellPx !== null) {
          current.gridMinCellPx = minCellPx;
        }
        if (body.gridFixedSpacing && typeof body.gridFixedSpacing === 'object') {
          // Per-unit merge: a client sends only the unit it edited, and a
          // non-positive pitch would blank the grid, so each key is validated
          // on its own.
          for (const unit of MEASURE_LENGTH_UNITS) {
            const pitch = body.gridFixedSpacing[unit];
            if (typeof pitch === 'number' && Number.isFinite(pitch) && pitch > 0) {
              current.gridFixedSpacing[unit] = pitch;
            }
          }
        }
        const majorEvery = clampedNumber(body.gridMajorEvery, GRID_MAJOR_EVERY_RANGE);
        if (majorEvery !== null) {
          current.gridMajorEvery = Math.round(majorEvery);
        }
        if (typeof body.editorOpen === 'boolean') {
          current.editorOpen = body.editorOpen;
        }
        if (typeof body.editorWidth === 'number' && Number.isFinite(body.editorWidth)) {
          current.editorWidth = body.editorWidth;
        }
        await savePreferences(current);
        return current;
      });
      res.json(saved);
    } catch (err: any) {
      res.status(500).json({ error: err.message || String(err) });
    }
  });

  return router;
}
