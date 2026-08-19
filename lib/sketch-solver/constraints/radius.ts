// radius / diameter — direct dimension on a circle-like entity's
// radius param.

import type { ConstraintSpec } from '../types.js';
import type { CompiledRow, CompileCtx } from './types.js';

type RadiusSpec = Extract<ConstraintSpec, { kind: 'radius' }>;
type DiameterSpec = Extract<ConstraintSpec, { kind: 'diameter' }>;

export function compileRadius(spec: RadiusSpec, ctx: CompileCtx): CompiledRow[] {
  const c = ctx.circle(spec.a, 'radius circle/arc');
  return [
    {
      params: [c.r],
      eval: (p) => p[c.r] - spec.value,
      jac: (_p, out) => {
        out[0] = 1;
      },
    },
  ];
}

export function compileDiameter(spec: DiameterSpec, ctx: CompileCtx): CompiledRow[] {
  const c = ctx.circle(spec.a, 'diameter circle/arc');
  return [
    {
      params: [c.r],
      eval: (p) => 2 * p[c.r] - spec.value,
      jac: (_p, out) => {
        out[0] = 2;
      },
    },
  ];
}
