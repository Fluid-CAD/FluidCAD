import { describe, expect, it } from "vitest";
import {
  SketchSystem,
  X_AXIS_ENTITY,
  Y_AXIS_ENTITY,
  ORIGIN_ENTITY,
  center,
  diagnose,
  ellipseArcContainsParam,
  ellipseArcSpan,
  ellipseParamOf,
  ellipsePointAt,
  ellipseSweep,
  end,
  entityRef,
  sampleEllipseArc,
  solve,
  start,
} from "../../sketch-solver/index.js";
import type { EllipseFrame } from "../../sketch-solver/index.js";
import { fdCheckRows } from "./fd-rows.js";

// The elliptical arc entity [cx, cy, rx, ry, θ, sx, sy, ex, ey]: the
// ellipse's five params in the ellipse's own slots, then the two ends as
// points held on the ellipse by two internal consistency rows. Seven
// degrees of freedom. Every ellipse row reads it as its whole ellipse;
// its ends add one-row tangent junctions. Each new row form is checked
// against finite differences, and each constraint against what it means.

const DEG = Math.PI / 180;

/** An elliptical arc from parameter t0 to t1 (radians) of the ellipse. */
function addArc(sys: SketchSystem, e: EllipseFrame, t0: number, t1: number): number {
  const s = ellipsePointAt(e, t0);
  const en = ellipsePointAt(e, t1);
  return sys.eArc(e.cx, e.cy, e.rx, e.ry, e.theta, s[0], s[1], en[0], en[1]);
}

function frameOf(sys: SketchSystem, arc: number): EllipseFrame {
  const o = sys.entity(arc).paramOffset;
  const p = sys.values;
  return { cx: p[o], cy: p[o + 1], rx: p[o + 2], ry: p[o + 3], theta: p[o + 4] };
}

/** Implicit ellipse function of the arc's ellipse at a point: 0 on it. */
function implicit(sys: SketchSystem, arc: number, x: number, y: number): number {
  const e = frameOf(sys, arc);
  const dx = x - e.cx;
  const dy = y - e.cy;
  const c = Math.cos(e.theta);
  const s = Math.sin(e.theta);
  const xp = dx * c + dy * s;
  const yp = -dx * s + dy * c;
  return (xp * xp) / (e.rx * e.rx) + (yp * yp) / (e.ry * e.ry) - 1;
}

/** Unit normal of the arc's ellipse at a point on it. */
function normalAt(sys: SketchSystem, arc: number, x: number, y: number): [number, number] {
  const e = frameOf(sys, arc);
  const dx = x - e.cx;
  const dy = y - e.cy;
  const c = Math.cos(e.theta);
  const s = Math.sin(e.theta);
  const xp = (dx * c + dy * s) / (e.rx * e.rx);
  const yp = (-dx * s + dy * c) / (e.ry * e.ry);
  const nx = xp * c - yp * s;
  const ny = xp * s + yp * c;
  const len = Math.hypot(nx, ny);
  return [nx / len, ny / len];
}

function expectEndsOnEllipse(sys: SketchSystem, arc: number): void {
  const s = sys.pointValue(start(arc));
  const e = sys.pointValue(end(arc));
  expect(Math.abs(implicit(sys, arc, s.x, s.y))).toBeLessThan(1e-6);
  expect(Math.abs(implicit(sys, arc, e.x, e.y))).toBeLessThan(1e-6);
}

const BASE: EllipseFrame = { cx: 1, cy: 2, rx: 8, ry: 5, theta: 0.3 };

