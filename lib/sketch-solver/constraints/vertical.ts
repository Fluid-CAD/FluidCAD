// vertical — a line (end.x = start.x) or a point pair (a.x = b.x).

import type { ConstraintSpec } from '../types.js';
import type { CompiledRow, CompileCtx } from './types.js';

type Spec = Extract<ConstraintSpec, { kind: 'vertical' }>;

export function compileVertical(spec: Spec, ctx: CompileCtx): CompiledRow[] {
  if (spec.b !== undefined) {
    const a = ctx.point(spec.a, 'vertical first point');
    const b = ctx.point(spec.b, 'vertical second point');
    return [diffRow(a.ix, b.ix)];
  }
  const l = ctx.line(spec.a, 'vertical line');
  return [diffRow(l.ex, l.sx)];
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
