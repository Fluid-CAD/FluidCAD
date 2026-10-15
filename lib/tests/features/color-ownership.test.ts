import { describe, it, expect, vi, afterEach } from "vitest";
import { setupOC, render } from "../setup.js";
import { getSceneManager } from "../../scene-manager.js";
import { SceneRenderer } from "../../rendering/render.js";
import { MeshBuilder } from "../../rendering/mesh-builder.js";
import { DEFAULT_MESH_CONFIG } from "../../oc/mesh.js";
import sketch from "../../core/sketch.js";
import extrude from "../../core/extrude.js";
import color from "../../core/color.js";
import select from "../../core/select.js";
import fillet from "../../core/fillet.js";
import { } from "../../core/2d/index.js";
import { Solid } from "../../common/solid.js";
import { Face } from "../../common/face.js";
import { Shape } from "../../common/shape.js";
import { SceneObject } from "../../common/scene-object.js";
import { Color } from "../../features/color.js";
import { Extrude } from "../../features/extrude.js";
import { Fillet } from "../../features/fillet.js";
import { SelectSceneObject } from "../../features/select.js";
import { Scene, SceneObjectRender } from "../../rendering/scene.js";
import { liveSolidsOf } from "../../helpers/live-solids.js";
import { explainSelection } from "../../selection/explain.js";
import { colorOf, countShapes, faceColorsOf } from "../utils.js";
import { allFaceRefs } from "../selection/pick-helpers.js";
import { edge, face } from "../../filters/index.js";
import { testRect } from "../helpers/profiles.js";

const RED = "#ff0000";
const BLUE = "#0000ff";

/** The one body `holder` holds. */
function bodyOf(holder: SceneObject): Solid {
  const shapes = holder.getShapes();
  expect(shapes).toHaveLength(1);
  return shapes[0] as Solid;
}

/** The face of `solid` whose centre sits at z = `z` — the top of a 30 mm box, say. */
function faceAtZ(solid: Solid, z: number): Face {
  const faces = solid.getFaces().filter(f => Math.abs(f.center().z - z) < 1e-6 && Math.abs(f.getBoundingBox().maxZ - f.getBoundingBox().minZ) < 1e-6);
  expect(faces).toHaveLength(1);
  return faces[0];
}

/** A 100×50×30 box with its top face selected and painted `value`. */
function paintedBox(value = "red"): { e: Extrude; sel: SelectSceneObject; c: Color } {
  sketch("xy", () => {
      testRect(100, 50);
    });
  const e = extrude(30) as Extrude;
  const sel = select(face().onPlane("xy", 30)) as SelectSceneObject;
  const c = color(value) as Color;
  return { e, sel, c };
}

function rowOf(scene: Scene, obj: SceneObject): SceneObjectRender {
  const row = scene.getRenderedObject(obj);
  expect(row).not.toBeNull();
  return row!;
}

/** The `solid-faces` meshes the render emitted for `obj`'s one shape, with that shape's id. */
function faceMeshesOf(scene: Scene, obj: SceneObject): { shapeId: string; colors: (string | undefined)[] } {
  const row = rowOf(scene, obj);
  expect(row.sceneShapes).toHaveLength(1);
  const shape = row.sceneShapes[0];
  return {
    shapeId: shape.shapeId,
    colors: shape.meshes.filter(m => m.label === "solid-faces").map(m => m.color),
  };
}

function rollbackTo(scene: Scene, obj: SceneObject, offset = 0): Scene {
  const index = scene.getTimelineObjects().indexOf(obj) + offset;
  expect(index).toBeGreaterThanOrEqual(0);
  return new SceneRenderer(DEFAULT_MESH_CONFIG).renderRollback(scene, index);
}

