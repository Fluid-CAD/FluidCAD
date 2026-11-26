import { describe, expect, it } from "vitest";
import type { Geom_Curve, TopoDS_Edge } from "ocjs-fluidcad";
import { setupOC, render } from "../setup.js";
import { getOC } from "../../oc/init.js";
import { CurveClassifier } from "../../oc/curve-classifier.js";
import { Geometry } from "../../oc/geometry.js";
import { Edge } from "../../common/edge.js";
import { Point } from "../../math/point.js";
import helix from "../../core/helix.js";
import { Helix } from "../../features/helix.js";

type Bound = { delete(): void };

/** Runs `fn` with an `own` that records every object it is handed, and frees them all, last first. */
function withOwned<T>(fn: (own: <B extends Bound>(object: B) => B) => T): T {
  const owned: Bound[] = [];
  const own = <B extends Bound>(object: B): B => {
    owned.push(object);
    return object;
  };
  try {
    return fn(own);
  } finally {
    for (const object of owned.reverse()) {
      object.delete();
    }
  }
}

type Own = <B extends Bound>(object: B) => B;

function lineEdge(own: Own, from: number[], to: number[]): TopoDS_Edge {
  const oc = getOC();
  const maker = own(new oc.BRepBuilderAPI_MakeEdge(
    own(new oc.gp_Pnt(from[0], from[1], from[2])),
    own(new oc.gp_Pnt(to[0], to[1], to[2])),
  ));
  return own(maker.Edge());
}

/** An edge on a circle of radius 5 around z, from `a` to `b` radians. */
function circleEdge(own: Own, a: number, b: number): TopoDS_Edge {
  const oc = getOC();
  const circle = own(new oc.gp_Circ(own(new oc.gp_Ax2()), 5));
  return own(own(new oc.BRepBuilderAPI_MakeEdge(circle, a, b)).Edge());
}

/** An edge on an ellipse of radii 7 and 3 around z, from `a` to `b` radians. */
function ellipseEdge(own: Own, a: number, b: number): TopoDS_Edge {
  const oc = getOC();
  const ellipse = own(new oc.gp_Elips(own(new oc.gp_Ax2()), 7, 3));
  return own(own(new oc.BRepBuilderAPI_MakeEdge(ellipse, a, b)).Edge());
}

/** The same edge with its curve converted to a B-spline. */
function asBSpline(own: Own, edge: TopoDS_Edge): TopoDS_Edge {
  const oc = getOC();
  const curve = oc.BRep_Tool.Curve(edge, 0, 1);
  const trimmed = own(new oc.Geom_TrimmedCurve(curve.returnValue, curve.First, curve.Last, true, true));
  curve[Symbol.dispose]();
  const bspline = own(oc.GeomConvert.CurveToBSplineCurve(trimmed)) as unknown as Geom_Curve;
  return own(own(new oc.BRepBuilderAPI_MakeEdge(bspline)).Edge());
}

function isBSpline(edge: TopoDS_Edge): boolean {
  const oc = getOC();
  const adaptor = new oc.BRepAdaptor_Curve(edge);
  const type = adaptor.GetType();
  adaptor.delete();
  return type === oc.GeomAbs_CurveType.GeomAbs_BSplineCurve;
}

function bezier(poles: number[][]): Edge {
  const curve = Geometry.makeBezierCurve(poles.map(([x, y, z]) => new Point(x, y, z)));
  const edge = Geometry.makeEdgeFromBezier(curve);
  curve.delete();
  return edge;
}

