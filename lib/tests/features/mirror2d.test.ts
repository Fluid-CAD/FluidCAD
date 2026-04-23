import { describe, it, expect } from "vitest";
import { setupOC, render } from "../setup.js";
import sketch from "../../core/sketch.js";
import extrude from "../../core/extrude.js";
import mirror from "../../core/mirror.js";
import local from "../../core/local.js";
import { move, rect, circle } from "../../core/2d/index.js";
import { ExtrudeBase } from "../../features/extrude-base.js";
import { MirrorShape2D } from "../../features/mirror-shape2d.js";
import { ShapeOps } from "../../oc/shape-ops.js";

describe("mirror (2D)", () => {
  setupOC();

  describe("mirror sketch geometry across axis", () => {
    it("should mirror a circle across the Y axis", () => {
      sketch("xy", () => {
        move([30, 0]);
        const c = circle(20);
        mirror("y", c);
      });

      const e = extrude(10) as ExtrudeBase;

      render();

      const shapes = e.getShapes();
      // Original circle + mirrored circle → should produce solids on both sides
      expect(shapes.length).toBeGreaterThanOrEqual(1);

      // Overall bbox should span negative X (mirrored) and positive X (original)
      const allBBoxes = shapes.map(s => ShapeOps.getBoundingBox(s));
      const minX = Math.min(...allBBoxes.map(b => b.minX));
      const maxX = Math.max(...allBBoxes.map(b => b.maxX));
      expect(minX).toBeLessThan(0);
      expect(maxX).toBeGreaterThan(0);
    });

    it("should mirror a rect across the X axis", () => {
      sketch("xy", () => {
        move([0, 20]);
        const r = rect(30, 20);
        mirror("x", r);
      });

      const e = extrude(10) as ExtrudeBase;

      render();

      const shapes = e.getShapes();
      expect(shapes.length).toBeGreaterThanOrEqual(1);

      const allBBoxes = shapes.map(s => ShapeOps.getBoundingBox(s));
      const minY = Math.min(...allBBoxes.map(b => b.minY));
      const maxY = Math.max(...allBBoxes.map(b => b.maxY));
      expect(minY).toBeLessThan(0);
      expect(maxY).toBeGreaterThan(0);
    });
  });

  describe("mirror produces shapes", () => {
    it("should add mirrored edges to the sketch", () => {
      const m = { ref: null as MirrorShape2D };

      sketch("xy", () => {
        move([30, 0]);
        const c = circle(20);
        m.ref = mirror("y", c) as MirrorShape2D;
      });

      render();

      // The mirror object should have produced shapes
      expect(m.ref.getAddedShapes().length).toBeGreaterThan(0);
    });
  });

  describe("mirror specific geometry", () => {
    it("should mirror only the specified geometry", () => {
      sketch("xy", () => {
        move([30, 0]);
        const c1 = circle(20);
        move([0, 50]);
        circle(20);
        mirror("y", c1);
      });

      const e = extrude(10) as ExtrudeBase;

      render();

      // Should have shapes from original c1 + mirrored c1 + c2
      const shapes = e.getShapes();
      expect(shapes.length).toBeGreaterThanOrEqual(2);
    });
  });

  describe("local() axis wrapper", () => {
    it("should fail when mirroring across a world axis parallel to the sketch plane normal", () => {
      let mirrorRef: MirrorShape2D;

      sketch("front", () => {
        move([30, 0]);
        const c = circle(20);
        mirrorRef = mirror("y", c) as MirrorShape2D;
      });

      render();

      expect(mirrorRef.getError()).toBeTruthy();
    });

    it("should mirror across sketch-local Y on a non-XY plane via local()", () => {
      sketch("front", () => {
        move([30, 0]);
        const c = circle(20);
        mirror(local("y"), c);
      });

      const e = extrude(10) as ExtrudeBase;

      render();

      const shapes = e.getShapes();
      expect(shapes.length).toBeGreaterThanOrEqual(1);

      // Mirroring across sketch-local Y on the "front" plane flips world X,
      // so bbox should span both sides of X=0.
      const allBBoxes = shapes.map(s => ShapeOps.getBoundingBox(s));
      const minX = Math.min(...allBBoxes.map(b => b.minX));
      const maxX = Math.max(...allBBoxes.map(b => b.maxX));
      expect(minX).toBeLessThan(0);
      expect(maxX).toBeGreaterThan(0);
    });

    it("should throw when local() is called outside a sketch", () => {
      expect(() => local("y")).toThrow();
    });
  });
});
