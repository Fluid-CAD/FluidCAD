import { describe, it, expect } from "vitest";
import { SketchImport } from "../../../io/drawing/sketch-import.js";
import type { SketchPrimitive } from "../../../io/drawing/sketch-import.js";
import { Affine } from "../../../io/drawing/affine.js";
import { BSplineCurve2D } from "../../../io/drawing/bspline.js";
import { Curves } from "../../../io/drawing/drawing.js";
import type { Curve2D, Vec2 } from "../../../io/drawing/drawing.js";

const OPTIONS = { tolerance: 1e-5, joinTolerance: 1e-3, decimals: 6 };

function plan(curves: Curve2D[], options = OPTIONS) {
  return SketchImport.plan(curves, options);
}

/** The point of a bezier at `t`, by de Casteljau. */
function bezierAt(points: Vec2[], t: number): Vec2 {
  const work = points.map((p) => ({ ...p }));
  for (let level = work.length - 1; level > 0; level--) {
    for (let i = 0; i < level; i++) {
      work[i] = { x: work[i].x + (work[i + 1].x - work[i].x) * t, y: work[i].y + (work[i + 1].y - work[i].y) * t };
    }
  }
  return work[0];
}

const line = (a: [number, number], b: [number, number]): Curve2D =>
  ({ kind: 'line', a: { x: a[0], y: a[1] }, b: { x: b[0], y: b[1] } });

