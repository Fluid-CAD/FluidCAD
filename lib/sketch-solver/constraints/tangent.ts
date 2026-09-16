// tangent — line–circle/arc, circle–circle, line–ellipse, or
// ellipse–circle/arc/ellipse.
//
// Two formulations per circle-like pairing:
//
//  - Junction form, used when a user coincident statement pins a
//    tangency point (line endpoint ↔ arc endpoint, or endpoint on the
//    other curve): perpendicularity of the radius at the junction
//    (line case) / center–junction collinearity (circle case). The
//    residual is linear in the drift along the curve — the distance
//    form is quadratic there (rank-deficient at the solution, leaving
//    ~√tol position error), which is exactly the polyline-chain case.
//  - Distance form otherwise: |perpendicular distance| = r with the
//    side locked from the guess, or center distance = r1 ± r2 with
//    the internal/external branch locked from the guess. Locked
//    branches are the 2D preserveChirality — warm re-solves reuse the
//    compiled rows and cannot flip.
//
// Ellipse pairings (ellipse-geom.ts carries the math):
//
//  - line–ellipse: the support-function distance form — the center's
//    signed distance from the line equals the ellipse's half-width along
//    the line's normal, side locked from the guess — or, at a line
//    endpoint declared on the ellipse, the junction form (line direction
//    ⊥ ellipse normal there).
//  - arc–ellipse at a junction (an arc endpoint declared on the ellipse):
//    the arc's radius vector is parallel to the ellipse normal there.
//  - ellipse–circle/arc and ellipse–ellipse otherwise: no closed form
//    exists (the nearest point of an ellipse is a quartic), so the contact
//    point rides along as two compile-time aux params (CompileCtx.aux)
//    under three rows — on the first curve, on the second, normals
//    parallel — for one net DOF. External vs internal contact is the
//    basin the contact guess starts in: the boundary point of the ellipse
//    toward or away from the other center, whichever better satisfies the
//    other curve at compile time.

import type { ConstraintSpec, SolverRef } from '../types.js';
import type {
  CompiledRow,
  CompileCtx,
  ResolvedCircle,
  ResolvedEllipse,
  ResolvedLine,
  ResolvedPoint,
} from './types.js';
import { end, start } from '../types.js';
import {
  floorDist,
  guessSign,
  linePointSignedDist,
  makeLinePointDeriv,
  makePointDistDeriv,
  pointDist,
} from './util.js';
import {
  ellipseBoundaryPoint,
  ellipseNormal,
  ellipsePointResidual,
  ellipseSupport,
  makeEllipseNormalDeriv,
  makeEllipsePointDeriv,
  makeSupportDeriv,
  makeUnitCrossDeriv,
  unitCross,
  unitDot,
} from './ellipse-geom.js';

type Spec = Extract<ConstraintSpec, { kind: 'tangent' }>;

export function compileTangent(spec: Spec, ctx: CompileCtx): CompiledRow[] {
  if (ctx.isEllipse(spec.a) || ctx.isEllipse(spec.b)) {
    return compileEllipseTangent(spec, ctx);
  }
  const aLine = ctx.isLine(spec.a);
  const bLine = ctx.isLine(spec.b);
  if (aLine || bLine) {
    const lRef: SolverRef = aLine ? spec.a : spec.b;
    const cRef: SolverRef = aLine ? spec.b : spec.a;
    const l = ctx.line(lRef, 'tangent line');
    const c = ctx.circle(cRef, 'tangent circle/arc');
    const junction = lineJunction(ctx, cRef, l);
    if (junction) {
      return [linePointTangentRow(l, c, junction)];
    }
    return [lineDistanceTangentRow(ctx, l, c)];
  }
  const a = ctx.circle(spec.a, 'tangent first circle/arc');
  const b = ctx.circle(spec.b, 'tangent second circle/arc');
  const junction = circleJunction(ctx, spec.a, spec.b);
  if (junction) {
    return [circleJunctionTangentRow(a, b, junction)];
  }
  return [circleDistanceTangentRow(ctx, a, b)];
}

