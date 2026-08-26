// Shared residual math for the constraint modules. Every denominator
// is floored at EPS so degenerate configurations (zero-length lines,
// coincident tangency points) produce garbage-but-finite rows — the
// LM driver's λ escalation and singular outcome absorb those; nothing
// may NaN or hang.

import type { ResolvedLine } from './types.js';

export const EPS = 1e-12;

export function floorDist(d: number): number {
  return d > EPS ? d : EPS;
}

/** Wrap an angle to (−π, π]. */
export function wrapToPi(a: number): number {
  const twoPi = 2 * Math.PI;
  let r = (a + Math.PI) % twoPi;
  if (r <= 0) {
    r += twoPi;
  }
  return r - Math.PI;
}

/** Deterministic branch sign from a guess value: +1 for v ≥ 0. */
export function guessSign(v: number): number {
  return v >= 0 ? 1 : -1;
}

/**
 * Signed distance of point w from the infinite line s→e:
 * g = cross(e−s, w−s)/|e−s|, positive with w left of the direction.
 * Partials for the four line params and the two w values (chain dWx/
 * dWy onto whatever params w derives from).
 */
export type LinePointDeriv = {
  g: number;
  dSx: number;
  dSy: number;
  dEx: number;
  dEy: number;
  dWx: number;
  dWy: number;
};

export function linePointSignedDist(
  p: Float64Array,
  l: ResolvedLine,
  wx: number,
  wy: number,
  out: LinePointDeriv,
): void {
  const sx = p[l.sx];
  const sy = p[l.sy];
  const ux = p[l.ex] - sx;
  const uy = p[l.ey] - sy;
  const wpx = wx - sx;
  const wpy = wy - sy;
  const d = floorDist(Math.hypot(ux, uy));
  const cr = ux * wpy - uy * wpx;
  const d2 = d * d;
  out.g = cr / d;
  out.dSx = ((uy - wpy) * d + cr * (ux / d)) / d2;
  out.dSy = ((wpx - ux) * d + cr * (uy / d)) / d2;
  out.dEx = (wpy * d - cr * (ux / d)) / d2;
  out.dEy = (-wpx * d - cr * (uy / d)) / d2;
  out.dWx = -uy / d;
  out.dWy = ux / d;
}

export function makeLinePointDeriv(): LinePointDeriv {
  return { g: 0, dSx: 0, dSy: 0, dEx: 0, dEy: 0, dWx: 0, dWy: 0 };
}

/**
 * Distance |a−b| with partials. The value is the true distance; only
 * partial denominators are floored.
 */
export type PointDistDeriv = {
  d: number;
  dAx: number;
  dAy: number;
};

export function pointDist(
  p: Float64Array,
  aix: number,
  aiy: number,
  bix: number,
  biy: number,
  out: PointDistDeriv,
): void {
  const dx = p[aix] - p[bix];
  const dy = p[aiy] - p[biy];
  const d = Math.hypot(dx, dy);
  const df = floorDist(d);
  out.d = d;
  out.dAx = dx / df;
  out.dAy = dy / df;
  // ∂/∂b = −∂/∂a; callers negate.
}

export function makePointDistDeriv(): PointDistDeriv {
  return { d: 0, dAx: 0, dAy: 0 };
}

/**
 * Direction-pair values for two lines: u1, u2, lengths, raw cross and
 * dot. Shared by parallel/perpendicular/angle.
 */
export type DirPair = {
  u1x: number;
  u1y: number;
  u2x: number;
  u2y: number;
  d1: number;
  d2: number;
  cross: number;
  dot: number;
};

export function dirPair(p: Float64Array, a: ResolvedLine, b: ResolvedLine, out: DirPair): void {
  out.u1x = p[a.ex] - p[a.sx];
  out.u1y = p[a.ey] - p[a.sy];
  out.u2x = p[b.ex] - p[b.sx];
  out.u2y = p[b.ey] - p[b.sy];
  out.d1 = floorDist(Math.hypot(out.u1x, out.u1y));
  out.d2 = floorDist(Math.hypot(out.u2x, out.u2y));
  out.cross = out.u1x * out.u2y - out.u1y * out.u2x;
  out.dot = out.u1x * out.u2x + out.u1y * out.u2y;
}

export function makeDirPair(): DirPair {
  return { u1x: 0, u1y: 0, u2x: 0, u2y: 0, d1: 0, d2: 0, cross: 0, dot: 0 };
}

/**
 * Partials of h = f/(d1·d2) into out[0..7] for params ordered
 * [s1x, s1y, e1x, e1y, s2x, s2y, e2x, e2y], given ∂f for the same
 * ordering. h·∂d/d terms fold in the length sensitivities.
 */
export function normalizedPairJac(dp: DirPair, h: number, df: number[], out: Float64Array): void {
  const D = dp.d1 * dp.d2;
  const t1x = (h * dp.u1x) / (dp.d1 * dp.d1);
  const t1y = (h * dp.u1y) / (dp.d1 * dp.d1);
  const t2x = (h * dp.u2x) / (dp.d2 * dp.d2);
  const t2y = (h * dp.u2y) / (dp.d2 * dp.d2);
  out[0] = df[0] / D + t1x;
  out[1] = df[1] / D + t1y;
  out[2] = df[2] / D - t1x;
  out[3] = df[3] / D - t1y;
  out[4] = df[4] / D + t2x;
  out[5] = df[5] / D + t2y;
  out[6] = df[6] / D - t2x;
  out[7] = df[7] / D - t2y;
}

/** ∂cross(u1,u2) for [s1x, s1y, e1x, e1y, s2x, s2y, e2x, e2y]. */
export function crossPartials(dp: DirPair, out: number[]): void {
  out[0] = -dp.u2y;
  out[1] = dp.u2x;
  out[2] = dp.u2y;
  out[3] = -dp.u2x;
  out[4] = dp.u1y;
  out[5] = -dp.u1x;
  out[6] = -dp.u1y;
  out[7] = dp.u1x;
}

/** ∂dot(u1,u2) for the same ordering. */
export function dotPartials(dp: DirPair, out: number[]): void {
  out[0] = -dp.u2x;
  out[1] = -dp.u2y;
  out[2] = dp.u2x;
  out[3] = dp.u2y;
  out[4] = -dp.u1x;
  out[5] = -dp.u1y;
  out[6] = dp.u1x;
  out[7] = dp.u1y;
}

/** The 8 line-pair params in the ordering the partial helpers use. */
export function linePairParams(a: ResolvedLine, b: ResolvedLine): number[] {
  return [a.sx, a.sy, a.ex, a.ey, b.sx, b.sy, b.ex, b.ey];
}

/** Ordinal for variadic-constraint error messages ('first', 'second', …). */
export function ordinal(i: number): string {
  const names = ['first', 'second', 'third', 'fourth', 'fifth', 'sixth', 'seventh', 'eighth'];
  return names[i] ?? `${i + 1}th`;
}
