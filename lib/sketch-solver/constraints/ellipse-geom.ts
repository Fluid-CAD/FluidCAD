// Shared ellipse math for the constraint modules. An ellipse entity is
// [cx, cy, rx, ry, θ]: u = (cos θ, sin θ) carries RX, v = (−sin θ, cos θ)
// carries RY. All five params are free (the radii are dimensioned like a
// circle's, with radius(el, v, 'x' | 'y')), so every helper here returns
// partials for the pose AND the radii.
//
// Every denominator is floored (util EPS discipline): a point at the
// center, a collapsed radius or a collapsed normal yields
// garbage-but-finite rows for the LM driver to absorb; nothing may NaN.

import type { ResolvedEllipse } from './types.js';
import { EPS, floorDist } from './util.js';

/** A radius param kept away from zero but with its sign — the rows are
 * even in the radii, the partials odd, so the sign must survive for the
 * analytic Jacobian to match a finite difference. */
function safeRadius(v: number): number {
  return Math.abs(v) > EPS ? v : v < 0 ? -EPS : EPS;
}

/**
 * The on-curve residual of a point against the ellipse and its partials:
 * R = F/|∇F| with F = (x'/rx)² + (y'/ry)² − 1 in the ellipse frame. R is
 * the first-order distance of the point from the curve (exact on it, in
 * length units like every other on-curve row) and, unlike F itself, has
 * a unit-norm gradient at the solution — so rank reads angles, not radii.
 * `dPx`/`dPy` are ∂R/∂point; the center's partials are their negatives.
 */
export type EllipsePointDeriv = {
  r: number;
  dPx: number;
  dPy: number;
  dTh: number;
  dRx: number;
  dRy: number;
};

export function makeEllipsePointDeriv(): EllipsePointDeriv {
  return { r: 0, dPx: 0, dPy: 0, dTh: 0, dRx: 0, dRy: 0 };
}

export function ellipsePointResidual(
  p: Float64Array,
  e: ResolvedEllipse,
  px: number,
  py: number,
  out: EllipsePointDeriv,
): void {
  const rx = safeRadius(p[e.rx]);
  const ry = safeRadius(p[e.ry]);
  const th = p[e.th];
  const c = Math.cos(th);
  const s = Math.sin(th);
  const dx = px - p[e.cx];
  const dy = py - p[e.cy];
  const xp = dx * c + dy * s;
  const yp = -dx * s + dy * c;
  const rx2 = rx * rx;
  const ry2 = ry * ry;
  const ax = 2 / rx2;
  const ay = 2 / ry2;
  const gx = ax * xp;
  const gy = ay * yp;
  const f = (xp * xp) / rx2 + (yp * yp) / ry2 - 1;
  const g = floorDist(Math.hypot(gx, gy));
  const g2 = g * g;
  const r = f / g;
  // ∂R/∂x' = (gx·G − F·∂G/∂x')/G², ∂G/∂x' = gx·ax/G (and likewise y').
  const rxp = (gx * g - f * ((gx * ax) / g)) / g2;
  const ryp = (gy * g - f * ((gy * ay) / g)) / g2;
  out.r = r;
  // x' = dx·c + dy·s, y' = −dx·s + dy·c.
  out.dPx = rxp * c - ryp * s;
  out.dPy = rxp * s + ryp * c;
  // ∂x'/∂θ = y', ∂y'/∂θ = −x'.
  out.dTh = rxp * yp - ryp * xp;
  // Radii: ∂F/∂rx = −2x'²/rx³, ∂gx/∂rx = −4x'/rx³, ∂G/∂rx = gx·∂gx/∂rx / G.
  const dFrx = (-2 * xp * xp) / (rx2 * rx);
  const dGrx = (gx * ((-4 * xp) / (rx2 * rx))) / g;
  out.dRx = (dFrx * g - f * dGrx) / g2;
  const dFry = (-2 * yp * yp) / (ry2 * ry);
  const dGry = (gy * ((-4 * yp) / (ry2 * ry))) / g;
  out.dRy = (dFry * g - f * dGry) / g2;
}

