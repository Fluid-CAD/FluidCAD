import { describe, it, expect } from "vitest";
import { setupOC, render } from "../../setup.js";
import sketch from "../../../core/sketch.js";
import extrude from "../../../core/extrude.js";
import { circle, move } from "../../../core/2d/index.js";
import { ExtrudeBase } from "../../../features/extrude-base.js";
import { Solid } from "../../../common/solid.js";
import { ShapeOps } from "../../../oc/shape-ops.js";
import { getFacesByType } from "../../utils.js";

describe("circle", () => {
  setupOC();

  describe("in sketch", () => {
    it("should create a circle with default radius", () => {
      sketch("xy", () => {
        circle();
      });
      const e = extrude(10) as ExtrudeBase;
      render();

      const solid = e.getShapes()[0] as Solid;
      // Default radius is 20, so diameter = 40
      const bbox = ShapeOps.getBoundingBox(solid);
      expect(bbox.maxX - bbox.minX).toBeCloseTo(40, 0);
    });

    it("should create a circle with given radius", () => {
      sketch("xy", () => {
        circle(30);
      });
      const e = extrude(10) as ExtrudeBase;
      render();

      const solid = e.getShapes()[0] as Solid;
      const bbox = ShapeOps.getBoundingBox(solid);
      expect(bbox.maxX - bbox.minX).toBeCloseTo(60, 0);
    });

    it("should create a circle at a given center", () => {
      sketch("xy", () => {
        circle([50, 30], 20);
      });
      const e = extrude(10) as ExtrudeBase;
      render();

      const bbox = ShapeOps.getBoundingBox(e.getShapes()[0]);
      expect(bbox.centerX).toBeCloseTo(50, 0);
      expect(bbox.centerY).toBeCloseTo(30, 0);
    });

    it("should produce a cylinder when extruded", () => {
      sketch("xy", () => {
        circle(25);
      });
      const e = extrude(30) as ExtrudeBase;
      render();

      const solid = e.getShapes()[0] as Solid;
      // Cylinder has 2 circular + 1 cylindrical face
      expect(getFacesByType(solid, "circle")).toHaveLength(2);
      expect(getFacesByType(solid, "cylinder")).toHaveLength(1);
    });
  });

  describe("standalone with targetPlane", () => {
    it("should create a circle on a specific plane", () => {
      circle(30, "xy");
      const e = extrude(10) as ExtrudeBase;
      render();

      const solid = e.getShapes()[0] as Solid;
      const bbox = ShapeOps.getBoundingBox(solid);
      expect(bbox.maxX - bbox.minX).toBeCloseTo(60, 0);
    });
  });
});
