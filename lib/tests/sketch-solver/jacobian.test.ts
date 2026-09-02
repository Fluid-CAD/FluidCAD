import { describe, expect, it } from "vitest";
import { SketchSystem, center, end, entityRef, start } from "../../sketch-solver/index.js";
import { makeLcg } from "../solver-core/synthetic.js";

// Analytic-Jacobian cross-check against centered finite differences
// for every constraint kind and overload form, at random generic
// configurations (the ezpz practice). A menagerie system holds one
// instance of every form; conflicts are irrelevant — rows are only
// evaluated, never solved.

/** FD-verify every compiled row of the system at perturbed configs. */
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
      // Aggregate per unique param (duplicate slots sum).
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
        expect(
          Math.abs(fd - an),
          `row ${k} (constraint ${sys.constraints()[compiled.rowConstraint[k]].id}, ` +
            `${sys.constraints()[compiled.rowConstraint[k]].spec.kind}) ∂/∂p[${gp}]: fd=${fd} analytic=${an}`,
        ).toBeLessThanOrEqual(2e-5 + 1e-4 * Math.abs(an));
      }
    }
  }
}

describe("constraint jacobians vs finite differences", () => {
  it("covers every constraint kind and form", () => {
    const sys = new SketchSystem();
    const pA = sys.point(3.2, -1.7);
    const pB = sys.point(7.9, 4.3);
    const lineA = sys.line(0.5, 1.2, 10.3, 3.7);
    const lineB = sys.line(2.1, 8.9, 9.7, 6.2);
    const lineC = sys.line(-3, -2, 4, -7);
    const circleA = sys.circle(5.5, -4.2, 2.7);
    const circleB = sys.circle(11.2, 2.4, 1.3);
    const circleD = sys.circle(1.2, 0.4, 1.1);
    const circleC = sys.circle(0, 0, 5); // contains circleD at the guess
    const circleE = sys.circle(0.1, 0.2, 3.0);
    const circleF = sys.circle(1.9, 0.3, 1.05); // internal tangency guess vs circleE
    const arcA = sys.arc(-5, 3, -2.1, 3.4, -5.2, 6.1); // + internal arc-consistency rows

    // coincident: p–p, p–line, p–circle, p–arc
    sys.constrain({ kind: "coincident", a: entityRef(pA), b: entityRef(pB) });
    sys.constrain({ kind: "coincident", a: entityRef(pA), b: entityRef(lineA) });
    sys.constrain({ kind: "coincident", a: end(lineB), b: entityRef(circleA) });
    sys.constrain({ kind: "coincident", a: entityRef(pB), b: entityRef(arcA) });
    // horizontal / vertical: line and point-pair forms
    sys.constrain({ kind: "horizontal", a: entityRef(lineA) });
    sys.constrain({ kind: "horizontal", a: entityRef(pA), b: start(lineB) });
    sys.constrain({ kind: "vertical", a: entityRef(lineB) });
    sys.constrain({ kind: "vertical", a: end(arcA), b: entityRef(pB) });
    // parallel / perpendicular / angle
    sys.constrain({ kind: "parallel", a: entityRef(lineA), b: entityRef(lineB) });
    sys.constrain({ kind: "perpendicular", a: entityRef(lineB), b: entityRef(lineC) });
    sys.constrain({ kind: "angle", a: entityRef(lineA), b: entityRef(lineC), value: 0.62 });
    // tangent: line–circle, line–arc, circle–circle external + internal
    sys.constrain({ kind: "tangent", a: entityRef(lineA), b: entityRef(circleA) });
    sys.constrain({ kind: "tangent", a: entityRef(arcA), b: entityRef(lineC) });
    sys.constrain({ kind: "tangent", a: entityRef(circleA), b: entityRef(circleB) });
    sys.constrain({ kind: "tangent", a: entityRef(circleE), b: entityRef(circleF) });
    // distance: p–p, axis x, axis y, p–line, p–circle, line–line,
    // line–circle gap + crossing, c–c external + containment
    sys.constrain({ kind: "distance", a: entityRef(pA), b: entityRef(pB), value: 6.5 });
    sys.constrain({ kind: "distance", a: entityRef(pA), b: end(lineA), value: 4.1, axis: "x" });
    sys.constrain({ kind: "distance", a: start(lineC), b: entityRef(pB), value: 3.3, axis: "y" });
    sys.constrain({ kind: "distance", a: entityRef(pB), b: entityRef(lineC), value: 5.5 });
    sys.constrain({ kind: "distance", a: entityRef(pA), b: entityRef(circleB), value: 2.2 });
    sys.constrain({ kind: "distance", a: entityRef(lineA), b: entityRef(lineB), value: 4.4 });
    sys.constrain({ kind: "distance", a: entityRef(lineB), b: entityRef(circleA), value: 2.1 });
    sys.constrain({ kind: "distance", a: entityRef(circleE), b: entityRef(lineA), value: 0.8 });
    sys.constrain({ kind: "distance", a: entityRef(circleA), b: entityRef(circleB), value: 1.7 });
    sys.constrain({ kind: "distance", a: entityRef(circleC), b: entityRef(circleD), value: 0.9 });
    // distance tangency max: p–circle, line–circle, c–c far sides
    sys.constrain({ kind: "distance", a: entityRef(pA), b: entityRef(circleB), value: 9.9, tangency: "max" });
    sys.constrain({ kind: "distance", a: entityRef(lineB), b: entityRef(circleA), value: 15.2, tangency: "max" });
    sys.constrain({ kind: "distance", a: entityRef(circleA), b: entityRef(circleB), value: 12.1, tangency: "max" });
    // radius / diameter / equal
    sys.constrain({ kind: "radius", a: entityRef(circleA), value: 2.5 });
    sys.constrain({ kind: "radius", a: entityRef(arcA), value: 3.0 });
    sys.constrain({ kind: "diameter", a: entityRef(circleB), value: 2.9 });
    sys.constrain({ kind: "equal", a: entityRef(lineA), b: entityRef(lineC) });
    sys.constrain({ kind: "equal", a: entityRef(circleB), b: entityRef(arcA) });
    // concentric / collinear / midpoint / symmetric / fix
    sys.constrain({ kind: "concentric", a: entityRef(circleA), b: entityRef(arcA) });
    sys.constrain({ kind: "collinear", a: entityRef(lineA), b: entityRef(lineC) });
    sys.constrain({ kind: "midpoint", p: entityRef(pA), l: entityRef(lineB) });
    sys.constrain({ kind: "midpoint", p: entityRef(pB), a: end(lineC), b: center(circleA) });
    sys.constrain({ kind: "symmetric", a: entityRef(pA), b: entityRef(pB), l: entityRef(lineC) });
    sys.constrain({ kind: "fix", p: start(lineA) });

    // 39 user constraint statements + 1 internal arc-consistency.
    expect(sys.constraints().length).toBe(40);
    // Row count: coincident 2+1+1+1, h/v 4×1, par/perp/angle 3×1,
    // tangent 4×1, distance 13×1, radius/diameter 3×1, equal 2×1,
    // concentric 2, collinear 2, midpoint 2+2, symmetric 2, fix 2,
    // arc-consistency 2.
    expect(sys.compiled().rows.length).toBe(48);
    fdCheckRows(sys, [11, 29, 53], 0.25);
  });

  it("junction tangency forms (coincident-pinned) cross-check too", () => {
    const sys = new SketchSystem();
    const lineA = sys.line(0.2, 0.1, 9.8, 1.3);
    const arcA = sys.arc(10.5, 4.2, 9.8, 1.3, 13.6, 4.9);
    const arcB = sys.arc(16.9, 4.1, 13.6, 4.9, 19.8, 7.4);
    const circleA = sys.circle(3.1, -4.2, 4.4);
    const lineB = sys.line(-1.2, -1.9, 6.8, -8.3);
    // line end ↔ arc start pinned: line–arc junction form.
    sys.constrain({ kind: "coincident", a: end(lineA), b: start(arcA) });
    sys.constrain({ kind: "tangent", a: entityRef(lineA), b: entityRef(arcA) });
    // arc end ↔ arc start pinned: circle–circle junction form.
    sys.constrain({ kind: "coincident", a: end(arcA), b: start(arcB) });
    sys.constrain({ kind: "tangent", a: entityRef(arcA), b: entityRef(arcB) });
    // line endpoint declared on the circle: point-on-entity junction.
    sys.constrain({ kind: "coincident", a: start(lineB), b: entityRef(circleA) });
    sys.constrain({ kind: "tangent", a: entityRef(circleA), b: entityRef(lineB) });
    // 6 user + 2 internal arc-consistency records.
    expect(sys.constraints().length).toBe(8);
    // coincident 2+2+1, tangent 1+1+1, arc-consistency 2+2.
    expect(sys.compiled().rows.length).toBe(12);
    fdCheckRows(sys, [5, 31], 0.2);
  });

  it("branch signs are locked from the compile-time guess, not per-eval", () => {
    const sys = new SketchSystem();
    const l = sys.line(0, 0, 10, 0);
    const c = sys.circle(5, 3, 2); // above the line
    sys.constrain({ kind: "tangent", a: entityRef(l), b: entityRef(c) });
    const compiled = sys.compiled();
    const row = compiled.rows[0];
    const p = new Float64Array(sys.values);
    // Center above at distance r: residual 0.
    p[compiled.paramCount - 1] = 3; // r = 3 == cy
    expect(row.eval(p)).toBeCloseTo(0, 12);
    // Mirror the center below the line: with the sign locked to
    // "above", the residual reads −(cy + r), not 0.
    p[compiled.paramCount - 2] = -3; // cy = −3
    expect(row.eval(p)).toBeCloseTo(-6, 12);
  });
});

