// angle — counterclockwise angle from line a's oriented direction to
// line b's: atan2(cross, dot) − target, wrapped to (−π, π). Targets are
// positive, [0, 2π); orientation is carried by the refs — a bare line
// ref (or its 'end' point) means start→end, a 'start' point ref means
// the reversed direction, so every sector at the intersection of two
// lines is expressible without signed values. Unique solution modulo
// full turns (a sin-only form would also accept θ+π). The wrap makes
// the residual jump at the target's antipode — standard sketcher
// behavior; guesses near the antipode may converge to the far branch.

import type { ConstraintSpec, SolverRef } from '../types.js';
import type { CompiledRow, CompileCtx, ResolvedLine } from './types.js';
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

/** Resolve a line ref whose optional point role orients it: 'end' (or no
 * role) keeps start→end, 'start' reverses — the resolved endpoint indices
 * swap, so the shared direction-pair math needs no sign plumbing. */
function orientedLine(ctx: CompileCtx, ref: SolverRef, what: string): ResolvedLine {
  const l = ctx.line({ entity: ref.entity }, what);
  if (ref.point === undefined || ref.point === 'end') {
    return l;
  }
  if (ref.point === 'start') {
    return { sx: l.ex, sy: l.ey, ex: l.sx, ey: l.sy };
  }
  throw new Error(`${what}: a line has no '${ref.point}' direction — use .start() or .end()`);
}

export function compileAngle(spec: Spec, ctx: CompileCtx): CompiledRow[] {
  const a = orientedLine(ctx, spec.a, 'angle first line');
  const b = orientedLine(ctx, spec.b, 'angle second line');
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
