// horizontal — a line (end.y = start.y), an ellipse (RX axis along the sketch x
// direction) or two or more points sharing a
// y value. Every point after the first is aligned to the first — one row
// per pair, so diagnose can flag an individual redundant/conflicting link.

import type { ConstraintSpec, SolverRef } from '../types.js';
import type { CompiledRow, CompileCtx, ResolvedEllipse } from './types.js';
import { ordinal } from './util.js';

type Spec = Extract<ConstraintSpec, { kind: 'horizontal' }>;

export function compileHorizontal(spec: Spec, ctx: CompileCtx): CompiledRow[] {
  if (spec.b !== undefined) {
    const refs: SolverRef[] = [spec.a, spec.b, ...(spec.others ?? [])];
    const first = ctx.point(refs[0], 'horizontal first point');
    const rows: CompiledRow[] = [];
    for (let i = 1; i < refs.length; i++) {
      const other = ctx.point(refs[i], `horizontal ${ordinal(i)} point`);
      rows.push(diffRow(first.iy, other.iy));
    }
    return rows;
  }
  if (ctx.isEllipse(spec.a)) {
    return [ellipseRow(ctx, ctx.ellipse(spec.a, 'horizontal ellipse'))];
  }
  const l = ctx.line(spec.a, 'horizontal line');
  return [diffRow(l.ey, l.sy)];
}

/**
 * An ellipse is horizontal when its RX axis u = (cos θ, sin θ) runs along the
 * sketch x direction: θ = kπ (every k is the same ellipse). The row is
 * LINEAR in θ against the kπ nearest the guess, locked at compile time:
 * a trigonometric residual (sin θ) has a zero gradient exactly where a
 * drawn ellipse starts when the other orientation is asked for (θ = π/2 for
 * this row, θ = 0 for vertical's), and the solver stalls there and reports
 * a conflict. Dimensionless (radians), like the angle row.
 */
function ellipseRow(ctx: CompileCtx, e: ResolvedEllipse): CompiledRow {
  const target = Math.round(ctx.guess[e.th] / Math.PI) * Math.PI;
  return {
    params: [e.th],
    eval: (p) => p[e.th] - target,
    jac: (_p, out) => {
      out[0] = 1;
    },
  };
}

function diffRow(a: number, b: number): CompiledRow {
  return {
    params: [a, b],
    eval: (p) => p[a] - p[b],
    jac: (_p, out) => {
      out[0] = 1;
      out[1] = -1;
    },
  };
}
