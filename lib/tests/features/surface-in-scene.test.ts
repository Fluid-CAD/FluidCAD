import { describe, it, expect } from "vitest";
import { setupOC, render } from "../setup.js";
import sketch from "../../core/sketch.js";
import extrude from "../../core/extrude.js";
import cut from "../../core/cut.js";
import select from "../../core/select.js";
import translate from "../../core/translate.js";
import rotate from "../../core/rotate.js";
import mirror from "../../core/mirror.js";
import copy from "../../core/copy.js";
import repeat from "../../core/repeat.js";
import remove from "../../core/remove.js";
import color from "../../core/color.js";
import fuse from "../../core/fuse.js";
import common from "../../core/common.js";
import subtract from "../../core/subtract.js";
import fillet from "../../core/fillet.js";
import chamfer from "../../core/chamfer.js";
import shell from "../../core/shell.js";
import draft from "../../core/draft.js";
import split from "../../core/split.js";
import plane from "../../core/plane.js";
import axis from "../../core/axis.js";
import connector from "../../core/connector.js";
import helix from "../../core/helix.js";
import sweep from "../../core/sweep.js";
import part from "../../core/part.js";
import { circle, intersect, project } from "../../core/2d/index.js";
import { edge, face } from "../../filters/index.js";
import { SceneObject } from "../../common/scene-object.js";
import { Shape } from "../../common/shape.js";
import { Sheet } from "../../common/sheet.js";
import { Solid } from "../../common/solid.js";
import type { BodyShape } from "../../common/body-shape.js";
import { ShapeOps } from "../../oc/shape-ops.js";
import { heldBodiesOf, liveBodiesOf } from "../../helpers/live-solids.js";
import { TestSheets } from "../helpers/sheets.js";
import { TestCurves } from "../helpers/curves.js";
import { testRect } from "../helpers/profiles.js";
import { useLoadedBodies, loadShapes } from "../helpers/loaded-bodies.js";
import { buildFeatureGhost, type FeatureGhostRequest, type FeatureGhostResult } from "../../rendering/feature-ghost.js";
import { DEFAULT_MESH_CONFIG } from "../../oc/mesh.js";
import type { Scene } from "../../rendering/scene.js";

const asObject = (value: unknown) => value as SceneObject;

/** A 20 × 20 × 10 block at x ∈ [100, 120], away from the loaded shapes near the origin. */
function block(): SceneObject {
  sketch("xy", () => {
    testRect(20, 20, { at: [100, 0] });
  });
  return asObject(extrude(10));
}

/** A 10 × 10 plate on XY from the origin, loaded the way an imported surface is. */
function plate(): SceneObject {
  return asObject(loadShapes([TestSheets.plate(10, 10)]));
}

/** Every body the scene's objects hold at the end, in scene order. */
function bodiesIn(scene: ReturnType<typeof render>): Shape[] {
  return heldBodiesOf(scene.getSceneObjects()).map(({ body }) => body);
}

const surfacesIn = (scene: ReturnType<typeof render>) => bodiesIn(scene).filter(body => body instanceof Sheet);
const solidsIn = (scene: ReturnType<typeof render>) => bodiesIn(scene).filter(body => body instanceof Solid);
const center = (shape: Shape) => {
  const box = ShapeOps.getBoundingBox(shape);
  return [box.centerX, box.centerY, box.centerZ];
};

