import { describe, expect, it } from "vitest";
import {
  SketchSystem, Y_AXIS_ENTITY, center, diagnose, end, entityRef, solve, start,
} from "../../sketch-solver/index.js";
import { makeLcg } from "../solver-core/synthetic.js";

// symmetric — the ENTITY forms (two lines / circles / arcs across a line):
// exact row counts (no redundancy against the arc consistency rows),
// bidirectional coupling, semicircles solvable, and analytic Jacobians
// matching finite differences for the new reflected-ray row.

function fdCheckRows(sys: SketchSystem, seeds: number[], amp: number): void {
  const compiled = sys.compiled();
  expect(compiled.rows.length).toBeGreaterThan(0);
  for (const seed of seeds) {
    const rand = makeLcg(seed);
    const p = new Float64Array(sys.values);
    for (let i = 0; i < p.length; i++) {
      p[i] += (rand() * 2 - 1) * amp;
    }
    for (let k = 0; k < compiled.rows.length; k++) {
      const row = compiled.rows[k];
      const analytic = new Float64Array(row.params.length);
      row.jac(p, analytic);
      const byParam = new Map<number, number>();
      for (let s = 0; s < row.params.length; s++) {
        byParam.set(row.params[s], (byParam.get(row.params[s]) ?? 0) + analytic[s]);
      }
      for (const [gp, an] of byParam) {
        const h = 1e-6 * Math.max(1, Math.abs(p[gp]));
        const saved = p[gp];
        p[gp] = saved + h;
        const plus = row.eval(p);
        p[gp] = saved - h;
        const minus = row.eval(p);
        p[gp] = saved;
        const fd = (plus - minus) / (2 * h);
        expect(Math.abs(fd - an), `row ${k} ∂/∂p[${gp}]: fd=${fd} analytic=${an}`)
          .toBeLessThanOrEqual(2e-5 + 1e-4 * Math.abs(an));
      }
    }
  }
}

