import { describe, it, expect } from "vitest";
import { setupOC, render, addToScene, expectDisplayConsumed } from "../setup.js";
import sketch from "../../core/sketch.js";
import extrude from "../../core/extrude.js";
import cylinder from "../../core/cylinder.js";
import rotate from "../../core/rotate.js";
import translate from "../../core/translate.js";
import select from "../../core/select.js";
import sweep from "../../core/sweep.js";
import repeat from "../../core/repeat.js";
import plane from "../../core/plane.js";
import { circle, intersect } from "../../core/2d/index.js";
import { face } from "../../filters/index.js";
import { partIntersectArgs } from "../../core/2d/intersect.js";
import { getOC } from "../../oc/init.js";
import { Convert } from "../../oc/convert.js";
import { SheetOps } from "../../oc/sheet-ops.js";
import { CurveClassifier } from "../../oc/curve-classifier.js";
import { EdgeOps } from "../../oc/edge-ops.js";
import { DEFAULT_MESH_CONFIG } from "../../oc/mesh.js";
import { SceneObject } from "../../common/scene-object.js";
import { Edge } from "../../common/edge.js";
import { Wire } from "../../common/wire.js";
import { Sheet } from "../../common/sheet.js";
import { Face } from "../../common/face.js";
import { Plane } from "../../math/plane.js";
import { Point } from "../../math/point.js";
import { IntersectionCurve } from "../../features/intersection-curve.js";
import { Extrude } from "../../features/extrude.js";
import { Intersect } from "../../features/2d/intersect.js";
import { Sketch } from "../../features/2d/sketch.js";
import { RepeatBase } from "../../features/repeat-base.js";
import { PointResolver } from "../../features/point-resolver.js";
import { LazyVertex } from "../../features/lazy-vertex.js";
import { buildFeatureGhost, type GhostOperandRef } from "../../rendering/feature-ghost.js";
import type { Scene } from "../../rendering/scene.js";
import { synthesizeApplyFeature } from "../../selection/explain.js";
import { Explorer } from "../../oc/explorer.js";
import { testRect } from "../helpers/profiles.js";
import { getSceneManager, getCurrentScene } from "../../scene-manager.js";
import { DefaultNames } from "../../rendering/default-names.js";
import { TestSheets } from "../helpers/sheets.js";
import { useLoadedBodies, loadShapes } from "../helpers/loaded-bodies.js";
import { expectOptionsCarried } from "../helpers/option-contract.js";

const FILE = "/tmp/intersection-curve-test.fluid.js";

const asObject = (value: unknown) => value as SceneObject;
const round = (value: number) => +value.toFixed(4) + 0;
const xyz = (point: Point) => [point.x, point.y, point.z].map(round);
const mid = (edge: Edge) => xyz(EdgeOps.getEdgeMidPoint(edge));
const at = (vertex: LazyVertex) => xyz(PointResolver.toWorld(vertex));

/** The curve's wires, as the scene holds them. */
const wiresOf = (ic: unknown) => asObject(ic).getShapes() as Wire[];
/** Every edge of the result, in the order `edges()` lists them. */
const bucketOf = (ic: unknown) => asObject(ic).getState(IntersectionCurve.EDGES_KEY) as Edge[];
const closed = (wire: Wire) => wire.getFirstPoint()!.distanceTo(wire.getLastPoint()!) < 1e-6;

/** A planar sheet on `plane`, over [u0, u1] × [v0, v1] of its own axes, loaded the way an imported surface is. */
function sheetOn(plane: Plane, u: [number, number], v: [number, number]): SceneObject {
  return asObject(loadShapes([planarSheet(plane, u, v)]));
}

function planarSheet(plane: Plane, u: [number, number], v: [number, number]): Sheet {
  const oc = getOC();
  const [pln, disposePln] = Convert.toGpPln(plane);
  const maker = new oc.BRepBuilderAPI_MakeFace(pln, u[0], u[1], v[0], v[1]);
  const raw = maker.Face();
  try {
    return SheetOps.fromRawFace(raw);
  } finally {
    raw.delete();
    maker.delete();
    disposePln();
  }
}

