import { describe, it, expect } from "vitest";
import type { TopoDS_Edge, TopoDS_Face, TopoDS_Shape } from "ocjs-fluidcad";
import { setupOC, render, addToScene, expectDisplayConsumed } from "../setup.js";
import sketch from "../../core/sketch.js";
import extrude from "../../core/extrude.js";
import cylinder from "../../core/cylinder.js";
import sphere from "../../core/sphere.js";
import select from "../../core/select.js";
import fillet from "../../core/fillet.js";
import repeat from "../../core/repeat.js";
import plane from "../../core/plane.js";
import { arc, circle, line, offset, project, spline } from "../../core/2d/index.js";
import { edge, face } from "../../filters/index.js";
import { partOffsetCurveArgs, partOffsetOptions } from "../../core/2d/offset.js";
import { getOC } from "../../oc/init.js";
import { Convert } from "../../oc/convert.js";
import { SheetOps } from "../../oc/sheet-ops.js";
import { CurveClassifier } from "../../oc/curve-classifier.js";
import { EdgeOps } from "../../oc/edge-ops.js";
import { Explorer } from "../../oc/explorer.js";
import { ShapeMeasure } from "../../oc/shape-measure.js";
import { DEFAULT_MESH_CONFIG } from "../../oc/mesh.js";
import { SceneObject } from "../../common/scene-object.js";
import { Edge } from "../../common/edge.js";
import { Wire } from "../../common/wire.js";
import { Sheet } from "../../common/sheet.js";
import { Plane } from "../../math/plane.js";
import { Point } from "../../math/point.js";
import { Vector3d } from "../../math/vector3d.js";
import { CurveOperand } from "../../helpers/curve-operand.js";
import { OffsetCurve } from "../../features/offset-curve.js";
import { Offset } from "../../features/2d/offset.js";
import { Extrude } from "../../features/extrude.js";
import { Fillet } from "../../features/fillet.js";
import { Sketch } from "../../features/2d/sketch.js";
import { SelectSceneObject } from "../../features/select.js";
import { RepeatBase } from "../../features/repeat-base.js";
import { PointResolver } from "../../features/point-resolver.js";
import { LazyVertex } from "../../features/lazy-vertex.js";
import { buildFeatureGhost, type GhostOperandRef } from "../../rendering/feature-ghost.js";
import type { Scene } from "../../rendering/scene.js";
import { synthesizeApplyFeature } from "../../selection/explain.js";
import { resolveFeatureSources } from "../../selection/feature-sources.js";
import { DefaultNames } from "../../rendering/default-names.js";
import { getCurrentScene, getSceneManager } from "../../scene-manager.js";
import { testRect } from "../helpers/profiles.js";
import { useLoadedBodies, loadShapes } from "../helpers/loaded-bodies.js";
import { expectOptionsCarried } from "../helpers/option-contract.js";

const FILE = "/tmp/offset-curve-test.fluid.js";

const asObject = (value: unknown) => value as SceneObject;
const round = (value: number) => +value.toFixed(4) + 0;
const xyz = (point: Point) => [point.x, point.y, point.z].map(round);
const mid = (e: Edge) => xyz(EdgeOps.getEdgeMidPoint(e));
const at = (vertex: LazyVertex) => xyz(PointResolver.toWorld(vertex));

/** The curve's wires, as the scene holds them. */
const wiresOf = (oc: unknown) => asObject(oc).getShapes() as Wire[];
/** Every edge of the result, in the order `edges()` lists them. */
const bucketOf = (oc: unknown) => asObject(oc).getState(OffsetCurve.EDGES_KEY) as Edge[];
const ends = (wire: Wire) => [xyz(wire.getFirstPoint()!), xyz(wire.getLastPoint()!)];
const closed = (wire: Wire) => wire.isClosed();
const kinds = (oc: unknown) => bucketOf(oc).map(e => CurveClassifier.classify(e).kind);

/** A planar sheet on `plane`, over [u0, u1] × [v0, v1] of its own axes, loaded the way an imported surface is. */
function sheetOn(on: Plane, u: [number, number], v: [number, number]): SceneObject {
  const oc = getOC();
  const [pln, disposePln] = Convert.toGpPln(on);
  const maker = new oc.BRepBuilderAPI_MakeFace(pln, u[0], u[1], v[0], v[1]);
  const raw = maker.Face();
  let sheet: Sheet;
  try {
    sheet = SheetOps.fromRawFace(raw);
  } finally {
    raw.delete();
    maker.delete();
    disposePln();
  }
  return asObject(loadShapes([sheet]));
}

/** A `width` × `depth` × 5 block on XY from the origin. */
function block(width = 40, depth = 10): Extrude {
  sketch("xy", () => {
    testRect(width, depth);
  });
  return extrude(5).new() as unknown as Extrude;
}

/** A sketch on XY lifted to `height`, drawing what `draw` draws. */
function above(height: number, draw: () => void): Sketch {
  return sketch(plane("xy", height), draw) as unknown as Sketch;
}

function located<T>(value: T, line: number): T {
  asObject(value).setSourceLocation({ filePath: FILE, line, column: 0 });
  return value;
}

/** The faces of the scene object's bodies, as raw faces the caller frees with {@link free}. */
function facesOf(obj: unknown): TopoDS_Face[] {
  const oc = getOC();
  return asObject(obj).getShapes().flatMap(shape =>
    Explorer.findShapes<TopoDS_Face>(shape.getShape(), oc.TopAbs_ShapeEnum.TopAbs_FACE as never)
      .map(raw => {
        const typed = oc.TopoDS.Face(raw);
        raw.delete();
        return typed;
      }));
}