describe("CurveClassifier", () => {
  setupOC();

  describe("native curves", () => {
    it("reads a line, its direction and length", () => {
      withOwned(own => {
        const curve = CurveClassifier.classifyRaw(lineEdge(own, [0, 0, 0], [3, 4, 0]));
        expect(curve.kind).toBe("line");
        expect(curve.recovered).toBe(false);
        expect(curve.closed).toBe(false);
        expect(curve.planar).toBe(true);
        expect(curve.length).toBeCloseTo(5, 9);
        expect(curve.direction?.x).toBeCloseTo(0.6, 9);
        expect(curve.direction?.y).toBeCloseTo(0.8, 9);
      });
    });

    it("splits a circle into a full circle and an arc", () => {
      withOwned(own => {
        const arc = CurveClassifier.classifyRaw(circleEdge(own, 0, Math.PI));
        expect(arc).toMatchObject({ kind: "arc", recovered: false, closed: false, planar: true });
        expect(arc.radius).toBeCloseTo(5, 9);
        expect(arc.length).toBeCloseTo(5 * Math.PI, 9);

        const full = CurveClassifier.classifyRaw(circleEdge(own, 0, 2 * Math.PI));
        expect(full).toMatchObject({ kind: "circle", recovered: false, closed: true, planar: true });
        expect(full.radius).toBeCloseTo(5, 9);
        expect(full.axisDirection?.z).toBeCloseTo(1, 9);
      });
    });

    it("reads an ellipse and its radii, open or closed", () => {
      withOwned(own => {
        const open = CurveClassifier.classifyRaw(ellipseEdge(own, 0, 2));
        expect(open).toMatchObject({ kind: "ellipse", recovered: false, closed: false, planar: true });
        expect(open.majorRadius).toBeCloseTo(7, 9);
        expect(open.minorRadius).toBeCloseTo(3, 9);

        const closed = CurveClassifier.classifyRaw(ellipseEdge(own, 0, 2 * Math.PI));
        expect(closed).toMatchObject({ kind: "ellipse", closed: true, planar: true });
      });
    });
  });

  describe("B-spline curves", () => {
    it("recovers a line", () => {
      withOwned(own => {
        const edge = asBSpline(own, lineEdge(own, [0, 0, 0], [10, 0, 5]));
        expect(isBSpline(edge)).toBe(true);
        const curve = CurveClassifier.classifyRaw(edge);
        expect(curve).toMatchObject({ kind: "line", recovered: true, closed: false, planar: true });
        expect(curve.length).toBeCloseTo(Math.hypot(10, 5), 6);
      });
    });

    it("recovers an arc and a full circle with their radius and centre", () => {
      withOwned(own => {
        const arcEdge = asBSpline(own, circleEdge(own, 0, Math.PI));
        expect(isBSpline(arcEdge)).toBe(true);
        const arc = CurveClassifier.classifyRaw(arcEdge);
        expect(arc).toMatchObject({ kind: "arc", recovered: true, closed: false, planar: true });
        expect(arc.radius).toBeCloseTo(5, 6);
        expect(arc.center?.distanceTo(new Point(0, 0, 0))).toBeLessThan(1e-6);

        const full = CurveClassifier.classifyRaw(asBSpline(own, circleEdge(own, 0, 2 * Math.PI)));
        expect(full).toMatchObject({ kind: "circle", recovered: true, closed: true, planar: true });
        expect(full.radius).toBeCloseTo(5, 6);
      });
    });

    it("recovers an ellipse, open or closed", () => {
      withOwned(own => {
        const open = CurveClassifier.classifyRaw(asBSpline(own, ellipseEdge(own, 0, 2)));
        expect(open).toMatchObject({ kind: "ellipse", recovered: true, closed: false, planar: true });
        expect(open.majorRadius).toBeCloseTo(7, 6);
        expect(open.minorRadius).toBeCloseTo(3, 6);

        const closed = CurveClassifier.classifyRaw(asBSpline(own, ellipseEdge(own, 0, 2 * Math.PI)));
        expect(closed).toMatchObject({ kind: "ellipse", recovered: true, closed: true, planar: true });
      });
    });

    it("calls a free-form curve a spline and tells whether it lies in a plane", () => {
      const flat = bezier([[0, 0, 0], [5, 8, 0], [10, -6, 0], [15, 2, 0]]);
      expect(CurveClassifier.classify(flat)).toMatchObject({ kind: "spline", recovered: false, closed: false, planar: true });

      const tilted = bezier([[0, 0, 0], [5, 8, 5], [10, -6, 10], [15, 2, 15]]);
      expect(CurveClassifier.classify(tilted)).toMatchObject({ kind: "spline", planar: true });

      const twisted = bezier([[0, 0, 0], [5, 8, 3], [10, -6, -4], [15, 2, 6]]);
      expect(CurveClassifier.classify(twisted)).toMatchObject({ kind: "spline", planar: false });
    });

    it("tells a closed spline from an open one", () => {
      const oc = getOC();
      withOwned(own => {
        const poles = [[0, 0, 0], [10, 10, 0], [-10, 10, 0], [0, 0, 0]].map(([x, y, z]) => new Point(x, y, z));
        const loop = own(Geometry.makeBezierCurve(poles));
        const edge = own(own(new oc.BRepBuilderAPI_MakeEdge(loop)).Edge());
        const curve = CurveClassifier.classifyRaw(edge);
        expect(curve).toMatchObject({ kind: "spline", closed: true, planar: true });
        expect(curve.length).toBeGreaterThan(0);
      });
    });
  });

  it("does not call a helix planar", () => {
    const h = helix("z").pitch(5).turns(4) as Helix;
    render();
    const edge = h.getShapes()[0] as Edge;
    const curve = CurveClassifier.classify(edge);
    expect(curve.kind).toBe("spline");
    expect(curve.planar).toBe(false);
    expect(curve.closed).toBe(false);
  });

  it("keeps a wrapper's class", () => {
    const edge = bezier([[0, 0, 0], [5, 8, 0], [10, -6, 0], [15, 2, 0]]);
    expect(CurveClassifier.classify(edge)).toBe(CurveClassifier.classify(edge));
  });
});
