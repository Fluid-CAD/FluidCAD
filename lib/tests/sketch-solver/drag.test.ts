import { describe, expect, it } from "vitest";
import {
  SketchSystem,
  end,
  entityRef,
  solve,
  start,
} from "../../sketch-solver/index.js";

// The drag formulation: soft target rows + projection polish, value-
// coincidence glue clusters, λ/plan reuse across frames. Engine
// edition of the P4 rhombus exit criterion.

function square(): { sys: SketchSystem; lines: number[]; } {
  const sys = new SketchSystem();
  const a = sys.line(0, 0, 50, 0);
  const b = sys.line(50, 0, 50, 50);
  const c = sys.line(50, 50, 0, 50);
  const d = sys.line(0, 50, 0, 0);
  sys.constrain({ kind: "coincident", a: end(a), b: start(b) });
  sys.constrain({ kind: "coincident", a: end(b), b: start(c) });
  sys.constrain({ kind: "coincident", a: end(c), b: start(d) });
  sys.constrain({ kind: "coincident", a: end(d), b: start(a) });
  sys.constrain({ kind: "fix", p: start(a) });
  sys.constrain({ kind: "distance", a: start(a), b: end(a), value: 50 });
  return { sys, lines: [a, b, c, d] };
}

describe("drag", () => {
  it("rhombus test, engine edition: constraints hold at every frame", () => {
    const { sys, lines } = square();
    const [a, b, c] = lines;
    expect(solve(sys).outcome).toBe("solved");
    for (let i = 1; i <= 30; i++) {
      const target = { x: 50 + i * 0.7, y: 50 - i * 0.9 };
      const result = solve(sys, { drag: { points: [{ ref: start(c), ...target }] } });
      expect(result.outcome).toBe("solved");
      // Constraints hold exactly (projection polish): fix, dim,
      // coincidences.
      const s = sys.pointValue(start(a));
      expect(s.x).toBeCloseTo(0, 8);
      expect(s.y).toBeCloseTo(0, 8);
      const aStart = sys.pointValue(start(a));
      const aEnd = sys.pointValue(end(a));
      expect(Math.hypot(aEnd.x - aStart.x, aEnd.y - aStart.y)).toBeCloseTo(50, 7);
      const bEnd = sys.pointValue(end(b));
      const cStart = sys.pointValue(start(c));
      expect(bEnd.x).toBeCloseTo(cStart.x, 7);
      expect(bEnd.y).toBeCloseTo(cStart.y, 7);
      // The dragged corner tracks a reachable target closely.
      expect(Math.hypot(cStart.x - target.x, cStart.y - target.y)).toBeLessThan(0.05);
    }
  });

  it("value-coincident chains drag as one cluster (glue on)", () => {
    const sys = new SketchSystem();
    const a = sys.line(0, 0, 10, 0);
    const b = sys.line(10, 0, 20, 5);
    const c = sys.line(20, 5, 30, 0);
    const result = solve(sys, { drag: { points: [{ ref: end(a), x: 12, y: 3 }] } });
    expect(result.outcome).toBe("solved");
    const aEnd = sys.pointValue(end(a));
    const bStart = sys.pointValue(start(b));
    expect(aEnd.x).toBeCloseTo(12, 6);
    expect(aEnd.y).toBeCloseTo(3, 6);
    expect(bStart.x).toBeCloseTo(aEnd.x, 8);
    expect(bStart.y).toBeCloseTo(aEnd.y, 8);
    // The far junction stays glued too.
    const bEnd = sys.pointValue(end(b));
    const cStart = sys.pointValue(start(c));
    expect(bEnd.x).toBeCloseTo(cStart.x, 8);
    expect(bEnd.y).toBeCloseTo(cStart.y, 8);
  });

  it("glue: false moves only the referenced point", () => {
    const sys = new SketchSystem();
    const a = sys.line(0, 0, 10, 0);
    const b = sys.line(10, 0, 20, 5);
    const result = solve(sys, {
      drag: { points: [{ ref: end(a), x: 12, y: 3 }], glue: false },
    });
    expect(result.outcome).toBe("solved");
    const aEnd = sys.pointValue(end(a));
    const bStart = sys.pointValue(start(b));
    expect(aEnd.x).toBeCloseTo(12, 6);
    expect(bStart.x).toBeCloseTo(10, 8); // chain visually breaks
    expect(bStart.y).toBeCloseTo(0, 8);
  });

  it("unreachable target on rigid geometry: solved, constraints win", () => {
    const sys = new SketchSystem();
    const a = sys.line(0, 0, 50, 0);
    sys.constrain({ kind: "fix", p: start(a) });
    sys.constrain({ kind: "fix", p: end(a) });
    const result = solve(sys, { drag: { points: [{ ref: end(a), x: 80, y: 40 }] } });
    expect(result.outcome).toBe("solved");
    const e = sys.pointValue(end(a));
    expect(e.x).toBeCloseTo(50, 7);
    expect(e.y).toBeCloseTo(0, 7);
  });

  it("a repeated identical frame fixed-point-skips", () => {
    const { sys, lines } = square();
    solve(sys);
    const target = { x: 55, y: 45 };
    solve(sys, { drag: { points: [{ ref: start(lines[2]), ...target }] } });
    const repeat = solve(sys, { drag: { points: [{ ref: start(lines[2]), ...target }] } });
    expect(repeat.outcome).toBe("solved");
    expect(repeat.iters).toBe(0);
  });

  it("plan cache: a drag gesture reuses its plans across frames", () => {
    const { sys, lines } = square();
    solve(sys);
    solve(sys, { drag: { points: [{ ref: start(lines[2]), x: 51, y: 49 }] } });
    const cache = sys.planCache!;
    const planCount = cache.plans.size;
    solve(sys, { drag: { points: [{ ref: start(lines[2]), x: 52, y: 48 }] } });
    expect(sys.planCache!.plans.size).toBe(planCount); // no new plans built
    expect(sys.planCache).toBe(cache);
  });
});
