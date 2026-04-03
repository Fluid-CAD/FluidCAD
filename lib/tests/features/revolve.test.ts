import { describe, it, expect } from "vitest";
import { setupOC, render } from "../setup.js";
import sketch from "../../core/sketch.js";
import revolve from "../../core/revolve.js";
import { move, rect, circle } from "../../core/2d/index.js";
import { Revolve } from "../../features/revolve.js";
import { Solid } from "../../common/solid.js";
import { countShapes, getFacesByType, getEdgesByType } from "../utils.js";
import { ShapeOps } from "../../oc/shape-ops.js";
import { ShapeProps } from "../../oc/props.js";
import { Sketch } from "../../features/2d/sketch.js";

describe("revolve", () => {
  setupOC();

  describe("full revolution of a rect", () => {
    it("should revolve a rect 360° into a solid", () => {
      sketch("xz", () => {
        move([20, 0]);
        rect(10, 30);
      });

      const r = revolve("z") as Revolve;

      render();

      const shapes = r.getShapes();
      expect(shapes).toHaveLength(1);
      expect(shapes[0].getType()).toBe("solid");
    });

    it("should produce a ring with correct volume", () => {
      sketch("xz", () => {
        move([20, 0]);
        rect(10, 30);
      });

      const r = revolve("z") as Revolve;

      render();

      const solid = r.getShapes()[0] as Solid;
      // Ring volume = π * (R² - r²) * h where R=30, r=20, h=30
      const expected = Math.PI * (30 * 30 - 20 * 20) * 30;
      const props = ShapeProps.getProperties(solid.getShape());
      expect(props.volumeMm3).toBeCloseTo(expected, -1);
    });
  });

  describe("full revolution of a circle", () => {
    it("should produce a single solid torus", () => {
      sketch("xz", () => {
        move([30, 15]);
        circle(20);
      });

      const r = revolve("z") as Revolve;

      render();

      const shapes = r.getShapes();
      expect(shapes).toHaveLength(1);
      expect(shapes[0].getType()).toBe("solid");
    });

    it("should produce correct torus volume", () => {
      const R = 30; // major radius (center of tube to axis)
      const tubR = 10; // tube radius

      sketch("xz", () => {
        move([R, 15]);
        circle(tubR * 2);
      });

      const r = revolve("z") as Revolve;

      render();

      const solid = r.getShapes()[0] as Solid;
      // Torus volume = 2π²Rr²
      const expected = 2 * Math.PI * Math.PI * R * tubR * tubR;
      const props = ShapeProps.getProperties(solid.getShape());
      expect(props.volumeMm3).toBeCloseTo(expected, -1);
    });
  });

  describe("partial revolution of a rect", () => {
    it("should produce a solid with inner and outer cylindrical faces", () => {
      sketch("xz", () => {
        move([20, 0]);
        rect(10, 30);
      });

      const r = revolve("z", 180) as Revolve;

      render();

      const solid = r.getShapes()[0] as Solid;
      // Inner cylinder (r=20) and outer cylinder (r=30)
      const cylFaces = getFacesByType(solid, "cylinder");
      expect(cylFaces).toHaveLength(2);
    });

    it("should produce planar sweep-end faces and profile faces", () => {
      sketch("xz", () => {
        move([20, 0]);
        rect(10, 30);
      });

      const r = revolve("z", 90) as Revolve;

      render();

      const solid = r.getShapes()[0] as Solid;
      // 2 sweep-end faces + 2 profile (top/bottom annular rings) = 4 planar
      const planeFaces = getFacesByType(solid, "plane");
      expect(planeFaces).toHaveLength(4);
      // 2 cylindrical faces (inner + outer)
      const cylFaces = getFacesByType(solid, "cylinder");
      expect(cylFaces).toHaveLength(2);
    });

    it("should produce half the volume of a full revolution at 180°", () => {
      sketch("xz", () => {
        move([20, 0]);
        rect(10, 30);
      });

      const r = revolve("z", 180) as Revolve;

      render();

      const solid = r.getShapes()[0] as Solid;
      const fullVolume = Math.PI * (30 * 30 - 20 * 20) * 30;
      const props = ShapeProps.getProperties(solid.getShape());
      expect(props.volumeMm3).toBeCloseTo(fullVolume / 2, -1);
    });
  });

  describe("partial revolution of a circle", () => {
    it("should produce circular end faces and a swept surface", () => {
      sketch("xz", () => {
        move([30, 15]);
        circle(20);
      });

      const r = revolve("z", 180) as Revolve;

      render();

      const solid = r.getShapes()[0] as Solid;
      // 2 circular end faces (the profile cross-section at each sweep end)
      const circleFaces = getFacesByType(solid, "circle");
      expect(circleFaces).toHaveLength(2);
      // Total faces = 2 circular + 1 swept surface = 3
      expect(solid.getFaces()).toHaveLength(3);
    });

    it("should have circular edges at the sweep ends", () => {
      sketch("xz", () => {
        move([30, 15]);
        circle(20);
      });

      const r = revolve("z", 180) as Revolve;

      render();

      const solid = r.getShapes()[0] as Solid;
      const circleEdges = getEdgesByType(solid, "circle");
      // 2 profile circles (one at each sweep end)
      expect(circleEdges).toHaveLength(2);
    });
  });

  // symmetric revolve is skipped due to known OC binding issue (SetRotation overload)
  describe.skip("symmetric revolution", () => {
    it("should revolve symmetrically around the sketch plane", () => {
      sketch("xz", () => {
        move([20, 0]);
        rect(10, 30);
      });

      const r = revolve("z", 180, true) as Revolve;

      render();

      const shapes = r.getShapes();
      expect(shapes).toHaveLength(1);

      const bbox = ShapeOps.getBoundingBox(shapes[0]);
      expect(bbox.minY).toBeLessThan(0);
      expect(bbox.maxY).toBeGreaterThan(0);
    });
  });

  describe("merge scope", () => {
    it("should not merge when mergeScope is none", () => {
      sketch("xz", () => {
        move([20, 0]);
        rect(10, 30);
      });
      revolve("z").fuse("none");

      sketch("xz", () => {
        move([20, 0]);
        rect(10, 30);
      });
      revolve("z").fuse("none");

      const scene = render();

      expect(countShapes(scene)).toBe(2);
    });
  });

  describe("extrudable", () => {
    it("should remove the extrudable sketch shapes", () => {
      const s = sketch("xz", () => {
        move([20, 0]);
        rect(10, 30);
      }) as Sketch;

      revolve("z");

      render();

      expect(s.getShapes()).toHaveLength(0);
    });

    it("should revolve a specific extrudable", () => {
      const s1 = sketch("xz", () => {
        move([20, 0]);
        rect(10, 30);
      });

      sketch("xz", () => {
        move([40, 0]);
        rect(5, 10);
      });

      const r = revolve("z", 360, s1) as Revolve;

      render();

      expect(r.extrudable).toBe(s1);
      expect(r.getShapes()).toHaveLength(1);
    });
  });

  describe("pick", () => {
    it("should only revolve the picked region", () => {
      sketch("xz", () => {
        move([20, 0]);
        circle(16);
        move([20, 30]);
        circle(16);
      });

      const r = revolve("z", 360).pick([20, 0]) as Revolve;

      render();

      const shapes = r.getShapes();
      expect(shapes).toHaveLength(1);
    });
  });
});
