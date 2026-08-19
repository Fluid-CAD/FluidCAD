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

// Degenerate configurations must not NaN and must not hang: floored
// denominators keep rows finite, λ escalation and the iteration caps
// bound the work, and the outcome reports honestly.

function allFinite(sys: SketchSystem): boolean {
  const values = sys.values;
  for (let i = 0; i < values.length; i++) {
    if (!Number.isFinite(values[i])) {
      return false;
    }
  }
  return true;
}

describe("degenerates", () => {
  it("zero-length line with a length dim terminates finite", () => {
    const sys = new SketchSystem();
    const a = sys.line(5, 5, 5, 5);
    sys.constrain({ kind: "horizontal", a: entityRef(a) });
    sys.constrain({ kind: "distance", a: start(a), b: end(a), value: 10 });
    const result = solve(sys);
    // The length gradient vanishes at zero length — the solver may
    // or may not escape; it must terminate with finite params and an
    // honest outcome.
    expect(["solved", "didnt-converge", "singular"]).toContain(result.outcome);
    expect(allFinite(sys)).toBe(true);
    expect(Number.isFinite(diagnose(sys).dof)).toBe(true);
  });

  it("tangency with the center starting exactly on the line", () => {
    const sys = new SketchSystem();
    const l = sys.line(0, 0, 10, 0);
    const c = sys.circle(5, 0, 2); // on the line: side sign degenerate
    sys.constrain({ kind: "fix", p: start(l) });
    sys.constrain({ kind: "fix", p: end(l) });
    sys.constrain({ kind: "radius", a: entityRef(c), value: 2 });
    sys.constrain({ kind: "tangent", a: entityRef(l), b: entityRef(c) });
    const result = solve(sys);
    expect(result.outcome).toBe("solved");
    expect(allFinite(sys)).toBe(true);
    // Deterministic side pick (cross = 0 reads as +1): center above.
    expect(sys.pointValue(center(c)).y).toBeCloseTo(2, 6);
  });

  it("tangency between coincident-center circles terminates finite", () => {
    const sys = new SketchSystem();
    const a = sys.circle(3, 3, 2);
    const b = sys.circle(3, 3, 2); // same center, same radius
    sys.constrain({ kind: "tangent", a: entityRef(a), b: entityRef(b) });
    const result = solve(sys);
    expect(["solved", "didnt-converge", "singular"]).toContain(result.outcome);
    expect(allFinite(sys)).toBe(true);
  });

  it("concentric + coincident-center stacking stays solvable and names redundancy", () => {
    const sys = new SketchSystem();
    const a = sys.circle(4, 4, 3);
    const b = sys.circle(4.2, 3.9, 1.5);
    sys.constrain({ kind: "concentric", a: entityRef(a), b: entityRef(b) });
    const dup = sys.constrain({ kind: "coincident", a: center(a), b: center(b) });
    sys.constrain({ kind: "radius", a: entityRef(a), value: 3 });
    sys.constrain({ kind: "radius", a: entityRef(b), value: 1.5 });
    const result = solve(sys);
    expect(result.outcome).toBe("solved");
    const diag = diagnose(sys);
    expect(diag.conflicting).toEqual([]);
    expect(diag.redundant).toEqual([dup]);
    const ca = sys.pointValue(center(a));
    const cb = sys.pointValue(center(b));
    expect(ca.x).toBeCloseTo(cb.x, 8);
    expect(ca.y).toBeCloseTo(cb.y, 8);
  });

  it("a wildly perturbed rigid system terminates finite within the iteration cap", () => {
    const sys = new SketchSystem();
    const a = sys.line(0, 0, 100, 0);
    const b = sys.line(100, 0, 100, 80);
    sys.constrain({ kind: "coincident", a: end(a), b: start(b) });
    sys.constrain({ kind: "horizontal", a: entityRef(a) });
    sys.constrain({ kind: "vertical", a: entityRef(b) });
    sys.constrain({ kind: "fix", p: start(a) });
    sys.constrain({ kind: "distance", a: start(a), b: end(a), value: 100 });
    sys.constrain({ kind: "distance", a: start(b), b: end(b), value: 80 });
    const values = sys.values;
    // Scramble hard: all params to hostile magnitudes.
    for (let i = 0; i < values.length; i++) {
      values[i] = (i % 2 === 0 ? 1 : -1) * 1e4 + i * 137;
    }
    const t0 = performance.now();
    const result = solve(sys);
    expect(performance.now() - t0).toBeLessThan(2000);
    expect(["solved", "didnt-converge", "singular"]).toContain(result.outcome);
    expect(allFinite(sys)).toBe(true);
  });

  it("dragging a degenerate zero-length line does not NaN", () => {
    const sys = new SketchSystem();
    const a = sys.line(5, 5, 5, 5);
    const result = solve(sys, { drag: { points: [{ ref: end(a), x: 9, y: 9 }] } });
    expect(["solved", "didnt-converge", "singular"]).toContain(result.outcome);
    expect(allFinite(sys)).toBe(true);
  });
});
