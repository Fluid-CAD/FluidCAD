import { describe, expect, it } from "vitest";
import {
  SketchSystem,
  center,
  diagnose,
  end,
  entityRef,
  solve,
  start,
} from "../../sketch-solver/index.js";
import { makeLcg } from "../solver-core/synthetic.js";

// Golden solves: known configurations from noisy guesses must land on
// the exact geometry. These are the engine's never-rewrite regressions
// (cross-cutting rule 4) — named for what they pin down.

function perturb(sys: SketchSystem, amp: number, seed: number): void {
  const rand = makeLcg(seed);
  const values = sys.values;
  for (let i = 0; i < values.length; i++) {
    values[i] += (rand() * 2 - 1) * amp;
  }
}

function expectPoint(sys: SketchSystem, ref: Parameters<SketchSystem["pointValue"]>[0], x: number, y: number): void {
  const p = sys.pointValue(ref);
  expect(p.x).toBeCloseTo(x, 6);
  expect(p.y).toBeCloseTo(y, 6);
}

/** Rectangle: 4 lines, 4 coincidents, h/v, fix, two dims → rigid. */
function buildRectangle(): { sys: SketchSystem; a: number; b: number; c: number; d: number; dims: number[] } {
  const sys = new SketchSystem();
  const a = sys.line(0, 0, 100, 0);
  const b = sys.line(100, 0, 100, 80);
  const c = sys.line(100, 80, 0, 80);
  const d = sys.line(0, 80, 0, 0);
  sys.constrain({ kind: "coincident", a: end(a), b: start(b) });
  sys.constrain({ kind: "coincident", a: end(b), b: start(c) });
  sys.constrain({ kind: "coincident", a: end(c), b: start(d) });
  sys.constrain({ kind: "coincident", a: end(d), b: start(a) });
  sys.constrain({ kind: "horizontal", a: entityRef(a) });
  sys.constrain({ kind: "horizontal", a: entityRef(c) });
  sys.constrain({ kind: "vertical", a: entityRef(b) });
  sys.constrain({ kind: "vertical", a: entityRef(d) });
  sys.constrain({ kind: "fix", p: start(a) });
  const dims = [
    sys.constrain({ kind: "distance", a: start(a), b: end(a), value: 100 }),
    sys.constrain({ kind: "distance", a: start(b), b: end(b), value: 80 }),
  ];
  return { sys, a, b, c, d, dims };
}

