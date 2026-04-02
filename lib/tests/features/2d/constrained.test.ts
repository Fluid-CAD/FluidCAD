import { describe, it, expect } from "vitest";
import { setupOC, render } from "../../setup.js";
import sketch from "../../../core/sketch.js";
import extrude from "../../../core/extrude.js";
import { tLine, tCircle, tArc, circle, aLine, vLine, move, arc, hLine } from "../../../core/2d/index.js";
import { outside, enclosing } from "../../../features/2d/constraints/geometry-qualifier.js";
import { ExtrudeBase } from "../../../features/extrude-base.js";
import { Sketch } from "../../../features/2d/sketch.js";
import { Solid } from "../../../common/solid.js";
import { getEdgesByType } from "../../utils.js";

describe("constrained geometries", () => {
  setupOC();

  describe("tLine between two circles", () => {
    it("should create a tangent line between two outside circles", () => {
      const s = sketch("xy", () => {
        const c1 = circle(50);
        const c2 = circle([200, 0], 30);
        tLine(outside(c1), outside(c2));
      }) as Sketch;
      render();

      const shapes = s.getShapes();
      expect(shapes.length).toBeGreaterThan(0);
    });

    it("should create a tangent line with enclosing constraint", () => {
      const s = sketch("xy", () => {
        const c1 = circle(50);
        const c2 = circle([200, 0], 30);
        tLine(enclosing(c1), enclosing(c2));
      }) as Sketch;
      render();

      const shapes = s.getShapes();
      expect(shapes.length).toBeGreaterThan(0);
    });

    it("should create a tangent line between two arcs", () => {
      const s = sketch("xy", () => {
        const a1 = arc(50, 0, 180);
        move([200, 0]);
        const a2 = arc(30, 0, 180);
        tLine(a1, a2);
      }) as Sketch;
      render();

      const shapes = s.getShapes();
      expect(shapes.length).toBeGreaterThan(0);
    });
  });

  describe("tLine result accessors", () => {
    it("should expose start and end points", () => {
      const s = sketch("xy", () => {
        const c1 = circle(50);
        const c2 = circle([200, 0], 30);
        const t = tLine(outside(c1), outside(c2));
        // start() and end() return LazyVertex / SceneObjects
        const startPt = t.start();
        const endPt = t.end();
        expect(startPt).toBeDefined();
        expect(endPt).toBeDefined();
      }) as Sketch;
      render();
    });
  });

  describe("tCircle between two circles", () => {
    it("should create a tangent circle with outside constraints", () => {
      const s = sketch("xy", () => {
        const c1 = circle(80);
        const c2 = circle([200, 0], 30);
        tCircle(outside(c1), outside(c2), 80).guide();
      }) as Sketch;
      render();

      const shapes = s.getShapes();
      expect(shapes.length).toBeGreaterThan(0);
    });

    it("should create a tangent circle with enclosing constraint", () => {
      const s = sketch("xy", () => {
        const c1 = circle(80);
        const c2 = circle([200, 0], 30);
        tCircle(c1, enclosing(c2), 80).guide();
      }) as Sketch;
      render();

      const shapes = s.getShapes();
      expect(shapes.length).toBeGreaterThan(0);
    });
  });

  describe("tCircle between two points", () => {
    it("should create a tangent circle from two points", () => {
      const s = sketch("xy", () => {
        tCircle([-50, 0], [50, 0], 150);
      }) as Sketch;
      render();

      const shapes = s.getShapes();
      expect(shapes.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe("tCircle between circle and line", () => {
    it("should create a tangent circle to a circle and a line", () => {
      const s = sketch("xy", () => {
        const l = aLine(150, 45);
        const c = circle([100, 0], 30);
        tCircle(c, l, 50).guide();
      }) as Sketch;
      render();

      const shapes = s.getShapes();
      expect(shapes.length).toBeGreaterThan(0);
    });
  });

  describe("tCircle between two lines", () => {
    it("should create a tangent circle between two lines", () => {
      const s = sketch("xy", () => {
        const l1 = aLine(300, 45);
        move([-50, 0]);
        const l2 = vLine(300);
        tCircle(l1, l2, 100, true).guide();
      }) as Sketch;
      render();

      const shapes = s.getShapes();
      expect(shapes.length).toBeGreaterThan(0);
    });
  });

  describe("tArc between two circles", () => {
    it("should create a tangent arc with outside constraints", () => {
      const s = sketch("xy", () => {
        const c1 = circle(80);
        const c2 = circle([200, 0], 30);
        tArc(outside(c1), outside(c2), 80).guide();
      }) as Sketch;
      render();

      const shapes = s.getShapes();
      expect(shapes.length).toBeGreaterThan(0);
    });

    it("should create a tangent arc with enclosing constraint", () => {
      const s = sketch("xy", () => {
        const c1 = circle(85);
        const c2 = circle([200, 0], 30);
        tArc(c1, enclosing(c2), 50).guide();
      }) as Sketch;
      render();

      const shapes = s.getShapes();
      expect(shapes.length).toBeGreaterThan(0);
    });
  });

  describe("tArc between circle and line", () => {
    it("should create a tangent arc to a circle and a line", () => {
      const s = sketch("xy", () => {
        const l = aLine(150, 45);
        const c = circle([100, 0], 20);
        tArc(c, l, 50).guide();
      }) as Sketch;
      render();

      const shapes = s.getShapes();
      expect(shapes.length).toBeGreaterThan(0);
    });
  });

  describe("tArc between two lines", () => {
    it("should create a fillet arc between two lines", () => {
      const s = sketch("xy", () => {
        const l1 = aLine(150, 45);
        move([-50, 0]);
        const l2 = vLine(100);
        tArc(l1, l2, 50).guide();
      }) as Sketch;
      render();

      const shapes = s.getShapes();
      expect(shapes.length).toBeGreaterThan(0);
    });
  });

  describe("tArc between circle and point", () => {
    it("should create a tangent arc to a circle and a point", () => {
      const s = sketch("xy", () => {
        const c = circle([100, 0], 20);
        const p = [100, 50];
        tArc(outside(c), p, 100).guide();
      }) as Sketch;
      render();

      const shapes = s.getShapes();
      expect(shapes.length).toBeGreaterThan(0);
    });
  });

  describe("tArc between two arcs", () => {
    it("should create a tangent arc between two arc geometries", () => {
      const s = sketch("xy", () => {
        const a1 = arc(100, 0, 180);
        move([200, 0]);
        const a2 = arc(50, 270, 0);
        tArc(outside(a1), a2, 150).guide();
      }) as Sketch;
      render();

      const shapes = s.getShapes();
      expect(shapes.length).toBeGreaterThan(0);
    });
  });

  describe("constrained geometry produces extrudable shape", () => {
    it("should extrude a closed shape formed by tLine and tArc between circles", () => {
      sketch("xy", () => {
        const c1 = circle(50);
        const c2 = circle([200, 0], 30);
        const t1 = tLine(outside(c1), outside(c2));
        const t2 = tLine(enclosing(c1), enclosing(c2));
        tArc(t1.end(), t2.end(), t1.tangent());
        tArc(t1.start(), t2.start(), t1.tangent().reverse());
      });
      const e = extrude(10) as ExtrudeBase;
      render();

      const shapes = e.getShapes();
      expect(shapes.length).toBeGreaterThanOrEqual(1);
    });
  });
});
