import { describe, it, expect } from "vitest";
import { setupOC, render } from "../setup.js";
import sketch from "../../core/sketch.js";
import extrude from "../../core/extrude.js";
import subtract from "../../core/subtract.js";
import cylinder from "../../core/cylinder.js";
import { circle, move, rect } from "../../core/2d/index.js";
import { Solid } from "../../common/solid.js";
import { countShapes } from "../utils.js";
import { ShapeOps } from "../../oc/shape-ops.js";

describe("subtract", () => {
  setupOC();

  describe("basic subtraction", () => {
    it("should subtract one solid from another", () => {
      sketch("xy", () => {
        rect(100, 100);
      });
      const box = extrude(50).fuse("none");

      const cyl = cylinder(20, 50);

      const s = subtract(box, cyl);

      render();

      const shapes = s.getShapes();
      expect(shapes).toHaveLength(1);
      expect(shapes[0].getType()).toBe("solid");

      // Subtracted solid should have more faces than a simple box
      const solid = shapes[0] as Solid;
      expect(solid.getFaces().length).toBeGreaterThan(6);
    });

    it("should remove original shapes from both operands", () => {
      sketch("xy", () => {
        rect(100, 100);
      });
      const box = extrude(50).fuse("none");

      const cyl = cylinder(20, 50);

      subtract(box, cyl);

      render();

      expect(box.getShapes()).toHaveLength(0);
      expect(cyl.getShapes()).toHaveLength(0);
    });

    it("should produce a single solid in the scene", () => {
      sketch("xy", () => {
        rect(100, 100);
      });
      const box = extrude(50).fuse("none");

      const cyl = cylinder(20, 50);

      subtract(box, cyl);

      const scene = render();

      expect(countShapes(scene)).toBe(1);
    });
  });

  describe("subtraction geometry", () => {
    it("should preserve outer dimensions of the stock", () => {
      sketch("xy", () => {
        rect(100, 100);
      });
      const box = extrude(50).fuse("none");

      const cyl = cylinder(20, 50);

      const s = subtract(box, cyl);

      render();

      const bbox = ShapeOps.getBoundingBox(s.getShapes()[0]);
      expect(bbox.minX).toBeCloseTo(0, 0);
      expect(bbox.maxX).toBeCloseTo(100, 0);
      expect(bbox.minY).toBeCloseTo(0, 0);
      expect(bbox.maxY).toBeCloseTo(100, 0);
      expect(bbox.maxZ).toBeCloseTo(50, 0);
    });

    it("should subtract a smaller box from a larger box", () => {
      sketch("xy", () => {
        rect(100, 100);
      });
      const bigBox = extrude(50).fuse("none");

      sketch("xy", () => {
        move([25, 25]);
        rect(50, 50);
      });
      const smallBox = extrude(50).fuse("none");

      const s = subtract(bigBox, smallBox);

      render();

      const shapes = s.getShapes();
      expect(shapes).toHaveLength(1);

      // U-shaped result should have more than 6 faces
      const solid = shapes[0] as Solid;
      expect(solid.getFaces().length).toBeGreaterThan(6);
    });

    it("should handle non-intersecting solids", () => {
      sketch("xy", () => {
        rect(50, 50);
      });
      const box = extrude(30).fuse("none");

      sketch("xy", () => {
        move([200, 200]);
        rect(50, 50);
      });
      const farBox = extrude(30).fuse("none");

      const s = subtract(box, farBox);

      render();

      // Stock should remain unchanged as a simple box
      const shapes = s.getShapes();
      expect(shapes).toHaveLength(1);

      const solid = shapes[0] as Solid;
      expect(solid.getFaces()).toHaveLength(6);
    });
  });
});
