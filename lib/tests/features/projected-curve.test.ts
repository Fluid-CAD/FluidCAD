import { describe, it, expect } from "vitest";
import type { TopoDS_Edge, TopoDS_Face, TopoDS_Shape } from "ocjs-fluidcad";
import { setupOC, render, addToScene, expectDisplayConsumed } from "../setup.js";
import sketch from "../../core/sketch.js";
import extrude from "../../core/extrude.js";
import cylinder from "../../core/cylinder.js";
import sphere from "../../core/sphere.js";
import helix from "../../core/helix.js";
import axis from "../../core/axis.js";
import select from "../../core/select.js";
import fillet from "../../core/fillet.js";
import repeat from "../../core/repeat.js";
import plane from "../../core/plane.js";
import part from "../../core/part.js";
import connector from "../../core/connector.js";
import sweep from "../../core/sweep.js";
import translate from "../../core/translate.js";
import { circle, line, project } from "../../core/2d/index.js";
import { edge, face } from "../../filters/index.js";
import { partProjectArgs } from "../../core/2d/project.js";
import { getOC } from "../../oc/init.js";
import { Convert } from "../../oc/convert.js";
import { SheetOps } from "../../oc/sheet-ops.js";
import { CurveClassifier } from "../../oc/curve-classifier.js";
import { EdgeOps } from "../../oc/edge-ops.js";
import { Explorer } from "../../oc/explorer.js";
import { ShapeMeasure } from "../../oc/shape-measure.js";
import { WireOps } from "../../oc/wire-ops.js";
import { DEFAULT_MESH_CONFIG } from "../../oc/mesh.js";
import { SceneObject } from "../../common/scene-object.js";
import { Edge } from "../../common/edge.js";
import { Wire } from "../../common/wire.js";
import { Sheet } from "../../common/sheet.js";
import { Plane } from "../../math/plane.js";
import { Point } from "../../math/point.js";
import { Vector3d } from "../../math/vector3d.js";
import { ProjectedCurve } from "../../features/projected-curve.js";
import { Projection } from "../../features/2d/projection.js";
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
import { DefaultNames } from "../../rendering/default-names.js";
import { getCurrentScene } from "../../scene-manager.js";
import { testRect } from "../helpers/profiles.js";
import { useLoadedBodies, loadShapes } from "../helpers/loaded-bodies.js";
import { expectOptionsCarried } from "../helpers/option-contract.js";

const FILE = "/tmp/projected-curve-test.fluid.js";

const asObject = (value: unknown) => value as SceneObject;
const round = (value: number) => +value.toFixed(4) + 0;
const xyz = (point: Point) => [point.x, point.y, point.z].map(round);
const mid = (e: Edge) => xyz(EdgeOps.getEdgeMidPoint(e));
const at = (vertex: LazyVertex) => xyz(PointResolver.toWorld(vertex));

/** The curve's wires, as the scene holds them. */
const wiresOf = (pc: unknown) => asObject(pc).getShapes() as Wire[];
/** Every edge of the result, in the order `edges()` lists them. */
const bucketOf = (pc: unknown) => asObject(pc).getState(ProjectedCurve.EDGES_KEY) as Edge[];
const ends = (wire: Wire) => [xyz(wire.getFirstPoint()!), xyz(wire.getLastPoint()!)];
const closed = (wire: Wire) => wire.getFirstPoint()!.distanceTo(wire.getLastPoint()!) < 1e-6;
const lengthOf = (wire: Wire) => ShapeMeasure.size(wire);

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

