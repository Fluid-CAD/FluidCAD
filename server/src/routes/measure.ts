import { Router } from 'express';
import type { FluidCadServer } from '../fluidcad-server.ts';

const MAX_ENTITIES = 8;

export function createMeasureRouter(fluidCadServer: FluidCadServer): Router {
  const router = Router();

  router.post('/measure', (req, res) => {
    const entities = req.body?.entities;
    if (!Array.isArray(entities) || entities.length < 1 || entities.length > MAX_ENTITIES) {
      res.status(400).json({ error: `entities must be an array of 1-${MAX_ENTITIES} face/edge references` });
      return;
    }
    for (const entity of entities) {
      const validKind = entity?.kind === 'face' || entity?.kind === 'edge';
      const validIndex = Number.isInteger(entity?.index) && entity.index >= 0;
      if (!entity || typeof entity.shapeId !== 'string' || !entity.shapeId || !validKind || !validIndex) {
        res.status(400).json({ error: 'Each entity needs a shapeId, a kind (face|edge) and a non-negative index' });
        return;
      }
    }

    try {
      const result = fluidCadServer.measure(entities);
      if (!result) {
        res.status(404).json({ error: 'Entity not found' });
        return;
      }
      res.json(result);
    } catch (err: any) {
      res.status(500).json({ error: err?.message ?? String(err) });
    }
  });

  return router;
}
