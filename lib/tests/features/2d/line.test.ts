import { describe, it, expect } from "vitest";
import { setupOC, render } from "../../setup.js";
import sketch from "../../../core/sketch.js";
import extrude from "../../../core/extrude.js";
import { line, hLine, vLine, aLine, move } from "../../../core/2d/index.js";
import { ExtrudeBase } from "../../../features/extrude-base.js";
import { Solid } from "../../../common/solid.js";
import { ShapeOps } from "../../../oc/shape-ops.js";
import { Sketch } from "../../../features/2d/sketch.js";

describe("line functions", () => {
  setupOC();

  describe("line", () => {
    it("should create a line between two points", () => {
      const s = sketch("xy", () => {
        line([0, 0], [100, 0]);
      }) as Sketch;

      render();

      const shapes = s.getShapes();
      expect(shapes.length).toBeGreaterThan(0);
    });
  });

  describe("hLine", () => {
    it("should create a horizontal line and form a closed rect", () => {
      sketch("xy", () => {
        hLine(80);
        vLine(40);
        hLine(-80);
        vLine(-40);
      });
      const e = extrude(10) as ExtrudeBase;
      render();

      const solid = e.getShapes()[0] as Solid;
      const bbox = ShapeOps.getBoundingBox(solid);
      expect(bbox.maxX - bbox.minX).toBeCloseTo(80, 0);
      expect(bbox.maxY - bbox.minY).toBeCloseTo(40, 0);
    });

    it("should support standalone mode with targetPlane", () => {
      hLine(50, "xy");
      render();
      // Just verify no error — standalone line doesn't form a closed shape
    });
  });

  describe("vLine", () => {
    it("should create a vertical line and form a closed rect", () => {
      sketch("xy", () => {
        vLine(60);
        hLine(40);
        vLine(-60);
        hLine(-40);
      });
      const e = extrude(10) as ExtrudeBase;
      render();

      const solid = e.getShapes()[0] as Solid;
      const bbox = ShapeOps.getBoundingBox(solid);
      expect(bbox.maxX - bbox.minX).toBeCloseTo(40, 0);
      expect(bbox.maxY - bbox.minY).toBeCloseTo(60, 0);
    });
  });

  describe("aLine", () => {
    it("should create an angled line", () => {
      sketch("xy", () => {
        hLine(50);
        aLine(50, 90);
        hLine(-50);
        vLine(-50);
      });
      const e = extrude(10) as ExtrudeBase;
      render();

      expect(e.getShapes()).toHaveLength(1);
    });
  });

  describe("combined line functions", () => {
    it("should create an L-shape with hLine and vLine", () => {
      sketch("xy", () => {
        hLine(100);
        vLine(50);
        hLine(-60);
        vLine(30);
        hLine(-40);
        vLine(-80);
      });
      const e = extrude(10) as ExtrudeBase;
      render();

      const solid = e.getShapes()[0] as Solid;
      // L-shape has more than 6 faces
      expect(solid.getFaces().length).toBeGreaterThan(6);
    });
  });
});
