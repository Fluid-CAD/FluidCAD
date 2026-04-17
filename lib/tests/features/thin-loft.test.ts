import { describe, it, expect } from "vitest";
import { setupOC, render } from "../setup.js";
import sketch from "../../core/sketch.js";
import plane from "../../core/plane.js";
import loft from "../../core/loft.js";
import extrude from "../../core/extrude.js";
import { rect, circle } from "../../core/2d/index.js";
import { Loft } from "../../features/loft.js";
import { Face } from "../../common/face.js";
import { Edge } from "../../common/edge.js";
import { ShapeOps } from "../../oc/shape-ops.js";
import { ShapeProps } from "../../oc/props.js";
import { EdgeQuery } from "../../oc/edge-query.js";

describe("thin loft", () => {
  setupOC();

  describe("closed profile - same size", () => {
    it("should create a thin-walled loft between two rects", () => {
      const s1 = sketch("xy", () => {
        rect(40, 40);
      });

      const s2 = sketch(plane("xy", { offset: 30 }), () => {
        rect(40, 40);
      });

      const l = loft(s1, s2).thin(5) as Loft;
      render();

      const shapes = l.getShapes();
      expect(shapes).toHaveLength(1);
      expect(shapes[0].getType()).toBe("solid");

      const bbox = ShapeOps.getBoundingBox(shapes[0]);
      expect(bbox.maxZ - bbox.minZ).toBeCloseTo(30, 0);
    });

    it("should have less volume than a solid loft", () => {
      const s1 = sketch("xy", () => {
        rect(60, 60);
      });

      const s2 = sketch(plane("xy", { offset: 40 }), () => {
        rect(60, 60);
      });

      const solidS1 = sketch("xy", () => {
        rect(60, 60);
      });

      const solidS2 = sketch(plane("xy", { offset: 40 }), () => {
        rect(60, 60);
      });

      const thinLoft = loft(s1, s2).thin(3).new() as Loft;
      const solidLoft = loft(solidS1, solidS2).new() as Loft;
      render();

      const thinVolume = ShapeProps.getProperties(thinLoft.getShapes()[0].getShape()).volumeMm3;
      const solidVolume = ShapeProps.getProperties(solidLoft.getShapes()[0].getShape()).volumeMm3;
      expect(thinVolume).toBeLessThan(solidVolume * 0.9);
      expect(thinVolume).toBeGreaterThan(0);
    });
  });

  describe("closed profile - different sizes", () => {
    it("should create a thin-walled tapered loft", () => {
      const s1 = sketch("xy", () => {
        rect(40, 40);
      });

      const s2 = sketch(plane("xy", { offset: 30 }), () => {
        rect(20, 20);
      });

      const l = loft(s1, s2).thin(3) as Loft;
      render();

      const shapes = l.getShapes();
      expect(shapes).toHaveLength(1);
      expect(shapes[0].getType()).toBe("solid");
    });

    it("should create a thin-walled loft between circle and rect", () => {
      const s1 = sketch("xy", () => {
        circle(20);
      });

      const s2 = sketch(plane("xy", { offset: 30 }), () => {
        rect(30, 30);
      });

      const l = loft(s1, s2).thin(3) as Loft;
      render();

      const shapes = l.getShapes();
      expect(shapes).toHaveLength(1);
      expect(shapes[0].getType()).toBe("solid");
    });
  });

  describe("dual offset", () => {
    it("should create a thin-walled loft with dual offset", () => {
      const s1 = sketch("xy", () => {
        circle(40);
      });

      const s2 = sketch(plane("xy", { offset: 30 }), () => {
        circle(40);
      });

      const l = loft(s1, s2).thin(5, -3).new() as Loft;
      render();

      const shapes = l.getShapes();
      expect(shapes).toHaveLength(1);
      expect(shapes[0].getType()).toBe("solid");

      const edges = shapes[0].getSubShapes('edge') as Edge[];
      const circleEdges = edges.filter(e => EdgeQuery.isCircleEdge(e));
      expect(circleEdges).toHaveLength(4);
    });
  });

  describe("face classification", () => {
    it("should classify start and end faces", () => {
      const s1 = sketch("xy", () => {
        rect(40, 40);
      });

      const s2 = sketch(plane("xy", { offset: 30 }), () => {
        rect(40, 40);
      });

      const l = loft(s1, s2).thin(5) as Loft;
      render();

      const startFaces = l.getState('start-faces') as Face[];
      const endFaces = l.getState('end-faces') as Face[];
      const sideFaces = l.getState('side-faces') as Face[];

      expect(startFaces.length).toBeGreaterThan(0);
      expect(endFaces.length).toBeGreaterThan(0);
      expect(sideFaces.length).toBeGreaterThan(0);
    });
  });

  describe("three profiles", () => {
    it("should create a thin-walled loft through three profiles", () => {
      const s1 = sketch("xy", () => {
        rect(40, 40);
      });

      const s2 = sketch(plane("xy", { offset: 20 }), () => {
        rect(30, 30);
      });

      const s3 = sketch(plane("xy", { offset: 40 }), () => {
        rect(40, 40);
      });

      const l = loft(s1, s2, s3).thin(3) as Loft;
      render();

      const shapes = l.getShapes();
      expect(shapes).toHaveLength(1);
      expect(shapes[0].getType()).toBe("solid");
    });
  });

  describe("remove mode", () => {
    it("should cut a thin-walled loft from existing geometry", () => {
      sketch("xy", () => {
        rect(200, 200);
      });
      extrude(50);

      const s1 = sketch("xy", () => {
        rect(40, 40);
      });

      const s2 = sketch(plane("xy", { offset: 40 }), () => {
        rect(40, 40);
      });

      const l = loft(s1, s2).thin(5).remove() as Loft;
      render();

      const shapes = l.getShapes();
      expect(shapes.length).toBeGreaterThan(0);
    });
  });
});
