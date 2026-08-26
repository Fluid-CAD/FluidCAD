// horizontal — a line (end.y = start.y) or two or more points sharing a
// y value. Every point after the first is aligned to the first — one row
// per pair, so diagnose can flag an individual redundant/conflicting link.

import type { ConstraintSpec, SolverRef } from '../types.js';
import type { CompiledRow, CompileCtx } from './types.js';
import { ordinal } from './util.js';

type Spec = Extract<ConstraintSpec, { kind: 'horizontal' }>;

export function compileHorizontal(spec: Spec, ctx: CompileCtx): CompiledRow[] {
  if (spec.b !== undefined) {
    const refs: SolverRef[] = [spec.a, spec.b, ...(spec.others ?? [])];
    const first = ctx.point(refs[0], 'horizontal first point');
    const rows: CompiledRow[] = [];
    for (let i = 1; i < refs.length; i++) {
      const other = ctx.point(refs[i], `horizontal ${ordinal(i)} point`);
      rows.push(diffRow(first.iy, other.iy));
    }
    return rows;
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
