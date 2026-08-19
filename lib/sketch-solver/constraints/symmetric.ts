// symmetric — points a and b mirror across line l: their midpoint
// lies on the line and a−b is perpendicular to it (2 rows).

import type { ConstraintSpec } from '../types.js';
import type { CompiledRow, CompileCtx } from './types.js';
import { floorDist, linePointSignedDist, makeLinePointDeriv } from './util.js';

type Spec = Extract<ConstraintSpec, { kind: 'symmetric' }>;

export function compileSymmetric(spec: Spec, ctx: CompileCtx): CompiledRow[] {
  const a = ctx.point(spec.a, 'symmetric first point');
  const b = ctx.point(spec.b, 'symmetric second point');
  const l = ctx.line(spec.l, 'symmetric line');
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
