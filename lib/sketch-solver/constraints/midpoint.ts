// midpoint — point p is the midpoint of line l, or sits halfway between
// points a and b (2 rows either way: p − (a + b)/2 per axis, with the line
// form reading a/b off the line's endpoints).

import type { ConstraintSpec } from '../types.js';
import type { CompiledRow, CompileCtx } from './types.js';

type Spec = Extract<ConstraintSpec, { kind: 'midpoint' }>;

export function compileMidpoint(spec: Spec, ctx: CompileCtx): CompiledRow[] {
  const pt = ctx.point(spec.p, 'midpoint point');
  let ax: number;
  let ay: number;
  let bx: number;
  let by: number;
  if ('l' in spec) {
    const l = ctx.line(spec.l, 'midpoint line');
    ({ sx: ax, sy: ay, ex: bx, ey: by } = l);
  } else {
    const a = ctx.point(spec.a, 'midpoint first point');
    const b = ctx.point(spec.b, 'midpoint second point');
    ({ ix: ax, iy: ay } = a);
    ({ ix: bx, iy: by } = b);
  }
  const row = (pi: number, ai: number, bi: number): CompiledRow => ({
    params: [pi, ai, bi],
    eval: (p) => p[pi] - (p[ai] + p[bi]) / 2,
    jac: (_p, out) => {
      out[0] = 1;
      out[1] = -0.5;
      out[2] = -0.5;
    },
  });
  return [row(pt.ix, ax, bx), row(pt.iy, ay, by)];
}
