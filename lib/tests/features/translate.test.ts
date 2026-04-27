import { describe, it, expect } from "vitest";
import { setupOC, render } from "../setup.js";
import sketch from "../../core/sketch.js";
import extrude from "../../core/extrude.js";
import translate from "../../core/translate.js";
import { rect } from "../../core/2d/index.js";
import { ExtrudeBase } from "../../features/extrude-base.js";
import { SceneObject } from "../../common/scene-object.js";
import { countShapes } from "../utils.js";
import { ShapeOps } from "../../oc/shape-ops.js";

describe("translate", () => {
  setupOC();

  describe("translate along axes", () => {
    it("should translate along X", () => {
      sketch("xy", () => {
        rect(20, 20);
      });
      const e = extrude(10).new() as ExtrudeBase;

      const t = translate(50, e) as unknown as SceneObject;

      render();

      const shapes = t.getShapes();
      expect(shapes).toHaveLength(1);

      const bbox = ShapeOps.getBoundingBox(shapes[0]);
      expect(bbox.minX).toBeCloseTo(50, 0);
      expect(bbox.maxX).toBeCloseTo(70, 0);
    });

    it("should translate along X and Y", () => {
      sketch("xy", () => {
        rect(20, 20);
      });
      const e = extrude(10).new() as ExtrudeBase;

      const t = translate(30, 40, e) as unknown as SceneObject;

      render();

      const shapes = t.getShapes();
      const bbox = ShapeOps.getBoundingBox(shapes[0]);
      expect(bbox.minX).toBeCloseTo(30, 0);
      expect(bbox.minY).toBeCloseTo(40, 0);
    });

    it("should translate along X, Y, and Z", () => {
      sketch("xy", () => {
        rect(20, 20);
      });
      const e = extrude(10).new() as ExtrudeBase;

      const t = translate(10, 20, 30, e) as unknown as SceneObject;

      render();

      const shapes = t.getShapes();
      const bbox = ShapeOps.getBoundingBox(shapes[0]);
      expect(bbox.minX).toBeCloseTo(10, 0);
      expect(bbox.minY).toBeCloseTo(20, 0);
      expect(bbox.minZ).toBeCloseTo(30, 0);
    });
  });

  describe("translate with point", () => {
    it("should translate by a point-like offset", () => {
      sketch("xy", () => {
        rect(20, 20);
      });
      const e = extrude(10).new() as ExtrudeBase;

      const t = translate([15, 25, 35], e) as unknown as SceneObject;

      render();

      const shapes = t.getShapes();
      const bbox = ShapeOps.getBoundingBox(shapes[0]);
      expect(bbox.minX).toBeCloseTo(15, 0);
      expect(bbox.minY).toBeCloseTo(25, 0);
      expect(bbox.minZ).toBeCloseTo(35, 0);
    });
  });

  describe("move vs copy", () => {
    it("should move the original (remove from source) by default", () => {
      sketch("xy", () => {
        rect(20, 20);
      });
      const e = extrude(10).new() as ExtrudeBase;

      translate(50, e);

      render();

      // Original removed, only translated shape remains
      expect(e.getShapes()).toHaveLength(0);
    });

    it("should keep the original when copy is true", () => {
      sketch("xy", () => {
        rect(20, 20);
      });
      const e = extrude(10).new() as ExtrudeBase;

      translate(50, true, e);

      render();

      // Original preserved
      expect(e.getShapes()).toHaveLength(1);
    });

    it("should produce two shapes in the scene when copy is true", () => {
      sketch("xy", () => {
        rect(20, 20);
      });
      const e = extrude(10).new() as ExtrudeBase;

      translate(50, true, e);

      const scene = render();

      // Original + copy = 2
      expect(countShapes(scene)).toBe(2);
    });
  });

  describe("translate specific target", () => {
    it("should only translate the specified object", () => {
      sketch("xy", () => {
        rect(20, 20);
      });
      const e1 = extrude(10).new() as ExtrudeBase;

      sketch("xy", () => {
        rect(20, 20);
      });
      const e2 = extrude(10).new() as ExtrudeBase;

      translate(100, e1);

      render();

      // e1 moved, e2 stays
      expect(e1.getShapes()).toHaveLength(0);
      expect(e2.getShapes()).toHaveLength(1);

      const bbox = ShapeOps.getBoundingBox(e2.getShapes()[0]);
      expect(bbox.minX).toBeCloseTo(0, 0);
    });
  });

  describe("translate with .exclude()", () => {
    it("should skip excluded objects when translating everything", () => {
      sketch("xy", () => {
        rect(20, 20);
      });
      const e1 = extrude(10).new() as ExtrudeBase;

      sketch("xy", () => {
        rect(20, 20);
      });
      const e2 = extrude(10).new() as ExtrudeBase;

      // No explicit target → translate all, exclude e1 → only e2 moves
      translate(100, true).exclude(e1);

      render();

      // e1 stays at origin
      expect(e1.getShapes()).toHaveLength(1);
      const e1Bbox = ShapeOps.getBoundingBox(e1.getShapes()[0]);
      expect(e1Bbox.minX).toBeCloseTo(0, 0);

      // e2 was copied to x=100 (original still present because copy=true)
      expect(e2.getShapes()).toHaveLength(1);
    });

    it("should narrow an explicit target list with exclude", () => {
      sketch("xy", () => {
        rect(20, 20);
      });
      const e1 = extrude(10).new() as ExtrudeBase;

      sketch("xy", () => {
        rect(20, 20);
      });
      const e2 = extrude(10).new() as ExtrudeBase;

      // Explicit targets [e1, e2], exclude e2 → only e1 moves
      translate(100, e1, e2).exclude(e2);

      render();

      // e1 moved (removed from source), e2 stays
      expect(e1.getShapes()).toHaveLength(0);
      expect(e2.getShapes()).toHaveLength(1);
      const e2Bbox = ShapeOps.getBoundingBox(e2.getShapes()[0]);
      expect(e2Bbox.minX).toBeCloseTo(0, 0);
    });

    it("should accumulate exclusions across chained calls", () => {
      sketch("xy", () => {
        rect(20, 20);
      });
      const e1 = extrude(10).new() as ExtrudeBase;

      sketch("xy", () => {
        rect(20, 20);
      });
      const e2 = extrude(10).new() as ExtrudeBase;

      sketch("xy", () => {
        rect(20, 20);
      });
      const e3 = extrude(10).new() as ExtrudeBase;

      // Translate all (copy), exclude e1 and e2 across two calls → only e3 copied
      translate(200, true).exclude(e1).exclude(e2);

      render();

      // All originals preserved (copy=true)
      expect(e1.getShapes()).toHaveLength(1);
      expect(e2.getShapes()).toHaveLength(1);
      expect(e3.getShapes()).toHaveLength(1);

      // e1 and e2 still at origin
      expect(ShapeOps.getBoundingBox(e1.getShapes()[0]).minX).toBeCloseTo(0, 0);
      expect(ShapeOps.getBoundingBox(e2.getShapes()[0]).minX).toBeCloseTo(0, 0);
    });
  });
});
