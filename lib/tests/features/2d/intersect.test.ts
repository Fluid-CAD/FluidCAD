import { describe, it, expect } from "vitest";
import { setupOC, render } from "../../setup.js";
import sketch from "../../../core/sketch.js";
import extrude from "../../../core/extrude.js";
import { intersect, rect } from "../../../core/2d/index.js";
import { Extrude } from "../../../features/extrude.js";
import { Sketch } from "../../../features/2d/sketch.js";

describe("intersect", () => {
  setupOC();

  describe("intersect 3D shape with sketch plane", () => {
    it("should produce section edges from a box intersected by a sketch plane", () => {
      sketch("xy", () => {
        rect(100, 50);
      });

      const e = extrude(30) as Extrude;

      const s = sketch("xy", () => {
        intersect(e);
      }) as Sketch;

      render();

      const shapes = s.getShapes();
      expect(shapes.length).toBeGreaterThan(0);
    });
  });
});
