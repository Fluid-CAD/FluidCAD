// concentric — circle-like centers coincide (2 rows).

import type { ConstraintSpec } from '../types.js';
import type { CompiledRow, CompileCtx } from './types.js';

type Spec = Extract<ConstraintSpec, { kind: 'concentric' }>;

export function compileConcentric(spec: Spec, ctx: CompileCtx): CompiledRow[] {
  const a = ctx.circle(spec.a, 'concentric first circle/arc');
  const b = ctx.circle(spec.b, 'concentric second circle/arc');
  const row = (ai: number, bi: number): CompiledRow => ({
    params: [ai, bi],
    eval: (p) => p[ai] - p[bi],
    jac: (_p, out) => {
      out[0] = 1;
      out[1] = -1;
    },
  });
  return [row(a.cx, b.cx), row(a.cy, b.cy)];
}
