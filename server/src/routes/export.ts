import { Router } from 'express';
import type { FluidCadServer } from '../fluidcad-server.ts';

export function createExportRouter(fluidCadServer: FluidCadServer): Router {
  const router = Router();

  router.post('/export', (req, res) => {
    const { format, shapeIds, includeColors, resolution, customAngularDeflectionDeg, customLinearDeflection } = req.body;

    if (format !== 'step' && format !== 'stl') {
      res.status(400).json({ error: 'Invalid format. Must be "step" or "stl".' });
      return;
    }

    if (!Array.isArray(shapeIds) || shapeIds.length === 0) {
      res.status(400).json({ error: 'shapeIds must be a non-empty array.' });
      return;
    }

    if (format === 'stl') {
      const validResolutions = ['coarse', 'medium', 'fine', 'custom'];
      if (resolution && !validResolutions.includes(resolution)) {
        res.status(400).json({ error: 'Invalid resolution.' });
        return;
      }
      if (resolution === 'custom') {
        if (typeof customLinearDeflection !== 'number' || typeof customAngularDeflectionDeg !== 'number') {
          res.status(400).json({ error: 'Custom resolution requires customLinearDeflection and customAngularDeflectionDeg.' });
          return;
        }
      }
    }

    try {
      const result = fluidCadServer.exportShapes(shapeIds, {
        format,
        includeColors,
        resolution: resolution || 'medium',
        customLinearDeflection,
        customAngularDeflectionDeg,
      });

      if (!result) {
        res.status(404).json({ error: 'No active scene to export.' });
        return;
      }

      const ext = format === 'step' ? '.step' : '.stl';
      const mimeType = format === 'step' ? 'application/step' : 'application/sla';

      res.setHeader('Content-Type', mimeType);
      res.setHeader('Content-Disposition', `attachment; filename="export${ext}"`);

      if (typeof result.data === 'string') {
        res.send(Buffer.from(result.data, 'utf-8'));
      } else {
        res.send(Buffer.from(result.data));
      }
    } catch (err: any) {
      res.status(500).json({ error: err.message || String(err) });
    }
  });

  return router;
}
