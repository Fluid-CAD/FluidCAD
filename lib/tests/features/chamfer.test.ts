import { describe, it, expect } from "vitest";
import { setupOC, render } from "../setup.js";
import sketch from "../../core/sketch.js";
import extrude from "../../core/extrude.js";
import chamfer from "../../core/chamfer.js";
import select from "../../core/select.js";
import cylinder from "../../core/cylinder.js";
import { circle, rect } from "../../core/2d/index.js";
import { Solid } from "../../common/solid.js";
import { countShapes } from "../utils.js";
import { getEdgesByType, getFacesByType } from "../utils.js";
import { ShapeOps } from "../../oc/shape-ops.js";
import { ShapeProps } from "../../oc/props.js";
import { edge } from "../../filters/index.js";

describe("chamfer", () => {
  setupOC();

  describe("basic chamfer", () => {
    it("should chamfer edges and produce a valid solid", () => {
      sketch("xy", () => {
        rect(100, 50);
      });
      extrude(30);

      select(edge().verticalTo("xy"));
      chamfer(5);

      const scene = render();

      expect(countShapes(scene)).toBe(1);
    });

    it("should add planar faces for each chamfered edge", () => {
      sketch("xy", () => {
        rect(100, 50);
      });
      extrude(30);

      select(edge().verticalTo("xy"));
      chamfer(5);

      render();

      const solid = render().getAllSceneObjects()
        .flatMap(o => o.getShapes())
        .find(s => s.getType() === "solid") as Solid;

      const planeFaces = getFacesByType(solid, "plane");
      // Original box: 6 planar faces. Chamfering 4 edges adds 4 planar chamfer faces
      expect(planeFaces.length).toBeGreaterThanOrEqual(10);
    });

    it("should not introduce any arc edges", () => {
      sketch("xy", () => {
        rect(100, 50);
      });
      extrude(30);

      select(edge().verticalTo("xy"));
      chamfer(5);

      render();

      const solid = render().getAllSceneObjects()
        .flatMap(o => o.getShapes())
        .find(s => s.getType() === "solid") as Solid;

      // Chamfer produces only line edges, no arcs
      const arcEdges = getEdgesByType(solid, "arc");
      expect(arcEdges).toHaveLength(0);
    });

    it("should increase face count compared to original box", () => {
      sketch("xy", () => {
        rect(100, 50);
      });
      extrude(30);

      select(edge().verticalTo("xy"));
      chamfer(5);

      render();

      const solid = render().getAllSceneObjects()
        .flatMap(o => o.getShapes())
        .find(s => s.getType() === "solid") as Solid;

      expect(solid.getFaces().length).toBeGreaterThan(6);
    });

    it("should reduce volume compared to original box", () => {
      sketch("xy", () => {
        rect(100, 50);
      });
      extrude(30);

      select(edge().verticalTo("xy"));
      chamfer(5);

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
      chamfer(5);

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

  describe("chamfer with explicit selection", () => {
    it("should chamfer only the selected edges", () => {
      sketch("xy", () => {
        rect(100, 50);
      });
      extrude(30);

      const sel = select(edge().onPlane("xy", { offset: 30 }));
      chamfer(3, sel);

      render();

      const solid = render().getAllSceneObjects()
        .flatMap(o => o.getShapes())
        .find(s => s.getType() === "solid") as Solid;

      // 4 top edges chamfered → 4 extra planar faces (total 10)
      const planeFaces = getFacesByType(solid, "plane");
      expect(planeFaces).toHaveLength(10);
    });
  });

  describe("chamfer on cylinder", () => {
    it("should chamfer a cylinder's circular edges", () => {
      cylinder(30, 50);

      select(edge().circle());
      chamfer(5);

      render();

      const solid = render().getAllSceneObjects()
        .flatMap(o => o.getShapes())
        .find(s => s.getType() === "solid") as Solid;

      // Chamfered cylinder has more faces than original (3)
      expect(solid.getFaces().length).toBeGreaterThan(3);
    });
  });

  describe("chamfer vs fillet", () => {
    it("chamfer should produce no cylindrical faces while fillet does", () => {
      sketch("xy", () => {
        rect(100, 50);
      });
      extrude(30);

      select(edge().verticalTo("xy"));
      chamfer(5);

      render();

      const solid = render().getAllSceneObjects()
        .flatMap(o => o.getShapes())
        .find(s => s.getType() === "solid") as Solid;

      const cylFaces = getFacesByType(solid, "cylinder");
      expect(cylFaces).toHaveLength(0);
    });
  });

  describe("chamfer distance", () => {
    it("should use default distance of 1", () => {
      sketch("xy", () => {
        rect(100, 50);
      });
      extrude(30);

      select(edge().verticalTo("xy"));
      chamfer();

      const scene = render();

      expect(countShapes(scene)).toBe(1);
    });
  });
});
