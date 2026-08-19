// equal — equal line lengths or equal radii.

import type { ConstraintSpec } from '../types.js';
import type { CompiledRow, CompileCtx } from './types.js';
import { makePointDistDeriv, pointDist } from './util.js';

type Spec = Extract<ConstraintSpec, { kind: 'equal' }>;

export function compileEqual(spec: Spec, ctx: CompileCtx): CompiledRow[] {
  if (ctx.isLine(spec.a) && ctx.isLine(spec.b)) {
    const a = ctx.line(spec.a, 'equal first line');
    const b = ctx.line(spec.b, 'equal second line');
    const da = makePointDistDeriv();
    const db = makePointDistDeriv();
    return [
      {
        params: [a.ex, a.ey, a.sx, a.sy, b.ex, b.ey, b.sx, b.sy],
        eval: (p) => {
          pointDist(p, a.ex, a.ey, a.sx, a.sy, da);
          pointDist(p, b.ex, b.ey, b.sx, b.sy, db);
          return da.d - db.d;
        },
        jac: (p, out) => {
          pointDist(p, a.ex, a.ey, a.sx, a.sy, da);
          pointDist(p, b.ex, b.ey, b.sx, b.sy, db);
          out[0] = da.dAx;
          out[1] = da.dAy;
          out[2] = -da.dAx;
          out[3] = -da.dAy;
          out[4] = -db.dAx;
          out[5] = -db.dAy;
          out[6] = db.dAx;
          out[7] = db.dAy;
        },
      },
    ];
  }
  if (ctx.isCircle(spec.a) && ctx.isCircle(spec.b)) {
    const a = ctx.circle(spec.a, 'equal first circle/arc');
    const b = ctx.circle(spec.b, 'equal second circle/arc');
    return [
      {
        params: [a.r, b.r],
        eval: (p) => p[a.r] - p[b.r],
        jac: (_p, out) => {
          out[0] = 1;
          out[1] = -1;
        },
      },
    ];
  }
  throw new Error('equal needs two lines or two circle-like entities');
}