describe("color paints without owning", () => {
  setupOC();

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("selections", () => {
    it("leaves an explicitly painted face selection usable by a later feature", () => {
      sketch("xy", () => {
          testRect(100, 50);
        });
      const e = extrude(30) as Extrude;
      const rim = select(edge().onPlane("xy", 30)) as SelectSceneObject;
      const top = select(face().onPlane("xy", 30)) as SelectSceneObject;
      const c = color("red", top) as Color;
      const f = fillet(2, rim) as Fillet;

      const scene = render();

      expect(c.getError()).toBeFalsy();
      expect(f.getError()).toBeFalsy();
      expect(e.getShapes()).toHaveLength(0);
      const filleted = bodyOf(f);
      expect(filleted.getFaces()).toHaveLength(10);
      // The paint rode the fillet's lineage onto the trimmed top face and
      // bled onto the four fillet faces it seeded (as the lineage suite
      // pins); the sides and bottom stay bare.
      expect(colorOf(scene, filleted, faceAtZ(filleted, 30))).toBe(RED);
      expect(colorOf(scene, filleted, faceAtZ(filleted, 0))).toBeUndefined();
      expect(faceColorsOf(scene, filleted).size).toBe(5);
      expect(countShapes(scene)).toBe(1);
    });

    it("lets a painted face selection be painted again, the later statement winning", () => {
      sketch("xy", () => {
          testRect(100, 50);
        });
      const e = extrude(30) as Extrude;
      const top = select(face().onPlane("xy", 30)) as SelectSceneObject;
      const first = color("red", top) as Color;
      const second = color("blue", top) as Color;

      const scene = render();

      expect(first.getError()).toBeFalsy();
      expect(second.getError()).toBeFalsy();
      expect(top.getShapes()).toHaveLength(1);
      const solid = bodyOf(e);
      expect(colorOf(scene, solid, faceAtZ(solid, 30))).toBe(BLUE);
      expect(faceColorsOf(scene, solid).size).toBe(1);
    });

    it("claims the selection a bare color() takes, so a bare fillet() does not inherit it", () => {
      const { e, sel } = paintedBox();
      const f = fillet(2) as Fillet;

      const scene = render();

      expect(sel.isClaimed()).toBe(true);
      expect(sel.getShapes()).toHaveLength(1);
      // Exactly what a bare fillet(2) with no selection at all reports.
      expect(f.getError()).toMatch(/no edges selected/);
      expect(bodyOf(e).getFaces()).toHaveLength(6);
      expect(faceColorsOf(scene, bodyOf(e)).size).toBe(1);

      getSceneManager().startScene();
      sketch("xy", () => {
          testRect(100, 50);
        });
      extrude(30);
      const bare = fillet(2) as Fillet;
      render();
      expect(bare.getError()).toBe(f.getError());
    });

    it("refuses a face no held solid owns", () => {
      sketch("xy", () => {
          testRect(100, 50);
        });
      const e = extrude(30) as Extrude;
      const top = select(face().onPlane("xy", 30)) as SelectSceneObject;
      // The fillet consumes the extrude's body: the selected face belongs to
      // a solid nothing in scope holds any more.
      fillet(2, e.endEdges());
      const c = color("red", top) as Color;

      render();

      expect(c.getError()).toMatch(/no solid in scope holds a selected face/);
    });
  });

  describe("object operands", () => {
    it("paints the filleted body when a fillet consumed the object's solid", () => {
      sketch("xy", () => {
          testRect(100, 50);
        });
      const e = extrude(30) as Extrude;
      const f = fillet(2, e.endEdges()) as Fillet;
      const c = color("red", e) as Color;

      const scene = render();

      expect(c.getError()).toBeFalsy();
      expect(e.getShapes()).toHaveLength(0);
      const filleted = bodyOf(f);
      expect(filleted.getFaces()).toHaveLength(10);
      const colors = faceColorsOf(scene, filleted);
      expect(colors.size).toBe(10);
      expect([...colors.values()].every(value => value === RED)).toBe(true);
      expect(rowOf(scene, f).sceneShapes).toHaveLength(1);
    });

    it("keeps the extrude as the live holder of a painted body", () => {
      sketch("xy", () => {
          testRect(100, 50);
        });
      const e = extrude(30) as Extrude;
      color("red", e);

      render();

      const live = liveSolidsOf(e);
      expect(live).toHaveLength(1);
      expect(live[0].holder).toBe(e);
      expect(live[0].solid).toBe(bodyOf(e));
    });

    it("attributes a pick on a painted body to the feature that built it", () => {
      sketch("xy", () => {
          testRect(100, 50);
        });
      const e = extrude(30) as Extrude;
      color("red", e);

      const scene = render();

      const solid = bodyOf(e);
      const result = explainSelection(scene, allFaceRefs(solid));
      expect(result.picks).toHaveLength(6);
      for (const pick of result.picks) {
        expect(pick.solidOwnerId).toBe(e.id);
        expect(pick.attributed).toBe(true);
        expect(pick.producer!.featureId).toBe(e.id);
      }
    });
  });

  describe("the colour row", () => {
    it("renders no shapes and stays lit", () => {
      const { c } = paintedBox();

      const scene = render();

      const row = rowOf(scene, c);
      expect(row.sceneShapes).toHaveLength(0);
      expect(row.visible).toBe(true);
      expect(row.hasError).toBe(false);
    });
  });

  describe("rollback", () => {
    it("shows the same wrapper unpainted before the paint and painted at it", () => {
      const { e, c } = paintedBox();
      const scene = render();

      const full = faceMeshesOf(scene, e);
      expect(full.colors).toEqual(expect.arrayContaining([RED, undefined]));
      expect(full.colors).toHaveLength(2);

      const before = faceMeshesOf(rollbackTo(scene, c, -1), e);
      expect(before.shapeId).toBe(full.shapeId);
      expect(before.colors).toEqual([undefined]);

      const at = faceMeshesOf(rollbackTo(scene, c), e);
      expect(at.shapeId).toBe(full.shapeId);
      expect(at.colors).toEqual(expect.arrayContaining([RED, undefined]));
      expect(at.colors).toHaveLength(2);
    });

    it("shows the first colour between two paints of one face", () => {
      const { e, c: first } = paintedBox("red");
      select(face().onPlane("xy", 30));
      const second = color("blue") as Color;
      const scene = render();

      const full = faceMeshesOf(scene, e);
      expect(full.colors).toEqual(expect.arrayContaining([BLUE, undefined]));
      expect(full.colors).toHaveLength(2);

      const between = faceMeshesOf(rollbackTo(scene, second, -1), e);
      expect(between.shapeId).toBe(full.shapeId);
      expect(between.colors).toEqual(expect.arrayContaining([RED, undefined]));
      expect(between.colors).toHaveLength(2);

      const before = faceMeshesOf(rollbackTo(scene, first, -1), e);
      expect(before.colors).toEqual([undefined]);
    });

    it("meshes a body once for a full render and a rollback pass", () => {
      const { e, c } = paintedBox();
      const built = vi.spyOn(MeshBuilder.prototype, "buildPieces");

      const scene = render();
      const solid = bodyOf(e);
      const bodyBuilds = () => built.mock.calls.filter(([shape]) => shape === solid).length;
      expect(bodyBuilds()).toBe(1);

      rollbackTo(scene, c, -1);
      rollbackTo(scene, c);
      expect(bodyBuilds()).toBe(1);
      expect(solid.getMeshPieces()).not.toBeNull();
    });
  });

  describe("incremental rebuilds", () => {
    it("keeps the extrude cached and its wrapper when the colour value changes", () => {
      const first = paintedBox("red");
      const scene1 = render();
      const previous = getSceneManager().currentScene;
      const oldSolid = bodyOf(first.e);
      const oldShapeId = faceMeshesOf(scene1, first.e).shapeId;

      getSceneManager().startScene();
      const second = paintedBox("blue");
      const merged = getSceneManager().compare(previous, getSceneManager().currentScene);
      const scene2 = render();

      const e = merged.getAllSceneObjects().find(o => o instanceof Extrude) as Extrude;
      expect(merged.isCached(e)).toBe(true);
      expect(merged.isCached(second.c)).toBe(false);
      const solid = bodyOf(e);
      expect(solid).toBe(oldSolid);
      expect(solid.id).toBe(oldShapeId);
      expect(faceMeshesOf(scene2, e).shapeId).toBe(oldShapeId);
      expect(colorOf(scene2, solid, faceAtZ(solid, 30))).toBe(BLUE);
      expect(faceColorsOf(scene2, solid).size).toBe(1);
      expect(faceMeshesOf(scene2, e).colors).toEqual(expect.arrayContaining([BLUE, undefined]));
    });

    it("drops the colour from the body and from a fillet built after it when the paint is deleted", () => {
      sketch("xy", () => {
          testRect(100, 50);
        });
      const e1 = extrude(30) as Extrude;
      color("red", e1);
      const f1 = fillet(2, e1.endEdges()) as Fillet;
      const scene1 = render();
      expect(faceColorsOf(scene1, bodyOf(f1)).size).toBe(10);
      const previous = getSceneManager().currentScene;

      getSceneManager().startScene();
      sketch("xy", () => {
          testRect(100, 50);
        });
      const e2 = extrude(30) as Extrude;
      fillet(2, e2.endEdges());
      const merged = getSceneManager().compare(previous, getSceneManager().currentScene);
      const scene2 = render();

      const e = merged.getAllSceneObjects().find(o => o instanceof Extrude) as Extrude;
      const f = merged.getAllSceneObjects().find(o => o instanceof Fillet) as Fillet;
      expect(merged.isCached(e)).toBe(true);
      expect(f.getError()).toBeFalsy();
      expect(faceColorsOf(scene2, bodyOf(f)).size).toBe(0);
      expect(e.getAddedShapes().every((s: Shape) => faceColorsOf(scene2, s).size === 0)).toBe(true);
      expect(faceMeshesOf(scene2, f).colors).toEqual([undefined]);
    });
  });
});
