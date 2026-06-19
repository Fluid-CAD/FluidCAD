import { describe, it, expect } from "vitest";
import { setupOC, render } from "../../setup.js";
import sketch from "../../../core/sketch.js";
import { circle, rect, hLine, vLine, aLine, line, offset } from "../../../core/2d/index.js";
import { Sketch } from "../../../features/2d/sketch.js";
import { ShapeOps } from "../../../oc/shape-ops.js";
import { Edge } from "../../../common/edge.js";

describe("offset", () => {
  setupOC();

  describe("offset closed shape", () => {
    it("should offset a circle outward with positive distance", () => {
      const s = sketch("xy", () => {
        circle(40);
        offset(5);
      }) as Sketch;

      render();

      // Original circle (r=20) + offset circle (r=25)
      const shapes = s.getShapes();
      expect(shapes.length).toBeGreaterThan(1);

      // The offset edges should produce a wider bounding box
      const bbox = ShapeOps.getBoundingBox(shapes[shapes.length - 1]);
      expect(bbox.maxX - bbox.minX).toBeGreaterThan(40);
    });

    it("should offset a circle inward with negative distance", () => {
      const s = sketch("xy", () => {
        circle(60);
        offset(-5);
      }) as Sketch;

      render();

      const shapes = s.getShapes();
      expect(shapes.length).toBeGreaterThan(1);
    });
  });

  describe("offset open wire", () => {
    it("should offset an open wire path", () => {
      const s = sketch("xy", () => {
        hLine(80);
        vLine(40);
        offset(5);
      }) as Sketch;

      render();

      // Offset produces new edges alongside the original open wire
      const shapes = s.getShapes();
      expect(shapes.length).toBeGreaterThan(2);
    });
  });

  // Regression: a single straight segment has no curvature to imply an offset
  // plane, so BRepOffsetAPI_MakeOffset needs the sketch plane as a reference
  // face. Without it, the offset failed with "Failed to offset wire" and no
  // offset edge was produced.
  describe("offset single open line", () => {
    const endpoints = (edge: Edge) => [edge.getFirstVertex().toPoint(), edge.getLastVertex().toPoint()];

    it("offsets a single hLine to a parallel line at the right distance", () => {
      const s = sketch("xy", () => {
        hLine(100);
        offset(10);
      }) as Sketch;
      render();

      const shapes = s.getShapes();
      expect(shapes.length).toBe(2);
      const [a, b] = endpoints(shapes[1] as Edge);
      expect(Math.abs(a.y)).toBeCloseTo(10, 6);
      expect(Math.abs(b.y)).toBeCloseTo(10, 6);
      expect(Math.hypot(b.x - a.x, b.y - a.y)).toBeCloseTo(100, 6);
    });

    it("offsets a single vLine to a parallel line at the right distance", () => {
      const s = sketch("xy", () => {
        vLine(100);
        offset(10);
      }) as Sketch;
      render();

      const shapes = s.getShapes();
      expect(shapes.length).toBe(2);
      const [a, b] = endpoints(shapes[1] as Edge);
      expect(Math.abs(a.x)).toBeCloseTo(10, 6);
      expect(Math.abs(b.x)).toBeCloseTo(10, 6);
      expect(Math.hypot(b.x - a.x, b.y - a.y)).toBeCloseTo(100, 6);
    });

    it("offsets a single aLine, preserving its length", () => {
      const s = sketch("xy", () => {
        aLine(30, 100);
        offset(10);
      }) as Sketch;
      render();

      const shapes = s.getShapes();
      expect(shapes.length).toBe(2);
      const [a, b] = endpoints(shapes[1] as Edge);
      expect(Math.hypot(b.x - a.x, b.y - a.y)).toBeCloseTo(100, 6);
    });

    it("offsets a single line, preserving its length", () => {
      const s = sketch("xy", () => {
        line([100, 50]);
        offset(10);
      }) as Sketch;
      render();

      const shapes = s.getShapes();
      expect(shapes.length).toBe(2);
      const [a, b] = endpoints(shapes[1] as Edge);
      expect(Math.hypot(b.x - a.x, b.y - a.y)).toBeCloseTo(Math.hypot(100, 50), 6);
    });

    it("offsets a single line to the opposite side with a negative distance", () => {
      const sPos = sketch("xy", () => {
        hLine(100);
        offset(10);
      }) as Sketch;
      render();
      const posY = endpoints(sPos.getShapes()[1] as Edge)[0].y;

      const sNeg = sketch("xy", () => {
        hLine(100);
        offset(-10);
      }) as Sketch;
      render();
      const negShapes = sNeg.getShapes();
      expect(negShapes.length).toBe(2);
      const negY = endpoints(negShapes[1] as Edge)[0].y;

      expect(Math.abs(negY)).toBeCloseTo(10, 6);
      expect(Math.sign(negY)).toBe(-Math.sign(posY));
    });
  });

  describe("offset direction", () => {
    it("positive and negative offsets should produce different results", () => {
      const s1 = sketch("xy", () => {
        circle(40);
        offset(10);
      }) as Sketch;

      render();

      const shapes1 = s1.getShapes();
      const bbox1 = ShapeOps.getBoundingBox(shapes1[shapes1.length - 1]);
      const width1 = bbox1.maxX - bbox1.minX;

      const s2 = sketch("xy", () => {
        circle(40);
        offset(-5);
      }) as Sketch;

      render();

      const shapes2 = s2.getShapes();
      const bbox2 = ShapeOps.getBoundingBox(shapes2[shapes2.length - 1]);
      const width2 = bbox2.maxX - bbox2.minX;

      // Positive offset produces wider result than negative
      expect(width1).toBeGreaterThan(width2);
    });
  });

  describe("removeOriginal", () => {
    it("should keep original edges by default", () => {
      const s = sketch("xy", () => {
        const c = circle(40);
        offset(5);
      }) as Sketch;

      render();

      // Original + offset edges both present
      const shapes = s.getShapes();
      expect(shapes.length).toBeGreaterThan(1);
    });

    it("should remove original edges when removeOriginal is true", () => {
      const s = sketch("xy", () => {
        circle(40);
        offset(5, true);
      }) as Sketch;

      render();

      // Only offset edges remain — original circle removed
      const shapes = s.getShapes();
      expect(shapes).toHaveLength(1);
    });
  });

  describe("specific targets (standalone)", () => {
    it("should offset source geometries onto a target plane", () => {
      const s = sketch("xy", () => {
        circle(40);
      }) as Sketch;

      offset("xy", 5, false, s);

      render();

      // Offset edges should exist on the target plane
    });
  });

  describe("default distance", () => {
    it("should use default distance of 1", () => {
      const s = sketch("xy", () => {
        circle(40);
        offset();
      }) as Sketch;

      render();

      const shapes = s.getShapes();
      // Original + offset with distance 1
      expect(shapes.length).toBeGreaterThan(1);
    });
  });
});
