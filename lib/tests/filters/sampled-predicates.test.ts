import { describe, it, expect, vi } from "vitest";
import type { Geom_Surface } from "ocjs-fluidcad";
import { setupOC, render } from "../setup.js";
import { getOC } from "../../oc/init.js";
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
import { ShapeOps } from "../../oc/shape-ops.js";
import { withUnit } from "../../units/registry.js";
import type { Scene } from "../../rendering/scene.js";
import { extentDistances } from "../../filters/extent.js";
import { edgeSideDistances } from "../../filters/edge/above-below.js";
import { faceSideDistances, faceSideDistancesPastSpan } from "../../filters/face/above-below.js";
import { FreeformBodies } from "../helpers/freeform-bodies.js";
import { findSolids } from "../selection/pick-helpers.js";

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

/** The scene's faces whose side of a plane is read off their extent, with the surface kind of each. */
function freeformFaces(scene: Scene): Face[] {
  return findSolids(scene)
    .flatMap(solid => solid.getSubShapes("face"))
    .filter(f => !SurfaceClassifier.isAnalytic(SurfaceClassifier.classify(f).kind));
}

/** Whether `above` and `below` keep the shape, entirely and partly, in that order. */
function sideAnswers<T extends Shape>(shape: T, of: () => { above: FilterBuilderBase<T>; partlyAbove: FilterBuilderBase<T>; below: FilterBuilderBase<T>; partlyBelow: FilterBuilderBase<T> }): boolean[] {
  const builders = of();
  return [builders.above, builders.partlyAbove, builders.below, builders.partlyBelow].map(b => matches(shape, b));
}