/** A tangency point pinned by user coincidents: a line endpoint
 * linked to an arc endpoint (the arc's point is used), or a line
 * endpoint declared on the circle/arc. Scan order is deterministic. */
function lineJunction(ctx: CompileCtx, cRef: SolverRef, l: ResolvedLine): ResolvedPoint | null {
  const lineEnds: ResolvedPoint[] = [
    { ix: l.sx, iy: l.sy },
    { ix: l.ex, iy: l.ey },
  ];
  if (ctx.kindOf(cRef.entity) === 'arc') {
    const arcEnds = [ctx.point(start(cRef.entity), 'arc'), ctx.point(end(cRef.entity), 'arc')];
    for (const le of lineEnds) {
      for (const ae of arcEnds) {
        if (ctx.arePointsLinked(le, ae)) {
          return ae;
        }
      }
    }
  }
  for (const le of lineEnds) {
    if (ctx.isPointOnEntity(le, cRef.entity)) {
      return le;
    }
  }
  return null;
}

/** dot(e−s, w−center)/|e−s| = 0 — radius ⊥ line at the junction. */
function linePointTangentRow(l: ResolvedLine, c: ResolvedCircle, w: ResolvedPoint): CompiledRow {
  return {
    params: [l.sx, l.sy, l.ex, l.ey, w.ix, w.iy, c.cx, c.cy],
    eval: (p) => {
      const ux = p[l.ex] - p[l.sx];
      const uy = p[l.ey] - p[l.sy];
      const vx = p[w.ix] - p[c.cx];
      const vy = p[w.iy] - p[c.cy];
      return (ux * vx + uy * vy) / floorDist(Math.hypot(ux, uy));
    },
    jac: (p, out) => {
      const ux = p[l.ex] - p[l.sx];
      const uy = p[l.ey] - p[l.sy];
      const vx = p[w.ix] - p[c.cx];
      const vy = p[w.iy] - p[c.cy];
      const d = floorDist(Math.hypot(ux, uy));
      const f = ux * vx + uy * vy;
      const d2 = d * d;
      out[0] = (-vx * d + f * (ux / d)) / d2;
      out[1] = (-vy * d + f * (uy / d)) / d2;
      out[2] = (vx * d - f * (ux / d)) / d2;
      out[3] = (vy * d - f * (uy / d)) / d2;
      out[4] = ux / d;
      out[5] = uy / d;
      out[6] = -ux / d;
      out[7] = -uy / d;
    },
  };
}

function lineDistanceTangentRow(ctx: CompileCtx, l: ResolvedLine, c: ResolvedCircle): CompiledRow {
  const d = makeLinePointDeriv();
  linePointSignedDist(ctx.guess, l, ctx.guess[c.cx], ctx.guess[c.cy], d);
  const side = guessSign(d.g);
  return {
    params: [l.sx, l.sy, l.ex, l.ey, c.cx, c.cy, c.r],
    eval: (p) => {
      linePointSignedDist(p, l, p[c.cx], p[c.cy], d);
      return d.g - side * p[c.r];
    },
    jac: (p, out) => {
      linePointSignedDist(p, l, p[c.cx], p[c.cy], d);
      out[0] = d.dSx;
      out[1] = d.dSy;
      out[2] = d.dEx;
      out[3] = d.dEy;
      out[4] = d.dWx;
      out[5] = d.dWy;
      out[6] = -side;
    },
  };
}

/** Shared point of two circle-likes: an arc endpoint of one linked to
 * an arc endpoint of the other, or declared on the other entity. */
function circleJunction(ctx: CompileCtx, aRef: SolverRef, bRef: SolverRef): ResolvedPoint | null {
  const aEnds = arcEnds(ctx, aRef);
  const bEnds = arcEnds(ctx, bRef);
  for (const ae of aEnds) {
    for (const be of bEnds) {
      if (ctx.arePointsLinked(ae, be)) {
        return ae;
      }
    }
  }
  for (const ae of aEnds) {
    if (ctx.isPointOnEntity(ae, bRef.entity)) {
      return ae;
    }
  }
  for (const be of bEnds) {
    if (ctx.isPointOnEntity(be, aRef.entity)) {
      return be;
    }
  }
  return null;
}

