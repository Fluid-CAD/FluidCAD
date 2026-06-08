import { Router } from 'express';
import type { FluidCadServer } from '../fluidcad-server.ts';

export function createTimelineRouter(
  fluidCadServer: FluidCadServer,
  sendToExtension: (msg: any) => void,
  broadcastToUI: (msg: any) => void,
): Router {
  const router = Router();

  router.post('/rollback', async (req, res) => {
    const { index } = req.body;
    if (typeof index !== 'number' || index < 0) {
      res.status(400).json({ error: 'Invalid index' });
      return;
    }
    const data = await fluidCadServer.rollbackFromUI(index);
    if (!data) {
      res.status(404).json({ error: 'No active scene' });
      return;
    }
    sendToExtension({
      type: 'scene-rendered',
      absPath: data.absPath,
      sceneKind: data.sceneKind,
      result: data.result,
      rollbackStop: data.rollbackStop,
      ...(data.assembly ? { assembly: data.assembly } : {}),
    });
    broadcastToUI({
      type: 'scene-rendered',
      result: data.result,
      absPath: data.absPath,
      sceneKind: data.sceneKind,
      rollbackStop: data.rollbackStop,
      ...(data.assembly ? { assembly: data.assembly } : {}),
    });
    res.json({ success: true });
  });

  router.post('/add-breakpoint', (req, res) => {
    const { sourceLocation } = req.body;
    if (
      !sourceLocation ||
      typeof sourceLocation.filePath !== 'string' ||
      typeof sourceLocation.line !== 'number'
    ) {
      res.status(400).json({ error: 'Invalid request body' });
      return;
    }
    sendToExtension({
      type: 'add-breakpoint',
      filePath: sourceLocation.filePath,
      line: sourceLocation.line,
    });
    res.json({ success: true });
  });

  router.post('/clear-breakpoints', (_req, res) => {
    sendToExtension({ type: 'clear-breakpoints' });
    res.json({ success: true });
  });

  return router;
}
