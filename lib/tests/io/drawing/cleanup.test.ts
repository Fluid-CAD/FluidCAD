import { describe, it, expect } from "vitest";
import { DrawingCleanup } from "../../../io/drawing/cleanup.js";
import type { Curve2D, DrawingEntity, DrawingLayer, Vec2 } from "../../../io/drawing/drawing.js";

const TOL = 1e-5;
const TWO_PI = 2 * Math.PI;

const p = (x: number, y: number): Vec2 => ({ x, y });
const line = (a: Vec2, b: Vec2, layer: DrawingLayer = 'visible'): DrawingEntity => ({ layer, curve: { kind: 'line', a, b } });
const arc = (center: Vec2, radius: number, start: number, end: number, layer: DrawingLayer = 'visible'): DrawingEntity =>
  ({ layer, curve: { kind: 'arc', center, radius, start, end } });

const lines = (entities: DrawingEntity[]) => entities.filter((e) => e.curve.kind === 'line')
  .map((e) => ({ layer: e.layer, ...(e.curve as Extract<Curve2D, { kind: 'line' }>) }));

/** A deterministic shuffle: the same permutation for the same seed. */
function shuffled<T>(items: T[], seed: number): T[] {
  const result = [...items];
  let state = seed;
  for (let i = result.length - 1; i > 0; i--) {
    state = (state * 1103515245 + 12345) % 2147483648;
    const j = state % (i + 1);
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

describe("DrawingCleanup.canonicalize", () => {
  it("drops what has no length", () => {
    expect(DrawingCleanup.canonicalize({ kind: 'line', a: p(1, 1), b: p(1 + 1e-7, 1) }, TOL)).toBeNull();
    expect(DrawingCleanup.canonicalize({ kind: 'circle', center: p(0, 0), radius: 1e-7 }, TOL)).toBeNull();
    expect(DrawingCleanup.canonicalize({ kind: 'arc', center: p(0, 0), radius: 5, start: 1, end: 1 + 1e-7 }, TOL)).toBeNull();
    expect(DrawingCleanup.canonicalize({ kind: 'polyline', points: [p(0, 0), p(0, 1e-7)], closed: false }, TOL)).toBeNull();
  });

  it("makes a full-sweep arc a circle", () => {
    expect(DrawingCleanup.canonicalize({ kind: 'arc', center: p(2, 3), radius: 5, start: 1, end: 1 + TWO_PI }, TOL))
      .toEqual({ kind: 'circle', center: p(2, 3), radius: 5 });
  });

  it("brings an arc's start into [0, 2π) and keeps its sweep", () => {
    const curve = DrawingCleanup.canonicalize({ kind: 'arc', center: p(0, 0), radius: 5, start: -1, end: 0.5 }, TOL)!;
    expect(curve.kind).toBe('arc');
    if (curve.kind === 'arc') {
      expect(curve.start).toBeCloseTo(TWO_PI - 1, 12);
      expect(curve.end - curve.start).toBeCloseTo(1.5, 12);
    }
  });

  it("makes an ellipse with equal axes a circle or an arc", () => {
    expect(DrawingCleanup.canonicalize({ kind: 'ellipse', center: p(1, 1), major: p(3, 0), ratio: 1, start: 0, end: TWO_PI }, TOL))
      .toEqual({ kind: 'circle', center: p(1, 1), radius: 3 });
    const partial = DrawingCleanup.canonicalize({ kind: 'ellipse', center: p(1, 1), major: p(3, 0), ratio: 1, start: 0.5, end: 2 }, TOL)!;
    expect(partial.kind).toBe('arc');
  });

  it("makes a spline whose poles are in a row the line it draws", () => {
    const curve = DrawingCleanup.canonicalize({
      kind: 'bspline', degree: 2, knots: [0, 0, 0, 1, 1, 1], poles: [p(0, 0), p(4, 2), p(10, 5)],
    }, TOL)!;
    expect(curve.kind).toBe('line');
  });

  it("refuses a malformed spline rather than writing it", () => {
    expect(() => DrawingCleanup.canonicalize({ kind: 'bspline', degree: 2, knots: [0, 1], poles: [p(0, 0), p(4, 2), p(10, 6)] }, TOL)).toThrow();
  });

  it("removes a polyline's repeated points and turns two points into a line", () => {
    expect(DrawingCleanup.canonicalize({ kind: 'polyline', points: [p(0, 0), p(0, 0), p(5, 0)], closed: false }, TOL))
      .toEqual({ kind: 'line', a: p(0, 0), b: p(5, 0) });
    expect(DrawingCleanup.canonicalize({ kind: 'polyline', points: [p(0, 0), p(5, 0), p(5, 5), p(0, 0)], closed: false }, TOL))
      .toEqual({ kind: 'polyline', points: [p(0, 0), p(5, 0), p(5, 5)], closed: true });
  });
});

describe("DrawingCleanup.mergeOverlaps — lines", () => {
  it("unions overlapping collinear segments", () => {
    const merged = lines(DrawingCleanup.mergeOverlaps([line(p(0, 0), p(6, 0)), line(p(10, 0), p(4, 0))], TOL));
    expect(merged).toEqual([{ layer: 'visible', kind: 'line', a: p(0, 0), b: p(10, 0) }]);
  });

  it("drops an exact duplicate, whichever way round it is drawn", () => {
    const merged = DrawingCleanup.mergeOverlaps([line(p(1, 1), p(4, 5)), line(p(4, 5), p(1, 1)), line(p(1, 1), p(4, 5))], TOL);
    expect(merged).toHaveLength(1);
  });

  it("rejoins fragments that touch end to end", () => {
    const merged = lines(DrawingCleanup.mergeOverlaps([line(p(0, 0), p(3, 3)), line(p(3, 3), p(5, 5)), line(p(5, 5), p(9, 9))], TOL));
    expect(merged).toEqual([{ layer: 'visible', kind: 'line', a: p(0, 0), b: p(9, 9) }]);
  });

  it("keeps collinear segments with a real gap apart", () => {
    const merged = DrawingCleanup.mergeOverlaps([line(p(0, 0), p(3, 0)), line(p(3.001, 0), p(9, 0))], TOL);
    expect(merged).toHaveLength(2);
  });

  it("keeps parallel segments off the carrier apart", () => {
    const merged = DrawingCleanup.mergeOverlaps([line(p(0, 0), p(10, 0)), line(p(2, 1e-3), p(8, 1e-3))], TOL);
    expect(merged).toHaveLength(2);
  });

  it("merges a short segment into a long carrier far from the origin", () => {
    const merged = lines(DrawingCleanup.mergeOverlaps([
      line(p(1000, 2000), p(1300, 2400)),
      line(p(1300, 2400), p(1300.003, 2400.004)),
    ], TOL));
    expect(merged).toHaveLength(1);
    expect(merged[0].a).toEqual(p(1000, 2000));
    expect(merged[0].b).toEqual(p(1300.003, 2400.004));
  });

  it("keeps the members' own end points: merging moves no coordinate", () => {
    const merged = lines(DrawingCleanup.mergeOverlaps([line(p(0.1, 0.3), p(0.7, 0.9)), line(p(0.4, 0.6), p(1.3, 1.5))], TOL));
    expect(merged).toEqual([{ layer: 'visible', kind: 'line', a: p(0.1, 0.3), b: p(1.3, 1.5) }]);
  });
});

describe("DrawingCleanup.mergeOverlaps — layers", () => {
  it("removes a hidden line that lies under a visible one", () => {
    const merged = DrawingCleanup.mergeOverlaps([line(p(0, 0), p(10, 0)), line(p(0, 0), p(10, 0), 'hidden')], TOL);
    expect(merged).toEqual([line(p(0, 0), p(10, 0))]);
  });

  it("keeps the part of a hidden line that sticks out past the visible one", () => {
    const merged = lines(DrawingCleanup.mergeOverlaps([line(p(2, 0), p(6, 0)), line(p(0, 0), p(10, 0), 'hidden')], TOL));
    expect(merged).toEqual([
      { layer: 'visible', kind: 'line', a: p(2, 0), b: p(6, 0) },
      { layer: 'hidden', kind: 'line', a: p(0, 0), b: p(2, 0) },
      { layer: 'hidden', kind: 'line', a: p(6, 0), b: p(10, 0) },
    ]);
  });

  it("keeps a hidden line beside a visible one", () => {
    const merged = DrawingCleanup.mergeOverlaps([line(p(0, 0), p(10, 0)), line(p(0, 1), p(10, 1), 'hidden')], TOL);
    expect(merged).toHaveLength(2);
  });

  it("drops a hidden sliver left at the end of a visible line", () => {
    // Two stand-ins for one edge that disagree by a tenth of a micron.
    const merged = DrawingCleanup.mergeOverlaps([line(p(0, 0), p(10, 0)), line(p(-0.0001, 0), p(10, 0), 'hidden')], TOL);
    expect(merged).toEqual([line(p(0, 0), p(10, 0))]);
  });

  it("ranks tangent between visible and hidden", () => {
    const merged = lines(DrawingCleanup.mergeOverlaps([
      line(p(0, 0), p(4, 0)),
      line(p(0, 0), p(8, 0), 'tangent'),
      line(p(0, 0), p(12, 0), 'hidden'),
    ], TOL));
    expect(merged).toEqual([
      { layer: 'visible', kind: 'line', a: p(0, 0), b: p(4, 0) },
      { layer: 'tangent', kind: 'line', a: p(4, 0), b: p(8, 0) },
      { layer: 'hidden', kind: 'line', a: p(8, 0), b: p(12, 0) },
    ]);
  });

  it("removes a hidden arc under a visible circle", () => {
    const circle: DrawingEntity = { layer: 'visible', curve: { kind: 'circle', center: p(0, 0), radius: 5 } };
    expect(DrawingCleanup.mergeOverlaps([circle, arc(p(0, 0), 5, 1, 2, 'hidden')], TOL)).toEqual([circle]);
  });

  it("keeps the hidden half of a circle whose other half is visible", () => {
    const merged = DrawingCleanup.mergeOverlaps([
      arc(p(0, 0), 5, 0, Math.PI),
      { layer: 'hidden', curve: { kind: 'circle', center: p(0, 0), radius: 5 } },
    ], TOL);
    expect(merged).toHaveLength(2);
    const hidden = merged.find((e) => e.layer === 'hidden')!.curve;
    expect(hidden.kind).toBe('arc');
    if (hidden.kind === 'arc') {
      expect(hidden.start).toBeCloseTo(Math.PI, 12);
      expect(hidden.end).toBeCloseTo(TWO_PI, 12);
    }
  });
});

describe("DrawingCleanup.mergeOverlaps — arcs, ellipses, splines", () => {
  it("makes two half arcs one circle", () => {
    const merged = DrawingCleanup.mergeOverlaps([arc(p(1, 2), 5, 0, Math.PI), arc(p(1, 2), 5, Math.PI, TWO_PI)], TOL);
    expect(merged).toEqual([{ layer: 'visible', curve: { kind: 'circle', center: p(1, 2), radius: 5 } }]);
  });

  it("joins arcs across the zero angle into one run", () => {
    const merged = DrawingCleanup.mergeOverlaps([arc(p(0, 0), 5, 5.5, TWO_PI), arc(p(0, 0), 5, 0, 1)], TOL);
    expect(merged).toHaveLength(1);
    const curve = merged[0].curve;
    expect(curve.kind).toBe('arc');
    if (curve.kind === 'arc') {
      expect(curve.start).toBeCloseTo(5.5, 12);
      expect(curve.end).toBeCloseTo(TWO_PI + 1, 12);
    }
  });

  it("keeps concentric arcs of different radius apart", () => {
    expect(DrawingCleanup.mergeOverlaps([arc(p(0, 0), 5, 0, 1), arc(p(0, 0), 5.01, 0, 1)], TOL)).toHaveLength(2);
  });

  it("unions ellipse arcs whose major axes point opposite ways", () => {
    const merged = DrawingCleanup.mergeOverlaps([
      { layer: 'visible', curve: { kind: 'ellipse', center: p(0, 0), major: p(4, 0), ratio: 0.5, start: 0, end: Math.PI } },
      // The same ellipse, axis reversed: its parameter π..2π is the first one's 0..π shifted half a turn.
      { layer: 'visible', curve: { kind: 'ellipse', center: p(0, 0), major: p(-4, 0), ratio: 0.5, start: 0, end: Math.PI } },
    ], TOL);
    expect(merged).toHaveLength(1);
    const curve = merged[0].curve;
    expect(curve.kind).toBe('ellipse');
    if (curve.kind === 'ellipse') {
      expect(curve.end - curve.start).toBeCloseTo(TWO_PI, 12);
    }
  });

  it("keeps one of two identical splines drawn in opposite directions, on the higher layer", () => {
    const poles = [p(0, 0), p(3, 6), p(8, -2), p(12, 4)];
    const knots = [0, 0, 0, 0, 1, 1, 1, 1];
    const merged = DrawingCleanup.mergeOverlaps([
      { layer: 'hidden', curve: { kind: 'bspline', degree: 3, knots, poles: [...poles].reverse() } },
      { layer: 'visible', curve: { kind: 'bspline', degree: 3, knots, poles } },
    ], TOL);
    expect(merged).toHaveLength(1);
    expect(merged[0].layer).toBe('visible');
  });

  it("keeps two different splines between the same end points", () => {
    const knots = [0, 0, 0, 0, 1, 1, 1, 1];
    const merged = DrawingCleanup.mergeOverlaps([
      { layer: 'visible', curve: { kind: 'bspline', degree: 3, knots, poles: [p(0, 0), p(3, 6), p(8, -2), p(12, 4)] } },
      { layer: 'visible', curve: { kind: 'bspline', degree: 3, knots, poles: [p(0, 0), p(3, 5), p(8, -2), p(12, 4)] } },
    ], TOL);
    expect(merged).toHaveLength(2);
  });
});

describe("DrawingCleanup.chain", () => {
  const square = [
    line(p(10, 0), p(10, 10)),
    line(p(0, 10), p(0, 0)),
    line(p(0, 0), p(10, 0)),
    line(p(0, 10), p(10, 10)),
  ];

  it("joins a square into one counter-clockwise loop from its lowest-left corner", () => {
    const chains = DrawingCleanup.chain(square, TOL);
    expect(chains).toHaveLength(1);
    expect(chains[0].closed).toBe(true);
    const walk = chains[0].items.map((item) => {
      const l = item.curve as Extract<Curve2D, { kind: 'line' }>;
      return item.reversed ? [l.b, l.a] : [l.a, l.b];
    });
    expect(walk).toEqual([
      [p(0, 0), p(10, 0)],
      [p(10, 0), p(10, 10)],
      [p(10, 10), p(0, 10)],
      [p(0, 10), p(0, 0)],
    ]);
  });

  it("joins end points a hair apart and keeps apart those a real gap apart", () => {
    const corner = (gap: number) => [line(p(0, 0), p(10, 0)), line(p(10, gap), p(10, 10))];
    expect(DrawingCleanup.chain(corner(TOL * 0.5), TOL)).toHaveLength(1);
    expect(DrawingCleanup.chain(corner(TOL * 2), TOL)).toHaveLength(2);
  });

  it("makes a circle a loop of its own and never chains across layers", () => {
    const chains = DrawingCleanup.chain([
      { layer: 'visible', curve: { kind: 'circle', center: p(5, 5), radius: 2 } },
      line(p(0, 0), p(10, 0)),
      line(p(10, 0), p(10, 10), 'hidden'),
    ], TOL);
    expect(chains.map((c) => [c.layer, c.closed, c.items.length])).toEqual([
      ['visible', false, 1],
      ['visible', true, 1],
      ['hidden', false, 1],
    ]);
  });

  it("stops a run at a junction of three", () => {
    const chains = DrawingCleanup.chain([
      line(p(0, 0), p(5, 0)),
      line(p(5, 0), p(10, 0)),
      line(p(5, 0), p(5, 5)),
    ], TOL);
    expect(chains).toHaveLength(3);
  });

  it("chains arcs and lines together through their end points", () => {
    // A slot: two straights closed by two half circles.
    const chains = DrawingCleanup.chain([
      line(p(-5, -2), p(5, -2)),
      arc(p(5, 0), 2, 1.5 * Math.PI, 2.5 * Math.PI),
      line(p(5, 2), p(-5, 2)),
      arc(p(-5, 0), 2, 0.5 * Math.PI, 1.5 * Math.PI),
    ], TOL);
    expect(chains).toHaveLength(1);
    expect(chains[0].closed).toBe(true);
    expect(chains[0].items).toHaveLength(4);
    // Counter-clockwise: every arc is walked in its own direction.
    expect(chains[0].items.filter((i) => i.curve.kind === 'arc').every((i) => !i.reversed)).toBe(true);
  });
});

describe("DrawingCleanup.run", () => {
  const drawing: DrawingEntity[] = [
    line(p(0, 0), p(40, 0)),
    line(p(40, 0), p(40, 30)),
    line(p(40, 30), p(0, 30)),
    line(p(0, 30), p(0, 0)),
    // The far side's edges, hidden, exactly under the near side's.
    line(p(0, 0), p(40, 0), 'hidden'),
    line(p(0, 30), p(40, 30), 'hidden'),
    // A hole: its rim twice (top and bottom face), in two halves each.
    arc(p(20, 15), 5, 0, Math.PI),
    arc(p(20, 15), 5, Math.PI, TWO_PI),
    arc(p(20, 15), 5, 0.3, 0.3 + Math.PI, 'hidden'),
    arc(p(20, 15), 5, 0.3 + Math.PI, 0.3 + TWO_PI, 'hidden'),
    // An edge cut in three by what passes in front of it.
    line(p(5, 5), p(8, 8)),
    line(p(8, 8), p(11, 11), 'hidden'),
    line(p(11, 11), p(14, 14)),
    { layer: 'visible', curve: { kind: 'line', a: p(3, 3), b: p(3, 3) } },
  ];

  it("turns the raw pieces of a view into one curve per edge", () => {
    const cleaned = DrawingCleanup.run(drawing, TOL);
    expect(cleaned.map((e) => `${e.layer}:${e.curve.kind}`)).toEqual([
      'visible:line', 'visible:line', 'visible:line', 'visible:line',
      'visible:line',
      'visible:circle',
      'visible:line',
      'hidden:line',
    ]);
    // Bottom first: the outline, the edge's lower piece, the hole, the upper piece.
    expect(cleaned[4].curve).toEqual({ kind: 'line', a: p(5, 5), b: p(8, 8) });
    expect(cleaned[5].curve).toEqual({ kind: 'circle', center: p(20, 15), radius: 5 });
    expect(cleaned[6].curve).toEqual({ kind: 'line', a: p(11, 11), b: p(14, 14) });
    expect(cleaned[7].curve).toEqual({ kind: 'line', a: p(8, 8), b: p(11, 11) });
  });

  it("gives the same result whatever order the pieces come in", () => {
    const reference = JSON.stringify(DrawingCleanup.run(drawing, TOL));
    for (const seed of [1, 7, 42, 1234, 99999]) {
      expect(JSON.stringify(DrawingCleanup.run(shuffled(drawing, seed), TOL))).toBe(reference);
    }
  });

  it("is stable when run on its own output", () => {
    const once = DrawingCleanup.run(drawing, TOL);
    expect(DrawingCleanup.run(once, TOL)).toEqual(once);
  });
});
