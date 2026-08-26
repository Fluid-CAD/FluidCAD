// parallel — line–line: sin of the angle between directions,
// cross(u1,u2)/(|u1||u2|). Dimensionless and bounded, so mm-scale
// rows and this row conflict-resolve on comparable footing. Every line
// after the first is paralleled to the first — one row per pair, so
// diagnose can flag an individual redundant/conflicting link.

import type { ConstraintSpec, SolverRef } from '../types.js';
import type { CompiledRow, CompileCtx } from './types.js';
import { crossPartials, dirPair, linePairParams, makeDirPair, normalizedPairJac, ordinal } from './util.js';

type Spec = Extract<ConstraintSpec, { kind: 'parallel' }>;

export function compileParallel(spec: Spec, ctx: CompileCtx): CompiledRow[] {
  const refs: SolverRef[] = [spec.a, spec.b, ...(spec.others ?? [])];
  const first = ctx.line(refs[0], 'parallel first line');
  const rows: CompiledRow[] = [];
  for (let i = 1; i < refs.length; i++) {
    const other = ctx.line(refs[i], `parallel ${ordinal(i)} line`);
    const dp = makeDirPair();
    const df = new Array<number>(8);
    rows.push({
      params: linePairParams(first, other),
      eval: (p) => {
        dirPair(p, first, other, dp);
        return dp.cross / (dp.d1 * dp.d2);
      },
      jac: (p, out) => {
        dirPair(p, first, other, dp);
        crossPartials(dp, df);
        normalizedPairJac(dp, dp.cross / (dp.d1 * dp.d2), df, out);
      },
    });
  }
  return rows;
}
