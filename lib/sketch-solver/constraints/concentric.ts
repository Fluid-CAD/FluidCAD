// concentric — circle-like centers coincide (2 rows). Circles, arcs and
// ellipses all carry their center as their first two params.

import type { ConstraintSpec, SolverRef } from '../types.js';
import type { CompiledRow, CompileCtx, ResolvedPoint } from './types.js';

type Spec = Extract<ConstraintSpec, { kind: 'concentric' }>;

export function compileConcentric(spec: Spec, ctx: CompileCtx): CompiledRow[] {
  const a = centerOf(ctx, spec.a, 'concentric first');
  const b = centerOf(ctx, spec.b, 'concentric second');
  const row = (ai: number, bi: number): CompiledRow => ({
    params: [ai, bi],
    eval: (p) => p[ai] - p[bi],
    jac: (_p, out) => {
      out[0] = 1;
      out[1] = -1;
    },
  });
  return [row(a.ix, b.ix), row(a.iy, b.iy)];
}

/** The center params of a circle, arc or ellipse entity ref. */
function centerOf(ctx: CompileCtx, ref: SolverRef, what: string): ResolvedPoint {
  if (ctx.isEllipse(ref)) {
    const e = ctx.ellipse(ref, `${what} ellipse`);
    return { ix: e.cx, iy: e.cy };
  }
  if (ctx.isCircle(ref)) {
    const c = ctx.circle(ref, `${what} circle/arc`);
    return { ix: c.cx, iy: c.cy };
  }
  throw new Error(`${what} target: expected a circle, arc or ellipse entity ref`);
}
