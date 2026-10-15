import { Router } from 'express';
import { ScreenshotRequests, type ScreenshotSceneIds, type ScreenshotSelectionResolver } from './screenshot-overlays.ts';
import type { SectionSceneObjectLookup } from './screenshot-section.ts';
import type { ScreenshotView } from '../ws-protocol.ts';

/**
 * POST /screenshot — validate the capture options and forward them to the
 * page over the `take-screenshot` message. Overlay fields (`highlight`,
 * `hide`, `focus`, `annotations`, `fitTo`, `views`, `section`) are checked by
 * {@link ScreenshotRequests}; highlight expressions resolve through
 * `resolveSelection` here so the page only receives index refs, `fitTo.shapes`
 * ids are checked against `sceneIds` (the current render's shape and
 * instance ids) so an unknown one is a 404 rather than a page error, and a
 * section on a face or a `plane()`/`section()` statement resolves through
 * `resolveSelection` and `sceneObject` to the plane the page clips at.
 */
export function createScreenshotRouter(
  requestScreenshot: (options: Record<string, unknown>) => Promise<Buffer>,
  resolveSelection?: ScreenshotSelectionResolver,
  sceneIds?: ScreenshotSceneIds,
  sceneObject?: SectionSceneObjectLookup,
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
      solidsOnly,
      showDimensions,
      showPositional,
      framePlanes,
      pixelRatio,
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

    if (solidsOnly !== undefined) {
      if (typeof solidsOnly !== 'boolean') {
        res.status(400).json({ error: 'solidsOnly must be a boolean.' });
        return;
      }
      options.solidsOnly = solidsOnly;
    }

    for (const [key, value] of [['showDimensions', showDimensions], ['showPositional', showPositional], ['framePlanes', framePlanes]] as const) {
      if (value !== undefined) {
        if (typeof value !== 'boolean') {
          res.status(400).json({ error: `${key} must be a boolean.` });
          return;
        }
        options[key] = value;
      }
    }

    if (pixelRatio !== undefined) {
      if (typeof pixelRatio !== 'number' || !(pixelRatio >= 1 && pixelRatio <= 4)) {
        res.status(400).json({ error: 'pixelRatio must be a number between 1 and 4.' });
        return;
      }
      options.pixelRatio = pixelRatio;
    }

    if (view !== undefined) {
      const validated = ScreenshotRequests.view(view);
      if (typeof validated === 'string') {
        res.status(400).json({ error: validated });
        return;
      }
      options.view = validated;
    }

    const overlays = ScreenshotRequests.overlays(req.body ?? {}, resolveSelection, sceneIds, sceneObject);
    if (overlays.ok === false) {
      res.status(overlays.status).json({
        error: overlays.error,
        ...(overlays.code ? { code: overlays.code } : {}),
        ...(overlays.candidates ? { candidates: overlays.candidates } : {}),
      });
      return;
    }
    Object.assign(options, overlays.options);

    const sectionView = ScreenshotRequests.sectionViewError(options.view as ScreenshotView | undefined, overlays.options.views, overlays.options.section);
    if (sectionView) {
      res.status(400).json({ error: sectionView });
      return;
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
