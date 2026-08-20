import { describe, expect, it } from "vitest";
import {
  ORIGIN_ENTITY,
  SketchSystem,
  X_AXIS_ENTITY,
  Y_AXIS_ENTITY,
  diagnose,
  end,
  entityRef,
  solve,
  start,
} from "../../sketch-solver/index.js";

// The implicit sketch datums: origin point + x/y axis lines as fixed
// reference entities under reserved negative ids. Never-rewrite
// regressions for the datum contract (cross-cutting rule 4).

function withDatums(): SketchSystem {
  const sys = new SketchSystem();
  sys.ensureDatums();
  return sys;
}

describe("sketch datums", () => {
  it("registers origin + axes as fixed entities under the reserved ids, idempotently", () => {
    const sys = withDatums();
    sys.ensureDatums();

    const entities = sys.entities();
    expect(entities).toHaveLength(3);
    expect(entities.map((e) => e.id)).toEqual([ORIGIN_ENTITY, X_AXIS_ENTITY, Y_AXIS_ENTITY]);
    expect(entities.every((e) => e.fixed)).toBe(true);
    expect(sys.entity(ORIGIN_ENTITY).kind).toBe("point");
    expect(sys.entity(X_AXIS_ENTITY).kind).toBe("line");
    expect(sys.entity(Y_AXIS_ENTITY).kind).toBe("line");
    // Datums lead the param table (offsets 0/2/6) so a UI rebuild from the
    // snapshot aligns wholesale param copies.
    expect(sys.entity(ORIGIN_ENTITY).paramOffset).toBe(0);
    expect(sys.entity(X_AXIS_ENTITY).paramOffset).toBe(2);
    expect(sys.entity(Y_AXIS_ENTITY).paramOffset).toBe(6);
  });

  it("keeps statement entity ids in the ≥ 0 range and out of the datum range", () => {
    const sys = withDatums();
    const l = sys.line(1, 2, 3, 4);
    expect(l).toBe(0);
    expect(sys.line(0, 0, 5, 5)).toBe(1);
  });

  it("datums add no DOF and their params never move", () => {
    const sys = withDatums();
    const l = sys.line(3, 5, 40, 9);
    expect(solve(sys).outcome).toBe("solved");
    const d = diagnose(sys);
    expect(d.dof).toBe(4);
    expect(sys.pointValue({ entity: ORIGIN_ENTITY }).x).toBe(0);
    expect(sys.pointValue({ entity: ORIGIN_ENTITY }).y).toBe(0);
    expect(sys.pointValue(start(X_AXIS_ENTITY))).toEqual({ x: 0, y: 0 });
    expect(sys.pointValue(end(X_AXIS_ENTITY))).toEqual({ x: 1, y: 0 });
    void l;
  });

  it("coincident to the origin pins a vertex at (0,0)", () => {
    const sys = withDatums();
    const l = sys.line(2, 3, 50, 3);
    sys.constrain({ kind: "coincident", a: start(l), b: { entity: ORIGIN_ENTITY } });
    expect(solve(sys).outcome).toBe("solved");
    const s = sys.pointValue(start(l));
    expect(s.x).toBeCloseTo(0, 8);
    expect(s.y).toBeCloseTo(0, 8);
  });

  it("collinear with the x axis flattens a line onto y = 0", () => {
    const sys = withDatums();
    const l = sys.line(5, 2, 60, -1);
    sys.constrain({ kind: "collinear", a: entityRef(X_AXIS_ENTITY), b: entityRef(l) });
    expect(solve(sys).outcome).toBe("solved");
    expect(sys.pointValue(start(l)).y).toBeCloseTo(0, 8);
    expect(sys.pointValue(end(l)).y).toBeCloseTo(0, 8);
  });

  it("point-on-axis (coincident with the y axis) zeroes the x coordinate", () => {
    const sys = withDatums();
    const p = sys.point(7, 30);
    sys.constrain({ kind: "coincident", a: { entity: p }, b: entityRef(Y_AXIS_ENTITY) });
    expect(solve(sys).outcome).toBe("solved");
    expect(sys.pointValue({ entity: p }).x).toBeCloseTo(0, 8);
    expect(sys.pointValue({ entity: p }).y).toBeCloseTo(30, 6);
  });

  it("symmetric about the y axis mirrors two points", () => {
    const sys = withDatums();
    const a = sys.point(-22, 9);
    const b = sys.point(26, 11);
    sys.constrain({ kind: "fix", p: { entity: a } });
    sys.constrain({ kind: "symmetric", a: { entity: a }, b: { entity: b }, l: entityRef(Y_AXIS_ENTITY) });
    expect(solve(sys).outcome).toBe("solved");
    expect(sys.pointValue({ entity: b }).x).toBeCloseTo(22, 7);
    expect(sys.pointValue({ entity: b }).y).toBeCloseTo(9, 7);
  });

  it("distance from the origin along an axis dimensions a center", () => {
    const sys = withDatums();
    const c = sys.circle(38, 24, 10);
    sys.constrain({
      kind: "distance", a: { entity: ORIGIN_ENTITY }, b: { entity: c, point: "center" },
      value: 40, axis: "x",
    });
    sys.constrain({
      kind: "distance", a: { entity: ORIGIN_ENTITY }, b: { entity: c, point: "center" },
      value: 25, axis: "y",
    });
    expect(solve(sys).outcome).toBe("solved");
    expect(sys.pointValue({ entity: c, point: "center" }).x).toBeCloseTo(40, 7);
    expect(sys.pointValue({ entity: c, point: "center" }).y).toBeCloseTo(25, 7);
  });

  it("angle from the x axis orients a line", () => {
    const sys = withDatums();
    const l = sys.line(0, 0, 40, 8);
    sys.constrain({ kind: "fix", p: start(l) });
    sys.constrain({ kind: "distance", a: start(l), b: end(l), value: 40 });
    sys.constrain({
      kind: "angle", a: entityRef(X_AXIS_ENTITY), b: entityRef(l), value: Math.PI / 6,
    });
    expect(solve(sys).outcome).toBe("solved");
    const e = sys.pointValue(end(l));
    expect(e.x).toBeCloseTo(40 * Math.cos(Math.PI / 6), 6);
    expect(e.y).toBeCloseTo(40 * Math.sin(Math.PI / 6), 6);
  });

  it("names datums, not raw ids, in resolution errors", () => {
    const sys = withDatums();
    expect(() =>
      sys.constrain({ kind: "radius", a: entityRef(X_AXIS_ENTITY), value: 5 }),
    ).toThrow(/the sketch x-axis/);
    expect(() =>
      sys.constrain({
        kind: "coincident",
        a: entityRef(ORIGIN_ENTITY),
        b: { entity: Y_AXIS_ENTITY, point: "center" },
      }),
    ).toThrow(/the sketch y-axis/);
  });

  it("conflicting datum constraints are attributed, not silently absorbed", () => {
    const sys = withDatums();
    const p = sys.point(4, 4);
    const onX = sys.constrain({ kind: "coincident", a: { entity: p }, b: entityRef(X_AXIS_ENTITY) });
    const off = sys.constrain({
      kind: "distance", a: { entity: ORIGIN_ENTITY }, b: { entity: p }, value: 30, axis: "y",
    });
    solve(sys);
    const d = diagnose(sys);
    expect(d.conflicting.length).toBeGreaterThan(0);
    for (const id of d.conflicting) {
      expect([onX, off]).toContain(id);
    }
  });

  it("a free point drawn at the origin does not glue to it during drags", () => {
    const sys = withDatums();
    const p = sys.point(0, 0);
    const result = solve(sys, { drag: { points: [{ ref: { entity: p }, x: 12, y: -7 }] } });
    expect(result.outcome).toBe("solved");
    expect(sys.pointValue({ entity: p }).x).toBeCloseTo(12, 4);
    expect(sys.pointValue({ entity: p }).y).toBeCloseTo(-7, 4);
    // The origin itself never moved.
    expect(sys.pointValue({ entity: ORIGIN_ENTITY })).toEqual({ x: 0, y: 0 });
  });

  it("free endpoints sharing the origin's position still glue to each other", () => {
    const sys = withDatums();
    const a = sys.line(0, 0, 30, 0);
    const b = sys.line(0, 0, 0, 30);
    // Drag a's start: b's start coincides by value and must follow (one
    // cluster), while the origin datum stays put and holds nothing back.
    const result = solve(sys, { drag: { points: [{ ref: start(a), x: 5, y: 6 }] } });
    expect(result.outcome).toBe("solved");
    const aS = sys.pointValue(start(a));
    const bS = sys.pointValue(start(b));
    expect(aS.x).toBeCloseTo(bS.x, 6);
    expect(aS.y).toBeCloseTo(bS.y, 6);
    expect(aS.x).toBeCloseTo(5, 4);
    expect(sys.pointValue({ entity: ORIGIN_ENTITY })).toEqual({ x: 0, y: 0 });
  });
});
