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

// The ellipse entity [cx, cy, rx, ry, θ]: five free params, like a circle's
// three. Every new row form gets a finite-difference Jacobian check (the
// jacobian.test.ts discipline) plus a behavioural solve pinning what the
// constraint MEANS; the aux-param contact forms additionally pin the
// carry-across-recompile contract the UI's drag loop relies on.

/** Dimension both semi-radii: the fixed-shape scenarios below. */
function pinShape(sys: SketchSystem, ell: number, rx: number, ry: number): void {
  sys.constrain({ kind: "radius", a: entityRef(ell), value: rx, axis: "x" });
  sys.constrain({ kind: "radius", a: entityRef(ell), value: ry, axis: "y" });
}

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
        const record = sys.constraints()[compiled.rowConstraint[k]];
        expect(
          Math.abs(fd - an),
          `row ${k} (constraint ${record.id}, ${record.spec.kind}) ∂/∂p[${gp}]: fd=${fd} analytic=${an}`,
        ).toBeLessThanOrEqual(2e-5 + 1e-4 * Math.abs(an));
      }
    }
  }
}

/** Implicit ellipse function at a point: 0 on the curve. */
function implicit(sys: SketchSystem, ell: number, x: number, y: number): number {
  const e = sys.entity(ell);
  const p = sys.values;
  const o = e.paramOffset;
  const dx = x - p[o];
  const dy = y - p[o + 1];
  const c = Math.cos(p[o + 4]);
  const s = Math.sin(p[o + 4]);
  const xp = dx * c + dy * s;
  const yp = -dx * s + dy * c;
  return (xp * xp) / (p[o + 2] * p[o + 2]) + (yp * yp) / (p[o + 3] * p[o + 3]) - 1;
}

/** Sampled lowest y of the ellipse's outline. */
function sampledMinY(sys: SketchSystem, ell: number): number {
  const e = sys.entity(ell);
  const p = sys.values;
  const o = e.paramOffset;
  let best = Infinity;
  const n = 20000;
  for (let i = 0; i < n; i++) {
    const t = (i / n) * 2 * Math.PI;
    const xp = p[o + 2] * Math.cos(t);
    const yp = p[o + 3] * Math.sin(t);
    const py = p[o + 1] + xp * Math.sin(p[o + 4]) + yp * Math.cos(p[o + 4]);
    best = Math.min(best, py);
  }
  return best;
}

/** Sampled minimum / maximum distance from a point to the ellipse. */
function sampledDistance(sys: SketchSystem, ell: number, x: number, y: number, mode: 'min' | 'max'): number {
  const e = sys.entity(ell);
  const p = sys.values;
  const o = e.paramOffset;
  let best = mode === 'min' ? Infinity : -Infinity;
  const n = 20000;
  for (let i = 0; i < n; i++) {
    const t = (i / n) * 2 * Math.PI;
    const xp = p[o + 2] * Math.cos(t);
    const yp = p[o + 3] * Math.sin(t);
    const c = Math.cos(p[o + 4]);
    const s = Math.sin(p[o + 4]);
    const px = p[o] + xp * c - yp * s;
    const py = p[o + 1] + xp * s + yp * c;
    const d = Math.hypot(px - x, py - y);
    best = mode === 'min' ? Math.min(best, d) : Math.max(best, d);
  }
  return best;
}

function theta(sys: SketchSystem, ell: number): number {
  return sys.values[sys.entity(ell).paramOffset + 4];
}

/** The residue of θ modulo π in (−π/2, π/2]. */
function modPi(t: number): number {
  let r = t % Math.PI;
  if (r > Math.PI / 2) {
    r -= Math.PI;
  }
  if (r <= -Math.PI / 2) {
    r += Math.PI;
  }
  return r;
}

