import { describe, expect, it } from "vitest";
import {
  SketchSystem,
  diagnose,
  end,
  entityRef,
  solve,
  start,
} from "../../sketch-solver/index.js";

// transform-tie — the internal affine tie that makes a derived entity
// (a 2D copy instance) first-class: target = M·source + t, one linear
// row per target param. Never-rewrite regressions for the tie
// contract: bidirectional coupling, net-zero DOF, tie ids invisible
// to diagnostics, radius round-trips, drag through ties.

type TieMatrix = [number, number, number, number, number, number];

const TRANSLATE_30: TieMatrix = [1, 0, 0, 1, 30, 0];

/** 90° CCW rotation about (u, v): M = [[0,-1],[1,0]], t = c − M·c. */
function rotation90About(u: number, v: number): TieMatrix {
  return [0, -1, 1, 0, u + v, v - u];
}

function radiusOf(sys: SketchSystem, entity: number): number {
  return sys.values[sys.entity(entity).paramOffset + 2];
}

describe("transform-tie", () => {
  it("constraining the duplicate moves the source through a translation tie", () => {
    const sys = new SketchSystem();
    const src = sys.line(0, 0, 20, 6);
    const dup = sys.line(30, 0, 50, 6);
    sys.addTransformTie(src, dup, TRANSLATE_30);
    // All user constraints sit on the DUPLICATE — the tie must carry
    // them back to the source.
    sys.constrain({ kind: "fix", p: start(dup) }); // captured at (30, 0)
    sys.constrain({ kind: "horizontal", a: entityRef(dup) });
    sys.constrain({ kind: "distance", a: start(dup), b: end(dup), value: 25 });
    expect(solve(sys).outcome).toBe("solved");
    expect(sys.pointValue(start(src)).x).toBeCloseTo(0, 6);
    expect(sys.pointValue(start(src)).y).toBeCloseTo(0, 6);
    expect(sys.pointValue(end(src)).x).toBeCloseTo(25, 6);
    expect(sys.pointValue(end(src)).y).toBeCloseTo(0, 6);
    // The duplicate lands exactly at source + (30, 0).
    for (const role of [start, end]) {
      const s = sys.pointValue(role(src));
      const q = sys.pointValue(role(dup));
      expect(q.x).toBeCloseTo(s.x + 30, 7);
      expect(q.y).toBeCloseTo(s.y, 7);
    }
  });

  it("a 90° rotation tie: pinning the duplicate places the source exactly", () => {
    const sys = new SketchSystem();
    const src = sys.point(10, 2);
    const dup = sys.point(-2, 10); // R90 · (10, 2)
    sys.addTransformTie(src, dup, rotation90About(0, 0));
    sys.constrain({ kind: "fix", p: { entity: dup }, x: -5, y: 25 });
    expect(solve(sys).outcome).toBe("solved");
    // source = R⁻¹ · (-5, 25) = (25, 5)
    expect(sys.pointValue({ entity: src }).x).toBeCloseTo(25, 7);
    expect(sys.pointValue({ entity: src }).y).toBeCloseTo(5, 7);
    expect(sys.pointValue({ entity: dup }).x).toBeCloseTo(-5, 7);
    expect(sys.pointValue({ entity: dup }).y).toBeCloseTo(25, 7);
  });

  it("a rotated line copy: horizontal on the duplicate makes the source vertical", () => {
    const sys = new SketchSystem();
    // (x, y) → (20 − y, x): 90° CCW about (10, 10).
    const src = sys.line(12, 10, 12, 30);
    const dup = sys.line(10, 12, -10, 12);
    sys.addTransformTie(src, dup, rotation90About(10, 10));
    sys.constrain({ kind: "fix", p: start(dup), x: 12, y: 14 });
    sys.constrain({ kind: "horizontal", a: entityRef(dup) });
    sys.constrain({ kind: "distance", a: start(dup), b: end(dup), value: 25 });
    expect(solve(sys).outcome).toBe("solved");
    // Source start = inverse map of (12, 14) = (14, 8); end 25 up.
    expect(sys.pointValue(start(src)).x).toBeCloseTo(14, 6);
    expect(sys.pointValue(start(src)).y).toBeCloseTo(8, 6);
    expect(sys.pointValue(end(src)).x).toBeCloseTo(14, 6);
    expect(sys.pointValue(end(src)).y).toBeCloseTo(33, 6);
  });

  it("a tied duplicate adds zero net DOF and mirrors the source's free state", () => {
    const sys = new SketchSystem();
    const src = sys.line(0, 0, 20, 0);
    sys.constrain({ kind: "horizontal", a: entityRef(src) });
    sys.constrain({ kind: "fix", p: start(src) });
    const before = diagnose(sys).dof;
    const dup = sys.line(30, 0, 50, 0);
    sys.addTransformTie(src, dup, TRANSLATE_30);
    const after = diagnose(sys);
    expect(after.dof).toBe(before);
    expect(after.conflicting).toEqual([]);
    expect(after.redundant).toEqual([]);
    // The one remaining freedom (length) moves both — the duplicate
    // mirrors the source's under-constrained status.
    expect(after.underconstrainedEntities).toEqual([src, dup]);
  });

  it("a tied arc adds zero net DOF (its own consistency rides the tie)", () => {
    const sys = new SketchSystem();
    const src = sys.arc(0, 0, 10, 0, 0, 10);
    const before = diagnose(sys).dof;
    const dup = sys.arc(30, 0, 40, 0, 30, 10);
    sys.addTransformTie(src, dup, TRANSLATE_30);
    // The duplicate's arc-consistency record was dropped: the tie
    // plus the source's rows imply it, so nothing reads redundant.
    const consistency = sys
      .constraints()
      .filter((c) => c.spec.kind === "arc-consistency")
      .map((c) => (c.spec.kind === "arc-consistency" ? c.spec.entity : -1));
    expect(consistency).toEqual([src]);
    const after = diagnose(sys);
    expect(after.dof).toBe(before);
    expect(after.conflicting).toEqual([]);
    expect(after.redundant).toEqual([]);
  });

  it("a fully constrained source leaves the tied duplicate fully constrained", () => {
    const sys = new SketchSystem();
    const src = sys.line(0, 0, 20, 0);
    sys.constrain({ kind: "fix", p: start(src) });
    sys.constrain({ kind: "fix", p: end(src) });
    const dup = sys.line(30, 0, 50, 0);
    sys.addTransformTie(src, dup, TRANSLATE_30);
    expect(solve(sys).outcome).toBe("solved");
    const d = diagnose(sys);
    expect(d.dof).toBe(0);
    expect(d.underconstrainedEntities).toEqual([]);
  });

  it("circle tie: center transformed, radius equality runs both ways", () => {
    const sys = new SketchSystem();
    const src = sys.circle(5, 5, 7);
    const dup = sys.circle(-5, 5, 7); // 90° about the origin
    sys.addTransformTie(src, dup, rotation90About(0, 0));
    sys.constrain({ kind: "fix", p: { entity: dup, point: "center" }, x: -8, y: 12 });
    sys.constrain({ kind: "radius", a: entityRef(dup), value: 9 });
    expect(solve(sys).outcome).toBe("solved");
    const sc = sys.pointValue({ entity: src, point: "center" });
    expect(sc.x).toBeCloseTo(12, 7);
    expect(sc.y).toBeCloseTo(8, 7);
    // Dimensioning the duplicate's radius resized the source.
    expect(radiusOf(sys, src)).toBeCloseTo(9, 7);
    expect(radiusOf(sys, dup)).toBeCloseTo(9, 7);
  });

  it("arc tie: center/start transformed, radius preserved, consistency intact", () => {
    const sys = new SketchSystem();
    const src = sys.arc(0, 0, 10, 0, 0, 10);
    const dup = sys.arc(30, 0, 40, 0, 30, 10);
    sys.addTransformTie(src, dup, TRANSLATE_30);
    sys.constrain({ kind: "fix", p: { entity: dup, point: "center" }, x: 32, y: 4 });
    sys.constrain({ kind: "radius", a: entityRef(dup), value: 12 });
    sys.constrain({ kind: "fix", p: start(dup), x: 44, y: 4 });
    expect(solve(sys).outcome).toBe("solved");
    expect(sys.pointValue({ entity: src, point: "center" }).x).toBeCloseTo(2, 6);
    expect(sys.pointValue({ entity: src, point: "center" }).y).toBeCloseTo(4, 6);
    expect(sys.pointValue(start(src)).x).toBeCloseTo(14, 6);
    expect(sys.pointValue(start(src)).y).toBeCloseTo(4, 6);
    expect(radiusOf(sys, src)).toBeCloseTo(12, 6);
    expect(radiusOf(sys, dup)).toBeCloseTo(12, 6);
    // Even without its own consistency rows the duplicate's free end
    // stays on its circle — carried over from the source's rows.
    const dc = sys.pointValue({ entity: dup, point: "center" });
    const de = sys.pointValue(end(dup));
    expect(Math.hypot(de.x - dc.x, de.y - dc.y)).toBeCloseTo(12, 6);
  });

  it("a mirror tie (det = −1) is accepted and round-trips a circle", () => {
    const sys = new SketchSystem();
    const src = sys.circle(8, 3, 5);
    const dup = sys.circle(-8, 3, 5); // mirrored across the y axis
    sys.addTransformTie(src, dup, [-1, 0, 0, 1, 0, 0]);
    sys.constrain({ kind: "fix", p: { entity: dup, point: "center" }, x: -11, y: 6 });
    expect(solve(sys).outcome).toBe("solved");
    const sc = sys.pointValue({ entity: src, point: "center" });
    expect(sc.x).toBeCloseTo(11, 7);
    expect(sc.y).toBeCloseTo(6, 7);
    expect(radiusOf(sys, src)).toBeCloseTo(5, 7);
    expect(radiusOf(sys, dup)).toBeCloseTo(5, 7);
  });

  it("incompatible pins across a tie name only the user constraints", () => {
    const sys = new SketchSystem();
    const src = sys.point(0, 0);
    const dup = sys.point(30, 0);
    sys.addTransformTie(src, dup, TRANSLATE_30);
    const pinSrc = sys.constrain({ kind: "fix", p: { entity: src } }); // (0, 0)
    const pinDup = sys.constrain({ kind: "fix", p: { entity: dup }, x: 45, y: 0 });
    solve(sys);
    const d = diagnose(sys);
    expect(d.conflicting.length).toBeGreaterThan(0);
    for (const id of [...d.conflicting, ...d.redundant]) {
      expect(id).toBeGreaterThanOrEqual(0);
      expect([pinSrc, pinDup]).toContain(id);
    }
  });

  it("dragging the duplicate pulls the source through the tie", () => {
    const sys = new SketchSystem();
    const src = sys.point(0, 0);
    const dup = sys.point(30, 0);
    sys.addTransformTie(src, dup, TRANSLATE_30);
    const result = solve(sys, { drag: { points: [{ ref: { entity: dup }, x: 50, y: 7 }] } });
    expect(result.outcome).toBe("solved");
    expect(sys.pointValue({ entity: dup }).x).toBeCloseTo(50, 4);
    expect(sys.pointValue({ entity: dup }).y).toBeCloseTo(7, 4);
    expect(sys.pointValue({ entity: src }).x).toBeCloseTo(20, 4);
    expect(sys.pointValue({ entity: src }).y).toBeCloseTo(7, 4);
  });

  it("dragging the source stays convergent with ties present", () => {
    const sys = new SketchSystem();
    const src = sys.line(0, 0, 20, 0);
    sys.constrain({ kind: "horizontal", a: entityRef(src) });
    const dup = sys.line(30, 0, 50, 0);
    sys.addTransformTie(src, dup, TRANSLATE_30);
    const result = solve(sys, { drag: { points: [{ ref: end(src), x: 35, y: 9 }] } });
    expect(result.outcome).toBe("solved");
    expect(sys.pointValue(end(src)).x).toBeCloseTo(35, 4);
    // Horizontal held, and the duplicate followed exactly.
    expect(sys.pointValue(end(src)).y).toBeCloseTo(sys.pointValue(start(src)).y, 6);
    expect(sys.pointValue(end(dup)).x).toBeCloseTo(sys.pointValue(end(src)).x + 30, 6);
    expect(sys.pointValue(end(dup)).y).toBeCloseTo(sys.pointValue(end(src)).y, 6);
  });

  it("ties ride the snapshot as internal records and survive JSON", () => {
    const sys = new SketchSystem();
    const src = sys.circle(5, 5, 7);
    const dup = sys.circle(35, 5, 7);
    const tieId = sys.addTransformTie(src, dup, TRANSLATE_30);
    expect(tieId).toBeLessThan(0);
    const snap = sys.snapshot();
    const tie = snap.constraints.find((c) => c.spec.kind === "transform-tie");
    expect(tie).toBeDefined();
    expect(tie!.internal).toBe(true);
    expect(tie!.id).toBe(tieId);
    expect(JSON.parse(JSON.stringify(snap))).toEqual(snap);
  });

  it("rejects mismatched kinds, self-ties, and non-similarity circle maps", () => {
    const sys = new SketchSystem();
    const p = sys.point(0, 0);
    const l = sys.line(0, 0, 10, 0);
    expect(() => sys.addTransformTie(p, l, TRANSLATE_30)).toThrow(/same kind/);
    expect(() => sys.addTransformTie(p, p, TRANSLATE_30)).toThrow(/same entity/);
    const c1 = sys.circle(0, 0, 5);
    const c2 = sys.circle(10, 0, 5);
    expect(() => sys.addTransformTie(c1, c2, [2, 0, 0, 1, 10, 0])).toThrow(/similarity/);
  });
});
