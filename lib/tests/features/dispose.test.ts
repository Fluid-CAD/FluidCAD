import { describe, it, expect, vi } from "vitest";
import { setupOC, render } from "../setup.js";
import { getCurrentScene, getSceneManager } from "../../scene-manager.js";
import sketch from "../../core/sketch.js";
import extrude from "../../core/extrude.js";
import cylinder from "../../core/cylinder.js";
import trim from "../../core/trim.js";
import color from "../../core/color.js";
import plane from "../../core/plane.js";
import { circle, rect } from "../../core/2d/index.js";
import { SceneCompare } from "../../rendering/scene-compare.js";
import { renderScene } from "../../rendering/render.js";
import { Extrude } from "../../features/extrude.js";
import { Cylinder } from "../../features/cylinder.js";
import { Sketch } from "../../features/2d/sketch.js";
import { Face } from "../../common/face.js";

describe("dispose", () => {
  setupOC();

  describe("SceneObject.dispose()", () => {
    it("should clear state after dispose", () => {
      sketch("xy", () => {
        rect(100, 50);
      });
      const e = extrude(30) as Extrude;

      render();

      expect(e.getShapes().length).toBeGreaterThan(0);

      e.dispose();

      // State is cleared — getState returns undefined for all keys
      expect(e.getState("addedShapes")).toBeUndefined();
    });

    it("should call Shape.dispose() on addedShapes", () => {
      sketch("xy", () => {
        rect(100, 50);
      });
      const e = extrude(30) as Extrude;

      render();

      const shapes = e.getAddedShapes();
      expect(shapes.length).toBeGreaterThan(0);

      const spies = shapes.map(s => vi.spyOn(s, "dispose"));

      e.dispose();

      for (const spy of spies) {
        expect(spy).toHaveBeenCalled();
      }
    });

    it("should call Shape.dispose() on face state values", () => {
      sketch("xy", () => {
        rect(100, 50);
      });
      const e = extrude(30) as Extrude;

      render();

      const startFaces = e.getState("start-faces") as Face[];
      const endFaces = e.getState("end-faces") as Face[];
      const sideFaces = e.getState("side-faces") as Face[];

      expect(startFaces.length).toBeGreaterThan(0);
      expect(endFaces.length).toBeGreaterThan(0);
      expect(sideFaces.length).toBeGreaterThan(0);

      const allSpies = [...startFaces, ...endFaces, ...sideFaces].map(
        s => vi.spyOn(s, "dispose")
      );

      e.dispose();

      for (const spy of allSpies) {
        expect(spy).toHaveBeenCalled();
      }
    });

    it("should not dispose shapes in removedShapes", () => {
      sketch("xy", () => {
        circle(50);
      });
      const e1 = extrude(30) as Extrude;

      sketch("xy", () => {
        circle(50);
      });
      const e2 = extrude(30) as Extrude;

      render();

      // e1's shapes were removed (fused into e2)
      const e1Shapes = e1.getAddedShapes();
      const spies = e1Shapes.map(s => vi.spyOn(s, "dispose"));

      // Dispose e2 — it has removedShapes referencing e1's shapes
      e2.dispose();

      // e1's shapes should NOT have been disposed by e2
      for (const spy of spies) {
        expect(spy).not.toHaveBeenCalled();
      }
    });

    it("should be safe to call dispose twice", () => {
      sketch("xy", () => {
        rect(100, 50);
      });
      const e = extrude(30) as Extrude;

      render();

      e.dispose();
      // Second call should not throw
      expect(() => e.dispose()).not.toThrow();
    });
  });

  describe("SceneCompare disposes unmatched objects", () => {
    it("should dispose unmatched old scene objects after compare", () => {
      // Build first scene
      sketch("xy", () => {
        rect(100, 50);
      });
      extrude(30);
      const scene1 = render();

      const oldObjects = scene1.getSceneObjects();
      const spies = oldObjects.map(o => vi.spyOn(o, "dispose"));

      // Build second scene with completely different geometry
      getSceneManager().startScene();
      cylinder(50, 100);
      const scene2 = getCurrentScene();

      SceneCompare.compare(scene1, scene2);

      // All old objects are unmatched (cylinder vs sketch+extrude) — all should be disposed
      for (const spy of spies) {
        expect(spy).toHaveBeenCalled();
      }
    });

    it("should not dispose matched old scene objects", () => {
      // Build first scene
      cylinder(50, 100) as Cylinder;
      const scene1 = render();

      const oldObj = scene1.getSceneObjectAt(0);
      const disposeSpy = vi.spyOn(oldObj, "dispose");

      // Build second scene with same structure
      getSceneManager().startScene();
      cylinder(50, 100);
      const scene2 = getCurrentScene();

      SceneCompare.compare(scene1, scene2);

      // Same structure — old object should NOT be disposed (state was transferred)
      expect(disposeSpy).not.toHaveBeenCalled();
    });

    it("should dispose objects after the first mismatch point", () => {
      // Build first scene: cylinder + extrude
      cylinder(50, 100);
      sketch("xy", () => {
        rect(100, 50);
      });
      const e = extrude(30) as Extrude;
      const scene1 = render();

      const cylObj = scene1.getSceneObjectAt(0);
      const cylSpy = vi.spyOn(cylObj, "dispose");
      const eSpy = vi.spyOn(e, "dispose");

      // Build second scene: cylinder + different sketch shape
      getSceneManager().startScene();
      cylinder(50, 100);
      sketch("xy", () => {
        circle(80);
      });
      extrude(30);
      const scene2 = getCurrentScene();

      SceneCompare.compare(scene1, scene2);

      // Cylinder matches — should NOT be disposed
      expect(cylSpy).not.toHaveBeenCalled();

      // Sketch changed (rect -> circle) so from sketch onwards is unmatched
      expect(eSpy).toHaveBeenCalled();
    });

    it("should mark matched objects as cached in new scene", () => {
      cylinder(50, 100);
      const scene1 = render();

      getSceneManager().startScene();
      cylinder(50, 100);
      sketch("xy", () => {
        rect(100, 50);
      });
      extrude(30);
      const scene2 = getCurrentScene();

      SceneCompare.compare(scene1, scene2);

      // Cylinder matched — should be cached
      const newCyl = scene2.getSceneObjectAt(0);
      expect(scene2.isCached(newCyl)).toBe(true);

      // Sketch is new — should not be cached
      const newSketch = scene2.getSceneObjects().find(o => o instanceof Sketch);
      expect(scene2.isCached(newSketch)).toBe(false);
    });

    it("should not delete shapes shared with matched objects (color + sideFaces scenario)", () => {
      // Build first scene: two extrudes + color on side face
      sketch("xy", () => {
        rect([0, 100], 50, 50);
      });
      extrude(100);

      sketch("xy", () => {
        rect([0, 0], 50, 50);
      });
      const e2 = extrude(100).new();

      color("red", e2.sideFaces(0));
      const scene1 = render();

      // Build second scene: same but different color
      getSceneManager().startScene();
      sketch("xy", () => {
        rect([0, 100], 50, 50);
      });
      extrude(100);

      sketch("xy", () => {
        rect([0, 0], 50, 50);
      });
      const e2b = extrude(100).new();

      color("blue", e2b.sideFaces(0));
      const scene2 = getCurrentScene();

      // Compare — everything matches except Color (red vs blue)
      SceneCompare.compare(scene1, scene2);

      // Render should succeed — faces from matched extrude must not be deleted
      expect(() => renderScene(scene2)).not.toThrow();
    });

    it("should not delete shapes when new objects are added after matched ones", () => {
      // First render: two extrudes, no color
      sketch(plane("xy"), () => {
        rect([100, 250], 50, 50);
      });
      extrude(100);

      sketch(plane("xy"), () => {
        rect([100, 150], 50, 50);
      });
      extrude(100).new();

      const scene1 = render();

      // Second render: same two extrudes + color added at the end
      getSceneManager().startScene();
      sketch(plane("xy"), () => {
        rect([100, 250], 50, 50);
      });
      extrude(100);

      sketch(plane("xy"), () => {
        rect([100, 150], 50, 50);
      });
      const e2 = extrude(100).new();

      color("red", e2.sideFaces(1));

      const scene2 = getCurrentScene();

      // Compare — all old objects match, color/selection are new
      SceneCompare.compare(scene1, scene2);

      // Render — LazySelection and Color must build successfully
      // using faces from the matched extrude's transferred state
      expect(() => renderScene(scene2)).not.toThrow();
    });

    it("should not delete shapes shared with matched objects (trim2d scenario)", () => {
      // Build first scene: sketch with circle + trim
      sketch("xy", () => {
        circle(100);
        trim();
      });
      const scene1 = render();

      // Build second scene: same sketch, trim with different points
      getSceneManager().startScene();
      sketch("xy", () => {
        circle(100);
        trim([10, 0]);
      });
      const scene2 = getCurrentScene();

      // Compare — circle matches, trim2d does not
      SceneCompare.compare(scene1, scene2);

      // Render should succeed — the matched circle's edge must not be deleted
      expect(() => renderScene(scene2)).not.toThrow();

      // Verify shapes exist on the scene
      const rendered = scene2.getRenderedObjects();
      expect(rendered.length).toBeGreaterThan(0);
    });
  });
});
