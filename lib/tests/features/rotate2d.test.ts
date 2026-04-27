import { describe, it, expect } from "vitest";
import { setupOC, render } from "../setup.js";
import sketch from "../../core/sketch.js";
import extrude from "../../core/extrude.js";
import rotate from "../../core/rotate.js";
import { move, rect, circle } from "../../core/2d/index.js";
import { ExtrudeBase } from "../../features/extrude-base.js";
import { Sketch } from "../../features/2d/sketch.js";
import { Rotate2D } from "../../features/rotate2d.js";
import { ShapeOps } from "../../oc/shape-ops.js";

describe("rotate 2D", () => {
  setupOC();

  describe("rotate geometry inside sketch", () => {
    it("should rotate a rect inside a sketch", () => {
      sketch("xy", () => {
        move([30, 0]);
        const r = rect(20, 10);
        rotate(90, r);
      });

      const e = extrude(5) as ExtrudeBase;

      render();

      const shapes = e.getShapes();
      expect(shapes).toHaveLength(1);
    });

    it("should rotate all geometry when no target specified", () => {
      sketch("xy", () => {
        move([30, 0]);
        rect(20, 10);
        rotate(90);
      });

      const e = extrude(5) as ExtrudeBase;

      render();

      const shapes = e.getShapes();
      expect(shapes).toHaveLength(1);
    });
  });

  describe("move vs copy (2D)", () => {
    it("should move the geometry by default", () => {
      const s = sketch("xy", () => {
        move([30, 0]);
        const r = rect(20, 10);
        rotate(90, r);
      }) as Sketch;

      render();

      // The rect's original edges should be removed
      const children = s.getChildren();
      const rectObj = children[1]; // move is 0, rect is 1
      expect(rectObj.getShapes()).toHaveLength(0);
    });

    it("should keep original when copy is true", () => {
      const s = sketch("xy", () => {
        move([30, 0]);
        const r = rect(20, 10);
        rotate(90, true, r);
      }) as Sketch;

      render();

      const children = s.getChildren();
      const rectObj = children[1];
      expect(rectObj.getShapes().length).toBeGreaterThan(0);
    });
  });

  describe("rotate specific target (2D)", () => {
    it("should only rotate the specified geometry", () => {
      sketch("xy", () => {
        move([30, 0]);
        const r1 = rect(20, 10);
        move([0, 50]);
        const r2 = rect(20, 10);
        rotate(90, r1);
      });

      const e = extrude(5) as ExtrudeBase;

      render();

      // Both rects produce solids (one rotated, one not)
      const shapes = e.getShapes();
      expect(shapes.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe("rotate (2D) with .exclude()", () => {
    it("should skip an excluded geometry when rotating all sketch siblings", () => {
      let rot: Rotate2D;
      sketch("xy", () => {
        move([30, 0]);
        const r1 = rect(20, 10);
        move([30, 50]);
        const r2 = rect(20, 10);
        rot = rotate(90, true).exclude(r2) as Rotate2D;
        void r1;
      });

      render();

      // Only r1 should have been rotated (r2 excluded)
      // 1 rotated rect = 4 edges
expect(rot.getAddedShapes()).toHaveLength(4);
    });

    it("should narrow an explicit target list with exclude", () => {
      let rot: Rotate2D;
      sketch("xy", () => {
        move([30, 0]);
        const r1 = rect(20, 10);
        move([30, 50]);
        const r2 = rect(20, 10);
        rot = rotate(90, true, r1, r2).exclude(r2) as Rotate2D;
      });

      render();

      // 1 rotated rect = 4 edges
expect(rot.getAddedShapes()).toHaveLength(4);
    });

    it("should accumulate exclusions across chained calls", () => {
      let rot: Rotate2D;
      sketch("xy", () => {
        move([30, 0]);
        const r1 = rect(20, 10);
        move([30, 50]);
        const r2 = rect(20, 10);
        move([30, 100]);
        const r3 = rect(20, 10);
        rot = rotate(90, true).exclude(r1).exclude(r2) as Rotate2D;
        void r3;
      });

      render();

      // Only r3 rotated; r1 and r2 excluded
      // 1 rotated rect = 4 edges
expect(rot.getAddedShapes()).toHaveLength(4);
    });
  });
});
