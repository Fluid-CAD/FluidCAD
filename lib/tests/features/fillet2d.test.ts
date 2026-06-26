import { describe, it, expect } from "vitest";
import { setupOC, render } from "../setup.js";
import sketch from "../../core/sketch.js";
import extrude from "../../core/extrude.js";
import fillet from "../../core/fillet.js";
import fuse from "../../core/fuse.js";
import { arc, hMove, rect, vLine, hLine, vMove, back } from "../../core/2d/index.js";
import { Solid } from "../../common/solid.js";
import { ExtrudeBase } from "../../features/extrude-base.js";
import { Sketch } from "../../features/2d/sketch.js";
import { getEdgesByType } from "../utils.js";

describe("fillet2d", () => {
  setupOC();

  describe("fillet all corners", () => {
    it("should fillet all corners of a rectangle", () => {
      sketch("xy", () => {
        rect(100, 50);
        fillet(5);
      });

      const e = extrude(20) as ExtrudeBase;

      render();

      const shapes = e.getShapes();
      expect(shapes).toHaveLength(1);
      expect(shapes[0].getType()).toBe("solid");

      const solid = shapes[0] as Solid;
      // Filleted rect produces arc edges on top and bottom faces
      const arcEdges = getEdgesByType(solid, "arc");
      expect(arcEdges.length).toBeGreaterThan(0);
    });

    it("should replace sharp corners with arcs", () => {
      const s = sketch("xy", () => {
        rect(100, 50);
        fillet(5);
      }) as Sketch;

      render();

      // The sketch edges should contain arcs from the fillets
      const edges = s.getShapes();
      expect(edges.length).toBeGreaterThan(4);
    });
  });

  describe("fillet specific targets", () => {
    it("should fillet only the specified geometry", () => {
      sketch("xy", () => {
        const r = rect(100, 50);
        fillet([r], 5);
      });

      const e = extrude(20) as ExtrudeBase;

      render();

      const shapes = e.getShapes();
      expect(shapes).toHaveLength(1);

      const solid = shapes[0] as Solid;
      // Filleted rect on top and bottom: 4 arcs per face = 8 arcs total
      expect(getEdgesByType(solid, "arc")).toHaveLength(8);
      // 4 shortened sides per face (8) + 4 vertical edges each split into segments (8) = 16
      expect(getEdgesByType(solid, "line")).toHaveLength(16);
    });

    it("should fillet a corner passed as radius-first spread args", () => {
      const s = sketch("xy", () => {
        const l1 = hLine(40);
        const l2 = vLine(-40);
        fillet(8, l1, l2);
      }) as Sketch;

      render();

      // The corner is rounded: each line is shortened and one fillet arc inserted.
      // Before the radius-first spread dispatch existed, fillet(8, l1, l2) was a
      // silent no-op (returned undefined) and produced 0 arcs.
      expect(getEdgesByType(s.getEdges(), "arc")).toHaveLength(1);
      expect(getEdgesByType(s.getEdges(), "line")).toHaveLength(2);
    });

    it("fillets an arc/line corner passed as radius-first spread args", () => {
      // The exact shape from the original bug report: a fillet between an arc (l1)
      // and a line (l2) requested as fillet(radius, l2, l1). Before the radius-first
      // spread form was dispatched, this was a silent no-op while fillet(8) (all
      // corners) rounded the same arc/line corner.
      const s = sketch("front", () => {
        vMove(10);
        const gl = hLine(140).guide().centered();
        back();
        vMove(33 + 16);
        hLine(8);
        vLine(-16);
        hLine(15 - 8);
        const l1 = arc(gl.end()).radius(55);
        const l2 = vLine(-10);
        fillet(8, l2, l1);
      }) as Sketch;

      render();

      // Baseline (no fillet) is 1 arc; rounding the arc/line corner shortens the
      // original arc and inserts the fillet arc -> 2 arcs. The array form
      // fillet([l2, l1], 8) produces the identical result.
      expect(getEdgesByType(s.getEdges(), "arc")).toHaveLength(2);
    });
  });

  describe("fillet radius", () => {
    it("should use default radius of 1", () => {
      sketch("xy", () => {
        rect(100, 50);
        fillet();
      });

      const e = extrude(20) as ExtrudeBase;

      render();

      const shapes = e.getShapes();
      expect(shapes).toHaveLength(1);

      const solid = shapes[0] as Solid;
      const arcEdges = getEdgesByType(solid, "arc");
      expect(arcEdges.length).toBeGreaterThan(0);
    });
  });

  describe("wire orientation", () => {
    it("fillets a fused shape built from CW rectangles (negative height)", () => {
      const s = sketch("xz", () => {
        rect(2, -2);
        hMove(-2);
        rect(4, -2);

        fuse();
        fillet(1);
      }) as Sketch;

      render();

      const arcs = getEdgesByType(s.getEdges(), "arc");
      expect(arcs.length).toBeGreaterThan(0);
    });
  });

});