describe("SketchImport: the statement each curve becomes", () => {
  it("writes lines, circles and arcs as themselves", () => {
    const { primitives, approximated, duplicates } = plan([
      line([0, 0], [40, 12.5]),
      { kind: 'circle', center: { x: 20, y: 15 }, radius: 5 },
      { kind: 'arc', center: { x: 0, y: 0 }, radius: 10, start: 0, end: Math.PI / 2 },
    ]);
    expect(primitives).toEqual([
      { kind: 'line', start: { x: 0, y: 0 }, end: { x: 40, y: 12.5 } },
      { kind: 'circle', center: { x: 20, y: 15 }, diameter: 10 },
      { kind: 'arc', start: { x: 10, y: 0 }, end: { x: 0, y: 10 }, center: { x: 0, y: 0 } },
    ]);
    expect(approximated).toBe(0);
    expect(duplicates).toBe(0);
  });

  it("rounds to the written decimals, never writing a negative zero", () => {
    const { primitives } = plan([line([-1e-9, 1 / 3], [2 / 3, 10])], { ...OPTIONS, decimals: 3 });
    expect(primitives).toEqual([{ kind: 'line', start: { x: 0, y: 0.333 }, end: { x: 0.667, y: 10 } }]);
    expect(Object.is((primitives[0] as { start: Vec2 }).start.x, 0)).toBe(true);
  });

  it("writes a full ellipse with its semi-radii and the angle of its long axis, kept in (−90°, 90°]", () => {
    const turned = (degrees: number): SketchPrimitive => plan([{
      kind: 'ellipse',
      center: { x: 5, y: -5 },
      major: { x: 10 * Math.cos(degrees * Math.PI / 180), y: 10 * Math.sin(degrees * Math.PI / 180) },
      ratio: 0.4,
      start: 0,
      end: 2 * Math.PI,
    }]).primitives[0];
    expect(turned(30)).toEqual({ kind: 'ellipse', center: { x: 5, y: -5 }, rx: 10, ry: 4, rotation: 30 });
    expect(turned(150)).toMatchObject({ rotation: -30 });
    expect(turned(-90)).toMatchObject({ rotation: 90 });
    expect(turned(180)).toMatchObject({ rotation: 0 });
  });

  it("writes an arc that is the whole circle as a circle", () => {
    const { primitives } = plan([{ kind: 'arc', center: { x: 1, y: 1 }, radius: 3, start: 1, end: 1 + 2 * Math.PI }]);
    expect(primitives).toEqual([{ kind: 'circle', center: { x: 1, y: 1 }, diameter: 6 }]);
  });

  it("writes a cubic spline as its own bezier pieces: the same curve", () => {
    const spline: Curve2D = {
      kind: 'bspline',
      degree: 3,
      knots: [0, 0, 0, 0, 0.3, 0.7, 1, 1, 1, 1],
      poles: [{ x: 0, y: 0 }, { x: 4, y: 9 }, { x: 11, y: -3 }, { x: 16, y: 8 }, { x: 22, y: 1 }, { x: 25, y: 6 }],
    };
    const { primitives, joins, approximated } = plan([spline]);
    expect(primitives.map((p) => p.kind)).toEqual(['bezier', 'bezier', 'bezier']);
    expect(approximated).toBe(0);
    const spans: [number, number][] = [[0, 0.3], [0.3, 0.7], [0.7, 1]];
    primitives.forEach((primitive, i) => {
      const points = (primitive as { points: Vec2[] }).points;
      expect(points).toHaveLength(4);
      for (const s of [0, 0.25, 0.5, 0.75, 1]) {
        const expected = BSplineCurve2D.evaluate(spline, spans[i][0] + (spans[i][1] - spans[i][0]) * s);
        const actual = bezierAt(points, s);
        expect(actual.x).toBeCloseTo(expected.x, 5);
        expect(actual.y).toBeCloseTo(expected.y, 5);
      }
    });
    // The pieces meet end to start.
    expect(joins).toEqual([
      { a: { primitive: 0, end: 'end' }, b: { primitive: 1, end: 'start' } },
      { a: { primitive: 1, end: 'end' }, b: { primitive: 2, end: 'start' } },
    ]);
  });

  it("writes a quadratic spline as three-point beziers and a straight one as a line", () => {
    const { primitives } = plan([
      { kind: 'bspline', degree: 2, knots: [0, 0, 0, 1, 1, 1], poles: [{ x: 0, y: 0 }, { x: 5, y: 8 }, { x: 10, y: 0 }] },
      { kind: 'bspline', degree: 3, knots: [0, 0, 0, 0, 1, 1, 1, 1], poles: [{ x: 0, y: 20 }, { x: 1, y: 20 }, { x: 7, y: 20 }, { x: 9, y: 20 }] },
      { kind: 'bspline', degree: 1, knots: [0, 0, 1, 2, 2], poles: [{ x: 0, y: 30 }, { x: 5, y: 35 }, { x: 10, y: 30 }] },
    ]);
    expect(primitives).toEqual([
      { kind: 'bezier', points: [{ x: 0, y: 0 }, { x: 5, y: 8 }, { x: 10, y: 0 }] },
      { kind: 'line', start: { x: 0, y: 20 }, end: { x: 9, y: 20 } },
      { kind: 'line', start: { x: 0, y: 30 }, end: { x: 5, y: 35 } },
      { kind: 'line', start: { x: 5, y: 35 }, end: { x: 10, y: 30 } },
    ]);
  });

  it("fits a rational spline with cubics within the tolerance, and counts it", () => {
    const quarter: Curve2D = {
      kind: 'bspline',
      degree: 2,
      knots: [0, 0, 0, 1, 1, 1],
      poles: [{ x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }],
      weights: [1, Math.SQRT1_2, 1],
    };
    const { primitives, approximated } = plan([quarter], { ...OPTIONS, tolerance: 1e-4 });
    expect(approximated).toBe(1);
    expect(primitives.length).toBeGreaterThan(1);
    for (const primitive of primitives) {
      expect(primitive.kind).toBe('bezier');
      const points = (primitive as { points: Vec2[] }).points;
      expect(points).toHaveLength(4);
      for (const s of [0, 0.2, 0.4, 0.6, 0.8, 1]) {
        const p = bezierAt(points, s);
        expect(Math.abs(Math.hypot(p.x, p.y) - 10)).toBeLessThan(2e-4);
      }
    }
  });

  it("fits an elliptical arc with cubics that stay on the ellipse and run its whole extent", () => {
    const arc: Curve2D = { kind: 'ellipse', center: { x: 3, y: 4 }, major: { x: 20, y: 0 }, ratio: 0.5, start: 0.5, end: 4 };
    const { primitives, joins, approximated } = plan([arc], { ...OPTIONS, tolerance: 1e-3 });
    expect(approximated).toBe(1);
    // 3.5 radians: three pieces do it, not dozens.
    expect(primitives).toHaveLength(3);
    const onEllipse = (p: Vec2) => Math.hypot((p.x - 3) / 20, (p.y - 4) / 10);
    for (const primitive of primitives) {
      expect(primitive.kind).toBe('bezier');
      const points = (primitive as { points: Vec2[] }).points;
      expect(points).toHaveLength(4);
      for (let k = 0; k <= 40; k++) {
        // The tolerance is 1e-3 of length: 5e-5 of the unit circle the ellipse is the image of, at its long radius of 20.
        expect(Math.abs(onEllipse(bezierAt(points, k / 40)) - 1)).toBeLessThan(5e-5);
      }
    }
    const first = (primitives[0] as { points: Vec2[] }).points[0];
    const lastPoints = (primitives[primitives.length - 1] as { points: Vec2[] }).points;
    const last = lastPoints[lastPoints.length - 1];
    const [start, end] = Curves.endpoints(arc)!;
    expect(first.x).toBeCloseTo(start.x, 5);
    expect(first.y).toBeCloseTo(start.y, 5);
    expect(last.x).toBeCloseTo(end.x, 5);
    expect(last.y).toBeCloseTo(end.y, 5);
    expect(joins).toHaveLength(primitives.length - 1);
  });

  it("cuts an elliptical arc finer for a tighter tolerance, and never coarser than a quarter turn a piece", () => {
    const half: Curve2D = { kind: 'ellipse', center: { x: 0, y: 0 }, major: { x: 19, y: 0 }, ratio: 0.6, start: Math.PI, end: 2 * Math.PI };
    expect(plan([half], { ...OPTIONS, tolerance: 1e-4 }).primitives).toHaveLength(4);
    expect(plan([half], { ...OPTIONS, tolerance: 1 }).primitives).toHaveLength(2);
    const tight = plan([half], { ...OPTIONS, tolerance: 1e-6 }).primitives;
    expect(tight.length).toBeGreaterThan(4);
    expect(tight.length).toBeLessThan(12);
  });

  it("writes a polyline as its segments", () => {
    const { primitives } = plan([{ kind: 'polyline', points: [{ x: 0, y: 0 }, { x: 3, y: 0 }, { x: 3, y: 3 }], closed: true }]);
    expect(primitives.map((p) => p.kind)).toEqual(['line', 'line', 'line']);
    expect(primitives[2]).toEqual({ kind: 'line', start: { x: 3, y: 3 }, end: { x: 0, y: 0 } });
  });
});

