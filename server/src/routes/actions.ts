import { Router } from 'express';
import type { FluidCadServer } from '../fluidcad-server.ts';

export function createActionsRouter(
  fluidCadServer: FluidCadServer,
  sendToExtension: (msg: any) => void,
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

  return router;
}