describe("ellipse entity", () => {
  it("lays out five free params: pose and both radii", () => {
    const sys = new SketchSystem();
    const ell = sys.ellipse(1, 2, 5, 3, 0.4);
    const record = sys.entity(ell);
    expect(record.kind).toBe("ellipse");
    expect(Array.from(sys.values.subarray(record.paramOffset, record.paramOffset + 5)))
      .toEqual([1, 2, 5, 3, 0.4]);
    const compiled = sys.compiled();
    const o = record.paramOffset;
    expect(Array.from(compiled.freeMask.subarray(o, o + 5))).toEqual([1, 1, 1, 1, 1]);
    // Nothing constrained: 5 DOF, the ellipse listed.
    const d = diagnose(sys);
    expect(d.dof).toBe(5);
    expect(d.underconstrainedEntities).toEqual([ell]);
  });

  it("resolves its center as a point role", () => {
    const sys = new SketchSystem();
    const ell = sys.ellipse(1, 2, 5, 3, 0);
    const pt = sys.point(0, 0);
    sys.constrain({ kind: "coincident", a: entityRef(pt), b: center(ell) });
    expect(solve(sys).outcome).toBe("solved");
    const c = sys.pointValue(center(ell));
    const q = sys.pointValue(entityRef(pt));
    expect(c.x).toBeCloseTo(q.x, 8);
    expect(c.y).toBeCloseTo(q.y, 8);
  });

  it("radius(el, v, axis) dimensions one semi-radius; the axis is required there and refused on circles", () => {
    const sys = new SketchSystem();
    const ell = sys.ellipse(0, 0, 5, 3, 0.2);
    const c = sys.circle(20, 0, 2);
    sys.constrain({ kind: "radius", a: entityRef(ell), value: 8, axis: "x" });
    sys.constrain({ kind: "radius", a: entityRef(ell), value: 2.5, axis: "y" });
    expect(solve(sys).outcome).toBe("solved");
    const o = sys.entity(ell).paramOffset;
    expect(sys.values[o + 2]).toBeCloseTo(8, 9);
    expect(sys.values[o + 3]).toBeCloseTo(2.5, 9);
    // Pose still free: 3 DOF.
    expect(diagnose(sys).dof).toBe(3 + 3); // + the free circle
    expect(() => sys.constrain({ kind: "radius", a: entityRef(ell), value: 4 }))
      .toThrow(/needs the axis/);
    expect(() => sys.constrain({ kind: "diameter", a: entityRef(ell), value: 4 }))
      .toThrow(/two semi-radii/);
    expect(() => sys.constrain({ kind: "radius", a: entityRef(c), value: 4, axis: "x" }))
      .toThrow(/axis argument/);
  });

  it("equal() matches two ellipses' shapes and refuses a mixed pair", () => {
    const sys = new SketchSystem();
    const a = sys.ellipse(0, 0, 5, 3, 0);
    const b = sys.ellipse(20, 0, 2, 1, 0.5);
    const c = sys.circle(40, 0, 2);
    pinShape(sys, a, 5, 3);
    sys.constrain({ kind: "equal", a: entityRef(a), b: entityRef(b) });
    expect(solve(sys).outcome).toBe("solved");
    const o = sys.entity(b).paramOffset;
    expect(sys.values[o + 2]).toBeCloseTo(5, 8);
    expect(sys.values[o + 3]).toBeCloseTo(3, 8);
    expect(() => sys.constrain({ kind: "equal", a: entityRef(a), b: entityRef(c) }))
      .toThrow(/all ellipses/);
  });

  it("the collapse guard pins a semi-radius the solve drove to zero", () => {
    // A horizontal ellipse whose center is pinned ON a horizontal line it
    // must be tangent to: only ry → 0 satisfies the tangency, which the
    // guard must refuse to call solved.
    const sys = new SketchSystem();
    const l = sys.line(-20, 0, 20, 0);
    const ell = sys.ellipse(0, 0, 5, 3, 0);
    sys.constrain({ kind: "fix", p: start(l) });
    sys.constrain({ kind: "fix", p: end(l) });
    sys.constrain({ kind: "fix", p: center(ell) });
    sys.constrain({ kind: "horizontal", a: entityRef(ell) });
    sys.constrain({ kind: "radius", a: entityRef(ell), value: 5, axis: "x" });
    sys.constrain({ kind: "tangent", a: entityRef(l), b: entityRef(ell) });
    const result = solve(sys);
    expect(result.collapsed).toEqual([ell]);
    expect(result.outcome).not.toBe("solved");
  });
});

