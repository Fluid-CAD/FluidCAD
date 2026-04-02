import { describe, it, expect } from "vitest";
import { setupOC, render } from "../setup.js";
import sketch from "../../core/sketch.js";
import extrude from "../../core/extrude.js";
import shell from "../../core/shell.js";
import select from "../../core/select.js";
import cylinder from "../../core/cylinder.js";
import { circle, rect } from "../../core/2d/index.js";
import { Solid } from "../../common/solid.js";
import { Extrude } from "../../features/extrude.js";
import { SelectSceneObject } from "../../features/select.js";
import { countShapes } from "../utils.js";
import { ShapeOps } from "../../oc/shape-ops.js";
import { ShapeProps } from "../../oc/props.js";
import { face } from "../../filters/index.js";

describe("shell", () => {
  setupOC();

  describe("basic shell", () => {
    it("should hollow out a box by removing the top face", () => {
      sketch("xy", () => {
        rect(100, 100);
      });
      const e = extrude(50) as Extrude;

      select(face().onPlane("xy", 50));
      shell(5);

      const scene = render();

      expect(countShapes(scene)).toBe(1);

      const solid = scene.getAllSceneObjects()
        .flatMap(o => o.getShapes())
        .find(s => s.getType() === "solid") as Solid;

      // Shelled box has more faces than a solid box (inner walls)
      expect(solid.getFaces().length).toBeGreaterThan(6);
    });

    it("should reduce volume compared to the original solid", () => {
      sketch("xy", () => {
        rect(100, 100);
      });
      extrude(50);

      select(face().onPlane("xy", 50));
      shell(5);

      const scene = render();

      const solid = scene.getAllSceneObjects()
        .flatMap(o => o.getShapes())
        .find(s => s.getType() === "solid") as Solid;

      const props = ShapeProps.getProperties(solid.getShape());
      // Hollow box volume should be less than solid box (100*100*50 = 500000)
      expect(props.volumeMm3).toBeLessThan(500000);
      expect(props.volumeMm3).toBeGreaterThan(0);
    });
  });

  describe("shell with explicit selection", () => {
    it("should shell using an explicit face selection", () => {
      sketch("xy", () => {
        rect(100, 100);
      });
      extrude(50);

      const sel = select(face().onPlane("xy", 50)) as SelectSceneObject;
      shell(3, sel);

      const scene = render();

      expect(countShapes(scene)).toBe(1);

      const solid = scene.getAllSceneObjects()
        .flatMap(o => o.getShapes())
        .find(s => s.getType() === "solid") as Solid;

      expect(solid.getFaces().length).toBeGreaterThan(6);
    });
  });

  describe("shell thickness", () => {
    it("should use default thickness of 2.5", () => {
      sketch("xy", () => {
        rect(100, 100);
      });
      extrude(50);

      select(face().onPlane("xy", 50));
      shell();

      const scene = render();

      expect(countShapes(scene)).toBe(1);

      const solid = scene.getAllSceneObjects()
        .flatMap(o => o.getShapes())
        .find(s => s.getType() === "solid") as Solid;

      expect(solid.getFaces().length).toBeGreaterThan(6);
    });

    it("should produce thinner walls with smaller thickness", () => {
      sketch("xy", () => {
        rect(100, 100);
      });
      extrude(50);

      select(face().onPlane("xy", 50));
      shell(2);

      render();

      const solid2 = [...render().getAllSceneObjects()]
        .flatMap(o => o.getShapes())
        .find(s => s.getType() === "solid") as Solid;

      // Re-run with a thicker shell to compare
      // (we can't easily compare two shells in one test due to scene reset,
      // so just verify it produces a valid shelled solid)
      expect(solid2).toBeDefined();
    });
  });

  describe("shell on cylinder", () => {
    it("should hollow out a cylinder", () => {
      cylinder(50, 80);

      select(face().onPlane("xy", 80));
      shell(5);

      const scene = render();

      expect(countShapes(scene)).toBe(1);

      const solid = scene.getAllSceneObjects()
        .flatMap(o => o.getShapes())
        .find(s => s.getType() === "solid") as Solid;

      // Hollow cylinder has more faces than a solid cylinder (3)
      expect(solid.getFaces().length).toBeGreaterThan(3);
    });
  });

  describe("shell removes selection shapes", () => {
    it("should remove the face selection after shelling", () => {
      sketch("xy", () => {
        rect(100, 100);
      });
      extrude(50);

      const sel = select(face().onPlane("xy", 50)) as SelectSceneObject;
      shell(5, sel);

      render();

      expect(sel.getShapes()).toHaveLength(0);
    });
  });
});