describe("surfaces and curves in an existing model", () => {
  setupOC();
  useLoadedBodies();

  describe("translate", () => {
    it("moves a named surface, and a named curve", () => {
      const l = plate();
      const curve = asObject(loadShapes([TestCurves.threeEdges()]));
      const t = asObject(translate(0, 0, 5, l, curve));
      render();

      expect(t.getError()).toBeNull();
      const moved = t.getShapes();
      expect(moved.map(shape => shape.getType()).sort()).toEqual(["surface", "wire"]);
      for (const shape of moved) {
        expect(center(shape)[2]).toBeCloseTo(5, 6);
      }
      expect(l.getShapes()).toEqual([]);
      expect(curve.getShapes()).toEqual([]);
    });

    it("without targets moves every body, surfaces included, and leaves curves", () => {
      const e = block();
      const l = plate();
      const curve = asObject(loadShapes([TestCurves.threeEdges()]));
      const t = asObject(translate(0, 0, 5));
      render();

      expect(t.getError()).toBeNull();
      expect(t.getShapes().map(shape => shape.getType()).sort()).toEqual(["solid", "surface"]);
      expect(e.getShapes()).toEqual([]);
      expect(l.getShapes()).toEqual([]);
      expect(curve.getShapes().length).toBe(1);
    });

    it("refuses a face selection as a target", () => {
      block();
      const t = asObject(translate(0, 0, 5, select(face().onPlane("xy", 10))));
      render();

      expect(t.getError()).toContain("translate: target 1 is a face selection; translate works on solids or surfaces or curves.");
    });
  });

  describe("rotate", () => {
    it("turns a named surface with the same rule as translate", () => {
      const l = plate();
      const r = asObject(rotate("z", 90, l));
      render();

      expect(r.getError()).toBeNull();
      const [turned] = r.getShapes();
      expect(turned).toBeInstanceOf(Sheet);
      const [x, y] = center(turned);
      expect(x).toBeCloseTo(-5, 6);
      expect(y).toBeCloseTo(5, 6);
    });

    it("without targets turns bodies only: a sketch stays where it was", () => {
      const s = asObject(sketch("xy", () => {
        circle([200, 0], 10);
      }));
      plate();
      const r = asObject(rotate("z", 90));
      render();

      expect(r.getError()).toBeNull();
      expect(r.getShapes().map(shape => shape.getType())).toEqual(["surface"]);
      expect(s.getShapes().length).toBe(1);
      expect(center(s.getShapes()[0])[0]).toBeCloseTo(200, 6);
    });
  });

  describe("mirror", () => {
    it("reflects a named surface as a body of its own and keeps the original", () => {
      block();
      const l = plate();
      const m = asObject(mirror("yz", l));
      const scene = render();

      expect(m.getError()).toBeNull();
      const [image] = m.getShapes();
      expect(image).toBeInstanceOf(Sheet);
      expect(center(image)[0]).toBeCloseTo(-5, 6);
      expect(l.getShapes().length).toBe(1);
      expect(surfacesIn(scene).length).toBe(2);
      // The block is not fused with anything: a surface image has no material to join.
      expect(solidsIn(scene).length).toBe(1);
    });

    it("reflects a named curve", () => {
      const curve = asObject(loadShapes([TestCurves.threeEdges()]));
      const m = asObject(mirror("yz", curve));
      render();

      expect(m.getError()).toBeNull();
      expect(m.getShapes().map(shape => shape.getType())).toEqual(["wire"]);
      expect(center(m.getShapes()[0])[0]).toBeCloseTo(-10, 6);
    });
  });

  it("copy clones a surface", () => {
    const l = plate();
    const c = asObject(copy("linear", "x", { count: 3, offset: 30 }, l));
    const scene = render();

    expect(c.getError()).toBeNull();
    const surfaces = surfacesIn(scene);
    expect(surfaces.length).toBe(3);
    expect(surfaces.map(shape => center(shape)[0]).sort((a, b) => a - b)).toEqual([5, 35, 65].map(v => expect.closeTo(v, 6)));
  });

  it("repeat re-runs a load that produces a surface", () => {
    const l = plate();
    const r = asObject(repeat("linear", "y", { count: 2, offset: 30 }, l as never));
    const scene = render();

    expect(r.getError()).toBeNull();
    const surfaces = surfacesIn(scene);
    expect(surfaces.length).toBe(2);
    expect(surfaces.map(shape => center(shape)[1]).sort((a, b) => a - b)).toEqual([5, 35].map(v => expect.closeTo(v, 6)));
  });

  it("remove takes a surface and a curve out of the model", () => {
    const e = block();
    const l = plate();
    const curve = asObject(loadShapes([TestCurves.threeEdges()]));
    remove(l, curve);
    const scene = render();

    expect(l.getShapes()).toEqual([]);
    expect(curve.getShapes()).toEqual([]);
    expect(bodiesIn(scene)).toEqual(e.getShapes());
  });

  describe("color", () => {
    it("paints a whole surface", () => {
      const l = plate();
      color("red", l);
      render();

      const [surface] = l.getShapes();
      const face = (surface as BodyShape).getFaces()[0];
      expect(l.faceColorOf(surface, face)).toBe("#ff0000");
    });

    it("paints one face of a surface", () => {
      const l = asObject(loadShapes([TestSheets.openBox(10, 10, 10)]));
      color("blue", select(face().onPlane("xy")));
      render();

      const [surface] = l.getShapes() as BodyShape[];
      const painted = surface.getFaces().filter(face => l.faceColorOf(surface, face));
      expect(painted.length).toBe(1);
    });

    it("with no operand paints surfaces with the solids", () => {
      const e = block();
      const l = plate();
      color("green");
      render();

      const [surface] = l.getShapes() as BodyShape[];
      const [solid] = e.getShapes() as BodyShape[];
      expect(l.faceColorOf(surface, surface.getFaces()[0])).toBe("#008000");
      expect(e.faceColorOf(solid, solid.getFaces()[0])).toBe("#008000");
    });
  });

  describe("booleans", () => {
    const refusal = (consumer: string, label: string) =>
      `${consumer}: ${label} is a surface; ${consumer} works on solids.`;

    it("fuse refuses a surface operand", () => {
      const e = block();
      const f = asObject(fuse(e, plate()));
      render();
      expect(f.getError()).toContain(refusal("fuse", "operand 2"));
      expect(f.getError()).toContain("Booleans work on solids");
    });

    it("common refuses a surface operand", () => {
      const e = block();
      const c = asObject(common(plate(), e));
      render();
      expect(c.getError()).toContain(refusal("common", "operand 1"));
    });

    it("subtract refuses a surface as stock, and leaves it in the model", () => {
      const e = block();
      const l = plate();
      const s = asObject(subtract(l, e));
      render();
      expect(s.getError()).toContain(refusal("subtract", "first operand"));
      expect(l.getShapes().length).toBe(1);
    });

    it("the implicit stock stays solids: a scope-wide fuse leaves a surface alone", () => {
      sketch("xy", () => {
        testRect(20, 20);
      });
      extrude(10);
      sketch("xy", () => {
        testRect(20, 20, { at: [10, 0] });
      });
      extrude(10).new();
      const l = plate();
      const f = asObject(fuse());
      const scene = render();

      expect(f.getError()).toBeNull();
      expect(solidsIn(scene).length).toBe(1);
      expect(l.getShapes().length).toBe(1);
    });
  });

  it("an additive extrude and a cut passing through a surface leave it alone", () => {
    const l = asObject(loadShapes([TestSheets.plate(40, 40)]));
    sketch(plane("xy", -10), () => {
      testRect(10, 10, { at: [5, 5] });
    });
    const e = asObject(extrude(20));
    sketch(plane("xy", 10), () => {
      testRect(4, 4, { at: [8, 8] });
    });
    const c = asObject(cut(20));
    const scene = render();

    expect(e.getError()).toBeNull();
    expect(c.getError()).toBeNull();
    const [surface] = l.getShapes() as BodyShape[];
    expect(surface).toBeInstanceOf(Sheet);
    expect(surface.getFaces().length).toBe(1);
    expect(surfacesIn(scene)).toEqual([surface]);
    // The block got its hole: the cut acted on the solid only.
    expect(solidsIn(scene).length).toBe(1);
    expect((solidsIn(scene)[0] as BodyShape).getFaces().length).toBe(10);
  });

  it("extrude of a surface's face makes a solid from it", () => {
    plate();
    const e = asObject(extrude(5, select(face().ofSurface())));
    render();

    expect(e.getError()).toBeNull();
    const [solid] = e.getShapes();
    expect(solid).toBeInstanceOf(Solid);
    expect(ShapeOps.getBoundingBox(solid).maxZ).toBeCloseTo(5, 6);
  });

  describe("fillet and chamfer", () => {
    it("fillet refuses a surface edge and points to .ofSolid()", () => {
      block();
      plate();
      const f = asObject(fillet(1, select(edge())));
      render();

      expect(f.getError()).toContain("fillet: edge selection 1 holds a surface edge; fillet works on solids.");
      expect(f.getError()).toContain(".ofSolid()");
    });

    it("fillet with .ofSolid() fillets the solid beside a surface", () => {
      block();
      const l = plate();
      const f = asObject(fillet(1, select(edge().ofSolid().onPlane("xy", 10))));
      render();

      expect(f.getError()).toBeNull();
      expect(f.getShapes()[0]).toBeInstanceOf(Solid);
      expect(l.getShapes().length).toBe(1);
    });

    it("chamfer refuses a surface edge", () => {
      block();
      plate();
      const c = asObject(chamfer(1, select(edge().ofSurface())));
      render();

      expect(c.getError()).toContain("chamfer: edge selection 1 holds a surface edge; chamfer works on solids.");
    });
  });

  it("shell refuses a face of a surface", () => {
    block();
    plate();
    const s = asObject(shell(1, select(face().ofSurface())));
    render();

    expect(s.getError()).toContain("shell: face selection 1 holds a surface face; shell works on solids.");
  });

  it("draft refuses a face of a surface", () => {
    block();
    plate();
    const d = asObject(draft(5, select(face().ofSurface())));
    render();

    expect(d.getError()).toContain("draft: selection 1 holds a surface face; draft works on solids.");
  });

  it("split refuses a surface target", () => {
    const l = plate();
    const s = asObject(split("yz", l));
    render();

    expect(s.getError()).toContain("split: target 1 is a surface; split works on solids.");
  });

  describe("references read a surface's faces and edges and a curve's edges", () => {
    it("plane() from a surface's face", () => {
      asObject(loadShapes([TestSheets.openBox(10, 10, 10)]));
      const p = asObject(plane(select(face().onPlane("yz", 10))));
      render();

      expect(p.getError()).toBeNull();
      const normal = (p as unknown as { getPlane(): { normal: { x: number } } }).getPlane().normal;
      expect(Math.abs(normal.x)).toBeCloseTo(1, 6);
    });

    it("axis() from a surface's edge and from a curve's edge", () => {
      plate();
      const curve = asObject(loadShapes([TestCurves.threeEdges()]));
      const a1 = asObject(axis(select(edge().ofSurface().line().onPlane("xz"))));
      const a2 = asObject(axis(select(edge().from(curve).line().onPlane("yz", 20))));
      render();

      expect(a1.getError()).toBeNull();
      expect(a2.getError()).toBeNull();
    });

    it("sketch() on a surface's face", () => {
      plate();
      const s = asObject(sketch(select(face().ofSurface()), () => {
        circle([5, 5], 2);
      }));
      render();

      expect(s.getError()).toBeNull();
      expect(s.getShapes().length).toBe(1);
    });

    it("connector() on a surface's face", () => {
      let c!: SceneObject;
      part("Panel", () => {
        plate();
        c = asObject(connector("top", select(face().ofSurface())));
      });
      render();

      expect(c.getError()).toBeNull();
    });

    it("helix() from a surface's cylindrical face", () => {
      loadShapes([TestSheets.halfPipe(5, 20)]);
      const h = asObject(helix(select(face().ofSurface())));
      render();

      expect(h.getError()).toBeNull();
      expect(h.getShapes().length).toBe(1);
    });

    it("intersect() in a sketch sections a surface", () => {
      const l = asObject(loadShapes([TestSheets.openBox(10, 10, 10)]));
      const s = asObject(sketch(plane("xy", 5), () => {
        intersect(l);
      }));
      render();

      expect(s.getError()).toBeNull();
      // Four walls cut at mid height; the floor is parallel and gives nothing.
      expect(s.getShapes().length).toBe(4);
    });

    it("project() in a sketch takes a surface's rim", () => {
      const l = asObject(loadShapes([TestSheets.openBox(10, 10, 10)]));
      const s = asObject(sketch(plane("xy", 30), () => {
        project(l);
      }));
      render();

      expect(s.getError()).toBeNull();
      expect(s.getShapes().length).toBe(4);
      // The surface is referenced, not consumed.
      expect(l.getShapes().length).toBe(1);
    });

    it("sweep() along a curve object", () => {
      const curve = asObject(loadShapes([TestCurves.lineIntoArc()]));
      sketch("yz", () => {
        circle([0, 0], 1);
      });
      const sw = asObject(sweep(curve));
      render();

      expect(sw.getError()).toBeNull();
      expect(sw.getShapes()[0]).toBeInstanceOf(Solid);
    });
  });

  it("a surface followed through translate then rotate still answers to its loader", () => {
    const l = plate();
    translate(0, 0, 5, l);
    const r = asObject(rotate("z", 90, l));
    render();

    const live = liveBodiesOf(l);
    expect(live.map(({ holder }) => holder)).toEqual([r]);
    const [x, y, z] = center(live[0].body);
    expect([x, y, z].map(v => Number(v.toFixed(6)))).toEqual([-5, 5, 5]);
  });

  describe("previews", () => {
    const FILE = "/tmp/surface-previews.fluid.js";

    function at<T>(value: T, line: number): T {
      asObject(value).setSourceLocation({ filePath: FILE, line, column: 0 });
      return value;
    }

    function preview(scene: Scene, request: FeatureGhostRequest): FeatureGhostResult {
      return buildFeatureGhost(scene, request, DEFAULT_MESH_CONFIG);
    }

    /** The ghost's bodies by how the overlay draws them, with every vertex of each. */
    function drawn(result: FeatureGhostResult): Array<{ kind: string | undefined; xs: number[]; zs: number[] }> {
      if (!result.ok) {
        throw new Error(`preview refused: ${"reason" in result ? result.reason : ""}`);
      }
      return result.solids.map(solid => {
        const vertices = solid.meshes.flatMap(mesh => mesh.vertices);
        return {
          kind: solid.kind,
          xs: vertices.filter((_, i) => i % 3 === 0),
          zs: vertices.filter((_, i) => i % 3 === 2),
        };
      });
    }

    it("translate draws a named surface as a body and a named curve as lines", () => {
      at(plate(), 3);
      at(loadShapes([TestCurves.threeEdges()]), 4);
      const scene = render();

      const result = preview(scene, {
        feature: "translate",
        translation: [0, 0, 5],
        targets: [{ filePath: FILE, line: 3 }, { filePath: FILE, line: 4 }],
      });

      const [surface, curve] = drawn(result);
      expect(surface.kind).toBe("add");
      expect(curve.kind).toBe("wire");
      for (const body of [surface, curve]) {
        expect(Math.min(...body.zs)).toBeCloseTo(5, 6);
        expect(Math.max(...body.zs)).toBeCloseTo(5, 6);
      }
    });

    it("rotate and copy draw a surface", () => {
      at(plate(), 3);
      const scene = render();
      const targets = [{ filePath: FILE, line: 3 }];

      const turned = drawn(preview(scene, { feature: "rotate", axis: { kind: "standard", axis: "z" }, angle: 180, targets }));
      expect(turned).toHaveLength(1);
      expect(Math.min(...turned[0].xs)).toBeCloseTo(-10, 6);

      const copied = drawn(preview(scene, {
        feature: "copy", kind: "linear", targets,
        axes: [{ kind: "standard", axis: "x" }],
        directions: [{ count: 3, offset: 30, length: null }],
        centered: false, count: null, sweep: null,
      }));
      expect(copied).toHaveLength(2);
    });

    it("a removing mirror adds a surface's image: a surface has no material to cut", () => {
      block();
      at(plate(), 3);
      const scene = render();

      const result = preview(scene, {
        feature: "mirror", op: "remove", plane: { kind: "standard", plane: "yz" },
        targets: [{ filePath: FILE, line: 3 }],
      });

      const [surface] = drawn(result);
      expect(surface.kind).toBe("add");
      expect(Math.min(...surface.xs)).toBeCloseTo(-10, 6);
    });

    it("fillet refuses an edge of a surface with the build's own words", () => {
      block();
      const l = plate();
      const scene = render();

      const result = preview(scene, {
        feature: "fillet", value: 1, distance2: null, isAngle: false,
        edges: [{ shapeId: l.getShapes()[0].id, index: 0, kind: "edge" }],
      });

      expect(result).toEqual({
        ok: false,
        reason: "fillet: edge selection 1 holds a surface edge; fillet works on solids.",
        surface: true,
      });
    });

    it("shell refuses a face of a surface with the build's own words", () => {
      block();
      const l = plate();
      const scene = render();

      const result = preview(scene, {
        feature: "shell", thickness: -1, joinType: "arc",
        faces: [{ shapeId: l.getShapes()[0].id, index: 0 }],
      });

      expect(result).toEqual({
        ok: false,
        reason: "shell: face selection 1 holds a surface face; shell works on solids.",
        surface: true,
      });
    });
  });
});
