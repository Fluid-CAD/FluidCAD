import { describe, it, expect } from "vitest";
import { setupOC, render } from "../../setup.js";
import sketch from "../../../core/sketch.js";
import plane from "../../../core/plane.js";
import extrude from "../../../core/extrude.js";
import { circle, move } from "../../../core/2d/index.js";
import { ExtrudeBase } from "../../../features/extrude-base.js";
import { Circle } from "../../../features/2d/circle.js";
import { Edge } from "../../../common/edge.js";
import { Vertex } from "../../../common/vertex.js";
import { Solid } from "../../../common/solid.js";
import { ShapeOps } from "../../../oc/shape-ops.js";
import { EdgeQuery } from "../../../oc/edge-query.js";
import { getFacesByType } from "../../utils.js";

describe("circle", () => {
  setupOC();

  describe("in sketch", () => {
    it("should create a circle with default diameter", () => {
      sketch("xy", () => {
        circle();
      });
      const e = extrude(10) as ExtrudeBase;
      render();

      const solid = e.getShapes()[0] as Solid;
      // Default diameter is 40
      const bbox = ShapeOps.getBoundingBox(solid);
      expect(bbox.maxX - bbox.minX).toBeCloseTo(40, 0);
    });

    it("should create a circle with given diameter", () => {
      sketch("xy", () => {
        circle(60);
      });
      const e = extrude(10) as ExtrudeBase;
      render();

      const solid = e.getShapes()[0] as Solid;
      const bbox = ShapeOps.getBoundingBox(solid);
      expect(bbox.maxX - bbox.minX).toBeCloseTo(60, 0);
    });

    it("should create a circle at a given center", () => {
      sketch("xy", () => {
        circle([50, 30], 40);
      });
      const e = extrude(10) as ExtrudeBase;
      render();

      const bbox = ShapeOps.getBoundingBox(e.getShapes()[0]);
      expect(bbox.centerX).toBeCloseTo(50, 0);
      expect(bbox.centerY).toBeCloseTo(30, 0);
    });

    it("should place the center meta vertex on the sketch plane", () => {
      let c: Circle;
      sketch(plane("yz", { offset: 25 }), () => {
        c = circle([10, 20], 30) as Circle;
      });
      render();

      const shapes = c.getShapes({ excludeMeta: false, excludeGuide: false });
      const centerVertex = shapes.find(s => s.isVertex() && s.isMetaShape());
      expect(centerVertex).toBeDefined();

      const edge = shapes.find(s => s instanceof Edge) as Edge;
      const circleData = EdgeQuery.getCircleDataFromEdge(edge);
      const centerPoint = (centerVertex as Vertex).toPoint();

      // The meta vertex must coincide with the perimeter's world-space center.
      expect(centerPoint.x).toBeCloseTo(circleData.center.x, 6);
      expect(centerPoint.y).toBeCloseTo(circleData.center.y, 6);
      expect(centerPoint.z).toBeCloseTo(circleData.center.z, 6);
      expect(centerPoint.x).toBeCloseTo(25, 6);
    });

    it("should produce a cylinder when extruded", () => {
      sketch("xy", () => {
        circle(50);
      });
      const e = extrude(30) as ExtrudeBase;
      render();

      const solid = e.getShapes()[0] as Solid;
      // Cylinder has 2 circular + 1 cylindrical face
      expect(getFacesByType(solid, "circle")).toHaveLength(2);
      expect(getFacesByType(solid, "cylinder")).toHaveLength(1);
    });
  });
});