describe("ellipse jacobians vs finite differences", () => {
  it("covers every ellipse row form", () => {
    const sys = new SketchSystem();
    const ellA = sys.ellipse(2.3, -1.1, 4.2, 2.1, 0.37);
    const ellB = sys.ellipse(-3.4, 5.2, 3.3, 1.7, -0.9);
    const ellC = sys.ellipse(9.1, 0.4, 2.4, 1.9, 1.3);
    const pA = sys.point(5.1, 0.7);
    const lineA = sys.line(-6, -6, 7, -4.2);
    const lineB = sys.line(1.2, 3.1, 6.8, 8.9);
    const circleA = sys.circle(10, -2, 1.4);
    const arcA = sys.arc(-8, 2, -6.1, 2.4, -8.2, 4.7);

    sys.constrain({ kind: "horizontal", a: entityRef(ellA) });
    sys.constrain({ kind: "vertical", a: entityRef(ellB) });
    sys.constrain({ kind: "concentric", a: entityRef(ellA), b: entityRef(circleA) });
    sys.constrain({ kind: "concentric", a: entityRef(arcA), b: entityRef(ellB) });
    sys.constrain({ kind: "concentric", a: entityRef(ellA), b: entityRef(ellC) });
    sys.constrain({ kind: "coincident", a: entityRef(pA), b: entityRef(ellA) });
    // line–ellipse distance form; line–ellipse junction form (lineB.start on ellB)
    sys.constrain({ kind: "tangent", a: entityRef(lineA), b: entityRef(ellA) });
    sys.constrain({ kind: "coincident", a: start(lineB), b: entityRef(ellB) });
    sys.constrain({ kind: "tangent", a: entityRef(ellB), b: entityRef(lineB) });
    // arc–ellipse junction form (arcA.end on ellC); contact forms
    sys.constrain({ kind: "coincident", a: end(arcA), b: entityRef(ellC) });
    sys.constrain({ kind: "tangent", a: entityRef(arcA), b: entityRef(ellC) });
    sys.constrain({ kind: "tangent", a: entityRef(ellA), b: entityRef(circleA) });
    sys.constrain({ kind: "tangent", a: entityRef(ellB), b: entityRef(ellC) });
    // radius on each axis; equal shapes
    sys.constrain({ kind: "radius", a: entityRef(ellA), value: 4.5, axis: "x" });
    sys.constrain({ kind: "radius", a: entityRef(ellB), value: 1.5, axis: "y" });
    sys.constrain({ kind: "equal", a: entityRef(ellA), b: entityRef(ellC) });
    // ties: a rotated copy and mirrors across a solver line and a fixed axis
    sys.addTransformTie(ellA, ellB, [Math.cos(0.7), -Math.sin(0.7), Math.sin(0.7), Math.cos(0.7), 1.5, -2]);
    sys.addMirrorTie(ellA, ellC, entityRef(lineA));
    sys.addMirrorTie(ellB, ellC, [0.5, -1, 2.5, 3]);

    const compiled = sys.compiled();
    // Rows: h 1, v 1, concentric 3×2, coincident-on-ellipse 1, tangent
    // line-distance 1, coincident 1 + junction 1, coincident 1 + junction 1,
    // contact 3 + 3, radius 2, equal 2, arc-consistency 2, transform-tie 5,
    // mirror-tie 5 + 5.
    expect(compiled.rows.length).toBe(1 + 1 + 6 + 1 + 1 + 2 + 2 + 6 + 2 + 2 + 2 + 5 + 10);
    // Two contact forms → four aux slots after the entity params.
    expect(compiled.paramCount).toBe(sys.paramCount + 4);
    expect(sys.auxParams()).toHaveLength(4);
    fdCheckRows(sys, [1, 2, 3, 4, 5], 0.05);
  });
});