describe("SketchImport: what is left out", () => {
  it("drops what has no length", () => {
    const { primitives } = plan([
      line([1, 1], [1, 1]),
      line([1, 1], [1 + 5e-4, 1]),
      { kind: 'circle', center: { x: 0, y: 0 }, radius: 0 },
      { kind: 'arc', center: { x: 0, y: 0 }, radius: 100, start: 0, end: 1e-6 },
      line([0, 0], [1, 0]),
    ]);
    expect(primitives).toEqual([{ kind: 'line', start: { x: 0, y: 0 }, end: { x: 1, y: 0 } }]);
  });

  it("keeps an arc whose ends nearly meet after going most of the way round", () => {
    const { primitives, joins } = plan([{ kind: 'arc', center: { x: 0, y: 0 }, radius: 10, start: 0, end: 2 * Math.PI - 5e-5 }]);
    expect(primitives).toHaveLength(1);
    expect(primitives[0].kind).toBe('arc');
    // Its two ends are within the join tolerance, and still not joined: that would fold it.
    expect(joins).toEqual([]);
  });

  it("drops a curve drawn twice, whichever way a line runs, and counts it", () => {
    const { primitives, duplicates } = plan([
      line([0, 0], [10, 0]),
      line([10, 0], [0, 0]),
      { kind: 'circle', center: { x: 5, y: 5 }, radius: 2 },
      { kind: 'circle', center: { x: 5, y: 5 }, radius: 2 },
      { kind: 'circle', center: { x: 5, y: 5 }, radius: 3 },
    ]);
    expect(primitives).toHaveLength(3);
    expect(duplicates).toBe(2);
  });
});

