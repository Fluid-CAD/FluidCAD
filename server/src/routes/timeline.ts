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
      result: data.result,
      rollbackStop: data.rollbackStop,
    });
    broadcastToUI({
      type: 'scene-rendered',
      result: data.result,
      absPath: data.absPath,
      rollbackStop: data.rollbackStop,
      // The last full render's paused state — a refresh replays whatever
      // scene message went out last, and the indicator must survive it.
      breakpointHit: data.breakpointHit,
    });
    // Features inside the rollback scope that failed to build are still
    // broken — a rollback re-emits them, it doesn't repair them.
    res.json({
      success: true,
      state: data.objectErrors.length > 0 ? 'build-error' : 'rendered',
      objectErrors: data.objectErrors,
    });
  });

  router.post('/remove-feature', (req, res) => {
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
      type: 'remove-feature',
      filePath: sourceLocation.filePath,
      line: sourceLocation.line,
    });
    res.json({ success: true });
  });

  router.post('/rename-feature', (req, res) => {
    const { sourceLocation, name } = req.body;
    if (
      !sourceLocation ||
      typeof sourceLocation.filePath !== 'string' ||
      typeof sourceLocation.line !== 'number' ||
      (name !== null && typeof name !== 'string')
    ) {
      res.status(400).json({ error: 'Invalid request body' });
      return;
    }
    sendToExtension({
      type: 'rename-feature',
      filePath: sourceLocation.filePath,
      line: sourceLocation.line,
      name,
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