/** One planar face on `plane` over [u0, u1] × [v0, v1] of its own axes. */
function planarFace(plane: Plane, u: [number, number], v: [number, number]): Face {
  const sheet = planarSheet(plane, u, v);
  try {
    return Face.fromTopoDSFace(getOC().TopoDS.Face(sheet.getFaces()[0].getShape()));
  } finally {
    sheet.dispose();
  }
}

/** XY tilted 30° about its own X, through (0, 0, 10): what `plane('xy', { offset: 10, rotateX: 30 })` builds. */
function slopedPlane(): Plane {
  const xy = Plane.XY();
  return xy.applyMatrix(xy.getTransformMatrix({ offset: 10, rotateX: 30 }));
}

/** A Ø10 cylinder on XY, 20 tall: a circle extruded. */
function tube(): Extrude {
  sketch("xy", () => {
    circle([0, 0], 10);
  });
  return extrude(20).new() as unknown as Extrude;
}

/** A 20 × 10 × 5 block on XY from the origin. */
function block(width = 20): Extrude {
  sketch("xy", () => {
    testRect(width, 10);
  });
  return extrude(5).new() as unknown as Extrude;
}

/** A horizontal sheet through the block at z = 2.5, overhanging it on every side. */
function slab(): SceneObject {
  return sheetOn(new Plane(new Point(0, 0, 2.5), Plane.XY().xDirection, Plane.XY().normal), [-5, 35], [-5, 15]);
}

function located<T>(value: T, line: number): T {
  asObject(value).setSourceLocation({ filePath: FILE, line, column: 0 });
  return value;
}

