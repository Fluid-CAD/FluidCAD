// Pure 2D hit testing over the solved-sketch read model (sketch-rewrite
// P4). The solved drag handler and the constraint pick flows share this,
// so what grabs is exactly what picks. All coordinates are sketch-plane
// local; thresholds are in sketch units (callers convert from pixels).

import type { PointRole, SolverRef } from '../../../lib/sketch-solver/types.js';
import type { SolvedEntityView, SolvedSketchModel } from './model';
import { Vec2, sub, norm } from './resolve';

export type SolvedVertexHit = {
  type: 'vertex';
  entityId: number;
  role: PointRole | null;
  /** Solver ref of the grabbed point (role omitted for point entities). */
  ref: SolverRef;
  at: Vec2;
  distSq: number;
};

export type SolvedEdgeHit = {
  type: 'edge';
  entityId: number;
  kind: SolvedEntityView['kind'];
  distSq: number;
};

export type SolvedHit = SolvedVertexHit | SolvedEdgeHit;

export type SketchDatumName = 'origin' | 'x-axis' | 'y-axis';

export type SolvedDatumHit = {
  type: 'datum';
  datum: SketchDatumName;
  /** Reserved solver entity id (-1/-2/-3). */
  entityId: number;
  /** 'point' for the origin, 'line' for the axes — the legality matrix's
   * vocabulary. */
  kind: 'point' | 'line';
  distSq: number;
};

const DATUM_IDS: Record<SketchDatumName, number> = { origin: -1, 'x-axis': -2, 'y-axis': -3 };

/**
 * Hit test the implicit datums, sketch-local: the origin as a vertex-like
 * target, the axes as INFINITE lines (x-axis: |y|, y-axis: |x|). Callers
 * rank datums below real geometry — run this only after solvedHitTest
 * misses (origin after real vertices, axes after real edges).
 */
export function datumHitTest(
  model: SolvedSketchModel,
  point: Vec2,
  originThreshold: number,
  axisThreshold: number,
): SolvedDatumHit | null {
  if (!model.hasDatums) {
    return null;
  }
  const originDistSq = point[0] * point[0] + point[1] * point[1];
  if (originThreshold > 0 && originDistSq <= originThreshold * originThreshold) {
    return { type: 'datum', datum: 'origin', entityId: DATUM_IDS.origin, kind: 'point', distSq: originDistSq };
  }
  if (axisThreshold <= 0) {
    return null;
  }
  const limit = axisThreshold * axisThreshold;
  const dx = point[0] * point[0]; // distance² to the y axis (x = 0)
  const dy = point[1] * point[1]; // distance² to the x axis (y = 0)
  const best: SketchDatumName | null = dy <= dx ? (dy <= limit ? 'x-axis' : null) : (dx <= limit ? 'y-axis' : null);
  if (!best) {
    return null;
  }
  return {
    type: 'datum',
    datum: best,
    entityId: DATUM_IDS[best],
    kind: 'line',
    distSq: best === 'x-axis' ? dy : dx,
  };
}

type VertexSlot = { role: PointRole | null; at: Vec2 | undefined };

function vertexSlots(e: SolvedEntityView): VertexSlot[] {
  switch (e.kind) {
    case 'point':
      return [{ role: null, at: e.point }];
    case 'line':
      return [
        { role: 'start', at: e.start },
        { role: 'end', at: e.end },
      ];
    case 'circle':
      return [{ role: 'center', at: e.center }];
    case 'arc':
      return [
        { role: 'start', at: e.start },
        { role: 'end', at: e.end },
        { role: 'center', at: e.center },
      ];
  }
}

function distSqToSegment(p: Vec2, a: Vec2, b: Vec2): number {
  const abx = b[0] - a[0];
  const aby = b[1] - a[1];
  const lenSq = abx * abx + aby * aby;
  let t = 0;
  if (lenSq > 1e-24) {
    t = ((p[0] - a[0]) * abx + (p[1] - a[1]) * aby) / lenSq;
    t = Math.max(0, Math.min(1, t));
  }
  const dx = p[0] - (a[0] + t * abx);
  const dy = p[1] - (a[1] + t * aby);
  return dx * dx + dy * dy;
}

/** Angular membership on the drawn side of an arc (mirrors the cw/ccw
 * sweep convention in resolve.ts's arcMidPoint). */
function angleOnArc(e: SolvedEntityView, angle: number): boolean {
  if (!e.center || !e.start || !e.end) {
    return false;
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
  let rel = angle - a0;
  if (e.cw) {
    while (rel > 0) {
      rel -= 2 * Math.PI;
    }
    return rel >= sweep - 1e-9;
  }
  while (rel < 0) {
    rel += 2 * Math.PI;
  }
  return rel <= sweep + 1e-9;
}

function edgeDistSq(e: SolvedEntityView, p: Vec2): number | null {
  switch (e.kind) {
    case 'point':
      return e.point ? norm(sub(p, e.point)) ** 2 : null;
    case 'line':
      return e.start && e.end ? distSqToSegment(p, e.start, e.end) : null;
    case 'circle': {
      if (!e.center || e.radius === undefined) {
        return null;
      }
      const d = norm(sub(p, e.center)) - e.radius;
      return d * d;
    }
    case 'arc': {
      if (!e.center || e.radius === undefined || !e.start || !e.end) {
        return null;
      }
      const radial = sub(p, e.center);
      const angle = Math.atan2(radial[1], radial[0]);
      if (angleOnArc(e, angle)) {
        const d = norm(radial) - e.radius;
        return d * d;
      }
      // Off the drawn sweep: nearest endpoint.
      return Math.min(norm(sub(p, e.start)) ** 2, norm(sub(p, e.end)) ** 2);
    }
  }
}

export function refFor(entityId: number, role: PointRole | null): SolverRef {
  return role === null ? { entity: entityId } : { entity: entityId, point: role };
}

/**
 * Nearest vertex within `vertexThreshold`, else nearest edge body within
 * `edgeThreshold`. Vertices win outright — a line endpoint is grabbable on
 * top of its own edge.
 */
export function solvedHitTest(
  model: SolvedSketchModel,
  point: Vec2,
  vertexThreshold: number,
  edgeThreshold: number,
): SolvedHit | null {
  let bestVertex: SolvedVertexHit | null = null;
  const vertexLimit = vertexThreshold * vertexThreshold;
  for (const e of model.entities.values()) {
    for (const slot of vertexSlots(e)) {
      if (!slot.at) {
        continue;
      }
      const d = sub(point, slot.at);
      const distSq = d[0] * d[0] + d[1] * d[1];
      if (distSq <= vertexLimit && (!bestVertex || distSq < bestVertex.distSq)) {
        bestVertex = {
          type: 'vertex',
          entityId: e.entityId,
          role: slot.role,
          ref: refFor(e.entityId, slot.role),
          at: slot.at,
          distSq,
        };
      }
    }
  }
  if (bestVertex) {
    return bestVertex;
  }

  let bestEdge: SolvedEdgeHit | null = null;
  const edgeLimit = edgeThreshold * edgeThreshold;
  for (const e of model.entities.values()) {
    const distSq = edgeDistSq(e, point);
    if (distSq !== null && distSq <= edgeLimit && (!bestEdge || distSq < bestEdge.distSq)) {
      bestEdge = { type: 'edge', entityId: e.entityId, kind: e.kind, distSq };
    }
  }
  return bestEdge;
}
