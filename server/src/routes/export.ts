import fs from 'fs';
import path from 'path';
import { Router } from 'express';
import type { FluidCadServer } from '../fluidcad-server.ts';

export function createExportRouter(fluidCadServer: FluidCadServer, workspacePath: string): Router {
  const router = Router();
  // Resolve the workspace root once so symlink checks below match the path
  // we actually allow writes into.
  const workspaceRoot = (() => {
    try {
      return fs.realpathSync(workspacePath);
    } catch {
      return path.resolve(workspacePath);
    }
  })();

  router.post('/export', (req, res) => {
    const { format, shapeIds, includeColors, resolution, customAngularDeflectionDeg, customLinearDeflection, saveAsPath } = req.body;

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

    if (saveAsPath !== undefined && typeof saveAsPath !== 'string') {
      res.status(400).json({ error: 'saveAsPath must be a string.' });
      return;
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
      const bytes = typeof result.data === 'string'
        ? Buffer.from(result.data, 'utf-8')
        : Buffer.from(result.data);

      if (saveAsPath) {
        // Resolve against the workspace root, then verify the canonical path
        // (after symlink resolution of the parent) still lives inside it.
        const candidate = path.resolve(workspaceRoot, saveAsPath);
        const parent = path.dirname(candidate);
        let parentReal: string;
        try {
          parentReal = fs.realpathSync(parent);
        } catch {
          res.status(400).json({ error: `Parent directory does not exist: ${parent}` });
          return;
        }
        const canonical = path.join(parentReal, path.basename(candidate));
        const rel = path.relative(workspaceRoot, canonical);
        if (rel.startsWith('..') || path.isAbsolute(rel)) {
          res.status(400).json({ error: `saveAsPath escapes workspace root: ${saveAsPath}` });
          return;
        }
        fs.writeFileSync(canonical, bytes);
        res.json({ savedTo: canonical, bytesWritten: bytes.length });
        return;
      }

      res.setHeader('Content-Type', mimeType);
      res.setHeader('Content-Disposition', `attachment; filename="export${ext}"`);
      res.send(bytes);
    } catch (err: any) {
      res.status(500).json({ error: err.message || String(err) });
    }
  });

  return router;
}
