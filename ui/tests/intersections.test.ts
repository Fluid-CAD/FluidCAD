import { describe, it, expect } from 'vitest';
import { curveIntersections, entityIntersections, type Curve } from '../src/sketch-solver-client/intersections';
import { angleWithinSweep } from '../src/sketch-solver-client/tessellate';
import type { SolvedBezierView, SolvedEntityView, SolvedSketchModel } from '../src/sketch-solver-client/model';

// Sketch-local crossings between solved entities — the Trim tool's cut
// points. Analytic for lines, arcs and circles; through a fine polyline for
// ellipses and beziers; never at the target's own ends.

type V2 = [number, number];

const near = (a: V2, b: V2, tol = 1e-6): void => {
  expect(Math.abs(a[0] - b[0])).toBeLessThan(tol);
  expect(Math.abs(a[1] - b[1])).toBeLessThan(tol);
};

const sortByX = (points: V2[]): V2[] => [...points].sort((a, b) => a[0] - b[0] || a[1] - b[1]);

function lineView(entityId: number, start: V2, end: V2): SolvedEntityView {
  return { entityId, kind: 'line', start, end } as SolvedEntityView;
}

function circleView(entityId: number, center: V2, radius: number): SolvedEntityView {
  return { entityId, kind: 'circle', center, radius } as SolvedEntityView;
}

function arcView(entityId: number, start: V2, end: V2, center: V2, cw: boolean): SolvedEntityView {
  const radius = Math.hypot(start[0] - center[0], start[1] - center[1]);
  return { entityId, kind: 'arc', start, end, center, radius, cw } as SolvedEntityView;
}

function makeModel(entities: SolvedEntityView[], beziers: SolvedBezierView[] = []): SolvedSketchModel {
  return {
    entities: new Map(entities.map(e => [e.entityId, e])),
    beziers: new Map(beziers.map((b, i) => [`b${i}`, b])),
    constraints: [],
    hasDatums: true,
  } as unknown as SolvedSketchModel;
}

describe('angleWithinSweep', () => {
  it('contains the drawn side of an arc, both ways round, and every angle of a full turn', () => {
    // Counter-clockwise quarter from 0 to π/2.
    expect(angleWithinSweep(0, Math.PI / 2, Math.PI / 4)).toBe(true);
    expect(angleWithinSweep(0, Math.PI / 2, -Math.PI / 4)).toBe(false);
    expect(angleWithinSweep(0, Math.PI / 2, -1e-12)).toBe(true);
    expect(angleWithinSweep(0, Math.PI / 2, Math.PI / 2 + 1e-12)).toBe(true);
    // Clockwise three quarters from 0 down to π/2 (through the bottom).
    expect(angleWithinSweep(0, -1.5 * Math.PI, -Math.PI / 2)).toBe(true);
    expect(angleWithinSweep(0, -1.5 * Math.PI, Math.PI / 4)).toBe(false);
    expect(angleWithinSweep(0, -1.5 * Math.PI, 1e-12)).toBe(true);
    expect(angleWithinSweep(1, 2 * Math.PI, 4)).toBe(true);
    expect(angleWithinSweep(1, -2 * Math.PI, 4)).toBe(true);
  });
});

describe('curveIntersections', () => {
  const seg = (a: V2, b: V2): Curve => ({ kind: 'segment', a, b });
  const circle = (center: V2, radius: number): Curve => ({ kind: 'circle', center, radius });

  it('crosses two segments once and lets a touching end count', () => {
    const [p] = curveIntersections(seg([0, 0], [10, 10]), seg([0, 10], [10, 0]));
    near(p, [5, 5]);
    const [touch] = curveIntersections(seg([0, 0], [10, 0]), seg([4, 0], [4, 7]));
    near(touch, [4, 0]);
    expect(curveIntersections(seg([0, 0], [10, 0]), seg([12, -1], [12, 1]))).toEqual([]);
    expect(curveIntersections(seg([0, 0], [10, 0]), seg([0, 1], [10, 1]))).toEqual([]);
  });

  it('meets collinear segments at the ends that overlap', () => {
    const points = sortByX(curveIntersections(seg([0, 0], [10, 0]), seg([6, 0], [20, 0])));
    expect(points).toHaveLength(2);
    near(points[0], [6, 0]);
    near(points[1], [10, 0]);
  });

  it('crosses a segment and a circle twice, once at a tangency, never when apart', () => {
    const points = sortByX(curveIntersections(seg([-20, 0], [20, 0]), circle([0, 0], 10)));
    expect(points).toHaveLength(2);
    near(points[0], [-10, 0]);
    near(points[1], [10, 0]);
    const [tangency] = curveIntersections(seg([-20, 10], [20, 10]), circle([0, 0], 10));
    near(tangency, [0, 10]);
    expect(curveIntersections(seg([-20, 11], [20, 11]), circle([0, 0], 10))).toEqual([]);
    expect(curveIntersections(seg([-20, 0], [-15, 0]), circle([0, 0], 10))).toEqual([]);
  });

  it('keeps only the crossings on an arc\'s drawn side', () => {
    const upper: Curve = { kind: 'circle', center: [0, 0], radius: 10, arc: { a0: 0, sweep: Math.PI } };
    const [p] = curveIntersections(seg([0, -20], [0, 20]), upper);
    near(p, [0, 10]);
    expect(curveIntersections(seg([0, -20], [0, 20]), upper)).toHaveLength(1);
  });

  it('crosses two circles twice, once at a tangency, never when apart or concentric', () => {
    const points = sortByX(curveIntersections(circle([0, 0], 10), circle([10, 0], 10)));
    expect(points).toHaveLength(2);
    near(points[0], [5, -Math.sqrt(75)]);
    near(points[1], [5, Math.sqrt(75)]);
    const [tangency] = curveIntersections(circle([0, 0], 10), circle([15, 0], 5));
    near(tangency, [10, 0]);
    expect(curveIntersections(circle([0, 0], 10), circle([30, 0], 5))).toEqual([]);
    expect(curveIntersections(circle([0, 0], 10), circle([0, 0], 5))).toEqual([]);
  });

  it('walks a polyline segment by segment', () => {
    const poly: Curve = { kind: 'polyline', points: [[0, -5], [5, 5], [10, -5]] };
    const points = sortByX(curveIntersections(seg([0, 0], [10, 0]), poly));
    expect(points).toHaveLength(2);
    near(points[0], [2.5, 0]);
    near(points[1], [7.5, 0]);
  });
});

