// equal — equal line lengths or equal radii, over two or more entities.
// Every entity after the first is equated to the first: one residual row
// per pair, so diagnose can flag an individual redundant/conflicting link
// without dragging the whole chain down.

import type { ConstraintSpec, SolverRef } from '../types.js';
import type { CompiledRow, CompileCtx } from './types.js';
import { makePointDistDeriv, ordinal, pointDist } from './util.js';

type Spec = Extract<ConstraintSpec, { kind: 'equal' }>;

export function compileEqual(spec: Spec, ctx: CompileCtx): CompiledRow[] {
  const refs: SolverRef[] = [spec.a, spec.b, ...(spec.others ?? [])];
  if (refs.every(r => ctx.isLine(r))) {
    const first = ctx.line(refs[0], 'equal first line');
    const rows: CompiledRow[] = [];
    for (let i = 1; i < refs.length; i++) {
      const other = ctx.line(refs[i], `equal ${ordinal(i)} line`);
      const da = makePointDistDeriv();
      const db = makePointDistDeriv();
      rows.push({
        params: [first.ex, first.ey, first.sx, first.sy, other.ex, other.ey, other.sx, other.sy],
        eval: (p) => {
          pointDist(p, first.ex, first.ey, first.sx, first.sy, da);
          pointDist(p, other.ex, other.ey, other.sx, other.sy, db);
          return da.d - db.d;
        },
        jac: (p, out) => {
          pointDist(p, first.ex, first.ey, first.sx, first.sy, da);
          pointDist(p, other.ex, other.ey, other.sx, other.sy, db);
          out[0] = da.dAx;
          out[1] = da.dAy;
          out[2] = -da.dAx;
          out[3] = -da.dAy;
          out[4] = -db.dAx;
          out[5] = -db.dAy;
          out[6] = db.dAx;
          out[7] = db.dAy;
        },
      });
    }
    return rows;
  }
  if (refs.every(r => ctx.isCircle(r))) {
    const first = ctx.circle(refs[0], 'equal first circle/arc');
    const rows: CompiledRow[] = [];
    for (let i = 1; i < refs.length; i++) {
      const other = ctx.circle(refs[i], `equal ${ordinal(i)} circle/arc`);
      rows.push({
        params: [first.r, other.r],
        eval: (p) => p[first.r] - p[other.r],
        jac: (_p, out) => {
          out[0] = 1;
          out[1] = -1;
        },
      });
    }
    return rows;
  }
  throw new Error('equal needs all lines or all circle-like entities');
}
