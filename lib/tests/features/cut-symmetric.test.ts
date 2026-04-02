import { describe, it, expect } from "vitest";
import { setupOC, render } from "../setup.js";
import sketch from "../../core/sketch.js";
import extrude from "../../core/extrude.js";
import cut from "../../core/cut.js";
import { circle, move, rect } from "../../core/2d/index.js";
import { Solid } from "../../common/solid.js";
import { ExtrudeSymmetric } from "../../features/extrude-symmetric.js";
import { CutSymmetric } from "../../features/cut-symmetric.js";
import { countShapes } from "../utils.js";
import { ShapeOps } from "../../oc/shape-ops.js";

describe("cut symmetric", () => {
  setupOC();

  describe("symmetric cut by distance", () => {
    it("should cut symmetrically from both sides of the sketch plane", () => {
      // Symmetric extrude spans z=-25 to z=+25, sketch plane is at z=0
      sketch("xy", () => {
        rect(100, 100);
      });
      extrude(50, true);

      // Sketch on xy (z=0) is in the middle of the solid
      sketch("xy", () => {
        move([25, 25]);
        rect(50, 50);
      });
      cut(20, true);

      const scene = render();

      expect(countShapes(scene)).toBe(1);

      const solid = scene.getAllSceneObjects()
        .flatMap(o => o.getShapes())
        .find(s => s.getType() === "solid") as Solid;

      // A box with a symmetric pocket has more than 6 faces
      expect(solid.getFaces().length).toBeGreaterThan(6);
    });

    it("should preserve the outer dimensions of the solid", () => {
      sketch("xy", () => {
        rect(100, 100);
      });
      extrude(50, true);

      sketch("xy", () => {
        move([25, 25]);
        rect(50, 50);
      });
      cut(30, true);

      const scene = render();

      expect(countShapes(scene)).toBe(1);

      const solid = scene.getAllSceneObjects()
        .flatMap(o => o.getShapes())
        .find(s => s.getType() === "solid") as Solid;

      const bbox = ShapeOps.getBoundingBox(solid);
      expect(bbox.minZ).toBeCloseTo(-25, 0);
      expect(bbox.maxZ).toBeCloseTo(25, 0);
    });
  });

  describe("symmetric cut through all", () => {
    it("should cut all the way through the solid symmetrically", () => {
      sketch("xy", () => {
        rect(100, 100);
      });
      extrude(50, true);

      sketch("xy", () => {
        move([25, 25]);
        circle(20);
      });
      cut(true);

      const scene = render();

      expect(countShapes(scene)).toBe(1);

      const solid = scene.getAllSceneObjects()
        .flatMap(o => o.getShapes())
        .find(s => s.getType() === "solid") as Solid;

      // Through-all symmetric cut with a circle creates a hole
      expect(solid.getFaces().length).toBeGreaterThan(6);
    });
  });

  describe("section edges", () => {
    it("should expose section edges", () => {
      sketch("xy", () => {
        rect(100, 100);
      });
      extrude(50, true);

      sketch("xy", () => {
        move([25, 25]);
        rect(50, 50);
      });
      const c = cut(20, true) as CutSymmetric;

      render();

      const edges = c.edges().getShapes();
      expect(edges.length).toBeGreaterThan(0);
      for (const edge of edges) {
        expect(edge.getType()).toBe("edge");
      }
    });
  });

  describe("pick", () => {
    it("should only cut the picked region", () => {
      sketch("xy", () => {
        rect(100, 100);
      });
      extrude(50, true);

      sketch("xy", () => {
        move([25, 25]);
        circle(15);
        move([75, 25]);
        circle(15);
      });
      const c = cut(20, true).pick([25, 25]) as CutSymmetric;

      render();

      const shapes = c.getShapes();
      expect(shapes.length).toBeGreaterThan(0);
      expect(shapes[0].getType()).toBe("solid");
    });
  });
});
