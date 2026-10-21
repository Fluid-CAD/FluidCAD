import { Router } from 'express';
import { sceneStopFields, sceneUnitFields } from '../fluidcad-server/index.ts';
import type { FluidCadServer, SceneRenderedData } from '../fluidcad-server/index.ts';

/**
 * The active configuration of the file on screen
 * (`docs/assembly-configurations-plan.md` §3.3, §4.2).
 *
 * - `GET /api/configurations` → `{ active, names, rows, modified }` as the
 *   last render declared them; `{ active: 'Default', names: [], rows: {},
 *   modified }` for a file without a `configurations()` table (or before any
 *   render).
 * - `POST /api/configurations/select { name }` → switch the session to the
 *   named row (`'Default'` for the literals), drop its overrides, re-render
 *   and fan the render out exactly as `/set-param` does; answers
 *   `{ success: true, configurations }` with the render's summary. The row
 *   editing routes (`/add`, `/save`, `/rename`, `/remove`, `/table`) come
 *   with the `ConfigurationEditor`.
 */
export function createConfigurationsRouter(
  fluidCadServer: FluidCadServer,
  sendToExtension: (msg: any) => void,
  broadcastToUI: (msg: any) => void,
): Router {
  const router = Router();

  function broadcastRender(data: SceneRenderedData): void {
    sendToExtension({
      type: 'scene-rendered',
      absPath: data.absPath,
      sceneKind: data.sceneKind,
      ...sceneUnitFields(data),
      result: data.result,
      ...sceneStopFields(data),
      ...(data.assembly ? { assembly: data.assembly } : {}),
    });
    broadcastToUI({
      type: 'scene-rendered',
      result: data.result,
      absPath: data.absPath,
      sceneKind: data.sceneKind,
      ...sceneUnitFields(data),
      ...sceneStopFields(data),
      params: data.params,
      properties: data.properties,
      ...(data.configurations ? { configurations: data.configurations } : {}),
      ...(data.assembly ? { assembly: data.assembly } : {}),
    });
  }

  router.get('/configurations', (_req, res) => {
    const file = fluidCadServer.getCurrentFileName();
    if (!file) {
      res.json({ active: 'Default', names: [], rows: {}, modified: false });
      return;
    }
    res.json(fluidCadServer.getConfigurations(file));
  });

  router.post('/configurations/select', async (req, res) => {
    const name = req.body?.name;
    if (typeof name !== 'string' || name.trim() === '') {
      res.status(400).json({ error: 'name must be a non-empty string — a configuration row, or Default' });
      return;
    }
    const file = fluidCadServer.getCurrentFileName();
    if (!file) {
      res.status(404).json({ error: 'No active scene' });
      return;
    }
    fluidCadServer.selectConfiguration(file, name);
    const data = await fluidCadServer.recomputeCurrentFile();
    if (!data) {
      res.status(404).json({ error: 'No active scene' });
      return;
    }
    broadcastRender(data);
    res.json({ success: true, ...(data.configurations ? { configurations: data.configurations } : {}) });
  });

  return router;
}
