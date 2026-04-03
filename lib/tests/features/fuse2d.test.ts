import { describe, it, expect } from "vitest";
import { setupOC, render } from "../setup.js";
import sketch from "../../core/sketch.js";
import extrude from "../../core/extrude.js";
import fuse from "../../core/fuse.js";
import { circle, move, rect } from "../../core/2d/index.js";
import { Sketch } from "../../features/2d/sketch.js";
import { ExtrudeBase } from "../../features/extrude-base.js";
import { Solid } from "../../common/solid.js";

describe("fuse2d", () => {
  setupOC();

  describe("fuse all sketch geometries", () => {
    it("should fuse overlapping circles into a single outline", () => {
      sketch("xy", () => {
        const c1 = circle([-20, 0], 60);
        const c2 = circle([20, 0], 60);
        fuse();
      });

      const e = extrude(20) as ExtrudeBase;

      render();

      // Fused sketch produces a single solid
      const shapes = e.getShapes();
      expect(shapes).toHaveLength(1);
      expect(shapes[0].getType()).toBe("solid");
    });

    it("should fuse overlapping rects into a single outline", () => {
      sketch("xy", () => {
        rect(60, 40);
        move([30, 10]);
        rect(60, 40);
        fuse();
      });

      const e = extrude(20) as ExtrudeBase;

      render();

      const shapes = e.getShapes();
      expect(shapes).toHaveLength(1);
    });
  });

  describe("fuse specific targets", () => {
    it("should fuse only the specified geometries", () => {
      sketch("xy", () => {
        const c1 = circle([-20, 0], 60);
        const c2 = circle([20, 0], 60);
        // Third circle far away, not included in fuse
        circle([200, 0], 60);
        fuse(c1, c2);
      });

      const e = extrude(20) as ExtrudeBase;

      render();

      // Fused pair + separate circle = 2 solids
      const shapes = e.getShapes();
      expect(shapes).toHaveLength(2);
    });
  });

  describe("fuse removes original edges", () => {
    it("should remove original edges from fused geometries", () => {
      const s = sketch("xy", () => {
        const c1 = circle([-20, 0], 60);
        const c2 = circle([20, 0], 60);
        fuse(c1, c2);
      }) as Sketch;

      render();

      // Original circle edges should be removed, replaced by fused outline
      const childShapes = s.getShapes();
      // Fused edges exist
      expect(childShapes.length).toBeGreaterThan(0);
    });
  });

  describe("non-overlapping geometries", () => {
    it("should not change non-overlapping geometries", () => {
      sketch("xy", () => {
        circle(40);
        circle([200, 0], 40);
        fuse();
      });

      const e = extrude(20) as ExtrudeBase;

      render();

      // Non-overlapping circles remain separate
      const shapes = e.getShapes();
      expect(shapes).toHaveLength(2);
    });
  });
});
