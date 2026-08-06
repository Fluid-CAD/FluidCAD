import { Router } from 'express';
import type { FluidCadServer } from '../fluidcad-server.ts';
import { getOC } from '../../../lib/dist/oc/init.js';
import { FontRegistry } from '../../../lib/dist/io/font-registry.js';
import { TextOutline, type TextAlign } from '../../../lib/dist/oc/text-outline.js';
import { Mesh } from '../../../lib/dist/oc/mesh.js';
import { Plane } from '../../../lib/dist/math/plane.js';
import { Point, Point2D } from '../../../lib/dist/math/point.js';
import { Vector3d } from '../../../lib/dist/math/vector3d.js';

type Vec3Body = { x: number; y: number; z: number };

const ALIGN_VALUES: TextAlign[] = ['left', 'center', 'right', 'start', 'end', 'space-between', 'space-around'];

function readVec(input: unknown): Vector3d | null {
  const v = input as Vec3Body;
  if (!v || typeof v.x !== 'number' || typeof v.y !== 'number' || typeof v.z !== 'number') {
    return null;
  }
  return new Vector3d(v.x, v.y, v.z);
}

function readNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/**
 * Font + text-outline queries backing the UI's Text tool: the font-family
 * list for the options dialog, and a layout preview — the same glyph edges
 * `text()` would build, discretized to world-space polylines the viewport
 * can draw while the user tweaks options, without touching the code. A
 * request carrying `path` lays the glyphs along a picked sketch geometry
 * instead of a straight baseline; that variant resolves against the rendered
 * scene, so it runs through the workspace's own fluidcad (the scene manager),
 * never this repo's lib.
 */
export function createTextRouter(fluidCadServer: FluidCadServer): Router {
  const router = Router();

  router.get('/fonts', async (_req, res) => {
    try {
      await FontRegistry.init();
      res.json({ families: FontRegistry.families() });
    } catch (err: any) {
      res.status(500).json({ error: err?.message ?? 'Could not list fonts' });
    }
  });

  router.post('/text-preview', async (req, res) => {
    const { text, position, plane, options, path } = req.body ?? {};
    if (typeof text !== 'string') {
      res.status(400).json({ error: 'Invalid request body: text must be a string' });
      return;
    }
    const opts = options ?? {};
    const align = ALIGN_VALUES.includes(opts.align) ? opts.align as TextAlign : 'left';
    const size = readNumber(opts.size, 10);
    if (size <= 0) {
      res.status(400).json({ error: 'Invalid request body: size must be positive' });
      return;
    }

    // Path variant: lay the glyphs along the picked geometry, resolved
    // against the rendered scene through the workspace's fluidcad.
    if (path !== undefined && path !== null) {
      if (typeof path.shapeId !== 'string' || path.shapeId.length === 0) {
        res.status(400).json({ error: 'Invalid request body: path must be {shapeId}' });
        return;
      }
      try {
        const result = fluidCadServer.buildTextPathPreview({
          shapeId: path.shapeId,
          text,
          font: typeof opts.font === 'string' && opts.font.trim() !== '' ? opts.font : undefined,
          weight: readNumber(opts.weight, 400),
          italic: opts.italic === true,
          size,
          align,
          lineSpacing: readNumber(opts.lineSpacing, 1),
          letterSpacing: readNumber(opts.letterSpacing, 0),
          offset: readNumber(opts.offset, 0),
          startAt: readNumber(opts.startAt, 0),
          flip: opts.flip === true,
        });
        if (!result) {
          res.status(404).json({ error: 'No rendered scene' });
          return;
        }
        if ('reason' in result) {
          res.status(422).json({ error: result.reason });
          return;
        }
        res.json({ polylines: result.polylines });
      } catch (err: any) {
        res.status(422).json({ error: err?.message ?? 'Could not lay out the text' });
      }
      return;
    }

    if (!Array.isArray(position) || position.length !== 2
      || typeof position[0] !== 'number' || typeof position[1] !== 'number') {
      res.status(400).json({ error: 'Invalid request body: position must be [x, y]' });
      return;
    }
    const origin = readVec(plane?.origin);
    const normal = readVec(plane?.normal);
    const xDirection = readVec(plane?.xDirection);
    if (!origin || !normal || !xDirection) {
      res.status(400).json({ error: 'Invalid request body: plane needs origin, normal and xDirection' });
      return;
    }

    try {
      // Fail loudly when the engine isn't up yet — glyph edge construction
      // swallows per-edge errors, which would read as an empty preview.
      getOC();
      await FontRegistry.init();
      const font = FontRegistry.resolve({
        font: typeof opts.font === 'string' && opts.font.trim() !== '' ? opts.font : undefined,
        weight: readNumber(opts.weight, 400),
        italic: opts.italic === true,
      });

      const targetPlane = new Plane(
        new Point(origin.x, origin.y, origin.z),
        xDirection.normalize(),
        normal.normalize(),
      );
      const edges = TextOutline.buildEdges(
        font,
        text,
        {
          size,
          align,
          lineSpacing: readNumber(opts.lineSpacing, 1),
          letterSpacing: readNumber(opts.letterSpacing, 0),
        },
        targetPlane,
        new Point2D(position[0], position[1]),
      );

      const polylines: number[][] = [];
      for (const edge of edges) {
        try {
          const vertices = Mesh.discretizeEdge(edge).vertices;
          if (vertices.length >= 6) {
            polylines.push(vertices);
          }
        } finally {
          edge.dispose();
        }
      }
      res.json({ polylines });
    } catch (err: any) {
      res.status(422).json({ error: err?.message ?? 'Could not lay out the text' });
    }
  });

  return router;
}
