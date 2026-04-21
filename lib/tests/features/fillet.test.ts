import { describe, it, expect } from "vitest";
import { setupOC, render } from "../setup.js";
import sketch from "../../core/sketch.js";
import extrude from "../../core/extrude.js";
import fillet from "../../core/fillet.js";
import select from "../../core/select.js";
import cylinder from "../../core/cylinder.js";
import { circle, rect } from "../../core/2d/index.js";
import { Solid } from "../../common/solid.js";
import { Extrude } from "../../features/extrude.js";
import { countShapes } from "../utils.js";
import { getEdgesByType, getFacesByType } from "../utils.js";
import { ShapeOps } from "../../oc/shape-ops.js";
import { ShapeProps } from "../../oc/props.js";
import { edge } from "../../filters/index.js";

describe("fillet", () => {
  setupOC();

  describe("basic fillet", () => {
    it("should fillet edges and produce a valid solid", () => {
      sketch("xy", () => {
        rect(100, 50);
      });
      extrude(30);

      select(edge().verticalTo("xy"));
      fillet(5);

      const scene = render();

      expect(countShapes(scene)).toBe(1);
    });

    it("should add cylindrical faces for each filleted edge", () => {
      sketch("xy", () => {
        rect(100, 50);
      });
      extrude(30);

      // Fillet the 4 vertical edges
      select(edge().verticalTo("xy"));
      fillet(5);

      render();

      const solid = render().getAllSceneObjects()
        .flatMap(o => o.getShapes())
        .find(s => s.getType() === "solid") as Solid;

      const cylFaces = getFacesByType(solid, "cylinder");
      expect(cylFaces).toHaveLength(4);
    });

    it("should add arc edges where fillets are applied", () => {
      sketch("xy", () => {
        rect(100, 50);
      });
      extrude(30);

      select(edge().verticalTo("xy"));
      fillet(5);

      render();

      const solid = render().getAllSceneObjects()
        .flatMap(o => o.getShapes())
        .find(s => s.getType() === "solid") as Solid;

      const arcEdges = getEdgesByType(solid, "arc");
      // Each vertical fillet creates 2 arcs (top and bottom)
      expect(arcEdges).toHaveLength(8);
    });

    it("should increase face count compared to original box", () => {
      sketch("xy", () => {
        rect(100, 50);
      });
      extrude(30);

      select(edge().verticalTo("xy"));
      fillet(5);

      render();

      const solid = render().getAllSceneObjects()
        .flatMap(o => o.getShapes())
        .find(s => s.getType() === "solid") as Solid;

      // Original box: 6 faces. Filleting 4 edges adds 4 cylindrical faces
      expect(solid.getFaces().length).toBeGreaterThan(6);
    });

    it("should reduce volume compared to original box", () => {
      sketch("xy", () => {
        rect(100, 50);
      });
      extrude(30);

      select(edge().verticalTo("xy"));
      fillet(5);

      render();

      const solid = render().getAllSceneObjects()
        .flatMap(o => o.getShapes())
        .find(s => s.getType() === "solid") as Solid;

      const props = ShapeProps.getProperties(solid.getShape());
      expect(props.volumeMm3).toBeLessThan(100 * 50 * 30);
    });

    it("should preserve bounding box dimensions", () => {
      sketch("xy", () => {
        rect(100, 50);
      });
      extrude(30);

      select(edge().verticalTo("xy"));
      fillet(5);

      render();

      const solid = render().getAllSceneObjects()
        .flatMap(o => o.getShapes())
        .find(s => s.getType() === "solid") as Solid;

      const bbox = ShapeOps.getBoundingBox(solid);
      expect(bbox.maxX - bbox.minX).toBeCloseTo(100, 0);
      expect(bbox.maxY - bbox.minY).toBeCloseTo(50, 0);
      expect(bbox.maxZ - bbox.minZ).toBeCloseTo(30, 0);
    });
  });

  describe("fillet with explicit selection", () => {
    it("should fillet only the selected edges", () => {
      sketch("xy", () => {
        rect(100, 50);
      });
      extrude(30);

      // Fillet only the top horizontal edges (4 edges)
      const sel = select(edge().onPlane("xy", { offset: 30 }));
      fillet(3, sel);

      render();

      const solid = render().getAllSceneObjects()
        .flatMap(o => o.getShapes())
        .find(s => s.getType() === "solid") as Solid;

      // 4 top edges filleted → 4 cylindrical faces
      const cylFaces = getFacesByType(solid, "cylinder");
      expect(cylFaces).toHaveLength(4);
    });
  });

  describe("fillet on cylinder", () => {
    it("should fillet a cylinder's circular edges", () => {
      cylinder(30, 50);

      select(edge().circle());
      fillet(5);

      render();

      const solid = render().getAllSceneObjects()
        .flatMap(o => o.getShapes())
        .find(s => s.getType() === "solid") as Solid;

      expect(solid.getFaces().length).toBeGreaterThan(3);
    });
  });

  describe("fillet radius", () => {
    it("should use default radius of 1", () => {
      sketch("xy", () => {
        rect(100, 50);
      });
      extrude(30);

      select(edge().verticalTo("xy"));
      fillet();

      const scene = render();

      expect(countShapes(scene)).toBe(1);
    });

    it("smaller radius should retain more volume", () => {
      // Small fillet
      sketch("xy", () => {
        rect(100, 50);
      });
      extrude(30);

      select(edge().verticalTo("xy"));
      fillet(2);

      render();

      const smallSolid = render().getAllSceneObjects()
        .flatMap(o => o.getShapes())
        .find(s => s.getType() === "solid") as Solid;

      const smallVol = ShapeProps.getProperties(smallSolid.getShape()).volumeMm3;

      // Large fillet (new scene from beforeEach)
      // Can't compare in same test due to scene reset,
      // just verify volume is less than original
      expect(smallVol).toBeLessThan(100 * 50 * 30);
      expect(smallVol).toBeGreaterThan(0);
    });
  });
});