/** A `width` × 10 × 5 block on XY from the origin. */
function block(width = 40): Extrude {
  sketch("xy", () => {
    testRect(width, 10);
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

/** The distance from a point to a shape. */
function distance(point: Point, shape: TopoDS_Shape): number {
  const oc = getOC();
  const at = new oc.gp_Pnt(point.x, point.y, point.z);
  const maker = new oc.BRepBuilderAPI_MakeVertex(at);
  const vertex = maker.Shape();
  const progress = new oc.Message_ProgressRange();
  const extrema = new oc.BRepExtrema_DistShapeShape(
    vertex, shape, oc.Extrema_ExtFlag.Extrema_ExtFlag_MIN, oc.Extrema_ExtAlgo.Extrema_ExtAlgo_Grad, progress,
  );
  try {
    return extrema.Value();
  } finally {
    extrema.delete();
    progress.delete();
    vertex.delete();
    maker.delete();
    at.delete();
  }
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

/** Every image edge lies on the target faces — its points within `tolerance` — and carries its curve on one of them. */
function expectOnTarget(pc: unknown, faces: TopoDS_Face[], tolerance = 1e-5): void {
  const compound = (() => {
    const oc = getOC();
    const builder = new oc.BRep_Builder();
    const result = new oc.TopoDS_Compound();
    builder.MakeCompound(result);
    faces.forEach(f => builder.Add(result, f));
    builder.delete();
    return result;
  })();
  try {
    for (const e of bucketOf(pc)) {
      expect(hasCurveOn(e, faces), `the edge at ${mid(e)} carries its curve on a target face`).toBe(true);
      for (const point of pointsAlong(e)) {
        expect(distance(point, compound)).toBeLessThan(tolerance);
      }
    }
  } finally {
    compound.delete();
  }
}

describe("project(source, target) outside a sketch", () => {
  setupOC();
  useLoadedBodies();

  describe("along a direction", () => {
    it("drops a line onto a plane below it along the sketch normal, as long as it was", () => {
      const floor = sheetOn(Plane.XY(), [0, 40], [0, 20]);
      const sk = above(20, () => {
        line([5, 10], [35, 10]);
      });
      const pc = project(sk, floor) as unknown as ProjectedCurve;
      render();

      expect(pc.getError()).toBeNull();
      const wires = wiresOf(pc);
      expect(wires).toHaveLength(1);
      expect(ends(wires[0])).toEqual([[5, 10, 0], [35, 10, 0]]);
      expect(lengthOf(wires[0])).toBeCloseTo(30, 6);
      expect(CurveClassifier.classify(bucketOf(pc)[0]).kind).toBe("line");
    });

    it("lays a circle onto a sphere as one closed curve, and onto both sides with keep('all')", () => {
      const ball = sphere(10);
      const sk = above(20, () => {
        circle([0, 0], 10);
      });
      const nearest = project(sk, asObject(ball)) as unknown as ProjectedCurve;
      const all = project(sk, asObject(ball)).keep("all") as unknown as ProjectedCurve;
      render();

      expect(nearest.getError()).toBeNull();
      expect(all.getError()).toBeNull();
      const [top] = wiresOf(nearest);
      expect(wiresOf(nearest)).toHaveLength(1);
      expect(closed(top)).toBe(true);
      const cls = CurveClassifier.classify(bucketOf(nearest)[0]);
      expect(cls.kind).toBe("circle");
      expect(cls.radius).toBeCloseTo(5, 6);
      expect(cls.center!.z).toBeCloseTo(Math.sqrt(75), 6);

      // The near side first, then the far side; each runs round as the source does.
      const both = wiresOf(all);
      expect(both).toHaveLength(2);
      expect(both.every(closed)).toBe(true);
      expect(ShapeMeasure.centerOfMass(both[0]).z).toBeCloseTo(Math.sqrt(75), 6);
      expect(ShapeMeasure.centerOfMass(both[1]).z).toBeCloseTo(-Math.sqrt(75), 6);
      const source = sk.getShapes()[0] as Edge;
      const sourceWire = WireOps.makeWireFromEdges([source]);
      const up = new Vector3d(0, 0, 1);
      try {
        for (const image of both) {
          expect(WireOps.isCW(image, up)).toBe(WireOps.isCW(sourceWire, up));
        }
      } finally {
        sourceWire.dispose();
      }
    });

    it("keeps the image on the source's side of a cylinder, chained across its seam, and the far one too with keep('all')", () => {
      // The cylinder's seam runs at +X; the line, at x = 20, projects across it.
      const tube = cylinder(10, 40);
      const sk = sketch(plane("yz", 20), () => {
        line([-5, 20], [5, 20]);
      }) as unknown as Sketch;
      const nearest = project(sk, asObject(tube)) as unknown as ProjectedCurve;
      const all = project(sk, asObject(tube)).keep("all") as unknown as ProjectedCurve;
      render();

      expect(nearest.getError()).toBeNull();
      const near = wiresOf(nearest);
      expect(near).toHaveLength(1);
      // Two arcs, one each side of the seam, as one wire running as the source does.
      expect(near[0].getEdges()).toHaveLength(2);
      expect(ends(near[0])).toEqual([[round(Math.sqrt(75)), -5, 20], [round(Math.sqrt(75)), 5, 20]]);

      const both = wiresOf(all);
      expect(both).toHaveLength(2);
      expect(ends(both[0])).toEqual(ends(near[0]));
      expect(ends(both[1])).toEqual([[-round(Math.sqrt(75)), -5, 20], [-round(Math.sqrt(75)), 5, 20]]);
      for (const e of bucketOf(all)) {
        const cls = CurveClassifier.classify(e);
        expect(cls.kind).toBe("arc");
        expect(cls.radius).toBeCloseTo(10, 6);
      }
    });

    it("gives the same image for 'z', an axis(), a straight edge, a planar face and 'xy'", () => {
      sketch("xy", () => {
        testRect(100, 100, { at: [-50, -50] });
      });
      const box = extrude(5).new() as unknown as Extrude;
      const upright = select(edge().verticalTo("xy").nearest("x").nearest("y"));
      const top = box.endFaces();
      const sk = sketch(plane("xy", { offset: 20, rotateX: 30 }), () => {
        circle([0, 0], 10);
      });
      const byName = project(sk, box.endFaces()).direction("z") as unknown as ProjectedCurve;
      const byAxis = project(sk, box.endFaces()).direction(axis("z")) as unknown as ProjectedCurve;
      const byEdge = project(sk, box.endFaces()).direction(upright) as unknown as ProjectedCurve;
      const byFace = project(sk, box.endFaces()).direction(top) as unknown as ProjectedCurve;
      const byPlane = project(sk, box.endFaces()).direction("xy") as unknown as ProjectedCurve;
      const natural = project(sk, box.endFaces()) as unknown as ProjectedCurve;
      render();

      const shape = (pc: ProjectedCurve) => {
        expect(pc.getError()).toBeNull();
        const wires = wiresOf(pc);
        expect(wires).toHaveLength(1);
        return { length: round(lengthOf(wires[0])), centre: xyz(ShapeMeasure.centerOfMass(wires[0])) };
      };
      const expected = shape(byName);
      // Straight down onto the top: an ellipse 10 across one way, 10·cos 30° the other.
      expect(expected.centre[2]).toBe(5);
      for (const pc of [byAxis, byEdge, byFace, byPlane]) {
        expect(shape(pc)).toEqual(expected);
      }
      // Along the sketch's own normal the image is another ellipse, elsewhere.
      expect(shape(natural)).not.toEqual(expected);
    });

    it("takes a connector as the line of its Z axis", () => {
      let byConnector: ProjectedCurve = null!;
      let byName: ProjectedCurve = null!;
      part("plate", () => {
        const box = block();
        const top = connector("top", select(face().planar().onPlane("xy", 5)));
        const sk = sketch(plane("xy", { offset: 20, rotateX: 20 }), () => {
          line([5, 5], [35, 5]);
        });
        byConnector = project(sk, box.endFaces()).direction(top) as unknown as ProjectedCurve;
        byName = project(sk, box.endFaces()).direction("z") as unknown as ProjectedCurve;
      });
      render();

      expect(byConnector.getError()).toBeNull();
      expect(byConnector.directionOperand!.isInternal()).toBe(true);
      expect(wiresOf(byConnector).map(ends)).toEqual(wiresOf(byName).map(ends));
    });

    it("lays an image across two faces as one wire of two edges, and leaves out the far side of the body", () => {
      // A roof: a triangle 20 wide and 8 tall, extruded 10.
      sketch("xz", () => {
        line([0, 0], [20, 0]);
        line([20, 0], [10, 8]);
        line([10, 8], [0, 0]);
      });
      const roof = extrude(10).new();
      const sk = above(20, () => {
        line([-5, -5], [25, -5]);
      });
      const nearest = project(sk, asObject(roof)) as unknown as ProjectedCurve;
      const all = project(sk, asObject(roof)).keep("all") as unknown as ProjectedCurve;
      render();

      expect(nearest.getError()).toBeNull();
      const [wire] = wiresOf(nearest);
      expect(wiresOf(nearest)).toHaveLength(1);
      expect(wire.getEdges().map(mid)).toEqual([[5, -5, 4], [15, -5, 4]]);
      expect(ends(wire)).toEqual([[0, -5, 0], [20, -5, 0]]);
      // Every image: the roof's two slopes and its floor, one closed loop.
      expect(wiresOf(all)).toHaveLength(1);
      expect(closed(wiresOf(all)[0])).toBe(true);
      expect(bucketOf(all)).toHaveLength(3);
    });

    it("leaves out the far side of a ball where the image folds round its silhouette", () => {
      const ball = sphere(10);
      const sk = above(20, () => {
        line([-15, 3], [15, 3]);
      });
      const nearest = project(sk, asObject(ball)) as unknown as ProjectedCurve;
      const all = project(sk, asObject(ball)).keep("all") as unknown as ProjectedCurve;
      const wall = cylinder(10, 40);
      const across = sketch(plane("yz", 30), () => {
        line([-15, 20], [15, 20]);
      });
      const halfRound = project(across, asObject(wall)) as unknown as ProjectedCurve;
      render();

      // The upper half of the circle the line's plane cuts, from fold to fold.
      expect(nearest.getError()).toBeNull();
      expect(wiresOf(nearest)).toHaveLength(1);
      const r = round(Math.sqrt(91));
      expect(ends(wiresOf(nearest)[0])).toEqual([[-r, 3, 0], [r, 3, 0]]);
      for (const e of bucketOf(nearest)) {
        for (const point of pointsAlong(e)) {
          expect(point.z).toBeGreaterThan(-1e-6);
        }
      }
      // Every image: the whole circle, one closed wire.
      expect(wiresOf(all)).toHaveLength(1);
      expect(closed(wiresOf(all)[0])).toBe(true);
      expect(lengthOf(wiresOf(all)[0])).toBeCloseTo(2 * Math.PI * Math.sqrt(91), 6);
      // A line wider than a cylinder: the half of the wall facing it.
      expect(halfRound.getError()).toBeNull();
      expect(wiresOf(halfRound)).toHaveLength(1);
      expect(ends(wiresOf(halfRound)[0])).toEqual([[0, -10, 20], [0, 10, 20]]);
      expect(lengthOf(wiresOf(halfRound)[0])).toBeCloseTo(10 * Math.PI, 6);
    });

    it("keeps every stretch of the near side: the top either side of a pocket, and the pocket's floor", () => {
      sketch("xy", () => {
        testRect(30, 10);
      });
      extrude(10);
      sketch(plane("xy", 10), () => {
        testRect(10, 4, { at: [10, 3] });
      });
      const body = extrude(4).remove();
      const sk = above(20, () => {
        line([0, 5], [30, 5]);
      });
      const pc = project(sk, asObject(body)) as unknown as ProjectedCurve;
      render();

      expect(pc.getError()).toBeNull();
      expect(wiresOf(pc).map(ends)).toEqual([
        [[0, 5, 10], [10, 5, 10]],
        [[10, 5, 6], [20, 5, 6]],
        [[20, 5, 10], [30, 5, 10]],
      ]);
    });

    it("projects each chain of the source, in source order, each running as its source does", () => {
      const box = block();
      const sk = above(20, () => {
        line([5, 2], [15, 2]);
        line([30, 8], [20, 8]);
      });
      const tops = project(sk, box.endFaces()) as unknown as ProjectedCurve;
      const all = project(sk, asObject(box)).keep("all") as unknown as ProjectedCurve;
      render();

      expect(tops.getError()).toBeNull();
      expect(wiresOf(tops).map(ends)).toEqual([
        [[5, 2, 5], [15, 2, 5]],
        [[30, 8, 5], [20, 8, 5]],
      ]);
      expect(wiresOf(all).map(ends)).toEqual([
        [[5, 2, 5], [15, 2, 5]],
        [[5, 2, 0], [15, 2, 0]],
        [[30, 8, 5], [20, 8, 5]],
        [[30, 8, 0], [20, 8, 0]],
      ]);
    });

    it("needs a direction for a source in no one plane, and works with one", () => {
      const h = helix("z").radius(5).pitch(5).height(12);
      const wall = sheetOn(new Plane(new Point(-20, 0, 0), Plane.YZ().xDirection, Plane.YZ().normal), [-10, 10], [-5, 20]);
      const bare = project(asObject(h), wall) as unknown as ProjectedCurve;
      const along = project(asObject(h), wall).direction("x") as unknown as ProjectedCurve;
      render();

      expect(bare.getError()).toBe(
        "project: the source does not lie in a plane, so it has no natural direction.\n"
        + "Hint: Add .direction(…), or use .mode('normal').",
      );
      expect(along.getError()).toBeNull();
      expect(wiresOf(along)).toHaveLength(1);
      for (const e of bucketOf(along)) {
        for (const point of pointsAlong(e)) {
          expect(point.x).toBeCloseTo(-20, 6);
        }
      }
    });

    it("says the projection misses the target, and so when the direction runs along it", () => {
      const box = block();
      const beside = above(20, () => {
        line([50, 5], [70, 5]);
      });
      const over = above(20, () => {
        line([5, 5], [35, 5]);
      });
      const off = project(beside, asObject(box)) as unknown as ProjectedCurve;
      const sideways = project(over, box.endFaces()).direction("y") as unknown as ProjectedCurve;
      const lengthways = project(over, box.endFaces()).direction("x") as unknown as ProjectedCurve;
      render();

      expect(off.getError()).toBe(
        "project: the projection misses the target.\n"
        + "Hint: Along Z, no part of the source falls on the picked faces.",
      );
      expect(sideways.getError()).toMatch(/^project: the projection misses the target\.\nHint: Along Y, /);
      expect(lengthways.getError()).toMatch(/^project: the projection misses the target\.\nHint: Along X, /);
      expect(off.getShapes()).toEqual([]);
    });

    it("lies on the target, each edge carrying its curve on the face it lies on", () => {
      const tube = cylinder(10, 40);
      const ball = asObject(translate(40, 0, 0, sphere(10) as never));
      const across = sketch(plane("yz", 20), () => {
        line([-5, 20], [5, 20]);
      });
      const ring = above(30, () => {
        circle([40, 3], 10);
      });
      const onTube = project(across, asObject(tube)).keep("all") as unknown as ProjectedCurve;
      const onBall = project(ring, ball).keep("all") as unknown as ProjectedCurve;
      render();

      expect(onTube.getError()).toBeNull();
      expect(onBall.getError()).toBeNull();
      const tubeFaces = facesOf(tube);
      const ballFaces = facesOf(ball);
      try {
        expectOnTarget(onTube, tubeFaces);
        expectOnTarget(onBall, ballFaces);
      } finally {
        free([...tubeFaces, ...ballFaces]);
      }
    });
  });

  describe("normal to the faces", () => {
    it("lays a helix onto a larger coaxial cylinder with the helix's pitch", () => {
      const h = helix("z").radius(5).pitch(5).height(12);
      sketch("xy", () => {
        circle([0, 0], 20);
      });
      const shaft = extrude(30).new() as unknown as Extrude;
      const pc = project(asObject(h), shaft.sideFaces()).mode("normal") as unknown as ProjectedCurve;
      render();

      expect(pc.getError()).toBeNull();
      expect(wiresOf(pc)).toHaveLength(1);
      const source = asObject(h).getShapes()[0].getShape();
      const faces = facesOf(shaft);
      try {
        for (const e of bucketOf(pc)) {
          for (const point of pointsAlong(e)) {
            // On the cylinder, 10 from its axis …
            expect(Math.hypot(point.x, point.y)).toBeCloseTo(10, 4);
            // … straight out from a point of the helix: same angle, same height.
            const inward = new Point(point.x / 2, point.y / 2, point.z);
            expect(distance(inward, source)).toBeLessThan(1e-3);
          }
        }
        expectOnTarget(pc, faces, 1e-4);
      } finally {
        free(faces);
      }
      // It runs as the helix does: from its start to its end.
      const [first, last] = ends(wiresOf(pc)[0]);
      expect(first[2]).toBeCloseTo(0, 4);
      expect(last[2]).toBeCloseTo(12, 4);
    });

    it("lays a helix of many turns onto the cylinder whole, one wire from its start to its end", () => {
      // The kernel's normal projector walks a long winding curve badly: in
      // one go, this helix came back as three stretches with a whole turn
      // missing between each, so keep 'nearest' kept the first turn alone.
      const h = helix(axis("z", { offsetX: -100 })).radius(10).pitch(8).height(40);
      sketch("xy", () => {
        circle([-100, 0], 40);
      });
      const shaft = extrude(60).new() as unknown as Extrude;
      const nearest = project(asObject(h), shaft.sideFaces()).mode("normal") as unknown as ProjectedCurve;
      const all = project(asObject(h), shaft.sideFaces()).mode("normal").keep("all") as unknown as ProjectedCurve;
      render();

      for (const pc of [nearest, all]) {
        expect(pc.getError()).toBeNull();
        expect(wiresOf(pc)).toHaveLength(1);
        const [first, last] = ends(wiresOf(pc)[0]);
        expect(first[2]).toBeCloseTo(0, 4);
        expect(last[2]).toBeCloseTo(40, 4);
        // Five turns of a helix of radius 20: its length, every stretch there.
        expect(lengthOf(wiresOf(pc)[0])).toBeCloseTo(5 * Math.hypot(2 * Math.PI * 20, 8), 1);
        for (const e of bucketOf(pc)) {
          for (const point of pointsAlong(e, 4)) {
            expect(Math.hypot(point.x + 100, point.y)).toBeCloseTo(20, 4);
          }
        }
      }
    });

    it("keeps the image at the smallest distance, and every one with keep('all')", () => {
      const box = block();
      const sk = above(20, () => {
        line([5, 5], [35, 5]);
      });
      const nearest = project(sk, asObject(box)).mode("normal") as unknown as ProjectedCurve;
      const all = project(sk, asObject(box)).mode("normal").keep("all") as unknown as ProjectedCurve;
      render();

      expect(nearest.getError()).toBeNull();
      expect(wiresOf(nearest).map(ends)).toEqual([[[5, 5, 5], [35, 5, 5]]]);
      expect(wiresOf(all).map(ends)).toEqual([[[5, 5, 5], [35, 5, 5]], [[5, 5, 0], [35, 5, 0]]]);
    });
  });

  describe("the chained options", () => {
    it("refuses .direction() with mode 'normal', in either order", () => {
      const box = block();
      const sk = above(20, () => {
        line([5, 5], [35, 5]);
      });
      const first = project(sk, asObject(box)).direction("z").mode("normal") as unknown as ProjectedCurve;
      const second = project(sk, asObject(box)).mode("normal").direction("z") as unknown as ProjectedCurve;
      render();

      for (const pc of [first, second]) {
        expect(pc.getError()).toMatch(/^project: \.direction\(\) is for mode 'direction'\./);
        expect(pc.getShapes()).toEqual([]);
      }
    });

    it("refuses a mode or a keep outside its set where the statement is written", () => {
      const box = block();
      const sk = above(20, () => {
        line([5, 5], [35, 5]);
      });
      const pc = project(sk, asObject(box));
      expect(() => pc.mode("sideways" as never)).toThrow("project: .mode() takes 'direction' or 'normal'.");
      expect(() => pc.keep("both" as never)).toThrow("project: .keep() takes 'nearest' or 'all'.");
      expect(() => pc.direction("up" as never)).toThrow(/direction: expected an axis/);
    });

    it("claims a select() given to .direction(), so a later bare fillet(2) does not take it", () => {
      const box = block();
      const sk = above(20, () => {
        line([5, 5], [35, 5]);
      });
      const upright = select(edge().verticalTo("xy").nearest("x").nearest("y")) as unknown as SelectSceneObject;
      expect(getCurrentScene().getLastSelection()).toBe(upright);

      const pc = project(sk, box.endFaces()).direction(upright) as unknown as ProjectedCurve;
      const rounded = fillet(2) as unknown as Fillet;

      expect(upright.isClaimed()).toBe(true);
      expect(rounded.targetEdges).not.toContain(upright);
      render();
      expect(pc.getError()).toBeNull();
      expect(wiresOf(pc).map(ends)).toEqual([[[5, 5, 5], [35, 5, 5]]]);
    });

    it("builds along a lazy accessor given to .direction()", () => {
      const box = block();
      const sk = sketch(plane("xy", { offset: 20, rotateX: 20 }), () => {
        line([5, 5], [35, 5]);
      });
      const pc = project(sk, box.endFaces()).direction(box.endFaces()) as unknown as ProjectedCurve;
      render();

      expect(pc.getError()).toBeNull();
      expect(bucketOf(pc).every(e => Math.abs(EdgeOps.getEdgeMidPoint(e).z - 5) < 1e-6)).toBe(true);
    });

    it("carries the operands, mode, direction and keep through createCopy, compareTo, getDependencies and serialize", () => {
      const box = block();
      const sk = above(20, () => {
        line([5, 5], [35, 5]);
      });
      const a = axis("y");
      const other = block(30);
      const top = asObject(box.endFaces());
      const make = () => project(sk, top) as unknown as ProjectedCurve;
      expectOptionsCarried<ProjectedCurve>(make, {
        mode: tool => tool.mode("normal"),
        direction: tool => tool.direction(a),
        keep: tool => tool.keep("all"),
        source: tool => { tool["source"][0] = asObject(other); },
        target: tool => { tool["target"].push(asObject(other)); },
      });
      expectOptionsCarried<ProjectedCurve>(make, {
        direction: tool => tool.direction("z"),
      });
      expect(make().getDependencies()).toEqual([sk, top]);
      expect(make().direction(a).getDependencies()).toEqual([sk, top, a]);
      expect(make().getType()).toBe("projected-curve");
      expect(make().mode("normal").keep("all").serialize()).toMatchObject({ mode: "normal", keep: "all", direction: null });
    });
  });

  describe("the operands", () => {
    it("hides the source sketch, which a later statement still reads, and leaves the target untouched", () => {
      const box = block();
      const sk = above(20, () => {
        line([5, 5], [35, 5]);
      });
      const pc = project(sk, asObject(box)) as unknown as ProjectedCurve;
      const again = project(sk, asObject(box)).keep("all") as unknown as ProjectedCurve;
      const scene = render();

      expect(pc.getError()).toBeNull();
      expect(again.getError()).toBeNull();
      expect(wiresOf(again)).toHaveLength(2);
      expectDisplayConsumed(scene, sk);
      expect(box.getShapes()).toHaveLength(1);
      expect(box.getShapes()[0].isSolid()).toBe(true);
      expect(box.getShapes(undefined, undefined, new Set(scene.getAllSceneObjects()))).toHaveLength(1);
    });

    it("takes a face selection's highlight off the display, its faces still readable", () => {
      const box = block();
      const top = asObject(select(face().planar().onPlane("xy", 5)));
      const sk = above(20, () => {
        line([5, 5], [35, 5]);
      });
      const pc = project(sk, top) as unknown as ProjectedCurve;
      const scene = render();

      expect(pc.getError()).toBeNull();
      expectDisplayConsumed(scene, top);
      expect(box.getShapes()).toHaveLength(1);
    });

    it("hides once a sweep runs along it, still readable", () => {
      const box = block();
      const sk = above(20, () => {
        line([5, 5], [35, 5]);
      });
      const pc = project(sk, box.endFaces()) as unknown as ProjectedCurve;
      const swept = asObject(sweep(pc, sketch("yz", () => {
        circle([5, 5], 1);
      })));
      const again = asObject(pc.edges(0));
      addToScene(again);
      const scene = render();

      expect(pc.getError()).toBeNull();
      expect(swept.getError()).toBeNull();
      expectDisplayConsumed(scene, asObject(pc));
      expect(again.getShapes()).toHaveLength(1);
    });

    it("refuses a solid as the source, and a sketch as the target, in the readers' words", () => {
      const box = block();
      const sk = above(20, () => {
        line([5, 5], [35, 5]);
      });
      const solidSource = project(asObject(box), box.endFaces()) as unknown as ProjectedCurve;
      const sketchTarget = project(sk, sk) as unknown as ProjectedCurve;
      render();

      expect(solidSource.getError()).toMatch(/^project: the source is a solid; pick the edges to use\./);
      expect(sketchTarget.getError()).toMatch(/^project: the target is a sketch; it needs faces\./);
    });

    it("asks for a source and a target when given fewer outside a sketch", () => {
      const box = block();
      expect(() => project(asObject(box))).toThrow(
        "project: outside a sketch, give the curves to project and the faces to project them onto: project(source, target).",
      );
      expect(() => partProjectArgs([])).toThrow(/give the curves to project/);
      expect(() => partProjectArgs([box, box, box])).toThrow(/takes two arguments, got 3/);
      expect(() => partProjectArgs([[], box])).toThrow("project: the source argument is an empty list; give it the curves to project.");
      expect(() => partProjectArgs([box, []])).toThrow("project: the target argument is an empty list; give it the faces to project onto.");
      expect(() => partProjectArgs([box, 3])).toThrow(
        "project: the target argument must be faces, a surface or a solid, or a list of them; got 3.",
      );
      expect(() => partProjectArgs(["xy", box])).toThrow(
        "project: the source argument must be curves — a sketch, a curve, a selection of edges — or a list of them; got 'xy'.",
      );
    });
  });

  describe("accessors", () => {
    it("answers edges(), edges(i), start() and end()", () => {
      const box = block();
      const sk = above(20, () => {
        line([35, 5], [5, 5]);
      });
      const pc = project(sk, box.endFaces()) as unknown as ProjectedCurve;
      const all = asObject(pc.edges());
      const first = asObject(pc.edges(0));
      addToScene(all);
      addToScene(first);
      const start = pc.start();
      const end = pc.end();
      render();

      expect(all.getShapes()).toEqual(bucketOf(pc));
      expect(first.getShapes()).toEqual([bucketOf(pc)[0]]);
      expect(at(start)).toEqual([35, 5, 5]);
      expect(at(end)).toEqual([5, 5, 5]);
    });
  });

  describe("repeat()", () => {
    it("repeats the curve with its edges bucket", () => {
      const box = block();
      const sk = above(20, () => {
        line([5, 5], [35, 5]);
      });
      const pc = project(sk, box.endFaces()) as unknown as ProjectedCurve;
      const r = repeat("linear", "y", { count: 2, offset: 50 }, pc) as unknown as RepeatBase;
      const copied = asObject(r.instance(1).edges(0));
      addToScene(copied);
      render();

      const [copy] = r.getInstanceRoots(1);
      expect(copy).toBeInstanceOf(ProjectedCurve);
      expect(copy.getError()).toBeNull();
      const bucket = copy.getState(ProjectedCurve.EDGES_KEY) as Edge[];
      expect(bucket.map(mid)).toEqual([[20, 55, 5]]);
      expect(copied.getShapes()).toEqual([bucket[0]]);
    });
  });

  describe("its row", () => {
    it("reads as what it makes in an unnamed row, while the sketch tool of its callee keeps its own name", () => {
      const box = block();
      const sk = above(20, () => {
        line([5, 5], [35, 5]);
      });
      const pc = project(sk, box.endFaces()) as unknown as ProjectedCurve;
      render();

      const labels = DefaultNames.labelsFor(getCurrentScene().getTimelineObjects());
      expect(pc.getDisplayType()).toBe("Projected Curve");
      expect(DefaultNames.labelFor(pc, labels)).toBe("Projected Curve 1");
      expect(Object.create(Projection.prototype).getDisplayType()).toBe("Projection");
    });
  });

  describe("the preview", () => {
    const ref = (line: number): GhostOperandRef => ({ kind: "statement", filePath: FILE, line });

    it("draws the curve as a wire from statements, the direction left out", () => {
      located(block(), 2);
      located(above(20, () => {
        line([5, 5], [35, 5]);
      }), 3);
      const scene = render();

      const result = buildFeatureGhost(scene, {
        feature: "projected-curve", source: [ref(3)], target: [ref(2)], mode: "direction", direction: null, keep: "nearest",
      }, DEFAULT_MESH_CONFIG);
      expect(result).toMatchObject({ ok: true, solids: [{ kind: "wire" }] });
    });

    it("takes a picked face, a world axis and keep 'all'", () => {
      const box = block();
      located(above(20, () => {
        line([5, 5], [35, 5]);
      }), 3);
      const scene = render() as Scene;
      const solid = asObject(box).getShapes()[0];
      const faces = Explorer.findFacesWrapped(solid);
      const top = faces.findIndex(f => Math.abs(ShapeMeasure.centerOfMass(f).z - 5) < 1e-6);
      faces.forEach(f => f.dispose());

      const picked = buildFeatureGhost(scene, {
        feature: "projected-curve",
        source: [ref(3)],
        target: [{ kind: "face", shapeId: solid.id, index: top }],
        mode: "direction",
        direction: { kind: "standard", axis: "z" },
        keep: "all",
      }, DEFAULT_MESH_CONFIG);
      expect(picked).toMatchObject({ ok: true, solids: [{ kind: "wire" }] });

      const along = buildFeatureGhost(scene, {
        feature: "projected-curve", source: [ref(3)], target: [ref(0)], mode: "direction", direction: null, keep: "nearest",
      }, DEFAULT_MESH_CONFIG);
      expect(along.ok).toBe(false);
    });

    it("says why the build refuses: a direction with mode 'normal', a projection that misses", () => {
      located(block(), 2);
      located(above(20, () => {
        line([50, 5], [70, 5]);
      }), 3);
      const scene = render();

      const normal = buildFeatureGhost(scene, {
        feature: "projected-curve", source: [ref(3)], target: [ref(2)], mode: "normal",
        direction: { kind: "standard", axis: "z" }, keep: "nearest",
      }, DEFAULT_MESH_CONFIG);
      expect(normal).toMatchObject({ ok: false, surface: true, reason: "project: .direction() is for mode 'direction'." });

      const misses = buildFeatureGhost(scene, {
        feature: "projected-curve", source: [ref(3)], target: [ref(2)], mode: "direction", direction: null, keep: "nearest",
      }, DEFAULT_MESH_CONFIG);
      expect(misses).toMatchObject({ ok: false, surface: true, reason: "project: the projection misses the target." });
    });

    it("reads the direction as the build does: a picked edge, a plane() and an origin plane", () => {
      const box = block();
      located(sketch(plane("xy", { offset: 20, rotateX: 20 }), () => {
        line([5, 5], [35, 5]);
      }), 3);
      located(plane("xy", 30), 4);
      const scene = render() as Scene;
      const solid = asObject(box).getShapes()[0];
      const edges = Explorer.findEdgesWrapped(solid);
      const upright = edges.findIndex(e => {
        const [a, b] = EdgeOps.endPoints(e);
        return Math.abs(a.x - b.x) < 1e-9 && Math.abs(a.y - b.y) < 1e-9;
      });
      const curved = edges.length;
      edges.forEach(e => e.dispose());
      const faces = Explorer.findFacesWrapped(solid);
      const top = faces.findIndex(f => Math.abs(ShapeMeasure.centerOfMass(f).z - 5) < 1e-6);
      faces.forEach(f => f.dispose());

      for (const direction of [
        { kind: "edge" as const, shapeId: solid.id, index: upright },
        { kind: "plane" as const, filePath: FILE, line: 4 },
        { kind: "standard-plane" as const, plane: "xy" as const },
        { kind: "face" as const, shapeId: solid.id, index: top },
      ]) {
        const result = buildFeatureGhost(scene, {
          feature: "projected-curve", source: [ref(3)], target: [{ kind: "face", shapeId: solid.id, index: top }],
          mode: "direction", direction, keep: "nearest",
        }, DEFAULT_MESH_CONFIG);
        expect(result).toMatchObject({ ok: true, solids: [{ kind: "wire" }] });
      }
      const stale = buildFeatureGhost(scene, {
        feature: "projected-curve", source: [ref(3)], target: [{ kind: "face", shapeId: solid.id, index: top }],
        mode: "direction", direction: { kind: "edge", shapeId: solid.id, index: curved }, keep: "nearest",
      }, DEFAULT_MESH_CONFIG);
      expect(stale.ok).toBe(false);
    });
  });

  describe("picks", () => {
    it("synthesizes a row's face picks, or its edge picks, as project(...) arguments, and refuses a mixed row", () => {
      const box = located(block(), 2);
      const scene = render();
      const solid = asObject(box).getShapes()[0];
      const faces = Explorer.findFacesWrapped(solid);
      const top = faces.findIndex(f => Math.abs(ShapeMeasure.centerOfMass(f).z - 5) < 1e-6);
      faces.forEach(f => f.dispose());

      const target = synthesizeApplyFeature(scene, [{ shapeId: solid.id, sub: { type: "face", index: top } }], "projected-curve");
      expect(target.ok).toBe(true);
      if (target.ok) {
        expect(target.preview).toBe(`project(${target.args})`);
        expect(target.spec.feature).toBe("projected-curve");
        expect(target.spec.value).toBeUndefined();
      }
      const source = synthesizeApplyFeature(scene, [{ shapeId: solid.id, sub: { type: "edge", index: 0 } }], "projected-curve");
      expect(source.ok).toBe(true);

      const mixed = synthesizeApplyFeature(scene, [
        { shapeId: solid.id, sub: { type: "edge", index: 0 } },
        { shapeId: solid.id, sub: { type: "face", index: top } },
      ], "projected-curve");
      expect(mixed).toMatchObject({
        ok: false, reason: "project takes edges for its curves and faces for its target — pick one kind per row",
      });
    });

    it("names a pick on the curve through the curve's own variable, pc", () => {
      const box = block();
      const sk = above(20, () => {
        line([5, 5], [35, 5]);
      });
      const pc = located(project(sk, box.endFaces()), 6);
      const scene = render();
      const wire = asObject(pc).getShapes()[0];

      const result = synthesizeApplyFeature(scene, [{ shapeId: wire.id, sub: { type: "edge", index: 0 } }], "sweep");
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.spec.producers.map(producer => producer.nameHint)).toEqual(["pc"]);
        expect(result.args).toMatch(/^pc\.edges\(/);
      }
    });
  });

  describe("inside a sketch", () => {
    it("still projects onto the sketch plane", () => {
      const box = block();
      const s = sketch(plane("xy", 20), () => {
        project(box.endFaces());
      }) as unknown as Sketch;
      render();

      const projected = s.getChildren().filter(child => child instanceof Projection);
      expect(projected).toHaveLength(1);
      expect(s.getChildren().some(child => child instanceof ProjectedCurve)).toBe(false);
      expect(projected[0].getError()).toBeNull();
      // The top face's outline, on the sketch plane.
      const edges = projected[0].getShapes().filter(shape => shape instanceof Edge) as Edge[];
      expect(edges).toHaveLength(4);
      expect(edges.every(e => Math.abs(EdgeOps.getEdgeMidPoint(e).z - 20) < 1e-6)).toBe(true);
    });
  });
});

