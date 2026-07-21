import { Router } from 'express';
import type { FluidCadServer } from '../fluidcad-server.ts';

export function createParamsRouter(
  fluidCadServer: FluidCadServer,
  sendToExtension: (msg: any) => void,
  broadcastToUI: (msg: any) => void,
): Router {
  const router = Router();

  router.post('/recompute', async (_req, res) => {
    const data = await fluidCadServer.recomputeCurrentFile(true);
    if (!data) {
      res.status(404).json({ error: 'No active scene' });
      return;
    }
    sendToExtension({
      type: 'scene-rendered',
      absPath: data.absPath,
      result: data.result,
      rollbackStop: data.rollbackStop,
    });
    broadcastToUI({
      type: 'scene-rendered',
      result: data.result,
      absPath: data.absPath,
      breakpointHit: data.breakpointHit,
      params: data.params,
    });
    res.json({ success: true });
  });

  router.post('/set-param', async (req, res) => {
    const { label, value } = req.body;
    if (typeof label !== 'string') {
      res.status(400).json({ error: 'Invalid label' });
      return;
    }
    fluidCadServer.setParam(fluidCadServer.getCurrentFileName(), label, value);
    const data = await fluidCadServer.recomputeCurrentFile();
    if (!data) {
      res.status(404).json({ error: 'No active scene' });
      return;
    }
    sendToExtension({
      type: 'scene-rendered',
      absPath: data.absPath,
      result: data.result,
      rollbackStop: data.rollbackStop,
    });
    broadcastToUI({
      type: 'scene-rendered',
      result: data.result,
      absPath: data.absPath,
      rollbackStop: data.rollbackStop,
      params: data.params,
    });
    res.json({ success: true });
  });

  router.post('/reset-params', async (_req, res) => {
    fluidCadServer.resetParams(fluidCadServer.getCurrentFileName());
    const data = await fluidCadServer.recomputeCurrentFile();
    if (!data) {
      res.status(404).json({ error: 'No active scene' });
      return;
    }
    sendToExtension({
      type: 'scene-rendered',
      absPath: data.absPath,
      result: data.result,
      rollbackStop: data.rollbackStop,
    });
    broadcastToUI({
      type: 'scene-rendered',
      result: data.result,
      absPath: data.absPath,
      rollbackStop: data.rollbackStop,
      params: data.params,
    });
    res.json({ success: true });
  });

  return router;
}