describe("intersect(first, second) outside a sketch", () => {
  setupOC();
  useLoadedBodies();

  describe("the curve", () => {
    it("is one closed circle where a cylinder wall meets a square plane", () => {
      const wall = tube();
      const flat = sheetOn(new Plane(new Point(0, 0, 10), Plane.XY().xDirection, Plane.XY().normal), [-20, 20], [-20, 20]);
      const ic = intersect(wall.sideFaces(), flat) as unknown as IntersectionCurve;
      render();

      expect(ic.getError()).toBeNull();
      const wires = wiresOf(ic);
      expect(wires).toHaveLength(1);
      expect(closed(wires[0])).toBe(true);
      const edges = bucketOf(ic);
      expect(edges).toHaveLength(1);
      const cls = CurveClassifier.classify(edges[0]);
      expect(cls.kind).toBe("circle");
      expect(cls.radius).toBeCloseTo(5, 6);
      expect(cls.center!.z).toBeCloseTo(10, 6);
    });

    it("is one closed ellipse where a cylinder wall meets a sloped plane", () => {
      const wall = tube();
      const sloped = sheetOn(slopedPlane(), [-20, 20], [-20, 20]);
      const ic = intersect(wall.sideFaces(), sloped) as unknown as IntersectionCurve;
      render();

      expect(ic.getError()).toBeNull();
      const wires = wiresOf(ic);
      expect(wires).toHaveLength(1);
      expect(closed(wires[0])).toBe(true);
      const cls = CurveClassifier.classify(bucketOf(ic)[0]);
      expect(cls.kind).toBe("ellipse");
      expect(cls.minorRadius).toBeCloseTo(5, 6);
      expect(cls.majorRadius).toBeCloseTo(5 / Math.cos(Math.PI / 6), 6);
    });

    it("is two closed curves where two cylinders cross", () => {
      const upright = cylinder(5, 20);
      const across = translate(0, 20, 10, rotate("x", 90, cylinder(3, 40) as any) as any);
      const ic = intersect(asObject(upright), asObject(across)) as unknown as IntersectionCurve;
      render();

      expect(ic.getError()).toBeNull();
      const wires = wiresOf(ic);
      expect(wires).toHaveLength(2);
      expect(wires.every(closed)).toBe(true);
    });

    it("is one closed wire of four edges, one per face crossed, where a surface runs through a box", () => {
      const box = block();
      const ic = intersect(box, slab()) as unknown as IntersectionCurve;
      render();

      expect(ic.getError()).toBeNull();
      const wires = wiresOf(ic);
      expect(wires).toHaveLength(1);
      expect(closed(wires[0])).toBe(true);
      // Starts on the edge with the smallest midpoint (x = 0), from its
      // smaller end, and walks on round the box.
      expect(bucketOf(ic).map(mid)).toEqual([
        [0, 5, 2.5],
        [10, 10, 2.5],
        [20, 5, 2.5],
        [10, 0, 2.5],
      ]);
      expect(xyz(bucketOf(ic)[0].getFirstPoint())).toEqual([0, 0, 2.5]);
    });

    it("is an open wire between two surfaces, ending on the rim of each", () => {
      const floor = asObject(loadShapes([TestSheets.plate(20, 10)]));
      const wall = sheetOn(new Plane(new Point(10, 0, 0), Plane.YZ().xDirection, Plane.YZ().normal), [-5, 5], [-5, 5]);
      const ic = intersect(floor, wall) as unknown as IntersectionCurve;
      render();

      expect(ic.getError()).toBeNull();
      const wires = wiresOf(ic);
      expect(wires).toHaveLength(1);
      expect(closed(wires[0])).toBe(false);
      // From the floor's rim (y = 0) to the wall's (y = 5), the smaller end first.
      expect(xyz(wires[0].getFirstPoint()!)).toEqual([10, 0, 0]);
      expect(xyz(wires[0].getLastPoint()!)).toEqual([10, 5, 0]);
    });

    it("is the same for a whole solid as for all its faces", () => {
      const box = block();
      const whole = intersect(box, slab()) as unknown as IntersectionCurve;
      const faces = intersect(
        [box.startFaces(), box.endFaces(), box.sideFaces()],
        slab(),
      ) as unknown as IntersectionCurve;
      render();

      expect(whole.getError()).toBeNull();
      expect(faces.getError()).toBeNull();
      expect(bucketOf(faces).map(mid)).toEqual(bucketOf(whole).map(mid));
    });

    it("reads a face named twice, by its body and by a selection, once", () => {
      const box = block();
      const whole = intersect(box, slab()) as unknown as IntersectionCurve;
      const twice = intersect([box, box.sideFaces()], slab()) as unknown as IntersectionCurve;
      render();

      expect(twice.getError()).toBeNull();
      expect(bucketOf(twice).map(mid)).toEqual(bucketOf(whole).map(mid));
    });

    it("takes a plane() as its second operand, as the face lying in it", () => {
      const wall = tube();
      const byFace = intersect(wall.sideFaces(), sheetOn(slopedPlane(), [-20, 20], [-20, 20])) as unknown as IntersectionCurve;
      const byPlane = intersect(wall.sideFaces(), plane("xy", { offset: 10, rotateX: 30 })) as unknown as IntersectionCurve;
      render();

      expect(byPlane.getError()).toBeNull();
      const [a] = bucketOf(byFace);
      const [b] = bucketOf(byPlane);
      expect(bucketOf(byPlane)).toHaveLength(1);
      expect(CurveClassifier.classify(b).kind).toBe("ellipse");
      expect(CurveClassifier.classify(b).majorRadius).toBeCloseTo(CurveClassifier.classify(a).majorRadius!, 6);
      expect(mid(b)).toEqual(mid(a));
    });

    it("runs along the edges of a box a plane passes through", () => {
      sketch("xy", () => {
        testRect(10, 10, { at: [-5, -5] });
      });
      const box = extrude(10).new();
      // The plane through the Z axis at 45°: it holds two opposite vertical edges.
      const ic = intersect(box, plane("xz", { rotateY: 45 })) as unknown as IntersectionCurve;
      render();

      expect(ic.getError()).toBeNull();
      expect(wiresOf(ic)).toHaveLength(1);
      expect(bucketOf(ic).map(mid)).toEqual([[-5, -5, 5], [0, 0, 10], [5, 5, 5], [0, 0, 0]]);
    });

    it("lies on both sides", () => {
      const wall = tube();
      const sloped = sheetOn(slopedPlane(), [-20, 20], [-20, 20]);
      const ic = intersect(wall.sideFaces(), sloped) as unknown as IntersectionCurve;
      render();

      const oc = getOC();
      const [edge] = bucketOf(ic);
      const adaptor = new oc.BRepAdaptor_Curve(edge.getShape() as any);
      const normal = slopedPlane().normal;
      try {
        for (let i = 0; i <= 16; i++) {
          const t = adaptor.FirstParameter() + (adaptor.LastParameter() - adaptor.FirstParameter()) * i / 16;
          const p = adaptor.Value(t);
          const point = new Point(p.X(), p.Y(), p.Z());
          p.delete();
          // On the cylinder wall: 5 from the Z axis.
          expect(Math.hypot(point.x, point.y)).toBeCloseTo(5, 5);
          // On the sloped plane through (0, 0, 10).
          const d = (point.x - 0) * normal.x + (point.y - 0) * normal.y + (point.z - 10) * normal.z;
          expect(Math.abs(d)).toBeLessThan(1e-5);
        }
      } finally {
        adaptor.delete();
      }
    });
  });

  describe("order", () => {
    /** The model built again from scratch, as a re-render of the file does. */
    const fresh = () => {
      getSceneManager().startScene();
      getSceneManager().setCurrentFile("");
    };

    it("lists the same edges in the same order when built twice", () => {
      const build = () => {
        fresh();
        // Two cylinders crossing at x = 50, clear of a block a surface runs through.
        const upright = translate(50, 0, 0, cylinder(5, 20) as any);
        const across = translate(50, 20, 10, rotate("x", 90, cylinder(3, 40) as any) as any);
        const ic = intersect([asObject(upright), block()], [asObject(across), slab()]);
        render();
        expect(asObject(ic).getError()).toBeNull();
        return {
          wires: wiresOf(ic).map(wire => wire.getEdges().length),
          edges: bucketOf(ic).map(edge => [mid(edge), xyz(edge.getFirstPoint()), xyz(edge.getLastPoint())]),
        };
      };
      const first = build();
      // The cylinder's loops first: its faces come first on the first side.
      expect(first.wires).toEqual([1, 1, 4]);
      expect(build()).toEqual(first);
    });

    it("keeps edges(1) on the same face after an upstream dimension changes", () => {
      const pick = (width: number) => {
        fresh();
        const box = block(width);
        const ic = intersect(box, slab()) as unknown as IntersectionCurve;
        const second = asObject(ic.edges(1));
        addToScene(second);
        render();
        return (second.getShapes() as Edge[]).map(mid);
      };
      // The top face's edge, y = 10, whatever the box's width.
      expect(pick(20)).toEqual([[10, 10, 2.5]]);
      expect(pick(30)).toEqual([[15, 10, 2.5]]);
    });
  });

  describe("refusals", () => {
    it("says the selections do not cross where two blocks only touch", () => {
      const lower = block();
      sketch("xy", () => {
        testRect(20, 10);
      });
      const upper = translate(0, 0, 5, extrude(5).new() as any);
      const ic = intersect(lower, asObject(upper)) as unknown as IntersectionCurve;
      render();

      expect(ic.getError()).toBe(
        "intersect: the two selections do not cross.\n"
        + "Hint: Faces that only touch along an edge, or lie on top of each other, have no intersection curve.",
      );
      expect(ic.getShapes()).toEqual([]);
    });

    it("says the selections do not cross where two blocks meet along an edge", () => {
      const lower = block();
      sketch("xy", () => {
        testRect(20, 10);
      });
      const corner = translate(20, 10, 0, extrude(5).new() as any);
      const ic = intersect(lower, asObject(corner)) as unknown as IntersectionCurve;
      render();

      expect(ic.getError()).toMatch(/^intersect: the two selections do not cross\./);
    });

    it("says the selections do not cross where a cylinder only grazes a face", () => {
      const box = block();
      const grazing = translate(25, 5, 0, cylinder(5, 5) as any);
      const ic = intersect(box, asObject(grazing)) as unknown as IntersectionCurve;
      render();

      expect(ic.getError()).toMatch(/^intersect: the two selections do not cross\./);
    });

    it("refuses curves that branch, where two equal cylinders cross, naming the point", () => {
      const upright = translate(0, 0, -20, cylinder(5, 40) as any);
      const across = translate(0, 20, 0, rotate("x", 90, cylinder(5, 40) as any) as any);
      const ic = intersect(asObject(upright), asObject(across)) as unknown as IntersectionCurve;
      render();

      expect(ic.getError()).toMatch(/^intersect: the intersection branches at \(-?5, 0, 0\): 4 of its edges meet there\./);
    });

    it("refuses a curve that breaks off inside both selections, where a surface lies partly on a face", () => {
      const box = block();
      // An L of two faces: one lying on the box's top (z = 5) for x ∈ [5, 10],
      // one going down through the box at x = 10. Where the first lies on the
      // top the sides only touch; the second crosses, and its curve ends
      // where the touching begins, on no rim.
      const onTop = planarFace(new Plane(new Point(0, 0, 5), Plane.XY().xDirection, Plane.XY().normal), [5, 10], [-5, 15]);
      const down = planarFace(new Plane(new Point(10, 0, 0), Plane.YZ().xDirection, Plane.YZ().normal), [-5, 15], [-5, 5]);
      const sheets = SheetOps.sew([onTop, down]);
      onTop.dispose();
      down.dispose();
      expect(sheets).toHaveLength(1);
      const ell = asObject(loadShapes(sheets));
      const ic = intersect(box, ell) as unknown as IntersectionCurve;
      render();

      expect(ic.getError()).toMatch(/^intersect: the intersection breaks off at \(10, (0|10), 5\), inside both selections\./);
    });

    it("refuses a face in both selections, naming it", () => {
      const wall = tube();
      const ic = intersect(wall.sideFaces(), [wall.sideFaces(), wall.endFaces()]) as unknown as IntersectionCurve;
      render();

      expect(ic.getError()).toMatch(/^intersect: the cylindrical face at \(0, 0, 10\) is in both selections\./);
    });

    it("refuses edges in the words of a face reader", () => {
      const box = block();
      const ic = intersect(box.sideEdges(), slab()) as unknown as IntersectionCurve;
      render();

      expect(ic.getError()).toMatch(/^intersect: the first selection is an edge selection; it needs faces\./);
    });

    it("refuses a plane anywhere but alone in the second place", () => {
      const box = block();
      const ic = intersect(plane("xy", 2), box) as unknown as IntersectionCurve;
      render();

      expect(ic.getError()).toMatch(/^intersect: a plane can only be the second argument, given on its own\./);
    });

    it("asks for two sides when given fewer outside a sketch", () => {
      const box = block();
      expect(() => intersect(box)).toThrow(
        "intersect: outside a sketch, give the two sets of faces to intersect: intersect(first, second).",
      );
      expect(() => partIntersectArgs([])).toThrow(/give the two sets of faces/);
      expect(() => partIntersectArgs([box, box, box])).toThrow(/takes two arguments, got 3/);
      expect(() => partIntersectArgs([[], box])).toThrow(/the first argument is an empty list/);
      expect(() => partIntersectArgs([box, 3])).toThrow(/the second argument must be faces, a surface or a solid, or a list of them; got 3/);
    });
  });

  describe("accessors", () => {
    it("answers edges(), edges(i), start() and end()", () => {
      const floor = asObject(loadShapes([TestSheets.plate(20, 10)]));
      const wall = sheetOn(new Plane(new Point(10, 0, 0), Plane.YZ().xDirection, Plane.YZ().normal), [-5, 5], [-5, 5]);
      const ic = intersect(floor, wall) as unknown as IntersectionCurve;
      const all = asObject(ic.edges());
      const first = asObject(ic.edges(0));
      addToScene(all);
      addToScene(first);
      const start = ic.start();
      const end = ic.end();
      render();

      expect(all.getShapes()).toEqual(bucketOf(ic));
      expect(first.getShapes()).toEqual([bucketOf(ic)[0]]);
      expect(at(start)).toEqual([10, 0, 0]);
      expect(at(end)).toEqual([10, 5, 0]);
    });
  });

  describe("as an operand", () => {
    it("leaves its operands in the scene, and hides once a sweep runs along it, still readable", () => {
      const floor = asObject(loadShapes([TestSheets.plate(20, 10)]));
      const wall = sheetOn(new Plane(new Point(10, 0, 0), Plane.YZ().xDirection, Plane.YZ().normal), [-5, 5], [-5, 5]);
      const ic = intersect(floor, wall) as unknown as IntersectionCurve;
      const swept = asObject(sweep(ic, sketch("xz", () => {
        circle([10, 0], 1);
      })));
      const again = asObject(ic.edges(0));
      addToScene(again);
      const scene = render();

      expect(ic.getError()).toBeNull();
      expect(swept.getError()).toBeNull();
      expect(swept.getShapes().some(shape => shape.isSolid())).toBe(true);
      expect(floor.getShapes()).toHaveLength(1);
      expect(wall.getShapes()).toHaveLength(1);
      expectDisplayConsumed(scene, asObject(ic));
      expect(again.getShapes()).toHaveLength(1);
    });

    it("takes a face selection's highlight off the display, its faces still readable", () => {
      const wall = tube();
      const side = asObject(select(face().cylinder()));
      const ic = intersect(side, plane("xy", 10)) as unknown as IntersectionCurve;
      const scene = render();

      expect(ic.getError()).toBeNull();
      expectDisplayConsumed(scene, side);
      expect(wall.getShapes()).toHaveLength(1);
    });
  });

  describe("repeat()", () => {
    it("repeats the curve with its edges bucket", () => {
      const box = block();
      const ic = intersect(box, slab()) as unknown as IntersectionCurve;
      const r = repeat("linear", "x", { count: 2, offset: 50 }, ic) as unknown as RepeatBase;
      const copied = asObject(r.instance(1).edges(1));
      addToScene(copied);
      render();

      const [copy] = r.getInstanceRoots(1);
      expect(copy).toBeInstanceOf(IntersectionCurve);
      expect(copy.getError()).toBeNull();
      const bucket = copy.getState(IntersectionCurve.EDGES_KEY) as Edge[];
      expect(bucket.map(mid)).toEqual([[50, 5, 2.5], [60, 10, 2.5], [70, 5, 2.5], [60, 0, 2.5]]);
      expect(copied.getShapes()).toEqual([bucket[1]]);
    });
  });

  describe("the contract", () => {
    it("carries both operand lists through createCopy, compareTo, getDependencies and serialize", () => {
      const box = block();
      const other = block(30);
      const surface = slab();
      const side = asObject(box.sideFaces());
      const make = () => new IntersectionCurve([side], [surface]);
      expectOptionsCarried<IntersectionCurve>(make, {
        first: tool => { tool["first"][0] = other; },
        second: tool => { tool["second"].push(other); },
      });
      expect(make().getDependencies()).toEqual([side, surface]);
      expect(make().getType()).toBe("intersection-curve");
    });

    it("reads as the tool's name in an unnamed row, as the sketch tool of its callee does", () => {
      const box = block();
      const ic = intersect(box, slab()) as unknown as IntersectionCurve;
      render();

      const labels = DefaultNames.labelsFor(getCurrentScene().getTimelineObjects());
      expect(ic.getDisplayType()).toBe("Intersect");
      expect(DefaultNames.labelFor(ic, labels)).toBe("Intersect 1");
      expect(Object.create(Intersect.prototype).getDisplayType()).toBe("Intersect");
    });
  });

  describe("the preview", () => {
    it("draws the curve as a wire", () => {
      located(block(), 2);
      located(slab(), 3);
      const scene = render();

      const ref = (line: number): GhostOperandRef => ({ kind: "statement", filePath: FILE, line });
      const result = buildFeatureGhost(scene, {
        feature: "intersection-curve", first: [ref(2)], second: [ref(3)],
      }, DEFAULT_MESH_CONFIG);
      expect(result.ok).toBe(true);
      if (!result.ok) {
        return;
      }
      expect(result.solids).toHaveLength(1);
      expect(result.solids[0].kind).toBe("wire");
    });

    it("takes a face selection statement on the first row and a plane() alone on the second", () => {
      tube();
      located(select(face().cylinder()), 2);
      located(plane("xy", 10), 3);
      const scene = render();

      const ref = (line: number): GhostOperandRef => ({ kind: "statement", filePath: FILE, line });
      const result = buildFeatureGhost(scene, {
        feature: "intersection-curve", first: [ref(2)], second: [ref(3)],
      }, DEFAULT_MESH_CONFIG);
      expect(result).toMatchObject({ ok: true, solids: [{ kind: "wire" }] });
    });

    it("takes picked faces, and says when the picks do not cross", () => {
      const box = block();
      const scene = render() as Scene;
      const solid = asObject(box).getShapes()[0];

      const crossing = buildFeatureGhost(scene, {
        feature: "intersection-curve",
        first: [{ kind: "face", shapeId: solid.id, index: 0 }],
        second: [{ kind: "face", shapeId: solid.id, index: 0 }],
      }, DEFAULT_MESH_CONFIG);
      expect(crossing).toMatchObject({ ok: false, surface: true });
      expect("reason" in crossing ? crossing.reason : "").toMatch(/is in both selections/);

      const stale = buildFeatureGhost(scene, {
        feature: "intersection-curve",
        first: [{ kind: "face", shapeId: "gone", index: 0 }],
        second: [{ kind: "face", shapeId: solid.id, index: 1 }],
      }, DEFAULT_MESH_CONFIG);
      expect(stale.ok).toBe(false);
    });
  });

  describe("picks", () => {
    it("synthesizes a side's face picks as intersect(...) arguments, binding the solid as ic's operand", () => {
      const box = located(block(), 2);
      const scene = render();
      const solid = asObject(box).getShapes()[0];
      const top = Explorer.findFacesWrapped(solid).findIndex(f => Math.abs(EdgeOps.getEdgeMidPoint(f.getEdges()[0]).z - 5) < 1e-6);

      const result = synthesizeApplyFeature(scene, [{ shapeId: solid.id, sub: { type: "face", index: top } }], "intersection-curve");
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.preview).toBe(`intersect(${result.args})`);
        expect(result.spec.feature).toBe("intersection-curve");
        expect(result.spec.value).toBeUndefined();
        expect(result.spec.parts).toHaveLength(1);
      }
    });

    it("names a pick on the curve through the curve's own variable, ic", () => {
      const box = block();
      const ic = located(intersect(box, slab()), 4);
      const scene = render();
      const wire = asObject(ic).getShapes()[0];

      const result = synthesizeApplyFeature(scene, [{ shapeId: wire.id, sub: { type: "edge", index: 0 } }], "sweep");
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.spec.producers.map(producer => producer.nameHint)).toEqual(["ic"]);
        expect(result.args).toMatch(/^ic\.edges\(/);
      }
    });

    it("refuses an edge pick", () => {
      const box = block();
      const scene = render();
      const solid = asObject(box).getShapes()[0];

      const result = synthesizeApplyFeature(scene, [{ shapeId: solid.id, sub: { type: "edge", index: 0 } }], "intersection-curve");
      expect(result).toMatchObject({ ok: false, reason: "intersect takes faces — pick faces only" });
    });
  });

  describe("inside a sketch", () => {
    it("still sections its arguments with the sketch plane", () => {
      const box = block();
      const s = sketch("xy", () => {
        intersect(box);
      }) as unknown as Sketch;
      render();

      const sectioned = s.getChildren().filter(child => child instanceof Intersect);
      expect(sectioned).toHaveLength(1);
      expect(sectioned[0]).not.toBeInstanceOf(IntersectionCurve);
      expect(sectioned[0].getError()).toBeNull();
      expect(s.getShapes().length).toBeGreaterThan(0);
    });
  });
});