/**
 * The (unnormalized) world-space normal of the ellipse's implicit
 * function at a point, N = M(θ)·(P − c) with M = Rot(θ)·diag(2/rx², 2/ry²)·
 * Rot(−θ) — symmetric, [[a, b], [b, d]] — and its partials: ∂N/∂P = M,
 * ∂N/∂c = −M, ∂N/∂θ = (dNxTh, dNyTh), ∂N/∂rx = (dNxRx, dNyRx), ∂N/∂ry =
 * (dNxRy, dNyRy). Used by the tangency rows that align this normal with
 * another curve's.
 */
export type EllipseNormalDeriv = {
  nx: number;
  ny: number;
  a: number;
  b: number;
  d: number;
  dNxTh: number;
  dNyTh: number;
  dNxRx: number;
  dNyRx: number;
  dNxRy: number;
  dNyRy: number;
};

export function makeEllipseNormalDeriv(): EllipseNormalDeriv {
  return {
    nx: 0, ny: 0, a: 0, b: 0, d: 0,
    dNxTh: 0, dNyTh: 0, dNxRx: 0, dNyRx: 0, dNxRy: 0, dNyRy: 0,
  };
}

export function ellipseNormal(
  p: Float64Array,
  e: ResolvedEllipse,
  px: number,
  py: number,
  out: EllipseNormalDeriv,
): void {
  const rx = safeRadius(p[e.rx]);
  const ry = safeRadius(p[e.ry]);
  const th = p[e.th];
  const c = Math.cos(th);
  const s = Math.sin(th);
  const A = 2 / (rx * rx);
  const B = 2 / (ry * ry);
  const a = A * c * c + B * s * s;
  const d = A * s * s + B * c * c;
  const b = (A - B) * c * s;
  const dx = px - p[e.cx];
  const dy = py - p[e.cy];
  out.nx = a * dx + b * dy;
  out.ny = b * dx + d * dy;
  out.a = a;
  out.b = b;
  out.d = d;
  const daTh = 2 * c * s * (B - A);
  const ddTh = 2 * c * s * (A - B);
  const dbTh = (A - B) * (c * c - s * s);
  out.dNxTh = daTh * dx + dbTh * dy;
  out.dNyTh = dbTh * dx + ddTh * dy;
  // ∂A/∂rx = −4/rx³ enters a, d, b through c², s², cs; ∂B/∂ry likewise
  // with the roles of c² and s² swapped and b's sign flipped.
  const dA = -4 / (rx * rx * rx);
  out.dNxRx = dA * (c * c * dx + c * s * dy);
  out.dNyRx = dA * (c * s * dx + s * s * dy);
  const dB = -4 / (ry * ry * ry);
  out.dNxRy = dB * (s * s * dx - c * s * dy);
  out.dNyRy = dB * (-c * s * dx + c * c * dy);
}

/**
 * h = cross(n1, n2)/(|n1|·|n2|) — the sine of the angle between two
 * direction vectors — with partials for the four components. Zero when
 * the directions are parallel OR anti-parallel, which is exactly the
 * tangency condition on two curve normals (external and internal contact
 * alike; the guess basin picks).
 */
export type UnitCrossDeriv = {
  h: number;
  d1x: number;
  d1y: number;
  d2x: number;
  d2y: number;
};

export function makeUnitCrossDeriv(): UnitCrossDeriv {
  return { h: 0, d1x: 0, d1y: 0, d2x: 0, d2y: 0 };
}

