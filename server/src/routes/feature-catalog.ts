import { Router } from 'express';
import { readFile } from 'fs/promises';
import { extname } from 'path';
import type { FeatureCatalog } from '../feature-catalog/catalog.ts';

/** The image types a feature's declared images may be (the metadata check admits no others). */
const ASSET_TYPES: Record<string, string> = {
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
};

/**
 * The feature catalog's backend: the features the workspace offers (its
 * `*.feature.js` modules' builders and the engine's own, as metadata
 * snapshots — the UI never runs feature code), and each feature's declared
 * images: its icon and its options' images.
 */
export function createFeatureCatalogRouter(catalog: FeatureCatalog, workspacePath: string): Router {
  const router = Router();

  router.get('/features/catalog', async (_req, res) => {
    try {
      const features = await catalog.list();
      if (features === null) {
        res.status(503).json({ error: 'Engine not initialized yet' });
        return;
      }
      // Whether a feature reaches raw OpenCascade stays in the engine: it
      // only names the likeliest cause when the kernel traps.
      res.json({ workspacePath, features: features.map(({ usesOcct: _, ...entry }) => entry) });
    } catch (err: any) {
      res.status(500).json({ error: err?.message ?? String(err) });
    }
  });

  // `?id=acme.standoff&path=./standoff.svg` — the path exactly as the
  // feature's metadata declares it: its icon, or an option's image
  // (`./fastener/m3.svg`). Served for <img>, where an SVG's
  // scripts never run; the policy below keeps them inert when the URL is
  // opened on its own too.
  router.get('/features/asset', async (req, res) => {
    const { id, path } = req.query;
    if (typeof id !== 'string' || id.length === 0 || typeof path !== 'string' || path.length === 0) {
      res.status(400).json({ error: 'id and path must be non-empty strings' });
      return;
    }
    try {
      const found = await catalog.asset(id, path);
      if ('error' in found) {
        res.status(found.status).json({ error: found.error });
        return;
      }
      const type = ASSET_TYPES[extname(found.file).toLowerCase()];
      if (!type) {
        res.status(415).json({ error: `feature '${id}': '${path}' is not an image` });
        return;
      }
      const content = await readFile(found.file);
      res.setHeader('Content-Type', type);
      res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; sandbox");
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Cache-Control', 'no-cache');
      res.send(content);
    } catch (err: any) {
      res.status(500).json({ error: err?.message ?? String(err) });
    }
  });

  return router;
}
