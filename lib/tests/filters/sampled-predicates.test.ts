import { describe, it, expect } from "vitest";
import { setupOC, render } from "../setup.js";
import { sketch, line, spline, extrude, select } from "../../core/index.js";
import { edge, face } from "../../filters/index.js";
import { FilterBuilderBase } from "../../filters/filter-builder-base.js";
import { applyFilterStages } from "../../filters/filter-base.js";
import { SelectSceneObject } from "../../features/select.js";
import { Edge } from "../../common/edge.js";
import { Face } from "../../common/face.js";
import { Shape } from "../../common/shape.js";
import { Geometry } from "../../oc/geometry.js";
import { EdgeOps } from "../../oc/edge-ops.js";
import { EdgeQuery } from "../../oc/edge-query.js";
import { Convert } from "../../oc/convert.js";
import { CurveClassifier } from "../../oc/curve-classifier.js";
import { SurfaceClassifier } from "../../oc/surface-classifier.js";
import { Point } from "../../math/point.js";
import { Vector3d } from "../../math/vector3d.js";
import { Plane } from "../../math/plane.js";

function bezier(poles: number[][]): Edge {
  const curve = Geometry.makeBezierCurve(poles.map(([x, y, z]) => new Point(x, y, z)));
  const made = Geometry.makeEdgeFromBezier(curve);
  curve.delete();
  return made;
}

function segment(from: number[], to: number[]): Edge {
  return EdgeOps.makeLineEdge(new Point(from[0], from[1], from[2]), new Point(to[0], to[1], to[2]));
}

/** The arc from `start` through `through` to `end`. */
function arcThrough(start: number[], through: number[], end: number[]): Edge {
  const [s, t, e] = [start, through, end].map(([x, y, z]) => new Point(x, y, z));
  const curve = Geometry.makeArcThreePoints(s, e, t);
  const made = Geometry.makeEdgeFromCurve(curve);
  curve.delete();
  return made;
}

function matches<T extends Shape>(shape: T, builder: FilterBuilderBase<T>): boolean {
  return applyFilterStages([shape], builder.getFilters()).length === 1;
}

const XY = new Plane(new Point(0, 0, 0), new Vector3d(1, 0, 0), new Vector3d(0, 0, 1));

/** What `onPlane` answered before: the edge's first, middle and last parameters on the plane. */
function onPlaneAtThreeParameters(e: Edge, plane: Plane): boolean {
  const [pln, dispose] = Convert.toGpPln(plane);
  try {
    return EdgeQuery.isEdgeOnPlaneRaw(e.getShape(), pln);
  } finally {
    dispose();
  }
}

/** What `parallelTo` answered before: the tangent at the middle parameter is perpendicular to the normal. */
function parallelAtMidTangent(e: Edge, normal: Vector3d): boolean {
  const [vec, dispose] = Convert.toGpVec(normal);
  try {
    return EdgeQuery.isEdgeParallelToPlaneRaw(e.getShape(), vec);
  } finally {
    dispose();
  }
}

/** What `verticalTo` answered before: the chord from start to end runs along the normal. */
function verticalByChord(e: Edge, normal: Vector3d): boolean {
  const [vec, dispose] = Convert.toGpVec(normal);
  try {
    return EdgeQuery.isEdgeAlignedWithNormalRaw(e.getShape(), vec);
  } finally {
    dispose();
  }
}

function endHeights(e: Edge): number[] {
  return [EdgeOps.getFirstVertex(e), EdgeOps.getLastVertex(e)].map(v => EdgeOps.getVertexPoint(v).z);
}

/**
 * A slab drawn in the xz plane and pushed 10 along y: its floor is a spline
 * from (0, 1) down to z = -2 and back up to (10, 1), under a flat top at
 * z = 5. Every vertex sits at z = 1 or above; the floor dips below z = 0.
 */
function sagSlab() {
  sketch("xz", () => {
    spline([0, 1], [5, -3], [10, 1]);
    line([10, 1], [10, 5]);
    line([10, 5], [0, 5]);
    line([0, 5], [0, 1]);
  });
  return extrude(10);
}

