import { describe, it, expect } from "vitest";
import { setupOC, render, addToScene } from "../setup.js";
import sketch from "../../core/sketch.js";
import extrude from "../../core/extrude.js";
import cut from "../../core/cut.js";
import { circle, move, rect } from "../../core/2d/index.js";
import { Solid } from "../../common/solid.js";
import { ExtrudeBase } from "../../features/extrude-base.js";
import { countShapes, getFacesByType } from "../utils.js";
import { ShapeOps } from "../../oc/shape-ops.js";
import { SceneObject } from "../../common/scene-object.js";

describe("cut two distances", () => {
  setupOC();

  describe("two distances behavior", () => {
    it("should cut with different depths in each direction", () => {
      // Symmetric extrude spans z=-25 to z=+25, sketch plane is at z=0
      sketch("xy", () => {
        rect(100, 100);
      });
      extrude(50).symmetric();

      sketch("xy", () => {
        move([25, 25]);
        rect(50, 50);
      });
      cut(20, 10);

      const scene = render();

      expect(countShapes(scene)).toBe(1);

      const solid = scene.getAllSceneObjects()
        .flatMap(o => o.getShapes())
        .find(s => s.getType() === "solid") as Solid;

      // Rectangular asymmetric pocket: all faces planar, more than original 6
      expect(getFacesByType(solid, "plane").length).toBeGreaterThan(6);
      expect(getFacesByType(solid, "cylinder")).toHaveLength(0);
    });

    it("should remove the extrudable sketch shapes", () => {
      sketch("xy", () => {
        rect(100, 100);
      });
      extrude(50).symmetric();

      const s = sketch("xy", () => {
        move([25, 25]);
        rect(50, 50);
      }) as SceneObject;

      cut(20, 10);

      render();

      expect(s.getShapes()).toHaveLength(0);
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
      const c = cut(20, 10) as ExtrudeBase;
      const edgesObj = c.edges();
      addToScene(edgesObj);

      render();

      const edges = edgesObj.getShapes();
      expect(edges.length).toBeGreaterThan(0);
      for (const edge of edges) {
        expect(edge.getType()).toBe("edge");
      }
    });

    it("should expose specific edge by index", () => {
      sketch("xy", () => {
        rect(100, 100);
      });
      extrude(50).symmetric();

      sketch("xy", () => {
        move([25, 25]);
        rect(50, 50);
      });
      const c = cut(20, 10) as ExtrudeBase;
      const edge0 = c.edges(0);
      const edge1 = c.edges(1);
      addToScene(edge0);
      addToScene(edge1);

      render();

      expect(edge0.getShapes()).toHaveLength(1);
      expect(edge1.getShapes()).toHaveLength(1);
      expect(edge0.getShapes()[0].isSame(edge1.getShapes()[0])).toBe(false);
    });
  });

  describe("fuse scope", () => {
    it("should only cut the targeted object", () => {
      sketch("xy", () => {
        rect(100, 100);
      });
      const e1 = extrude(50).symmetric();

      sketch("xy", () => {
        move([200, 0]);
        rect(100, 100);
      });
      extrude(50).symmetric();

      sketch("xy", () => {
        move([25, 25]);
        rect(50, 50);
      });
      cut(20, 10).scope(e1);

      const scene = render();

      // First box is cut, second box is untouched — 2 shapes
      expect(countShapes(scene)).toBe(2);
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
      const c = cut(20, 10).pick([25, 25]) as ExtrudeBase;

      render();

      const shapes = c.getShapes();
      expect(shapes.length).toBeGreaterThan(0);
      expect(shapes[0].getType()).toBe("solid");
    });
  });
});