describe("horizontal / vertical on an ellipse", () => {
  it("horizontal turns the RX axis onto the sketch x direction", () => {
    const sys = new SketchSystem();
    const ell = sys.ellipse(3, 4, 5, 2, 0.35);
    sys.constrain({ kind: "fix", p: center(ell) });
    sys.constrain({ kind: "horizontal", a: entityRef(ell) });
    expect(solve(sys).outcome).toBe("solved");
    expect(modPi(theta(sys, ell))).toBeCloseTo(0, 8);
    // The two radii are still free — the entity stays listed until they
    // are dimensioned.
    expect(diagnose(sys).dof).toBe(2);
    pinShape(sys, ell, 5, 2);
    expect(solve(sys).outcome).toBe("solved");
    const d = diagnose(sys);
    expect(d.dof).toBe(0);
    expect(d.underconstrainedEntities).toEqual([]);
  });

  it("vertical turns a freshly drawn (θ = 0) ellipse a quarter turn counter-clockwise", () => {
    // The drawn case: axis-aligned, rotation exactly 0 — a cos θ residual
    // has zero gradient here and used to stall as a bogus conflict.
    const sys = new SketchSystem();
    const ell = sys.ellipse(10, 5, 20, 12, 0);
    sys.constrain({ kind: "fix", p: center(ell) });
    pinShape(sys, ell, 20, 12);
    sys.constrain({ kind: "vertical", a: entityRef(ell) });
    expect(solve(sys).outcome).toBe("solved");
    expect(theta(sys, ell)).toBeCloseTo(Math.PI / 2, 9);
    const d = diagnose(sys);
    expect(d.conflicting).toEqual([]);
    expect(d.dof).toBe(0);
    // And back: horizontal from exactly π/2 (the swap the toolbar performs).
    const back = new SketchSystem();
    const e2 = back.ellipse(10, 5, 20, 12, Math.PI / 2);
    back.constrain({ kind: "fix", p: center(e2) });
    back.constrain({ kind: "horizontal", a: entityRef(e2) });
    expect(solve(back).outcome).toBe("solved");
    expect(modPi(theta(back, e2))).toBeCloseTo(0, 9);
  });

  it("vertical turns the RX axis onto the sketch y direction, from either side", () => {
    for (const guess of [1.2, -1.3, 2.0]) {
      const sys = new SketchSystem();
      const ell = sys.ellipse(0, 0, 5, 2, guess);
      sys.constrain({ kind: "fix", p: center(ell) });
      sys.constrain({ kind: "vertical", a: entityRef(ell) });
      expect(solve(sys).outcome).toBe("solved");
      expect(Math.abs(modPi(theta(sys, ell)))).toBeCloseTo(Math.PI / 2, 8);
    }
  });

  it("horizontal and vertical together conflict", () => {
    const sys = new SketchSystem();
    const ell = sys.ellipse(0, 0, 5, 2, 0.2);
    sys.constrain({ kind: "fix", p: center(ell) });
    const h = sys.constrain({ kind: "horizontal", a: entityRef(ell) });
    const v = sys.constrain({ kind: "vertical", a: entityRef(ell) });
    solve(sys);
    const d = diagnose(sys);
    expect(d.conflicting.sort()).toEqual([h, v].sort());
  });
});

