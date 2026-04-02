import { describe, it, expect } from "vitest";
import { setupOC, render } from "../setup.js";
import sketch from "../../core/sketch.js";
import plane from "../../core/plane.js";
import loft from "../../core/loft.js";
import { move, rect, circle } from "../../core/2d/index.js";
import { Solid } from "../../common/solid.js";
import { Loft } from "../../features/loft.js";
import { Sketch } from "../../features/2d/sketch.js";
import { countShapes, getFacesByType, getEdgesByType } from "../utils.js";
import { ShapeOps } from "../../oc/shape-ops.js";
import { ShapeProps } from "../../oc/props.js";

describe("loft", () => {
  setupOC();

  describe("loft between two profiles", () => {
    it("should loft between two rects on parallel planes", () => {
      const s1 = sketch("xy", () => {
        rect(100, 50);
      });

      const s2 = sketch(plane("xy", { offset: 40 }), () => {
        rect(100, 50);
      });

      const l = loft(s1, s2) as Loft;

      render();

      const shapes = l.getShapes();
      expect(shapes).toHaveLength(1);
      expect(shapes[0].getType()).toBe("solid");
    });

    it("should span the correct height between profiles", () => {
      const s1 = sketch("xy", () => {
        rect(100, 50);
      });

      const s2 = sketch(plane("xy", { offset: 60 }), () => {
        rect(100, 50);
      });

      const l = loft(s1, s2) as Loft;

      render();

      const bbox = ShapeOps.getBoundingBox(l.getShapes()[0]);
      expect(bbox.minZ).toBeCloseTo(0, 0);
      expect(bbox.maxZ).toBeCloseTo(60, 0);
    });

    it("should loft between two circles of different radii", () => {
      const s1 = sketch("xy", () => {
        circle(40);
      });

      const s2 = sketch(plane("xy", { offset: 50 }), () => {
        circle(20);
      });

      const l = loft(s1, s2) as Loft;

      render();

      const shapes = l.getShapes();
      expect(shapes).toHaveLength(1);

      // Tapered loft — wider at bottom than top
      const bbox = ShapeOps.getBoundingBox(shapes[0]);
      const bottomWidth = 80; // 2 * 40
      const topWidth = 40;    // 2 * 20
      expect(bbox.maxX - bbox.minX).toBeCloseTo(bottomWidth, -1);
    });

    it("should produce a solid with positive volume", () => {
      const s1 = sketch("xy", () => {
        circle(30);
      });

      const s2 = sketch(plane("xy", { offset: 40 }), () => {
        circle(15);
      });

      const l = loft(s1, s2) as Loft;

      render();

      const props = ShapeProps.getProperties(l.getShapes()[0].getShape());
      expect(props.volumeMm3).toBeGreaterThan(0);
    });
  });

  describe("loft between different shapes", () => {
    it("should loft between a rect and a circle", () => {
      const s1 = sketch("xy", () => {
        rect(60, 60).center();
      });

      const s2 = sketch(plane("xy", { offset: 50 }), () => {
        circle(30);
      });

      const l = loft(s1, s2) as Loft;

      render();

      const shapes = l.getShapes();
      expect(shapes).toHaveLength(1);
      expect(shapes[0].getType()).toBe("solid");
    });
  });

  describe("loft between three profiles", () => {
    it("should loft through three profiles", () => {
      const s1 = sketch("xy", () => {
        circle(30);
      });

      const s2 = sketch(plane("xy", { offset: 25 }), () => {
        circle(50);
      });

      const s3 = sketch(plane("xy", { offset: 50 }), () => {
        circle(30);
      });

      const l = loft(s1, s2, s3) as Loft;

      render();

      const shapes = l.getShapes();
      expect(shapes).toHaveLength(1);

      // Middle profile is wider → the solid should bulge out
      const bbox = ShapeOps.getBoundingBox(shapes[0]);
      expect(bbox.maxX - bbox.minX).toBeCloseTo(100, -1); // 2 * 50
    });
  });

  describe("loft removes profile shapes", () => {
    it("should remove sketch shapes from the profiles", () => {
      const s1 = sketch("xy", () => {
        rect(100, 50);
      }) as Sketch;

      const s2 = sketch(plane("xy", { offset: 40 }), () => {
        rect(100, 50);
      }) as Sketch;

      loft(s1, s2);

      render();

      expect(s1.getShapes()).toHaveLength(0);
      expect(s2.getShapes()).toHaveLength(0);
    });
  });

  describe("loft produces single shape", () => {
    it("should produce a single shape in the scene", () => {
      const s1 = sketch("xy", () => {
        circle(30);
      });

      const s2 = sketch(plane("xy", { offset: 40 }), () => {
        circle(20);
      });

      loft(s1, s2);

      const scene = render();

      expect(countShapes(scene)).toBe(1);
    });
  });
});