/** The endpoints of an arc ref; empty for full circles and ellipses. */
function arcEnds(ctx: CompileCtx, ref: SolverRef): ResolvedPoint[] {
  return ctx.kindOf(ref.entity) === 'arc'
    ? [ctx.point(start(ref.entity), 'arc'), ctx.point(end(ref.entity), 'arc')]
    : [];
}

/** cross(w−c1, w−c2)/(|w−c1|·|w−c2|) = 0 — centers collinear with
 * the junction (covers internal and external tangency; the guess
 * basin picks). */
function circleJunctionTangentRow(
  a: ResolvedCircle,
  b: ResolvedCircle,
  w: ResolvedPoint,
): CompiledRow {
  return {
    params: [w.ix, w.iy, a.cx, a.cy, b.cx, b.cy],
    eval: (p) => {
      const Ax = p[w.ix] - p[a.cx];
      const Ay = p[w.iy] - p[a.cy];
      const Bx = p[w.ix] - p[b.cx];
      const By = p[w.iy] - p[b.cy];
      return (Ax * By - Ay * Bx) / (floorDist(Math.hypot(Ax, Ay)) * floorDist(Math.hypot(Bx, By)));
    },
    jac: (p, out) => {
      const Ax = p[w.ix] - p[a.cx];
      const Ay = p[w.iy] - p[a.cy];
      const Bx = p[w.ix] - p[b.cx];
      const By = p[w.iy] - p[b.cy];
      const dA = floorDist(Math.hypot(Ax, Ay));
      const dB = floorDist(Math.hypot(Bx, By));
      const D = dA * dB;
      const f = Ax * By - Ay * Bx;
      const h = f / D;
      const tAx = (h * Ax) / (dA * dA);
      const tAy = (h * Ay) / (dA * dA);
      const tBx = (h * Bx) / (dB * dB);
      const tBy = (h * By) / (dB * dB);
      out[0] = (By - Ay) / D - tAx - tBx;
      out[1] = (Ax - Bx) / D - tAy - tBy;
      out[2] = -By / D + tAx;
      out[3] = Bx / D + tAy;
      out[4] = Ay / D + tBx;
      out[5] = -Ax / D + tBy;
    },
  };
}

function circleDistanceTangentRow(
  ctx: CompileCtx,
  a: ResolvedCircle,
  b: ResolvedCircle,
): CompiledRow {
  const pd = makePointDistDeriv();
  pointDist(ctx.guess, a.cx, a.cy, b.cx, b.cy, pd);
  const d0 = pd.d;
  const r1 = ctx.guess[a.r];
  const r2 = ctx.guess[b.r];
  const s = guessSign(r1 - r2);
  const externalErr = Math.abs(d0 - (r1 + r2));
  const internalErr = Math.abs(d0 - s * (r1 - r2));
  // (ca, cb) coefficients of (r1, r2) in D − (ca·r1 + cb·r2) = 0.
  const external = externalErr <= internalErr;
  const ca = external ? 1 : s;
  const cb = external ? 1 : -s;
  return {
    params: [a.cx, a.cy, b.cx, b.cy, a.r, b.r],
    eval: (p) => {
      pointDist(p, a.cx, a.cy, b.cx, b.cy, pd);
      return pd.d - (ca * p[a.r] + cb * p[b.r]);
    },
    jac: (p, out) => {
      pointDist(p, a.cx, a.cy, b.cx, b.cy, pd);
      out[0] = pd.dAx;
      out[1] = pd.dAy;
      out[2] = -pd.dAx;
      out[3] = -pd.dAy;
      out[4] = -ca;
      out[5] = -cb;
    },
  };
}

// -- ellipse pairings -------------------------------------------------------

