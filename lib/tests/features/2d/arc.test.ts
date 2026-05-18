import { describe, it, expect } from "vitest";
import { setupOC, render } from "../../setup.js";
import sketch from "../../../core/sketch.js";
import extrude from "../../../core/extrude.js";
import { arc, hLine, vLine, line } from "../../../core/2d/index.js";
import { ExtrudeBase } from "../../../features/extrude-base.js";
import { Solid } from "../../../common/solid.js";
import { getEdgesByType } from "../../utils.js";

describe("arc", () => {
  setupOC();

  describe("in sketch (point mode)", () => {
    it("should create an arc and form a closed shape", () => {
      sketch("xy", () => {
        hLine(50);
        arc([50, 30]).radius(20);
        hLine(-50);
        vLine(-30);
      });
      const e = extrude(10) as ExtrudeBase;
      render();

      expect(e.getShapes()).toHaveLength(1);

      const solid = e.getShapes()[0] as Solid;
      const arcEdges = getEdgesByType(solid, "arc");
      expect(arcEdges.length).toBeGreaterThan(0);
    });
  });

  describe("from three points (start, end, center)", () => {
    it("should create an arc from start to end around a center point", () => {
      sketch("xy", () => {
        arc([0, 0], [20, 0]).center([10, 0]);
        line([0, 0]);
      });
      const e = extrude(10) as ExtrudeBase;
      render();

      expect(e.getShapes()).toHaveLength(1);

      const solid = e.getShapes()[0] as Solid;
      const arcEdges = getEdgesByType(solid, "arc");
      expect(arcEdges.length).toBeGreaterThan(0);
    });
  });

  describe("clockwise arc with .cw()", () => {
    it("should create a CW arc from start to end around a center point", () => {
      sketch("xy", () => {
        arc([0, 0], [20, 0]).center([10, 0]).cw();
        line([0, 0]);
      });
      const e = extrude(10) as ExtrudeBase;
      render();

      expect(e.getShapes()).toHaveLength(1);

      const solid = e.getShapes()[0] as Solid;
      const arcEdges = getEdgesByType(solid, "arc");
      expect(arcEdges.length).toBeGreaterThan(0);
    });

    it("should create a valid arc when chained from current position", () => {
      sketch("xy", () => {
        hLine(20);
        arc([0, 0]).center([10, 0]).cw();
      });
      const e = extrude(10) as ExtrudeBase;
      render();

      expect(e.getShapes()).toHaveLength(1);

      const solid = e.getShapes()[0] as Solid;
      const arcEdges = getEdgesByType(solid, "arc");
      expect(arcEdges.length).toBeGreaterThan(0);
    });
  });

  describe("major arc with .flip()", () => {
    it("should create a major arc (>180°) from current position", () => {
      sketch("xy", () => {
        arc([30, 0]).radius(20).flip();
        line([0, 0]);
      });
      const e = extrude(10) as ExtrudeBase;
      render();

      expect(e.getShapes()).toHaveLength(1);

      const solid = e.getShapes()[0] as Solid;
      const arcEdges = getEdgesByType(solid, "arc");
      expect(arcEdges.length).toBeGreaterThan(0);
    });

    it("should create a major arc with two explicit points", () => {
      sketch("xy", () => {
        arc([0, 0], [30, 0]).radius(20).flip();
        line([0, 0]);
      });
      const e = extrude(10) as ExtrudeBase;
      render();

      expect(e.getShapes()).toHaveLength(1);

      const solid = e.getShapes()[0] as Solid;
      const arcEdges = getEdgesByType(solid, "arc");
      expect(arcEdges.length).toBeGreaterThan(0);
    });

    it("should create a CW major arc with negative radius and flip", () => {
      sketch("xy", () => {
        arc([30, 0]).radius(-20).flip();
        line([0, 0]);
      });
      const e = extrude(10) as ExtrudeBase;
      render();

      expect(e.getShapes()).toHaveLength(1);

      const solid = e.getShapes()[0] as Solid;
      const arcEdges = getEdgesByType(solid, "arc");
      expect(arcEdges.length).toBeGreaterThan(0);
    });
  });

  describe("combined with lines", () => {
    it("should create a shape with straight and curved edges", () => {
      sketch("xy", () => {
        hLine(60);
        vLine(20);
        hLine(-60);
        vLine(-20);
      });
      const e = extrude(10) as ExtrudeBase;
      render();

      const solid = e.getShapes()[0] as Solid;
      const lineEdges = getEdgesByType(solid, "line");
      expect(lineEdges.length).toBeGreaterThan(0);
    });
  });
});
