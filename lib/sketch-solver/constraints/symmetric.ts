// symmetric — two points, or two entities of one kind (lines, circles,
// arcs), mirror across line l.
//
//   points   → 2 rows: their midpoint lies on the line and a−b is
//              perpendicular to it.
//   lines    → 4 rows: start↔start and end↔end point pairs.
//   circles  → 3 rows: the centers mirror + equal radii.
//   arcs     → 5 rows: the centers mirror, the starts mirror, and b's end
//              lies on the reflection of a's center→end ray (1 row) — the
//              arc's own consistency row (|end−center| = r) supplies the
//              other. Three point pairs would be one row too many against
//              the consistency rows (a redundant symmetric); two point
//              pairs plus equal radii would go singular on a semicircle.
//              The direction row's sign branch (the reflected ray or its
//              opposite) is picked by the guess, like every other branch.
//
// The entity forms are what the sketch Mirror tool writes — one statement
// per mirrored entity — and what a user writes to keep two halves of a
// profile mirrored by hand.

import type { ConstraintSpec } from '../types.js';
import { center, end, start } from '../types.js';
import type { CompiledRow, CompileCtx, ResolvedLine, ResolvedPoint } from './types.js';
import { floorDist, linePointSignedDist, makeLinePointDeriv } from './util.js';

type Spec = Extract<ConstraintSpec, { kind: 'symmetric' }>;

export function compileSymmetric(spec: Spec, ctx: CompileCtx): CompiledRow[] {
  const l = ctx.line(spec.l, 'symmetric line');
  const aPoint = ctx.isPoint(spec.a);
  const bPoint = ctx.isPoint(spec.b);
  if (aPoint && bPoint) {
    return pointPairRows(
      l,
      ctx.point(spec.a, 'symmetric first point'),
      ctx.point(spec.b, 'symmetric second point'),
    );
  }
  if (aPoint || bPoint) {
    throw new Error('symmetric needs two points, or two lines / two circles / two arcs');
  }
  const kindA = ctx.kindOf(spec.a.entity);
  const kindB = ctx.kindOf(spec.b.entity);
  if (kindA !== kindB) {
    throw new Error(`symmetric needs two entities of the same kind, got ${kindA} and ${kindB}`);
  }
  switch (kindA) {
    case 'line':
      return [
        ...pointPairRows(l, ctx.point(start(spec.a.entity), 'symmetric first line start'),
          ctx.point(start(spec.b.entity), 'symmetric second line start')),
        ...pointPairRows(l, ctx.point(end(spec.a.entity), 'symmetric first line end'),
          ctx.point(end(spec.b.entity), 'symmetric second line end')),
      ];
    case 'circle': {
      const ca = ctx.circle(spec.a, 'symmetric first circle');
      const cb = ctx.circle(spec.b, 'symmetric second circle');
      return [
        ...pointPairRows(l, ctx.point(center(spec.a.entity), 'symmetric first circle center'),
          ctx.point(center(spec.b.entity), 'symmetric second circle center')),
        equalRadiusRow(ca.r, cb.r),
      ];
    }
    case 'arc':
      return [
        ...pointPairRows(l, ctx.point(center(spec.a.entity), 'symmetric first arc center'),
          ctx.point(center(spec.b.entity), 'symmetric second arc center')),
        ...pointPairRows(l, ctx.point(start(spec.a.entity), 'symmetric first arc start'),
          ctx.point(start(spec.b.entity), 'symmetric second arc start')),
        reflectedRayRow(
          l,
          ctx.point(center(spec.a.entity), 'symmetric first arc center'),
          ctx.point(end(spec.a.entity), 'symmetric first arc end'),
          ctx.point(center(spec.b.entity), 'symmetric second arc center'),
          ctx.point(end(spec.b.entity), 'symmetric second arc end'),
        ),
      ];
    default:
      throw new Error(`symmetric does not apply to ${kindA} entities`);
  }
}