function compileEllipseTangent(spec: Spec, ctx: CompileCtx): CompiledRow[] {
  if (ctx.isEllipse(spec.a) && ctx.isEllipse(spec.b)) {
    if (spec.a.entity === spec.b.entity) {
      throw new Error('tangent needs two different entities');
    }
    return ellipseEllipseContactRows(
      ctx,
      ctx.ellipse(spec.a, 'tangent first ellipse'),
      ctx.ellipse(spec.b, 'tangent second ellipse'),
    );
  }
  const eRef: SolverRef = ctx.isEllipse(spec.a) ? spec.a : spec.b;
  const oRef: SolverRef = ctx.isEllipse(spec.a) ? spec.b : spec.a;
  const e = ctx.ellipse(eRef, 'tangent ellipse');
  if (ctx.isLine(oRef)) {
    const l = ctx.line(oRef, 'tangent line');
    const lineEnds: ResolvedPoint[] = [
      { ix: l.sx, iy: l.sy },
      { ix: l.ex, iy: l.ey },
    ];
    for (const le of lineEnds) {
      if (ctx.isPointOnEntity(le, eRef.entity)) {
        return [lineEllipseJunctionRow(l, e, le)];
      }
    }
    return [lineEllipseDistanceRow(ctx, l, e)];
  }
  if (ctx.isCircle(oRef)) {
    const c = ctx.circle(oRef, 'tangent circle/arc');
    for (const ae of arcEnds(ctx, oRef)) {
      if (ctx.isPointOnEntity(ae, eRef.entity)) {
        return [arcEllipseJunctionRow(c, e, ae)];
      }
    }
    return ellipseCircleContactRows(ctx, e, c);
  }
  throw new Error('tangent with an ellipse needs a line, circle, arc or ellipse on the other side');
}

/**
 * Distance form: g − side·h(t̂) = 0 with g the center's signed distance
 * from the line (linePointSignedDist) and h the ellipse's half-width along
 * the line's normal (ellipseSupport). The side is locked from the guess;
 * a re-solve cannot cross the line.
 */
function lineEllipseDistanceRow(ctx: CompileCtx, l: ResolvedLine, e: ResolvedEllipse): CompiledRow {
  const d = makeLinePointDeriv();
  const sd = makeSupportDeriv();
  linePointSignedDist(ctx.guess, l, ctx.guess[e.cx], ctx.guess[e.cy], d);
  const side = guessSign(d.g);
  // Unit line direction and the support value for the current params.
  const evaluate = (p: Float64Array): { len: number; tx: number; ty: number } => {
    const ux = p[l.ex] - p[l.sx];
    const uy = p[l.ey] - p[l.sy];
    const len = floorDist(Math.hypot(ux, uy));
    const tx = ux / len;
    const ty = uy / len;
    linePointSignedDist(p, l, p[e.cx], p[e.cy], d);
    ellipseSupport(p, e, tx, ty, sd);
    return { len, tx, ty };
  };
  return {
    params: [l.sx, l.sy, l.ex, l.ey, e.cx, e.cy, e.th, e.rx, e.ry],
    eval: (p) => {
      evaluate(p);
      return d.g - side * sd.h;
    },
    jac: (p, out) => {
      const { len, tx, ty } = evaluate(p);
      // ∂h/∂L through the unit direction: (q − (q·t̂)t̂)/|L|, q = ∂h/∂t̂.
      const qt = sd.dTx * tx + sd.dTy * ty;
      const hLx = (sd.dTx - qt * tx) / len;
      const hLy = (sd.dTy - qt * ty) / len;
      out[0] = d.dSx + side * hLx;
      out[1] = d.dSy + side * hLy;
      out[2] = d.dEx - side * hLx;
      out[3] = d.dEy - side * hLy;
      out[4] = d.dWx;
      out[5] = d.dWy;
      out[6] = -side * sd.dTh;
      out[7] = -side * sd.dRx;
      out[8] = -side * sd.dRy;
    },
  };
}

/**
 * Junction form at a line endpoint w declared on the ellipse: the line
 * direction is perpendicular to the ellipse normal at w —
 * dot(e−s, N(w))/(|e−s|·|N|) = 0.
 */
