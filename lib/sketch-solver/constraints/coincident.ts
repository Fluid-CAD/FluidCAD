// coincident — point–point (2 rows) or point-on-entity (1 row).
// Point-on-line is the infinite line; point-on-circle/arc is the full
// circle (arc endpoints are first-class points, so trimming semantics
// stay out of the solver).

import type { ConstraintSpec, SolverRef } from '../types.js';
import type { CompiledRow, CompileCtx } from './types.js';
import { linePointSignedDist, makeLinePointDeriv, makePointDistDeriv, pointDist } from './util.js';

type Spec = Extract<ConstraintSpec, { kind: 'coincident' }>;

export function compileCoincident(spec: Spec, ctx: CompileCtx): CompiledRow[] {
  const aPoint = ctx.isPoint(spec.a);
  const bPoint = ctx.isPoint(spec.b);
  if (aPoint && bPoint) {
    const a = ctx.point(spec.a, 'coincident first point');
    const b = ctx.point(spec.b, 'coincident second point');
    return [
      {
        params: [a.ix, b.ix],
        eval: (p) => p[a.ix] - p[b.ix],
        jac: (_p, out) => {
          out[0] = 1;
          out[1] = -1;
        },
      },
      {
        params: [a.iy, b.iy],
        eval: (p) => p[a.iy] - p[b.iy],
        jac: (_p, out) => {
          out[0] = 1;
          out[1] = -1;
        },
      },
    ];
  }
  const pRef: SolverRef = aPoint ? spec.a : spec.b;
  const eRef: SolverRef = aPoint ? spec.b : spec.a;
  if (!aPoint && !bPoint) {
    throw new Error('coincident needs at least one point reference');
  }
  const pt = ctx.point(pRef, 'coincident point');
  if (ctx.isLine(eRef)) {
    const l = ctx.line(eRef, 'coincident line');
    const d = makeLinePointDeriv();
    return [
      {
        params: [l.sx, l.sy, l.ex, l.ey, pt.ix, pt.iy],
        eval: (p) => {
          linePointSignedDist(p, l, p[pt.ix], p[pt.iy], d);
          return d.g;
        },
        jac: (p, out) => {
          linePointSignedDist(p, l, p[pt.ix], p[pt.iy], d);
          out[0] = d.dSx;
          out[1] = d.dSy;
          out[2] = d.dEx;
          out[3] = d.dEy;
          out[4] = d.dWx;
          out[5] = d.dWy;
        },
      },
    ];
  }
  const c = ctx.circle(eRef, 'coincident circle/arc');
  const pd = makePointDistDeriv();
  return [
    {
      params: [pt.ix, pt.iy, c.cx, c.cy, c.r],
      eval: (p) => {
        pointDist(p, pt.ix, pt.iy, c.cx, c.cy, pd);
        return pd.d - p[c.r];
      },
      jac: (p, out) => {
        pointDist(p, pt.ix, pt.iy, c.cx, c.cy, pd);
        out[0] = pd.dAx;
        out[1] = pd.dAy;
        out[2] = -pd.dAx;
        out[3] = -pd.dAy;
        out[4] = -1;
      },
    },
  ];
}
