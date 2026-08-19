// angle — directed angle from line a's direction to line b's,
// atan2(cross, dot) − target, wrapped to (−π, π]. Unique solution
// modulo full turns (a sin-only form would also accept θ+π). The wrap
// makes the residual jump at the ±π antipode — standard sketcher
// behavior; guesses near the antipode may converge to the far branch.

import type { ConstraintSpec } from '../types.js';
import type { CompiledRow, CompileCtx } from './types.js';
import {
  crossPartials,
  dirPair,
  dotPartials,
  EPS,
  linePairParams,
  makeDirPair,
  wrapToPi,
} from './util.js';

type Spec = Extract<ConstraintSpec, { kind: 'angle' }>;

export function compileAngle(spec: Spec, ctx: CompileCtx): CompiledRow[] {
  const a = ctx.line(spec.a, 'angle first line');
  const b = ctx.line(spec.b, 'angle second line');
  const target = spec.value;
  const dp = makeDirPair();
  const dCross = new Array<number>(8);
  const dDot = new Array<number>(8);
  return [
    {
      params: linePairParams(a, b),
      eval: (p) => {
        dirPair(p, a, b, dp);
        return wrapToPi(Math.atan2(dp.cross, dp.dot) - target);
      },
      jac: (p, out) => {
        dirPair(p, a, b, dp);
        crossPartials(dp, dCross);
        dotPartials(dp, dDot);
        const q = Math.max(dp.cross * dp.cross + dp.dot * dp.dot, EPS);
        for (let i = 0; i < 8; i++) {
          out[i] = (dp.dot * dCross[i] - dp.cross * dDot[i]) / q;
        }
      },
    },
  ];
}