describe("sampled predicates on curved edges", () => {
  setupOC();

  describe("onPlane", () => {
    it("rejects a spline that crosses the plane at its first, middle and last parameters only", () => {
      const wave = bezier([[0, 0, 0], [10 / 3, 0, 6], [20 / 3, 0, -6], [10, 0, 0]]);
      expect(CurveClassifier.classify(wave).kind).toBe("spline");
      expect(onPlaneAtThreeParameters(wave, XY)).toBe(true);
      expect(matches(wave, edge().onPlane("xy"))).toBe(false);
      expect(matches(wave, edge().notOnPlane("xy"))).toBe(true);
    });

    it("keeps a spline that lies in the plane", () => {
      const flat = bezier([[0, 0, 0], [5, 6, 0], [10, -4, 0], [15, 0, 0]]);
      expect(matches(flat, edge().onPlane("xy"))).toBe(true);
    });

    it("rejects a long spline that starts on the plane and drifts off it", () => {
      // A flat spline in a plane tilted 5e-7 rad from xy about the y axis:
      // it starts on xy, its normal is within the angular bound of xy's, and
      // 100 mm on it is 5e-5 mm below.
      const tilt = Math.tan(5e-7);
      const drifting = bezier([[0, 0, 0], [30, 20, -30 * tilt], [60, -20, -60 * tilt], [100, 0, -100 * tilt]]);
      const curve = CurveClassifier.classify(drifting);
      expect(curve).toMatchObject({ kind: "spline", planar: true });
      expect(EdgeQuery.isCurveParallelToPlane(curve, XY.normal)).toBe(true);
      expect(matches(drifting, edge().onPlane("xy"))).toBe(false);

      // The same curve a tenth of a millimetre long stays within tolerance of xy.
      const short = bezier([[0, 0, 0], [0.03, 0.02, -0.03 * tilt], [0.06, -0.02, -0.06 * tilt], [0.1, 0, -0.1 * tilt]]);
      expect(matches(short, edge().onPlane("xy"))).toBe(true);
    });

    it("keeps an ellipse lying in the plane, and rejects one tilted off it past its centre", () => {
      const lying = Geometry.makeEllipseEdge(new Point(0, 0, 0), 50, 20, new Vector3d(0, 0, 1), new Vector3d(1, 0, 0));
      expect(CurveClassifier.classify(lying).kind).toBe("ellipse");
      expect(matches(lying, edge().onPlane("xy"))).toBe(true);
      const tilted = Geometry.makeEllipseEdge(new Point(0, 0, 0), 50, 20, new Vector3d(Math.sin(5e-7), 0, Math.cos(5e-7)), new Vector3d(Math.cos(5e-7), 0, -Math.sin(5e-7)));
      expect(matches(tilted, edge().onPlane("xy"))).toBe(false);
    });

    it("judges lines and arcs as before", () => {
      const inPlane = [segment([0, 0, 0], [10, 5, 0]), arcThrough([0, 0, 0], [5, 5, 0], [10, 0, 0])];
      const offPlane = [segment([0, 0, 0], [0, 0, 10]), arcThrough([0, 0, 0], [5, 0, 5], [10, 0, 0])];
      for (const e of [...inPlane, ...offPlane]) {
        expect(matches(e, edge().onPlane("xy"))).toBe(onPlaneAtThreeParameters(e, XY));
      }
      expect(inPlane.map(e => matches(e, edge().onPlane("xy")))).toEqual([true, true]);
      expect(offPlane.map(e => matches(e, edge().onPlane("xy")))).toEqual([false, false]);
    });
  });

  describe("parallelTo", () => {
    it("rejects a hump whose middle tangent alone lies flat", () => {
      const hump = bezier([[0, 0, 0], [5, 0, 8], [10, 0, 0]]);
      expect(parallelAtMidTangent(hump, XY.normal)).toBe(true);
      expect(matches(hump, edge().parallelTo("xy"))).toBe(false);
      expect(matches(hump, edge().notParallelTo("xy"))).toBe(true);
    });

    it("keeps a spline that lies in a plane parallel to the reference", () => {
      const raised = bezier([[0, 0, 5], [5, 6, 5], [10, -4, 5], [15, 0, 5]]);
      expect(matches(raised, edge().parallelTo("xy"))).toBe(true);
      expect(matches(raised, edge().parallelTo("xz"))).toBe(false);
    });

    it("judges lines and arcs as before", () => {
      const cases = [
        segment([0, 0, 3], [10, 5, 3]),
        segment([0, 0, 0], [0, 0, 10]),
        arcThrough([0, 0, 2], [5, 5, 2], [10, 0, 2]),
      ];
      expect(cases.map(e => parallelAtMidTangent(e, XY.normal))).toEqual([true, false, true]);
      expect(cases.map(e => matches(e, edge().parallelTo("xy")))).toEqual([true, false, true]);
    });
  });

  describe("verticalTo", () => {
    it("rejects a curve whose chord alone runs along the normal", () => {
      const bulge = bezier([[0, 0, 0], [6, 0, 3], [6, 0, 7], [0, 0, 10]]);
      expect(verticalByChord(bulge, XY.normal)).toBe(true);
      expect(matches(bulge, edge().verticalTo("xy"))).toBe(false);
      expect(matches(bulge, edge().notVerticalTo("xy"))).toBe(true);
    });

    it("judges lines and arcs as before", () => {
      const cases = [
        segment([1, 1, 0], [1, 1, 10]),
        segment([0, 0, 0], [10, 0, 0]),
        arcThrough([0, 0, 0], [5, 5, 0], [10, 0, 0]),
      ];
      expect(cases.map(e => verticalByChord(e, XY.normal))).toEqual([true, false, false]);
      expect(cases.map(e => matches(e, edge().verticalTo("xy")))).toEqual([true, false, false]);
    });
  });

  describe("above / below on edges", () => {
    it("judges a spline by how far it reaches, not by its end vertices", () => {
      const dip = bezier([[0, 0, 1], [4, 0, -5], [8, 0, 1]]);
      expect(endHeights(dip)).toEqual([1, 1]);
      expect(matches(dip, edge().above("xy"))).toBe(false);
      expect(matches(dip, edge().above("xy", { partial: true }))).toBe(true);
      expect(matches(dip, edge().below("xy"))).toBe(false);
      expect(matches(dip, edge().below("xy", { partial: true }))).toBe(true);
      // The dip bottoms out at z = -2.
      expect(matches(dip, edge().above("xy", -1.9))).toBe(false);
      expect(matches(dip, edge().above("xy", -2.1))).toBe(true);
    });

    it("treats a spline lying in the plane as on neither side", () => {
      const flat = bezier([[0, 0, 0], [5, 6, 0], [10, -4, 0], [15, 0, 0]]);
      expect(matches(flat, edge().above("xy", { partial: true }))).toBe(false);
      expect(matches(flat, edge().below("xy", { partial: true }))).toBe(false);
    });

    it("judges lines and arcs by their end vertices, as before", () => {
      const raisedLine = segment([0, 0, 1], [10, 0, 1]);
      const raisedArc = arcThrough([0, 0, 1], [4, 0, 3], [8, 0, 1]);
      const crossingLine = segment([0, 0, -1], [10, 0, 1]);
      expect(matches(raisedLine, edge().above("xy"))).toBe(true);
      expect(matches(raisedArc, edge().above("xy"))).toBe(true);
      expect(matches(crossingLine, edge().above("xy"))).toBe(false);
      expect(matches(crossingLine, edge().above("xy", { partial: true }))).toBe(true);
      expect(matches(crossingLine, edge().below("xy", { partial: true }))).toBe(true);
    });

    it("leaves out a solid's sagging spline edges", () => {
      sagSlab();
      const above = select(edge().above("xy")) as SelectSceneObject;
      const splinesBelow = select(edge().spline().below("xy", { partial: true })) as SelectSceneObject;
      render();
      const kinds = (above.getShapes() as Edge[]).map(e => CurveClassifier.classify(e).kind);
      // Every line of the slab, none of its two spline edges.
      expect(kinds).toHaveLength(10);
      expect(kinds.every(k => k === "line")).toBe(true);
      expect(splinesBelow.getShapes()).toHaveLength(2);
    });
  });

  describe("above / below on faces", () => {
    it("judges a free-form face by how far it reaches, and a flat face bounded by a spline too", () => {
      sagSlab();
      const above = select(face().above("xy")) as SelectSceneObject;
      const partlyBelow = select(face().below("xy", { partial: true })) as SelectSceneObject;
      const all = select(face()) as SelectSceneObject;
      render();
      for (const f of all.getShapes() as Face[]) {
        for (const e of f.getEdges()) {
          expect(Math.min(...endHeights(e))).toBeGreaterThanOrEqual(1 - 1e-9);
        }
      }
      // The floor and the two ends it bounds dip below z = 0; the top and the two side walls do not.
      const aboveFaces = above.getShapes() as Face[];
      expect(aboveFaces).toHaveLength(3);
      expect(aboveFaces.every(f => SurfaceClassifier.classify(f).kind === "plane")).toBe(true);
      expect(aboveFaces.every(f => f.getEdges().every(e => CurveClassifier.classify(e).kind === "line"))).toBe(true);
      const belowKinds = (partlyBelow.getShapes() as Face[]).map(f => SurfaceClassifier.classify(f).kind).sort();
      expect(belowKinds).toEqual(["extruded", "plane", "plane"]);
    });

    it("judges a box's faces by their boundary vertices, as before", () => {
      sketch("xy", () => {
        line([0, 0], [10, 0]);
        line([10, 0], [10, 10]);
        line([10, 10], [0, 10]);
        line([0, 10], [0, 0]);
      });
      extrude(10);
      const above = select(face().above("xy", 5)) as SelectSceneObject;
      const partly = select(face().above("xy", { offset: 5, partial: true })) as SelectSceneObject;
      render();
      expect(above.getShapes()).toHaveLength(1);
      expect(partly.getShapes()).toHaveLength(5);
    });
  });
});
