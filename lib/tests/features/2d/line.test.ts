import { describe, it, expect } from "vitest";
import { setupOC, render } from "../../setup.js";
import sketch from "../../../core/sketch.js";
import extrude from "../../../core/extrude.js";
import { line, hLine, vLine, aLine, circle, move } from "../../../core/2d/index.js";
import { ExtrudeBase } from "../../../features/extrude-base.js";
import { Solid } from "../../../common/solid.js";
import { ShapeOps } from "../../../oc/shape-ops.js";
import { Sketch } from "../../../features/2d/sketch.js";
import { Edge } from "../../../common/edge.js";

describe("line functions", () => {
  setupOC();

  describe("line", () => {
    it("should create a line between two points", () => {
      const s = sketch("xy", () => {
        line([0, 0], [100, 0]);
      }) as Sketch;

      render();

      const shapes = s.getShapes();
      expect(shapes.length).toBeGreaterThan(0);
    });
  });

  describe("hLine", () => {
    it("should create a horizontal line and form a closed rect", () => {
      sketch("xy", () => {
        hLine(80);
        vLine(40);
        hLine(-80);
        vLine(-40);
      });
      const e = extrude(10) as ExtrudeBase;
      render();

      const solid = e.getShapes()[0] as Solid;
      const bbox = ShapeOps.getBoundingBox(solid);
      expect(bbox.maxX - bbox.minX).toBeCloseTo(80, 0);
      expect(bbox.maxY - bbox.minY).toBeCloseTo(40, 0);
    });

    it("should support standalone mode with targetPlane", () => {
      hLine("xy", 50);
      render();
      // Just verify no error — standalone line doesn't form a closed shape
    });
  });

  describe("vLine", () => {
    it("should create a vertical line and form a closed rect", () => {
      sketch("xy", () => {
        vLine(60);
        hLine(40);
        vLine(-60);
        hLine(-40);
      });
      const e = extrude(10) as ExtrudeBase;
      render();

      const solid = e.getShapes()[0] as Solid;
      const bbox = ShapeOps.getBoundingBox(solid);
      expect(bbox.maxX - bbox.minX).toBeCloseTo(40, 0);
      expect(bbox.maxY - bbox.minY).toBeCloseTo(60, 0);
    });
  });

  describe("aLine", () => {
    it("should create an angled line", () => {
      sketch("xy", () => {
        hLine(50);
        aLine(90, 50);
        hLine(-50);
        vLine(-50);
      });
      const e = extrude(10) as ExtrudeBase;
      render();

      expect(e.getShapes()).toHaveLength(1);
    });
  });

  describe("hLine to target geometry", () => {
    it("should end at the nearest intersection with a circle", () => {
      let h: any;
      sketch("xy", () => {
        const c = circle([100, 0], 50);
        h = hLine([0, 0], c);
      });
      render();

      const edges = h.getOwnShapes().filter((sh: any) => sh instanceof Edge) as Edge[];
      expect(edges).toHaveLength(1);
      const endPoint = edges[0].getLastVertex().toPoint();
      // Circle at (100, 0) with diameter 50 → radius 25 → near edge at x=75
      expect(endPoint.x).toBeCloseTo(75, 1);
      expect(endPoint.y).toBeCloseTo(0, 1);
    });

    it("should pick nearest intersection when target is behind the start", () => {
      let h: any;
      sketch("xy", () => {
        const c = circle([-100, 0], 50);
        h = hLine([0, 0], c);
      });
      render();

      const edges = h.getOwnShapes().filter((sh: any) => sh instanceof Edge) as Edge[];
      const endPoint = edges[0].getLastVertex().toPoint();
      // Circle at (-100, 0) with diameter 50 → near edge at x=-75
      expect(endPoint.x).toBeCloseTo(-75, 1);
      expect(endPoint.y).toBeCloseTo(0, 1);
    });

    it("should record an error when there is no intersection", () => {
      let h: any;
      sketch("xy", () => {
        const c = circle([0, 100], 20);
        h = hLine([0, 0], c);
      });
      render();

      expect((h as any).getError()).toMatch(/does not intersect/);
    });

    it("should record an error when .centered() is combined with a target", () => {
      let h: any;
      sketch("xy", () => {
        const c = circle([100, 0], 40);
        h = hLine([0, 0], c).centered();
      });
      render();

      expect((h as any).getError()).toMatch(/centered/);
    });
  });

  describe("vLine to target geometry", () => {
    it("should end at the nearest intersection with a circle above", () => {
      let v: any;
      sketch("xy", () => {
        const c = circle([0, 100], 50);
        v = vLine([0, 0], c);
      });
      render();

      const edges = v.getOwnShapes().filter((sh: any) => sh instanceof Edge) as Edge[];
      const endPoint = edges[0].getLastVertex().toPoint();
      expect(endPoint.x).toBeCloseTo(0, 1);
      expect(endPoint.y).toBeCloseTo(75, 1);
    });
  });

  describe("aLine to target geometry", () => {
    it("should end where the angled line meets a horizontal line", () => {
      let a: any;
      sketch("xy", () => {
        // A horizontal segment at y = 50 (drawn as guide for intersection).
        // Use hLine starting at (-100, 50) with length 200 so it spans x ∈ [-100, 100].
        const h = hLine([-100, 50], 200);
        // Now place a 45° line starting at the origin; previous tangent is (1,0)
        // (left over from h's hLine). Rotated 45° CCW that's direction (√2/2, √2/2).
        // Starting from (100, 50)? Actually current position after h is (100, 50).
        // We want aLine at angle 45° from current direction (1,0) rotated by 45°
        // → direction (√2/2, √2/2). Starting from (100, 50), going at 45° → never
        // hits the segment again. Use move() to reset start.
        move([0, 0]);
        a = aLine(45, h);
      });
      render();

      const edges = a.getOwnShapes().filter((sh: any) => sh instanceof Edge) as Edge[];
      const endPoint = edges[0].getLastVertex().toPoint();
      // 45° line from (0,0) hits y=50 at x=50.
      expect(endPoint.x).toBeCloseTo(50, 1);
      expect(endPoint.y).toBeCloseTo(50, 1);
    });
  });

  describe("combined line functions", () => {
    it("should create an L-shape with hLine and vLine", () => {
      sketch("xy", () => {
        hLine(100);
        vLine(50);
        hLine(-60);
        vLine(30);
        hLine(-40);
        vLine(-80);
      });
      const e = extrude(10) as ExtrudeBase;
      render();

      const solid = e.getShapes()[0] as Solid;
      // L-shape has more than 6 faces
      expect(solid.getFaces().length).toBeGreaterThan(6);
    });
  });
});