describe("concentric with an ellipse", () => {
  it("shares the center with a circle, an arc and another ellipse", () => {
    const sys = new SketchSystem();
    const ell = sys.ellipse(3, 4, 5, 2, 0);
    const c = sys.circle(10, -2, 1.5);
    const a = sys.arc(-4, 6, -2, 6, -4, 8);
    const ell2 = sys.ellipse(8, 8, 2, 1, 0.3);
    sys.constrain({ kind: "fix", p: center(ell) });
    sys.constrain({ kind: "concentric", a: entityRef(c), b: entityRef(ell) });
    sys.constrain({ kind: "concentric", a: entityRef(ell), b: entityRef(a) });
    sys.constrain({ kind: "concentric", a: entityRef(ell2), b: entityRef(ell) });
    expect(solve(sys).outcome).toBe("solved");
    for (const ref of [center(c), center(a), center(ell2)]) {
      const v = sys.pointValue(ref);
      expect(v.x).toBeCloseTo(3, 8);
      expect(v.y).toBeCloseTo(4, 8);
    }
  });
});

describe("point on an ellipse", () => {
  it("coincident puts a point onto the rotated curve", () => {
    const sys = new SketchSystem();
    const ell = sys.ellipse(1, 1, 6, 2, 0.6);
    const pt = sys.point(9, 4);
    sys.constrain({ kind: "fix", p: center(ell) });
    sys.constrain({ kind: "horizontal", a: entityRef(ell) });
    pinShape(sys, ell, 6, 2);
    sys.constrain({ kind: "coincident", a: entityRef(pt), b: entityRef(ell) });
    expect(solve(sys).outcome).toBe("solved");
    const v = sys.pointValue(entityRef(pt));
    expect(implicit(sys, ell, v.x, v.y)).toBeCloseTo(0, 8);
    // One DOF left: the point slides along the curve.
    expect(diagnose(sys).dof).toBe(1);
  });
});

describe("tangent line–ellipse", () => {
  it("distance form: the ellipse rests on whichever side it was guessed", () => {
    for (const side of [1, -1]) {
      const sys = new SketchSystem();
      const l = sys.line(-20, 0, 20, 0);
      const ell = sys.ellipse(3, side * 4.4, 5, 2, 0);
      sys.constrain({ kind: "fix", p: start(l) });
      sys.constrain({ kind: "fix", p: end(l) });
      sys.constrain({ kind: "horizontal", a: entityRef(ell) });
      pinShape(sys, ell, 5, 2);
      sys.constrain({ kind: "vertical", a: center(ell), b: start(l) });
      sys.constrain({ kind: "tangent", a: entityRef(l), b: entityRef(ell) });
      expect(solve(sys).outcome).toBe("solved");
      // RX along x: the half-width along the line's normal is ry.
      expect(sys.pointValue(center(ell)).y * side).toBeCloseTo(2, 8);
      expect(diagnose(sys).dof).toBe(0);
    }
  });

  it("distance form rotates a pinned ellipse until it touches the line", () => {
    const sys = new SketchSystem();
    const l = sys.line(-20, 0, 20, 0);
    const ell = sys.ellipse(0, 3.5, 5, 2, 0.5);
    sys.constrain({ kind: "fix", p: start(l) });
    sys.constrain({ kind: "fix", p: end(l) });
    sys.constrain({ kind: "fix", p: center(ell) });
    pinShape(sys, ell, 5, 2);
    sys.constrain({ kind: "tangent", a: entityRef(l), b: entityRef(ell) });
    expect(solve(sys).outcome).toBe("solved");
    // Half-width along the y normal: √((rx sin θ)² + (ry cos θ)²) = 3.5,
    // i.e. the lowest point of the rotated ellipse sits on the line.
    const t = theta(sys, ell);
    expect(Math.hypot(5 * Math.sin(t), 2 * Math.cos(t))).toBeCloseTo(3.5, 8);
    expect(sampledMinY(sys, ell)).toBeCloseTo(0, 4);
  });

  it("junction form at a line end declared on the ellipse", () => {
    const sys = new SketchSystem();
    const ell = sys.ellipse(0, 0, 6, 3, 0.2);
    const l = sys.line(5, 2.5, 12, 6);
    sys.constrain({ kind: "fix", p: center(ell) });
    sys.constrain({ kind: "horizontal", a: entityRef(ell) });
    pinShape(sys, ell, 6, 3);
    sys.constrain({ kind: "fix", p: end(l) });
    sys.constrain({ kind: "coincident", a: start(l), b: entityRef(ell) });
    sys.constrain({ kind: "tangent", a: entityRef(l), b: entityRef(ell) });
    expect(solve(sys).outcome).toBe("solved");
    const s = sys.pointValue(start(l));
    expect(implicit(sys, ell, s.x, s.y)).toBeCloseTo(0, 8);
    // Line direction ⊥ ellipse normal (∇F = (2x/rx², 2y/ry²) at θ = 0).
    const e = sys.pointValue(end(l));
    const dot = (e.x - s.x) * (s.x / 36) + (e.y - s.y) * (s.y / 9);
    expect(dot / Math.hypot(e.x - s.x, e.y - s.y)).toBeCloseTo(0, 8);
    expect(diagnose(sys).dof).toBe(0);
  });
});

