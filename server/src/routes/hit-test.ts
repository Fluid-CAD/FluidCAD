import { Router } from 'express';
import type { FluidCadServer } from '../fluidcad-server.ts';

export function createHitTestRouter(fluidCadServer: FluidCadServer): Router {
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

  return router;
}
