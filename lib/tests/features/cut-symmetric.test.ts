import { describe, it, expect } from "vitest";
import { setupOC, render, addToScene } from "../setup.js";
import sketch from "../../core/sketch.js";
import extrude from "../../core/extrude.js";
import cut from "../../core/cut.js";
import { circle, move, rect } from "../../core/2d/index.js";
import { Solid } from "../../common/solid.js";
import { ExtrudeBase } from "../../features/extrude-base.js";
import { countShapes, getFacesByType, getEdgesByType } from "../utils.js";
import { ShapeOps } from "../../oc/shape-ops.js";

describe("cut symmetric", () => {
  setupOC();

  describe("symmetric cut by distance", () => {
    it("should cut symmetrically from both sides of the sketch plane", () => {
      sketch("xy", () => {
        rect(100, 100);
      });
      extrude(50).symmetric();

      sketch("xy", () => {
        move([25, 25]);
        rect(50, 50);
      });
      extrude(20).symmetric().remove();

      const scene = render();

      expect(countShapes(scene)).toBe(1);

      const solid = scene.getAllSceneObjects()
        .flatMap(o => o.getShapes())
        .find(s => s.getType() === "solid") as Solid;

      expect(getFacesByType(solid, "plane").length).toBeGreaterThan(6);
      expect(getFacesByType(solid, "cylinder")).toHaveLength(0);
    });

    it("should preserve the outer dimensions of the solid", () => {
      sketch("xy", () => {
        rect(100, 100);
      });
      extrude(50).symmetric();

      sketch("xy", () => {
        move([25, 25]);
        rect(50, 50);
      });
      extrude(30).symmetric().remove();

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
      extrude(50).symmetric();

      sketch("xy", () => {
        move([25, 25]);
        circle(40);
      });
      extrude(0).symmetric().remove();

      const scene = render();

      expect(countShapes(scene)).toBe(1);

      const solid = scene.getAllSceneObjects()
        .flatMap(o => o.getShapes())
        .find(s => s.getType() === "solid") as Solid;

      expect(getFacesByType(solid, "cylinder")).toHaveLength(1);
      expect(getEdgesByType(solid, "circle").length).toBeGreaterThanOrEqual(2);

      // Verify the hole spans both sides (symmetric about z=0)
      const bbox = ShapeOps.getBoundingBox(solid);
      expect(bbox.minZ).toBeCloseTo(-25, 0);
      expect(bbox.maxZ).toBeCloseTo(25, 0);

      // The cylindrical hole should have circle edges on both the top and bottom faces
      const circleEdges = getEdgesByType(solid, "circle");
      const edgeBBoxes = circleEdges.map(e => ShapeOps.getBoundingBox(e));
      const hasTopEdge = edgeBBoxes.some(b => Math.abs(b.minZ - 25) < 1);
      const hasBottomEdge = edgeBBoxes.some(b => Math.abs(b.maxZ + 25) < 1);
      expect(hasTopEdge).toBe(true);
      expect(hasBottomEdge).toBe(true);
    });
  });

  describe("section edges", () => {
    it("should expose section edges", () => {
      sketch("xy", () => {
        rect(100, 100);
      });
      extrude(50).symmetric();

      sketch("xy", () => {
        move([25, 25]);
        rect(50, 50);
      });
      const c = extrude(20).symmetric().remove() as ExtrudeBase;
      const edgesObj = c.edges();
      addToScene(edgesObj);

      render();

      const edges = edgesObj.getShapes();
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
      extrude(50).symmetric();

      sketch("xy", () => {
        move([25, 25]);
        circle(30);
        move([75, 25]);
        circle(30);
      });
      const c = extrude(20).symmetric().remove().pick([25, 25]) as ExtrudeBase;

      render();

      const shapes = c.getShapes();
      expect(shapes.length).toBeGreaterThan(0);
      expect(shapes[0].getType()).toBe("solid");
    });
  });
});