describe("elliptical arc entity", () => {
  it("lays out nine free params with two internal consistency rows: seven degrees of freedom", () => {
    const sys = new SketchSystem();
    const arc = addArc(sys, BASE, 0.2, 1.9);
    const record = sys.entity(arc);
    expect(record.kind).toBe("eArc");
    const o = record.paramOffset;
    expect(Array.from(sys.values.subarray(o, o + 5))).toEqual([1, 2, 8, 5, 0.3]);
    const compiled = sys.compiled();
    expect(Array.from(compiled.freeMask.subarray(o, o + 9))).toEqual([1, 1, 1, 1, 1, 1, 1, 1, 1]);
    // The consistency record is internal, and its two rows are the only rows.
    expect(sys.constraints().map(c => [c.internal, c.spec.kind])).toEqual([[true, "arc-consistency"]]);
    expect(compiled.rows.length).toBe(2);
    expect(solve(sys).outcome).toBe("solved");
    const d = diagnose(sys);
    expect(d.dof).toBe(7);
    expect(d.underconstrainedEntities).toEqual([arc]);
    expect(d.redundant).toEqual([]);
  });

  it("a fixed elliptical arc gets no consistency rows", () => {
    const sys = new SketchSystem();
    addArc(sys, BASE, 0, 1);
    const fixed = sys.eArc(0, 0, 4, 2, 0, 4, 0, 0, 2, { fixed: true });
    expect(sys.constraints().length).toBe(1);
    expect(sys.entity(fixed).fixed).toBe(true);
  });

  it("resolves start, end and center as point roles, and glues by all three", () => {
    const sys = new SketchSystem();
    const arc = addArc(sys, { cx: 0, cy: 0, rx: 6, ry: 3, theta: 0 }, 0, Math.PI / 2);
    expect(sys.pointValue(start(arc))).toEqual({ x: 6, y: 0 });
    expect(sys.pointValue(end(arc)).x).toBeCloseTo(0, 12);
    expect(sys.pointValue(end(arc)).y).toBeCloseTo(3, 12);
    expect(sys.pointValue(center(arc))).toEqual({ x: 0, y: 0 });
    expect(sys.pointSlots().filter(slot => slot.entity === arc).map(slot => slot.role))
      .toEqual(["center", "start", "end"]);
    expect(() => sys.pointIndices(entityRef(arc))).toThrow(/does not resolve to a point/);
  });

  it("the consistency rows pull rough ends onto the ellipse", () => {
    const sys = new SketchSystem();
    // Ends given well off the outline, as rounded or hand-written literals are.
    const arc = sys.eArc(0, 0, 8, 5, 0, 8.4, 0.3, -0.2, 5.5);
    expect(solve(sys).outcome).toBe("solved");
    expectEndsOnEllipse(sys, arc);
  });

  it("every row form matches finite differences", () => {
    const sys = new SketchSystem();
    sys.ensureDatums();
    const a = addArc(sys, BASE, 0.2, 1.9);
    const b = addArc(sys, { cx: 14, cy: 6, rx: 6, ry: 3, theta: -0.4 }, 2.4, 4.1);
    const mirrored = addArc(sys, { cx: -1, cy: 2, rx: 8, ry: 5, theta: Math.PI - 0.3 }, 0.2, 1.9);
    const ell = sys.ellipse(-12, 3, 4, 2, 0.7);
    const circ = sys.circle(5, -9, 3);
    const arc = sys.arc(20, -4, 23, -4, 20, -1);
    const line = sys.line(-3, 9, 9, 11);
    const axis = sys.line(0, -20, 0.5, 20);
    const pt = sys.point(7, 6);

    // Carrier-ellipse rows.
    sys.constrain({ kind: "coincident", a: entityRef(pt), b: entityRef(a) });
    sys.constrain({ kind: "horizontal", a: entityRef(a) });
    sys.constrain({ kind: "vertical", a: entityRef(b) });
    sys.constrain({ kind: "radius", a: entityRef(a), value: 8, axis: "x" });
    sys.constrain({ kind: "radius", a: entityRef(b), value: 3, axis: "y" });
    sys.constrain({ kind: "equal", a: entityRef(a), b: entityRef(ell) });
    sys.constrain({ kind: "concentric", a: entityRef(a), b: entityRef(circ) });
    // Distance / aux tangency forms.
    sys.constrain({ kind: "tangent", a: entityRef(a), b: entityRef(line) });
    sys.constrain({ kind: "tangent", a: entityRef(b), b: entityRef(circ) });
    sys.constrain({ kind: "tangent", a: entityRef(b), b: entityRef(ell) });
    sys.constrain({ kind: "tangent", a: entityRef(mirrored), b: entityRef(arc) });
    // Entity forms.
    sys.constrain({ kind: "symmetric", a: entityRef(a), b: entityRef(mirrored), l: entityRef(axis) });
    fdCheckRows(sys, [3, 17, 71], 0.2);
  });

  it("the tangent junction forms match finite differences", () => {
    const sys = new SketchSystem();
    const a = addArc(sys, BASE, 0.2, 1.9);
    const b = addArc(sys, { cx: 14, cy: 6, rx: 6, ry: 3, theta: -0.4 }, 2.4, 4.1);
    const c = addArc(sys, { cx: -9, cy: -6, rx: 5, ry: 2, theta: 1.1 }, 0.5, 2.5);
    const ell = sys.ellipse(-12, 3, 4, 2, 0.7);
    const circ = sys.circle(5, -9, 3);
    const arc = sys.arc(20, -4, 23, -4, 20, -1);
    const line = sys.line(-3, 9, 9, 11);
    // An end joined to a line end, to an arc end, to another elliptical
    // arc's end; an end declared on a circle and on an ellipse.
    sys.constrain({ kind: "coincident", a: start(a), b: end(line) });
    sys.constrain({ kind: "tangent", a: entityRef(a), b: entityRef(line) });
    sys.constrain({ kind: "coincident", a: end(a), b: start(arc) });
    sys.constrain({ kind: "tangent", a: entityRef(arc), b: entityRef(a) });
    sys.constrain({ kind: "coincident", a: end(b), b: start(c) });
    sys.constrain({ kind: "tangent", a: entityRef(b), b: entityRef(c) });
    sys.constrain({ kind: "coincident", a: start(b), b: entityRef(circ) });
    sys.constrain({ kind: "tangent", a: entityRef(b), b: entityRef(circ) });
    sys.constrain({ kind: "coincident", a: end(c), b: entityRef(ell) });
    sys.constrain({ kind: "tangent", a: entityRef(c), b: entityRef(ell) });
    // One row each: no aux contact point is allocated for a junction.
    expect(sys.auxParams()).toEqual([]);
    const tangentRows = sys.compiled().rowConstraint
      .reduce((n, owner) => n + (sys.constraints()[owner].spec.kind === "tangent" ? 1 : 0), 0);
    expect(tangentRows).toBe(5);
    fdCheckRows(sys, [5, 23, 59], 0.2);
  });

  it("the derived ties match finite differences and add no freedom", () => {
    const sys = new SketchSystem();
    const src = addArc(sys, BASE, 0.2, 1.9);
    // A quarter turn about (3, -1): p' = R·p + t.
    const moved = addArc(sys, { cx: 0, cy: -3, rx: 8, ry: 5, theta: 0.3 + Math.PI / 2 }, 0.2, 1.9);
    sys.addTransformTie(src, moved, [0, -1, 1, 0, 2, -4]);
    const axis = sys.line(-5, -10, -4, 12);
    const imageOnLine = addArc(sys, { cx: -10, cy: 2, rx: 8, ry: 5, theta: 2.7 }, -0.2, -1.9);
    sys.addMirrorTie(src, imageOnLine, entityRef(axis));
    const imageOnAxis = addArc(sys, { cx: -1, cy: 2, rx: 8, ry: 5, theta: Math.PI - 0.3 }, -0.2, -1.9);
    sys.addMirrorTie(src, imageOnAxis, [0, 0, 0, 1]);
    // The tied targets' own consistency rows are dropped: 2 (the source's)
    // + 9 per tie.
    expect(sys.compiled().rows.length).toBe(2 + 9 * 3);
    fdCheckRows(sys, [9, 31, 47], 0.2);
    expect(solve(sys).outcome).toBe("solved");
    // The source's 7 plus the mirror line's 4; no tie adds any.
    const d = diagnose(sys);
    expect(d.dof).toBe(7 + 4);
    expect(d.redundant).toEqual([]);
    expectEndsOnEllipse(sys, moved);
    expectEndsOnEllipse(sys, imageOnLine);
    expectEndsOnEllipse(sys, imageOnAxis);
  });
});

