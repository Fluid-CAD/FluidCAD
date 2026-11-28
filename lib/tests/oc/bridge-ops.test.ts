import { afterEach, describe, expect, it } from "vitest";
import type { GeomAbs_Shape, Geom_Curve, TopoDS_Edge } from "ocjs-fluidcad";
import { getOC } from "../../oc/init.js";
import { BridgeOps, type BridgeContinuity } from "../../oc/bridge-ops.js";
import { EdgeOps } from "../../oc/edge-ops.js";
import { Geometry } from "../../oc/geometry.js";
import { Edge } from "../../common/edge.js";
import { CurveEnds, type CurveEnd } from "../../helpers/curve-end.js";
import { Point } from "../../math/point.js";
import { Vector3d } from "../../math/vector3d.js";

const owned: Edge[] = [];
afterEach(() => {
  owned.splice(0).forEach(e => e.dispose());
});

const round = (value: number) => +value.toFixed(6) + 0;
const xyz = (v: Point | Vector3d) => [v.x, v.y, v.z].map(round);

/** An edge the test frees. */
function keep(e: Edge): Edge {
  owned.push(e);
  return e;
}

function segment(from: [number, number, number], to: [number, number, number]): Edge {
  return keep(EdgeOps.makeLineEdge(new Point(...from), new Point(...to)));
}

/** An arc of `radius` about `center` in XY, from `start` to `end`, anticlockwise. */
function arcEdge(center: [number, number, number], radius: number, start: [number, number, number], end: [number, number, number]): Edge {
  const curve = Geometry.makeArc(new Point(...center), radius, new Vector3d(0, 0, 1), new Point(...start), new Point(...end));
  try {
    return keep(Geometry.makeEdgeFromCurve(curve));
  } finally {
    curve.delete();
  }
}

/** The bridge at one continuity for both ends, or `[start, end]`. */
function bridge(
  from: CurveEnd, to: CurveEnd, continuity: BridgeContinuity | [BridgeContinuity, BridgeContinuity], startMagnitude = 1, endMagnitude = 1,
): Edge {
  const [startContinuity, endContinuity] = Array.isArray(continuity) ? continuity : [continuity, continuity];
  return keep(BridgeOps.make(from, to, { startContinuity, endContinuity, startMagnitude, endMagnitude }));
}

/** The bridge's curve as the kernel holds it: its degree and poles (a line has degree 1 and its two ends). */
function curveOf(e: Edge): { degree: number; poles: number[][]; line: boolean } {
  const oc = getOC();
  const adaptor = new oc.BRepAdaptor_Curve(e.getShape() as TopoDS_Edge);
  try {
    if (adaptor.GetType() === oc.GeomAbs_CurveType.GeomAbs_Line) {
      return { degree: 1, poles: [xyz(e.getFirstPoint()), xyz(e.getLastPoint())], line: true };
    }
    expect(adaptor.GetType()).toBe(oc.GeomAbs_CurveType.GeomAbs_BezierCurve);
    const bezier = adaptor.Bezier();
    try {
      const poles: number[][] = [];
      for (let i = 1; i <= bezier.NbPoles(); i++) {
        const pole = bezier.Pole(i);
        poles.push([pole.X(), pole.Y(), pole.Z()].map(round));
        pole.delete();
      }
      return { degree: bezier.Degree(), poles, line: false };
    } finally {
      bezier.delete();
    }
  } finally {
    adaptor.delete();
  }
}

/**
 * The continuity the kernel finds where `first` runs into `second`:
 * `first` at the parameter where it ends (its last, or with `firstAt:
 * 'first'` its first), `second` where it starts. The kernel's angle is
 * between lines — a curve doubling back reads as tangent — so `sameWay`
 * says whether the two first derivatives also point the same way.
 */
function joint(
  first: Edge, second: Edge, order: 'G1' | 'G2',
  firstAt: 'first' | 'last' = 'last', secondAt: 'first' | 'last' = 'first',
): { c0: number; g1: boolean; g2: boolean; angle: number; sameWay: boolean } {
  const oc = getOC();
  const a = oc.BRep_Tool.Curve(first.getShape() as TopoDS_Edge, 0, 1);
  const b = oc.BRep_Tool.Curve(second.getShape() as TopoDS_Edge, 0, 1);
  const u1 = firstAt === 'last' ? a.Last : a.First;
  const u2 = secondAt === 'last' ? b.Last : b.First;
  const shape = (order === 'G1' ? oc.GeomAbs_Shape.GeomAbs_G1 : oc.GeomAbs_Shape.GeomAbs_G2) as GeomAbs_Shape;
  const analysis = new oc.LocalAnalysis_CurveContinuity(a.returnValue as Geom_Curve, u1, b.returnValue as Geom_Curve, u2, shape);
  const derivative = (curve: Geom_Curve, u: number) => {
    const pnt = new oc.gp_Pnt();
    const vec = new oc.gp_Vec();
    curve.D1(u, pnt, vec);
    const result = new Vector3d(vec.X(), vec.Y(), vec.Z());
    pnt.delete();
    vec.delete();
    return result;
  };
  try {
    expect(analysis.IsDone()).toBe(true);
    return {
      c0: analysis.C0Value(),
      g1: analysis.IsG1(),
      g2: order === 'G2' ? analysis.IsG2() : false,
      angle: analysis.G1Angle(),
      sameWay: derivative(a.returnValue as Geom_Curve, u1).dot(derivative(b.returnValue as Geom_Curve, u2)) > 0,
    };
  } finally {
    analysis.delete();
    a[Symbol.dispose]();
    b[Symbol.dispose]();
  }
}

