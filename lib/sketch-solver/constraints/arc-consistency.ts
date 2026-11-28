// arc-consistency — internal, auto-added per arc: both endpoints on the
// arc's own curve. A circular arc holds them at radius distance from the
// center (the planegcs arc layout); an elliptical arc holds them on its
// ellipse with the on-curve residual every point-on-ellipse row uses.
// Either way the endpoints stay first-class points for coincidence and
// tangency while the curve's own params stay meaningful.

import type { ConstraintSpec } from '../types.js';
import type { CompiledRow, CompileCtx, ResolvedPoint } from './types.js';
import { center, end, start } from '../types.js';
import { makePointDistDeriv, pointDist } from './util.js';
import { pointOnEllipseRow } from './ellipse-rows.js';

type Spec = Extract<ConstraintSpec, { kind: 'arc-consistency' }>;

export function compileArcConsistency(spec: Spec, ctx: CompileCtx): CompiledRow[] {
  const kind = ctx.kindOf(spec.entity);
  if (kind === 'eArc') {
    const e = ctx.ellipse({ entity: spec.entity }, 'elliptical arc');
    return [
      pointOnEllipseRow(e, ctx.point(start(spec.entity), 'elliptical arc start')),
      pointOnEllipseRow(e, ctx.point(end(spec.entity), 'elliptical arc end')),
    ];
  }
  if (kind !== 'arc') {
    throw new Error('arc-consistency applies to arcs and elliptical arcs only');
  }
  const c = ctx.circle({ entity: spec.entity }, 'arc');
  const cen = ctx.point(center(spec.entity), 'arc center');
  const row = (endpoint: ResolvedPoint): CompiledRow => {
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