describe("SketchImport: joins", () => {
  it("joins a closed outline at every corner", () => {
    const { joins } = plan([line([0, 0], [10, 0]), line([10, 0], [10, 5]), line([10, 5], [0, 5]), line([0, 5], [0, 0])]);
    expect(joins).toEqual([
      { a: { primitive: 0, end: 'start' }, b: { primitive: 3, end: 'end' } },
      { a: { primitive: 0, end: 'end' }, b: { primitive: 1, end: 'start' } },
      { a: { primitive: 1, end: 'end' }, b: { primitive: 2, end: 'start' } },
      { a: { primitive: 2, end: 'end' }, b: { primitive: 3, end: 'start' } },
    ]);
  });

  it("joins three ends at one point as a star from the first", () => {
    const { joins } = plan([line([0, 0], [5, 5]), line([5, 5], [10, 0]), line([5, 10], [5, 5])]);
    expect(joins).toEqual([
      { a: { primitive: 0, end: 'end' }, b: { primitive: 1, end: 'start' } },
      { a: { primitive: 0, end: 'end' }, b: { primitive: 2, end: 'end' } },
    ]);
  });

  it("joins ends within the join tolerance and not beyond", () => {
    const near = plan([line([0, 0], [10, 0]), line([10 + 8e-4, 0], [20, 0])]);
    expect(near.joins).toHaveLength(1);
    const far = plan([line([0, 0], [10, 0]), line([10 + 2e-3, 0], [20, 0])]);
    expect(far.joins).toEqual([]);
  });

  it("joins a line to an arc and to a bezier by their ends; circles and ellipses have none", () => {
    const { primitives, joins } = plan([
      line([0, 0], [10, 0]),
      { kind: 'arc', center: { x: 10, y: 5 }, radius: 5, start: -Math.PI / 2, end: Math.PI / 2 },
      { kind: 'bspline', degree: 2, knots: [0, 0, 0, 1, 1, 1], poles: [{ x: 10, y: 10 }, { x: 5, y: 14 }, { x: 0, y: 0 }] },
      { kind: 'circle', center: { x: 0, y: 0 }, radius: 1 },
    ]);
    expect(primitives.map((p) => p.kind)).toEqual(['line', 'arc', 'bezier', 'circle']);
    expect(joins).toEqual([
      { a: { primitive: 0, end: 'start' }, b: { primitive: 2, end: 'end' } },
      { a: { primitive: 0, end: 'end' }, b: { primitive: 1, end: 'start' } },
      { a: { primitive: 1, end: 'end' }, b: { primitive: 2, end: 'start' } },
    ]);
  });

  it("closes a bezier that ends where it starts", () => {
    const { joins } = plan([{
      kind: 'bspline', degree: 3, knots: [0, 0, 0, 0, 1, 1, 1, 1],
      poles: [{ x: 0, y: 0 }, { x: 10, y: 10 }, { x: -10, y: 10 }, { x: 0, y: 0 }],
    }]);
    expect(joins).toEqual([{ a: { primitive: 0, end: 'start' }, b: { primitive: 0, end: 'end' } }]);
  });
});

