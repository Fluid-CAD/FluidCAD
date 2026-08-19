// parallel — line–line: sin of the angle between directions,
// cross(u1,u2)/(|u1||u2|). Dimensionless and bounded, so mm-scale
// rows and this row conflict-resolve on comparable footing.

import type { ConstraintSpec } from '../types.js';
import type { CompiledRow, CompileCtx } from './types.js';
import { crossPartials, dirPair, linePairParams, makeDirPair, normalizedPairJac } from './util.js';

type Spec = Extract<ConstraintSpec, { kind: 'parallel' }>;

export function compileParallel(spec: Spec, ctx: CompileCtx): CompiledRow[] {
  const a = ctx.line(spec.a, 'parallel first line');
  const b = ctx.line(spec.b, 'parallel second line');
  const dp = makeDirPair();
  const df = new Array<number>(8);
  return [
    {
      params: linePairParams(a, b),
      eval: (p) => {
        dirPair(p, a, b, dp);
        return dp.cross / (dp.d1 * dp.d2);
      },
      jac: (p, out) => {
        dirPair(p, a, b, dp);
        crossPartials(dp, df);
        normalizedPairJac(dp, dp.cross / (dp.d1 * dp.d2), df, out);
      },
    },
  ];
}
