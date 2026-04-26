import { describe, it, expect } from "vitest";
import { setupOC, render } from "../../setup.js";
import sketch from "../../../core/sketch.js";
import extrude from "../../../core/extrude.js";
import { ellipse } from "../../../core/2d/index.js";
import { Ellipse } from "../../../features/2d/ellipse.js";
import { ExtrudeBase } from "../../../features/extrude-base.js";
import { Solid } from "../../../common/solid.js";
import { ShapeOps } from "../../../oc/shape-ops.js";

describe("ellipse", () => {
  setupOC();

  describe("in sketch", () => {
    it("creates an ellipse with rx along X and ry along Y", () => {
      sketch("xy", () => {
        ellipse(50, 30);
      });
      const e = extrude(10) as ExtrudeBase;
      render();

      const solid = e.getShapes()[0] as Solid;
      const bbox = ShapeOps.getBoundingBox(solid);
      expect(bbox.maxX - bbox.minX).toBeCloseTo(100, 0);
      expect(bbox.maxY - bbox.minY).toBeCloseTo(60, 0);
    });

    it("handles ry > rx (axis-swap path)", () => {
      sketch("xy", () => {
        ellipse(30, 50);
      });
      const e = extrude(10) as ExtrudeBase;
      render();

      const solid = e.getShapes()[0] as Solid;
      const bbox = ShapeOps.getBoundingBox(solid);
      expect(bbox.maxX - bbox.minX).toBeCloseTo(60, 0);
      expect(bbox.maxY - bbox.minY).toBeCloseTo(100, 0);
    });

    it("creates an ellipse at a given center", () => {
      sketch("xy", () => {
        ellipse([50, 30], 40, 20);
      });
      const e = extrude(10) as ExtrudeBase;
      render();

      const bbox = ShapeOps.getBoundingBox(e.getShapes()[0]);
      expect(bbox.centerX).toBeCloseTo(50, 0);
      expect(bbox.centerY).toBeCloseTo(30, 0);
      expect(bbox.maxX - bbox.minX).toBeCloseTo(80, 0);
      expect(bbox.maxY - bbox.minY).toBeCloseTo(40, 0);
    });

    it("falls through to a circle when rx == ry", () => {
      sketch("xy", () => {
        ellipse(25, 25);
      });
      const e = extrude(10) as ExtrudeBase;
      render();

      const solid = e.getShapes()[0] as Solid;
      const bbox = ShapeOps.getBoundingBox(solid);
      expect(bbox.maxX - bbox.minX).toBeCloseTo(50, 0);
      expect(bbox.maxY - bbox.minY).toBeCloseTo(50, 0);
    });

    it("rejects zero or negative radii", () => {
      let zeroEllipse: Ellipse | undefined;
      sketch("xy", () => {
        zeroEllipse = ellipse(0, 30) as Ellipse;
      });
      render();
      expect(zeroEllipse?.getError()).toMatch(/positive/i);

      let negEllipse: Ellipse | undefined;
      sketch("xy", () => {
        negEllipse = ellipse(-10, 5) as Ellipse;
      });
      render();
      expect(negEllipse?.getError()).toMatch(/positive/i);
    });

    it("throws when given a plane inside a sketch", () => {
      expect(() => {
        sketch("xy", () => {
          (ellipse as any)("xy", 30, 20);
        });
        render();
      }).toThrow();
    });
  });

  describe("standalone with targetPlane", () => {
    it("creates an ellipse on a specific plane", () => {
      ellipse("xy", 60, 40);
      const e = extrude(10) as ExtrudeBase;
      render();

      const solid = e.getShapes()[0] as Solid;
      const bbox = ShapeOps.getBoundingBox(solid);
      expect(bbox.maxX - bbox.minX).toBeCloseTo(120, 0);
      expect(bbox.maxY - bbox.minY).toBeCloseTo(80, 0);
    });

    it("creates an ellipse on a plane at a given center", () => {
      ellipse("xy", [10, 20], 30, 15);
      const e = extrude(10) as ExtrudeBase;
      render();

      const solid = e.getShapes()[0] as Solid;
      const bbox = ShapeOps.getBoundingBox(solid);
      expect(bbox.centerX).toBeCloseTo(10, 0);
      expect(bbox.centerY).toBeCloseTo(20, 0);
      expect(bbox.maxX - bbox.minX).toBeCloseTo(60, 0);
      expect(bbox.maxY - bbox.minY).toBeCloseTo(30, 0);
    });
  });
});
