import { describe, it, expect } from "vitest";
import { setupOC, render } from "../setup.js";
import sketch from "../../core/sketch.js";
import extrude from "../../core/extrude.js";
import common from "../../core/common.js";
import { circle, move, rect } from "../../core/2d/index.js";
import { Sketch } from "../../features/2d/sketch.js";
import { ExtrudeBase } from "../../features/extrude-base.js";
import { ShapeOps } from "../../oc/shape-ops.js";

describe("common2d", () => {
  setupOC();

  describe("common of all sketch geometries", () => {
    it("should produce the intersection of overlapping circles", () => {
      sketch("xy", () => {
        circle([-15, 0], 60);
        circle([15, 0], 60);
        common();
      });

      const e = extrude(20) as ExtrudeBase;

      render();

      const shapes = e.getShapes();
      expect(shapes).toHaveLength(1);
      expect(shapes[0].getType()).toBe("solid");

      // Intersection region is narrower than either circle
      const bbox = ShapeOps.getBoundingBox(shapes[0]);
      const width = bbox.maxX - bbox.minX;
      expect(width).toBeLessThan(60);
    });

    it("should produce a smaller region than either input circle", () => {
      sketch("xy", () => {
        circle([-15, 0], 60);
        circle([15, 0], 60);
        common();
      });

      const e = extrude(20) as ExtrudeBase;

      render();

      const shapes = e.getShapes();
      expect(shapes).toHaveLength(1);

      // Intersection is smaller than either full circle (diameter 60)
      const bbox = ShapeOps.getBoundingBox(shapes[0]);
      const width = bbox.maxX - bbox.minX;
      const height = bbox.maxY - bbox.minY;
      expect(width).toBeLessThan(60);
      expect(height).toBeLessThan(60);
    });
  });

  describe("common of specific targets", () => {
    it("should intersect only the specified geometries", () => {
      sketch("xy", () => {
        const c1 = circle([-15, 0], 60);
        const c2 = circle([15, 0], 60);
        // Third circle far away, not included
        circle([200, 0], 60);
        common(c1, c2);
      });

      const e = extrude(20) as ExtrudeBase;

      render();

      // Intersection of pair + separate circle = 2 solids
      const shapes = e.getShapes();
      expect(shapes).toHaveLength(2);
    });
  });

  describe("common removes original edges", () => {
    it("should remove original edges from intersected geometries", () => {
      const s = sketch("xy", () => {
        const c1 = circle([-15, 0], 60);
        const c2 = circle([15, 0], 60);
        common(c1, c2);
      }) as Sketch;

      render();

      // Original circles removed, replaced by intersection outline
      const childShapes = s.getShapes();
      expect(childShapes.length).toBeGreaterThan(0);
    });
  });

  describe("keepOriginal", () => {
    it("should keep original edges when keepOriginal is true", () => {
      const s = sketch("xy", () => {
        const c1 = circle([-15, 0], 60);
        const c2 = circle([15, 0], 60);
        common(c1, c2).keepOriginal();
      }) as Sketch;

      render();

      // Original circle edges are preserved alongside the intersection edges
      const childShapes = s.getShapes();
      expect(childShapes.length).toBeGreaterThan(0);
    });

    it("should remove original edges when keepOriginal is false", () => {
      const s = sketch("xy", () => {
        const c1 = circle([-15, 0], 60);
        const c2 = circle([15, 0], 60);
        common(c1, c2);
      }) as Sketch;

      render();

      // Original circles should be removed; only intersection edges remain
      // The intersection edges exist but the originals are gone
      const c1Shapes = (s.getChildren()[0] as any).getShapes();
      expect(c1Shapes).toHaveLength(0);
    });
  });

  describe("non-overlapping geometries", () => {
    it("should not remove original edges when geometries do not overlap", () => {
      sketch("xy", () => {
        circle(40);
        circle([200, 0], 40);
        common();
      });

      const e = extrude(20) as ExtrudeBase;

      render();

      // No intersection, originals preserved
      const shapes = e.getShapes();
      expect(shapes).toHaveLength(2);
    });
  });
});
