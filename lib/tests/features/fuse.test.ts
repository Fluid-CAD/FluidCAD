import { describe, it, expect } from "vitest";
import { setupOC, render } from "../setup.js";
import sketch from "../../core/sketch.js";
import extrude from "../../core/extrude.js";
import fuse from "../../core/fuse.js";
import cylinder from "../../core/cylinder.js";
import { circle, move, rect } from "../../core/2d/index.js";
import { Solid } from "../../common/solid.js";
import { ExtrudeBase } from "../../features/extrude-base.js";
import { Fuse } from "../../features/fuse.js";
import { countShapes } from "../utils.js";
import { ShapeOps } from "../../oc/shape-ops.js";

describe("fuse", () => {
  setupOC();

  describe("fuse specific objects", () => {
    it("should fuse two intersecting solids into one", () => {
      sketch("xy", () => {
        rect(100, 50);
      });
      const e1 = extrude(30).new();

      sketch("xy", () => {
        move([50, 0]);
        rect(100, 50);
      });
      const e2 = extrude(30).new();

      fuse(e1, e2);

      const scene = render();

      expect(countShapes(scene)).toBe(1);
    });

    it("should not fuse non-intersecting solids", () => {
      sketch("xy", () => {
        rect(50, 50);
      });
      const e1 = extrude(30).new();

      sketch("xy", () => {
        move([200, 0]);
        rect(50, 50);
      });
      const e2 = extrude(30).new();

      fuse(e1, e2);

      const scene = render();

      expect(countShapes(scene)).toBe(2);
    });

    it("should remove original shapes from fused objects", () => {
      sketch("xy", () => {
        rect(100, 50);
      });
      const e1 = extrude(30).new() as ExtrudeBase;

      sketch("xy", () => {
        move([50, 0]);
        rect(100, 50);
      });
      const e2 = extrude(30).new() as ExtrudeBase;

      fuse(e1, e2);

      render();

      expect(e1.getShapes()).toHaveLength(0);
      expect(e2.getShapes()).toHaveLength(0);
    });

    it("should fuse a box and a cylinder", () => {
      sketch("xy", () => {
        rect(100, 50);
      });
      const e1 = extrude(30).new();

      const c = cylinder(30, 30);

      fuse(e1, c);

      const scene = render();

      expect(countShapes(scene)).toBe(1);
    });
  });

  describe("fuse all", () => {
    it("should fuse all solids in the scene", () => {
      sketch("xy", () => {
        rect(100, 50);
      });
      extrude(30).new();

      sketch("xy", () => {
        move([50, 0]);
        rect(100, 50);
      });
      extrude(30).new();

      fuse();

      const scene = render();

      expect(countShapes(scene)).toBe(1);
    });

    it("should fuse multiple overlapping solids into one", () => {
      sketch("xy", () => {
        rect(50, 50);
      });
      extrude(30).new();

      sketch("xy", () => {
        move([25, 0]);
        rect(50, 50);
      });
      extrude(30).new();

      sketch("xy", () => {
        move([50, 0]);
        rect(50, 50);
      });
      extrude(30).new();

      fuse();

      const scene = render();

      expect(countShapes(scene)).toBe(1);
    });
  });

  describe("fused solid geometry", () => {
    it("should produce a solid wider than either input", () => {
      sketch("xy", () => {
        rect(100, 50);
      });
      const e1 = extrude(30).new();

      sketch("xy", () => {
        move([50, 0]);
        rect(100, 50);
      });
      const e2 = extrude(30).new();

      const f = fuse(e1, e2) as Fuse;

      render();

      const solid = f.getShapes()[0];
      const bbox = ShapeOps.getBoundingBox(solid);
      // Combined: x from 0 to 150
      expect(bbox.minX).toBeCloseTo(0, 0);
      expect(bbox.maxX).toBeCloseTo(150, 0);
    });
  });
});
