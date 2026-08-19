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

// Diagnostics: DOF counting, conflicting attribution (rows above
// tolerance at convergence), redundant attribution (satisfied rows
// that don't raise rank), inert rows on fixed geometry. Everything
// keyed by constraint id.

function rectangle(): {
  sys: SketchSystem;
  lines: number[];
  widthDim: number;
} {
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
  const widthDim = sys.constrain({ kind: "distance", a: start(a), b: end(a), value: 100 });
  sys.constrain({ kind: "distance", a: start(b), b: end(b), value: 80 });
  return { sys, lines: [a, b, c, d], widthDim };
}

describe("diagnostics", () => {
  it("DOF ladder: rectangle from loose to rigid", () => {
    const sys = new SketchSystem();
    const a = sys.line(0, 0, 100, 0);
    const b = sys.line(100, 0, 100, 80);
    const c = sys.line(100, 80, 0, 80);
    const d = sys.line(0, 80, 0, 0);
    expect(diagnose(sys).dof).toBe(16);
    sys.constrain({ kind: "coincident", a: end(a), b: start(b) });
    sys.constrain({ kind: "coincident", a: end(b), b: start(c) });
    sys.constrain({ kind: "coincident", a: end(c), b: start(d) });
    sys.constrain({ kind: "coincident", a: end(d), b: start(a) });
    expect(diagnose(sys).dof).toBe(8);
    sys.constrain({ kind: "horizontal", a: entityRef(a) });
    sys.constrain({ kind: "horizontal", a: entityRef(c) });
    sys.constrain({ kind: "vertical", a: entityRef(b) });
    sys.constrain({ kind: "vertical", a: entityRef(d) });
    // x, y, w, h
    expect(diagnose(sys).dof).toBe(4);
    sys.constrain({ kind: "fix", p: start(a) });
    expect(diagnose(sys).dof).toBe(2);
    sys.constrain({ kind: "distance", a: start(a), b: end(a), value: 100 });
    sys.constrain({ kind: "distance", a: start(b), b: end(b), value: 80 });
    expect(diagnose(sys).dof).toBe(0);
  });

  it("a bare circle reports 3 DOF, an arc 5", () => {
    const sys = new SketchSystem();
    sys.circle(10, 10, 5);
    expect(diagnose(sys).dof).toBe(3);
    sys.arc(0, 0, 5, 0, 0, 5);
    // + center 2 + radius 1 + two endpoint angles
    expect(diagnose(sys).dof).toBe(8);
  });

  it("over-dimensioned but consistent: redundant named, still solved", () => {
    const { sys, lines, widthDim } = rectangle();
    const extraDim = sys.constrain({
      kind: "distance",
      a: start(lines[2]),
      b: end(lines[2]),
      value: 100,
    });
    expect(solve(sys).outcome).toBe("solved");
    const diag = diagnose(sys);
    expect(diag.conflicting).toEqual([]);
    expect(diag.dof).toBe(0);
    // One of the two interchangeable width dims is named; which one
    // is greedy-QR-arbitrary but deterministic.
    expect(diag.redundant.length).toBe(1);
    expect([widthDim, extraDim]).toContain(diag.redundant[0]);
  });

  it("contradictory dims: both named conflicting, nothing else", () => {
    const { sys, lines, widthDim } = rectangle();
    const contradiction = sys.constrain({
      kind: "distance",
      a: start(lines[2]),
      b: end(lines[2]),
      value: 120,
    });
    expect(solve(sys).outcome).toBe("didnt-converge");
    const diag = diagnose(sys);
    // The least-squares compromise spreads the 20-unit disagreement
    // across the dims AND the joints between them (bending two
    // coincidents by 5 costs less than one dim by 20), so the
    // conflicting *group* includes the chain — same reporting as
    // FreeCAD's conflicting sets. Both dims must be in it.
    expect(diag.conflicting).toContain(widthDim);
    expect(diag.conflicting).toContain(contradiction);
    expect(diag.redundant).toEqual([]);
  });

  it("duplicated horizontal is redundant, not an error", () => {
    const sys = new SketchSystem();
    const a = sys.line(0, 0, 10, 0.3);
    sys.constrain({ kind: "horizontal", a: entityRef(a) });
    const dup = sys.constrain({ kind: "horizontal", a: entityRef(a) });
    expect(solve(sys).outcome).toBe("solved");
    const diag = diagnose(sys);
    expect(diag.redundant).toEqual([dup]);
    expect(diag.conflicting).toEqual([]);
    expect(diag.dof).toBe(3);
  });

  it("constraints between fixed reference entities are inert: redundant or conflicting", () => {
    const sys = new SketchSystem();
    const refA = sys.line(0, 0, 10, 0, { fixed: true });
    const refB = sys.line(0, 5, 10, 5, { fixed: true });
    const ok = sys.constrain({ kind: "parallel", a: entityRef(refA), b: entityRef(refB) });
    const bad = sys.constrain({ kind: "distance", a: entityRef(refA), b: entityRef(refB), value: 9 });
    expect(solve(sys).outcome).toBe("solved"); // nothing to solve
    const diag = diagnose(sys);
    expect(diag.redundant).toEqual([ok]);
    expect(diag.conflicting).toEqual([bad]);
    expect(diag.dof).toBe(0);
  });

  it("redundancy attribution names the user statement, not the internal arc rows", () => {
    const sys = new SketchSystem();
    const b = sys.arc(0, 0, 5, 0, 0, 5);
    sys.constrain({ kind: "radius", a: entityRef(b), value: 5 });
    // Distance from center to start duplicates radius+consistency.
    const dup = sys.constrain({ kind: "distance", a: center(b), b: start(b), value: 5 });
    expect(solve(sys).outcome).toBe("solved");
    const diag = diagnose(sys);
    expect(diag.redundant).toEqual([dup]);
  });

  it("under-constrained components report per-component DOF", () => {
    const sys = new SketchSystem();
    const a = sys.line(0, 0, 10, 0);
    sys.constrain({ kind: "horizontal", a: entityRef(a) });
    sys.circle(50, 50, 4);
    const diag = diagnose(sys);
    // Components are param-graph precise: the horizontal row links
    // only the two y params, so both x params are singleton
    // components, as are the unconstrained circle's three params.
    expect(diag.components.length).toBe(6);
    expect(diag.components.map((c) => c.dof).sort().join(",")).toBe("1,1,1,1,1,1");
    expect(diag.dof).toBe(6);
  });
});
