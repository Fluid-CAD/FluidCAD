import { describe, expect, it } from "vitest";
import {
  SketchSystem,
  diagnose,
  end,
  entityRef,
  solve,
  start,
} from "../../sketch-solver/index.js";

// Degenerate-collapse guard (solve.ts): direction constraints with
// absolute residuals (vertical's dx, parallel's cross) vanish as a
// line's length → 0 while scale-invariant residuals (angle's atan2)
// stay satisfiable at any tiny length, so LM could "solve" a truly
// conflicting sketch by collapsing an entity — reporting solved with
// nothing for diagnose to name (Marwan's H+V+angle(80°) triangle
// rendered as one horizontal line). The guard detects the collapse,
// re-solves with internal size pins, and the conflict materializes.

/** Marwan's triangle: l1 horizontal, l3 vertical, angle(l3, l1) = 80°. */
function triangle(): {
  sys: SketchSystem;
  l1: number;
  l2: number;
  l3: number;
  ids: { h: number; v: number; dim: number; ang: number };
} {
  const sys = new SketchSystem();
  const l2 = sys.line(234.16, 199.21, 120.59, 160.45);
  const l1 = sys.line(120.59, 160.45, 234.16, 160.45);
  const l3 = sys.line(234.16, 160.45, 234.16, 199.21);
  const h = sys.constrain({ kind: "horizontal", a: entityRef(l1) });
  sys.constrain({ kind: "coincident", a: end(l2), b: start(l1) });
  sys.constrain({ kind: "coincident", a: start(l3), b: end(l1) });
  const v = sys.constrain({ kind: "vertical", a: entityRef(l3) });
  sys.constrain({ kind: "coincident", a: start(l2), b: end(l3) });
  const dim = sys.constrain({ kind: "distance", a: end(l2), b: start(l2), value: 120 });
  const ang = sys.constrain({
    kind: "angle",
    a: entityRef(l3),
    b: entityRef(l1),
    value: (80 * Math.PI) / 180,
  });
  return { sys, l1, l2, l3, ids: { h, v, dim, ang } };
}

function lineLength(sys: SketchSystem, id: number): number {
  const o = sys.entity(id).paramOffset;
  const p = sys.values;
  return Math.hypot(p[o + 2] - p[o], p[o + 3] - p[o + 1]);
}

describe("degenerate-collapse guard", () => {
  it("H + V + angle(80°): the vertical leg does not collapse and the conflict is named", () => {
    const { sys, l3, ids } = triangle();
    const result = solve(sys);
    // Without the guard this reported "solved" with l3 at ~5e-8 length.
    expect(result.outcome).not.toBe("solved");
    expect(result.collapsed).toEqual([l3]);
    expect(lineLength(sys, l3)).toBeGreaterThan(1);

    const diag = diagnose(sys);
    // The mutually inconsistent cluster: H and V lock the angle at
    // ±90°, the dimension demands 80°.
    expect(diag.conflicting).toEqual([ids.h, ids.v, ids.ang]);
    // The loop coincidents and the 120 length dim are innocent.
    expect(diag.redundant).toEqual([]);
  });

  it("H + V + parallel on the same pair collapses the same way and is caught", () => {
    const sys = new SketchSystem();
    const l1 = sys.line(0, 0, 100, 0);
    const l3 = sys.line(100, 0, 100, 40);
    sys.constrain({ kind: "coincident", a: end(l1), b: start(l3) });
    const h = sys.constrain({ kind: "horizontal", a: entityRef(l1) });
    const v = sys.constrain({ kind: "vertical", a: entityRef(l3) });
    const par = sys.constrain({ kind: "parallel", a: entityRef(l1), b: entityRef(l3) });
    const result = solve(sys);
    expect(result.outcome).not.toBe("solved");
    expect(lineLength(sys, l1)).toBeGreaterThan(1);
    expect(lineLength(sys, l3)).toBeGreaterThan(1);

    const conflicting = diagnose(sys).conflicting;
    expect(conflicting).toContain(par);
    expect(conflicting.every((id) => [h, v, par].includes(id))).toBe(true);
  });

  it("a legitimately tiny dimension does not trip the guard", () => {
    const sys = new SketchSystem();
    const a = sys.line(0, 0, 40, 0);
    sys.constrain({ kind: "horizontal", a: entityRef(a) });
    sys.constrain({ kind: "fix", p: start(a) });
    sys.constrain({ kind: "distance", a: start(a), b: end(a), value: 0.01 });
    const result = solve(sys);
    expect(result.outcome).toBe("solved");
    expect(result.collapsed).toBeUndefined();
    expect(lineLength(sys, a)).toBeCloseTo(0.01, 6);
    expect(diagnose(sys).conflicting).toEqual([]);
  });

  it("the consistent 90° variant solves clean with no collapse", () => {
    const consistent = new SketchSystem();
    const a = consistent.line(0, 0, 100, 0);
    const b = consistent.line(100, 0, 100, 40);
    consistent.constrain({ kind: "coincident", a: end(a), b: start(b) });
    consistent.constrain({ kind: "horizontal", a: entityRef(a) });
    consistent.constrain({
      kind: "angle",
      a: entityRef(b),
      b: entityRef(a),
      value: (90 * Math.PI) / 180,
    });
    const result = solve(consistent);
    expect(result.outcome).toBe("solved");
    expect(result.collapsed).toBeUndefined();
    expect(diagnose(consistent).conflicting).toEqual([]);
  });
});
