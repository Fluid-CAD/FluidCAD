import { describe, expect, it } from "vitest";
import { buildPlan } from "../../sketch-solver/decompose.js";
import {
  SketchSystem,
  end,
  entityRef,
  solve,
  start,
} from "../../sketch-solver/index.js";

// Decomposition + RCM: independent components solve independently,
// fixed params don't transmit coupling, and the RCM ordering keeps
// the normal-matrix envelope narrow even for closed rings (whose
// natural ordering has a full-width closing row).

describe("decomposition", () => {
  it("disjoint profiles are separate components and both solve", () => {
    const sys = new SketchSystem();
    const a = sys.line(0, 0, 10, 0.2);
    sys.constrain({ kind: "horizontal", a: entityRef(a) });
    const b = sys.line(100, 100, 110, 99.7);
    sys.constrain({ kind: "horizontal", a: entityRef(b) });
    const result = solve(sys);
    expect(result.outcome).toBe("solved");
    expect(result.components.length).toBe(2);
    expect(sys.pointValue(end(a)).y).toBeCloseTo(sys.pointValue(start(a)).y, 9);
    expect(sys.pointValue(end(b)).y).toBeCloseTo(sys.pointValue(start(b)).y, 9);
  });

  it("fixed reference geometry does not merge components", () => {
    const sys = new SketchSystem();
    const datum = sys.line(0, 0, 100, 0, { fixed: true });
    const p1 = sys.point(10, 3);
    const p2 = sys.point(90, -2);
    sys.constrain({ kind: "coincident", a: entityRef(p1), b: entityRef(datum) });
    sys.constrain({ kind: "coincident", a: entityRef(p2), b: entityRef(datum) });
    const result = solve(sys);
    expect(result.outcome).toBe("solved");
    // Two separate 2-param components, not one 4-param blob.
    expect(result.components.length).toBe(2);
    expect(sys.pointValue(entityRef(p1)).y).toBeCloseTo(0, 8);
    expect(sys.pointValue(entityRef(p2)).y).toBeCloseTo(0, 8);
  });

  it("coincidents alone split into per-axis micro-components", () => {
    // A coincident's x row and y row touch disjoint params, and
    // nothing couples a line's own params — so a bare chain shatters
    // into tiny independent solves. This is the param-graph
    // decomposition working as designed.
    const sys = new SketchSystem();
    const a = sys.line(0, 0, 10, 0);
    const b = sys.line(10, 0, 20, 5);
    sys.constrain({ kind: "coincident", a: end(a), b: start(b) });
    const plan = buildPlan(sys.compiled(), [], []);
    expect(plan.comps.length).toBe(2);
    expect(plan.comps.every((c) => c.params.length === 2)).toBe(true);
  });

  it("RCM keeps the envelope narrow on a closed ring", () => {
    // 40 dimensioned lines in a closed loop: length dims couple each
    // line's params; the closing coincident links the last entity to
    // the first, which under natural ordering makes a full-width
    // band. RCM must reorder to a narrow one.
    const sys = new SketchSystem();
    const n = 40;
    const lines: number[] = [];
    for (let i = 0; i < n; i++) {
      const a0 = (i / n) * 2 * Math.PI;
      const a1 = ((i + 1) / n) * 2 * Math.PI;
      lines.push(sys.line(50 * Math.cos(a0), 50 * Math.sin(a0), 50 * Math.cos(a1), 50 * Math.sin(a1)));
    }
    const segment = 2 * 50 * Math.sin(Math.PI / n);
    for (let i = 0; i < n; i++) {
      sys.constrain({ kind: "coincident", a: end(lines[i]), b: start(lines[(i + 1) % n]) });
      sys.constrain({ kind: "distance", a: start(lines[i]), b: end(lines[i]), value: segment });
    }
    const plan = buildPlan(sys.compiled(), [], []);
    expect(plan.comps.length).toBe(1);
    const comp = plan.comps[0];
    const firstNz = comp.workspace.firstNz;
    let bandwidth = 0;
    for (let i = 0; i < firstNz.length; i++) {
      bandwidth = Math.max(bandwidth, i - firstNz[i]);
    }
    // 160 params; natural order would give bandwidth ~156. A ring's
    // RCM bandwidth is small and n-independent.
    expect(bandwidth).toBeLessThanOrEqual(16);
    expect(solve(sys).outcome).toBe("solved");
  });

  it("rows on fully fixed geometry are inert, not solved", () => {
    const sys = new SketchSystem();
    const refA = sys.line(0, 0, 10, 0, { fixed: true });
    sys.constrain({ kind: "horizontal", a: entityRef(refA) });
    const result = solve(sys);
    expect(result.outcome).toBe("solved");
    expect(result.components.length).toBe(0);
  });
});
