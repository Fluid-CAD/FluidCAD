import { describe, it, expect } from "vitest";
import {
  interpolateBSpline2d,
  interpolateWithDerivatives,
  BSplineCurveData,
  XY,
} from "../../math/bspline-interpolation.js";

/** Evaluates the B-spline at t via Cox–de Boor (independent of OCC). */
function evaluate(data: ReturnType<typeof interpolateBSpline2d>, t: number): XY {
  const flat: number[] = [];
  for (let i = 0; i < data.knots.length; i++) {
    for (let m = 0; m < data.multiplicities[i]; m++) {
      flat.push(data.knots[i]);
    }
  }
  const p = data.degree;
  const n = data.poles.length - 1;
  let span = n;
  if (t < flat[n + 1]) {
    let low = p;
    let high = n + 1;
    let mid = (low + high) >> 1;
    while (t < flat[mid] || t >= flat[mid + 1]) {
      if (t < flat[mid]) {
        high = mid;
      } else {
        low = mid;
      }
      mid = (low + high) >> 1;
    }
    span = mid;
  }
  const values = [1];
  const left: number[] = [];
  const right: number[] = [];
  for (let j = 1; j <= p; j++) {
    left[j] = t - flat[span + 1 - j];
    right[j] = flat[span + j] - t;
    let saved = 0;
    for (let r = 0; r < j; r++) {
      const temp = values[r] / (right[r + 1] + left[j - r]);
      values[r] = saved + right[r + 1] * temp;
      saved = left[j - r] * temp;
    }
    values[j] = saved;
  }
  let x = 0;
  let y = 0;
  for (let j = 0; j <= p; j++) {
    x += values[j] * data.poles[span - p + j].x;
    y += values[j] * data.poles[span - p + j].y;
  }
  return { x, y };
}

function chordParams(points: XY[]): number[] {
  const params = [0];
  for (let i = 1; i < points.length; i++) {
    params.push(params[i - 1] + Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y));
  }
  return params.map(v => v / params[params.length - 1]);
}

describe("interpolateBSpline2d", () => {
  it("passes exactly through every input point", () => {
    const points = [
      { x: 0, y: 0 }, { x: 1, y: 2 }, { x: 2.5, y: 1.5 },
      { x: 4, y: 3 }, { x: 5, y: 0.5 }, { x: 7, y: 1 },
    ];
    const data = interpolateBSpline2d(points);
    const params = chordParams(points);
    for (let i = 0; i < points.length; i++) {
      const q = evaluate(data, params[i]);
      expect(q.x).toBeCloseTo(points[i].x, 9);
      expect(q.y).toBeCloseTo(points[i].y, 9);
    }
  });

  it("stays close to a semicircle between samples", () => {
    const points: XY[] = [];
    for (let i = 0; i <= 48; i++) {
      const a = (Math.PI * i) / 48;
      points.push({ x: 5 * Math.cos(a), y: 5 * Math.sin(a) });
    }
    const data = interpolateBSpline2d(points);
    // Dense evaluation must stay on the circle (radius 5) and inside x ∈ [-5, 5].
    let maxRadiusError = 0;
    let maxAbsX = 0;
    for (let i = 0; i <= 1000; i++) {
      const q = evaluate(data, i / 1000);
      maxRadiusError = Math.max(maxRadiusError, Math.abs(Math.hypot(q.x, q.y) - 5));
      maxAbsX = Math.max(maxAbsX, Math.abs(q.x));
    }
    expect(maxRadiusError).toBeLessThan(1e-4);
    expect(maxAbsX).toBeLessThan(5.0001);
  });

  it("reproduces a straight line exactly", () => {
    const points = [{ x: 0, y: 0 }, { x: 1, y: 1 }, { x: 2, y: 2 }, { x: 5, y: 5 }];
    const data = interpolateBSpline2d(points);
    for (let i = 0; i <= 100; i++) {
      const q = evaluate(data, i / 100);
      expect(q.y).toBeCloseTo(q.x, 9);
    }
  });

  it("handles two and three points with reduced degree", () => {
    const line = interpolateBSpline2d([{ x: 0, y: 0 }, { x: 2, y: 1 }]);
    expect(line.degree).toBe(1);
    const mid = evaluate(line, 0.5);
    expect(mid.x).toBeCloseTo(1, 9);
    expect(mid.y).toBeCloseTo(0.5, 9);

    const three = interpolateBSpline2d([{ x: 0, y: 0 }, { x: 1, y: 1 }, { x: 2, y: 0 }]);
    expect(three.degree).toBe(2);
    const params = chordParams([{ x: 0, y: 0 }, { x: 1, y: 1 }, { x: 2, y: 0 }]);
    const q = evaluate(three, params[1]);
    expect(q.x).toBeCloseTo(1, 9);
    expect(q.y).toBeCloseTo(1, 9);
  });

  it("drops duplicate consecutive points instead of going singular", () => {
    const points = [
      { x: 0, y: 0 }, { x: 1, y: 1 }, { x: 1, y: 1 },
      { x: 2, y: 0 }, { x: 3, y: 1 },
    ];
    const data = interpolateBSpline2d(points);
    expect(data.poles.length).toBe(4);
  });
});

