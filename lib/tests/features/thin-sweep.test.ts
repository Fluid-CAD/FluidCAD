import { describe, it, expect } from "vitest";
import { setupOC, render } from "../setup.js";
import sketch from "../../core/sketch.js";
import sweep from "../../core/sweep.js";
import extrude from "../../core/extrude.js";
import { circle, rect, vLine, line } from "../../core/2d/index.js";
import { Sweep } from "../../features/sweep.js";
import { Face } from "../../common/face.js";
import { Edge } from "../../common/edge.js";
import { ShapeOps } from "../../oc/shape-ops.js";
import { ShapeProps } from "../../oc/props.js";
import { EdgeQuery } from "../../oc/edge-query.js";

describe("thin sweep", () => {
  setupOC();

  describe("closed profile", () => {
    it("should create a thin-walled swept solid with single offset", () => {
      const profile = sketch("xy", () => {
        rect(20, 20);
      });

      const path = sketch("xz", () => {
        vLine(50);
      });

      const s = sweep(path, profile).thin(3) as Sweep;
      render();

      const shapes = s.getShapes();
      expect(shapes).toHaveLength(1);
      expect(shapes[0].getType()).toBe("solid");

      const bbox = ShapeOps.getBoundingBox(shapes[0]);
      expect(bbox.maxZ - bbox.minZ).toBeCloseTo(50, 0);
    });

    it("should have less volume than a solid sweep", () => {
      const profile = sketch("xy", () => {
        circle(20);
      });

      const path = sketch("xz", () => {
        vLine(50);
      });

      const s = sweep(path, profile).thin(5) as Sweep;
      render();

      const solid = s.getShapes()[0];
      const thinVolume = ShapeProps.getProperties(solid.getShape()).volumeMm3;
      const fullVolume = Math.PI * 20 * 20 * 50;
      expect(thinVolume).toBeLessThan(fullVolume * 0.9);
      expect(thinVolume).toBeGreaterThan(0);
    });

    it("should classify internal faces for closed profile", () => {
      const profile = sketch("xy", () => {
        rect(30, 30);
      });

      const path = sketch("xz", () => {
        vLine(40);
      });

      const s = sweep(path, profile).thin(5) as Sweep;
      render();

      const internalFaces = s.getState('internal-faces') as Face[];
      expect(internalFaces.length).toBeGreaterThan(0);
    });

    it("should create a thin-walled solid with dual offset", () => {
      const profile = sketch("xy", () => {
        circle(20);
      });

      const path = sketch("xz", () => {
        vLine(40);
      });

      const s = sweep(path, profile).thin(5, -3).new() as Sweep;
      render();

      const shapes = s.getShapes();
      expect(shapes).toHaveLength(1);
      expect(shapes[0].getType()).toBe("solid");

      const edges = shapes[0].getSubShapes('edge') as Edge[];
      const circleEdges = edges.filter(e => EdgeQuery.isCircleEdge(e));
      expect(circleEdges).toHaveLength(4);
    });
  });

  describe("open profile", () => {
    it("should create a thin-walled solid from an open profile", () => {
      const profile = sketch("xy", () => {
        line([0, 0], [30, 0]);
      });

      const path = sketch("xz", () => {
        vLine(40);
      });

      const s = sweep(path, profile).thin(5).new() as Sweep;
      render();

      const shapes = s.getShapes();
      expect(shapes).toHaveLength(1);
      expect(shapes[0].getType()).toBe("solid");
    });

    it("should classify side, internal, and cap faces for open profile", () => {
      const profile = sketch("xy", () => {
        line([0, 0], [30, 0]);
      });

      const path = sketch("xz", () => {
        vLine(40);
      });

      const s = sweep(path, profile).thin(5).new() as Sweep;
      render();

      const sideFaces = s.getState('side-faces') as Face[];
      const internalFaces = s.getState('internal-faces') as Face[];
      const capFaces = s.getState('cap-faces') as Face[];

      expect(sideFaces.length).toBeGreaterThan(0);
      expect(internalFaces.length).toBeGreaterThan(0);
      expect(capFaces.length).toBe(2);
    });
  });

  describe("remove mode", () => {
    it("should cut a thin-walled sweep from existing geometry", () => {
      sketch("xy", () => {
        rect(200, 200);
      });
      extrude(80);

      const profile = sketch("xy", () => {
        rect(30, 30);
      });

      const path = sketch("xz", () => {
        vLine(80);
      });

      const s = sweep(path, profile).thin(5).remove() as Sweep;
      render();

      const shapes = s.getShapes();
      expect(shapes.length).toBeGreaterThan(0);
    });
  });
});
