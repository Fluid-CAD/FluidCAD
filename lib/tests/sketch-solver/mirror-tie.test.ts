import { describe, expect, it } from "vitest";
import {
  SketchSystem,
  X_AXIS_ENTITY,
  Y_AXIS_ENTITY,
  center,
  diagnose,
  end,
  entityRef,
  solve,
  start,
} from "../../sketch-solver/index.js";

// mirror-tie — the internal reflection tie that makes a 2D mirror image
// first-class: target = reflect(source, axis), one row per target param.
// The axis is a solver LINE entity (rows nonlinear in its params: a
// moving mirror line moves its images) or a constant sketch-local line.
// Never-rewrite regressions for the tie contract: bidirectional
// coupling, images following the axis, net-zero DOF, tie ids invisible
// to diagnostics, radius preserved, arcs keep start→start.

const Y_LINE: [number, number, number, number] = [0, 0, 0, 1];

function reflectAcrossY(x: number, y: number): [number, number] {
  return [-x, y];
}

describe("mirror-tie", () => {
  it("a fixed-axis tie: constraining the image moves the source", () => {
    const sys = new SketchSystem();
    const src = sys.line(10, 0, 30, 6);
    const dup = sys.line(-10, 0, -30, 6);
    sys.addMirrorTie(src, dup, Y_LINE);
    sys.constrain({ kind: "fix", p: start(dup) }); // captured at (-10, 0)
    sys.constrain({ kind: "horizontal", a: entityRef(dup) });
    sys.constrain({ kind: "distance", a: start(dup), b: end(dup), value: 25 });
    expect(solve(sys).outcome).toBe("solved");
    expect(sys.pointValue(start(src)).x).toBeCloseTo(10, 6);
    expect(sys.pointValue(start(src)).y).toBeCloseTo(0, 6);
    expect(sys.pointValue(end(src)).x).toBeCloseTo(35, 6);
    expect(sys.pointValue(end(src)).y).toBeCloseTo(0, 6);
    for (const role of [start, end]) {
      const s = sys.pointValue(role(src));
      const q = sys.pointValue(role(dup));
      const [rx, ry] = reflectAcrossY(s.x, s.y);
      expect(q.x).toBeCloseTo(rx, 7);
      expect(q.y).toBeCloseTo(ry, 7);
    }
  });

  it("an entity-axis tie against the Y datum matches the fixed form", () => {
    const sys = new SketchSystem();
    sys.ensureDatums();
    const src = sys.point(10, 2);
    const dup = sys.point(-10, 2);
    sys.addMirrorTie(src, dup, { entity: Y_AXIS_ENTITY });
    sys.constrain({ kind: "fix", p: { entity: dup }, x: -5, y: 25 });
    expect(solve(sys).outcome).toBe("solved");
    expect(sys.pointValue({ entity: src }).x).toBeCloseTo(5, 7);
    expect(sys.pointValue({ entity: src }).y).toBeCloseTo(25, 7);
  });

  it("images follow a FREE mirror line: rotating the axis moves the image, not the source", () => {
    const sys = new SketchSystem();
    // Axis: the vertical line x = 0 (guess), free to rotate about its start.
    const axis = sys.line(0, 0, 0, 40);
    const src = sys.point(10, 20);
    const dup = sys.point(-10, 20);
    sys.addMirrorTie(src, dup, { entity: axis });
    sys.constrain({ kind: "fix", p: { entity: src } });
    sys.constrain({ kind: "fix", p: start(axis) });
    // Force the axis to the diagonal y = x: the image of (10, 20) is (20, 10).
    sys.constrain({ kind: "fix", p: end(axis), x: 40, y: 40 });
    expect(solve(sys).outcome).toBe("solved");
    expect(sys.pointValue({ entity: src }).x).toBeCloseTo(10, 7);
    expect(sys.pointValue({ entity: src }).y).toBeCloseTo(20, 7);
    expect(sys.pointValue({ entity: dup }).x).toBeCloseTo(20, 6);
    expect(sys.pointValue({ entity: dup }).y).toBeCloseTo(10, 6);
  });

  it("constraining the image can drive the mirror LINE when the source is pinned", () => {
    const sys = new SketchSystem();
    const axis = sys.line(0, -10, 0, 50);
    const src = sys.point(10, 20);
    const dup = sys.point(-10, 20);
    sys.addMirrorTie(src, dup, { entity: axis });
    sys.constrain({ kind: "fix", p: { entity: src } });
    sys.constrain({ kind: "vertical", a: entityRef(axis) });
    sys.constrain({ kind: "distance", a: start(axis), b: end(axis), value: 60 });
    // Ask the image 40 away from the pinned source: the vertical axis must
    // slide to x = -10 (its position along itself stays free — fine).
    sys.constrain({ kind: "distance", a: { entity: dup }, b: { entity: src }, value: 40 });
    expect(solve(sys).outcome).toBe("solved");
    const q = sys.pointValue({ entity: dup });
    expect(Math.abs(q.x - 10)).toBeCloseTo(40, 5);
    expect(q.y).toBeCloseTo(20, 6);
    const axisX = sys.pointValue(start(axis)).x;
    expect(axisX).toBeCloseTo((q.x + 10) / 2, 5);
  });

  it("circle and arc images keep the radius; arcs tie start→start", () => {
    const sys = new SketchSystem();
    sys.ensureDatums();
    const c = sys.circle(20, 5, 7);
    const cImage = sys.circle(20, -5, 7);
    sys.addMirrorTie(c, cImage, { entity: X_AXIS_ENTITY });
    const a = sys.arc(0, 0, 10, 0, 0, 10);
    const aImage = sys.arc(0, 0, 10, 0, 0, -10);
    sys.addMirrorTie(a, aImage, { entity: X_AXIS_ENTITY });
    sys.constrain({ kind: "radius", a: entityRef(cImage), value: 9 });
    sys.constrain({ kind: "fix", p: center(c), x: 20, y: 8 });
    sys.constrain({ kind: "fix", p: center(a), x: 0, y: 0 });
    sys.constrain({ kind: "fix", p: start(a), x: 12, y: 0 });
    sys.constrain({ kind: "fix", p: end(aImage), x: 0, y: -12 });
    expect(solve(sys).outcome).toBe("solved");
    // Radius flowed through the tie into the source circle.
    expect(sys.values[sys.entity(c).paramOffset + 2]).toBeCloseTo(9, 7);
    expect(sys.pointValue(center(cImage)).y).toBeCloseTo(-8, 7);
    // Arc: the image's end is the reflection of the source's end.
    expect(sys.pointValue(end(a)).x).toBeCloseTo(0, 6);
    expect(sys.pointValue(end(a)).y).toBeCloseTo(12, 6);
    expect(sys.pointValue(start(aImage)).x).toBeCloseTo(12, 6);
    expect(sys.pointValue(start(aImage)).y).toBeCloseTo(0, 6);
    expect(sys.values[sys.entity(aImage).paramOffset + 2]).toBeCloseTo(12, 6);
  });

  it("net-zero DOF and never named by diagnose, even when a user pin conflicts across it", () => {
    const sys = new SketchSystem();
    sys.ensureDatums();
    const src = sys.point(10, 5);
    const dup = sys.point(-10, 5);
    const tieId = sys.addMirrorTie(src, dup, { entity: Y_AXIS_ENTITY });
    expect(tieId).toBeLessThan(0);
    // One free point behind the tie: 2 DOF.
    expect(diagnose(sys).dof).toBe(2);
    sys.constrain({ kind: "fix", p: { entity: src } });
    const conflicting = sys.constrain({ kind: "fix", p: { entity: dup }, x: 100, y: 100 });
    solve(sys);
    const d = diagnose(sys);
    expect(d.conflicting).toContain(conflicting);
    expect(d.conflicting).not.toContain(tieId);
    expect(d.redundant).not.toContain(tieId);
  });

  it("refuses ties between different kinds and self-ties", () => {
    const sys = new SketchSystem();
    const p = sys.point(1, 1);
    const l = sys.line(0, 0, 1, 0);
    expect(() => sys.addMirrorTie(p, l, Y_LINE)).toThrow(/same kind/);
    expect(() => sys.addMirrorTie(p, p, Y_LINE)).toThrow(/same entity/);
  });
});
