// Pure 2D tessellation of solved entities for the live drag preview
// (sketch-rewrite P4): the drag loop rewrites edge mesh positions from the
// solver's params every frame, bypassing the kernel's OCC tessellation
// until the write-back lands and the real render replaces everything.

import type { SolvedEntityView } from './model';
import type { Vec2 } from './resolve';

const CIRCLE_SEGMENTS = 64;
const ARC_SEGMENTS = 48;

/** Signed sweep from start to end around the center, on the drawn side
 * (mirrors resolve.ts's arcMidPoint convention). */
export function arcSweep(e: SolvedEntityView): { a0: number; sweep: number } | null {
  if (!e.center || !e.start || !e.end) {
    return null;
  }
  const a0 = Math.atan2(e.start[1] - e.center[1], e.start[0] - e.center[0]);
  const a1 = Math.atan2(e.end[1] - e.center[1], e.end[0] - e.center[0]);
  let sweep = a1 - a0;
  if (e.cw) {
    if (sweep > 0) {
      sweep -= 2 * Math.PI;
    }
  } else if (sweep < 0) {
    sweep += 2 * Math.PI;
  }
  return { a0, sweep };
}

/**
 * Polyline through the entity's current geometry, in sketch-plane 2D.
 * Null for point entities (they render as dots, not edges) and for
 * incomplete views.
 *
 * `segments` pins the polyline's segment count — the in-place mesh update
 * must feed `LineSegmentsGeometry.setPositions` exactly as many segments as
 * the mesh was built with, or the renderer's cached instance count clips the
 * result (observed: a circle drawn as a half-circle mid-drag).
 */
export function tessellateSolvedEntity(e: SolvedEntityView, segments?: number): Vec2[] | null {
  switch (e.kind) {
    case 'point':
      return null;
    case 'line': {
      if (!e.start || !e.end) {
        return null;
      }
      const n = segments ?? 1;
      if (n <= 1) {
        return [e.start, e.end];
      }
      const points: Vec2[] = [];
      for (let i = 0; i <= n; i++) {
        const t = i / n;
        points.push([
          e.start[0] + (e.end[0] - e.start[0]) * t,
          e.start[1] + (e.end[1] - e.start[1]) * t,
        ]);
      }
      return points;
    }
    case 'circle': {
      if (!e.center || e.radius === undefined) {
        return null;
      }
      const n = segments ?? CIRCLE_SEGMENTS;
      const points: Vec2[] = [];
      for (let i = 0; i <= n; i++) {
        const a = (i / n) * 2 * Math.PI;
        points.push([
          e.center[0] + Math.cos(a) * e.radius,
          e.center[1] + Math.sin(a) * e.radius,
        ]);
      }
      return points;
    }
    case 'arc': {
      const sweep = arcSweep(e);
      if (!sweep || !e.center || e.radius === undefined) {
        return null;
      }
      const n = segments ?? ARC_SEGMENTS;
      const points: Vec2[] = [];
      for (let i = 0; i <= n; i++) {
        const a = sweep.a0 + sweep.sweep * (i / n);
        points.push([
          e.center[0] + Math.cos(a) * e.radius,
          e.center[1] + Math.sin(a) * e.radius,
        ]);
      }
      // Land exactly on the solved endpoints — the sweep is angle-derived
      // but start/end are authoritative params.
      points[0] = e.start!;
      points[points.length - 1] = e.end!;
      return points;
    }
  }
}
