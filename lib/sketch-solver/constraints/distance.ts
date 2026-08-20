// distance — the dimension workhorse. Form by resolution:
//   point–point            |a−b| = t          (axis: side-locked Δx/Δy)
//   point–line             side-locked perpendicular distance
//   point–circle/arc       distance to the circumference, side-locked
//   line–line              b's midpoint to a's infinite line (pair
//                          with parallel for the classic dim)
//   line–circle/arc        perpendicular distance from the center to
//                          the infinite line, minus the radius (side
//                          + outside/crossing locked from the guess)
//   circle–circle          gap between circumferences (containment vs
//                          external locked from the guess)
// Side locks come from the guesses at compile time so a dimensioned
// point can't wander to the mirror solution during a warm re-solve.
//
// `tangency: 'max'` (SolidWorks arc-condition max) flips every
// circle/arc measurement to the FAR side of the circumference:
// point–circle d + r, line–circle |g| + r, circle–circle d + r1 + r2.
// All max forms are smooth sums — no outside/crossing branch to lock.

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
  const far = spec.tangency === 'max';
  const aPoint = ctx.isPoint(spec.a);
  const bPoint = ctx.isPoint(spec.b);

  if (spec.axis !== undefined && !(aPoint && bPoint)) {
    throw new Error('distance axis variants require two point references');
  }
  if (spec.tangency !== undefined && !ctx.isCircle(spec.a) && !ctx.isCircle(spec.b)) {
    throw new Error('distance: min/max tangency requires a circle or arc reference');
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
    if (far) {
      return [
        {
          params: [pt.ix, pt.iy, c.cx, c.cy, c.r],
          eval: (p) => {
            pointDist(p, pt.ix, pt.iy, c.cx, c.cy, pd);
            return pd.d + p[c.r] - t;
          },
          jac: (p, out) => {
            pointDist(p, pt.ix, pt.iy, c.cx, c.cy, pd);
            out[0] = pd.dAx;
            out[1] = pd.dAy;
            out[2] = -pd.dAx;
            out[3] = -pd.dAy;
            out[4] = 1;
          },
        },
      ];
    }
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

  if ((ctx.isLine(spec.a) && ctx.isCircle(spec.b)) || (ctx.isCircle(spec.a) && ctx.isLine(spec.b))) {
    const lRef: SolverRef = ctx.isLine(spec.a) ? spec.a : spec.b;
    const cRef: SolverRef = ctx.isLine(spec.a) ? spec.b : spec.a;
    const l = ctx.line(lRef, 'distance line');
    const c = ctx.circle(cRef, 'distance circle/arc');
    const d = makeLinePointDeriv();
    linePointSignedDist(ctx.guess, l, ctx.guess[c.cx], ctx.guess[c.cy], d);
    // s1 locks which side of the line the center sits; s2 locks whether
    // the line clears the circle (gap) or crosses it (chord depth).
    // Far side (max): |g| + r — always positive, no s2 branch.
    const s1 = guessSign(d.g);
    const s2 = far ? 1 : guessSign(s1 * d.g - ctx.guess[c.r]);
    const rCoef = far ? 1 : -s2;
    const k = s2 * s1;
    return [
      {
        params: [l.sx, l.sy, l.ex, l.ey, c.cx, c.cy, c.r],
        eval: (p) => {
          linePointSignedDist(p, l, p[c.cx], p[c.cy], d);
          return k * d.g + rCoef * p[c.r] - t;
        },
        jac: (p, out) => {
          linePointSignedDist(p, l, p[c.cx], p[c.cy], d);
          out[0] = k * d.dSx;
          out[1] = k * d.dSy;
          out[2] = k * d.dEx;
          out[3] = k * d.dEy;
          out[4] = k * d.dWx;
          out[5] = k * d.dWy;
          out[6] = rCoef;
        },
      },
    ];
  }

  if (ctx.isCircle(spec.a) && ctx.isCircle(spec.b)) {
    const a = ctx.circle(spec.a, 'distance first circle/arc');
    const b = ctx.circle(spec.b, 'distance second circle/arc');
    const pd = makePointDistDeriv();
    if (far) {
      return [
        {
          params: [a.cx, a.cy, b.cx, b.cy, a.r, b.r],
          eval: (p) => {
            pointDist(p, a.cx, a.cy, b.cx, b.cy, pd);
            return pd.d + p[a.r] + p[b.r] - t;
          },
          jac: (p, out) => {
            pointDist(p, a.cx, a.cy, b.cx, b.cy, pd);
            out[0] = pd.dAx;
            out[1] = pd.dAy;
            out[2] = -pd.dAx;
            out[3] = -pd.dAy;
            out[4] = 1;
            out[5] = 1;
          },
        },
      ];
    }
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
