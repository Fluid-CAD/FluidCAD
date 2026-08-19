// distance — the dimension workhorse. Form by resolution:
//   point–point            |a−b| = t          (axis: side-locked Δx/Δy)
//   point–line             side-locked perpendicular distance
//   point–circle/arc       distance to the circumference, side-locked
//   line–line              b's midpoint to a's infinite line (pair
//                          with parallel for the classic dim)
//   circle–circle          gap between circumferences (containment vs
//                          external locked from the guess)
// Side locks come from the guesses at compile time so a dimensioned
// point can't wander to the mirror solution during a warm re-solve.

import type { ConstraintSpec, SolverRef } from '../types.js';
import type { CompiledRow, CompileCtx } from './types.js';
import {
  guessSign,
  linePointSignedDist,
  makeLinePointDeriv,
  makePointDistDeriv,
  pointDist,
} from './util.js';

type Spec = Extract<ConstraintSpec, { kind: 'distance' }>;

export function compileDistance(spec: Spec, ctx: CompileCtx): CompiledRow[] {
  const t = spec.value;
  const aPoint = ctx.isPoint(spec.a);
  const bPoint = ctx.isPoint(spec.b);

  if (spec.axis !== undefined && !(aPoint && bPoint)) {
    throw new Error('distance axis variants require two point references');
  }

  if (aPoint && bPoint) {
    const a = ctx.point(spec.a, 'distance first point');
    const b = ctx.point(spec.b, 'distance second point');
    if (spec.axis !== undefined) {
      const ai = spec.axis === 'x' ? a.ix : a.iy;
      const bi = spec.axis === 'x' ? b.ix : b.iy;
      const s = guessSign(ctx.guess[ai] - ctx.guess[bi]);
      return [
        {
          params: [ai, bi],
          eval: (p) => s * (p[ai] - p[bi]) - t,
          jac: (_p, out) => {
            out[0] = s;
            out[1] = -s;
          },
        },
      ];
    }
    const pd = makePointDistDeriv();
    return [
      {
        params: [a.ix, a.iy, b.ix, b.iy],
        eval: (p) => {
          pointDist(p, a.ix, a.iy, b.ix, b.iy, pd);
          return pd.d - t;
        },
        jac: (p, out) => {
          pointDist(p, a.ix, a.iy, b.ix, b.iy, pd);
          out[0] = pd.dAx;
          out[1] = pd.dAy;
          out[2] = -pd.dAx;
          out[3] = -pd.dAy;
        },
      },
    ];
  }

  if (aPoint || bPoint) {
    const pRef: SolverRef = aPoint ? spec.a : spec.b;
    const eRef: SolverRef = aPoint ? spec.b : spec.a;
    const pt = ctx.point(pRef, 'distance point');
    if (ctx.isLine(eRef)) {
      const l = ctx.line(eRef, 'distance line');
      const d = makeLinePointDeriv();
      linePointSignedDist(ctx.guess, l, ctx.guess[pt.ix], ctx.guess[pt.iy], d);
      const s = guessSign(d.g);
      return [
        {
          params: [l.sx, l.sy, l.ex, l.ey, pt.ix, pt.iy],
          eval: (p) => {
            linePointSignedDist(p, l, p[pt.ix], p[pt.iy], d);
            return s * d.g - t;
          },
          jac: (p, out) => {
            linePointSignedDist(p, l, p[pt.ix], p[pt.iy], d);
            out[0] = s * d.dSx;
            out[1] = s * d.dSy;
            out[2] = s * d.dEx;
            out[3] = s * d.dEy;
            out[4] = s * d.dWx;
            out[5] = s * d.dWy;
          },
        },
      ];
    }
    const c = ctx.circle(eRef, 'distance circle/arc');
    const pd = makePointDistDeriv();
    pointDist(ctx.guess, pt.ix, pt.iy, c.cx, c.cy, pd);
    const s = guessSign(pd.d - ctx.guess[c.r]);
    return [
      {
        params: [pt.ix, pt.iy, c.cx, c.cy, c.r],
        eval: (p) => {
          pointDist(p, pt.ix, pt.iy, c.cx, c.cy, pd);
          return s * (pd.d - p[c.r]) - t;
        },
        jac: (p, out) => {
          pointDist(p, pt.ix, pt.iy, c.cx, c.cy, pd);
          out[0] = s * pd.dAx;
          out[1] = s * pd.dAy;
          out[2] = -s * pd.dAx;
          out[3] = -s * pd.dAy;
          out[4] = -s;
        },
      },
    ];
  }

  if (ctx.isLine(spec.a) && ctx.isLine(spec.b)) {
    const a = ctx.line(spec.a, 'distance first line');
    const b = ctx.line(spec.b, 'distance second line');
    const d = makeLinePointDeriv();
    const midX = (p: Float64Array): number => (p[b.sx] + p[b.ex]) / 2;
    const midY = (p: Float64Array): number => (p[b.sy] + p[b.ey]) / 2;
    linePointSignedDist(ctx.guess, a, midX(ctx.guess), midY(ctx.guess), d);
    const s = guessSign(d.g);
    return [
      {
        params: [a.sx, a.sy, a.ex, a.ey, b.sx, b.sy, b.ex, b.ey],
        eval: (p) => {
          linePointSignedDist(p, a, midX(p), midY(p), d);
          return s * d.g - t;
        },
        jac: (p, out) => {
          linePointSignedDist(p, a, midX(p), midY(p), d);
          out[0] = s * d.dSx;
          out[1] = s * d.dSy;
          out[2] = s * d.dEx;
          out[3] = s * d.dEy;
          out[4] = (s * d.dWx) / 2;
          out[5] = (s * d.dWy) / 2;
          out[6] = (s * d.dWx) / 2;
          out[7] = (s * d.dWy) / 2;
        },
      },
    ];
  }

  if (ctx.isCircle(spec.a) && ctx.isCircle(spec.b)) {
    const a = ctx.circle(spec.a, 'distance first circle/arc');
    const b = ctx.circle(spec.b, 'distance second circle/arc');
    const pd = makePointDistDeriv();
    pointDist(ctx.guess, a.cx, a.cy, b.cx, b.cy, pd);
    const d0 = pd.d;
    const r1 = ctx.guess[a.r];
    const r2 = ctx.guess[b.r];
    const containment = d0 <= Math.abs(r1 - r2);
    if (containment) {
      const s = guessSign(r1 - r2);
      return [
        {
          params: [a.cx, a.cy, b.cx, b.cy, a.r, b.r],
          eval: (p) => {
            pointDist(p, a.cx, a.cy, b.cx, b.cy, pd);
            return s * (p[a.r] - p[b.r]) - pd.d - t;
          },
          jac: (p, out) => {
            pointDist(p, a.cx, a.cy, b.cx, b.cy, pd);
            out[0] = -pd.dAx;
            out[1] = -pd.dAy;
            out[2] = pd.dAx;
            out[3] = pd.dAy;
            out[4] = s;
            out[5] = -s;
          },
        },
      ];
    }
    return [
      {
        params: [a.cx, a.cy, b.cx, b.cy, a.r, b.r],
        eval: (p) => {
          pointDist(p, a.cx, a.cy, b.cx, b.cy, pd);
          return pd.d - p[a.r] - p[b.r] - t;
        },
        jac: (p, out) => {
          pointDist(p, a.cx, a.cy, b.cx, b.cy, pd);
          out[0] = pd.dAx;
          out[1] = pd.dAy;
          out[2] = -pd.dAx;
          out[3] = -pd.dAy;
          out[4] = -1;
          out[5] = -1;
        },
      },
    ];
  }

  throw new Error('distance: unsupported reference combination');
}