describe("elliptical arc constraints", () => {
  it("pins all seven degrees of freedom with center, orientation, both semi-radii and both ends", () => {
    const sys = new SketchSystem();
    sys.ensureDatums();
    const arc = sys.eArc(0.4, -0.3, 9, 4.5, 0.1, 9.2, 0.4, -0.3, 4.8);
    sys.constrain({ kind: "coincident", a: center(arc), b: entityRef(ORIGIN_ENTITY) });
    sys.constrain({ kind: "horizontal", a: entityRef(arc) });
    sys.constrain({ kind: "radius", a: entityRef(arc), value: 10, axis: "x" });
    sys.constrain({ kind: "radius", a: entityRef(arc), value: 5, axis: "y" });
    expect(solve(sys).outcome).toBe("solved");
    // The ellipse is pinned; each end still slides along it.
    expect(diagnose(sys).dof).toBe(2);
    sys.constrain({ kind: "coincident", a: start(arc), b: entityRef(X_AXIS_ENTITY) });
    sys.constrain({ kind: "coincident", a: end(arc), b: entityRef(Y_AXIS_ENTITY) });
    expect(solve(sys).outcome).toBe("solved");
    const d = diagnose(sys);
    expect(d.dof).toBe(0);
    expect(d.redundant).toEqual([]);
    expect(d.conflicting).toEqual([]);
    expect(sys.pointValue(start(arc)).x).toBeCloseTo(10, 6);
    expect(sys.pointValue(start(arc)).y).toBeCloseTo(0, 6);
    expect(sys.pointValue(end(arc)).x).toBeCloseTo(0, 6);
    expect(sys.pointValue(end(arc)).y).toBeCloseTo(5, 6);
    expect(frameOf(sys, arc).theta).toBeCloseTo(0, 9);
  });

  it("joins a line to an end: the coincident moves the end along the ellipse", () => {
    const sys = new SketchSystem();
    const arc = addArc(sys, { cx: 0, cy: 0, rx: 10, ry: 5, theta: 0 }, 0, Math.PI / 2);
    const line = sys.line(10.5, -6, 10.5, 0.2);
    sys.constrain({ kind: "fix", p: center(arc) });
    sys.constrain({ kind: "horizontal", a: entityRef(arc) });
    sys.constrain({ kind: "radius", a: entityRef(arc), value: 10, axis: "x" });
    sys.constrain({ kind: "radius", a: entityRef(arc), value: 5, axis: "y" });
    sys.constrain({ kind: "coincident", a: end(line), b: start(arc) });
    expect(solve(sys).outcome).toBe("solved");
    const s = sys.pointValue(start(arc));
    const e = sys.pointValue(end(line));
    expect(e.x).toBeCloseTo(s.x, 8);
    expect(e.y).toBeCloseTo(s.y, 8);
    expectEndsOnEllipse(sys, arc);
  });

  it("tangent at a joined line end lines the line up with the ellipse there", () => {
    const sys = new SketchSystem();
    const arc = addArc(sys, { cx: 0, cy: 0, rx: 10, ry: 5, theta: 0.2 }, 0.3, 1.8);
    const s0 = sys.pointValue(start(arc));
    const line = sys.line(s0.x + 3, s0.y - 7, s0.x, s0.y);
    sys.constrain({ kind: "coincident", a: end(line), b: start(arc) });
    sys.constrain({ kind: "tangent", a: entityRef(line), b: entityRef(arc) });
    expect(solve(sys).outcome).toBe("solved");
    const s = sys.pointValue(start(arc));
    const [nx, ny] = normalAt(sys, arc, s.x, s.y);
    const a = sys.pointValue(start(line));
    const b = sys.pointValue(end(line));
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    expect(len).toBeGreaterThan(1);
    expect(Math.abs(((b.x - a.x) * nx + (b.y - a.y) * ny) / len)).toBeLessThan(1e-7);
    expectEndsOnEllipse(sys, arc);
    // 7 (arc) + 4 (line) − 2 (join) − 1 (tangent).
    const d = diagnose(sys);
    expect(d.dof).toBe(8);
    expect(d.redundant).toEqual([]);
  });

  it("tangent at an end joined to a circular arc lines the two curves up", () => {
    const sys = new SketchSystem();
    const ea = addArc(sys, { cx: 0, cy: 0, rx: 10, ry: 5, theta: 0 }, 0.4, 2.2);
    const e0 = sys.pointValue(end(ea));
    const arc = sys.arc(e0.x - 3, e0.y - 1, e0.x, e0.y, e0.x - 6, e0.y - 1.5);
    sys.constrain({ kind: "coincident", a: start(arc), b: end(ea) });
    sys.constrain({ kind: "tangent", a: entityRef(ea), b: entityRef(arc) });
    expect(solve(sys).outcome).toBe("solved");
    const j = sys.pointValue(end(ea));
    const [nx, ny] = normalAt(sys, ea, j.x, j.y);
    const c = sys.pointValue(center(arc));
    const rx = j.x - c.x;
    const ry = j.y - c.y;
    // The arc's radius at the junction runs along the ellipse's normal.
    expect(Math.abs((rx * ny - ry * nx) / Math.hypot(rx, ry))).toBeLessThan(1e-7);
    expect(diagnose(sys).redundant).toEqual([]);
  });

  it("two elliptical arcs joined end to end take the one-row junction tangent", () => {
    const sys = new SketchSystem();
    const a = addArc(sys, { cx: 0, cy: 0, rx: 10, ry: 5, theta: 0 }, 0.2, 1.4);
    const j0 = sys.pointValue(end(a));
    const b = sys.eArc(j0.x - 4, j0.y + 3, 6, 3, 0.9, j0.x, j0.y, j0.x - 9, j0.y + 1);
    sys.constrain({ kind: "coincident", a: end(a), b: start(b) });
    sys.constrain({ kind: "tangent", a: entityRef(a), b: entityRef(b) });
    expect(sys.auxParams()).toEqual([]);
    expect(solve(sys).outcome).toBe("solved");
    const j = sys.pointValue(end(a));
    const [ax, ay] = normalAt(sys, a, j.x, j.y);
    const [bx, by] = normalAt(sys, b, j.x, j.y);
    expect(Math.abs(ax * by - ay * bx)).toBeLessThan(1e-7);
    // 7 + 7 − 2 − 1.
    const d = diagnose(sys);
    expect(d.dof).toBe(11);
    expect(d.redundant).toEqual([]);
  });

  it("tangent to a line away from the ends touches the ellipse the arc lies on", () => {
    const sys = new SketchSystem();
    const arc = addArc(sys, { cx: 0, cy: 0, rx: 10, ry: 5, theta: 0 }, 0.3, 2.6);
    const line = sys.line(-15, 6.5, 15, 7);
    sys.constrain({ kind: "fix", p: center(arc) });
    sys.constrain({ kind: "horizontal", a: entityRef(arc) });
    sys.constrain({ kind: "radius", a: entityRef(arc), value: 10, axis: "x" });
    sys.constrain({ kind: "radius", a: entityRef(arc), value: 5, axis: "y" });
    sys.constrain({ kind: "horizontal", a: entityRef(line) });
    sys.constrain({ kind: "tangent", a: entityRef(arc), b: entityRef(line) });
    expect(solve(sys).outcome).toBe("solved");
    expect(sys.pointValue(start(line)).y).toBeCloseTo(5, 7);
  });

  it("concentric, equal and point-on-curve read the arc as its ellipse", () => {
    const sys = new SketchSystem();
    const arc = addArc(sys, { cx: 2, cy: 1, rx: 9, ry: 4, theta: 0.5 }, 0.1, 2);
    const circ = sys.circle(-6, 5, 2);
    const ell = sys.ellipse(20, 0, 3, 2, 0);
    const other = addArc(sys, { cx: -20, cy: 0, rx: 3, ry: 2, theta: 0 }, 1, 3);
    const pt = sys.point(11, 6);
    sys.constrain({ kind: "concentric", a: entityRef(arc), b: entityRef(circ) });
    sys.constrain({ kind: "radius", a: entityRef(arc), value: 9, axis: "x" });
    sys.constrain({ kind: "radius", a: entityRef(arc), value: 4, axis: "y" });
    sys.constrain({ kind: "equal", a: entityRef(arc), b: entityRef(ell), others: [entityRef(other)] });
    sys.constrain({ kind: "coincident", a: entityRef(pt), b: entityRef(arc) });
    expect(solve(sys).outcome).toBe("solved");
    const c = sys.pointValue(center(arc));
    const cc = sys.pointValue(center(circ));
    expect(c.x).toBeCloseTo(cc.x, 8);
    expect(c.y).toBeCloseTo(cc.y, 8);
    for (const shaped of [ell, other]) {
      const o = sys.entity(shaped).paramOffset;
      expect(sys.values[o + 2]).toBeCloseTo(9, 8);
      expect(sys.values[o + 3]).toBeCloseTo(4, 8);
    }
    const q = sys.pointValue(entityRef(pt));
    expect(Math.abs(implicit(sys, arc, q.x, q.y))).toBeLessThan(1e-7);
    expectEndsOnEllipse(sys, other);
  });

  it("horizontal and vertical orient the RX axis from where it is drawn", () => {
    for (const [kind, drawn, want] of [
      ["horizontal", 0.3, 0],
      ["vertical", 0.3, Math.PI / 2],
      ["vertical", 0, Math.PI / 2],
      ["horizontal", Math.PI / 2, 0],
    ] as const) {
      const sys = new SketchSystem();
      const arc = addArc(sys, { cx: 0, cy: 0, rx: 9, ry: 4, theta: drawn }, 0.2, 2.4);
      sys.constrain({ kind, a: entityRef(arc) });
      expect(solve(sys).outcome, `${kind} from ${drawn}`).toBe("solved");
      const theta = frameOf(sys, arc).theta;
      expect(Math.abs(Math.sin(theta - want)), `${kind} from ${drawn}`).toBeLessThan(1e-9);
      expectEndsOnEllipse(sys, arc);
    }
  });

  it("symmetric mirrors one elliptical arc onto another with exactly seven rows", () => {
    const sys = new SketchSystem();
    sys.ensureDatums();
    const a = addArc(sys, { cx: 12, cy: 3, rx: 8, ry: 4, theta: 0.4 }, 0.2, 2.1);
    // Roughly the mirror image across the y-axis.
    const b = sys.eArc(-11, 3.5, 7, 4.5, Math.PI - 0.5, -17, 7, -7.5, 5);
    const before = sys.compiled().rows.length;
    sys.constrain({ kind: "symmetric", a: entityRef(a), b: entityRef(b), l: entityRef(Y_AXIS_ENTITY) });
    expect(sys.compiled().rows.length - before).toBe(7);
    expect(solve(sys).outcome).toBe("solved");
    for (const role of [start, end, center]) {
      const pa = sys.pointValue(role(a));
      const pb = sys.pointValue(role(b));
      expect(pb.x).toBeCloseTo(-pa.x, 6);
      expect(pb.y).toBeCloseTo(pa.y, 6);
    }
    const d = diagnose(sys);
    expect(d.dof).toBe(7);
    expect(d.redundant).toEqual([]);
  });

  it("refuses the constraints that have no meaning on it, in plain words", () => {
    const sys = new SketchSystem();
    const arc = addArc(sys, BASE, 0.2, 1.9);
    const other = addArc(sys, { ...BASE, cx: 30 }, 0.2, 1.9);
    const circ = sys.circle(0, 20, 3);
    const line = sys.line(0, 0, 5, 5);
    const pt = sys.point(3, 3);
    expect(() => sys.constrain({ kind: "radius", a: entityRef(arc), value: 4 }))
      .toThrow(/needs the axis/);
    expect(() => sys.constrain({ kind: "diameter", a: entityRef(arc), value: 4 }))
      .toThrow(/an elliptical arc has two semi-radii/);
    expect(() => sys.constrain({ kind: "distance", a: entityRef(pt), b: entityRef(arc), value: 4 }))
      .toThrow(/an elliptical arc has two semi-radii/);
    expect(() => sys.constrain({ kind: "equal", a: entityRef(arc), b: entityRef(circ) }))
      .toThrow(/all ellipses/);
    expect(() => sys.constrain({ kind: "parallel", a: entityRef(arc), b: entityRef(line) }))
      .toThrow(/expected a line/);
    expect(() => sys.constrain({ kind: "symmetric", a: entityRef(arc), b: entityRef(circ), l: entityRef(line) }))
      .toThrow(/same kind/);
    expect(() => sys.constrain({ kind: "tangent", a: entityRef(arc), b: entityRef(arc) }))
      .toThrow(/two different entities/);
    expect(() => sys.constrain({
      kind: "offset-from", targets: [entityRef(other)], sources: [entityRef(arc)], value: 2,
    })).toThrow(/must be a line, arc or circle/);
    // Nothing above was registered.
    expect(sys.constraints().filter(c => !c.internal)).toEqual([]);
  });

  it("the collapse guard pins a semi-radius the solve drove to zero", () => {
    // Center pinned ON a horizontal line the arc must be tangent to: only
    // ry → 0 satisfies it, which the guard must refuse to call solved.
    const sys = new SketchSystem();
    const l = sys.line(-20, 0, 20, 0);
    const arc = addArc(sys, { cx: 0, cy: 0, rx: 5, ry: 3, theta: 0 }, 0.4, 2);
    sys.constrain({ kind: "fix", p: start(l) });
    sys.constrain({ kind: "fix", p: end(l) });
    sys.constrain({ kind: "fix", p: center(arc) });
    sys.constrain({ kind: "horizontal", a: entityRef(arc) });
    sys.constrain({ kind: "tangent", a: entityRef(arc), b: entityRef(l) });
    const result = solve(sys);
    expect(result.collapsed).toEqual([arc]);
    expect(frameOf(sys, arc).ry).toBeGreaterThan(1);
  });
});

