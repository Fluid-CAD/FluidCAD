import { describe, it, expect } from "vitest";
import { setupOC, render } from "../setup.js";
import sketch from "../../core/sketch.js";
import extrude from "../../core/extrude.js";
import subtract from "../../core/subtract.js";
import cylinder from "../../core/cylinder.js";
import sphere from "../../core/sphere.js";
import axis from "../../core/axis.js";
import revolve from "../../core/revolve.js";
import { circle, move, rect } from "../../core/2d/index.js";
import { Solid } from "../../common/solid.js";
import { Subtract } from "../../features/subtract.js";
import { ExtrudeBase } from "../../features/extrude-base.js";
import { Revolve } from "../../features/revolve.js";
import { SceneObject } from "../../common/scene-object.js";
import { countShapes } from "../utils.js";
import { ShapeOps } from "../../oc/shape-ops.js";

describe("subtract", () => {
  setupOC();

  describe("basic subtraction", () => {
    it("should subtract one solid from another", () => {
      sketch("xy", () => {
        rect(100, 100);
      });
      const box = extrude(50).new() as ExtrudeBase;

      const cyl = cylinder(20, 50) as unknown as SceneObject;

      const s = subtract(box, cyl) as Subtract;

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
      const box = extrude(50).new() as ExtrudeBase;

      const cyl = cylinder(20, 50) as unknown as SceneObject;

      subtract(box, cyl);

      render();

      expect(box.getShapes()).toHaveLength(0);
      expect(cyl.getShapes()).toHaveLength(0);
    });

    it("should produce a single solid in the scene", () => {
      sketch("xy", () => {
        rect(100, 100);
      });
      const box = extrude(50).new() as ExtrudeBase;

      const cyl = cylinder(20, 50) as unknown as SceneObject;

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
      const box = extrude(50).new() as ExtrudeBase;

      const cyl = cylinder(20, 50) as unknown as SceneObject;

      const s = subtract(box, cyl) as Subtract;

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
      const bigBox = extrude(50).new() as ExtrudeBase;

      sketch("xy", () => {
        move([25, 25]);
        rect(50, 50);
      });
      const smallBox = extrude(50).new() as ExtrudeBase;

      const s = subtract(bigBox, smallBox) as Subtract;

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
      const box = extrude(30).new() as ExtrudeBase;

      sketch("xy", () => {
        move([200, 200]);
        rect(50, 50);
      });
      const farBox = extrude(30).new() as ExtrudeBase;

      const s = subtract(box, farBox) as Subtract;

      render();

      // Stock should remain unchanged as a simple box
      const shapes = s.getShapes();
      expect(shapes).toHaveLength(1);

      const solid = shapes[0] as Solid;
      expect(solid.getFaces()).toHaveLength(6);
    });

    // Repro for issue #46: a torus revolved on the -yz plane produced an
    // inside-out solid that caused subtract() to silently fail.
    it("should subtract a revolved torus built on the -yz plane", () => {
      const s = sphere(10) as unknown as SceneObject;
      const a = axis("y", { offsetZ: 20 });
      sketch("-yz", () => {
        circle([0, 1], 5);
      });
      const ringHole = revolve(a).new() as Revolve;

      const result = subtract(s, ringHole) as Subtract;

      render();

      // Sphere (r=10) and torus (centered at z=20, tube r=5) don't intersect,
      // so the subtract should leave the sphere intact.
      const shapes = result.getShapes();
      expect(shapes).toHaveLength(1);
      expect(shapes[0].getType()).toBe("solid");
    });
  });
});