describe("SketchImport: points", () => {
  const at = (x: number, y: number): Vec2 => ({ x, y });

  it("writes a point after the curves, rounded like them", () => {
    const { primitives, approximated, duplicates } = SketchImport.plan(
      [line([0, 0], [40, 0])],
      OPTIONS,
      [at(12.5, 7.25), at(1 / 3, -1e-9)],
    );
    expect(primitives).toEqual([
      { kind: 'line', start: { x: 0, y: 0 }, end: { x: 40, y: 0 } },
      { kind: 'point', at: { x: 12.5, y: 7.25 } },
      { kind: 'point', at: { x: 0.333333, y: 0 } },
    ]);
    expect(Object.is((primitives[2] as { at: Vec2 }).at.y, 0)).toBe(true);
    expect(approximated).toBe(0);
    expect(duplicates).toBe(0);
  });

  it("writes a point marked twice once, without counting it among the curves drawn twice", () => {
    const { primitives, duplicates } = SketchImport.plan([], OPTIONS, [at(5, 5), at(5, 5.0000001), at(6, 5)]);
    expect(primitives).toEqual([{ kind: 'point', at: { x: 5, y: 5 } }, { kind: 'point', at: { x: 6, y: 5 } }]);
    expect(duplicates).toBe(0);
  });

  it("plans a file of nothing but points", () => {
    const { primitives, joins } = SketchImport.plan([], OPTIONS, [at(0, 0), at(10, 0), at(10, 10)]);
    expect(primitives.map((p) => p.kind)).toEqual(['point', 'point', 'point']);
    expect(joins).toEqual([]);
  });

  it("joins a point to the end it sits on, and to nothing along a curve or at a centre", () => {
    const { primitives, joins } = SketchImport.plan(
      [line([0, 0], [10, 0]), line([10, 0], [10, 10]), { kind: 'circle', center: { x: 30, y: 30 }, radius: 4 }],
      OPTIONS,
      [at(10, 0), at(5, 0), at(30, 30)],
    );
    expect(primitives.map((p) => p.kind)).toEqual(['line', 'line', 'circle', 'point', 'point', 'point']);
    // The corner is one meeting point: the first line's end, with the second line's start and the point on it.
    expect(joins).toEqual([
      { a: { primitive: 0, end: 'end' }, b: { primitive: 1, end: 'start' } },
      { a: { primitive: 0, end: 'end' }, b: { primitive: 3, end: 'point' } },
    ]);
  });

  it("fixes a point once: on its own when it stands alone, through its join when it sits on an end", () => {
    const plan = SketchImport.plan([line([0, 0], [10, 0])], OPTIONS, [at(10, 0), at(5, 5)]);
    const fixed = (joined: boolean) => SketchImport.pins(plan, { joined, decimals: OPTIONS.decimals })
      .map((pin) => (pin.kind === 'fix' ? `${pin.point.primitive}:${pin.point.point}` : pin.kind));
    expect(fixed(true)).toEqual(['0:start', '0:end', '2:point']);
    expect(fixed(false)).toEqual(['0:start', '0:end', '1:point', '2:point']);
  });

  it("draws a point's outline as the point", () => {
    expect(SketchImport.outline({ kind: 'point', at: { x: 3, y: 4 } })).toEqual([{ x: 3, y: 4 }]);
  });
});

describe("SketchImport: guide lines", () => {
  const cut = (a: [number, number], b: [number, number]) => ({ a: { x: a[0], y: a[1] }, b: { x: b[0], y: b[1] } });

  it("writes a construction line as a guide line, after the curves and the points, rounded like them", () => {
    const { primitives, duplicates, approximated } = SketchImport.plan(
      [line([0, 0], [40, 0])],
      OPTIONS,
      [{ x: 5, y: 5 }],
      { guides: [cut([-4, 1 / 3], [44, 1 / 3])] },
    );
    expect(primitives).toEqual([
      { kind: 'line', start: { x: 0, y: 0 }, end: { x: 40, y: 0 } },
      { kind: 'point', at: { x: 5, y: 5 } },
      { kind: 'line', start: { x: -4, y: 0.333333 }, end: { x: 44, y: 0.333333 }, guide: true },
    ]);
    expect(primitives.map((p) => SketchImport.isGuide(p))).toEqual([false, false, true]);
    expect(duplicates).toBe(0);
    expect(approximated).toBe(0);
  });

  it("joins a guide line's ends to nothing: they are where an endless line was cut", () => {
    // The guide's ends sit exactly on the outline's corners and on a point.
    const { joins } = SketchImport.plan(
      [line([0, 0], [10, 0]), line([10, 0], [10, 10])],
      OPTIONS,
      [{ x: 10, y: 10 }],
      { guides: [cut([0, 0], [10, 10]), cut([10, 10], [20, 10])] },
    );
    expect(joins).toEqual([
      { a: { primitive: 0, end: 'end' }, b: { primitive: 1, end: 'start' } },
      { a: { primitive: 1, end: 'end' }, b: { primitive: 2, end: 'point' } },
    ]);
  });

  it("writes one construction line given twice once, whichever way it runs, without counting it as a curve drawn twice", () => {
    const { primitives, duplicates } = SketchImport.plan([], OPTIONS, [], {
      guides: [cut([0, 0], [10, 10]), cut([10, 10], [0, 0]), cut([0, 0], [10, 10.0000001])],
    });
    expect(primitives).toHaveLength(1);
    expect(duplicates).toBe(0);
  });

  it("keeps a guide line that lies on a line of the outline, and the line", () => {
    const { primitives, duplicates } = SketchImport.plan([line([0, 0], [10, 0])], OPTIONS, [], { guides: [cut([0, 0], [10, 0])] });
    expect(primitives.map((p) => SketchImport.isGuide(p))).toEqual([false, true]);
    expect(duplicates).toBe(0);
  });

  it("leaves out a guide line cut to nothing", () => {
    const { primitives } = SketchImport.plan([], OPTIONS, [], { guides: [cut([3, 3], [3, 3.0000001])] });
    expect(primitives).toEqual([]);
  });

  it("fixes each end of a guide line on its own, joined or not", () => {
    const made = SketchImport.plan(
      [line([0, 0], [10, 0]), line([10, 0], [10, 10])],
      OPTIONS,
      [],
      { guides: [cut([0, 0], [10, 10])] },
    );
    const fixed = (joined: boolean) => SketchImport.pins(made, { joined, decimals: OPTIONS.decimals })
      .map((pin) => (pin.kind === 'fix' ? `${pin.point.primitive}:${pin.point.point}` : pin.kind));
    expect(fixed(true)).toEqual(['0:start', '0:end', '1:end', '2:start', '2:end']);
    expect(fixed(false)).toEqual(['0:start', '0:end', '1:start', '1:end', '2:start', '2:end']);
  });
});

