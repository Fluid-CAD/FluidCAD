// Sector math for the angle constraint's interactive placement. Two picked
// lines cross at a point and bound four sectors; the cursor picks one
// (FreeCAD-style), and the sector maps to an emission — argument order plus
// per-line orientation roles — whose counterclockwise angle is the sector's
// own visible angle: always positive, at most 180°. Pure 2D, unit-testable.

import type { ConstraintSpec, SolverRef } from '../../../../lib/sketch-solver/types.js';
import type { SolvedPick } from '../sketch-hover-select-handler';
import type { SolvedSketchModel } from '../../sketch-solver-client';
import {
  Vec2,
  add,
  entityFor,
  lineDir,
  lineIntersection,
  normalize,
  segmentCoversRay,
  segmentExtensionTo,
  sub,
} from '../../sketch-solver-client/resolve';

export type AngleRole = 'start' | 'end';

/**
 * One sector of the X two picked lines make, as the emission that
 * dimensions it. `aRole`/`bRole` orient the FIRST and SECOND pick's line
 * toward that endpoint ('end' = the statement's bare-line default); `swap`
 * emits the picks in (b, a) order so the counterclockwise turn stays ≤ 180°.
 * The arc sweeps counterclockwise from `startAngle` by `sweep` around `at`
 * (null when the lines are near-parallel — value still measures).
 */
export type AngleSector = {
  aRole: AngleRole;
  bRole: AngleRole;
  swap: boolean;
  /** The sector's current angle, degrees, (0, 180), 2dp. */
  valueDeg: number;
  at: Vec2 | null;
  startAngle: number;
  sweep: number;
  /** Dashed helper leaders to `at` for segments that don't reach it —
   * quadrant-independent (empty when both segments cross, or no `at`). */
  extensions: [Vec2, Vec2][];
  /** Sector-boundary ray angles no segment covers — the arc group draws a
   * screen-constant dashed tail through the center there so its ends touch
   * the extension leaders. Quadrant-DEPENDENT. */
  tails: number[];
};

function roleDir(d: Vec2, role: AngleRole): Vec2 {
  return role === 'start' ? [-d[0], -d[1]] : d;
}

function ccw(u: Vec2, v: Vec2): number {
  const phi = Math.atan2(u[0] * v[1] - u[1] * v[0], u[0] * v[0] + u[1] * v[1]);
  return phi < 0 ? phi + 2 * Math.PI : phi;
}

/** The sector bounded by the two oriented rays, as its ≤ 180° emission. */
export function angleSectorFor(
  model: SolvedSketchModel,
  pickA: SolvedPick,
  pickB: SolvedPick,
  aRole: AngleRole,
  bRole: AngleRole,
): AngleSector | null {
  const a = entityFor(model, { entity: pickA.entityId });
  const b = entityFor(model, { entity: pickB.entityId });
  const da = a ? lineDir(a) : null;
  const db = b ? lineDir(b) : null;
  if (!a || !b || !da || !db) {
    return null;
  }
  const u = roleDir(da, aRole);
  const v = roleDir(db, bRole);
  const phi = ccw(u, v);
  const swap = phi > Math.PI;
  const sweep = swap ? 2 * Math.PI - phi : phi;
  const from = swap ? v : u;
  const at = lineIntersection(a, b);
  const tails: number[] = [];
  if (at && !segmentCoversRay(a, at, u)) {
    tails.push(Math.atan2(u[1], u[0]));
  }
  if (at && !segmentCoversRay(b, at, v)) {
    tails.push(Math.atan2(v[1], v[0]));
  }
  return {
    aRole,
    bRole,
    swap,
    valueDeg: Math.round(((sweep * 180) / Math.PI) * 100) / 100,
    at,
    startAngle: Math.atan2(from[1], from[0]),
    sweep,
    extensions: at
      ? [segmentExtensionTo(a, at), segmentExtensionTo(b, at)]
          .filter((e): e is [Vec2, Vec2] => e !== null)
      : [],
    tails,
  };
}

/**
 * The sector under the cursor: of the four candidate ray pairs, the one
 * whose bisector points most toward the cursor. No cursor (or no usable
 * intersection, or the cursor sitting on it) falls back to the default
 * sector between the two start→end directions.
 */
