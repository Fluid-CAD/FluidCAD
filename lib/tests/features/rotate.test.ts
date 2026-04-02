import { describe, it, expect } from "vitest";
import { setupOC, render } from "../setup.js";
import sketch from "../../core/sketch.js";
import extrude from "../../core/extrude.js";
import rotate from "../../core/rotate.js";
import { rect, circle } from "../../core/2d/index.js";
import { ExtrudeBase } from "../../features/extrude-base.js";
import { SceneObject } from "../../common/scene-object.js";
import { countShapes } from "../utils.js";
import { ShapeOps } from "../../oc/shape-ops.js";

describe("rotate", () => {
  setupOC();

  describe("rotate around standard axes", () => {
    it("should rotate around the Z axis", () => {
      sketch("xy", () => {
        rect(20, 10);
      });
      const e = extrude(5).fuse("none") as ExtrudeBase;

      // Box at (0..20, 0..10). Rotate 90° around Z → should move to (-10..0, 0..20)
      const r = rotate("z", 90, e) as SceneObject;

      render();

      const shapes = r.getShapes();
      expect(shapes).toHaveLength(1);

      const bbox = ShapeOps.getBoundingBox(shapes[0]);
      expect(bbox.minX).toBeCloseTo(-10, 0);
      expect(bbox.maxX).toBeCloseTo(0, 0);
      expect(bbox.minY).toBeCloseTo(0, 0);
      expect(bbox.maxY).toBeCloseTo(20, 0);
    });

    it("should rotate around the X axis", () => {
      sketch("xy", () => {
        rect(20, 10);
      });
      const e = extrude(5).fuse("none") as ExtrudeBase;

      // Rotate 90° around X → Y becomes Z, Z becomes -Y
      const r = rotate("x", 90, e) as SceneObject;

      render();

      const shapes = r.getShapes();
      const bbox = ShapeOps.getBoundingBox(shapes[0]);
      expect(bbox.minZ).toBeCloseTo(0, 0);
      expect(bbox.maxZ).toBeCloseTo(10, 0);
    });

    it("should rotate around the Y axis", () => {
      sketch("xy", () => {
        rect(20, 10);
      });
      const e = extrude(5).fuse("none") as ExtrudeBase;

      // Rotate 90° around Y → X becomes -Z, Z becomes X
      const r = rotate("y", 90, e) as SceneObject;

      render();

      const shapes = r.getShapes();
      const bbox = ShapeOps.getBoundingBox(shapes[0]);
      expect(bbox.minX).toBeCloseTo(0, 0);
      expect(bbox.maxX).toBeCloseTo(5, 0);
    });
  });

  describe("move vs copy", () => {
    it("should move the original by default", () => {
      sketch("xy", () => {
        rect(20, 10);
      });
      const e = extrude(5).fuse("none") as ExtrudeBase;

      rotate("z", 90, e);

      render();

      expect(e.getShapes()).toHaveLength(0);
    });

    it("should keep the original when copy is true", () => {
      sketch("xy", () => {
        rect(20, 10);
      });
      const e = extrude(5).fuse("none") as ExtrudeBase;

      rotate("z", 90, true, e);

      render();

      expect(e.getShapes()).toHaveLength(1);
    });

    it("should produce two shapes in the scene when copy is true", () => {
      sketch("xy", () => {
        rect(20, 10);
      });
      const e = extrude(5).fuse("none") as ExtrudeBase;

      rotate("z", 90, true, e);

      const scene = render();

      expect(countShapes(scene)).toBe(2);
    });
  });

  describe("rotate specific target", () => {
    it("should only rotate the specified object", () => {
      sketch("xy", () => {
        rect(20, 10);
      });
      const e1 = extrude(5).fuse("none") as ExtrudeBase;

      sketch("xy", () => {
        rect(20, 10);
      });
      const e2 = extrude(5).fuse("none") as ExtrudeBase;

      rotate("z", 90, e1);

      render();

      expect(e1.getShapes()).toHaveLength(0);
      expect(e2.getShapes()).toHaveLength(1);

      // e2 should still be at original position
      const bbox = ShapeOps.getBoundingBox(e2.getShapes()[0]);
      expect(bbox.minX).toBeCloseTo(0, 0);
      expect(bbox.minY).toBeCloseTo(0, 0);
    });
  });

  describe("rotate by arbitrary angle", () => {
    it("should rotate by 45 degrees", () => {
      sketch("xy", () => {
        rect(20, 20);
      });
      const e = extrude(5).fuse("none") as ExtrudeBase;

      const r = rotate("z", 45, e) as SceneObject;

      render();

      const shapes = r.getShapes();
      const bbox = ShapeOps.getBoundingBox(shapes[0]);
      // A 20x20 square rotated 45° has a diagonal of ~28.3
      const width = bbox.maxX - bbox.minX;
      expect(width).toBeCloseTo(20 * Math.sqrt(2), 0);
    });

    it("should rotate by 180 degrees", () => {
      sketch("xy", () => {
        rect(20, 10);
      });
      const e = extrude(5).fuse("none") as ExtrudeBase;

      // Box at (0..20, 0..10). Rotate 180° around Z → (-20..0, -10..0)
      const r = rotate("z", 180, e) as SceneObject;

      render();

      const bbox = ShapeOps.getBoundingBox(r.getShapes()[0]);
      expect(bbox.minX).toBeCloseTo(-20, 0);
      expect(bbox.maxX).toBeCloseTo(0, 0);
      expect(bbox.minY).toBeCloseTo(-10, 0);
      expect(bbox.maxY).toBeCloseTo(0, 0);
    });
  });
});
