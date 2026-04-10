import { Router } from 'express';

export function createScreenshotRouter(
  requestScreenshot: (options: Record<string, unknown>) => Promise<Buffer>,
): Router {
  const router = Router();

  router.post('/screenshot', async (req, res) => {
    const { width, height, showGrid, showAxes, transparent, autoCrop, fitToModel, margin } = req.body;

    const options: Record<string, unknown> = {};

    if (width !== undefined) {
      if (typeof width !== 'number' || width < 1 || width > 8192) {
        res.status(400).json({ error: 'width must be a number between 1 and 8192.' });
        return;
      }
      options.width = width;
    }

    if (height !== undefined) {
      if (typeof height !== 'number' || height < 1 || height > 8192) {
        res.status(400).json({ error: 'height must be a number between 1 and 8192.' });
        return;
      }
      options.height = height;
    }

    if (showGrid !== undefined) {
      if (typeof showGrid !== 'boolean') {
        res.status(400).json({ error: 'showGrid must be a boolean.' });
        return;
      }
      options.showGrid = showGrid;
    }

    if (showAxes !== undefined) {
      if (typeof showAxes !== 'boolean') {
        res.status(400).json({ error: 'showAxes must be a boolean.' });
        return;
      }
      options.showAxes = showAxes;
    }

    if (transparent !== undefined) {
      if (typeof transparent !== 'boolean') {
        res.status(400).json({ error: 'transparent must be a boolean.' });
        return;
      }
      options.transparent = transparent;
    }

    if (autoCrop !== undefined) {
      if (typeof autoCrop !== 'boolean') {
        res.status(400).json({ error: 'autoCrop must be a boolean.' });
        return;
      }
      options.autoCrop = autoCrop;
    }

    if (fitToModel !== undefined) {
      if (typeof fitToModel !== 'boolean') {
        res.status(400).json({ error: 'fitToModel must be a boolean.' });
        return;
      }
      options.fitToModel = fitToModel;
    }

    if (margin !== undefined) {
      if (typeof margin !== 'number' || margin < 0) {
        res.status(400).json({ error: 'margin must be a non-negative number.' });
        return;
      }
      options.margin = margin;
    }

    try {
      const png = await requestScreenshot(options);
      res.setHeader('Content-Type', 'image/png');
      res.setHeader('Content-Disposition', 'inline; filename="screenshot.png"');
      res.send(png);
    } catch (err: any) {
      const message = err.message || String(err);
      const status = message.includes('No UI client') || message.includes('timed out') ? 503 : 500;
      res.status(status).json({ error: message });
    }
  });

  return router;
}