describe("tangent ellipse–circle / arc / ellipse", () => {
  it("external contact: the circle ends up touching the ellipse from outside", () => {
    const sys = new SketchSystem();
    const ell = sys.ellipse(0, 0, 6, 3, 0.3);
    const c = sys.circle(9, 4, 2);
    sys.constrain({ kind: "fix", p: center(ell) });
    sys.constrain({ kind: "horizontal", a: entityRef(ell) });
    pinShape(sys, ell, 6, 3);
    sys.constrain({ kind: "fix", p: center(c) });
    sys.constrain({ kind: "tangent", a: entityRef(ell), b: entityRef(c) });
    const result = solve(sys);
    expect(result.outcome).toBe("solved");
    // Radius free: the circle grows/shrinks until its nearest ellipse point is r away.
    const r = sys.values[sys.entity(c).paramOffset + 2];
    expect(sampledDistance(sys, ell, 9, 4, 'min')).toBeCloseTo(r, 4);
    expect(diagnose(sys).dof).toBe(0);
  });

  it("internal contact: a circle guessed inside stays inside", () => {
    // r = 1 fits the vertex (the ellipse's curvature radius there is
    // ry²/rx = 1.5): the circle nests at the end of the RX axis.
    const sys = new SketchSystem();
    const ell = sys.ellipse(0, 0, 6, 3, 0);
    const c = sys.circle(4, 0.3, 1.1);
    sys.constrain({ kind: "fix", p: center(ell) });
    sys.constrain({ kind: "horizontal", a: entityRef(ell) });
    pinShape(sys, ell, 6, 3);
    sys.constrain({ kind: "radius", a: entityRef(c), value: 1 });
    sys.constrain({ kind: "horizontal", a: center(c), b: center(ell) });
    sys.constrain({ kind: "tangent", a: entityRef(c), b: entityRef(ell) });
    expect(solve(sys).outcome).toBe("solved");
    const cc = sys.pointValue(center(c));
    expect(cc.x).toBeCloseTo(5, 6); // touches at (6, 0) from inside
    expect(sampledDistance(sys, ell, cc.x, cc.y, 'min')).toBeCloseTo(1, 4);
  });

  it("junction form at an arc end declared on the ellipse", () => {
    const sys = new SketchSystem();
    const ell = sys.ellipse(0, 0, 6, 3, 0);
    const a = sys.arc(7, 2, 5.5, 1.4, 9, 3);
    sys.constrain({ kind: "fix", p: center(ell) });
    sys.constrain({ kind: "horizontal", a: entityRef(ell) });
    pinShape(sys, ell, 6, 3);
    sys.constrain({ kind: "fix", p: center(a) });
    sys.constrain({ kind: "coincident", a: start(a), b: entityRef(ell) });
    sys.constrain({ kind: "tangent", a: entityRef(a), b: entityRef(ell) });
    expect(solve(sys).outcome).toBe("solved");
    const s = sys.pointValue(start(a));
    expect(implicit(sys, ell, s.x, s.y)).toBeCloseTo(0, 8);
    // Arc radius vector ∥ ellipse normal (∇F = (2x/rx², 2y/ry²)) at the junction.
    const nx = s.x / 36;
    const ny = s.y / 9;
    const cross = (s.x - 7) * ny - (s.y - 2) * nx;
    expect(Math.abs(cross) / (Math.hypot(s.x - 7, s.y - 2) * Math.hypot(nx, ny))).toBeLessThan(1e-7);
    // The arc's end still slides along its circle: one DOF.
    expect(diagnose(sys).dof).toBe(1);
  });

  it("ellipse–ellipse contact", () => {
    const sys = new SketchSystem();
    const a = sys.ellipse(0, 0, 6, 3, 0);
    const b = sys.ellipse(11.5, 0.4, 4, 2, 0.1);
    sys.constrain({ kind: "fix", p: center(a) });
    sys.constrain({ kind: "horizontal", a: entityRef(a) });
    sys.constrain({ kind: "horizontal", a: entityRef(b) });
    pinShape(sys, a, 6, 3);
    pinShape(sys, b, 4, 2);
    sys.constrain({ kind: "horizontal", a: center(b), b: center(a) });
    sys.constrain({ kind: "tangent", a: entityRef(a), b: entityRef(b) });
    expect(solve(sys).outcome).toBe("solved");
    // b slides along x until its RX vertex meets a's: centers 6 + 4 apart.
    expect(sys.pointValue(center(b)).x).toBeCloseTo(10, 6);
    // The contact point sits on both curves with a shared normal.
    const contact = sys.auxParams();
    expect(contact).toHaveLength(2);
    const px = contact[0].value;
    const py = contact[1].value;
    expect(implicit(sys, a, px, py)).toBeCloseTo(0, 7);
    expect(implicit(sys, b, px, py)).toBeCloseTo(0, 7);
    expect(diagnose(sys).dof).toBe(0);
  });

  it("carries the contact point across a recompile and seeds it from a snapshot", () => {
    const sys = new SketchSystem();
    const ell = sys.ellipse(0, 0, 6, 3, 0);
    const c = sys.circle(9, 4, 2);
    sys.constrain({ kind: "fix", p: center(ell) });
    sys.constrain({ kind: "horizontal", a: entityRef(ell) });
    pinShape(sys, ell, 6, 3);
    sys.constrain({ kind: "fix", p: center(c) });
    const t = sys.constrain({ kind: "tangent", a: entityRef(ell), b: entityRef(c) });
    expect(solve(sys).outcome).toBe("solved");
    const before = sys.auxParams();
    expect(before.map((a) => [a.constraint, a.slot])).toEqual([[t, 0], [t, 1]]);

    // A structural change (a new, unrelated entity) recompiles: the contact
    // point comes back exactly, not from the geometric guess.
    sys.point(50, 50);
    const after = sys.auxParams();
    expect(after.map((a) => a.value)).toEqual(before.map((a) => a.value));
    expect(sys.paramCount).toBe(sys.compiled().paramCount - 2);
    expect(solve(sys).iters).toBe(0); // already at the solution

    // Snapshot: entity params only, aux beside them; a rebuild seeds them.
    const snap = sys.snapshot();
    expect(snap.params).toHaveLength(sys.paramCount);
    expect(snap.aux).toEqual(after);
    const rebuilt = new SketchSystem();
    for (const e of snap.entities) {
      const p = snap.params.slice(e.paramOffset, e.paramOffset + (e.kind === 'ellipse' ? 5 : e.kind === 'circle' ? 3 : 2));
      if (e.kind === 'ellipse') {
        rebuilt.ellipse(p[0], p[1], p[2], p[3], p[4], { id: e.id });
      } else if (e.kind === 'circle') {
        rebuilt.circle(p[0], p[1], p[2], { id: e.id });
      } else {
        rebuilt.point(p[0], p[1], { id: e.id });
      }
    }
    for (const record of snap.constraints) {
      rebuilt.constrain(record.spec, record.id);
    }
    rebuilt.seedAux(snap.aux!);
    expect(rebuilt.auxParams().map((a) => a.value)).toEqual(after.map((a) => a.value));
    expect(solve(rebuilt).iters).toBe(0);
  });
});

