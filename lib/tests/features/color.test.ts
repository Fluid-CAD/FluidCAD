import { describe, it, expect } from "vitest";
import { setupOC, render } from "../setup.js";
import sketch from "../../core/sketch.js";
import extrude from "../../core/extrude.js";
import color from "../../core/color.js";
import select from "../../core/select.js";
import { rect } from "../../core/2d/index.js";
import { Solid } from "../../common/solid.js";
import { Color } from "../../features/color.js";
import { SelectSceneObject } from "../../features/select.js";
import { countShapes } from "../utils.js";
import { face } from "../../filters/index.js";

describe("color", () => {
  setupOC();

  describe("apply color to face", () => {
    it("should apply a color to a selected face", () => {
      sketch("xy", () => {
        rect(100, 50);
      });
      extrude(30);

      select(face().onPlane("xy", 30));
      const c = color("red") as Color;

      render();

      const shapes = c.getShapes();
      expect(shapes).toHaveLength(1);

      const solid = shapes[0] as Solid;
      expect(solid.hasColors()).toBe(true);
    });

    it("should store the correct color value", () => {
      sketch("xy", () => {
        rect(100, 50);
      });
      extrude(30);

      const sel = select(face().onPlane("xy", 30)) as SelectSceneObject;
      const c = color("#ff0000", sel) as Color;

      render();

      const solid = c.getShapes()[0] as Solid;
      expect(solid.hasColors()).toBe(true);

      // The color map should have an entry with the specified color
      expect(solid.colorMap.length).toBeGreaterThan(0);
      expect(solid.colorMap[0].color).toBe("#ff0000");
    });
  });

  describe("color with explicit selection", () => {
    it("should color the explicitly passed selection", () => {
      sketch("xy", () => {
        rect(100, 50);
      });
      extrude(30);

      const sel = select(face().onPlane("xy")) as SelectSceneObject;
      const c = color("blue", sel) as Color;

      render();

      const solid = c.getShapes()[0] as Solid;
      expect(solid.hasColors()).toBe(true);
      expect(solid.colorMap[0].color).toBe("#0000ff");
    });
  });

  describe("color multiple faces", () => {
    it("should color multiple selected faces", () => {
      sketch("xy", () => {
        rect(100, 50);
      });
      extrude(30);

      // Select both top and bottom faces
      select(face().parallelTo("xy"));
      const c = color("#008000") as Color;

      render();

      const solid = c.getShapes()[0] as Solid;
      expect(solid.colorMap).toHaveLength(2);
      for (const entry of solid.colorMap) {
        expect(entry.color).toBe("#008000");
      }
    });
  });

  describe("color replaces original solid", () => {
    it("should produce a single solid in the scene", () => {
      sketch("xy", () => {
        rect(100, 50);
      });
      extrude(30);

      select(face().onPlane("xy", 30));
      color("red");

      const scene = render();

      expect(countShapes(scene)).toBe(1);
    });
  });

  describe("color removes selection shapes", () => {
    it("should remove the face selection after coloring", () => {
      sketch("xy", () => {
        rect(100, 50);
      });
      extrude(30);

      const sel = select(face().onPlane("xy", 30)) as SelectSceneObject;
      color("red", sel);

      render();

      expect(sel.getShapes()).toHaveLength(0);
    });
  });
});