describe("SketchImport.outline", () => {
  it("runs from a primitive's start to its end, on the curve", () => {
    const arc = SketchImport.outline({ kind: 'arc', start: { x: 10, y: 0 }, end: { x: 0, y: 10 }, center: { x: 0, y: 0 } });
    expect(arc[0].x).toBeCloseTo(10, 9);
    expect(arc[arc.length - 1].y).toBeCloseTo(10, 9);
    for (const p of arc) {
      expect(Math.hypot(p.x, p.y)).toBeCloseTo(10, 9);
      expect(p.x).toBeGreaterThan(-1e-9);
      expect(p.y).toBeGreaterThan(-1e-9);
    }
    const bezier = SketchImport.outline({ kind: 'bezier', points: [{ x: 0, y: 0 }, { x: 5, y: 10 }, { x: 10, y: 0 }] });
    expect(bezier[0]).toEqual({ x: 0, y: 0 });
    expect(bezier[bezier.length - 1]).toEqual({ x: 10, y: 0 });
    expect(bezier[bezier.length >> 1].y).toBeCloseTo(5, 9);
    const ellipse = SketchImport.outline({ kind: 'ellipse', center: { x: 0, y: 0 }, rx: 10, ry: 5, rotation: 90 });
    expect(Math.max(...ellipse.map((p) => Math.abs(p.x)))).toBeCloseTo(5, 6);
    expect(Math.max(...ellipse.map((p) => Math.abs(p.y)))).toBeCloseTo(10, 6);
  });
});

