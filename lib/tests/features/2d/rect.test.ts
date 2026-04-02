import { describe, it, expect } from "vitest";
import { setupOC, render } from "../../setup.js";
import sketch from "../../../core/sketch.js";
import extrude from "../../../core/extrude.js";
import { rect } from "../../../core/2d/index.js";
import { ExtrudeBase } from "../../../features/extrude-base.js";
import { Solid } from "../../../common/solid.js";
import { ShapeOps } from "../../../oc/shape-ops.js";

describe("rect", () => {
  setupOC();

  describe("in sketch", () => {
    it("should create a rectangle with width and height", () => {
      sketch("xy", () => {
        rect(100, 50);
      });
      const e = extrude(10) as ExtrudeBase;
      render();

      const solid = e.getShapes()[0] as Solid;
      const bbox = ShapeOps.getBoundingBox(solid);
      expect(bbox.maxX - bbox.minX).toBeCloseTo(100, 0);
      expect(bbox.maxY - bbox.minY).toBeCloseTo(50, 0);
    });

    it("should create a square when only width is given", () => {
      sketch("xy", () => {
        rect(60);
      });
      const e = extrude(10) as ExtrudeBase;
      render();

      const solid = e.getShapes()[0] as Solid;
      const bbox = ShapeOps.getBoundingBox(solid);
      expect(bbox.maxX - bbox.minX).toBeCloseTo(60, 0);
      expect(bbox.maxY - bbox.minY).toBeCloseTo(60, 0);
    });

    it("should create a centered rectangle", () => {
      sketch("xy", () => {
        rect(100, 50).center();
      });
      const e = extrude(10) as ExtrudeBase;
      render();

      const bbox = ShapeOps.getBoundingBox(e.getShapes()[0]);
      expect(bbox.minX).toBeCloseTo(-50, 0);
      expect(bbox.maxX).toBeCloseTo(50, 0);
      expect(bbox.minY).toBeCloseTo(-25, 0);
      expect(bbox.maxY).toBeCloseTo(25, 0);
    });

    it("should create a rounded rectangle", () => {
      sketch("xy", () => {
        rect(100, 50).radius(10);
      });
      const e = extrude(10) as ExtrudeBase;
      render();

      const solid = e.getShapes()[0] as Solid;
      // Rounded rect has more edges than a sharp rect (arcs at corners)
      expect(solid.getEdges().length).toBeGreaterThan(12);
    });
  });

  describe("standalone with targetPlane", () => {
    it("should create a rectangle on a specific plane", () => {
      rect(80, 40, "xy");
      const e = extrude(10) as ExtrudeBase;
      render();

      const solid = e.getShapes()[0] as Solid;
      const bbox = ShapeOps.getBoundingBox(solid);
      expect(bbox.maxX - bbox.minX).toBeCloseTo(80, 0);
      expect(bbox.maxY - bbox.minY).toBeCloseTo(40, 0);
    });
  });
});