export function angleSectorAt(
  model: SolvedSketchModel,
  pickA: SolvedPick,
  pickB: SolvedPick,
  cursor: Vec2 | null,
): AngleSector | null {
  const fallback = (): AngleSector | null => angleSectorFor(model, pickA, pickB, 'end', 'end');
  if (!cursor) {
    return fallback();
  }
  const a = entityFor(model, { entity: pickA.entityId });
  const b = entityFor(model, { entity: pickB.entityId });
  const da = a ? lineDir(a) : null;
  const db = b ? lineDir(b) : null;
  const at = a && b ? lineIntersection(a, b) : null;
  if (!a || !b || !da || !db || !at) {
    return fallback();
  }
  const toCursor = sub(cursor, at);
  if (Math.hypot(toCursor[0], toCursor[1]) < 1e-9) {
    return fallback();
  }
  const m = normalize(toCursor);
  const roles: AngleRole[] = ['end', 'start'];
  let best: { aRole: AngleRole; bRole: AngleRole } | null = null;
  let bestScore = -Infinity;
  for (const aRole of roles) {
    for (const bRole of roles) {
      const w = normalize(add(roleDir(da, aRole), roleDir(db, bRole)));
      const score = w[0] * m[0] + w[1] * m[1];
      if (score > bestScore) {
        bestScore = score;
        best = { aRole, bRole };
      }
    }
  }
  return best ? angleSectorFor(model, pickA, pickB, best.aRole, best.bRole) : fallback();
}

function orientedRef(pick: SolvedPick, role: AngleRole): SolverRef {
  return role === 'start' ? { entity: pick.entityId, point: 'start' } : { entity: pick.entityId };
}

/**
 * The sector's roles in their datum-safe representation. A datum axis has
 * no orientation accessor (`xAxis()` cannot say `.start()`), and negating
 * BOTH directions names the same constraint — the vertical-opposite sector
 * sweeps the identical CCW angle — so a 'start' that would land on a datum
 * flips the pair instead. Dropping just the datum's role (the pre-fix
 * behavior) names the SUPPLEMENTARY sector: a constraint 180° off the
 * clicked one that the solver satisfies by flipping the line — and, with a
 * tangent circle attached, driving its radius negative.
 */
function datumSafeRoles(
  pickA: SolvedPick,
  pickB: SolvedPick,
  sector: AngleSector,
): { aRole: AngleRole; bRole: AngleRole } {
  const violations = (a: AngleRole, b: AngleRole): number =>
    Number(pickA.datum !== undefined && a === 'start')
    + Number(pickB.datum !== undefined && b === 'start');
  const flip = (r: AngleRole): AngleRole => (r === 'start' ? 'end' : 'start');
  const flipped = { aRole: flip(sector.aRole), bRole: flip(sector.bRole) };
  return violations(flipped.aRole, flipped.bRole) < violations(sector.aRole, sector.bRole)
    ? flipped
    : { aRole: sector.aRole, bRole: sector.bRole };
}

/** Solver spec for the sector's constraint at `valueDeg` (the ghost/preview
 * solve) — refs oriented per role, in the sector's emission order. */
export function angleSectorSpec(
  pickA: SolvedPick,
  pickB: SolvedPick,
  sector: AngleSector,
  valueDeg: number,
): ConstraintSpec {
  const { aRole, bRole } = datumSafeRoles(pickA, pickB, sector);
  const refA = orientedRef(pickA, aRole);
  const refB = orientedRef(pickB, bRole);
  const [from, to] = sector.swap ? [refB, refA] : [refA, refB];
  return { kind: 'angle', a: from, b: to, value: (valueDeg * Math.PI) / 180 };
}

/** Emission targets for the sector, in statement-argument order: a 'start'
 * orientation renders as the `.start()` accessor, the default stays the
 * bare line. */
export function angleSectorTargets(
  pickA: SolvedPick,
  pickB: SolvedPick,
  sector: AngleSector,
): SolvedPick[] {
  const { aRole, bRole } = datumSafeRoles(pickA, pickB, sector);
  const ta: SolvedPick = aRole === 'start' ? { ...pickA, role: 'start' } : { ...pickA };
  const tb: SolvedPick = bRole === 'start' ? { ...pickB, role: 'start' } : { ...pickB };
  return sector.swap ? [tb, ta] : [ta, tb];
}
