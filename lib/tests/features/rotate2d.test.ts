import { describe, it, expect } from "vitest";
import { setupOC, render } from "../setup.js";
import sketch from "../../core/sketch.js";
import extrude from "../../core/extrude.js";
import rotate from "../../core/rotate.js";
import { ExtrudeBase } from "../../features/extrude-base.js";
import { Sketch } from "../../features/2d/sketch.js";
import { Rotate2D } from "../../features/rotate2d.js";
import { testRect } from "../helpers/profiles.js";

describe("rotate 2D", () => {
  setupOC();

  describe("rotate geometry inside sketch", () => {
    it("should rotate a rect inside a sketch", () => {
      // legacy: move([30, 0]); rect(20, 10); rotate(90) about the pen [50, 10]
      sketch("xy", () => {
          const r = testRect(20, 10, { at: [30, 0] });
          rotate(90, [50, 10], r.b, r.r, r.t, r.l);
        });

      const e = extrude(5) as ExtrudeBase;

      render();

      const shapes = e.getShapes();
      expect(shapes).toHaveLength(1);
    });

    it("should rotate all geometry when no target specified", () => {
      sketch("xy", () => {
          testRect(20, 10, { at: [30, 0] });
          rotate(90, [50, 10]);
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
          const r = testRect(20, 10, { at: [30, 0] });
          rotate(90, [50, 10], r.b, r.r, r.t, r.l);
        }) as Sketch;

      render();

      // The rect's original edges should be removed (move mode strips
      // source shapes). Children 0..3 are the four testRect lines.
      const children = s.getChildren();
      const rectLine = children[1]; // b is 0, r is 1
      expect(rectLine.getShapes()).toHaveLength(0);
    });

    it("should keep original when copy is true", () => {
      const s = sketch("xy", () => {
          const r = testRect(20, 10, { at: [30, 0] });
          rotate(90, [50, 10], true, r.b, r.r, r.t, r.l);
        }) as Sketch;

      render();

      const children = s.getChildren();
      const rectLine = children[1];
      expect(rectLine.getShapes().length).toBeGreaterThan(0);
    });
  });

  describe("rotate specific target (2D)", () => {
    it("should only rotate the specified geometry", () => {
      // legacy pen after the second rect landed at [20, 60] — that cursor
      // was the implicit rotation center.
      sketch("xy", () => {
          const r1 = testRect(20, 10, { at: [30, 0] });
          testRect(20, 10, { at: [0, 50] });
          rotate(90, [20, 60], r1.b, r1.r, r1.t, r1.l);
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
          testRect(20, 10, { at: [30, 0] });
          const r2 = testRect(20, 10, { at: [30, 50] });
          // legacy cursor (implicit center) after the second rect: [50, 60]
          rot = rotate(90, [50, 60], true)
            .exclude(r2.b, r2.r, r2.t, r2.l) as Rotate2D;
        });

      render();

      // Only r1 should have been rotated (r2 excluded)
      // 1 rotated rect = 4 edges
      expect(rot.getAddedShapes()).toHaveLength(4);
    });

    it("should narrow an explicit target list with exclude", () => {
      let rot: Rotate2D;
      sketch("xy", () => {
          const r1 = testRect(20, 10, { at: [30, 0] });
          const r2 = testRect(20, 10, { at: [30, 50] });
          rot = rotate(90, [50, 60], true, r1.b, r1.r, r1.t, r1.l, r2.b, r2.r, r2.t, r2.l)
            .exclude(r2.b, r2.r, r2.t, r2.l) as Rotate2D;
        });

      render();

      // 1 rotated rect = 4 edges
      expect(rot.getAddedShapes()).toHaveLength(4);
    });

    it("should accumulate exclusions across chained calls", () => {
      let rot: Rotate2D;
      sketch("xy", () => {
          const r1 = testRect(20, 10, { at: [30, 0] });
          const r2 = testRect(20, 10, { at: [30, 50] });
          testRect(20, 10, { at: [30, 100] });
          // legacy cursor (implicit center) after the third rect: [50, 110]
          rot = rotate(90, [50, 110], true)
            .exclude(r1.b, r1.r, r1.t, r1.l)
            .exclude(r2.b, r2.r, r2.t, r2.l) as Rotate2D;
        });

      render();

      // Only r3 rotated; r1 and r2 excluded
      // 1 rotated rect = 4 edges
      expect(rot.getAddedShapes()).toHaveLength(4);
    });
  });
});