describe("golden solves", () => {
  it("rectangle from noisy guesses", () => {
    const { sys, a, b, c } = buildRectangle();
    perturb(sys, 0.6, 41);
    const result = solve(sys);
    expect(result.outcome).toBe("solved");
    expectPoint(sys, start(a), 0, 0);
    expectPoint(sys, end(a), 100, 0);
    expectPoint(sys, end(b), 100, 80);
    expectPoint(sys, end(c), 0, 80);
    expect(diagnose(sys).dof).toBe(0);
  });

  it("slot: lines + arcs, tangents, equal radii", () => {
    const sys = new SketchSystem();
    const a = sys.line(0, 0, 60, 0);
    const b = sys.arc(60, 10, 60, 0, 60, 20);
    const c = sys.line(60, 20, 0, 20);
    const d = sys.arc(0, 10, 0, 20, 0, 0);
    sys.constrain({ kind: "coincident", a: end(a), b: start(b) });
    sys.constrain({ kind: "coincident", a: end(b), b: start(c) });
    sys.constrain({ kind: "coincident", a: end(c), b: start(d) });
    sys.constrain({ kind: "coincident", a: end(d), b: start(a) });
    sys.constrain({ kind: "tangent", a: entityRef(a), b: entityRef(b) });
    sys.constrain({ kind: "tangent", a: entityRef(c), b: entityRef(b) });
    sys.constrain({ kind: "tangent", a: entityRef(c), b: entityRef(d) });
    sys.constrain({ kind: "tangent", a: entityRef(a), b: entityRef(d) });
    sys.constrain({ kind: "horizontal", a: entityRef(a) });
    sys.constrain({ kind: "fix", p: start(a) });
    sys.constrain({ kind: "radius", a: entityRef(b), value: 10 });
    sys.constrain({ kind: "equal", a: entityRef(b), b: entityRef(d) });
    sys.constrain({ kind: "distance", a: start(a), b: end(a), value: 60 });
    perturb(sys, 0.4, 7);
    const result = solve(sys);
    expect(result.outcome).toBe("solved");
    expect(diagnose(sys).dof).toBe(0);
    expectPoint(sys, center(b), 60, 10);
    expectPoint(sys, center(d), 0, 10);
    expectPoint(sys, start(c), 60, 20);
    expectPoint(sys, end(c), 0, 20);
    const rIdx = sys.entity(b).paramOffset + 2;
    expect(sys.values[rIdx]).toBeCloseTo(10, 6);
  });

  it("tangent-arc chain: H line into a CCW quarter arc into a V line", () => {
    const sys = new SketchSystem();
    const a = sys.line(0, 0, 10, 0);
    const b = sys.arc(10, 3, 10, 0, 13, 3);
    const c = sys.line(13, 3, 13, 13);
    sys.constrain({ kind: "coincident", a: end(a), b: start(b) });
    sys.constrain({ kind: "coincident", a: end(b), b: start(c) });
    sys.constrain({ kind: "tangent", a: entityRef(a), b: entityRef(b) });
    sys.constrain({ kind: "tangent", a: entityRef(c), b: entityRef(b) });
    sys.constrain({ kind: "horizontal", a: entityRef(a) });
    sys.constrain({ kind: "vertical", a: entityRef(c) });
    sys.constrain({ kind: "fix", p: start(a) });
    sys.constrain({ kind: "distance", a: start(a), b: end(a), value: 10 });
    sys.constrain({ kind: "radius", a: entityRef(b), value: 3 });
    sys.constrain({ kind: "distance", a: start(c), b: end(c), value: 10 });
    perturb(sys, 0.35, 19);
    const result = solve(sys);
    expect(result.outcome).toBe("solved");
    expectPoint(sys, end(a), 10, 0);
    expectPoint(sys, center(b), 10, 3);
    expectPoint(sys, start(c), 13, 3);
    expectPoint(sys, end(c), 13, 13);
    // One DOF short of rigid is wrong here: chain ends on a line and
    // everything is dimensioned.
    expect(diagnose(sys).dof).toBe(0);
  });

  it("dimensioned bracket: bore positioned off two edges", () => {
    const { sys, a, b } = buildRectangle();
    const bore = sys.circle(55, 35, 10);
    sys.constrain({ kind: "distance", a: center(bore), b: entityRef(b), value: 30 });
    sys.constrain({ kind: "distance", a: center(bore), b: entityRef(a), value: 40 });
    sys.constrain({ kind: "radius", a: entityRef(bore), value: 12 });
    perturb(sys, 0.5, 23);
    const result = solve(sys);
    expect(result.outcome).toBe("solved");
    expectPoint(sys, center(bore), 70, 40);
    expect(sys.values[sys.entity(bore).paramOffset + 2]).toBeCloseTo(12, 6);
    expect(diagnose(sys).dof).toBe(0);
  });

  it("line–arc distance: gap measured to the circumference, not the center", () => {
    const sys = new SketchSystem();
    const l = sys.line(0, 0, 0, 100);
    const a = sys.arc(148, 50, 128, 50, 168, 50);
    sys.constrain({ kind: "vertical", a: entityRef(l) });
    sys.constrain({ kind: "fix", p: start(l) });
    sys.constrain({ kind: "distance", a: start(l), b: end(l), value: 100 });
    sys.constrain({ kind: "radius", a: entityRef(a), value: 20 });
    sys.constrain({ kind: "distance", a: entityRef(l), b: entityRef(a), value: 130 });
    perturb(sys, 0.4, 31);
    const result = solve(sys);
    expect(result.outcome).toBe("solved");
    // Gap 130 to a radius-20 circumference puts the center 150 off the line.
    expect(sys.pointValue(center(a)).x).toBeCloseTo(150, 6);
    expect(sys.values[sys.entity(a).paramOffset + 2]).toBeCloseTo(20, 6);
  });

  it("line–circle distance: crossing guess locks the chord-depth branch", () => {
    const sys = new SketchSystem();
    const l = sys.line(0, 0, 20, 0);
    const c = sys.circle(5, 2, 10); // center 2 above a line that crosses it
    sys.constrain({ kind: "horizontal", a: entityRef(l) });
    sys.constrain({ kind: "fix", p: start(l) });
    sys.constrain({ kind: "distance", a: start(l), b: end(l), value: 20 });
    sys.constrain({ kind: "radius", a: entityRef(c), value: 10 });
    sys.constrain({ kind: "distance", a: entityRef(c), b: entityRef(l), value: 4 });
    perturb(sys, 0.3, 37);
    const result = solve(sys);
    expect(result.outcome).toBe("solved");
    // Crossing branch: r − |perp| = 4 → the center sits 6 above, still inside.
    expect(sys.pointValue(center(c)).y).toBeCloseTo(6, 6);
  });

  it("under-constrained: untouched DOF stay exactly at their guesses", () => {
    const sys = new SketchSystem();
    const a = sys.line(0, 0, 10, 0);
    const b = sys.line(10, 0, 20, 5);
    const island = sys.circle(40, 40, 3); // separate component, nothing constrains it
    sys.constrain({ kind: "coincident", a: end(a), b: start(b) });
    const before = Array.from(sys.values);
    const result = solve(sys);
    expect(result.outcome).toBe("solved");
    // Guesses already satisfy the coincidence: fixed-point skip, zero
    // iterations, bit-identical params.
    expect(result.iters).toBe(0);
    expect(Array.from(sys.values)).toEqual(before);
    const diag = diagnose(sys);
    // 4 + 4 + 3 params, minus 2 (coincident): the island's 3 DOF are
    // counted too.
    expect(diag.dof).toBe(9);
    expect(sys.entity(island).kind).toBe("circle");
  });

  it("under-constrained solve moves minimally, leaving far entities alone", () => {
    const sys = new SketchSystem();
    const a = sys.line(0, 0, 10, 0);
    const b = sys.line(11, 0.5, 20, 5); // start off a.end by (1, 0.5)
    const island = sys.circle(40, 40, 3);
    sys.constrain({ kind: "coincident", a: end(a), b: start(b) });
    const islandOffset = sys.entity(island).paramOffset;
    const before = Array.from(sys.values);
    const result = solve(sys);
    expect(result.outcome).toBe("solved");
    // The joint closes near the midpoint of the gap; far endpoints
    // barely move (minimum-norm-near-guess semantics).
    const aEnd = sys.pointValue(end(a));
    const bStart = sys.pointValue(start(b));
    expect(aEnd.x).toBeCloseTo(bStart.x, 8);
    expect(aEnd.y).toBeCloseTo(bStart.y, 8);
    expect(aEnd.x).toBeGreaterThan(10);
    expect(aEnd.x).toBeLessThan(11);
    expect(Math.abs(sys.pointValue(start(a)).x - 0)).toBeLessThan(0.2);
    // The island component is untouched entirely.
    for (let i = 0; i < 3; i++) {
      expect(sys.values[islandOffset + i]).toBe(before[islandOffset + i]);
    }
  });

  it("constraint insertion order does not change the solution", () => {
    const build = (flip: boolean): Float64Array => {
      const sys = new SketchSystem();
      const a = sys.line(0, 0, 100, 0);
      const b = sys.line(100, 0, 100, 80);
      const c = sys.line(100, 80, 0, 80);
      const d = sys.line(0, 80, 0, 0);
      const specs: Parameters<SketchSystem["constrain"]>[0][] = [
        { kind: "coincident", a: end(a), b: start(b) },
        { kind: "coincident", a: end(b), b: start(c) },
        { kind: "coincident", a: end(c), b: start(d) },
        { kind: "coincident", a: end(d), b: start(a) },
        { kind: "horizontal", a: entityRef(a) },
        { kind: "horizontal", a: entityRef(c) },
        { kind: "vertical", a: entityRef(b) },
        { kind: "vertical", a: entityRef(d) },
        { kind: "fix", p: start(a) },
        { kind: "distance", a: start(a), b: end(a), value: 100 },
        { kind: "distance", a: start(b), b: end(b), value: 80 },
      ];
      if (flip) {
        specs.reverse();
      }
      for (const spec of specs) {
        sys.constrain(spec);
      }
      perturb(sys, 0.6, 41);
      expect(solve(sys).outcome).toBe("solved");
      return sys.values;
    };
    const forward = build(false);
    const reversed = build(true);
    for (let i = 0; i < forward.length; i++) {
      expect(reversed[i]).toBeCloseTo(forward[i], 7);
    }
  });
});