/** Every point lies on the line through `a` and `b`. */
function collinear(points: number[][], a: Point, b: Point): boolean {
  const along = a.vectorTo(b).normalize();
  return points.every(p => {
    const off = a.vectorTo(new Point(p[0], p[1], p[2]));
    return off.cross(along).length() < 1e-9;
  });
}

describe("BridgeOps", () => {
  it("g0: a straight edge between the two points", () => {
    const a = segment([0, 0, 0], [10, 0, 0]);
    const b = segment([20, 10, 0], [30, 10, 0]);
    const br = bridge(CurveEnds.ofEdge(a, "end"), CurveEnds.ofEdge(b, "start"), "g0");

    expect(curveOf(br)).toEqual({ degree: 1, poles: [[10, 0, 0], [20, 10, 0]], line: true });
    expect(joint(a, br, 'G1').g1).toBe(false);
  });

  it("g1 across a gap between two collinear lines: straight, every pole on the line", () => {
    const a = segment([0, 0, 0], [10, 0, 0]);
    const b = segment([20, 0, 0], [30, 0, 0]);
    const br = bridge(CurveEnds.ofEdge(a, "end"), CurveEnds.ofEdge(b, "start"), "g1");

    const curve = curveOf(br);
    expect(curve.degree).toBe(3);
    expect(curve.poles[0]).toEqual([10, 0, 0]);
    expect(curve.poles[3]).toEqual([20, 0, 0]);
    expect(collinear(curve.poles, new Point(0, 0, 0), new Point(1, 0, 0))).toBe(true);
    // Each inner pole a third of the gap in from its end.
    expect(curve.poles[1][0]).toBeCloseTo(10 + 10 / 3, 5);
    expect(curve.poles[2][0]).toBeCloseTo(20 - 10 / 3, 5);
  });

  it("g1 between two perpendicular lines: a cubic, leaving and arriving along them, G1 by the kernel at both joints", () => {
    const a = segment([0, 0, 0], [10, 0, 0]);
    const b = segment([20, 10, 0], [20, 20, 0]);
    const from = CurveEnds.ofEdge(a, "end");
    const to = CurveEnds.ofEdge(b, "start");
    const br = bridge(from, to, "g1");

    expect(curveOf(br).degree).toBe(3);
    // Out of the bridge at its start is back along a; at its end, on up b.
    expect(xyz(CurveEnds.ofEdge(br, "start").tangent!)).toEqual([-1, 0, 0]);
    expect(xyz(CurveEnds.ofEdge(br, "end").tangent!)).toEqual([0, 1, 0]);

    const entry = joint(a, br, 'G1');
    const exit = joint(br, b, 'G1');
    expect(entry).toMatchObject({ g1: true, sameWay: true });
    expect(entry.c0).toBeLessThan(1e-9);
    expect(exit).toMatchObject({ g1: true, sameWay: true });
    expect(exit.c0).toBeLessThan(1e-9);
  });

  it("g2 between two arcs: a quintic with each arc's curvature at its joint, G2 by the kernel at both", () => {
    // A rises anticlockwise to (5, 0, 0), heading +Y; B leaves (15, 0, 0) anticlockwise, heading −Y.
    const a = arcEdge([0, 0, 0], 5, [0, -5, 0], [5, 0, 0]);
    const b = arcEdge([20, 0, 0], 5, [15, 0, 0], [20, -5, 0]);
    const from = CurveEnds.ofEdge(a, "end");
    const to = CurveEnds.ofEdge(b, "start");
    expect(xyz(from.tangent!)).toEqual([0, 1, 0]);
    expect(xyz(to.tangent!)).toEqual([0, 1, 0]);
    const br = bridge(from, to, "g2");

    expect(curveOf(br).degree).toBe(5);
    expect(xyz(CurveEnds.ofEdge(br, "start").curvature!)).toEqual(xyz(from.curvature!));
    expect(xyz(CurveEnds.ofEdge(br, "end").curvature!)).toEqual(xyz(to.curvature!));
    expect(Math.hypot(...xyz(CurveEnds.ofEdge(br, "start").curvature!))).toBeCloseTo(0.2, 9);

    const entry = joint(a, br, 'G2');
    const exit = joint(br, b, 'G2');
    expect(entry).toMatchObject({ g1: true, g2: true, sameWay: true });
    expect(exit).toMatchObject({ g1: true, g2: true, sameWay: true });

    // The same arcs at g1: tangent, and the kernel sees the curvature jump.
    const tangent = bridge(from, to, "g1");
    expect(joint(a, tangent, 'G2')).toMatchObject({ g1: true, g2: false });
  });

  it("g2 at a straight end matches its zero curvature: the second pole stays on the line", () => {
    const a = segment([0, 0, 0], [10, 0, 0]);
    const b = segment([20, 10, 0], [20, 20, 0]);
    const curve = curveOf(bridge(CurveEnds.ofEdge(a, "end"), CurveEnds.ofEdge(b, "start"), "g2"));

    expect(curve.degree).toBe(5);
    expect(collinear(curve.poles.slice(0, 3), new Point(0, 0, 0), new Point(1, 0, 0))).toBe(true);
    expect(collinear(curve.poles.slice(3), new Point(20, 0, 0), new Point(20, 1, 0))).toBe(true);
  });

  it("doubling startMagnitude moves the second pole twice as far; the joints stay G1", () => {
    const a = segment([0, 0, 0], [10, 0, 0]);
    const b = segment([20, 10, 0], [20, 20, 0]);
    const from = CurveEnds.ofEdge(a, "end");
    const to = CurveEnds.ofEdge(b, "start");
    const plainBridge = bridge(from, to, "g1");
    const fuller = bridge(from, to, "g1", 2);

    const reach = (e: Edge) => {
      const poles = curveOf(e).poles;
      return new Point(poles[0][0], poles[0][1], poles[0][2]).distanceTo(new Point(poles[1][0], poles[1][1], poles[1][2]));
    };
    const gap = new Point(10, 0, 0).distanceTo(new Point(20, 10, 0));
    expect(reach(plainBridge)).toBeCloseTo(gap / 3, 5);
    expect(reach(fuller)).toBeCloseTo(2 * reach(plainBridge), 5);
    // The end magnitude left at 1: the far inner pole does not move.
    expect(curveOf(fuller).poles[2]).toEqual(curveOf(plainBridge).poles[2]);
    expect(joint(a, fuller, 'G1')).toMatchObject({ g1: true, sameWay: true });
    expect(joint(fuller, b, 'G1')).toMatchObject({ g1: true, sameWay: true });
  });

  it("mixed: an edge end and a bare point at g1 is a quadratic matching the tangent at the edge end only", () => {
    const a = segment([0, 0, 0], [10, 0, 0]);
    const br = bridge(CurveEnds.ofEdge(a, "end"), { point: new Point(20, 10, 0) }, "g1");

    const curve = curveOf(br);
    expect(curve.degree).toBe(2);
    expect(curve.poles).toEqual([[10, 0, 0], [10 + Math.hypot(10, 10) / 2, 0, 0].map(round), [20, 10, 0]]);
    expect(joint(a, br, 'G1')).toMatchObject({ g1: true, sameWay: true });
  });

  it("mixed at g2: an arc end and a bare point is a cubic matching the arc's curvature at its end", () => {
    const a = arcEdge([0, 0, 0], 5, [0, -5, 0], [5, 0, 0]);
    const from = CurveEnds.ofEdge(a, "end");
    const br = bridge({ point: new Point(15, 10, 0) }, from, "g2");

    expect(curveOf(br).degree).toBe(3);
    expect(xyz(CurveEnds.ofEdge(br, "end").curvature!)).toEqual(xyz(from.curvature!));
  });

  it("two bare points are a straight edge at any continuity", () => {
    const br = bridge({ point: new Point(0, 0, 0) }, { point: new Point(0, 0, 10) }, "g2");
    expect(curveOf(br)).toEqual({ degree: 1, poles: [[0, 0, 0], [0, 0, 10]], line: true });
  });

  it("refuses two ends at the same point, before building", () => {
    const a = segment([0, 0, 0], [10, 0, 0]);
    const b = segment([10, 0, 0], [10, 10, 0]);
    expect(() => BridgeOps.make(CurveEnds.ofEdge(a, "end"), CurveEnds.ofEdge(b, "start"), {
      startContinuity: "g1", endContinuity: "g1", startMagnitude: 1, endMagnitude: 1,
    }))
      .toThrow(/^bridge: the two ends are at the same point\./);
  });
});
