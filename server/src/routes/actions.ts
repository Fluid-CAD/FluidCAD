import { Router } from 'express';
import type { FluidCadServer } from '../fluidcad-server.ts';
import { findBreakpointInsertLine } from '../code-editor.ts';

export function createActionsRouter(
  fluidCadServer: FluidCadServer,
  sendToExtension: (msg: any) => void,
  broadcastToUI: (msg: any) => void,
  workspacePath: string,
): Router {
  const router = Router();

  router.post('/hit-test', (req, res) => {
    const { shapeId, rayOrigin, rayDir, edgeThreshold } = req.body;
    if (
      typeof shapeId !== 'string' ||
      !Array.isArray(rayOrigin) || rayOrigin.length !== 3 ||
      !Array.isArray(rayDir) || rayDir.length !== 3 ||
      typeof edgeThreshold !== 'number'
    ) {
      res.status(400).json({ error: 'Invalid request body' });
      return;
    }
    const result = fluidCadServer.hitTest(
      shapeId,
      rayOrigin as [number, number, number],
      rayDir as [number, number, number],
      edgeThreshold,
    );
    res.json(result);
  });

  router.post('/insert-point', (req, res) => {
    const { point, sourceLocation } = req.body;
    if (
      !Array.isArray(point) || point.length !== 2 ||
      !sourceLocation || typeof sourceLocation.line !== 'number' || typeof sourceLocation.column !== 'number'
    ) {
      res.status(400).json({ error: 'Invalid request body' });
      return;
    }
    sendToExtension({
      type: 'insert-point',
      point: point as [number, number],
      sourceLocation,
    });
    res.json({ success: true });
  });

  router.post('/remove-point', (req, res) => {
    const { point, sourceLocation } = req.body;
    if (
      !Array.isArray(point) || point.length !== 2 ||
      !sourceLocation || typeof sourceLocation.line !== 'number' || typeof sourceLocation.column !== 'number'
    ) {
      res.status(400).json({ error: 'Invalid request body' });
      return;
    }
    sendToExtension({
      type: 'remove-point',
      point: point as [number, number],
      sourceLocation,
    });
    res.json({ success: true });
  });

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
    });
    res.json({ success: true });
  });

  router.post('/compute-breakpoint-line', async (req, res) => {
    const { code, referenceRow } = req.body;
    if (typeof code !== 'string' || typeof referenceRow !== 'number') {
      res.status(400).json({ error: 'Invalid request body' });
      return;
    }
    try {
      const insertLine = await findBreakpointInsertLine(code, referenceRow);
      res.json({ insertLine });
    } catch (err: any) {
      res.status(500).json({ error: err?.message || String(err) });
    }
  });

  router.post('/clear-breakpoints', (_req, res) => {
    sendToExtension({ type: 'clear-breakpoints' });
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

  router.post('/add-pick', (req, res) => {
    const { sourceLocation } = req.body;
    if (
      !sourceLocation || typeof sourceLocation.line !== 'number' || typeof sourceLocation.column !== 'number'
    ) {
      res.status(400).json({ error: 'Invalid request body' });
      return;
    }
    sendToExtension({
      type: 'add-pick',
      sourceLocation,
    });
    res.json({ success: true });
  });

  router.post('/set-pick-points', (req, res) => {
    const { points, sourceLocation } = req.body;
    if (
      !Array.isArray(points) ||
      !sourceLocation || typeof sourceLocation.line !== 'number' || typeof sourceLocation.column !== 'number'
    ) {
      res.status(400).json({ error: 'Invalid request body' });
      return;
    }
    sendToExtension({
      type: 'set-pick-points',
      points: points as [number, number][],
      sourceLocation,
    });
    res.json({ success: true });
  });

  router.post('/import-file', async (req, res) => {
    const { fileName, data } = req.body;
    if (typeof fileName !== 'string' || typeof data !== 'string') {
      res.status(400).json({ error: 'Invalid request body' });
      return;
    }

    try {
      await fluidCadServer.importFile(workspacePath, fileName, data);
    } catch (err: any) {
      res.status(500).json({ error: err.message || String(err) });
      return;
    }

    const loadName = fileName.replace(/\.(step|stp)$/i, '');
    res.json({ success: true, fileName: loadName });
  });

  return router;
}
