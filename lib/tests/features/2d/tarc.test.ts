import { describe, it, expect } from "vitest";
import { setupOC, render } from "../../setup.js";
import sketch from "../../../core/sketch.js";
import extrude from "../../../core/extrude.js";
import { tArc, hLine, vLine, circle, move, arc } from "../../../core/2d/index.js";
import { outside } from "../../../features/2d/constraints/geometry-qualifier.js";
import { ExtrudeBase } from "../../../features/extrude-base.js";
import { Sketch } from "../../../features/2d/sketch.js";
import { getEdgesByType } from "../../utils.js";
import { Solid } from "../../../common/solid.js";

describe("tArc", () => {
  setupOC();

  describe("tangent arc from previous geometry (radius, angle)", () => {
    it("should create a tangent arc after a horizontal line", () => {
      sketch("xy", () => {
        hLine(50);
        tArc(20, 90);
        vLine(-20);
        hLine(-50);
        vLine(-20);
      });
      const e = extrude(5) as ExtrudeBase;
      render();

      const solid = e.getShapes()[0] as Solid;
      const arcEdges = getEdgesByType(solid, "arc");
      expect(arcEdges.length).toBeGreaterThan(0);
    });

    it("should create a tangent arc after a vertical line", () => {
      const s = sketch("xy", () => {
        vLine(50);
        tArc(20, 90);
      }) as Sketch;
      render();

      const shapes = s.getShapes();
      expect(shapes.length).toBeGreaterThanOrEqual(2);
    });

    it("should create a tangent arc with default parameters", () => {
      const s = sketch("xy", () => {
        hLine(50);
        tArc();
      }) as Sketch;
      render();

      const shapes = s.getShapes();
      // hLine + tArc = at least 2 edges
      expect(shapes.length).toBeGreaterThanOrEqual(2);
    });

    it("should create a clockwise arc with negative angle", () => {
      const s = sketch("xy", () => {
        hLine(50);
        tArc(20, -90);
      }) as Sketch;
      render();

      const shapes = s.getShapes();
      expect(shapes.length).toBeGreaterThanOrEqual(2);
    });

    it("should create a 180-degree arc", () => {
      const s = sketch("xy", () => {
        hLine(50);
        tArc(30, 180);
      }) as Sketch;
      render();

      const shapes = s.getShapes();
      expect(shapes.length).toBeGreaterThanOrEqual(2);
    });

    it("should chain multiple tangent arcs", () => {
      const s = sketch("xy", () => {
        hLine(50);
        tArc(20, 90);
        tArc(20, 90);
      }) as Sketch;
      render();

      const shapes = s.getShapes();
      // hLine + 2 tArcs = at least 3 edges
      expect(shapes.length).toBeGreaterThanOrEqual(3);
    });

    it("should create a tangent arc after another arc", () => {
      const s = sketch("xy", () => {
        move([0, 0]);
        arc(30, 0, 90);
        tArc(20, 45);
      }) as Sketch;
      render();

      const shapes = s.getShapes();
      expect(shapes.length).toBeGreaterThanOrEqual(2);
    });
  });

  describe("tangent arc with explicit tangent (radius, angle, tangent)", () => {
    it("should create a tangent arc with a specified start tangent", () => {
      const s = sketch("xy", () => {
        move([0, 0]);
        tArc(30, 90, [1, 0]);
      }) as Sketch;
      render();

      const shapes = s.getShapes();
      expect(shapes.length).toBeGreaterThanOrEqual(1);
    });

    it("should create a tangent arc with a diagonal start tangent", () => {
      const s = sketch("xy", () => {
        move([0, 0]);
        tArc(25, 120, [1, 1]);
      }) as Sketch;
      render();

      const shapes = s.getShapes();
      expect(shapes.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe("tangent arc to endpoint (endPoint)", () => {
    it("should create a tangent arc to a given point", () => {
      const s = sketch("xy", () => {
        hLine(50);
        tArc([50, 30]);
      }) as Sketch;
      render();

      const shapes = s.getShapes();
      expect(shapes.length).toBeGreaterThanOrEqual(2);
    });

    it("should create a tangent arc to a point above", () => {
      const s = sketch("xy", () => {
        hLine(40);
        tArc([60, 40]);
      }) as Sketch;
      render();

      const shapes = s.getShapes();
      expect(shapes.length).toBeGreaterThanOrEqual(2);
    });

    it("should create a tangent arc to a point below", () => {
      const s = sketch("xy", () => {
        hLine(40);
        tArc([60, -30]);
      }) as Sketch;
      render();

      const shapes = s.getShapes();
      expect(shapes.length).toBeGreaterThanOrEqual(2);
    });
  });

  describe("tangent arc to endpoint with tangent (endPoint, tangent)", () => {
    it("should create a tangent arc to a point with explicit end tangent", () => {
      const s = sketch("xy", () => {
        hLine(50);
        tArc([70, 30], [0, 1]);
      }) as Sketch;
      render();

      const shapes = s.getShapes();
      expect(shapes.length).toBeGreaterThanOrEqual(2);
    });

    it("should create a tangent arc with a horizontal end tangent", () => {
      const s = sketch("xy", () => {
        vLine(30);
        tArc([50, 50], [1, 0]);
      }) as Sketch;
      render();

      const shapes = s.getShapes();
      expect(shapes.length).toBeGreaterThanOrEqual(2);
    });
  });

  describe("tangent arc from start to end with tangent (startPoint, endPoint, tangent)", () => {
    it("should create a tangent arc between two points with explicit tangent", () => {
      const s = sketch("xy", () => {
        tArc([0, 0], [50, 50], [1, 0]);
      }) as Sketch;
      render();

      const shapes = s.getShapes();
      expect(shapes.length).toBeGreaterThanOrEqual(1);
    });

    it("should create a tangent arc with vertical tangent direction", () => {
      const s = sketch("xy", () => {
        tArc([10, 0], [60, 40], [0, 1]);
      }) as Sketch;
      render();

      const shapes = s.getShapes();
      expect(shapes.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe("tangent arc between two objects (c1, c2, radius)", () => {
    it("should create a fillet arc between two circles", () => {
      sketch("xy", () => {
        const c1 = circle(40);
        const c2 = circle([80, 0], 40);
        tArc(c1, c2, 15);
      });
      const e = extrude(10) as ExtrudeBase;
      render();

      const shapes = e.getShapes();
      expect(shapes.length).toBeGreaterThanOrEqual(1);
    });

    it("should create a fillet arc between two circles with outside qualifier", () => {
      const s = sketch("xy", () => {
        const c1 = circle(160);
        const c2 = circle([200, 0], 60);
        tArc(outside(c1), outside(c2), 80).guide();
      }) as Sketch;
      render();

      const shapes = s.getShapes();
      expect(shapes.length).toBeGreaterThan(0);
    });

    it("should create a fillet arc between a circle and a point", () => {
      const s = sketch("xy", () => {
        const c = circle([100, 0], 40);
        tArc(outside(c), [100, 50], 100).guide();
      }) as Sketch;
      render();

      const shapes = s.getShapes();
      expect(shapes.length).toBeGreaterThan(0);
    });

    it("should create a fillet arc with mustTouch enabled", () => {
      const s = sketch("xy", () => {
        const c1 = circle(60);
        const c2 = circle([100, 0], 60);
        tArc(c1, c2, 40, true).guide();
      }) as Sketch;
      render();

      const shapes = s.getShapes();
      expect(shapes.length).toBeGreaterThan(0);
    });

    it("should expose start and end accessors on constrained arc", () => {
      sketch("xy", () => {
        const c1 = circle(100);
        const c2 = circle([200, 0], 60);
        const t = tArc(outside(c1), outside(c2), 80);
        const startPt = t.start();
        const endPt = t.end();
        expect(startPt).toBeDefined();
        expect(endPt).toBeDefined();
      });
      render();
    });

    it("should expose indexed start and end accessors", () => {
      sketch("xy", () => {
        const c1 = circle(100);
        const c2 = circle([200, 0], 60);
        const t = tArc(outside(c1), outside(c2), 80);
        const start0 = t.start(0);
        const end0 = t.end(0);
        expect(start0).toBeDefined();
        expect(end0).toBeDefined();
      });
      render();
    });
  });
});
