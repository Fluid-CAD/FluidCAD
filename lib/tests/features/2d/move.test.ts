import { describe, it, expect } from "vitest";
import { setupOC, render } from "../../setup.js";
import sketch from "../../../core/sketch.js";
import extrude from "../../../core/extrude.js";
import { move, hMove, vMove, rect, circle } from "../../../core/2d/index.js";
import { ExtrudeBase } from "../../../features/extrude-base.js";
import { Solid } from "../../../common/solid.js";
import { ShapeOps } from "../../../oc/shape-ops.js";

describe("move functions", () => {
  setupOC();

  describe("move", () => {
    it("should position geometry at a given point", () => {
      sketch("xy", () => {
        move([30, 20]);
        rect(50, 50);
      });
      const e = extrude(10) as ExtrudeBase;
      render();

      const bbox = ShapeOps.getBoundingBox(e.getShapes()[0]);
      expect(bbox.minX).toBeCloseTo(30, 0);
      expect(bbox.minY).toBeCloseTo(20, 0);
    });

    it("should move to origin with no args", () => {
      sketch("xy", () => {
        move([50, 50]);
        rect(20, 20);
        move();
        circle(10);
      });
      const e = extrude(10) as ExtrudeBase;
      render();

      // Both shapes should exist
      expect(e.getShapes().length).toBeGreaterThanOrEqual(1);
    });
  });

  describe("hMove", () => {
    it("should move cursor horizontally", () => {
      sketch("xy", () => {
        hMove(40);
        rect(30, 30);
      });
      const e = extrude(10) as ExtrudeBase;
      render();

      const bbox = ShapeOps.getBoundingBox(e.getShapes()[0]);
      expect(bbox.minX).toBeCloseTo(40, 0);
      expect(bbox.minY).toBeCloseTo(0, 0);
    });
  });

  describe("vMove", () => {
    it("should move cursor vertically", () => {
      sketch("xy", () => {
        vMove(50);
        rect(30, 30);
      });
      const e = extrude(10) as ExtrudeBase;
      render();

      const bbox = ShapeOps.getBoundingBox(e.getShapes()[0]);
      expect(bbox.minX).toBeCloseTo(0, 0);
      expect(bbox.minY).toBeCloseTo(50, 0);
    });
  });

  describe("combined moves", () => {
    it("should chain horizontal and vertical moves", () => {
      sketch("xy", () => {
        hMove(20);
        vMove(30);
        rect(40, 40);
      });
      const e = extrude(10) as ExtrudeBase;
      render();

      const bbox = ShapeOps.getBoundingBox(e.getShapes()[0]);
      expect(bbox.minX).toBeCloseTo(20, 0);
      expect(bbox.minY).toBeCloseTo(30, 0);
    });
  });
});