describe("elliptical arc under drag", () => {
  it("a dragged end slides along the ellipse and leaves it where it was", () => {
    const sys = new SketchSystem();
    const arc = addArc(sys, { cx: 0, cy: 0, rx: 10, ry: 5, theta: 0 }, 0, Math.PI / 2);
    sys.constrain({ kind: "fix", p: center(arc) });
    sys.constrain({ kind: "horizontal", a: entityRef(arc) });
    sys.constrain({ kind: "radius", a: entityRef(arc), value: 10, axis: "x" });
    sys.constrain({ kind: "radius", a: entityRef(arc), value: 5, axis: "y" });
    solve(sys);
    const startBefore = sys.pointValue(start(arc));
    // Pull the end toward the far side of the minor axis.
    const result = solve(sys, { drag: { points: [{ ref: end(arc), x: -7, y: 8 }] } });
    expect(result.outcome).toBe("solved");
    const e = sys.pointValue(end(arc));
    expect(e.x).toBeLessThan(-1);
    expectEndsOnEllipse(sys, arc);
    // The other end is free along the ellipse too: the soft drag pass may
    // stir it a little, but it stays where it was drawn.
    const s = sys.pointValue(start(arc));
    expect(Math.hypot(s.x - startBefore.x, s.y - startBefore.y)).toBeLessThan(0.5);
    expect(frameOf(sys, arc).cx).toBeCloseTo(0, 7);
    expect(frameOf(sys, arc).cy).toBeCloseTo(0, 7);
    expect(frameOf(sys, arc).rx).toBeCloseTo(10, 7);
    expect(frameOf(sys, arc).ry).toBeCloseTo(5, 7);
  });

  it("a dragged center carries the whole arc along", () => {
    const sys = new SketchSystem();
    const arc = addArc(sys, { cx: 0, cy: 0, rx: 10, ry: 5, theta: 0.3 }, 0.2, 2);
    solve(sys);
    const result = solve(sys, { drag: { points: [{ ref: center(arc), x: 6, y: -4 }] } });
    expect(result.outcome).toBe("solved");
    const c = sys.pointValue(center(arc));
    expect(c.x).toBeCloseTo(6, 3);
    expect(c.y).toBeCloseTo(-4, 3);
    expectEndsOnEllipse(sys, arc);
    // A free arc keeps its size under a center drag.
    expect(frameOf(sys, arc).rx).toBeGreaterThan(5);
    expect(frameOf(sys, arc).ry).toBeGreaterThan(2);
  });

  it("an end joined to a fixed line end holds the join while the far end drags", () => {
    const sys = new SketchSystem();
    const arc = addArc(sys, { cx: 0, cy: 0, rx: 10, ry: 5, theta: 0 }, 0, Math.PI / 2);
    const line = sys.line(10, -8, 10, 0);
    sys.constrain({ kind: "fix", p: start(line) });
    sys.constrain({ kind: "fix", p: end(line) });
    sys.constrain({ kind: "coincident", a: start(arc), b: end(line) });
    solve(sys);
    const result = solve(sys, { drag: { points: [{ ref: end(arc), x: -3, y: 9 }] } });
    expect(result.outcome).toBe("solved");
    const s = sys.pointValue(start(arc));
    expect(s.x).toBeCloseTo(10, 7);
    expect(s.y).toBeCloseTo(0, 7);
    expectEndsOnEllipse(sys, arc);
  });
});