describe("Affine", () => {
  it("places: scales, then turns, then moves", () => {
    const m = Affine.placement(2, Math.PI / 2, { x: 10, y: 0 });
    const p = Affine.point(m, { x: 1, y: 0 });
    expect(p.x).toBeCloseTo(10, 12);
    expect(p.y).toBeCloseTo(2, 12);
  });

  it("composes in the order named", () => {
    const move = Affine.translation({ x: 5, y: 0 });
    const turn = Affine.placement(1, Math.PI / 2, { x: 0, y: 0 });
    const movedThenTurned = Affine.point(Affine.compose(move, turn), { x: 0, y: 0 });
    expect(movedThenTurned.x).toBeCloseTo(0, 12);
    expect(movedThenTurned.y).toBeCloseTo(5, 12);
    const turnedThenMoved = Affine.point(Affine.compose(turn, move), { x: 0, y: 0 });
    expect(turnedThenMoved.x).toBeCloseTo(5, 12);
    expect(turnedThenMoved.y).toBeCloseTo(0, 12);
  });

  it("hands back the curve itself under the identity", () => {
    const curve = line([0, 0], [1, 1]);
    expect(Affine.curve(Affine.IDENTITY, curve, 1e-9)).toBe(curve);
  });

  it("turns and scales an arc, keeping it an arc over the same points", () => {
    const arc: Curve2D = { kind: 'arc', center: { x: 2, y: 0 }, radius: 1, start: 0, end: Math.PI / 2 };
    const m = Affine.placement(3, Math.PI, { x: 0, y: 0 });
    const placed = Affine.curve(m, arc, 1e-9)!;
    expect(placed).toMatchObject({ kind: 'arc', radius: expect.closeTo(3, 12) });
    const expected = Curves.sample(arc, 8).map((p) => Affine.point(m, p));
    Curves.sample(placed, 8).forEach((p, i) => {
      expect(p.x).toBeCloseTo(expected[i].x, 9);
      expect(p.y).toBeCloseTo(expected[i].y, 9);
    });
  });

  it("mirrors an arc into the counter-clockwise arc over the mirrored points", () => {
    const arc: Curve2D = { kind: 'arc', center: { x: 0, y: 0 }, radius: 5, start: 0, end: Math.PI / 2 };
    const mirror = { a: -1, b: 0, c: 0, d: 1, e: 0, f: 0 };
    const placed = Affine.curve(mirror, arc, 1e-9)!;
    expect(placed.kind).toBe('arc');
    const expected = Curves.sample(arc, 8).map((p) => Affine.point(mirror, p)).reverse();
    Curves.sample(placed, 8).forEach((p, i) => {
      expect(p.x).toBeCloseTo(expected[i].x, 9);
      expect(p.y).toBeCloseTo(expected[i].y, 9);
    });
  });

  it("stretches a circle into an ellipse along the stretched axis, and flattens it to a segment", () => {
    const circle: Curve2D = { kind: 'circle', center: { x: 1, y: 1 }, radius: 2 };
    const stretched = Affine.curve({ a: 1, b: 0, c: 0, d: 3, e: 0, f: 0 }, circle, 1e-9)!;
    expect(stretched).toMatchObject({ kind: 'ellipse', center: { x: 1, y: 3 }, ratio: expect.closeTo(1 / 3, 12) });
    expect(Math.abs((stretched as { major: Vec2 }).major.y)).toBeCloseTo(6, 12);
    const flat = Affine.curve({ a: 1, b: 0, c: 0, d: 0, e: 0, f: 0 }, circle, 1e-9)!;
    expect(flat.kind).toBe('line');
  });

  it("moves a spline's poles and keeps its knots and weights", () => {
    const spline: Curve2D = {
      kind: 'bspline', degree: 2, knots: [0, 0, 0, 1, 1, 1],
      poles: [{ x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }], weights: [1, 0.7, 1],
    };
    const placed = Affine.curve(Affine.translation({ x: 1, y: 2 }), spline, 1e-9)!;
    expect(placed).toEqual({ ...spline, poles: [{ x: 11, y: 2 }, { x: 11, y: 12 }, { x: 1, y: 12 }] });
  });
});

describe("BSplineCurve2D.clamped", () => {
  it("hands back a clamped curve as it is", () => {
    const curve = { kind: 'bspline' as const, degree: 2, knots: [0, 0, 0, 1, 1, 1], poles: [{ x: 0, y: 0 }, { x: 1, y: 1 }, { x: 2, y: 0 }] };
    expect(BSplineCurve2D.clamped(curve)).toBe(curve);
  });

  it("clamps a uniform rational curve to the same curve on its domain", () => {
    const curve = {
      kind: 'bspline' as const,
      degree: 2,
      knots: [0, 1, 2, 3, 4, 5, 6],
      poles: [{ x: 0, y: 0 }, { x: 4, y: 6 }, { x: 8, y: -2 }, { x: 12, y: 5 }],
      weights: [1, 2, 0.5, 1],
    };
    const clamped = BSplineCurve2D.clamped(curve);
    expect(BSplineCurve2D.isClamped(clamped)).toBe(true);
    expect(BSplineCurve2D.invalidReason(clamped)).toBeNull();
    expect(BSplineCurve2D.domain(clamped)).toEqual(BSplineCurve2D.domain(curve));
    const [t0, t1] = BSplineCurve2D.domain(curve);
    for (let i = 0; i <= 20; i++) {
      const t = t0 + ((t1 - t0) * i) / 20;
      const expected = BSplineCurve2D.evaluate(curve, t);
      const actual = BSplineCurve2D.evaluate(clamped, t);
      expect(actual.x).toBeCloseTo(expected.x, 10);
      expect(actual.y).toBeCloseTo(expected.y, 10);
    }
    // It starts and ends on its own poles now.
    const start = BSplineCurve2D.evaluate(clamped, t0);
    expect(clamped.poles[0].x).toBeCloseTo(start.x, 10);
    expect(clamped.poles[0].y).toBeCloseTo(start.y, 10);
  });
});
