// Solver registration for 2D copy duplicates: each (non-original,
// non-skipped) slot of a copy registers one duplicate entity per
// solver-backed source, rigidly derived from it through an internal
// transform tie (SketchSystem.addTransformTie). Registration happens at
// STATEMENT time — the copy statement precedes any constraint that names
// one of its instances — from guesses obtained by applying the slot's
// affine transform to the source's guess geometry, so the tie rows start
// exactly satisfied and net DOF is unchanged.

import { Point2D } from "../../../math/point.js";
import type { Matrix4 } from "../../../math/matrix4.js";
import type { Plane } from "../../../math/plane.js";
import type { SceneObject } from "../../../common/scene-object.js";
import type { EntityKind, PointRole } from "../../../sketch-solver/index.js";
import type { SketchSolverContext } from "./solver-context.js";

/** p' = [[a,b],[c,d]]·p + [tx,ty], flattened [a, b, c, d, tx, ty] — the
 * matrix layout SketchSystem.addTransformTie consumes. */
export type TieMatrix = [number, number, number, number, number, number];

/**
 * The sketch-local 2D affine equivalent of a slot's WORLD transform — the
 * very Matrix4 the build-time stamping applies. Derived by mapping three
 * local probe points through localToWorld → matrix → worldToLocal, so the
 * tie and the stamped shapes agree by construction, whatever the plane's
 * basis handedness. Only valid for transforms that keep the plane on
 * itself (translations along it, rotations about its normal — every 2D
 * copy transform).
 */
export function localAffineFromWorldMatrix(matrix: Matrix4, plane: Plane): TieMatrix {
  const map = (x: number, y: number): Point2D => {
    return plane.worldToLocal(matrix.transformPoint(plane.localToWorld(new Point2D(x, y))));
  };
  const o = map(0, 0);
  const u = map(1, 0);
  const v = map(0, 1);
  return [u.x - o.x, v.x - o.x, u.y - o.y, v.y - o.y, o.x, o.y];
}

/**
 * The sketch-local affine of a reflection across the line a→b (sketch
 * coordinates): p' = a + R·(p − a) with R = 2·n·nᵀ − I for the unit
 * direction n. The guess-side twin of the solver's mirror-tie rows — used
 * to place a mirror image's guess params exactly on the tie.
 */
export function reflectionAffine(axis: [number, number, number, number]): TieMatrix {
  const [ax, ay, bx, by] = axis;
  const len = Math.hypot(bx - ax, by - ay);
  if (len < 1e-12) {
    throw new Error('reflectionAffine: degenerate (zero-length) axis line');
  }
  const nx = (bx - ax) / len;
  const ny = (by - ay) / len;
  const a = 2 * nx * nx - 1;
  const b = 2 * nx * ny;
  const c = b;
  const d = 2 * ny * ny - 1;
  return [a, b, c, d, ax - (a * ax + b * ay), ay - (c * ax + d * ay)];
}

/** Role validity per entity kind — point instances answer every accessor
 * with themselves, mirroring SolvedPoint.start()/end(). Shared by the
 * copy-instance and mirror-image accessors. */
export function validateInstanceRole(kind: EntityKind, role: PointRole, what: string): void {
  if (kind === 'line' && role === 'center') {
    throw new Error(`${what}: a line instance has no center() point`);
  }
  if (kind === 'circle' && role !== 'center') {
    throw new Error(`${what}: a circle instance only has a center() point`);
  }
}

/** Apply a tie matrix to one 2D point. */
function applyAffine(affine: TieMatrix, x: number, y: number): Point2D {
  const [a, b, c, d, tx, ty] = affine;
  return new Point2D(a * x + b * y + tx, c * x + d * y + ty);
}

/**
 * Register the duplicate entity for one (slot, source) pair: same kind as
 * the source, guesses = affine(source guesses). The caller ties it to the
 * source right after — this only creates the entity.
 */
export function registerDuplicateEntity(
  ctx: SketchSolverContext,
  owner: SceneObject,
  source: { entityId: number; solverKind: EntityKind },
  affine: TieMatrix,
): number {
  const params = ctx.entityParams(source.entityId);
  switch (source.solverKind) {
    case 'point': {
      const p = applyAffine(affine, params[0], params[1]);
      return ctx.addPoint(owner, p.x, p.y);
    }
    case 'line': {
      const s = applyAffine(affine, params[0], params[1]);
      const e = applyAffine(affine, params[2], params[3]);
      return ctx.addLine(owner, s.x, s.y, e.x, e.y);
    }
    case 'circle': {
      // Similarity scale (1 for the rigid copy transforms, but derived
      // rather than assumed — addTransformTie validates it either way).
      const c = applyAffine(affine, params[0], params[1]);
      const scale = Math.hypot(affine[0], affine[2]);
      return ctx.addCircle(owner, c.x, c.y, params[2] * scale);
    }
    case 'arc': {
      // Arc params are POINTS (center/start/end); the radius guess is
      // re-derived by addArc from the transformed endpoints.
      const c = applyAffine(affine, params[0], params[1]);
      const s = applyAffine(affine, params[3], params[4]);
      const e = applyAffine(affine, params[5], params[6]);
      return ctx.addArc(owner, c.x, c.y, s.x, s.y, e.x, e.y);
    }
  }
}

/**
 * A named point of an entity, read from its current solver params.
 * Param layouts: point [x,y], line [sx,sy,ex,ey], circle [cx,cy,r],
 * arc [cx,cy,r,sx,sy,ex,ey]. Role validity is the caller's problem
 * (validated in the instance resolution before any read).
 */
export function entityPointFromParams(kind: EntityKind, params: number[], role: PointRole): Point2D {
  if (kind === 'point') {
    return new Point2D(params[0], params[1]);
  }
  if (kind === 'line') {
    return role === 'start'
      ? new Point2D(params[0], params[1])
      : new Point2D(params[2], params[3]);
  }
  if (kind === 'circle') {
    return new Point2D(params[0], params[1]);
  }
  if (role === 'center') {
    return new Point2D(params[0], params[1]);
  }
  return role === 'start'
    ? new Point2D(params[3], params[4])
    : new Point2D(params[5], params[6]);
}