describe('entityIntersections', () => {
  it('finds the crossings of the other entities, deduplicated, and skips the target\'s own ends', () => {
    // A 40-long bottom edge: the left and right edges meet it at its ends
    // (corners, not crossings); a vertical crosses it at 10; two lines
    // meet it at the same point 30.
    const bottom = lineView(1, [0, 0], [40, 0]);
    const model = makeModel([
      bottom,
      lineView(2, [0, 0], [0, 20]),
      lineView(3, [40, 0], [40, 20]),
      lineView(4, [10, -5], [10, 5]),
      lineView(5, [30, 0], [35, 5]),
      lineView(6, [30, 0], [25, 5]),
    ]);
    const points = sortByX(entityIntersections(bottom, model).map(c => c.point));
    expect(points).toHaveLength(2);
    near(points[0], [10, 0]);
    near(points[1], [30, 0]);
  });

  it('crosses a circle with a line and an arc', () => {
    // The arc is the LEFT half of the circle around (10,0): clockwise from
    // its bottom to its top passes through (0,0), where it crosses the
    // target circle at x = 5 twice.
    const c = circleView(1, [0, 0], 10);
    const model = makeModel([
      c,
      lineView(2, [-20, 0], [20, 0]),
      arcView(3, [10, -10], [10, 10], [10, 0], true),
    ]);
    const points = entityIntersections(c, model).map(x => x.point);
    expect(points).toHaveLength(4);
    const xs = points.map(p => Math.round(p[0] * 1000) / 1000).sort((a, b) => a - b);
    expect(xs).toEqual([-10, 5, 5, 10]);
  });

  it('crosses a bezier curve through its polyline', () => {
    const l = lineView(1, [0, 0], [10, 0]);
    const bezier = {
      obj: {}, points: [[2, -5], [5, 15], [8, -5]], sources: [null, null, null],
    } as unknown as SolvedBezierView;
    // The quadratic through (2,-5),(5,15),(8,-5) has x = 2 + 6t and
    // y = -5 + 40t - 40t², so it crosses y = 0 at t = (1 ∓ 1/√2)/2.
    const points = sortByX(entityIntersections(l, makeModel([l], [bezier])).map(c => c.point));
    expect(points).toHaveLength(2);
    expect(Math.abs(points[0][0] - (2 + 3 * (1 - Math.SQRT1_2)))).toBeLessThan(1e-3);
    expect(Math.abs(points[1][0] - (2 + 3 * (1 + Math.SQRT1_2)))).toBeLessThan(1e-3);
    expect(entityIntersections(l, makeModel([l], [bezier])).every(c => c.entityId === null)).toBe(true);
  });

  it('names the crossing entity, and the end of it a T-junction sits on', () => {
    const l = lineView(1, [0, 0], [40, 0]);
    const model = makeModel([l, lineView(2, [10, -5], [10, 5]), lineView(3, [30, 0], [30, 9])]);
    const crossings = entityIntersections(l, model).sort((a, b) => a.point[0] - b.point[0]);
    expect(crossings).toHaveLength(2);
    const [cross, tee] = crossings;
    expect(cross).toEqual({ point: [10, 0], entityId: 2 });
    expect(tee.entityId).toBe(3);
    expect(tee.role).toBe('start');
    near(tee.point, [30, 0]);
  });

  it('counts an end that stops a hundredth short of the target as touching it', () => {
    // The crossing sits at x = ±25.447; a trimmed piece ends at a two-decimal
    // literal just past it, another just short of it: both meet the circle,
    // at the exact crossing.
    const c = circleView(1, [0, 0], 30.62);
    const y = 17.03;
    const inside = lineView(2, [46.27, y], [25.45, y]);
    const outside = lineView(3, [-46.27, y], [-25.44, y]);
    const crossings = entityIntersections(c, makeModel([c, inside, outside]));
    expect(crossings).toHaveLength(2);
    const byX = [...crossings].sort((a, b) => a.point[0] - b.point[0]);
    expect(Math.hypot(byX[0].point[0], byX[0].point[1])).toBeCloseTo(30.62, 9);
    expect(Math.hypot(byX[1].point[0], byX[1].point[1])).toBeCloseTo(30.62, 9);
    expect(byX[0].role).toBe('end');
    expect(byX[1].role).toBe('end');
    // Two hundredths short is a miss.
    const far = lineView(4, [46.27, y], [25.47, y]);
    expect(entityIntersections(c, makeModel([c, far]))).toHaveLength(0);
  });

  it('treats a line a hundredth off a circle as tangent to it', () => {
    const c = circleView(1, [0, 0], 10);
    const grazing = lineView(2, [-20, 10.008], [20, 10.008]);
    const [touch] = entityIntersections(c, makeModel([c, grazing]));
    expect(touch).toBeDefined();
    expect(touch.point[0]).toBeCloseTo(0, 6);
    expect(entityIntersections(c, makeModel([c, lineView(3, [-20, 10.02], [20, 10.02])]))).toHaveLength(0);
  });
});