export function unitCross(
  n1x: number,
  n1y: number,
  n2x: number,
  n2y: number,
  out: UnitCrossDeriv,
): void {
  const l1 = floorDist(Math.hypot(n1x, n1y));
  const l2 = floorDist(Math.hypot(n2x, n2y));
  const D = l1 * l2;
  const f = n1x * n2y - n1y * n2x;
  const h = f / D;
  out.h = h;
  out.d1x = n2y / D - (h * n1x) / (l1 * l1);
  out.d1y = -n2x / D - (h * n1y) / (l1 * l1);
  out.d2x = -n1y / D - (h * n2x) / (l2 * l2);
  out.d2y = n1x / D - (h * n2y) / (l2 * l2);
}

/**
 * g = dot(n1, n2)/(|n1|·|n2|) — the cosine of the angle between two
 * direction vectors — with partials. Zero when they are perpendicular:
 * a line direction against a curve normal at the junction.
 */
export type UnitDotDeriv = UnitCrossDeriv;

export function unitDot(
  n1x: number,
  n1y: number,
  n2x: number,
  n2y: number,
  out: UnitDotDeriv,
): void {
  const l1 = floorDist(Math.hypot(n1x, n1y));
  const l2 = floorDist(Math.hypot(n2x, n2y));
  const D = l1 * l2;
  const f = n1x * n2x + n1y * n2y;
  const g = f / D;
  out.h = g;
  out.d1x = n2x / D - (g * n1x) / (l1 * l1);
  out.d1y = n2y / D - (g * n1y) / (l1 * l1);
  out.d2x = n1x / D - (g * n2x) / (l2 * l2);
  out.d2y = n1y / D - (g * n2y) / (l2 * l2);
}

/**
 * The point where the ray from the ellipse's center along the unit
 * direction (dx, dy) leaves the ellipse — the contact-point guess for
 * the aux-param tangency forms.
 */
export function ellipseBoundaryPoint(
  p: Float64Array,
  e: ResolvedEllipse,
  dx: number,
  dy: number,
): [number, number] {
  const rx = floorDist(Math.abs(p[e.rx]));
  const ry = floorDist(Math.abs(p[e.ry]));
  const th = p[e.th];
  const c = Math.cos(th);
  const s = Math.sin(th);
  const along = dx * c + dy * s;
  const across = -dx * s + dy * c;
  const k = 1 / floorDist(Math.hypot(along / rx, across / ry));
  return [p[e.cx] + k * dx, p[e.cy] + k * dy];
}

/**
 * Half-width of the ellipse measured along a unit normal n, i.e. the
 * support function h(n) = √((rx·(n·u))² + (ry·(n·v))²): the distance from
 * the center at which a line with that normal is tangent. With the line
 * DIRECTION t (n = perp(t)): n·u = cross(t, u), n·v = dot(t, u). Returns h
 * and its partials w.r.t. θ, the radii and the (unit) direction components.
 */
export type SupportDeriv = {
  h: number;
  dTh: number;
  dRx: number;
  dRy: number;
  dTx: number;
  dTy: number;
};

export function makeSupportDeriv(): SupportDeriv {
  return { h: 0, dTh: 0, dRx: 0, dRy: 0, dTx: 0, dTy: 0 };
}

export function ellipseSupport(
  p: Float64Array,
  e: ResolvedEllipse,
  tx: number,
  ty: number,
  out: SupportDeriv,
): void {
  const rx = p[e.rx];
  const ry = p[e.ry];
  const th = p[e.th];
  const ux = Math.cos(th);
  const uy = Math.sin(th);
  const A = tx * uy - ty * ux; // cross(t, u) = n·u
  const B = tx * ux + ty * uy; // dot(t, u) = n·v
  const h = floorDist(Math.hypot(rx * A, ry * B));
  const dA = (rx * rx * A) / h;
  const dB = (ry * ry * B) / h;
  out.h = h;
  // ∂u/∂θ = v: ∂A/∂θ = cross(t, v) = B, ∂B/∂θ = dot(t, v) = −A.
  out.dTh = dA * B - dB * A;
  out.dRx = (rx * A * A) / h;
  out.dRy = (ry * B * B) / h;
  out.dTx = dA * uy + dB * ux;
  out.dTy = -dA * ux + dB * uy;
}