describe("midpoint forms", () => {
  it("the point-pair form over a line's endpoints compiles the line form's rows", () => {
    const sys = new SketchSystem();
    const l = sys.line(1.2, -0.7, 8.9, 4.3);
    const p1 = sys.point(3.3, 2.2);
    const p2 = sys.point(-1.1, 0.4);
    sys.constrain({ kind: "midpoint", p: entityRef(p1), l: entityRef(l) });
    sys.constrain({ kind: "midpoint", p: entityRef(p2), a: start(l), b: end(l) });
    const rows = sys.compiled().rows;
    expect(rows.length).toBe(4);
    const values = new Float64Array(sys.values);
    // Move p2 onto p1: identical residuals row for row.
    const [lineX, lineY, pairX, pairY] = rows;
    values[pairX.params[0]] = values[lineX.params[0]];
    values[pairY.params[0]] = values[lineY.params[0]];
    expect(pairX.eval(values)).toBeCloseTo(lineX.eval(values), 12);
    expect(pairY.eval(values)).toBeCloseTo(lineY.eval(values), 12);
    expect(pairX.params.slice(1)).toEqual(lineX.params.slice(1));
    expect(pairY.params.slice(1)).toEqual(lineY.params.slice(1));
  });

  it("refuses a line in a point slot with a pointed message", () => {
    const sys = new SketchSystem();
    const l1 = sys.line(0, 0, 10, 0);
    const l2 = sys.line(0, 5, 10, 5);
    const p = sys.point(5, 2);
    expect(() => sys.constrain({ kind: "midpoint", p: entityRef(p), a: entityRef(l1), b: end(l2) }))
      .toThrow(/midpoint first point: line entity 0 does not resolve to a point/);
  });
});
