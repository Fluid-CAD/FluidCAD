// midpoint — point p is the midpoint of line l (2 rows).

import type { ConstraintSpec } from '../types.js';
import type { CompiledRow, CompileCtx } from './types.js';

type Spec = Extract<ConstraintSpec, { kind: 'midpoint' }>;

export function compileMidpoint(spec: Spec, ctx: CompileCtx): CompiledRow[] {
  const pt = ctx.point(spec.p, 'midpoint point');
  const l = ctx.line(spec.l, 'midpoint line');
  const row = (pi: number, si: number, ei: number): CompiledRow => ({
    params: [pi, si, ei],
    eval: (p) => p[pi] - (p[si] + p[ei]) / 2,
    jac: (_p, out) => {
      out[0] = 1;
      out[1] = -0.5;
      out[2] = -0.5;
    },
  });
  return [row(pt.ix, l.sx, l.ex), row(pt.iy, l.sy, l.ey)];
}
