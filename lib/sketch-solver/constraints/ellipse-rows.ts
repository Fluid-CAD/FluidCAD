// Residual rows shared by the modules that put a point on an ellipse or
// line two ellipse normals up: coincident (a point on the outline), the
// elliptical arc's own consistency rows (its ends on its ellipse), and
// tangent (the contact point of the aux forms, the shared end of two
// joined elliptical arcs). ellipse-geom.ts carries the math; these are
// the rows built on it, so no two modules keep their own copy of one.

import type { CompiledRow, ResolvedEllipse, ResolvedPoint } from './types.js';
import {
  ellipseNormal,
  ellipsePointResidual,
  makeEllipseNormalDeriv,
  makeEllipsePointDeriv,
  makeUnitCrossDeriv,
  unitCross,
} from './ellipse-geom.js';

/**
 * The point lies on the ellipse: the on-curve residual F/|∇F| over the
 * point's params and the ellipse's pose and radii. `pt` is any pair of
 * param indices — an entity's point or a constraint's aux contact point.
 */
export function pointOnEllipseRow(e: ResolvedEllipse, pt: ResolvedPoint): CompiledRow {
  const d = makeEllipsePointDeriv();
  return {
    params: [pt.ix, pt.iy, e.cx, e.cy, e.th, e.rx, e.ry],
    eval: (p) => {
      ellipsePointResidual(p, e, p[pt.ix], p[pt.iy], d);
      return d.r;
    },
    jac: (p, out) => {
      ellipsePointResidual(p, e, p[pt.ix], p[pt.iy], d);
      out[0] = d.dPx;
      out[1] = d.dPy;
      out[2] = -d.dPx;
      out[3] = -d.dPy;
      out[4] = d.dTh;
      out[5] = d.dRx;
      out[6] = d.dRy;
    },
  };
}

/**
 * The two ellipses' normals at the point are parallel:
 * cross(Na(P), Nb(P))/(|Na|·|Nb|) = 0. With P on both curves that is
 * tangency, external and internal alike (the guess basin picks). `pt` is
 * the aux contact point of the general form, or the shared end of two
 * joined elliptical arcs in the junction form.
 */
export function ellipseNormalsParallelRow(
  a: ResolvedEllipse,
  b: ResolvedEllipse,
  pt: ResolvedPoint,
): CompiledRow {
  const na = makeEllipseNormalDeriv();
  const nb = makeEllipseNormalDeriv();
  const uc = makeUnitCrossDeriv();
  const evaluate = (p: Float64Array): void => {
    ellipseNormal(p, a, p[pt.ix], p[pt.iy], na);
    ellipseNormal(p, b, p[pt.ix], p[pt.iy], nb);
    unitCross(na.nx, na.ny, nb.nx, nb.ny, uc);
  };
  return {
    params: [pt.ix, pt.iy, a.cx, a.cy, a.th, b.cx, b.cy, b.th, a.rx, a.ry, b.rx, b.ry],
    eval: (p) => {
      evaluate(p);
      return uc.h;
    },
    jac: (p, out) => {
      evaluate(p);
      const ax = uc.d1x * na.a + uc.d1y * na.b;
      const ay = uc.d1x * na.b + uc.d1y * na.d;
      const bx = uc.d2x * nb.a + uc.d2y * nb.b;
      const by = uc.d2x * nb.b + uc.d2y * nb.d;
      out[0] = ax + bx;
      out[1] = ay + by;
      out[2] = -ax;
      out[3] = -ay;
      out[4] = uc.d1x * na.dNxTh + uc.d1y * na.dNyTh;
      out[5] = -bx;
      out[6] = -by;
      out[7] = uc.d2x * nb.dNxTh + uc.d2y * nb.dNyTh;
      out[8] = uc.d1x * na.dNxRx + uc.d1y * na.dNyRx;
      out[9] = uc.d1x * na.dNxRy + uc.d1y * na.dNyRy;
      out[10] = uc.d2x * nb.dNxRx + uc.d2y * nb.dNyRx;
      out[11] = uc.d2x * nb.dNxRy + uc.d2y * nb.dNyRy;
    },
  };
}
