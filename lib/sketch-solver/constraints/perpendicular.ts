// perpendicular — line–line: cos of the angle between directions,
// dot(u1,u2)/(|u1||u2|).

import type { ConstraintSpec } from '../types.js';
import type { CompiledRow, CompileCtx } from './types.js';
import { dirPair, dotPartials, linePairParams, makeDirPair, normalizedPairJac } from './util.js';

type Spec = Extract<ConstraintSpec, { kind: 'perpendicular' }>;

export function compilePerpendicular(spec: Spec, ctx: CompileCtx): CompiledRow[] {
  const a = ctx.line(spec.a, 'perpendicular first line');
  const b = ctx.line(spec.b, 'perpendicular second line');
  const dp = makeDirPair();
  const df = new Array<number>(8);
  return [
    {
      params: linePairParams(a, b),
      eval: (p) => {
        dirPair(p, a, b, dp);
        return dp.dot / (dp.d1 * dp.d2);
      },
      jac: (p, out) => {
        dirPair(p, a, b, dp);
        dotPartials(dp, df);
        normalizedPairJac(dp, dp.dot / (dp.d1 * dp.d2), df, out);
      },
    },
  ];
}