function free(shapes: TopoDS_Shape[]): void {
  shapes.forEach(shape => shape.delete());
}

/** Points along an edge, `count` + 1 of them from end to end. */
function pointsAlong(e: Edge, count = 8): Point[] {
  const oc = getOC();
  const adaptor = new oc.BRepAdaptor_Curve(e.getShape() as TopoDS_Edge);
  try {
    const first = adaptor.FirstParameter();
    const last = adaptor.LastParameter();
    return Array.from({ length: count + 1 }, (_, i) => {
      const value = adaptor.Value(first + (last - first) * i / count);
      const point = new Point(value.X(), value.Y(), value.Z());
      value.delete();
      return point;
    });
  } finally {
    adaptor.delete();
  }
}

/** The distance from a point to a raw shape. */
const distance = (point: Point, shape: TopoDS_Shape) => EdgeOps.distancePointToShapeRaw(point, shape);

/**
 * Whether the edge carries its curve on one of `faces`: a curve in the
 * face's parameter space whose points are the edge's own, within the edge's
 * tolerance.
 */
function hasCurveOn(e: Edge, faces: TopoDS_Face[]): boolean {
  const oc = getOC();
  const raw = e.getShape() as TopoDS_Edge;
  const tolerance = Math.max(oc.BRep_Tool.Tolerance(raw), 1e-6);
  const own = pointsAlong(e, 4);
  return faces.some(f => {
    let adaptor;
    try {
      adaptor = new oc.BRepAdaptor_Curve(raw, f);
    } catch {
      return false;
    }
    try {
      if (!adaptor.IsCurveOnSurface()) {
        return false;
      }
      const first = adaptor.FirstParameter();
      const last = adaptor.LastParameter();
      return own.every((point, i) => {
        const value = adaptor.Value(first + (last - first) * i / 4);
        const gap = point.distanceTo(new Point(value.X(), value.Y(), value.Z()));
        value.delete();
        return gap <= tolerance;
      });
    } finally {
      adaptor.delete();
    }
  });
}

/**
 * Every result edge lies on `faces` — its points within `tolerance` — and
 * carries its curve on one of them, and every point of it is `gap` from the
 * source shape, within `tolerance`.
 */
function expectBeside(oc: unknown, faces: TopoDS_Face[], source: TopoDS_Shape, gap: number, tolerance = 1e-5): void {
  const raw = getOC();
  const builder = new raw.BRep_Builder();
  const compound = new raw.TopoDS_Compound();
  builder.MakeCompound(compound);
  faces.forEach(f => builder.Add(compound, f));
  builder.delete();
  try {
    expect(bucketOf(oc).length).toBeGreaterThan(0);
    for (const e of bucketOf(oc)) {
      expect(hasCurveOn(e, faces), `the edge at ${mid(e)} carries its curve on a face it lies on`).toBe(true);
      for (const point of pointsAlong(e)) {
        expect(distance(point, compound)).toBeLessThan(tolerance);
        expect(Math.abs(distance(point, source) - gap)).toBeLessThan(tolerance);
      }
    }
  } finally {
    compound.delete();
  }
}

/** The source shape of a scene object holding one curve: its first shape, raw. */
const sourceOf = (obj: unknown) => asObject(obj).getShapes()[0].getShape();

