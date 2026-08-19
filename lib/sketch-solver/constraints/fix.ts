// fix — anchor a point at (x, y). Implemented as residual rows (not
// a param mask) so diagnostics can attribute conflicts and
// redundancy to the fix statement like any other constraint. The
// param mask is reserved for fixed reference entities (P6).

import type { ConstraintSpec } from '../types.js';
import type { CompiledRow, CompileCtx } from './types.js';

type Spec = Extract<ConstraintSpec, { kind: 'fix' }>;

export function compileFix(spec: Spec, ctx: CompileCtx): CompiledRow[] {
  const pt = ctx.point(spec.p, 'fix point');
  // constrain() captures missing targets from the guess at statement
  // time; compile still guards for hand-built specs.
  const tx = spec.x ?? ctx.guess[pt.ix];
  const ty = spec.y ?? ctx.guess[pt.iy];
  const row = (pi: number, t: number): CompiledRow => ({
    params: [pi],
    eval: (p) => p[pi] - t,
    jac: (_p, out) => {
      out[0] = 1;
    },
  });
  return [row(pt.ix, tx), row(pt.iy, ty)];
}
