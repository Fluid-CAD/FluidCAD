import { describe, it, expect } from "vitest";
import { setupOC, render } from "../setup.js";
import sketch from "../../core/sketch.js";
import extrude from "../../core/extrude.js";
import { circle, rect, line, hLine, vLine } from "../../core/2d/index.js";
import { ShapeOps } from "../../oc/shape-ops.js";
import { ExtrudeBase } from "../../features/extrude-base.js";

describe("thin extrude", () => {
  setupOC();

  describe("closed profile", () => {
    it("should create a thin-walled solid with single offset", () => {
      sketch("xy", () => {
        rect(100, 100);
      });

      const e = extrude(30).thin(5) as ExtrudeBase;

      render();

      const shapes = e.getShapes();
      expect(shapes).toHaveLength(1);
      expect(shapes[0].getType()).toBe('solid');

      const bbox = ShapeOps.getBoundingBox(shapes[0]);
      expect(bbox.maxZ - bbox.minZ).toBeCloseTo(30, 0);
    });

    it("should create a thin-walled solid with dual offset", () => {
      sketch("xy", () => {
        rect(100, 100);
      });

      const e = extrude(20).thin(5, -3).new() as ExtrudeBase;

      render();

      const shapes = e.getShapes();
      expect(shapes).toHaveLength(1);
      expect(shapes[0].getType()).toBe('solid');

      const bbox = ShapeOps.getBoundingBox(shapes[0]);
      expect(bbox.maxZ - bbox.minZ).toBeCloseTo(20, 0);
    });

    it("should create a thin-walled solid from a circle", () => {
      sketch("xy", () => {
        circle(50);
      });

      const e = extrude(25).thin(10).new() as ExtrudeBase;

      render();

      const shapes = e.getShapes();
      expect(shapes).toHaveLength(1);
      expect(shapes[0].getType()).toBe('solid');

      const bbox = ShapeOps.getBoundingBox(shapes[0]);
      // circle(50) = diameter 50 = radius 25. Outer radius = 25 + 10 = 35, so width = 70
      expect(bbox.maxX - bbox.minX).toBeCloseTo(70, 0);
      expect(bbox.maxZ - bbox.minZ).toBeCloseTo(25, 0);
    });
  });

  describe("offset direction", () => {
    it("should offset inward with a negative value", () => {
      sketch("xy", () => {
        rect(100, 100);
      });

      const e = extrude(20).thin(-5).new() as ExtrudeBase;

      render();

      const shapes = e.getShapes();
      expect(shapes).toHaveLength(1);
      expect(shapes[0].getType()).toBe('solid');

      const bbox = ShapeOps.getBoundingBox(shapes[0]);
      // Original rect is 100x100 centered. Inward offset by 5 means outer = original (100),
      // inner = 90. So bounding box should be 100x100.
      expect(bbox.maxX - bbox.minX).toBeCloseTo(100, 0);
      expect(bbox.maxY - bbox.minY).toBeCloseTo(100, 0);
    });
  });

  describe("open profile", () => {
    it("should create a thin-walled solid from an open profile with single offset", () => {
      sketch("xy", () => {
        line([0, 0], [100, 0]);
      });

      const e = extrude(20).thin(10).new() as ExtrudeBase;

      render();

      const shapes = e.getShapes();
      expect(shapes).toHaveLength(1);
      expect(shapes[0].getType()).toBe('solid');

      const bbox = ShapeOps.getBoundingBox(shapes[0]);
      expect(bbox.maxX - bbox.minX).toBeCloseTo(100, 0);
      expect(bbox.maxZ - bbox.minZ).toBeCloseTo(20, 0);
    });

    it("should create a thin-walled solid from an open profile with dual offset", () => {
      sketch("xy", () => {
        line([0, 0], [100, 0]);
      });

      const e = extrude(20).thin(5, -10).new() as ExtrudeBase;

      render();

      const shapes = e.getShapes();
      expect(shapes).toHaveLength(1);
      expect(shapes[0].getType()).toBe('solid');

      const bbox = ShapeOps.getBoundingBox(shapes[0]);
      expect(bbox.maxX - bbox.minX).toBeCloseTo(100, 0);
      // Total Y extent = |5| + |-10| = 15
      expect(bbox.maxY - bbox.minY).toBeCloseTo(15, 0);
      expect(bbox.maxZ - bbox.minZ).toBeCloseTo(20, 0);
    });

    it("should create a thin-walled solid from an L-shaped open profile", () => {
      sketch("xy", () => {
        hLine([0, 0], 50);
        vLine(50);
      });

      const e = extrude(15).thin(5).new() as ExtrudeBase;

      render();

      const shapes = e.getShapes();
      expect(shapes).toHaveLength(1);
      expect(shapes[0].getType()).toBe('solid');
    });
  });

  describe("two-distance extrude", () => {
    it("should create a thin-walled solid with two distances", () => {
      sketch("xy", () => {
        rect(80, 80);
      });

      const e = extrude(20, 10).thin(5).new() as ExtrudeBase;

      render();

      const shapes = e.getShapes();
      expect(shapes).toHaveLength(1);
      expect(shapes[0].getType()).toBe('solid');

      const bbox = ShapeOps.getBoundingBox(shapes[0]);
      expect(bbox.maxZ - bbox.minZ).toBeCloseTo(30, 0);
    });
  });

  describe("remove mode", () => {
    it("should cut a thin-walled shape from existing geometry", () => {
      sketch("xy", () => {
        rect(200, 200);
      });
      extrude(50);

      render();

      sketch("xy", () => {
        rect(100, 100);
      });
      const e = extrude(50).thin(10).remove() as ExtrudeBase;

      render();

      const shapes = e.getShapes();
      expect(shapes.length).toBeGreaterThan(0);
    });
  });
});
