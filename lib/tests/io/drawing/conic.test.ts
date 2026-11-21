import { describe, it, expect } from "vitest";
import { Conic } from "../../../io/drawing/conic.js";
import { Curves } from "../../../io/drawing/drawing.js";
import type { Curve2D, Vec2 } from "../../../io/drawing/drawing.js";

const TOL = 1e-5;
const TWO_PI = 2 * Math.PI;

/** The point of `c + cos t·u + sin t·v`. */
function at(c: Vec2, u: Vec2, v: Vec2, t: number): Vec2 {
  return { x: c.x + Math.cos(t) * u.x + Math.sin(t) * v.x, y: c.y + Math.cos(t) * u.y + Math.sin(t) * v.y };
}

function distance(p: Vec2, q: Vec2): number {
  return Math.hypot(p.x - q.x, p.y - q.y);
}

/**
 * The result traces the same points as the input parametrisation: sampled
 * evenly on both, start to end, or — the result always runs counter-clockwise
 * — end to start.
 */
function expectSameTrace(curve: Curve2D, c: Vec2, u: Vec2, v: Vec2, t0: number, t1: number): void {
  const n = 24;
  const expected = Array.from({ length: n + 1 }, (_, i) => at(c, u, v, t0 + ((t1 - t0) * i) / n));
  const actual = Curves.sample(curve, n);
  const forward = Math.max(...expected.map((p, i) => distance(p, actual[i])));
  const backward = Math.max(...expected.map((p, i) => distance(p, actual[n - i])));
  expect(Math.min(forward, backward)).toBeLessThan(1e-9);
}

