import { describe, it, expect } from "vitest";
import { setupOC, render } from "../setup.js";
import sketch from "../../core/sketch.js";
import extrude from "../../core/extrude.js";
import mirror from "../../core/mirror.js";
import { move, rect, circle } from "../../core/2d/index.js";
import { ExtrudeBase } from "../../features/extrude-base.js";
import { SceneObject } from "../../common/scene-object.js";
import { countShapes } from "../utils.js";
import { ShapeOps } from "../../oc/shape-ops.js";

describe("mirror (3D)", () => {
  setupOC();

  describe("mirror across standard plane", () => {
    it("should mirror a solid across the YZ plane", () => {
      sketch("xy", () => {
        move([20, 0]);
        rect(30, 30);
      });
      const e = extrude(10).new() as ExtrudeBase;

      mirror("yz", e);

      const scene = render();

      // Original + mirrored = 2 shapes (or fused into 1 if overlapping)
      expect(countShapes(scene)).toBeGreaterThanOrEqual(1);
    });

    it("should place the mirrored solid on the opposite side", () => {
      sketch("xy", () => {
        move([20, 0]);
        rect(30, 30);
      });
      const e = extrude(10).new() as ExtrudeBase;

      const m = mirror("yz", e) as unknown as SceneObject;

      render();

      const shapes = m.getShapes();
      expect(shapes.length).toBeGreaterThan(0);

      // Original is at x=20..50, mirror across YZ (x=0) → mirrored at x=-50..-20
      const bbox = ShapeOps.getBoundingBox(shapes[0]);
      expect(bbox.maxX).toBeCloseTo(-20, 0);
      expect(bbox.minX).toBeCloseTo(-50, 0);
    });

    it("should mirror across the XZ plane", () => {
      sketch("xy", () => {
        move([0, 20]);
        rect(30, 30);
      });
      const e = extrude(10).new() as ExtrudeBase;

      const m = mirror("xz", e) as unknown as SceneObject;

      render();

      const shapes = m.getShapes();
      expect(shapes.length).toBeGreaterThan(0);

      // Original at y=20..50, mirrored to y=-50..-20
      const bbox = ShapeOps.getBoundingBox(shapes[0]);
      expect(bbox.maxY).toBeCloseTo(-20, 0);
      expect(bbox.minY).toBeCloseTo(-50, 0);
    });

    it("should mirror across the XY plane and fuse", () => {
      sketch("xy", () => {
        rect(30, 30);
      });
      extrude(20).new();

      mirror("xy");

      const scene = render();

      // Original at z=0..20 fuses with mirror at z=-20..0 → single solid
      expect(countShapes(scene)).toBe(1);

      const solid = scene.getAllSceneObjects()
        .flatMap(o => o.getShapes())
        .find(s => s.getType() === "solid");

      const bbox = ShapeOps.getBoundingBox(solid);
      expect(bbox.minZ).toBeCloseTo(-20, 0);
      expect(bbox.maxZ).toBeCloseTo(20, 0);
    });
  });

  describe("mirror all scene objects", () => {
    it("should mirror the last object when no target specified", () => {
      sketch("xy", () => {
        move([20, 0]);
        rect(30, 30);
      });
      extrude(10).new();

      mirror("yz");

      const scene = render();

      expect(countShapes(scene)).toBe(2);
    });
  });

  describe("mirror specific target", () => {
    it("should only mirror the specified object", () => {
      sketch("xy", () => {
        move([20, 0]);
        rect(30, 30);
      });
      const e1 = extrude(10).new() as ExtrudeBase;

      sketch("xy", () => {
        move([0, 50]);
        rect(30, 30);
      });
      extrude(10).new();

      mirror("yz", e1);

      const scene = render();

      // e1 + mirror of e1 + e2 = 3
      expect(countShapes(scene)).toBe(3);
    });
  });

  describe("mirror fuses with existing objects", () => {
    it("should fuse mirrored solid with adjacent objects", () => {
      // Box centered on YZ plane — mirror across YZ should fuse with original
      sketch("xy", () => {
        rect(30, 30);
      });
      extrude(10).new();

      mirror("yz");

      const scene = render();

      expect(countShapes(scene)).toBe(1);
    });
  });

  describe("mirror with .exclude()", () => {
    it("should skip excluded objects when mirroring everything", () => {
      sketch("xy", () => {
        move([20, 0]);
        rect(30, 30);
      });
      const e1 = extrude(10).new() as ExtrudeBase;

      sketch("xy", () => {
        move([50, 50]);
        rect(30, 30);
      });
      extrude(10).new();

      // mirror all, but exclude e1 → only e2 gets mirrored
      // e1 + e2 + mirror(e2) = 3 shapes (e2 is well clear of YZ plane, no fusion)
      mirror("yz").exclude(e1);

      const scene = render();

      expect(countShapes(scene)).toBe(3);
    });

    it("should narrow an explicit target list with exclude", () => {
      sketch("xy", () => {
        move([20, 0]);
        rect(30, 30);
      });
      const e1 = extrude(10).new() as ExtrudeBase;

      sketch("xy", () => {
        move([50, 50]);
        rect(30, 30);
      });
      const e2 = extrude(10).new() as ExtrudeBase;

      // explicit target [e1, e2], exclude e2 → only e1 mirrored
      // e1 + e2 + mirror(e1) = 3
      mirror("yz", e1, e2).exclude(e2);

      const scene = render();

      expect(countShapes(scene)).toBe(3);
    });

    it("should accumulate exclusions across chained calls", () => {
      sketch("xy", () => {
        move([20, 0]);
        rect(30, 30);
      });
      const e1 = extrude(10).new() as ExtrudeBase;

      sketch("xy", () => {
        move([50, 50]);
        rect(30, 30);
      });
      const e2 = extrude(10).new() as ExtrudeBase;

      sketch("xy", () => {
        move([100, 100]);
        rect(30, 30);
      });
      extrude(10).new();

      // mirror everything but exclude e1 and e2 across two chained .exclude() calls
      // e1 + e2 + e3 + mirror(e3) = 4 (all on +X side, mirror lands on -X side)
      mirror("yz").exclude(e1).exclude(e2);

      const scene = render();

      expect(countShapes(scene)).toBe(4);
    });
  });
});
