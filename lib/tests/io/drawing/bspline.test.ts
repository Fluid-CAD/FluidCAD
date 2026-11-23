import { describe, it, expect } from "vitest";
import { BSplineCurve2D } from "../../../io/drawing/bspline.js";
import type { Curve2D } from "../../../io/drawing/drawing.js";

type BSpline = Extract<Curve2D, { kind: 'bspline' }>;

const TOL = 1e-5;

describe("BSplineCurve2D", () => {
  it("flattens the kernel's knots and multiplicities", () => {
    expect(BSplineCurve2D.flattenKnots([0, 0.5, 1], [4, 2, 4])).toEqual([0, 0, 0, 0, 0.5, 0.5, 1, 1, 1, 1]);
    expect(() => BSplineCurve2D.flattenKnots([0, 1], [2])).toThrow();
  });

  it("says why a curve's data is not a clamped NURBS", () => {
    const ok: BSpline = { kind: 'bspline', degree: 2, knots: [0, 0, 0, 1, 1, 1], poles: [{ x: 0, y: 0 }, { x: 1, y: 1 }, { x: 2, y: 0 }] };
    expect(BSplineCurve2D.invalidReason(ok)).toBeNull();
    expect(BSplineCurve2D.invalidReason({ ...ok, knots: [0, 0, 1, 1] })).toMatch(/knots/);
    expect(BSplineCurve2D.invalidReason({ ...ok, knots: [0, 0, 0, 1, 0.5, 1] })).toMatch(/decrease/);
    expect(BSplineCurve2D.invalidReason({ ...ok, weights: [1, 1] })).toMatch(/weights/);
    expect(BSplineCurve2D.invalidReason({ ...ok, weights: [1, 0, 1] })).toMatch(/positive/);
    expect(BSplineCurve2D.invalidReason({ ...ok, degree: 3 })).toMatch(/poles/);
  });

  it("evaluates a quadratic Bezier at its closed form", () => {
    const curve: BSpline = { kind: 'bspline', degree: 2, knots: [0, 0, 0, 1, 1, 1], poles: [{ x: 0, y: 0 }, { x: 2, y: 4 }, { x: 6, y: 0 }] };
    for (const t of [0, 0.25, 0.5, 0.8, 1]) {
      const p = BSplineCurve2D.evaluate(curve, t);
      expect(p.x).toBeCloseTo(2 * t * (1 - t) * 2 + t * t * 6, 12);
      expect(p.y).toBeCloseTo(2 * t * (1 - t) * 4, 12);
    }
  });

  it("evaluates on a domain that is not [0, 1] and clamps outside it", () => {
    const curve: BSpline = { kind: 'bspline', degree: 1, knots: [2, 2, 3, 5, 5], poles: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 20 }] };
    expect(BSplineCurve2D.domain(curve)).toEqual([2, 5]);
    expect(BSplineCurve2D.evaluate(curve, 2.5)).toEqual({ x: 5, y: 0 });
    expect(BSplineCurve2D.evaluate(curve, 4)).toEqual({ x: 10, y: 10 });
    expect(BSplineCurve2D.evaluate(curve, 5)).toEqual({ x: 10, y: 20 });
    expect(BSplineCurve2D.evaluate(curve, 99)).toEqual({ x: 10, y: 20 });
    expect(BSplineCurve2D.evaluate(curve, -1)).toEqual({ x: 0, y: 0 });
  });

  it("keeps a rational quarter circle on its circle", () => {
    const curve: BSpline = {
      kind: 'bspline',
      degree: 2,
      knots: [0, 0, 0, 1, 1, 1],
      poles: [{ x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }],
      weights: [1, Math.SQRT1_2, 1],
    };
    for (const p of BSplineCurve2D.sample(curve, 16)) {
      expect(Math.hypot(p.x, p.y)).toBeCloseTo(10, 12);
    }
  });

  it("joins the spans of a multi-span cubic continuously and ends on its end poles", () => {
    const curve: BSpline = {
      kind: 'bspline',
      degree: 3,
      knots: [0, 0, 0, 0, 1, 2, 3, 3, 3, 3],
      poles: [{ x: 0, y: 0 }, { x: 1, y: 3 }, { x: 4, y: 5 }, { x: 7, y: 1 }, { x: 9, y: 4 }, { x: 12, y: 0 }],
    };
    expect(BSplineCurve2D.evaluate(curve, 0)).toEqual({ x: 0, y: 0 });
    expect(BSplineCurve2D.evaluate(curve, 3)).toEqual({ x: 12, y: 0 });
    for (const knot of [1, 2]) {
      const before = BSplineCurve2D.evaluate(curve, knot - 1e-9);
      const after = BSplineCurve2D.evaluate(curve, knot + 1e-9);
      expect(Math.hypot(before.x - after.x, before.y - after.y)).toBeLessThan(1e-7);
    }
  });

  describe("collinearExtent", () => {
    it("is null for a real curve", () => {
      const curve: BSpline = { kind: 'bspline', degree: 2, knots: [0, 0, 0, 1, 1, 1], poles: [{ x: 0, y: 0 }, { x: 2, y: 4 }, { x: 6, y: 0 }] };
      expect(BSplineCurve2D.collinearExtent(curve, TOL)).toBeNull();
    });

    it("is the segment between the ends for poles in a row", () => {
      const curve: BSpline = { kind: 'bspline', degree: 2, knots: [0, 0, 0, 1, 1, 1], poles: [{ x: 1, y: 1 }, { x: 3, y: 2 }, { x: 9, y: 5 }] };
      const extent = BSplineCurve2D.collinearExtent(curve, TOL);
      expect(extent).not.toBeNull();
      expect(extent).not.toBe('point');
      if (extent && extent !== 'point') {
        const ends = [extent.a, extent.b].sort((p, q) => p.x - q.x);
        expect(ends[0].x).toBeCloseTo(1, 10);
        expect(ends[0].y).toBeCloseTo(1, 10);
        expect(ends[1].x).toBeCloseTo(9, 10);
        expect(ends[1].y).toBeCloseTo(5, 10);
      }
    });

    it("reaches the turning point of a curve that doubles back", () => {
      // x(t) = 20t(1 − t) + 4t² turns at t = 0.625, x = 6.25 — past its end at x = 4
      // and short of its middle pole at x = 10.
      const curve: BSpline = { kind: 'bspline', degree: 2, knots: [0, 0, 0, 1, 1, 1], poles: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 4, y: 0 }] };
      const extent = BSplineCurve2D.collinearExtent(curve, TOL);
      expect(extent).not.toBe('point');
      if (extent && extent !== 'point') {
        const xs = [extent.a.x, extent.b.x].sort((p, q) => p - q);
        expect(xs[0]).toBeCloseTo(0, 9);
        expect(xs[1]).toBeCloseTo(6.25, 9);
      }
    });

    it("is a point for poles all in one spot", () => {
      const curve: BSpline = { kind: 'bspline', degree: 1, knots: [0, 0, 1, 1], poles: [{ x: 2, y: 2 }, { x: 2 + 1e-7, y: 2 }] };
      expect(BSplineCurve2D.collinearExtent(curve, TOL)).toBe('point');
    });
  });
  describe("toCubic", () => {
    /** A degree-5 curve of three spans — the shape of the kernel's intersection curves. */
    const quintic: BSpline = {
      kind: 'bspline',
      degree: 5,
      knots: [0, 0, 0, 0, 0, 0, 1, 2.5, 4, 4, 4, 4, 4, 4],
      poles: [
        { x: 0, y: 0 }, { x: 2, y: 5 }, { x: 5, y: 7 }, { x: 9, y: 6 },
        { x: 11, y: 1 }, { x: 14, y: -3 }, { x: 18, y: 0 }, { x: 20, y: 4 },
      ],
    };

    /** The largest distance between two curves on the same domain, at equal parameters. */
    function deviation(a: BSpline, b: BSpline): number {
      const [t0, t1] = BSplineCurve2D.domain(a);
      let worst = 0;
      for (let i = 0; i <= 4000; i++) {
        const t = t0 + ((t1 - t0) * i) / 4000;
        const p = BSplineCurve2D.evaluate(a, t);
        const q = BSplineCurve2D.evaluate(b, t);
        worst = Math.max(worst, Math.hypot(p.x - q.x, p.y - q.y));
      }
      return worst;
    }

    it("leaves a non-rational curve of degree three or less as it is", () => {
      const cubic: BSpline = { kind: 'bspline', degree: 3, knots: [0, 0, 0, 0, 1, 1, 1, 1], poles: [{ x: 0, y: 0 }, { x: 1, y: 2 }, { x: 3, y: 2 }, { x: 4, y: 0 }] };
      expect(BSplineCurve2D.toCubic(cubic, TOL)).toBe(cubic);
    });

    it.each([1e-3, 1e-5, 1e-7])("stays within %f of a quintic, on the same domain and through its ends", (tolerance) => {
      const cubic = BSplineCurve2D.toCubic(quintic, tolerance);
      expect(cubic.degree).toBe(3);
      expect(cubic.weights).toBeUndefined();
      expect(BSplineCurve2D.invalidReason(cubic)).toBeNull();
      expect(BSplineCurve2D.domain(cubic)).toEqual(BSplineCurve2D.domain(quintic));
      expect(cubic.poles[0]).toEqual(quintic.poles[0]);
      expect(cubic.poles.at(-1)).toEqual(quintic.poles.at(-1));
      expect(deviation(quintic, cubic)).toBeLessThanOrEqual(tolerance);
    });

    it("needs more pieces for a tighter tolerance", () => {
      expect(BSplineCurve2D.toCubic(quintic, 1e-7).poles.length).toBeGreaterThan(BSplineCurve2D.toCubic(quintic, 1e-3).poles.length);
    });

    it("joins smooth pieces with double knots: the cubic keeps the curve's tangent continuity", () => {
      const cubic = BSplineCurve2D.toCubic(quintic, 1e-5);
      const [t0, t1] = BSplineCurve2D.domain(cubic);
      const inner = cubic.knots.filter((knot) => knot > t0 && knot < t1);
      const multiplicity = new Map<number, number>();
      for (const knot of inner) {
        multiplicity.set(knot, (multiplicity.get(knot) ?? 0) + 1);
      }
      expect([...multiplicity.values()].every((m) => m === 2)).toBe(true);
      // Every breakpoint of the curve is one of the cubic's.
      expect(multiplicity.has(1)).toBe(true);
      expect(multiplicity.has(2.5)).toBe(true);
    });

    it("keeps a corner: a triple knot with the corner point as a pole", () => {
      // Two straight-ish quartic pieces meeting at (4, 4) with a kink (the knot's multiplicity is the degree).
      const kinked: BSpline = {
        kind: 'bspline',
        degree: 4,
        knots: [0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 2],
        poles: [
          { x: 0, y: 0 }, { x: 1, y: 2 }, { x: 2, y: 3 }, { x: 3, y: 3.5 }, { x: 4, y: 4 },
          { x: 5, y: 3 }, { x: 6, y: 1 }, { x: 7, y: 0.5 }, { x: 8, y: 0 },
        ],
      };
      const cubic = BSplineCurve2D.toCubic(kinked, 1e-6);
      expect(cubic.knots.filter((knot) => knot === 1)).toHaveLength(3);
      expect(cubic.poles.some((pole) => Math.hypot(pole.x - 4, pole.y - 4) < 1e-12)).toBe(true);
      expect(deviation(kinked, cubic)).toBeLessThanOrEqual(1e-6);
    });

    it("turns a rational curve into a plain cubic on the same circle", () => {
      const w = Math.SQRT1_2;
      const quarter: BSpline = {
        kind: 'bspline',
        degree: 2,
        knots: [0, 0, 0, 1, 1, 1],
        poles: [{ x: 5, y: 0 }, { x: 5, y: 5 }, { x: 0, y: 5 }],
        weights: [1, w, 1],
      };
      const cubic = BSplineCurve2D.toCubic(quarter, 1e-6);
      expect(cubic.weights).toBeUndefined();
      expect(deviation(quarter, cubic)).toBeLessThanOrEqual(1e-6);
      for (const point of BSplineCurve2D.sample(cubic, 64)) {
        expect(Math.hypot(point.x, point.y)).toBeCloseTo(5, 5);
      }
    });
  });

  describe("evaluateSpan", () => {
    it("gives the point evaluate gives, and the slope of the curve there", () => {
      const curve: BSpline = {
        kind: 'bspline',
        degree: 3,
        knots: [0, 0, 0, 0, 1, 2, 3, 3, 3, 3],
        poles: [{ x: 0, y: 0 }, { x: 1, y: 3 }, { x: 4, y: 5 }, { x: 7, y: 1 }, { x: 9, y: 4 }, { x: 12, y: 0 }],
        weights: [1, 2, 0.5, 1, 3, 1],
      };
      const h = 1e-6;
      for (const [span, t] of [[3, 0.4], [4, 1.5], [5, 2.9]] as const) {
        const { point, derivative } = BSplineCurve2D.evaluateSpan(curve, span, t);
        const here = BSplineCurve2D.evaluate(curve, t);
        expect(point.x).toBeCloseTo(here.x, 12);
        expect(point.y).toBeCloseTo(here.y, 12);
        const ahead = BSplineCurve2D.evaluate(curve, t + h);
        const behind = BSplineCurve2D.evaluate(curve, t - h);
        expect(derivative.x).toBeCloseTo((ahead.x - behind.x) / (2 * h), 5);
        expect(derivative.y).toBeCloseTo((ahead.y - behind.y) / (2 * h), 5);
      }
    });
  });
});
