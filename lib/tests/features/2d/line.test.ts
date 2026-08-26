import { describe, it, expect } from "vitest";
import { setupOC, render } from "../../setup.js";
import sketch from "../../../core/sketch.js";
import extrude from "../../../core/extrude.js";
import { line } from "../../../core/2d/index.js";
import { ExtrudeBase } from "../../../features/extrude-base.js";
import { Solid } from "../../../common/solid.js";
import { ShapeOps } from "../../../oc/shape-ops.js";
import { Sketch } from "../../../features/2d/sketch.js";
import { Edge } from "../../../common/edge.js";
import { coincident, horizontal, vertical } from "../../../core/constraints/index.js";

describe("line functions", () => {
  setupOC();

  describe("line", () => {
    it("should create a line between two points", () => {
      const s = sketch("xy", () => {
        line([0, 0], [100, 0]);
      }) as Sketch;

      render();

      const shapes = s.getShapes();
      expect(shapes.length).toBeGreaterThan(0);
    });
  });

  describe("combined line functions", () => {
    it("should create an L-shape with hLine and vLine", () => {
      sketch("xy", () => {
          const sg11 = line([0, 0], [100, 0]);
          const sg12 = line([100, 0], [100, 50]);
          const sg13 = line([100, 50], [40, 50]);
          const sg14 = line([40, 50], [40, 80]);
          const sg15 = line([40, 80], [0, 80]);
          const sg16 = line([0, 80], [0, 0]);
          horizontal(sg11);
          coincident(sg11.end(), sg12.start());
          vertical(sg12);
          coincident(sg12.end(), sg13.start());
          horizontal(sg13);
          coincident(sg13.end(), sg14.start());
          vertical(sg14);
          coincident(sg14.end(), sg15.start());
          horizontal(sg15);
          coincident(sg15.end(), sg16.start());
          vertical(sg16);
          coincident(sg16.end(), sg11.start());
        });
      const e = extrude(10) as ExtrudeBase;
      render();

      const solid = e.getShapes()[0] as Solid;
      // L-shape has more than 6 faces
      expect(solid.getFaces().length).toBeGreaterThan(6);
    });
  });
});