/** Evaluates an N-dimensional B-spline at t via Cox–de Boor. */
function evaluateNd(data: BSplineCurveData, t: number): number[] {
  const flat: number[] = [];
  for (let i = 0; i < data.knots.length; i++) {
    for (let m = 0; m < data.multiplicities[i]; m++) {
      flat.push(data.knots[i]);
    }
  }
  const asXY = {
    poles: data.poles.map(p => ({ x: p[0], y: p.length > 1 ? p[1] : 0 })),
    knots: data.knots,
    multiplicities: data.multiplicities,
    degree: data.degree,
  };
  // Reuse the 2D evaluator per dimension pair to keep this helper simple.
  const result: number[] = [];
  const dimension = data.poles[0].length;
  for (let d = 0; d < dimension; d += 2) {
    const pair = {
      ...asXY,
      poles: data.poles.map(p => ({ x: p[d], y: d + 1 < dimension ? p[d + 1] : 0 })),
    };
    const q = evaluate(pair, t);
    result.push(q.x);
    if (d + 1 < dimension) {
      result.push(q.y);
    }
  }
  return result;
}

/** Central-difference derivative of the curve at t. */
function numericDerivative(data: BSplineCurveData, t: number): number[] {
  const h = 1e-7;
  const t0 = Math.max(data.knots[0], t - h);
  const t1 = Math.min(data.knots[data.knots.length - 1], t + h);
  const a = evaluateNd(data, t0);
  const b = evaluateNd(data, t1);
  return a.map((v, d) => (b[d] - v) / (t1 - t0));
}

describe("interpolateWithDerivatives", () => {
  const points = [
    [0, 0, 0],
    [1, 2, 1],
    [3, 1, 2],
    [4, 4, 3],
  ];
  const params = [0, 0.3, 0.7, 1];

  it("passes through every point with both end derivatives constrained", () => {
    const data = interpolateWithDerivatives(points, params, [0, 0, 5], [5, 0, 0]);
    expect(data.degree).toBe(3);
    expect(data.poles.length).toBe(points.length + 2);
    for (let k = 0; k < points.length; k++) {
      const q = evaluateNd(data, params[k]);
      for (let d = 0; d < 3; d++) {
        expect(q[d]).toBeCloseTo(points[k][d], 9);
      }
    }
  });

  it("matches the requested end derivatives", () => {
    const startD = [0, 0, 5];
    const endD = [5, 0, 0];
    const data = interpolateWithDerivatives(points, params, startD, endD);
    const atStart = numericDerivative(data, 0);
    const atEnd = numericDerivative(data, 1);
    for (let d = 0; d < 3; d++) {
      expect(atStart[d]).toBeCloseTo(startD[d], 4);
      expect(atEnd[d]).toBeCloseTo(endD[d], 4);
    }
  });

  it("supports a single constrained end", () => {
    const startD = [0, 0, 4];
    const data = interpolateWithDerivatives(points, params, startD, undefined);
    expect(data.poles.length).toBe(points.length + 1);
    for (let k = 0; k < points.length; k++) {
      const q = evaluateNd(data, params[k]);
      for (let d = 0; d < 3; d++) {
        expect(q[d]).toBeCloseTo(points[k][d], 9);
      }
    }
    const atStart = numericDerivative(data, 0);
    for (let d = 0; d < 3; d++) {
      expect(atStart[d]).toBeCloseTo(startD[d], 4);
    }
  });

  it("reproduces a cubic Hermite segment for two points with derivatives", () => {
    const data = interpolateWithDerivatives(
      [[0, 0, 0], [1, 0, 0]],
      [0, 1],
      [0, 1, 0],
      [0, -1, 0],
    );
    expect(data.degree).toBe(3);
    expect(data.poles.length).toBe(4);
    // Bézier form of the Hermite segment: P1 = P0 + D0/3, P2 = P3 - D1/3.
    expect(data.poles[1][1]).toBeCloseTo(1 / 3, 9);
    expect(data.poles[2][1]).toBeCloseTo(1 / 3, 9);
  });

  it("rejects non-increasing parameters", () => {
    expect(() => interpolateWithDerivatives(
      [[0, 0], [1, 1], [2, 2]],
      [0, 0.5, 0.5],
    )).toThrow(/strictly increasing/);
  });
});
