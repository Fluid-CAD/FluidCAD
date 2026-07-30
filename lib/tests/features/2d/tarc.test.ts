import { describe, it, expect } from "vitest";
import { setupOC, render } from "../../setup.js";
import sketch from "../../../core/sketch.js";
import extrude from "../../../core/extrude.js";
import { tArc, hLine, vLine, circle, move, arc } from "../../../core/2d/index.js";
import { outside } from "../../../features/2d/constraints/geometry-qualifier.js";
import { ExtrudeBase } from "../../../features/extrude-base.js";
import { Sketch } from "../../../features/2d/sketch.js";
import { getEdgesByType } from "../../utils.js";
import { EdgeQuery } from "../../../oc/edge-query.js";
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

  describe("tangent arc with radius to endpoint (radius, endPoint)", () => {
    // After hLine(50) the chain sits at (50, 0) with tangent (1, 0); the
    // auto-solved tangent arc to (80, 30) has center (50, 30) and radius 30.

    it("reproduces the auto-solved tangent arc when given its radius", () => {
      const s = sketch("xy", () => {
        hLine(50);
        tArc(30, [80, 30]);
      }) as Sketch;
      render();

      const arcs = getEdgesByType(s.getShapes(), "arc");
      expect(arcs.length).toBe(1);
      const { center, radius } = EdgeQuery.getCircleDataFromEdge(arcs[0]);
      expect(radius).toBeCloseTo(30, 6);
      expect(center.x).toBeCloseTo(50, 6);
      expect(center.y).toBeCloseTo(30, 6);
      const end = arcs[0].getLastVertex().toPoint();
      expect(end.x).toBeCloseTo(80, 6);
      expect(end.y).toBeCloseTo(30, 6);
    });

    it("a different radius stays tangent and projects the endpoint onto its circle", () => {
      const s = sketch("xy", () => {
        hLine(50);
        tArc(60, [80, 30]);
      }) as Sketch;
      render();

      const arcs = getEdgesByType(s.getShapes(), "arc");
      expect(arcs.length).toBe(1);
      const { center, radius } = EdgeQuery.getCircleDataFromEdge(arcs[0]);
      expect(radius).toBeCloseTo(60, 6);
      // Tangency: the center sits on the perpendicular at the start, so the
      // arc leaves (50, 0) exactly along the chain tangent (1, 0).
      expect(center.x).toBeCloseTo(50, 6);
      expect(center.y).toBeCloseTo(60, 6);
      // The aim point (80, 30) is off this circle — the end lands on the
      // circle point closest to it.
      const start = arcs[0].getFirstVertex().toPoint();
      const end = arcs[0].getLastVertex().toPoint();
      const [s2, e2] = start.x < end.x ? [start, end] : [end, start];
      expect(s2.x).toBeCloseTo(50, 6);
      expect(s2.y).toBeCloseTo(0, 6);
      expect(e2.x).toBeCloseTo(92.4264, 3);
      expect(e2.y).toBeCloseTo(17.5736, 3);
    });

    it("negative radius flips the bulge to the other side", () => {
      const positive = sketch("xy", () => {
        hLine(50);
        tArc(30, [80, 30]);
      }) as Sketch;
      render();
      const negative = sketch("xy", () => {
        hLine(50);
        tArc(-30, [80, 30]);
      }) as Sketch;
      render();

      const midpointOf = (s: Sketch) => {
        const edge = getEdgesByType(s.getShapes(), "arc")[0];
        const { first, last } = EdgeQuery.getEdgeCurveParams(edge);
        return EdgeQuery.sampleEdgeCurvePoint(edge, (first + last) / 2);
      };
      // The positive arc bulges right of the chord, the negative one sweeps
      // around the far side.
      expect(midpointOf(positive).x).toBeGreaterThan(50);
      expect(midpointOf(negative).x).toBeLessThan(50);
    });

    it("a radius smaller than half the chord still builds a tangent arc", () => {
      const s = sketch("xy", () => {
        hLine(50);
        tArc(10, [80, 30]);
      }) as Sketch;
      render();

      const arcs = getEdgesByType(s.getShapes(), "arc");
      expect(arcs.length).toBe(1);
      const { center, radius } = EdgeQuery.getCircleDataFromEdge(arcs[0]);
      expect(radius).toBeCloseTo(10, 6);
      // Still tangent: center on the perpendicular at the start.
      expect(center.x).toBeCloseTo(50, 6);
      expect(center.y).toBeCloseTo(10, 6);
    });

    it("records an error for a zero radius", () => {
      const s = sketch("xy", () => {
        hLine(50);
        tArc(0, [80, 30]);
      }) as Sketch;
      render();

      const children = s.getChildren();
      const arc = children[children.length - 1];
      expect(arc.getError()).toMatch(/non-zero/);
    });

    it("records an error when the endpoint projects onto the start", () => {
      const s = sketch("xy", () => {
        hLine(50);
        tArc(10, [50, 0]);
      }) as Sketch;
      render();

      const children = s.getChildren();
      const arc = children[children.length - 1];
      expect(arc.getError()).toMatch(/no sweep/);
    });

    it("chains geometry after the arc", () => {
      const s = sketch("xy", () => {
        hLine(50);
        tArc(30, [80, 30]);
        hLine(-30);
      }) as Sketch;
      render();

      const shapes = s.getShapes();
      expect(shapes.length).toBeGreaterThanOrEqual(3);
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

  describe("tangent arc from current position to target line (target)", () => {
    it("should create a tangent arc from a horizontal line ending tangent to a vertical line", () => {
      const s = sketch("xy", () => {
        const v = vLine([200, 200], 100).guide();
        move([0, 0]);
        hLine(100);
        tArc(v);
      }) as Sketch;
      render();

      const shapes = s.getShapes();
      // hLine + tArc (guide excluded) = at least 2 edges
      expect(shapes.length).toBeGreaterThanOrEqual(2);
    });

    it("should accept a qualified line target", () => {
      const s = sketch("xy", () => {
        const v = vLine([200, 200], 100).guide();
        move([0, 0]);
        hLine(100);
        tArc(outside(v));
      }) as Sketch;
      render();

      const shapes = s.getShapes();
      expect(shapes.length).toBeGreaterThanOrEqual(2);
    });

    it("should allow chaining geometry after the solved arc", () => {
      const s = sketch("xy", () => {
        const v = vLine([200, 200], 100).guide();
        move([0, 0]);
        hLine(100);
        tArc(v);
        vLine(40);
      }) as Sketch;
      render();

      const shapes = s.getShapes();
      // chain continues — hLine + tArc + vLine
      expect(shapes.length).toBeGreaterThanOrEqual(3);
    });

    it("default arc curves to the left of the start tangent", () => {
      const s = sketch("xy", () => {
        const h = hLine([-150, 100], 300).guide();
        move([0, 0]);
        vLine(80);
        tArc(h);
      }) as Sketch;
      render();

      const arcs = getEdgesByType(s.getShapes(), "arc");
      expect(arcs.length).toBe(1);
      // start tangent is +Y; "left" of +Y is -X. End vertex sits at negative x.
      const endX = arcs[0].getLastVertex().toPoint().x;
      expect(endX).toBeLessThan(0);
    });

    it(".flip() reverses the curve to the right of the start tangent", () => {
      const s = sketch("xy", () => {
        const h = hLine([-150, 100], 300).guide();
        move([0, 0]);
        vLine(80);
        tArc(h).flip();
      }) as Sketch;
      render();

      const arcs = getEdgesByType(s.getShapes(), "arc");
      expect(arcs.length).toBe(1);
      const endX = arcs[0].getLastVertex().toPoint().x;
      expect(endX).toBeGreaterThan(0);
    });

    it("should reject circle targets", () => {
      const s = sketch("xy", () => {
        const c = circle([200, 80], 30).guide();
        move([0, 0]);
        hLine(100);
        tArc(c);
      }) as Sketch;
      render();

      const children = s.getChildren();
      const arc = children[children.length - 1];
      expect(arc.getError()).toMatch(/only line targets are supported/);
    });
  });

  describe("tangent arc with radius ending at intersection (radius, target)", () => {
    it("should end at the intersection with a line target", () => {
      const s = sketch("xy", () => {
        const h = hLine([-200, 100], 400).guide();
        move([0, 0]);
        vLine(50);
        tArc(60, h);
      }) as Sketch;
      render();

      const arcs = getEdgesByType(s.getShapes(), "arc");
      expect(arcs.length).toBe(1);
      // End vertex must lie on the target line y = 100.
      const endY = arcs[0].getLastVertex().toPoint().y;
      expect(endY).toBeCloseTo(100, 6);
    });

    it("should end at the intersection with a circle target", () => {
      const s = sketch("xy", () => {
        // circle(diameter); 80 diameter = 40 radius
        const c = circle([80, 0], 80).guide();
        move([0, 0]);
        hLine(40);
        tArc(50, c);
      }) as Sketch;
      render();

      const arcs = getEdgesByType(s.getShapes(), "arc");
      expect(arcs.length).toBe(1);
      // End vertex must lie on the target circle (radius 40 from (80, 0)).
      const end = arcs[0].getLastVertex().toPoint();
      const dist = Math.hypot(end.x - 80, end.y - 0);
      expect(dist).toBeCloseTo(40, 6);
    });

    it("negative radius flips the sweep direction", () => {
      // Same line, same start, same tangent — only the sign of the radius
      // differs. Positive radius (CCW) curves to the left of the tangent;
      // negative radius (CW) curves to the right.
      const sCCW = sketch("xy", () => {
        const h = hLine([-200, 100], 400).guide();
        move([0, 0]);
        vLine(50);
        tArc(60, h);
      }) as Sketch;
      render();

      const sCW = sketch("xy", () => {
        const h = hLine([-200, 100], 400).guide();
        move([0, 0]);
        vLine(50);
        tArc(-60, h);
      }) as Sketch;
      render();

      const ccwArc = getEdgesByType(sCCW.getShapes(), "arc")[0];
      const cwArc = getEdgesByType(sCW.getShapes(), "arc")[0];

      // T̂ = (0, +1); "left" of the tangent is −x, "right" is +x.
      expect(ccwArc.getLastVertex().toPoint().x).toBeLessThan(0);
      expect(cwArc.getLastVertex().toPoint().x).toBeGreaterThan(0);
    });

    it("should chain geometry after the solved arc", () => {
      const s = sketch("xy", () => {
        const h = hLine([-200, 100], 400).guide();
        move([0, 0]);
        vLine(50);
        tArc(60, h);
        hLine(40);
      }) as Sketch;
      render();

      const shapes = s.getShapes();
      expect(shapes.length).toBeGreaterThanOrEqual(3);
    });

    it("should record an error when there is no intersection", () => {
      const s = sketch("xy", () => {
        const h = hLine([-200, 500], 400).guide();
        move([0, 0]);
        vLine(10);
        tArc(20, h);
      }) as Sketch;
      render();

      const children = s.getChildren();
      const arc = children[children.length - 1];
      expect(arc.getError()).toMatch(/does not intersect target/);
    });
  });
});