function lineEllipseJunctionRow(l: ResolvedLine, e: ResolvedEllipse, w: ResolvedPoint): CompiledRow {
  const n = makeEllipseNormalDeriv();
  const ud = makeUnitCrossDeriv();
  const evaluate = (p: Float64Array): void => {
    ellipseNormal(p, e, p[w.ix], p[w.iy], n);
    unitDot(p[l.ex] - p[l.sx], p[l.ey] - p[l.sy], n.nx, n.ny, ud);
  };
  return {
    params: [l.sx, l.sy, l.ex, l.ey, w.ix, w.iy, e.cx, e.cy, e.th, e.rx, e.ry],
    eval: (p) => {
      evaluate(p);
      return ud.h;
    },
    jac: (p, out) => {
      evaluate(p);
      out[0] = -ud.d1x;
      out[1] = -ud.d1y;
      out[2] = ud.d1x;
      out[3] = ud.d1y;
      // ∂N/∂w = M = [[a, b], [b, d]]; ∂N/∂c = −M.
      const mx = ud.d2x * n.a + ud.d2y * n.b;
      const my = ud.d2x * n.b + ud.d2y * n.d;
      out[4] = mx;
      out[5] = my;
      out[6] = -mx;
      out[7] = -my;
      out[8] = ud.d2x * n.dNxTh + ud.d2y * n.dNyTh;
      out[9] = ud.d2x * n.dNxRx + ud.d2y * n.dNyRx;
      out[10] = ud.d2x * n.dNxRy + ud.d2y * n.dNyRy;
    },
  };
}

/**
 * Junction form at an arc endpoint w declared on the ellipse: the arc's
 * radius vector w − C is parallel to the ellipse normal at w —
 * cross(w−C, N(w))/(|w−C|·|N|) = 0. Internal and external contact alike.
 */
function arcEllipseJunctionRow(c: ResolvedCircle, e: ResolvedEllipse, w: ResolvedPoint): CompiledRow {
  const n = makeEllipseNormalDeriv();
  const uc = makeUnitCrossDeriv();
  const evaluate = (p: Float64Array): void => {
    ellipseNormal(p, e, p[w.ix], p[w.iy], n);
    unitCross(p[w.ix] - p[c.cx], p[w.iy] - p[c.cy], n.nx, n.ny, uc);
  };
  return {
    params: [w.ix, w.iy, c.cx, c.cy, e.cx, e.cy, e.th, e.rx, e.ry],
    eval: (p) => {
      evaluate(p);
      return uc.h;
    },
    jac: (p, out) => {
      evaluate(p);
      const mx = uc.d2x * n.a + uc.d2y * n.b;
      const my = uc.d2x * n.b + uc.d2y * n.d;
      out[0] = uc.d1x + mx;
      out[1] = uc.d1y + my;
      out[2] = -uc.d1x;
      out[3] = -uc.d1y;
      out[4] = -mx;
      out[5] = -my;
      out[6] = uc.d2x * n.dNxTh + uc.d2y * n.dNyTh;
      out[7] = uc.d2x * n.dNxRx + uc.d2y * n.dNyRx;
      out[8] = uc.d2x * n.dNxRy + uc.d2y * n.dNyRy;
    },
  };
}

/** The point of the ellipse where the contact search starts: its
 * boundary point toward or away from the other center, whichever the
 * `misfit` of the other curve rates closer. Coincident centers fall back
 * to the RX axis. */
function contactGuess(
  ctx: CompileCtx,
  e: ResolvedEllipse,
  otherCx: number,
  otherCy: number,
  misfit: (px: number, py: number) => number,
): [number, number] {
  const p = ctx.guess;
  let dx = otherCx - p[e.cx];
  let dy = otherCy - p[e.cy];
  const len = Math.hypot(dx, dy);
  if (len < 1e-9) {
    dx = Math.cos(p[e.th]);
    dy = Math.sin(p[e.th]);
  } else {
    dx /= len;
    dy /= len;
  }
  const toward = ellipseBoundaryPoint(p, e, dx, dy);
  const away = ellipseBoundaryPoint(p, e, -dx, -dy);
  return Math.abs(misfit(toward[0], toward[1])) <= Math.abs(misfit(away[0], away[1])) ? toward : away;
}

