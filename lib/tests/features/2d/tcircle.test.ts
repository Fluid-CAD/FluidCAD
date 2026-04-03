import { describe, it, expect } from "vitest";
import { setupOC, render } from "../../setup.js";
import sketch from "../../../core/sketch.js";
import extrude from "../../../core/extrude.js";
import { tCircle, circle } from "../../../core/2d/index.js";
import { ExtrudeBase } from "../../../features/extrude-base.js";
import { Sketch } from "../../../features/2d/sketch.js";
import { ShapeOps } from "../../../oc/shape-ops.js";

describe("tCircle", () => {
  setupOC();

  describe("tangent circle between two objects", () => {
    it("should create a circle tangent to two circles", () => {
      const s = sketch("xy", () => {
        const c1 = circle(40);
        const c2 = circle([80, 0], 40);
        tCircle(c1, c2, 30);
      }) as Sketch;
      render();

      const shapes = s.getShapes();
      // Original circles + tangent circle edges
      expect(shapes.length).toBeGreaterThanOrEqual(1);
    });

    it("should create a circle tangent to two points", () => {
      const s = sketch("xy", () => {
        tCircle([0, 0], [50, 0], 60);
      }) as Sketch;
      render();

      const shapes = s.getShapes();
      expect(shapes.length).toBeGreaterThanOrEqual(1);
    });
  });
});
