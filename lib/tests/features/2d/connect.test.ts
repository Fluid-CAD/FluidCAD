import { describe, it, expect } from "vitest";
import { setupOC, render } from "../../setup.js";
import sketch from "../../../core/sketch.js";
import extrude from "../../../core/extrude.js";
import revolve from "../../../core/revolve.js";
import sweep from "../../../core/sweep.js";
import { mirror } from "../../../core/index.js";
import { arc, line, hLine, vLine, hMove, move, connect, offset, circle } from "../../../core/2d/index.js";
import { Sketch } from "../../../features/2d/sketch.js";
import { Connect } from "../../../features/2d/connect.js";
import { MirrorShape2D } from "../../../features/mirror-shape2d.js";
import { Extrude } from "../../../features/extrude.js";
import { Revolve } from "../../../features/revolve.js";
import { Sweep } from "../../../features/sweep.js";
import { Edge } from "../../../common/edge.js";
import { EdgeOps } from "../../../oc/edge-ops.js";
import { EdgeQuery } from "../../../oc/edge-query.js";
import { ShapeProps } from "../../../oc/props.js";

// connect() closes the current polyline: it emits ONE bridge edge from the
// cursor's current position back to the polyline's start — the last
// absolutely-positioned statement (absolute move() or explicit-start
// segment), or the sketch start point when the whole sketch is one chain.
// Earlier geometry is never consumed or re-emitted.
describe("connect", () => {
  setupOC();

  const endpoints = (edge: Edge) => ({
    start: EdgeOps.getVertexPoint(EdgeOps.getFirstVertex(edge)),
    end: EdgeOps.getVertexPoint(EdgeOps.getLastVertex(edge)),
  });

  describe("closing bridge", () => {
    it("closes a chain back to the sketch start point", () => {
      let c: Connect;
      const s = sketch("xy", () => {
        hLine(80);
        vLine(40);
        c = connect() as Connect;
      }) as Sketch;

      render();

      const shapes = c.getShapes();
      expect(shapes).toHaveLength(1);
      expect(shapes[0].getType()).toBe("edge");

      const { start, end } = endpoints(shapes[0] as Edge);
      expect(start.x).toBeCloseTo(80);
      expect(start.y).toBeCloseTo(40);
      expect(end.x).toBeCloseTo(0);
      expect(end.y).toBeCloseTo(0);

      // Source edges stay with their own features; nothing is a wire.
      const sketchShapes = s.getShapes();
      expect(sketchShapes.filter(shape => shape.getType() === "edge")).toHaveLength(3);
      expect(sketchShapes.every(shape => shape.getType() !== "wire")).toBe(true);
    });

    it("closes back to the last absolute move", () => {
      let c: Connect;
      sketch("xy", () => {
        hLine(20); // stray open chain from the sketch start — not part of the polyline
        move([50, 0]);
        hLine(30);
        vLine(30);
        c = connect() as Connect;
      });

      render();

      const shapes = c.getShapes();
      expect(shapes).toHaveLength(1);

      const { start, end } = endpoints(shapes[0] as Edge);
      expect(start.x).toBeCloseTo(80);
      expect(start.y).toBeCloseTo(30);
      expect(end.x).toBeCloseTo(50);
      expect(end.y).toBeCloseTo(0);
    });

    it("closes back to an explicit-start segment", () => {
      let c: Connect;
      sketch("xy", () => {
        line([10, 5], [40, 5]);
        vLine(20);
        c = connect() as Connect;
      });

      render();

      const shapes = c.getShapes();
      expect(shapes).toHaveLength(1);

      const { start, end } = endpoints(shapes[0] as Edge);
      expect(start.x).toBeCloseTo(40);
      expect(start.y).toBeCloseTo(25);
      expect(end.x).toBeCloseTo(10);
      expect(end.y).toBeCloseTo(5);
    });

    it("walks past relative moves — they stay inside the chain", () => {
      let c: Connect;
      sketch("xy", () => {
        move([10, 0]);
        hLine(30);
        hMove(10); // gap, but still the same polyline
        vLine(25);
        c = connect() as Connect;
      });

      render();

      const shapes = c.getShapes();
      expect(shapes).toHaveLength(1);

      const { start, end } = endpoints(shapes[0] as Edge);
      expect(start.x).toBeCloseTo(50);
      expect(start.y).toBeCloseTo(25);
      expect(end.x).toBeCloseTo(10);
      expect(end.y).toBeCloseTo(0);
    });

    it("emits nothing when the chain is already closed", () => {
      let c: Connect;
      sketch("xy", () => {
        hLine(40);
        vLine(30);
        line([0, 0]); // manual close
        c = connect() as Connect;
      });

      render();

      expect(c.getShapes()).toHaveLength(0);
    });

    it("maps the bridge edge to the connect object in getEdgesWithOwner", () => {
      let c: Connect;
      const s = sketch("xy", () => {
        hLine(80);
        vLine(40);
        c = connect() as Connect;
      }) as Sketch;

      render();

      const edgeMap = s.getEdgesWithOwner();
      expect(edgeMap.size).toBe(3);
      const owners = Array.from(edgeMap.values());
      expect(owners.filter(owner => owner === c)).toHaveLength(1);
    });
  });

  describe("arc mode", () => {
    it("bridges with a circular arc", () => {
      let c: Connect;
      sketch("xy", () => {
        hLine(40);
        vLine(30);
        c = connect("arc") as Connect;
      });

      render();

      const shapes = c.getShapes();
      expect(shapes).toHaveLength(1);
      expect(EdgeQuery.getEdgeCurveType(shapes[0] as Edge)).toBe("circle");

      const { start, end } = endpoints(shapes[0] as Edge);
      expect(start.x).toBeCloseTo(40);
      expect(start.y).toBeCloseTo(30);
      expect(end.x).toBeCloseTo(0);
      expect(end.y).toBeCloseTo(0);
    });

    it("falls back to a line when the incoming tangent is collinear with the bridge", () => {
      let c: Connect;
      sketch("xy", () => {
        move([10, 0]);
        hLine(30);
        c = connect("arc") as Connect;
      });

      render();

      const shapes = c.getShapes();
      expect(shapes).toHaveLength(1);
      expect(EdgeQuery.getEdgeCurveType(shapes[0] as Edge)).toBe("line");
    });
  });

  describe("extrude over a connect-closed profile", () => {
    it("produces a solid with the exact profile volume", () => {
      sketch("xy", () => {
        hLine(80);
        vLine(40);
        connect();
      });

      const e = extrude(10) as Extrude;

      render();

      const shapes = e.getShapes();
      expect(shapes).toHaveLength(1);
      expect(shapes[0].getType()).toBe("solid");

      // Right triangle (0,0),(80,0),(80,40): area 1600, height 10.
      const props = ShapeProps.getProperties(shapes[0].getShape());
      expect(props.volumeMm3).toBeCloseTo(1600 * 10, 3);
    });
  });

  describe("revolve over a connect-closed profile", () => {
    it("produces a solid with positive volume", () => {
      sketch("xz", () => {
        move([20, 0]);
        hLine(10);
        vLine(20);
        connect();
      });

      const r = revolve("z") as Revolve;

      render();

      const shapes = r.getShapes();
      expect(shapes).toHaveLength(1);
      expect(shapes[0].getType()).toBe("solid");

      const props = ShapeProps.getProperties(shapes[0].getShape());
      expect(props.volumeMm3).toBeGreaterThan(0);
    });
  });

  describe("sweep over a connect-closed profile", () => {
    it("produces a solid", () => {
      const profile = sketch("xy", () => {
        hLine(20);
        vLine(10);
        connect();
      });

      const path = sketch("xz", () => {
        vLine(50);
      });

      const s = sweep(path, profile) as Sweep;

      render();

      const shapes = s.getShapes();
      expect(shapes).toHaveLength(1);
      expect(shapes[0].getType()).toBe("solid");
    });
  });

  describe("offset of a connect-closed profile", () => {
    it("produces offset edges alongside the profile edges", () => {
      const s = sketch("xy", () => {
        hLine(80);
        vLine(40);
        connect();
        offset(5);
      }) as Sketch;

      render();

      // 3 profile edges + offset ring edges, all individual edges.
      const shapes = s.getShapes();
      expect(shapes.length).toBeGreaterThan(3);
      expect(shapes.every(shape => shape.getType() !== "wire")).toBe(true);
    });
  });

  describe("mirror of a connect-closed profile", () => {
    it("copies the profile edges including the bridge", () => {
      let m: MirrorShape2D;
      sketch("xy", () => {
        move([10, 0]);
        hLine(80);
        vLine(40);
        connect();
        m = mirror("y") as MirrorShape2D;
      });

      render();

      const shapes = m.getShapes().filter(shape => !shape.isMetaShape() && !shape.isGuideShape());
      expect(shapes).toHaveLength(3);
      for (const shape of shapes) {
        expect(shape.getType()).toBe("edge");
      }
    });
  });

  describe("authored endpoints off the true curve", () => {
    it("closes and extrudes an arc whose authored end is rounded off its circle", () => {
      // The two-point arc takes its radius from the start point; the authored
      // end here sits ~0.005 off that circle, so the built arc's end vertex
      // deviates from the authored coordinates. The bridge must attach to the
      // segments' real vertices — bridging the authored points leaves a
      // micro-gap and the extrude silently finds no region.
      let c: Connect;
      sketch("xy", () => {
        arc([-205.71, -75.22], [-130.5, 124.58]).center([-176.56, 27.86]).cw();
        c = connect() as Connect;
      });

      const e = extrude(10) as Extrude;

      render();

      expect(c.getAddedShapes()).toHaveLength(1);

      const shapes = e.getShapes();
      expect(shapes).toHaveLength(1);
      expect(shapes[0].getType()).toBe("solid");

      const props = ShapeProps.getProperties(shapes[0].getShape());
      expect(props.volumeMm3).toBeGreaterThan(0);
    });
  });

  describe("earlier closed geometry is untouched", () => {
    it("leaves a full circle in place while closing the polyline", () => {
      let c: Connect;
      const s = sketch("xy", () => {
        circle(10);
        move([30, 0]);
        hLine(20);
        vLine(20);
        c = connect() as Connect;
      }) as Sketch;

      render();

      expect(c.getShapes()).toHaveLength(1);

      // Circle edge + two lines + one bridge; nothing is a wire.
      const shapes = s.getShapes();
      expect(shapes.filter(shape => shape.getType() === "edge")).toHaveLength(4);
      expect(shapes.every(shape => shape.getType() !== "wire")).toBe(true);
    });
  });
});