describe("symmetric — entity forms", () => {
  it("two lines: 4 rows, constraining the image drives the source", () => {
    const sys = new SketchSystem();
    sys.ensureDatums();
    const a = sys.line(10, 0, 30, 6);
    const b = sys.line(-10, 0, -30, 6);
    sys.constrain({ kind: "symmetric", a: entityRef(a), b: entityRef(b), l: entityRef(Y_AXIS_ENTITY) });
    expect(sys.compiled().rows.length).toBe(4);
    sys.constrain({ kind: "fix", p: start(b) });
    sys.constrain({ kind: "horizontal", a: entityRef(b) });
    sys.constrain({ kind: "distance", a: start(b), b: end(b), value: 25 });
    expect(solve(sys).outcome).toBe("solved");
    expect(sys.pointValue(end(a)).x).toBeCloseTo(35, 6);
    expect(sys.pointValue(end(a)).y).toBeCloseTo(0, 6);
    expect(diagnose(sys).dof).toBe(0);
  });

  it("two circles: centers mirror and radii stay equal (3 rows)", () => {
    const sys = new SketchSystem();
    sys.ensureDatums();
    const a = sys.circle(20, 5, 7);
    const b = sys.circle(-20, 5, 7);
    sys.constrain({ kind: "symmetric", a: entityRef(a), b: entityRef(b), l: entityRef(Y_AXIS_ENTITY) });
    expect(sys.compiled().rows.length).toBe(3);
    sys.constrain({ kind: "radius", a: entityRef(b), value: 9 });
    sys.constrain({ kind: "fix", p: center(a), x: 25, y: 8 });
    expect(solve(sys).outcome).toBe("solved");
    expect(sys.values[sys.entity(a).paramOffset + 2]).toBeCloseTo(9, 7);
    expect(sys.pointValue(center(b)).x).toBeCloseTo(-25, 7);
    expect(sys.pointValue(center(b)).y).toBeCloseTo(8, 7);
  });

  it("two arcs: 5 rows, exact against the consistency rows, a semicircle solves cleanly", () => {
    const sys = new SketchSystem();
    sys.ensureDatums();
    // A semicircle on the right, its mirror on the left.
    const a = sys.arc(20, 0, 20, -10, 20, 10);
    const b = sys.arc(-20, 0, -20, -10, -20, 10);
    const id = sys.constrain({ kind: "symmetric", a: entityRef(a), b: entityRef(b), l: entityRef(Y_AXIS_ENTITY) });
    // 5 user rows + 2×2 arc-consistency rows.
    expect(sys.compiled().rows.length).toBe(9);
    sys.constrain({ kind: "fix", p: center(a), x: 25, y: 3 });
    sys.constrain({ kind: "fix", p: start(a), x: 25, y: -9 });
    // The chord pins a's end angle (its radius already follows from the
    // pinned center and start through the consistency row).
    sys.constrain({ kind: "distance", a: start(a), b: end(a), value: 20 });
    expect(solve(sys).outcome).toBe("solved");
    const d = diagnose(sys);
    expect(d.dof).toBe(0);
    expect(d.redundant).not.toContain(id);
    expect(d.conflicting).toEqual([]);
    expect(sys.pointValue(center(b)).x).toBeCloseTo(-25, 6);
    expect(sys.pointValue(start(b)).y).toBeCloseTo(-9, 6);
    // b's end is the reflection of a's end, and both radii follow.
    const ea = sys.pointValue(end(a));
    const eb = sys.pointValue(end(b));
    expect(eb.x).toBeCloseTo(-ea.x, 6);
    expect(eb.y).toBeCloseTo(ea.y, 6);
    expect(Math.hypot(ea.x - 25, ea.y - 3)).toBeCloseTo(12, 6);
    expect(Math.hypot(ea.x - 25, ea.y + 9)).toBeCloseTo(20, 6);
    expect(sys.values[sys.entity(b).paramOffset + 2]).toBeCloseTo(12, 6);
  });

  it("a moving mirror LINE carries the mirrored entities with it", () => {
    const sys = new SketchSystem();
    const axis = sys.line(0, -20, 0, 40);
    const a = sys.line(10, 0, 30, 0);
    const b = sys.line(-10, 0, -30, 0);
    sys.constrain({ kind: "symmetric", a: entityRef(a), b: entityRef(b), l: entityRef(axis) });
    sys.constrain({ kind: "fix", p: start(a) });
    sys.constrain({ kind: "fix", p: end(a) });
    sys.constrain({ kind: "vertical", a: entityRef(axis) });
    sys.constrain({ kind: "fix", p: start(axis), x: 5, y: -20 });
    expect(solve(sys).outcome).toBe("solved");
    expect(sys.pointValue(start(b)).x).toBeCloseTo(0, 6);
    expect(sys.pointValue(end(b)).x).toBeCloseTo(-20, 6);
  });

  it("refuses mixed forms", () => {
    const sys = new SketchSystem();
    sys.ensureDatums();
    const p = sys.point(1, 1);
    const l = sys.line(0, 0, 1, 0);
    const c = sys.circle(3, 3, 1);
    expect(() => sys.constrain({ kind: "symmetric", a: entityRef(p), b: entityRef(l), l: entityRef(Y_AXIS_ENTITY) }))
      .toThrow(/two points, or two lines/);
    expect(() => sys.constrain({ kind: "symmetric", a: entityRef(c), b: entityRef(l), l: entityRef(Y_AXIS_ENTITY) }))
      .toThrow(/same kind/);
  });

  it("analytic Jacobians match finite differences for every entity form", () => {
    const sys = new SketchSystem();
    const axis = sys.line(-3.1, -2.2, 4.4, 7.3);
    const la = sys.line(0.5, 1.2, 10.3, 3.7);
    const lb = sys.line(2.1, 8.9, 9.7, 6.2);
    const ca = sys.circle(5.5, -4.2, 2.7);
    const cb = sys.circle(11.2, 2.4, 1.3);
    const aa = sys.arc(10.5, 4.2, 9.8, 1.3, 13.6, 4.9);
    const ab = sys.arc(-6.9, 4.1, -3.6, 4.9, -9.8, 7.4);
    sys.constrain({ kind: "symmetric", a: entityRef(la), b: entityRef(lb), l: entityRef(axis) });
    sys.constrain({ kind: "symmetric", a: entityRef(ca), b: entityRef(cb), l: entityRef(axis) });
    sys.constrain({ kind: "symmetric", a: entityRef(aa), b: entityRef(ab), l: entityRef(axis) });
    // 4 + 3 + 5 user rows + 2×2 arc-consistency rows.
    expect(sys.compiled().rows.length).toBe(16);
    fdCheckRows(sys, [7, 19, 41], 0.25);
  });
});
