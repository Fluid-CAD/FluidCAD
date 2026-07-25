import { describe, it, expect, vi, afterEach } from "vitest";
import { setupOC, render } from "../../setup.js";
import sketch from "../../../core/sketch.js";
import extrude from "../../../core/extrude.js";
import revolve from "../../../core/revolve.js";
import sweep from "../../../core/sweep.js";
import { mirror } from "../../../core/index.js";
import { hLine, vLine, move, connect, offset, circle } from "../../../core/2d/index.js";
import { Sketch } from "../../../features/2d/sketch.js";
import { Connect } from "../../../features/2d/connect.js";
import { MirrorShape2D } from "../../../features/mirror-shape2d.js";
import { Extrude } from "../../../features/extrude.js";
import { Revolve } from "../../../features/revolve.js";
import { Sweep } from "../../../features/sweep.js";
import { ShapeProps } from "../../../oc/props.js";

// Stage 0 invariant (plans/sketch-edge-selection): every sketch feature shape
// is an individual Edge — connect was the only wire emitter.
//
// Note: consecutive source edges must not touch — connect always builds a
// bridge between consecutive edges, and a zero-length bridge aborts in OCCT
// (pre-existing limitation, unrelated to edge emission). All profiles here
// leave gaps: (0,0)→(80,0) line, gap, (90,20)→(90,60) line, closed by two
// bridges into the quad (0,0),(80,0),(90,20),(90,60) — shoelace area 2600.
describe("connect", () => {
  setupOC();

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("edge emission invariant", () => {
    it("emits individual edges, never a wire", () => {
      let c: Connect;
      const s = sketch("xy", () => {
        hLine(80);
        move([90, 20]);
        vLine(40);
        c = connect() as Connect;
      }) as Sketch;

      render();

      // Two lines + two closing bridges, each an individual Edge.
      const shapes = c.getShapes();
      expect(shapes).toHaveLength(4);
      for (const shape of shapes) {
        expect(shape.getType()).toBe("edge");
      }

      const sketchShapes = s.getShapes();
      expect(sketchShapes.every(shape => shape.getType() !== "wire")).toBe(true);
    });

    it("maps every connect edge to the connect object in getEdgesWithOwner without warnings", () => {
      const warn = vi.spyOn(console, "warn");

      let c: Connect;
      const s = sketch("xy", () => {
        hLine(80);
        move([90, 20]);
        vLine(40);
        c = connect() as Connect;
      }) as Sketch;

      render();

      const edgeMap = s.getEdgesWithOwner();
      expect(edgeMap.size).toBe(4);
      for (const owner of edgeMap.values()) {
        expect(owner).toBe(c);
      }

      const wireWarnings = warn.mock.calls.filter(args =>
        String(args[0]).includes("emitted a Wire shape"));
      expect(wireWarnings).toHaveLength(0);
    });

    it("emits edges for arc mode bridges too", () => {
      let c: Connect;
      sketch("xy", () => {
        hLine(80);
        move([90, 20]);
        vLine(40);
        c = connect("arc") as Connect;
      });

      render();

      const shapes = c.getShapes();
      expect(shapes).toHaveLength(4);
      for (const shape of shapes) {
        expect(shape.getType()).toBe("edge");
      }
    });
  });

  describe("extrude over a connect profile", () => {
    it("produces a solid with the exact profile volume", () => {
      sketch("xy", () => {
        hLine(80);
        move([90, 20]);
        vLine(40);
        connect();
      });

      const e = extrude(10) as Extrude;

      render();

      const shapes = e.getShapes();
      expect(shapes).toHaveLength(1);
      expect(shapes[0].getType()).toBe("solid");

      // Quad (0,0),(80,0),(90,20),(90,60): shoelace area 2600, height 10.
      const props = ShapeProps.getProperties(shapes[0].getShape());
      expect(props.volumeMm3).toBeCloseTo(2600 * 10, 3);
    });
  });

  describe("revolve over a connect profile", () => {
    it("produces a solid with positive volume", () => {
      sketch("xz", () => {
        move([20, 0]);
        hLine(10);
        move([35, 10]);
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

  describe("sweep over a connect profile", () => {
    it("produces a solid", () => {
      const profile = sketch("xy", () => {
        hLine(20);
        move([25, 5]);
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

  describe("offset of a connect result", () => {
    it("produces offset edges alongside the connect edges", () => {
      const s = sketch("xy", () => {
        hLine(80);
        move([90, 20]);
        vLine(40);
        connect();
        offset(5);
      }) as Sketch;

      render();

      // 4 connect edges + offset ring edges, all individual edges.
      const shapes = s.getShapes();
      expect(shapes.length).toBeGreaterThan(4);
      expect(shapes.every(shape => shape.getType() !== "wire")).toBe(true);
    });
  });

  describe("mirror of a connect result", () => {
    it("copies the connect edges as edges, not a wire", () => {
      let m: MirrorShape2D;
      sketch("xy", () => {
        move([10, 0]);
        hLine(80);
        move([95, 20]);
        vLine(40);
        connect();
        m = mirror("y") as MirrorShape2D;
      });

      render();

      const shapes = m.getShapes().filter(shape => !shape.isMetaShape() && !shape.isGuideShape());
      expect(shapes).toHaveLength(4);
      for (const shape of shapes) {
        expect(shape.getType()).toBe("edge");
      }
    });
  });

  describe("closed curves are skipped", () => {
    it("leaves a full circle untouched while closing the open edges", () => {
      let c: Connect;
      const s = sketch("xy", () => {
        circle(10);
        move([30, 0]);
        hLine(20);
        move([55, 10]);
        vLine(20);
        c = connect() as Connect;
      }) as Sketch;

      render();

      expect(c.getShapes()).toHaveLength(4);

      // Circle edge stays with its own feature; nothing is a wire.
      const shapes = s.getShapes();
      expect(shapes).toHaveLength(5);
      expect(shapes.every(shape => shape.getType() !== "wire")).toBe(true);
    });
  });
});
