import { Router } from 'express';
import type { NamedView, ScreenshotView } from '../ws-protocol.ts';

const NAMED_VIEWS: ReadonlySet<NamedView> = new Set([
  'front', 'back', 'left', 'right', 'top', 'bottom',
  'iso-ftr', 'iso-fbr', 'iso-ftl', 'iso-fbl',
  'iso-btr', 'iso-bbr', 'iso-btl', 'iso-bbl',
]);

export function createScreenshotRouter(
  requestScreenshot: (options: Record<string, unknown>) => Promise<Buffer>,
): Router {
  const router = Router();

  router.post('/screenshot', async (req, res) => {
    const {
      width,
      height,
      showGrid,
      showAxes,
      transparent,
      autoCrop,
      fitToModel,
      margin,
      view,
      multi,
    } = req.body;

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

    if (multi !== undefined) {
      if (typeof multi !== 'boolean') {
        res.status(400).json({ error: 'multi must be a boolean.' });
        return;
      }
      options.multi = multi;
    }

    if (view !== undefined) {
      const validated = validateView(view);
      if (typeof validated === 'string') {
        res.status(400).json({ error: validated });
        return;
      }
      options.view = validated;
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

/** Validate the `view` payload. Returns the parsed view on success or an
 *  error-message string on failure. */
function validateView(raw: unknown): ScreenshotView | string {
  if (raw === null || typeof raw !== 'object') {
    return 'view must be an object.';
  }
  const v = raw as Record<string, unknown>;
  switch (v.kind) {
    case 'current':
      return { kind: 'current' };
    case 'named': {
      if (typeof v.name !== 'string' || !NAMED_VIEWS.has(v.name as NamedView)) {
        return `view.name must be one of: ${Array.from(NAMED_VIEWS).join(', ')}.`;
      }
      return { kind: 'named', name: v.name as NamedView };
    }
    case 'orbit-from-current': {
      if (typeof v.azimuthDeg !== 'number' || !Number.isFinite(v.azimuthDeg)) {
        return 'view.azimuthDeg must be a finite number.';
      }
      if (typeof v.elevationDeg !== 'number' || !Number.isFinite(v.elevationDeg)) {
        return 'view.elevationDeg must be a finite number.';
      }
      return { kind: 'orbit-from-current', azimuthDeg: v.azimuthDeg, elevationDeg: v.elevationDeg };
    }
    case 'look-from': {
      if (!isVec3(v.eye)) {
        return 'view.eye must be a 3-element array of finite numbers.';
      }
      if (v.target !== undefined && !isVec3(v.target)) {
        return 'view.target must be a 3-element array of finite numbers when provided.';
      }
      return {
        kind: 'look-from',
        eye: v.eye as [number, number, number],
        target: v.target as [number, number, number] | undefined,
      };
    }
    default:
      return `view.kind must be one of: current, named, orbit-from-current, look-from.`;
  }
}

function isVec3(value: unknown): value is [number, number, number] {
  return (
    Array.isArray(value) &&
    value.length === 3 &&
    value.every((n) => typeof n === 'number' && Number.isFinite(n))
  );
}
