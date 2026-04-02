import { describe, it, expect } from "vitest";
import { setupOC, render } from "../../setup.js";
import sketch from "../../../core/sketch.js";
import extrude from "../../../core/extrude.js";
import { slot, move } from "../../../core/2d/index.js";
import { ExtrudeBase } from "../../../features/extrude-base.js";
import { Solid } from "../../../common/solid.js";
import { ShapeOps } from "../../../oc/shape-ops.js";
import { getEdgesByType } from "../../utils.js";

describe("slot", () => {
  setupOC();

  describe("in sketch", () => {
    it("should create a slot with distance and radius", () => {
      sketch("xy", () => {
        slot(80, 15);
      });
      const e = extrude(10) as ExtrudeBase;
      render();

      const solid = e.getShapes()[0] as Solid;
      const bbox = ShapeOps.getBoundingBox(solid);
      // Slot total width = distance + 2*radius = 80 + 30 = 110
      expect(bbox.maxX - bbox.minX).toBeCloseTo(110, 0);
      // Slot height = 2*radius = 30
      expect(bbox.maxY - bbox.minY).toBeCloseTo(30, 0);
    });

    it("should produce arc edges from rounded ends", () => {
      sketch("xy", () => {
        slot(60, 10);
      });
      const e = extrude(10) as ExtrudeBase;
      render();

      const solid = e.getShapes()[0] as Solid;
      // Slot has arc edges at its rounded ends
      const arcEdges = getEdgesByType(solid, "arc");
      expect(arcEdges.length).toBeGreaterThan(0);
    });
  });

  describe("standalone with targetPlane", () => {
    it("should create a slot on a specific plane", () => {
      slot(60, 10, "xy");
      const e = extrude(10) as ExtrudeBase;
      render();

      expect(e.getShapes()).toHaveLength(1);
    });
  });
});