/** P on the ellipse: one row over the contact params and the pose. */
function contactOnEllipseRow(e: ResolvedEllipse, px: number, py: number): CompiledRow {
  const d = makeEllipsePointDeriv();
  return {
    params: [px, py, e.cx, e.cy, e.th, e.rx, e.ry],
    eval: (p) => {
      ellipsePointResidual(p, e, p[px], p[py], d);
      return d.r;
    },
    jac: (p, out) => {
      ellipsePointResidual(p, e, p[px], p[py], d);
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
 * Ellipse–circle/arc contact: aux P on the ellipse, on the circle, with
 * the ellipse normal at P parallel to the circle's radius vector P − C.
 */
function ellipseCircleContactRows(ctx: CompileCtx, e: ResolvedEllipse, c: ResolvedCircle): CompiledRow[] {
  const g = ctx.guess;
  const [gx, gy] = contactGuess(
    ctx,
    e,
    g[c.cx],
    g[c.cy],
    (px, py) => Math.hypot(px - g[c.cx], py - g[c.cy]) - Math.abs(g[c.r]),
  );
  const [px, py] = ctx.aux([gx, gy]);
  const pd = makePointDistDeriv();
  const onCircle: CompiledRow = {
    params: [px, py, c.cx, c.cy, c.r],
    eval: (p) => {
      pointDist(p, px, py, c.cx, c.cy, pd);
      return pd.d - p[c.r];
    },
    jac: (p, out) => {
      pointDist(p, px, py, c.cx, c.cy, pd);
      out[0] = pd.dAx;
      out[1] = pd.dAy;
      out[2] = -pd.dAx;
      out[3] = -pd.dAy;
      out[4] = -1;
    },
  };
  const n = makeEllipseNormalDeriv();
  const uc = makeUnitCrossDeriv();
  const evaluate = (p: Float64Array): void => {
    ellipseNormal(p, e, p[px], p[py], n);
    unitCross(n.nx, n.ny, p[px] - p[c.cx], p[py] - p[c.cy], uc);
  };
  const normals: CompiledRow = {
    params: [px, py, e.cx, e.cy, e.th, c.cx, c.cy, e.rx, e.ry],
    eval: (p) => {
      evaluate(p);
      return uc.h;
    },
    jac: (p, out) => {
      evaluate(p);
      const mx = uc.d1x * n.a + uc.d1y * n.b;
      const my = uc.d1x * n.b + uc.d1y * n.d;
      out[0] = mx + uc.d2x;
      out[1] = my + uc.d2y;
      out[2] = -mx;
      out[3] = -my;
      out[4] = uc.d1x * n.dNxTh + uc.d1y * n.dNyTh;
      out[5] = -uc.d2x;
      out[6] = -uc.d2y;
      out[7] = uc.d1x * n.dNxRx + uc.d1y * n.dNyRx;
      out[8] = uc.d1x * n.dNxRy + uc.d1y * n.dNyRy;
    },
  };
  return [contactOnEllipseRow(e, px, py), onCircle, normals];
}

/**
 * Ellipse–ellipse contact: aux P on both ellipses with parallel normals.
 * The contact guess starts on the first ellipse, toward or away from the
 * second's center by the second's on-curve misfit.
 */
function ellipseEllipseContactRows(ctx: CompileCtx, a: ResolvedEllipse, b: ResolvedEllipse): CompiledRow[] {
  const g = ctx.guess;
  const probe = makeEllipsePointDeriv();
  const [gx, gy] = contactGuess(ctx, a, g[b.cx], g[b.cy], (px, py) => {
    ellipsePointResidual(g, b, px, py, probe);
    return probe.r;
  });
  const [px, py] = ctx.aux([gx, gy]);
  const na = makeEllipseNormalDeriv();
  const nb = makeEllipseNormalDeriv();
  const uc = makeUnitCrossDeriv();
  const evaluate = (p: Float64Array): void => {
    ellipseNormal(p, a, p[px], p[py], na);
    ellipseNormal(p, b, p[px], p[py], nb);
    unitCross(na.nx, na.ny, nb.nx, nb.ny, uc);
  };
  const normals: CompiledRow = {
    params: [px, py, a.cx, a.cy, a.th, b.cx, b.cy, b.th, a.rx, a.ry, b.rx, b.ry],
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
  return [contactOnEllipseRow(a, px, py), contactOnEllipseRow(b, px, py), normals];
}
