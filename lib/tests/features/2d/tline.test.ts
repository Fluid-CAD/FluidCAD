import { describe, it, expect } from "vitest";
import { setupOC, render } from "../../setup.js";
import sketch from "../../../core/sketch.js";
import extrude from "../../../core/extrude.js";
import { tLine, circle, hLine, vLine } from "../../../core/2d/index.js";
import { ExtrudeBase } from "../../../features/extrude-base.js";
import { Sketch } from "../../../features/2d/sketch.js";

describe("tLine", () => {
  setupOC();

  describe("tangent line from previous geometry", () => {
    it("should create a tangent line with given distance", () => {
      const s = sketch("xy", () => {
        hLine(50);
        tLine(30);
      }) as Sketch;
      render();

      const shapes = s.getShapes();
      // hLine + tLine = at least 2 edges
      expect(shapes.length).toBeGreaterThanOrEqual(2);
    });
  });

  describe("tangent line between two objects", () => {
    it("should create a tangent line between two circles", () => {
      sketch("xy", () => {
        const c1 = circle(40);
        const c2 = circle([80, 0], 40);
        tLine(c1, c2);
      });
      const e = extrude(10) as ExtrudeBase;
      render();

      // Two circles + tangent line form a closed region when extruded
      const shapes = e.getShapes();
      expect(shapes.length).toBeGreaterThanOrEqual(1);
    });
  });
});