/** The same four answers, worked out from two distances. */
function sidesOf([near, far]: number[]): boolean[] {
  return [near > 0 && far > 0, near > 0 || far > 0, near < 0 && far < 0, near < 0 || far < 0];
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

    it("reads a line's end points once per edge", () => {
      const rising = segment([0, 0, 1], [10, 0, 3]);
      const ends = vi.spyOn(EdgeOps, "endPointsRaw");
      try {
        expect(edgeSideDistances(rising, XY)).toEqual([1, 3]);
        expect(edgeSideDistances(rising, XY.offset(2))).toEqual([-1, 1]);
        expect(matches(rising, edge().above("xy", 0.5))).toBe(true);
        expect(ends).toHaveBeenCalledTimes(1);
      } finally {
        ends.mockRestore();
      }
      expect(EdgeOps.endPoints(rising).map(p => [p.x, p.y, p.z])).toEqual([[0, 0, 1], [10, 0, 3]]);
    });

    it.each(["in", "m"] as const)("treats a spline lying in the plane as on neither side in a document in %s", unit => {
      // The kernel pads a free-form bound by 1e-7 of the document's unit,
      // which a snap of a thousandth of a micron would not cover here.
      withUnit(unit, () => {
        const flat = bezier([[0, 0, 0], [5, 6, 0], [10, -4, 0], [15, 0, 0]]);
        expect(extentDistances(flat, XY)).toEqual([0, 0]);
        expect(matches(flat, edge().above("xy", { partial: true }))).toBe(false);
        expect(matches(flat, edge().below("xy", { partial: true }))).toBe(false);

        // A hump that rises to the plane from 1 below and touches it.
        const touching = bezier([[0, 0, -1], [4, 0, 1], [8, 0, -1]]);
        expect(matches(touching, edge().above("xy", { partial: true }))).toBe(false);
        expect(matches(touching, edge().below("xy", { partial: true }))).toBe(true);
        expect(matches(touching, edge().below("xy"))).toBe(false);
      });
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

    it("answers for a free-form face as its measured extent does, wherever the plane lies", () => {
      FreeformBodies.filletedSlab();
      FreeformBodies.ellipseLoft(200);
      FreeformBodies.revolvedSpline();
      const faces = freeformFaces(render());
      // Six fillets and a loft wall on B-spline surfaces, three extruded walls, a revolved one.
      expect(faces.map(f => SurfaceClassifier.classify(f).kind).sort()).toEqual([
        "extruded", "extruded", "extruded",
        "freeform", "freeform", "freeform", "freeform", "freeform", "freeform", "freeform",
        "revolved",
      ]);
      const tilted = new Plane(new Point(3, -2, 5), new Vector3d(2, 1, 0).normalize(), new Vector3d(1, -2, 3).normalize());
      for (const f of faces) {
        for (const base of [XY, new Plane(new Point(0, 0, 0), new Vector3d(1, 0, 0), new Vector3d(0, -1, 0)), tilted]) {
          const { min, max } = ShapeOps.extentAlongRaw(f.getShape(), base);
          // Clear of the face on either side, touching each end of it, and through it.
          for (const offset of [min - 25, min - 1e-3, min, (min + max) / 2, max, max + 1e-3, max + 25]) {
            const plane = base.offset(offset);
            const answers = sideAnswers(f, () => ({
              above: face().above(plane),
              partlyAbove: face().above(plane, { partial: true }),
              below: face().below(plane),
              partlyBelow: face().below(plane, { partial: true }),
            }));
            expect(answers).toEqual(sidesOf(extentDistances(f, plane)));
          }
        }
      }
    });

    it("does not measure a face on a B-spline surface that lies clear of the plane", () => {
      FreeformBodies.filletedSlab();
      const fillets = freeformFaces(render()).filter(f => SurfaceClassifier.classify(f).kind === "freeform");
      expect(fillets).toHaveLength(6);
      const box = vi.spyOn(ShapeOps, "getExactBoundingBoxRaw");
      const framed = vi.spyOn(ShapeOps, "extentAlongRaw");
      try {
        // The slab stands between z = 0 and z = 10, within 50 of the origin.
        expect(fillets.every(f => matches(f, face().above("xy", -5)))).toBe(true);
        expect(fillets.some(f => matches(f, face().above("xy", { offset: 15, partial: true })))).toBe(false);
        expect(fillets.every(f => matches(f, face().below("yz", 80)))).toBe(true);
        expect(fillets.every(f => matches(f, face().above(new Plane(new Point(0, 0, -40), new Vector3d(1, 0, 0), new Vector3d(0, -1, 1).normalize()))))).toBe(true);
        expect(box).not.toHaveBeenCalled();
        expect(framed).not.toHaveBeenCalled();

        // A plane through the top fillets measures those three alone.
        expect(fillets.filter(f => matches(f, face().above("xy", 9))).length).toBe(0);
        expect(fillets.filter(f => matches(f, face().above("xy", { offset: 9, partial: true }))).length).toBe(3);
        expect(box).toHaveBeenCalledTimes(3);
      } finally {
        box.mockRestore();
        framed.mockRestore();
      }
    });

    it("stands in for a face clear of a span with bounds no farther from it, and measures one that crosses its end", () => {
      FreeformBodies.filletedSlab();
      const fillets = freeformFaces(render()).filter(f => SurfaceClassifier.classify(f).kind === "freeform");
      const top = fillets.filter(f => extentDistances(f, XY)[0] > 5);
      const bottom = fillets.filter(f => extentDistances(f, XY)[1] < 5);
      expect([top.length, bottom.length]).toEqual([3, 3]);
      const [lowest, highest] = extentDistances(top[0], XY);
      expect([lowest, highest].map(v => Math.round(v * 1e4) / 1e4)).toEqual([8.5, 10]);

      const box = vi.spyOn(ShapeOps, "getExactBoundingBoxRaw");
      try {
        // Past a span above them, the bottom fillets answer without being measured ...
        const standIns = bottom.map(f => faceSideDistancesPastSpan(f, XY, 8, 12));
        // ... and so do the top ones, which lie within it.
        const within = top.map(f => faceSideDistancesPastSpan(f, XY, 8, 12));
        expect(box).not.toHaveBeenCalled();
        expect(within.every(([near, far]) => near >= 8 && far <= 12)).toBe(true);
        bottom.forEach((f, i) => {
          const [near, far] = faceSideDistances(f, XY);
          expect(standIns[i][1]).toBeLessThan(8);
          expect(standIns[i][0]).toBeLessThanOrEqual(near);
          expect(standIns[i][1]).toBeGreaterThanOrEqual(far);
        });

        // A span that ends inside the top fillets measures them.
        box.mockClear();
        expect(top.map(f => faceSideDistancesPastSpan(f, XY, 9, 12))).toEqual(top.map(f => faceSideDistances(f, XY)));
      } finally {
        box.mockRestore();
      }
    });

    it.each(["in", "m"] as const)("treats a flat B-spline face lying in the plane as on neither side in a document in %s", unit => {
      withUnit(unit, () => {
        const oc = getOC();
        const poles = new oc.NCollection_Array2_gp_Pnt(1, 3, 1, 3);
        const owned: { delete(): void }[] = [poles];
        // A patch in the xy plane with one side bowed outwards: flat, and no plane to the kernel.
        for (let i = 0; i < 3; i++) {
          for (let j = 0; j < 3; j++) {
            const pole = new oc.gp_Pnt(i * 5, j * 5 - (i === 1 && j === 0 ? 4 : 0), 0);
            owned.push(pole);
            poles.SetValue(i + 1, j + 1, pole);
          }
        }
        const surface = new oc.Geom_BezierSurface(poles) as unknown as Geom_Surface;
        const maker = new oc.BRepBuilderAPI_MakeFace(surface, 1e-6);
        const raw = maker.Face();
        owned.push(surface, maker, raw);
        try {
          const flat = Face.fromTopoDSFace(raw);
          // Its bounding edges are curved Beziers, so it is judged by its extent.
          expect(flat.getEdges().some(e => CurveClassifier.classify(e).kind === "spline")).toBe(true);
          expect(extentDistances(flat, XY)).toEqual([0, 0]);
          expect(matches(flat, face().above("xy", { partial: true }))).toBe(false);
          expect(matches(flat, face().below("xy", { partial: true }))).toBe(false);
        } finally {
          for (const object of owned.reverse()) {
            object.delete();
          }
        }
      });
    });

    it("judges a face by its vertices or by its extent as its class stands in the document's unit", () => {
      const oc = getOC();
      // A sheet 2 wide with a shallow S across x, 2.3e-4 either side of
      // z = 0, its four corners on z = 0. Within a thousandth of a
      // millimetre it is a plane bounded by lines; in metres it is neither.
      const poles = new oc.NCollection_Array2_gp_Pnt(1, 4, 1, 2);
      const owned: { delete(): void }[] = [poles];
      [[-1, 0], [-1 / 3, 8e-4], [1 / 3, -8e-4], [1, 0]].forEach(([x, z], i) => {
        for (const [j, y] of [[1, -1], [2, 1]]) {
          const pole = new oc.gp_Pnt(x, y, z);
          owned.push(pole);
          poles.SetValue(i + 1, j, pole);
        }
      });
      const surface = new oc.Geom_BezierSurface(poles) as unknown as Geom_Surface;
      const maker = new oc.BRepBuilderAPI_MakeFace(surface, 1e-6);
      const raw = maker.Face();
      owned.push(surface, maker, raw);
      try {
        const sheet = Face.fromTopoDSFace(raw);
        const partlyAbove = () => matches(sheet, face().above("xy", { partial: true }));
        expect(SurfaceClassifier.classify(sheet).kind).toBe("plane");
        expect(sheet.getEdges().map(e => CurveClassifier.classify(e).kind)).toEqual(["line", "line", "line", "line"]);
        expect(partlyAbove()).toBe(false);
        withUnit("m", () => {
          expect(SurfaceClassifier.classify(sheet).kind).toBe("freeform");
          expect(partlyAbove()).toBe(true);
        });
        expect(partlyAbove()).toBe(false);
      } finally {
        for (const object of owned.reverse()) {
          object.delete();
        }
      }
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
