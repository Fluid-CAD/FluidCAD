// tangent — line–circle/arc or circle–circle.
//
// Two formulations per pairing:
//
//  - Junction form, used when a user coincident statement pins a
//    tangency point (line endpoint ↔ arc endpoint, or endpoint on the
//    other circle): perpendicularity of the radius at the junction
//    (line case) / center–junction collinearity (circle case). The
//    residual is linear in the drift along the curve — the distance
//    form is quadratic there (rank-deficient at the solution, leaving
//    ~√tol position error), which is exactly the polyline-chain case.
//  - Distance form otherwise: |perpendicular distance| = r with the
//    side locked from the guess, or center distance = r1 ± r2 with
//    the internal/external branch locked from the guess. Locked
//    branches are the 2D preserveChirality — warm re-solves reuse the
//    compiled rows and cannot flip.

import type { ConstraintSpec, SolverRef } from '../types.js';
import type { CompiledRow, CompileCtx, ResolvedCircle, ResolvedLine, ResolvedPoint } from './types.js';
import { end, start } from '../types.js';
import {
  floorDist,
  guessSign,
  linePointSignedDist,
  makeLinePointDeriv,
  makePointDistDeriv,
  pointDist,
} from './util.js';

type Spec = Extract<ConstraintSpec, { kind: 'tangent' }>;

export function compileTangent(spec: Spec, ctx: CompileCtx): CompiledRow[] {
  const aLine = ctx.isLine(spec.a);
  const bLine = ctx.isLine(spec.b);
  if (aLine || bLine) {
    const lRef: SolverRef = aLine ? spec.a : spec.b;
    const cRef: SolverRef = aLine ? spec.b : spec.a;
    const l = ctx.line(lRef, 'tangent line');
    const c = ctx.circle(cRef, 'tangent circle/arc');
    const junction = lineJunction(ctx, lRef, cRef, l);
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
function lineJunction(
  ctx: CompileCtx,
  lRef: SolverRef,
  cRef: SolverRef,
  l: ResolvedLine,
): ResolvedPoint | null {
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
  const endsOf = (ref: SolverRef): ResolvedPoint[] =>
    ctx.kindOf(ref.entity) === 'arc'
      ? [ctx.point(start(ref.entity), 'arc'), ctx.point(end(ref.entity), 'arc')]
      : [];
  const aEnds = endsOf(aRef);
  const bEnds = endsOf(bRef);
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