describe("Conic.fromConjugateDiameters", () => {
  const c = { x: 3, y: -2 };

  it("gives a circle for a circle seen square-on", () => {
    const curve = Conic.fromConjugateDiameters(c, { x: 5, y: 0 }, { x: 0, y: 5 }, 0, TWO_PI, TOL);
    expect(curve).toEqual({ kind: 'circle', center: c, radius: 5 });
  });

  it("gives a circle whatever direction the parameter starts in", () => {
    const u = { x: 5 * Math.cos(0.7), y: 5 * Math.sin(0.7) };
    const v = { x: -5 * Math.sin(0.7), y: 5 * Math.cos(0.7) };
    const curve = Conic.fromConjugateDiameters(c, u, v, 1.2, 1.2 + TWO_PI, TOL)!;
    expect(curve.kind).toBe('circle');
  });

  it("gives a counter-clockwise arc for part of a circle", () => {
    const u = { x: 5, y: 0 };
    const v = { x: 0, y: 5 };
    const curve = Conic.fromConjugateDiameters(c, u, v, 0.5, 2, TOL)!;
    expect(curve.kind).toBe('arc');
    if (curve.kind === 'arc') {
      expect(curve.start).toBeCloseTo(0.5, 12);
      expect(curve.end).toBeCloseTo(2, 12);
    }
    expectSameTrace(curve, c, u, v, 0.5, 2);
  });

  it("turns a clockwise run into the counter-clockwise arc over the same points", () => {
    // Seen from behind: v is mirrored, so increasing t runs clockwise.
    const u = { x: 5, y: 0 };
    const v = { x: 0, y: -5 };
    const curve = Conic.fromConjugateDiameters(c, u, v, 0.5, 2, TOL)!;
    expect(curve.kind).toBe('arc');
    if (curve.kind === 'arc') {
      expect(curve.end).toBeGreaterThan(curve.start);
      expect(curve.start).toBeCloseTo(TWO_PI - 2, 12);
      expect(curve.end - curve.start).toBeCloseTo(1.5, 12);
    }
    expectSameTrace(curve, c, u, v, 0.5, 2);
  });

  it("keeps an arc across the zero angle in one piece", () => {
    const u = { x: 5, y: 0 };
    const v = { x: 0, y: 5 };
    const curve = Conic.fromConjugateDiameters(c, u, v, 5.5, 7, TOL)!;
    expect(curve.kind).toBe('arc');
    if (curve.kind === 'arc') {
      expect(curve.start).toBeCloseTo(5.5, 12);
      expect(curve.end).toBeCloseTo(7, 12);
    }
  });

  it("gives the closed-form ellipse for a tilted circle", () => {
    // A circle of radius 5 tilted 60° about the drawing's X axis.
    const tilt = Math.PI / 3;
    const u = { x: 5, y: 0 };
    const v = { x: 0, y: 5 * Math.cos(tilt) };
    const curve = Conic.fromConjugateDiameters(c, u, v, 0, TWO_PI, TOL)!;
    expect(curve.kind).toBe('ellipse');
    if (curve.kind === 'ellipse') {
      expect(Math.hypot(curve.major.x, curve.major.y)).toBeCloseTo(5, 12);
      expect(Math.abs(curve.major.y)).toBeLessThan(1e-12);
      expect(curve.ratio).toBeCloseTo(Math.cos(tilt), 12);
      expect(curve.start).toBe(0);
      expect(curve.end).toBe(TWO_PI);
    }
  });

  it("finds the principal axes of conjugate diameters that are not perpendicular", () => {
    // Semi-axes 4 and 2, rotated 30°, parametrised from a diameter 50° round.
    const rotation = Math.PI / 6;
    const delta = (50 * Math.PI) / 180;
    const major = { x: 4 * Math.cos(rotation), y: 4 * Math.sin(rotation) };
    const minor = { x: -2 * Math.sin(rotation), y: 2 * Math.cos(rotation) };
    const u = { x: Math.cos(delta) * major.x + Math.sin(delta) * minor.x, y: Math.cos(delta) * major.y + Math.sin(delta) * minor.y };
    const v = { x: -Math.sin(delta) * major.x + Math.cos(delta) * minor.x, y: -Math.sin(delta) * major.y + Math.cos(delta) * minor.y };
    const curve = Conic.fromConjugateDiameters(c, u, v, 0.3, 2.9, TOL)!;
    expect(curve.kind).toBe('ellipse');
    if (curve.kind === 'ellipse') {
      expect(Math.hypot(curve.major.x, curve.major.y)).toBeCloseTo(4, 10);
      expect(curve.ratio).toBeCloseTo(0.5, 10);
      // The major axis is the 30° line, either way round.
      expect(Math.abs(curve.major.x * Math.sin(rotation) - curve.major.y * Math.cos(rotation))).toBeLessThan(1e-10);
      expect(curve.end - curve.start).toBeCloseTo(2.6, 12);
    }
    expectSameTrace(curve, c, u, v, 0.3, 2.9);
  });

  it("remaps the range of a mirrored (clockwise) ellipse arc", () => {
    const u = { x: 4, y: 1 };
    const v = { x: 1, y: -2 };
    const curve = Conic.fromConjugateDiameters(c, u, v, 1, 4.5, TOL)!;
    expect(curve.kind).toBe('ellipse');
    expectSameTrace(curve, c, u, v, 1, 4.5);
  });

  it("folds an edge-on circle onto a segment", () => {
    // Edge-on: both projected axes lie along one direction.
    const direction = { x: Math.cos(0.4), y: Math.sin(0.4) };
    const u = { x: 5 * direction.x, y: 5 * direction.y };
    const v = { x: 0, y: 0 };
    const curve = Conic.fromConjugateDiameters(c, u, v, 0, TWO_PI, TOL)!;
    expect(curve.kind).toBe('line');
    if (curve.kind === 'line') {
      expect(distance(curve.a, curve.b)).toBeCloseTo(10, 12);
      expect(distance(curve.a, { x: c.x - u.x, y: c.y - u.y })).toBeLessThan(1e-12);
      expect(distance(curve.b, { x: c.x + u.x, y: c.y + u.y })).toBeLessThan(1e-12);
    }
  });

  it("reaches the fold's turning point when it lies inside the arc", () => {
    // An edge-on arc from 60° to 200° passes through 180°, its far left:
    // the segment ends there, not at the arc's own end point.
    const u = { x: 5, y: 0 };
    const v = { x: 0, y: 0 };
    const t0 = Math.PI / 3;
    const t1 = (200 * Math.PI) / 180;
    const curve = Conic.fromConjugateDiameters(c, u, v, t0, t1, TOL)!;
    expect(curve.kind).toBe('line');
    if (curve.kind === 'line') {
      expect(curve.a.x).toBeCloseTo(c.x - 5, 12);
      expect(curve.b.x).toBeCloseTo(c.x + 5 * Math.cos(t0), 12);
    }
  });

  it("stops short of the turning point when the arc does", () => {
    const curve = Conic.fromConjugateDiameters(c, { x: 5, y: 0 }, { x: 0, y: 0 }, 0.2, 1.2, TOL)!;
    expect(curve.kind).toBe('line');
    if (curve.kind === 'line') {
      expect(curve.a.x).toBeCloseTo(c.x + 5 * Math.cos(1.2), 12);
      expect(curve.b.x).toBeCloseTo(c.x + 5 * Math.cos(0.2), 12);
    }
  });

  it("gives nothing for a curve that collapses to a point", () => {
    expect(Conic.fromConjugateDiameters(c, { x: 1e-7, y: 0 }, { x: 0, y: 1e-7 }, 0, TWO_PI, TOL)).toBeNull();
    expect(Conic.fromConjugateDiameters(c, { x: 5, y: 0 }, { x: 0, y: 5 }, 1, 1, TOL)).toBeNull();
  });
});
