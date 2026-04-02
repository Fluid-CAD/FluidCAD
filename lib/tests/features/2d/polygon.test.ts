import { describe, it, expect } from "vitest";
import { setupOC, render } from "../../setup.js";
import sketch from "../../../core/sketch.js";
import extrude from "../../../core/extrude.js";
import { polygon } from "../../../core/2d/index.js";
import { ExtrudeBase } from "../../../features/extrude-base.js";
import { Solid } from "../../../common/solid.js";
import { Sketch } from "../../../features/2d/sketch.js";
import { ShapeOps } from "../../../oc/shape-ops.js";
import { getEdgesByType, getBoundingBoxOfShapes } from "../../utils.js";

describe("polygon", () => {
  setupOC();

  describe("face and edge count", () => {
    it("should create a triangle (5 faces, 9 edges)", () => {
      sketch("xy", () => {
        polygon(3, 30);
      });
      const e = extrude(10) as ExtrudeBase;
      render();

      const solid = e.getShapes()[0] as Solid;
      expect(solid.getFaces()).toHaveLength(5);
      expect(getEdgesByType(solid, "line")).toHaveLength(9);
    });

    it("should create a hexagon (8 faces, 18 edges)", () => {
      sketch("xy", () => {
        polygon(6, 30);
      });
      const e = extrude(10) as ExtrudeBase;
      render();

      const solid = e.getShapes()[0] as Solid;
      expect(solid.getFaces()).toHaveLength(8);
      expect(getEdgesByType(solid, "line")).toHaveLength(18);
    });

    it("should create an octagon (10 faces, 24 edges)", () => {
      sketch("xy", () => {
        polygon(8, 30);
      });
      const e = extrude(10) as ExtrudeBase;
      render();

      const solid = e.getShapes()[0] as Solid;
      expect(solid.getFaces()).toHaveLength(10);
      expect(getEdgesByType(solid, "line")).toHaveLength(24);
    });
  });

  describe("inscribed mode (default)", () => {
    it("should place vertices on the circle of given radius", () => {
      const radius = 40;

      // Hexagon inscribed: vertices at distance R from center, bbox width = 2R
      const s = sketch("xy", () => {
        polygon(6, radius);
      }) as Sketch;
      render();

      const shapes = s.getShapes({ excludeMeta: true });
      const bbox = getBoundingBoxOfShapes(shapes);
      expect(bbox.maxX - bbox.minX).toBeCloseTo(2 * radius, 0);
    });

    it("should produce a square with bbox = 2R x 2R", () => {
      const radius = 30;

      // Square inscribed: 4 vertices at angles 0, 90, 180, 270 → bbox = 2R x 2R
      const s = sketch("xy", () => {
        polygon(4, radius);
      }) as Sketch;
      render();

      const shapes = s.getShapes({ excludeMeta: true });
      const bbox = getBoundingBoxOfShapes(shapes);
      expect(bbox.maxX - bbox.minX).toBeCloseTo(2 * radius, 0);
      expect(bbox.maxY - bbox.minY).toBeCloseTo(2 * radius, 0);
    });
  });

  describe("circumscribed mode", () => {
    it("should produce a larger shape than inscribed with same radius", () => {
      const radius = 30;

      const s1 = sketch("xy", () => {
        polygon(6, radius, "inscribed");
      }) as Sketch;
      render();
      const inscribedBbox = ShapeOps.getBoundingBox(s1.getShapes({ excludeMeta: true })[0]);
      const inscribedWidth = inscribedBbox.maxX - inscribedBbox.minX;

      const s2 = sketch("xy", () => {
        polygon(6, radius, "circumscribed");
      }) as Sketch;
      render();
      const circumscribedBbox = ShapeOps.getBoundingBox(s2.getShapes({ excludeMeta: true })[0]);
      const circumscribedWidth = circumscribedBbox.maxX - circumscribedBbox.minX;

      expect(circumscribedWidth).toBeGreaterThan(inscribedWidth);
    });

    it("should have correct vertex radius for hexagon", () => {
      const radius = 30;
      const n = 6;

      // Circumscribed: vertices at radius / cos(π/n) from center
      const effectiveRadius = radius / Math.cos(Math.PI / n);

      const s = sketch("xy", () => {
        polygon(n, radius, "circumscribed");
      }) as Sketch;
      render();

      const shapes = s.getShapes({ excludeMeta: true });
      const bbox = getBoundingBoxOfShapes(shapes);
      expect(bbox.maxX - bbox.minX).toBeCloseTo(2 * effectiveRadius, 0);
    });

    it("should have correct vertex radius for square", () => {
      const radius = 25;
      const n = 4;

      // Circumscribed square: vertices at radius * sqrt(2) from center
      const effectiveRadius = radius / Math.cos(Math.PI / n);

      const s = sketch("xy", () => {
        polygon(n, radius, "circumscribed");
      }) as Sketch;
      render();

      const shapes = s.getShapes({ excludeMeta: true });
      const bbox = getBoundingBoxOfShapes(shapes);
      expect(bbox.maxX - bbox.minX).toBeCloseTo(2 * effectiveRadius, 0);
      expect(bbox.maxY - bbox.minY).toBeCloseTo(2 * effectiveRadius, 0);
    });
  });

  describe("center position", () => {
    it("should create a polygon at a given center", () => {
      sketch("xy", () => {
        polygon([50, 40], 6, 30);
      });
      const e = extrude(10) as ExtrudeBase;
      render();

      const bbox = ShapeOps.getBoundingBox(e.getShapes()[0]);
      expect(bbox.centerX).toBeCloseTo(50, 0);
      expect(bbox.centerY).toBeCloseTo(40, 0);
    });

    it("should center circumscribed polygon at given point", () => {
      sketch("xy", () => {
        polygon([20, 30], 6, 25, "circumscribed");
      });
      const e = extrude(10) as ExtrudeBase;
      render();

      const bbox = ShapeOps.getBoundingBox(e.getShapes()[0]);
      expect(bbox.centerX).toBeCloseTo(20, 0);
      expect(bbox.centerY).toBeCloseTo(30, 0);
    });
  });

  describe("standalone with targetPlane", () => {
    it("should create a polygon on a specific plane", () => {
      polygon(5, 25, "xy");
      const e = extrude(10) as ExtrudeBase;
      render();

      const solid = e.getShapes()[0] as Solid;
      expect(solid.getFaces()).toHaveLength(7);
    });

    it("should create a circumscribed polygon on a specific plane", () => {
      polygon(6, 30, "circumscribed", "xy");
      const e = extrude(10) as ExtrudeBase;
      render();

      const solid = e.getShapes()[0] as Solid;
      expect(solid.getFaces()).toHaveLength(8);
    });
  });
});