/** The two rows mirroring point b from point a across the line. */
function pointPairRows(l: ResolvedLine, a: ResolvedPoint, b: ResolvedPoint): CompiledRow[] {
  const d = makeLinePointDeriv();
  const midOnLine: CompiledRow = {
    params: [l.sx, l.sy, l.ex, l.ey, a.ix, a.iy, b.ix, b.iy],
    eval: (p) => {
      linePointSignedDist(p, l, (p[a.ix] + p[b.ix]) / 2, (p[a.iy] + p[b.iy]) / 2, d);
      return d.g;
    },
    jac: (p, out) => {
      linePointSignedDist(p, l, (p[a.ix] + p[b.ix]) / 2, (p[a.iy] + p[b.iy]) / 2, d);
      out[0] = d.dSx;
      out[1] = d.dSy;
      out[2] = d.dEx;
      out[3] = d.dEy;
      out[4] = d.dWx / 2;
      out[5] = d.dWy / 2;
      out[6] = d.dWx / 2;
      out[7] = d.dWy / 2;
    },
  };
  // h = dot(u, a−b)/|u|
  const perpendicularAB: CompiledRow = {
    params: [l.sx, l.sy, l.ex, l.ey, a.ix, a.iy, b.ix, b.iy],
    eval: (p) => {
      const ux = p[l.ex] - p[l.sx];
      const uy = p[l.ey] - p[l.sy];
      const abx = p[a.ix] - p[b.ix];
      const aby = p[a.iy] - p[b.iy];
      return (ux * abx + uy * aby) / floorDist(Math.hypot(ux, uy));
    },
    jac: (p, out) => {
      const ux = p[l.ex] - p[l.sx];
      const uy = p[l.ey] - p[l.sy];
      const abx = p[a.ix] - p[b.ix];
      const aby = p[a.iy] - p[b.iy];
      const dl = floorDist(Math.hypot(ux, uy));
      const f = ux * abx + uy * aby;
      const d2 = dl * dl;
      out[0] = (-abx * dl + f * (ux / dl)) / d2;
      out[1] = (-aby * dl + f * (uy / dl)) / d2;
      out[2] = (abx * dl - f * (ux / dl)) / d2;
      out[3] = (aby * dl - f * (uy / dl)) / d2;
      out[4] = ux / dl;
      out[5] = uy / dl;
      out[6] = -ux / dl;
      out[7] = -uy / dl;
    },
  };
  return [midOnLine, perpendicularAB];
}

function equalRadiusRow(ra: number, rb: number): CompiledRow {
  return {
    params: [ra, rb],
    eval: (p) => p[ra] - p[rb],
    jac: (_p, out) => {
      out[0] = 1;
      out[1] = -1;
    },
  };
}

/**
 * One row: b's ray cb→eb is the reflection of a's ray ca→ea across the
 * line — cross(R·(ea−ca), eb−cb) / |ea−ca| = 0 with R = 2·n·nᵀ − I for the
 * line's unit direction n. Pins the reflected arc's end angle without a
 * second row the arc-consistency row already provides.
 */
function reflectedRayRow(
  l: ResolvedLine,
  ca: ResolvedPoint,
  ea: ResolvedPoint,
  cb: ResolvedPoint,
  eb: ResolvedPoint,
): CompiledRow {
  const params = [
    l.sx, l.sy, l.ex, l.ey,
    ca.ix, ca.iy, ea.ix, ea.iy,
    cb.ix, cb.iy, eb.ix, eb.iy,
  ];
  type Terms = {
    nx: number; ny: number; L: number;
    dx: number; dy: number; D: number;
    mx: number; my: number;
    wx: number; wy: number;
    g: number;
  };
  const terms = (p: Float64Array): Terms => {
    const ux = p[l.ex] - p[l.sx];
    const uy = p[l.ey] - p[l.sy];
    const L = floorDist(Math.hypot(ux, uy));
    const nx = ux / L;
    const ny = uy / L;
    const dx = p[ea.ix] - p[ca.ix];
    const dy = p[ea.iy] - p[ca.iy];
    const nd = nx * dx + ny * dy;
    const mx = 2 * nd * nx - dx;
    const my = 2 * nd * ny - dy;
    const wx = p[eb.ix] - p[cb.ix];
    const wy = p[eb.iy] - p[cb.iy];
    return {
      nx, ny, L, dx, dy, D: floorDist(Math.hypot(dx, dy)), mx, my, wx, wy,
      g: mx * wy - my * wx,
    };
  };
  return {
    params,
    eval: (p) => {
      const t = terms(p);
      return t.g / t.D;
    },
    jac: (p, out) => {
      const t = terms(p);
      const { nx, ny, L, dx, dy, D, mx, my, wx, wy, g } = t;
      // v = (wy, −wx): ∂g/∂m.
      const vx = wy;
      const vy = -wx;
      // ∂g/∂d = R·v (R is symmetric).
      const nv = nx * vx + ny * vy;
      const rvx = 2 * nv * nx - vx;
      const rvy = 2 * nv * ny - vy;
      // ∂f/∂d = (∂g/∂d)/D − g·d/D³.
      const D3 = D * D * D;
      const fdx = rvx / D - g * dx / D3;
      const fdy = rvy / D - g * dy / D3;
      // ∂g/∂u = (2/L)[(n·v)(d − n(n·d)) + (n·d)(v − n(n·v))].
      const nd = nx * dx + ny * dy;
      const gux = (2 / L) * (nv * (dx - nx * nd) + nd * (vx - nx * nv));
      const guy = (2 / L) * (nv * (dy - ny * nd) + nd * (vy - ny * nv));
      out[0] = -gux / D;
      out[1] = -guy / D;
      out[2] = gux / D;
      out[3] = guy / D;
      out[4] = -fdx;
      out[5] = -fdy;
      out[6] = fdx;
      out[7] = fdy;
      // ∂g/∂w = (−my, mx); eb carries +, cb carries −.
      out[8] = my / D;
      out[9] = -mx / D;
      out[10] = -my / D;
      out[11] = mx / D;
    },
  };
}