describe("offset(distance, edges, { on }) outside a sketch", () => {
  setupOC();
  useLoadedBodies();

  describe("on a plane", () => {
    it("sets a straight edge beside itself: a parallel line at the distance, classified as a line", () => {
      const box = block(40, 20);
      const sk = above(5, () => {
        line([5, 10], [35, 10]);
      });
      const oc = offset(3, sk, { on: box.endFaces() }) as unknown as OffsetCurve;
      render();

      expect(oc.getError()).toBeNull();
      const wires = wiresOf(oc);
      expect(wires).toHaveLength(1);
      expect(ends(wires[0])).toEqual([[5, 13, 5], [35, 13, 5]]);
      expect(kinds(oc)).toEqual(["line"]);
    });

    it("goes left of the edge for a positive distance and right for a negative one, seen from the outside of the faces", () => {
      const floor = sheetOn(Plane.XY(), [0, 40], [0, 40]);
      const east = sketch("xy", () => {
        line([5, 20], [35, 20]);
      });
      const west = sketch("xy", () => {
        line([35, 20], [5, 20]);
      });
      const left = offset(4, east, { on: floor }) as unknown as OffsetCurve;
      const right = offset(-4, east, { on: floor }) as unknown as OffsetCurve;
      const turned = offset(4, west, { on: floor }) as unknown as OffsetCurve;
      render();

      // Walking +X with the face's outside (+Z) up, the left is +Y.
      expect(ends(wiresOf(left)[0])).toEqual([[5, 24, 0], [35, 24, 0]]);
      expect(ends(wiresOf(right)[0])).toEqual([[5, 16, 0], [35, 16, 0]]);
      // Walking -X, the left is -Y.
      expect(ends(wiresOf(turned)[0])).toEqual([[35, 16, 0], [5, 16, 0]]);
    });

    it("sets an arc beside itself as a concentric arc, smaller on its inside, larger outside", () => {
      const floor = sheetOn(Plane.XY(), [-40, 40], [-40, 40]);
      const bow = sketch("xy", () => {
        arc([20, 0], [-20, 0], [0, 0]);
      });
      const inner = offset(5, bow, { on: floor }) as unknown as OffsetCurve;
      const outer = offset(-5, bow, { on: floor }) as unknown as OffsetCurve;
      render();

      expect(inner.getError()).toBeNull();
      expect(outer.getError()).toBeNull();
      const [innerArc] = bucketOf(inner);
      const [outerArc] = bucketOf(outer);
      const innerCircle = CurveClassifier.classify(innerArc);
      const outerCircle = CurveClassifier.classify(outerArc);
      expect(innerCircle.kind).toBe("arc");
      expect(outerCircle.kind).toBe("arc");
      expect(innerCircle.radius).toBeCloseTo(15, 6);
      expect(outerCircle.radius).toBeCloseTo(25, 6);
      expect(xyz(innerCircle.center!)).toEqual([0, 0, 0]);
      expect(xyz(outerCircle.center!)).toEqual([0, 0, 0]);
      expect(ends(wiresOf(inner)[0])).toEqual([[15, 0, 0], [-15, 0, 0]]);
    });

    it("sets a closed circle beside itself as a closed circle, smaller or larger by the sign", () => {
      const floor = sheetOn(Plane.XY(), [-40, 40], [-40, 40]);
      const ring = sketch("xy", () => {
        circle([0, 0], 40);
      });
      const inner = offset(5, ring, { on: floor }) as unknown as OffsetCurve;
      const outer = offset(-5, ring, { on: floor }) as unknown as OffsetCurve;
      render();

      expect(inner.getError()).toBeNull();
      expect(outer.getError()).toBeNull();
      expect(wiresOf(inner).map(closed)).toEqual([true]);
      expect(wiresOf(outer).map(closed)).toEqual([true]);
      const radii = [inner, outer].map(oc => CurveClassifier.classify(bucketOf(oc)[0]));
      expect(radii.map(c => c.kind)).toEqual(["circle", "circle"]);
      expect(radii.map(c => round(c.radius!))).toEqual([15, 25]);
    });
  });

  describe("along a rim", () => {
    it("sets a box's top rim on its side walls as one closed wire of four edges, the distance below the rim", () => {
      const box = block(40, 10);
      const band = offset(3, box.endEdges(), { on: box.sideFaces() }) as unknown as OffsetCurve;
      const up = offset(-3, box.endEdges(), { on: box.sideFaces() }) as unknown as OffsetCurve;
      render();

      expect(band.getError()).toBeNull();
      const wires = wiresOf(band);
      expect(wires).toHaveLength(1);
      expect(closed(wires[0])).toBe(true);
      expect(kinds(band)).toEqual(["line", "line", "line", "line"]);
      expect(bucketOf(band).every(e => EdgeOps.endPoints(e).every(p => Math.abs(p.z - 2) < 1e-9))).toBe(true);
      // Above the rim there is no face.
      expect(up.getError()).toBe(
        "offset: at this distance the curve leaves the faces.\n"
        + "Hint: No part of the faces lies at this distance on this side of the edges: use a smaller distance, the other side, or more faces in { on }.",
      );
      expect(up.getShapes()).toEqual([]);
    });

    it("goes onto the faces from a rim whichever way the rim's edges run: the loop on the top face for its rim", () => {
      const box = block(40, 10);
      const inset = offset(2, box.endEdges(), { on: box.endFaces() }) as unknown as OffsetCurve;
      const bottom = offset(2, box.startEdges(), { on: box.startFaces() }) as unknown as OffsetCurve;
      render();

      expect(inset.getError()).toBeNull();
      expect(bottom.getError()).toBeNull();
      expect(bucketOf(inset).map(mid).sort()).toEqual([[2, 5, 5], [20, 2, 5], [20, 8, 5], [38, 5, 5]].sort());
      expect(bucketOf(bottom).map(mid).sort()).toEqual([[2, 5, 0], [20, 2, 0], [20, 8, 0], [38, 5, 0]].sort());
    });

    it("walks a rim with faces on both sides as it runs: the band on its left one way, the other band the other", () => {
      const box = block(40, 10);
      const rimEdges = box.endEdges();
      const plus = offset(2, rimEdges, { on: [box.endFaces(), box.sideFaces()] }) as unknown as OffsetCurve;
      const minus = offset(-2, box.endEdges(), { on: [box.endFaces(), box.sideFaces()] }) as unknown as OffsetCurve;
      render();

      expect(plus.getError()).toBeNull();
      expect(minus.getError()).toBeNull();
      const height = (oc: unknown) => [...new Set(bucketOf(oc).map(e => round(EdgeOps.getEdgeMidPoint(e).z)))];
      const bands = [height(plus), height(minus)];
      expect(bands.flat().sort()).toEqual([3, 5]);

      // The rim as it runs, at its first edge: standing on the top face
      // (outside +Z), the top band is on its left when the face's inside is.
      const [rim] = CurveOperand.wires(asObject(rimEdges), "rim");
      const first = rim.getEdges()[0];
      const [a, b] = [first.getFirstPoint(), first.getLastPoint()];
      const along = a.vectorTo(b);
      const inward = a.lerp(b, 0.5).vectorTo(new Point(20, 5, 5));
      const topIsLeft = new Vector3d(0, 0, 1).cross(along).dot(inward) > 0;
      rim.dispose();
      expect(bands).toEqual(topIsLeft ? [[5], [3]] : [[3], [5]]);
    });
  });

  describe("on curved faces and across faces", () => {
    it("sets a straight edge along a cylinder's axis beside itself on the cylinder: a line, its chord the distance", () => {
      const tube = cylinder(10, 40);
      const seam = sketch("yz", () => {
        line([10, 5], [10, 35]);
      });
      const oc = offset(4, seam, { on: asObject(tube) }) as unknown as OffsetCurve;
      render();

      expect(oc.getError()).toBeNull();
      expect(wiresOf(oc)).toHaveLength(1);
      expect(kinds(oc)).toEqual(["line"]);
      const [start, end] = ends(wiresOf(oc)[0]);
      expect(Math.hypot(start[0], start[1])).toBeCloseTo(10, 4);
      expect(new Point(start[0], start[1], start[2]).distanceTo(new Point(0, 10, 5))).toBeCloseTo(4, 4);
      expect(new Point(end[0], end[1], end[2]).distanceTo(new Point(0, 10, 35))).toBeCloseTo(4, 4);
      // Walking +Z on the outside of the wall at +Y (outside +Y), the left is +X.
      expect(start[0]).toBeGreaterThan(0);
      const faces = facesOf(tube);
      try {
        expectBeside(oc, faces, sourceOf(seam), 4);
      } finally {
        free(faces);
      }
    });

    it("sets a source across two faces beside itself as one wire of two edges, on the same side of both", () => {
      const box = block(40, 10);
      const bent = sketch(plane("yz", 20), () => {
        line([8, 5], [0, 5]);
        line([0, 5], [0, 1]);
      });
      const oc = offset(2, bent, { on: [box.endFaces(), select(face().planar().onPlane("xz"))] }) as unknown as OffsetCurve;
      render();

      expect(oc.getError()).toBeNull();
      const wires = wiresOf(oc);
      expect(wires).toHaveLength(1);
      expect(wires[0].getEdges()).toHaveLength(2);
      // Over the top along -Y then down the wall along -Z: the left is +X on both.
      expect(ends(wires[0])).toEqual([[22, 8, 5], [22, 0, 1]]);
      expect(kinds(oc)).toEqual(["line", "line"]);
    });

    it("sets a curve projected onto a ball beside itself on the ball", () => {
      const ball = sphere(30);
      const ring = above(50, () => {
        circle([0, 0], 30);
      });
      const pc = project(ring, asObject(ball));
      const inner = offset(1.5, asObject(pc), { on: asObject(ball) }) as unknown as OffsetCurve;
      const outer = offset(-1.5, asObject(pc), { on: asObject(ball) }) as unknown as OffsetCurve;
      render();

      expect(asObject(pc).getError()).toBeNull();
      expect(inner.getError()).toBeNull();
      expect(outer.getError()).toBeNull();
      expect(wiresOf(inner).map(closed)).toEqual([true]);
      expect(wiresOf(outer).map(closed)).toEqual([true]);
      const height = (oc: unknown) => EdgeOps.getEdgeMidPoint(bucketOf(oc)[0]).z;
      const source = asObject(pc).getShapes()[0];
      const faces = facesOf(ball);
      try {
        expectBeside(inner, faces, source.getShape(), 1.5, 1e-4);
        expectBeside(outer, faces, source.getShape(), 1.5, 1e-4);
      } finally {
        free(faces);
      }
      // One nearer the top of the ball, one farther.
      expect(new Set([Math.sign(height(inner) - 25.98), Math.sign(height(outer) - 25.98)])).toEqual(new Set([1, -1]));
    });
  });

  describe("refusals", () => {
    it("refuses edges that do not lie on the faces", () => {
      const box = block(40, 20);
      const high = above(20, () => {
        line([5, 10], [35, 10]);
      });
      const oc = offset(2, high, { on: box.endFaces() }) as unknown as OffsetCurve;
      render();

      expect(oc.getError()).toMatch(/^offset: the edges do not lie on the faces given in \{ on \}\.\nHint: The edge through \(5, 10, 20\) is off them/);
      expect(oc.getShapes()).toEqual([]);
    });

    it("refuses edges inside the solid given in { on }, which lie on none of its faces", () => {
      const box = block(40, 20);
      const inside = above(2.5, () => {
        line([5, 10], [35, 10]);
      });
      const oc = offset(2, inside, { on: asObject(box) }) as unknown as OffsetCurve;
      render();

      expect(oc.getError()).toMatch(/^offset: the edges do not lie on the faces given in \{ on \}\./);
    });

    it("refuses a zero distance", () => {
      const box = block(40, 20);
      const sk = above(5, () => {
        line([5, 10], [35, 10]);
      });
      const oc = offset(0, sk, { on: box.endFaces() }) as unknown as OffsetCurve;
      render();

      expect(oc.getError()).toMatch(/^offset: the distance is zero\./);
    });

    it("says the curve leaves the faces at a distance past their edge", () => {
      const box = block(40, 20);
      const sk = above(5, () => {
        line([5, 10], [35, 10]);
      });
      const oc = offset(15, sk, { on: box.endFaces() }) as unknown as OffsetCurve;
      render();

      expect(oc.getError()).toMatch(/^offset: at this distance the curve leaves the faces\./);
    });

    it("says the distance is larger than the tightest bend allows on the inside of a tight arc, and builds outside", () => {
      const floor = sheetOn(Plane.XY(), [-40, 40], [-40, 40]);
      const bow = sketch("xy", () => {
        arc([5, 0], [-5, 0], [0, 0]);
      });
      const inside = offset(8, bow, { on: floor }) as unknown as OffsetCurve;
      const outside = offset(-8, bow, { on: floor }) as unknown as OffsetCurve;
      render();

      expect(inside.getError()).toBe(
        "offset: the distance is larger than the curve's tightest bend allows on this side.\n"
        + "Hint: Use a smaller distance, or the other side.",
      );
      expect(outside.getError()).toBeNull();
      expect(round(CurveClassifier.classify(bucketOf(outside)[0]).radius!)).toBe(13);
    });
    it("finds where the tube folds on the inside of a spline's bend, and builds where it does not", () => {
      const floor = sheetOn(Plane.XY(), [-60, 60], [-60, 60]);
      // An arch about 20 in radius at its top; its inside is on the right.
      const arch = sketch("xy", () => {
        spline([-20, 0], [0, 10], [20, 0]);
      });
      // A hump much tighter at its top than 1.
      const hump = sketch("xy", () => {
        spline([-20, 0], [-3, 2], [0, 10], [3, 2], [20, 0]);
      });
      const near = offset(-3, arch, { on: floor }) as unknown as OffsetCurve;
      const far = offset(-25, arch, { on: floor }) as unknown as OffsetCurve;
      const outside = offset(25, arch, { on: floor }) as unknown as OffsetCurve;
      const narrow = offset(-1, hump, { on: floor }) as unknown as OffsetCurve;
      render();

      expect(near.getError()).toBeNull();
      expect(outside.getError()).toBeNull();
      const bend = /^offset: the distance is larger than the curve's tightest bend allows on this side\./;
      expect(far.getError()).toMatch(bend);
      // The fold is a sliver at the top, between any two samples of the
      // curve: found where the curve comes nearest the source.
      expect(narrow.getError()).toMatch(bend);
      const faces = facesOf(floor);
      try {
        expectBeside(near, faces, sourceOf(arch), 3, 1e-4);
        expectBeside(outside, faces, sourceOf(arch), 25, 1e-4);
      } finally {
        free(faces);
      }
    });

    it("refuses an L whose legs are shorter than the distance on the inside of its corner", () => {
      const floor = sheetOn(Plane.XY(), [-40, 40], [-40, 40]);
      const bend = sketch("xy", () => {
        line([0, 0], [10, 0]);
        line([10, 0], [10, 10]);
      });
      const inside = offset(12, bend, { on: floor }) as unknown as OffsetCurve;
      render();

      expect(inside.getError()).toMatch(/^offset: the distance is larger than the curve's tightest bend allows on this side\./);
    });
  });


  describe("the result", () => {
    const fresh = () => {
      getSceneManager().startScene();
      getSceneManager().setCurrentFile("");
    };

    it("lies on the faces at the distance from its source, each edge carrying its curve on the face it lies on", () => {
      const box = block(40, 10);
      const floor = sheetOn(Plane.XY(), [-40, 40], [-40, 40]);
      const bow = sketch("xy", () => {
        arc([20, 0], [-20, 0], [0, 0]);
      });
      const rim = box.endEdges();
      const band = offset(3, rim, { on: box.sideFaces() }) as unknown as OffsetCurve;
      const inner = offset(5, bow, { on: floor }) as unknown as OffsetCurve;
      render();

      expect(band.getError()).toBeNull();
      expect(inner.getError()).toBeNull();
      const rimShape = (() => {
        const raw = getOC();
        const builder = new raw.BRep_Builder();
        const compound = new raw.TopoDS_Compound();
        builder.MakeCompound(compound);
        asObject(rim).getShapes().forEach(e => builder.Add(compound, e.getShape()));
        builder.delete();
        return compound;
      })();
      const boxFaces = facesOf(box);
      const floorFaces = facesOf(floor);
      try {
        expectBeside(band, boxFaces, rimShape, 3);
        expectBeside(inner, floorFaces, sourceOf(bow), 5);
      } finally {
        free([...boxFaces, ...floorFaces, rimShape]);
      }
    });

    it("holds one wire per chain of the edges, in source order, each running as its source does", () => {
      const floor = sheetOn(Plane.XY(), [0, 40], [0, 40]);
      const first = sketch("xy", () => {
        line([30, 30], [10, 30]);
      });
      const second = sketch("xy", () => {
        line([10, 10], [30, 10]);
        line([30, 10], [30, 20]);
      });
      const oc = offset(2, [first, second], { on: floor }) as unknown as OffsetCurve;
      render();

      expect(oc.getError()).toBeNull();
      const wires = wiresOf(oc);
      expect(wires).toHaveLength(2);
      expect(ends(wires[0])).toEqual([[30, 28, 0], [10, 28, 0]]);
      // Along +X then +Y, the left is inside the turn: the corner is cut square.
      expect(ends(wires[1])).toEqual([[10, 12, 0], [28, 20, 0]]);
      expect(wires[1].getEdges().map(mid)).toEqual([[19, 12, 0], [28, 16, 0]]);
    });

    it("rounds a corner on its outside with an arc about the corner", () => {
      const floor = sheetOn(Plane.XY(), [0, 40], [0, 40]);
      const bend = sketch("xy", () => {
        line([10, 10], [30, 10]);
        line([30, 10], [30, 20]);
      });
      const oc = offset(-2, bend, { on: floor }) as unknown as OffsetCurve;
      render();

      expect(oc.getError()).toBeNull();
      expect(kinds(oc)).toEqual(["line", "arc", "line"]);
      expect(ends(wiresOf(oc)[0])).toEqual([[10, 8, 0], [32, 20, 0]]);
      const corner = CurveClassifier.classify(bucketOf(oc)[1]);
      expect(xyz(corner.center!)).toEqual([30, 10, 0]);
      expect(corner.radius).toBeCloseTo(2, 9);
    });

    it("lists the same edges in the same order when built twice, and after an upstream dimension changes", () => {
      const build = (width: number) => {
        fresh();
        const box = block(width, 10);
        const oc = offset(3, box.endEdges(), { on: box.sideFaces() });
        render();
        expect(asObject(oc).getError()).toBeNull();
        return bucketOf(oc).map(e => [mid(e), xyz(e.getFirstPoint()), xyz(e.getLastPoint())]);
      };
      // Each edge as [midpoint, start, end]: the loop starts on the wall at
      // x = 0 and runs as the rim does, whatever the block's width.
      const loop = (width: number) => [
        [[0, 5, 2], [0, 10, 2], [0, 0, 2]],
        [[width / 2, 0, 2], [0, 0, 2], [width, 0, 2]],
        [[width, 5, 2], [width, 0, 2], [width, 10, 2]],
        [[width / 2, 10, 2], [width, 10, 2], [0, 10, 2]],
      ];
      expect(build(40)).toEqual(loop(40));
      expect(build(40)).toEqual(loop(40));
      expect(build(60)).toEqual(loop(60));
    });
  });

  describe("accessors", () => {
    it("answers edges(), edges(i), start() and end()", () => {
      const box = block(40, 20);
      const sk = above(5, () => {
        line([35, 10], [5, 10]);
      });
      const oc = offset(2, sk, { on: box.endFaces() }) as unknown as OffsetCurve;
      const all = asObject(oc.edges());
      const first = asObject(oc.edges(0));
      addToScene(all);
      addToScene(first);
      const start = oc.start();
      const end = oc.end();
      render();

      expect(all.getShapes()).toEqual(bucketOf(oc));
      expect(first.getShapes()).toEqual([bucketOf(oc)[0]]);
      expect(at(start)).toEqual([35, 8, 5]);
      expect(at(end)).toEqual([5, 8, 5]);
    });
  });

  describe("the operands", () => {
    it("hides a source sketch, which a later statement still reads, and leaves the faces' body untouched", () => {
      const box = block(40, 20);
      const sk = above(5, () => {
        line([5, 10], [35, 10]);
      });
      const oc = offset(2, sk, { on: asObject(box) }) as unknown as OffsetCurve;
      const again = offset(-2, sk, { on: asObject(box) }) as unknown as OffsetCurve;
      const scene = render();

      expect(oc.getError()).toBeNull();
      expect(again.getError()).toBeNull();
      expectDisplayConsumed(scene, sk);
      expect(box.getShapes()).toHaveLength(1);
      expect(box.getShapes()[0].isSolid()).toBe(true);
      expect(box.getShapes(undefined, undefined, new Set(scene.getAllSceneObjects()))).toHaveLength(1);
    });

    it("leaves a body whose edges it runs beside untouched, and takes a face selection's highlight off the display", () => {
      const box = block(40, 10);
      const walls = asObject(select(face().planar().notParallelTo("xy")));
      const oc = offset(3, box.endEdges(), { on: walls }) as unknown as OffsetCurve;
      const scene = render();

      expect(oc.getError()).toBeNull();
      expectDisplayConsumed(scene, walls);
      expect(box.getShapes(undefined, undefined, new Set(scene.getAllSceneObjects()))).toHaveLength(1);
      expect(box.getShapes()[0].isSolid()).toBe(true);
    });

    it("claims a select() written inside { on }, so a later bare fillet(2) does not take it", () => {
      block(40, 20);
      const sk = above(5, () => {
        line([5, 10], [35, 10]);
      });
      const oc = offset(2, sk, { on: select(face().planar().onPlane("xy", 5)) }) as unknown as OffsetCurve;
      const top = getCurrentScene().getAllSceneObjects().find(obj => obj instanceof SelectSceneObject) as SelectSceneObject;
      const rounded = fillet(2) as unknown as Fillet;

      expect(top.isClaimed()).toBe(true);
      expect(getCurrentScene().getLastSelection()).toBeNull();
      expect(rounded.targetEdges).not.toContain(top);
      render();
      expect(oc.getError()).toBeNull();
      expect(ends(wiresOf(oc)[0])).toEqual([[5, 12, 5], [35, 12, 5]]);
    });

    it("refuses a solid as the edges, and a sketch in { on }, in the readers' words", () => {
      const box = block(40, 20);
      const sk = above(5, () => {
        line([5, 10], [35, 10]);
      });
      const solidSource = offset(2, asObject(box), { on: box.endFaces() }) as unknown as OffsetCurve;
      const sketchFaces = offset(2, sk, { on: sk }) as unknown as OffsetCurve;
      render();

      expect(solidSource.getError()).toMatch(/^offset: the source is a solid; pick the edges to use\./);
      expect(sketchFaces.getError()).toMatch(/^offset: \{ on \} is a sketch; it needs faces\./);
    });
  });

  describe("its arguments", () => {
    it("is told from the other forms by a trailing plain object, and from nothing else", () => {
      const box = block();
      expect(partOffsetOptions([2, box, { on: box }])).toEqual({ on: box });
      expect(partOffsetOptions([2, box])).toBeNull();
      expect(partOffsetOptions([2, [box]])).toBeNull();
      expect(partOffsetOptions([2, box, edge().line()])).toBeNull();
      expect(partOffsetOptions([2, box, Object.create(null)])).not.toBeNull();
    });

    it("takes exactly { on }: an empty options object, a missing on or another key is refused", () => {
      const box = block();
      expect(() => offset(2, box.endEdges(), {} as never)).toThrow("offset: the only option is { on: faces }.");
      expect(() => offset(2, box.endEdges(), { faces: box } as never)).toThrow("offset: the only option is { on: faces }.");
      expect(() => offset(2, box.endEdges(), { on: box.sideFaces(), extend: true } as never)).toThrow(
        "offset: the only option is { on: faces }.",
      );
    });

    it("needs faces in { on }: an empty list or something that is not a scene object is refused", () => {
      const box = block();
      expect(() => offset(2, box.endEdges(), { on: [] })).toThrow("offset: { on } needs the faces the curve lies on.");
      expect(() => offset(2, box.endEdges(), { on: "xy" } as never)).toThrow("offset: { on } needs the faces the curve lies on.");
      expect(() => offset(2, box.endEdges(), { on: undefined } as never)).toThrow("offset: { on } needs the faces the curve lies on.");
    });

    it("refuses a distance that is not a number, missing edges, an empty edges list and too many arguments", () => {
      const box = block();
      expect(() => partOffsetCurveArgs(["2", box, { on: box }])).toThrow("offset: the distance must be a number; got '2'.");
      expect(() => partOffsetCurveArgs([2, { on: box }])).toThrow(
        "offset: an offset curve needs a distance and the edges before { on }: offset(distance, edges, { on: faces }).",
      );
      expect(() => partOffsetCurveArgs([2, box, box, { on: box }])).toThrow(/takes one edges argument, got 2: put several objects in one list/);
      expect(() => partOffsetCurveArgs([2, [], { on: box }])).toThrow("offset: the edges argument is an empty list; give it the curves to offset.");
      expect(() => partOffsetCurveArgs([2, 3, { on: box }])).toThrow(
        "offset: the edges argument must be curves — a selection of edges, a curve, a sketch — or a list of them; got 3.",
      );
      expect(partOffsetCurveArgs([2, [box, box], { on: [box] }])).toEqual({ distance: 2, edges: [box, box], on: [box] });
    });

    it("carries the distance, the edges and the faces through createCopy, compareTo, getDependencies and serialize", () => {
      const box = block();
      const sk = above(5, () => {
        line([5, 5], [35, 5]);
      });
      const other = asObject(box.startEdges());
      const faces = asObject(box.endFaces());
      const make = () => new OffsetCurve(2, [asObject(sk)], [faces]);
      expectOptionsCarried<OffsetCurve>(make, {
        distance: tool => { tool["distance"] = -2; },
        edges: tool => { tool["sources"][0] = other; },
        on: tool => { tool["on"].push(asObject(box)); },
      });
      expect(make().getDependencies()).toEqual([sk, faces]);
      expect(make().getType()).toBe("offset-curve");
      expect(make().serialize()).toMatchObject({ distance: 2 });
      expect(Object.keys(make().serialize())).toEqual(["distance", "edges", "on"]);
    });
  });

  describe("repeat()", () => {
    it("repeats the curve with its edges bucket", () => {
      const box = block(40, 20);
      const sk = above(5, () => {
        line([5, 10], [35, 10]);
      });
      const oc = offset(2, sk, { on: box.endFaces() }) as unknown as OffsetCurve;
      const r = repeat("linear", "y", { count: 2, offset: 50 }, oc) as unknown as RepeatBase;
      const copied = asObject(r.instance(1).edges(0));
      addToScene(copied);
      render();

      const [copy] = r.getInstanceRoots(1);
      expect(copy).toBeInstanceOf(OffsetCurve);
      expect(copy.getError()).toBeNull();
      const bucket = copy.getState(OffsetCurve.EDGES_KEY) as Edge[];
      expect(bucket.map(mid)).toEqual([[20, 62, 5]]);
      expect(copied.getShapes()).toEqual([bucket[0]]);
    });
  });

  describe("its row", () => {
    it("reads as what it makes in an unnamed row, while the sketch tool of its callee keeps its own name", () => {
      const box = block(40, 20);
      const sk = above(5, () => {
        line([5, 10], [35, 10]);
      });
      const oc = offset(2, sk, { on: box.endFaces() }) as unknown as OffsetCurve;
      render();

      const labels = DefaultNames.labelsFor(getCurrentScene().getTimelineObjects());
      expect(oc.getDisplayType()).toBe("Offset Curve");
      expect(DefaultNames.labelFor(oc, labels)).toBe("Offset Curve 1");
      expect(Object.create(Offset.prototype).getDisplayType()).toBe("Offset");
    });
  });

  describe("the preview", () => {
    const ref = (line: number): GhostOperandRef => ({ kind: "statement", filePath: FILE, line });

    it("draws the curve as a wire from statements and from picked edges and faces", () => {
      const box = located(block(40, 20), 2);
      located(above(5, () => {
        line([5, 10], [35, 10]);
      }), 3);
      const scene = render() as Scene;

      const statements = buildFeatureGhost(scene, {
        feature: "offset-curve", distance: 2, edges: [ref(3)], on: [ref(2)],
      }, DEFAULT_MESH_CONFIG);
      expect(statements).toMatchObject({ ok: true, solids: [{ kind: "wire" }] });

      const solid = asObject(box).getShapes()[0];
      const faces = Explorer.findFacesWrapped(solid);
      const walls = faces.map((f, i) => [f, i] as const)
        .filter(([f]) => Math.abs(ShapeMeasure.centerOfMass(f).z - 2.5) < 1e-6).map(([, i]) => i);
      faces.forEach(f => f.dispose());
      const edges = Explorer.findEdgesWrapped(solid);
      const rim = edges.map((e, i) => [e, i] as const)
        .filter(([e]) => Math.abs(EdgeOps.getEdgeMidPoint(e).z - 5) < 1e-6).map(([, i]) => i);
      edges.forEach(e => e.dispose());
      const picked = buildFeatureGhost(scene, {
        feature: "offset-curve",
        distance: 3,
        edges: rim.map(index => ({ kind: "edge" as const, shapeId: solid.id, index })),
        on: walls.map(index => ({ kind: "face" as const, shapeId: solid.id, index })),
      }, DEFAULT_MESH_CONFIG);
      expect(picked).toMatchObject({ ok: true, solids: [{ kind: "wire" }] });

      const missing = buildFeatureGhost(scene, {
        feature: "offset-curve", distance: 2, edges: [ref(3)], on: [ref(9)],
      }, DEFAULT_MESH_CONFIG);
      expect(missing.ok).toBe(false);
    });

    it("says why the build refuses: a zero distance, a curve that leaves the faces", () => {
      located(block(40, 20), 2);
      located(above(5, () => {
        line([5, 10], [35, 10]);
      }), 3);
      const scene = render();

      const zero = buildFeatureGhost(scene, {
        feature: "offset-curve", distance: 0, edges: [ref(3)], on: [ref(2)],
      }, DEFAULT_MESH_CONFIG);
      expect(zero).toMatchObject({ ok: false, surface: true, reason: "offset: the distance is zero." });

      const leaves = buildFeatureGhost(scene, {
        feature: "offset-curve", distance: 15, edges: [ref(3)], on: [ref(2)],
      }, DEFAULT_MESH_CONFIG);
      expect(leaves).toMatchObject({ ok: false, surface: true, reason: "offset: at this distance the curve leaves the faces." });
    });
  });

  describe("its edit dialog's sources", () => {
    it("resolves the edges and the faces: statements by call site, selections as entities", () => {
      const box = located(block(40, 20), 2);
      const sk = located(above(5, () => {
        line([5, 10], [35, 10]);
      }), 3);
      const top = located(select(face().planar().onPlane("xy", 5)), 4);
      const oc = located(offset(2, [sk], { on: [top, asObject(box)] }), 6);
      const scene = render();
      expect(asObject(oc).getError()).toBeNull();

      const index = scene.getAllSceneObjects().indexOf(asObject(oc));
      const result = resolveFeatureSources(scene, { index, type: "offset-curve", line: 6, column: 0 });
      expect(result.ok).toBe(true);
      if (result.ok && result.feature === "offset-curve") {
        expect(result.edges).toEqual([{ kind: "sketch", filePath: FILE, line: 3, column: 0 }]);
        expect(result.on).toHaveLength(2);
        expect(result.on[0]).toMatchObject({ kind: "entities" });
        expect(result.on[1]).toEqual({ kind: "sketch", filePath: FILE, line: 2, column: 0 });
      }
    });
  });

  describe("picks", () => {
    it("synthesizes a row's edge picks, or its face picks, as offset(...) arguments, and refuses a mixed row", () => {
      const box = located(block(), 2);
      const scene = render();
      const solid = asObject(box).getShapes()[0];
      const faces = Explorer.findFacesWrapped(solid);
      const top = faces.findIndex(f => Math.abs(ShapeMeasure.centerOfMass(f).z - 5) < 1e-6);
      faces.forEach(f => f.dispose());

      const on = synthesizeApplyFeature(scene, [{ shapeId: solid.id, sub: { type: "face", index: top } }], "offset-curve");
      expect(on.ok).toBe(true);
      if (on.ok) {
        expect(on.preview).toBe(`offset(${on.args})`);
        expect(on.spec.feature).toBe("offset-curve");
        expect(on.spec.value).toBeUndefined();
      }
      const edges = synthesizeApplyFeature(scene, [{ shapeId: solid.id, sub: { type: "edge", index: 0 } }], "offset-curve");
      expect(edges.ok).toBe(true);

      const mixed = synthesizeApplyFeature(scene, [
        { shapeId: solid.id, sub: { type: "edge", index: 0 } },
        { shapeId: solid.id, sub: { type: "face", index: top } },
      ], "offset-curve");
      expect(mixed).toMatchObject({
        ok: false, reason: "offset takes edges for its curves and faces for { on } — pick one kind per row",
      });
    });

    it("names a pick on the curve through the curve's own variable, oc", () => {
      const box = block(40, 20);
      const sk = above(5, () => {
        line([5, 10], [35, 10]);
      });
      const oc = located(offset(2, sk, { on: box.endFaces() }), 6);
      const scene = render();
      const wire = asObject(oc).getShapes()[0];

      const result = synthesizeApplyFeature(scene, [{ shapeId: wire.id, sub: { type: "edge", index: 0 } }], "sweep");
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.spec.producers.map(producer => producer.nameHint)).toEqual(["oc"]);
        expect(result.args).toMatch(/^oc\.edges\(/);
      }
    });
  });

  describe("the other forms of offset", () => {
    it("still offsets sketch geometry inside a sketch, a trailing object or not", () => {
      const box = block(40, 20);
      const s = sketch("xy", () => {
        const c = circle([0, 0], 40);
        offset(5, c);
        offset(3, c, { on: asObject(box) } as never);
      }) as unknown as Sketch;
      render();

      const offsets = s.getChildren().filter(child => child instanceof Offset);
      expect(offsets).toHaveLength(2);
      expect(offsets.map(o => o.getError())).toEqual([null, null]);
      expect(offsets.map(o => o.getShapes().length)).toEqual([1, 1]);
      expect(getCurrentScene().getAllSceneObjects().some(obj => obj instanceof OffsetCurve)).toBe(false);
    });

    it("still offsets a face's outline on its plane outside a sketch without { on }", () => {
      const box = block(40, 20);
      const outline = offset(3, box.endFaces()) as unknown as Offset;
      render();

      expect(outline).toBeInstanceOf(Offset);
      expect(outline).not.toBeInstanceOf(OffsetCurve);
      expect(outline.getError()).toBeNull();
      const edges = outline.getShapes().filter(shape => shape instanceof Edge) as Edge[];
      expect(edges.length).toBeGreaterThan(0);
      expect(edges.every(e => Math.abs(EdgeOps.getEdgeMidPoint(e).z - 5) < 1e-6)).toBe(true);
    });
  });
});