describe("ellipse ties", () => {
  it("transform-tie rotates the copy's RX axis with the matrix", () => {
    const sys = new SketchSystem();
    const alpha = 0.7;
    const m: [number, number, number, number, number, number] =
      [Math.cos(alpha), -Math.sin(alpha), Math.sin(alpha), Math.cos(alpha), 10, 0];
    const src = sys.ellipse(1, 2, 5, 2, 0.1);
    const dup = sys.ellipse(0, 0, 5, 2, 0);
    sys.addTransformTie(src, dup, m);
    sys.constrain({ kind: "fix", p: center(src) });
    sys.constrain({ kind: "vertical", a: entityRef(dup) }); // constrain the COPY
    // The radii tie too: dimension the COPY, the source follows.
    pinShape(sys, dup, 7, 1.5);
    expect(solve(sys).outcome).toBe("solved");
    const os = sys.entity(src).paramOffset;
    expect(sys.values[os + 2]).toBeCloseTo(7, 8);
    expect(sys.values[os + 3]).toBeCloseTo(1.5, 8);
    expect(modPi(theta(sys, src) + alpha - theta(sys, dup))).toBeCloseTo(0, 8);
    expect(Math.abs(modPi(theta(sys, dup)))).toBeCloseTo(Math.PI / 2, 8);
    const cd = sys.pointValue(center(dup));
    expect(cd.x).toBeCloseTo(Math.cos(alpha) * 1 - Math.sin(alpha) * 2 + 10, 8);
    expect(diagnose(sys).dof).toBe(0);
  });

  it("mirror-tie reflects the RX axis across a moving line and a fixed axis", () => {
    const sys = new SketchSystem();
    const axis = sys.line(0, -5, 0, 5); // the y axis, as a solver line
    const src = sys.ellipse(3, 1, 5, 2, 0.4);
    const img = sys.ellipse(-3, 1, 5, 2, -0.4);
    const img2 = sys.ellipse(3, -1, 5, 2, -0.4);
    sys.addMirrorTie(src, img, entityRef(axis));
    sys.addMirrorTie(src, img2, [0, 0, 1, 0]); // the x axis, as a constant
    sys.constrain({ kind: "fix", p: start(axis) });
    sys.constrain({ kind: "fix", p: end(axis) });
    sys.constrain({ kind: "fix", p: center(src) });
    sys.constrain({ kind: "horizontal", a: entityRef(img) }); // constrain the IMAGE
    pinShape(sys, img2, 5, 2);
    expect(solve(sys).outcome).toBe("solved");
    const oi = sys.entity(img).paramOffset;
    expect(sys.values[oi + 2]).toBeCloseTo(5, 8);
    expect(sys.values[oi + 3]).toBeCloseTo(2, 8);
    expect(modPi(theta(sys, src))).toBeCloseTo(0, 8);
    expect(modPi(theta(sys, img) + theta(sys, src))).toBeCloseTo(0, 8);
    expect(modPi(theta(sys, img2) + theta(sys, src))).toBeCloseTo(0, 8);
    expect(sys.pointValue(center(img)).x).toBeCloseTo(-3, 8);
    expect(sys.pointValue(center(img2)).y).toBeCloseTo(-1, 8);
    expect(diagnose(sys).dof).toBe(0);
  });
});
