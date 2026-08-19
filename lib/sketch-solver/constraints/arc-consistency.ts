// arc-consistency — internal, auto-added per arc: both endpoints at
// radius distance from the center (the planegcs arc layout). Keeps
// arc endpoints first-class points for coincidence/tangency while the
// (center, r) pair stays meaningful.

import type { ConstraintSpec } from '../types.js';
import type { CompiledRow, CompileCtx } from './types.js';
import { center, end, start } from '../types.js';
import { makePointDistDeriv, pointDist } from './util.js';

type Spec = Extract<ConstraintSpec, { kind: 'arc-consistency' }>;

export function compileArcConsistency(spec: Spec, ctx: CompileCtx): CompiledRow[] {
  if (ctx.kindOf(spec.entity) !== 'arc') {
    throw new Error('arc-consistency applies to arcs only');
  }
  const c = ctx.circle({ entity: spec.entity }, 'arc');
  const cen = ctx.point(center(spec.entity), 'arc center');
  const row = (endpoint: { ix: number; iy: number }): CompiledRow => {
    const pd = makePointDistDeriv();
    return {
      params: [endpoint.ix, endpoint.iy, cen.ix, cen.iy, c.r],
      eval: (p) => {
        pointDist(p, endpoint.ix, endpoint.iy, cen.ix, cen.iy, pd);
        return pd.d - p[c.r];
      },
      jac: (p, out) => {
        pointDist(p, endpoint.ix, endpoint.iy, cen.ix, cen.iy, pd);
        out[0] = pd.dAx;
        out[1] = pd.dAy;
        out[2] = -pd.dAx;
        out[3] = -pd.dAy;
        out[4] = -1;
      },
    };
  };
  return [row(ctx.point(start(spec.entity), 'arc start')), row(ctx.point(end(spec.entity), 'arc end'))];
}
