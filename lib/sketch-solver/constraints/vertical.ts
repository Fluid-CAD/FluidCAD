// vertical — a line (end.x = start.x), an ellipse (RX axis along the sketch y
// direction) or two or more points sharing an
// x value. Every point after the first is aligned to the first — one row
// per pair, so diagnose can flag an individual redundant/conflicting link.

import type { ConstraintSpec, SolverRef } from '../types.js';
import type { CompiledRow, CompileCtx, ResolvedEllipse } from './types.js';
import { ordinal } from './util.js';

type Spec = Extract<ConstraintSpec, { kind: 'vertical' }>;

export function compileVertical(spec: Spec, ctx: CompileCtx): CompiledRow[] {
  if (spec.b !== undefined) {
    const refs: SolverRef[] = [spec.a, spec.b, ...(spec.others ?? [])];
    const first = ctx.point(refs[0], 'vertical first point');
    const rows: CompiledRow[] = [];
    for (let i = 1; i < refs.length; i++) {
      const other = ctx.point(refs[i], `vertical ${ordinal(i)} point`);
      rows.push(diffRow(first.ix, other.ix));
    }
    return rows;
  }
  if (ctx.isEllipse(spec.a)) {
    return [ellipseRow(ctx, ctx.ellipse(spec.a, 'vertical ellipse'))];
  }
  const l = ctx.line(spec.a, 'vertical line');
  return [diffRow(l.ex, l.sx)];
}

/**
 * An ellipse is vertical when its RX axis u = (cos θ, sin θ) runs along the
 * sketch y direction: θ = π/2 + kπ (every k is the same ellipse). The row
 * is LINEAR in θ against the odd multiple of π/2 nearest the guess, locked
 * at compile time — see horizontal's ellipseRow for why a cos θ residual
 * cannot be used: it has a zero gradient at θ = 0, exactly where every
 * drawn ellipse starts, so the solver stalls and reports a conflict. From
 * θ = 0 the tie breaks toward +π/2 (counter-clockwise). Radians, like the
 * angle row.
 */
function ellipseRow(ctx: CompileCtx, e: ResolvedEllipse): CompiledRow {
  const half = Math.PI / 2;
  const target = half + Math.round((ctx.guess[e.th] - half) / Math.PI) * Math.PI;
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