describe("elliptical arc geometry helpers", () => {
  const frame: EllipseFrame = { cx: 3, cy: -2, rx: 10, ry: 4, theta: 30 * DEG };

  it("round-trips a parameter through its point", () => {
    for (const t of [-3, -1.2, 0, 0.7, 1.5708, 2.9, Math.PI]) {
      const [x, y] = ellipsePointAt(frame, t);
      expect(ellipseParamOf(frame, x, y)).toBeCloseTo(t, 12);
    }
    expect(ellipseParamOf(frame, frame.cx, frame.cy)).toBe(0);
  });

  it("measures the sweep on the chosen side, a full turn for coincident ends", () => {
    expect(ellipseSweep(0, Math.PI / 2, false)).toBeCloseTo(Math.PI / 2, 12);
    expect(ellipseSweep(0, Math.PI / 2, true)).toBeCloseTo(-1.5 * Math.PI, 12);
    expect(ellipseSweep(3, -3, false)).toBeCloseTo(2 * Math.PI - 6, 12);
    expect(ellipseSweep(1, 1, false)).toBeCloseTo(2 * Math.PI, 12);
    expect(ellipseSweep(1, 1, true)).toBeCloseTo(-2 * Math.PI, 12);
  });

  it("samples from the start to the end and knows which parameters it covers", () => {
    const s = ellipsePointAt(frame, 0.5);
    const e = ellipsePointAt(frame, 2.5);
    const ccw = ellipseArcSpan(frame, s, e, false);
    const cw = ellipseArcSpan(frame, s, e, true);
    expect(ccw.sweep).toBeCloseTo(2, 12);
    expect(cw.sweep).toBeCloseTo(2 - 2 * Math.PI, 12);
    const points = sampleEllipseArc(ccw, 8);
    expect(points.length).toBe(9);
    expect(points[0][0]).toBeCloseTo(s[0], 12);
    expect(points[8][1]).toBeCloseTo(e[1], 12);
    expect(ellipseArcContainsParam(ccw, 1.5)).toBe(true);
    expect(ellipseArcContainsParam(ccw, 3)).toBe(false);
    expect(ellipseArcContainsParam(cw, 3)).toBe(true);
    expect(ellipseArcContainsParam(cw, 1.5)).toBe(false);
    expect(ellipseArcContainsParam(ccw, 2.55, 0.1)).toBe(true);
  });
});
