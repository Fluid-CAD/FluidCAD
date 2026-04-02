import { Router } from 'express';
import type { FluidCadServer } from '../fluidcad-server.ts';
import { getMaterials } from '../../../lib/dist/common/materials.js';

export function createPropertiesRouter(fluidCadServer: FluidCadServer): Router {
  const router = Router();

  router.get('/materials', (_req, res) => {
    res.json(getMaterials());
  });

  router.get('/shape-properties', (req, res) => {
    const shapeId = (req.query.shapeId as string) || '';
    const props = fluidCadServer.getShapeProperties(shapeId);
    if (!props) {
      res.status(404).json({ error: 'Shape not found' });
      return;
    }
    res.json(props);
  });

  router.get('/face-properties', (req, res) => {
    const shapeId = (req.query.shapeId as string) || '';
    const faceIndex = parseInt((req.query.faceIndex as string) || '', 10);
    if (!shapeId || isNaN(faceIndex) || faceIndex < 0) {
      res.status(400).json({ error: 'Missing or invalid shapeId / faceIndex' });
      return;
    }
    const props = fluidCadServer.getFaceProperties(shapeId, faceIndex);
    if (!props) {
      res.status(404).json({ error: 'Face not found' });
      return;
    }
    res.json(props);
  });

  router.get('/edge-properties', (req, res) => {
    const shapeId = (req.query.shapeId as string) || '';
    const edgeIndex = parseInt((req.query.edgeIndex as string) || '', 10);
    if (!shapeId || isNaN(edgeIndex) || edgeIndex < 0) {
      res.status(400).json({ error: 'Missing or invalid shapeId / edgeIndex' });
      return;
    }
    const props = fluidCadServer.getEdgeProperties(shapeId, edgeIndex);
    if (!props) {
      res.status(404).json({ error: 'Edge not found' });
      return;
    }
    res.json(props);
  });

  return router;
}
