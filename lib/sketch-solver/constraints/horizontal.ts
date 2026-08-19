// horizontal — a line (end.y = start.y) or a point pair (a.y = b.y).

import type { ConstraintSpec } from '../types.js';
import type { CompiledRow, CompileCtx } from './types.js';

type Spec = Extract<ConstraintSpec, { kind: 'horizontal' }>;

export function compileHorizontal(spec: Spec, ctx: CompileCtx): CompiledRow[] {
  if (spec.b !== undefined) {
    const a = ctx.point(spec.a, 'horizontal first point');
    const b = ctx.point(spec.b, 'horizontal second point');
    return [diffRow(a.iy, b.iy)];
  }
  const l = ctx.line(spec.a, 'horizontal line');
  return [diffRow(l.ey, l.sy)];
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
