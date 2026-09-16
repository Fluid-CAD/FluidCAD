// radius / diameter — direct dimension on a circle-like entity's
// radius param. An ellipse has two: radius(el, value, 'x' | 'y') names
// which semi-radius (its RX or RY axis) the row dimensions.

import type { ConstraintSpec } from '../types.js';
import type { CompiledRow, CompileCtx } from './types.js';

type RadiusSpec = Extract<ConstraintSpec, { kind: 'radius' }>;
type DiameterSpec = Extract<ConstraintSpec, { kind: 'diameter' }>;

export function compileRadius(spec: RadiusSpec, ctx: CompileCtx): CompiledRow[] {
  let ir: number;
  if (ctx.isEllipse(spec.a)) {
    if (spec.axis === undefined) {
      throw new Error(
        "radius on an ellipse needs the axis — radius(el, value, 'x') dimensions RX, 'y' dimensions RY",
      );
    }
    const e = ctx.ellipse(spec.a, 'radius ellipse');
    ir = spec.axis === 'x' ? e.rx : e.ry;
  } else {
    if (spec.axis !== undefined) {
      throw new Error("radius: the axis argument ('x' | 'y') names an ellipse's semi-radius — a circle or arc has one radius");
    }
    ir = ctx.circle(spec.a, 'radius circle/arc').r;
  }
  return [
    {
      params: [ir],
      eval: (p) => p[ir] - spec.value,
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
