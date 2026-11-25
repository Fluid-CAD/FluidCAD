// Geometry of the elliptical arc entity, shared by everything that has to
// turn its params into a curve: the kernel's edge builder, the statement
// layer's guesses, and the UI's tessellation, hit testing and tools. Pure
// math on plain numbers, like the rest of this directory.
//
// An elliptical arc is [cx, cy, rx, ry, θ, sx, sy, ex, ey]: a piece of the
// ellipse with semi-radii rx / ry along its own axes u = (cos θ, sin θ) and
// v = (−sin θ, cos θ), running from the start point to the end point. A
// point of the ellipse is named by its PARAMETER t (the eccentric angle):
// P(t) = c + rx·cos t·u + ry·sin t·v. It is not the polar angle of the
// point as seen from the center unless rx = ry.

const TWO_PI = 2 * Math.PI;

/** The ellipse an elliptical arc lies on; θ in radians. */
export type EllipseFrame = {
  cx: number;
  cy: number;
  rx: number;
  ry: number;
  theta: number;
};

/** An elliptical arc as its ellipse and the parameters it runs between:
 * from `startParam` through `sweep` radians, positive counter-clockwise
 * (toward growing t), negative clockwise, never zero. */
export type EllipseArcSpan = EllipseFrame & {
  startParam: number;
  sweep: number;
};

/** Ends closer than this (as a parameter gap, radians) read as one point:
 * the arc is the whole ellipse, never a zero-length sliver. */
const FULL_TURN_PARAM_TOL = 1e-9;

/** The point of the ellipse at parameter `t`. */
export function ellipsePointAt(e: EllipseFrame, t: number): [number, number] {
  const c = Math.cos(e.theta);
  const s = Math.sin(e.theta);
  const xp = e.rx * Math.cos(t);
  const yp = e.ry * Math.sin(t);
  return [e.cx + xp * c - yp * s, e.cy + xp * s + yp * c];
}

/**
 * The parameter of the ellipse point a position names, in (−π, π]: the
 * position is read in the ellipse's own frame and scaled onto the unit
 * circle. A position off the ellipse names the point on the same scaled
 * ray, which is how a rounded or dragged end is read; the center itself
 * names parameter 0.
 */
export function ellipseParamOf(e: EllipseFrame, x: number, y: number): number {
  const c = Math.cos(e.theta);
  const s = Math.sin(e.theta);
  const dx = x - e.cx;
  const dy = y - e.cy;
  const xp = (dx * c + dy * s) / nonZero(e.rx);
  const yp = (-dx * s + dy * c) / nonZero(e.ry);
  if (xp === 0 && yp === 0) {
    return 0;
  }
  return Math.atan2(yp, xp);
}

/** The ellipse point a position names (see {@link ellipseParamOf}). */
export function projectOntoEllipse(e: EllipseFrame, x: number, y: number): [number, number] {
  return ellipsePointAt(e, ellipseParamOf(e, x, y));
}

/**
 * The signed sweep from parameter `from` to parameter `to` on the chosen
 * side: counter-clockwise in (0, 2π], clockwise in [−2π, 0). Equal
 * parameters are a full turn.
 */
export function ellipseSweep(from: number, to: number, clockwise: boolean): number {
  let sweep = clockwise ? from - to : to - from;
  sweep %= TWO_PI;
  if (sweep < 0) {
    sweep += TWO_PI;
  }
  if (sweep < FULL_TURN_PARAM_TOL || TWO_PI - sweep < FULL_TURN_PARAM_TOL) {
    sweep = TWO_PI;
  }
  return clockwise ? -sweep : sweep;
}

/** The span of the arc from `start` to `end` on the chosen side. */
export function ellipseArcSpan(
  e: EllipseFrame,
  start: readonly [number, number],
  end: readonly [number, number],
  clockwise: boolean,
): EllipseArcSpan {
  const startParam = ellipseParamOf(e, start[0], start[1]);
  const endParam = ellipseParamOf(e, end[0], end[1]);
  return { ...e, startParam, sweep: ellipseSweep(startParam, endParam, clockwise) };
}

/** The point a fraction `u` (0 at the start, 1 at the end) along the arc. */
export function ellipseArcPointAt(span: EllipseArcSpan, u: number): [number, number] {
  return ellipsePointAt(span, span.startParam + u * span.sweep);
}

/** `segments + 1` points along the arc, both ends included. */
export function sampleEllipseArc(span: EllipseArcSpan, segments: number): [number, number][] {
  const points: [number, number][] = [];
  for (let i = 0; i <= segments; i++) {
    points.push(ellipseArcPointAt(span, i / segments));
  }
  return points;
}

/**
 * Whether parameter `t` falls on the arc, with `slack` radians of give at
 * each end (0 for a strict read).
 */
export function ellipseArcContainsParam(span: EllipseArcSpan, t: number, slack = 0): boolean {
  if (Math.abs(span.sweep) >= TWO_PI - FULL_TURN_PARAM_TOL) {
    return true;
  }
  // Travel from the start in the arc's own direction, in [0, 2π).
  let travel = (span.sweep > 0 ? t - span.startParam : span.startParam - t) % TWO_PI;
  if (travel < 0) {
    travel += TWO_PI;
  }
  const length = Math.abs(span.sweep);
  return travel <= length + slack || travel >= TWO_PI - slack;
}

function nonZero(v: number): number {
  return Math.abs(v) > 1e-12 ? v : v < 0 ? -1e-12 : 1e-12;
}
