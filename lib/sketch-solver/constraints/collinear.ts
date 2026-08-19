// collinear — both endpoints of line b on the infinite line of a
// (2 rows).

import type { ConstraintSpec } from '../types.js';
import type { CompiledRow, CompileCtx } from './types.js';
import { linePointSignedDist, makeLinePointDeriv } from './util.js';

type Spec = Extract<ConstraintSpec, { kind: 'collinear' }>;

export function compileCollinear(spec: Spec, ctx: CompileCtx): CompiledRow[] {
  const a = ctx.line(spec.a, 'collinear first line');
  const b = ctx.line(spec.b, 'collinear second line');
  const row = (wxIx: number, wyIx: number): CompiledRow => {
    const d = makeLinePointDeriv();
    return {
      params: [a.sx, a.sy, a.ex, a.ey, wxIx, wyIx],
      eval: (p) => {
        linePointSignedDist(p, a, p[wxIx], p[wyIx], d);
        return d.g;
      },
      jac: (p, out) => {
        linePointSignedDist(p, a, p[wxIx], p[wyIx], d);
        out[0] = d.dSx;
        out[1] = d.dSy;
        out[2] = d.dEx;
        out[3] = d.dEy;
        out[4] = d.dWx;
        out[5] = d.dWy;
      },
    };
  };
  return [row(b.sx, b.sy), row(b.ex, b.ey)];
}
