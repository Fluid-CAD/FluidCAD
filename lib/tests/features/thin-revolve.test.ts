import { describe, it, expect } from "vitest";
import { setupOC, render } from "../setup.js";
import sketch from "../../core/sketch.js";
import revolve from "../../core/revolve.js";
import extrude from "../../core/extrude.js";
import { move, rect, circle, line, vLine } from "../../core/2d/index.js";
import { Revolve } from "../../features/revolve.js";
import { Face } from "../../common/face.js";
import { Edge } from "../../common/edge.js";
import { ShapeProps } from "../../oc/props.js";
import { EdgeQuery } from "../../oc/edge-query.js";

describe("thin revolve", () => {
  setupOC();

  describe("closed profile - full revolution", () => {
    it("should create a thin-walled revolved solid", () => {
      sketch("xz", () => {
        move([20, 0]);
        rect(10, 20);
      });

      const r = revolve("z").thin(3) as Revolve;
      render();

      const shapes = r.getShapes();
      expect(shapes).toHaveLength(1);
      expect(shapes[0].getType()).toBe("solid");
    });

    it("should have less volume than a solid revolve of the same profile", () => {
      sketch("xz", () => {
        move([20, 0]);
        rect(10, 20);
      });

      const thinR = revolve("z").thin(3).new() as Revolve;

      sketch("xz", () => {
        move([20, 0]);
        rect(10, 20);
      });

      const solidR = revolve("z").new() as Revolve;
      render();

      const thinVolume = ShapeProps.getProperties(thinR.getShapes()[0].getShape()).volumeMm3;
      const solidVolume = ShapeProps.getProperties(solidR.getShapes()[0].getShape()).volumeMm3;
      expect(thinVolume).toBeGreaterThan(0);
      expect(thinVolume).not.toBeCloseTo(solidVolume, -1);
    });

    it("should classify internal faces for closed profile with partial revolve", () => {
      sketch("xz", () => {
        move([20, 0]);
        rect(10, 20);
      });

      const r = revolve("z", 180).thin(3) as Revolve;
      render();

      const internalFaces = r.getState('internal-faces') as Face[];
      expect(internalFaces.length).toBeGreaterThan(0);
    });

    it("should create a thin-walled solid with dual offset", () => {
      sketch("xz", () => {
        move([30, 0]);
        circle(10);
      });

      const r = revolve("z", 180).thin(3, -2).new() as Revolve;
      render();

      const shapes = r.getShapes();
      expect(shapes).toHaveLength(1);
      expect(shapes[0].getType()).toBe("solid");

      const edges = shapes[0].getSubShapes('edge') as Edge[];
      const circleEdges = edges.filter(e => EdgeQuery.isCircleEdge(e));
      expect(circleEdges).toHaveLength(4);
    });

    it("should create a thin-walled pipe from a circle", () => {
      sketch("xz", () => {
        move([30, 0]);
        circle(10);
      });

      const r = revolve("z").thin(3) as Revolve;
      render();

      const shapes = r.getShapes();
      expect(shapes).toHaveLength(1);
      expect(shapes[0].getType()).toBe("solid");
    });
  });

  describe("closed profile - partial revolution", () => {
    it("should create a thin-walled partial revolve", () => {
      sketch("xz", () => {
        move([20, 0]);
        rect(10, 20);
      });

      const r = revolve("z", 180).thin(3) as Revolve;
      render();

      const shapes = r.getShapes();
      expect(shapes).toHaveLength(1);
      expect(shapes[0].getType()).toBe("solid");
    });

    it("should classify start faces for partial revolve", () => {
      sketch("xz", () => {
        move([20, 0]);
        rect(10, 20);
      });

      const r = revolve("z", 90).thin(3) as Revolve;
      render();

      const startFaces = r.getState('start-faces') as Face[];
      expect(startFaces.length).toBeGreaterThan(0);
    });
  });

  describe("symmetric", () => {
    it("should create a symmetric thin-walled revolve", () => {
      sketch("xz", () => {
        move([20, 0]);
        rect(10, 20);
      });

      const r = revolve("z", 180).thin(3).symmetric() as Revolve;
      render();

      const shapes = r.getShapes();
      expect(shapes).toHaveLength(1);
      expect(shapes[0].getType()).toBe("solid");
    });
  });

  describe("open profile", () => {
    it("should create a thin-walled solid from an open profile", () => {
      sketch("xz", () => {
        line([20, 0], [30, 0]);
      });

      const r = revolve("z").thin(5).new() as Revolve;
      render();

      const shapes = r.getShapes();
      expect(shapes).toHaveLength(1);
      expect(shapes[0].getType()).toBe("solid");
    });

    it("should classify side, internal, and cap faces for open profile", () => {
      sketch("xz", () => {
        line([20, 0], [30, 0]);
      });

      const r = revolve("z", 180).thin(5).new() as Revolve;
      render();

      const sideFaces = r.getState('side-faces') as Face[];
      const internalFaces = r.getState('internal-faces') as Face[];
      const capFaces = r.getState('cap-faces') as Face[];

      expect(sideFaces.length).toBeGreaterThan(0);
      expect(internalFaces.length).toBeGreaterThan(0);
      expect(capFaces.length).toBe(2);
    });

    it("should classify cap faces for vertical line profile parallel to axis (90 deg)", () => {
      sketch("xy", () => {
        move([50, 0]);
        vLine(100).centered();
      });

      const r = revolve("y", -90).thin(20).new() as Revolve;
      render();

      const startFaces = r.getState('start-faces') as Face[];
      const endFaces = r.getState('end-faces') as Face[];
      const sideFaces = r.getState('side-faces') as Face[];
      const internalFaces = r.getState('internal-faces') as Face[];
      const capFaces = r.getState('cap-faces') as Face[];

      expect(startFaces.length).toBe(1);
      expect(endFaces.length).toBe(1);
      expect(sideFaces.length).toBe(1);
      expect(internalFaces.length).toBe(1);
      expect(capFaces.length).toBe(2);
    });

    it("should classify cap faces for vertical line profile parallel to axis (180 deg)", () => {
      sketch("xy", () => {
        move([50, 0]);
        vLine(100).centered();
      });

      const r = revolve("y", 180).thin(20).new() as Revolve;
      render();

      const startFaces = r.getState('start-faces') as Face[];
      const endFaces = r.getState('end-faces') as Face[];
      const sideFaces = r.getState('side-faces') as Face[];
      const internalFaces = r.getState('internal-faces') as Face[];
      const capFaces = r.getState('cap-faces') as Face[];

      expect(startFaces.length).toBe(1);
      expect(endFaces.length).toBe(1);
      expect(sideFaces.length).toBe(1);
      expect(internalFaces.length).toBe(1);
      expect(capFaces.length).toBe(2);
    });
  });

  describe("remove mode", () => {
    it("should cut a thin-walled revolve from existing geometry", () => {
      sketch("xy", () => {
        rect(200, 200);
      });
      extrude(50);

      sketch("xz", () => {
        move([20, 0]);
        rect(10, 20);
      });

      const r = revolve("z").thin(3).remove() as Revolve;
      render();

      const shapes = r.getShapes();
      expect(shapes.length).toBeGreaterThan(0);
    });
  });
});
