import { describe, it, expect } from "vitest";
import { setupOC, render } from "../setup.js";
import sketch from "../../core/sketch.js";
import extrude from "../../core/extrude.js";
import { circle, move, rect } from "../../core/2d/index.js";
import { Solid } from "../../common/solid.js";
import { ExtrudeTwoDistances } from "../../features/extrude-two-distances.js";
import { Sketch } from "../../features/2d/sketch.js";
import cylinder from "../../core/cylinder.js";
import { countShapes } from "../utils.js";
import { ShapeOps } from "../../oc/shape-ops.js";

describe("extrude two distances", () => {
  setupOC();

  describe("extrudable", () => {
    it("should extrude last extrudable by default", () => {
      const s = sketch("xy", () => {
        rect(100, 50);
      });

      const e = extrude(20, 10) as ExtrudeTwoDistances;

      expect(e.extrudable).toBe(s);
    });

    it("should remove the extrudable", () => {
      const s = sketch("xy", () => {
        rect(100, 50);
      }) as Sketch;

      extrude(20, 10);

      render();

      expect(s.getShapes()).toHaveLength(0);
    });
  });

  describe("two distances behavior", () => {
    it("should extrude up by distance1 and down by distance2", () => {
      sketch("xy", () => {
        rect(100, 50);
      });

      const e = extrude(20, 10) as ExtrudeTwoDistances;

      render();

      const shapes = e.getShapes();
      expect(shapes).toHaveLength(1);
      expect(shapes[0].getType()).toBe("solid");

      const bbox = ShapeOps.getBoundingBox(shapes[0]);
      expect(bbox.maxZ).toBeCloseTo(20, 0);
      expect(bbox.minZ).toBeCloseTo(-10, 0);
    });

    it("should produce a solid with correct total height", () => {
      sketch("xy", () => {
        rect(100, 50);
      });

      const e = extrude(30, 15) as ExtrudeTwoDistances;

      render();

      const bbox = ShapeOps.getBoundingBox(e.getShapes()[0]);
      const height = bbox.maxZ - bbox.minZ;
      expect(height).toBeCloseTo(45, 0);
    });

    it("should handle asymmetric distances", () => {
      sketch("xy", () => {
        rect(100, 50);
      });

      const e = extrude(50, 5) as ExtrudeTwoDistances;

      render();

      const bbox = ShapeOps.getBoundingBox(e.getShapes()[0]);
      expect(bbox.maxZ).toBeCloseTo(50, 0);
      expect(bbox.minZ).toBeCloseTo(-5, 0);
    });
  });

  describe("fuse", () => {
    it("should fuse intersecting faces by default", () => {
      sketch("xy", () => {
        circle([-25, 0], 50);
        circle([25, 0], 50);
      });

      const e = extrude(20, 10) as ExtrudeTwoDistances;

      render();

      const shapes = e.getShapes();
      expect(shapes).toHaveLength(1);
      expect(shapes[0].getType()).toBe("solid");
    });

    it("should fuse with existing scene objects by default", () => {
      cylinder(50, 50);

      sketch("xy", () => {
        move([25, 0]);
        circle(50);
      });

      extrude(20, 10);

      const scene = render();

      expect(countShapes(scene)).toBe(1);
    });

    it("should not fuse when fuse is none", () => {
      cylinder(50, 50);

      sketch("xy", () => {
        move([0, 0]);
        circle(50);
      });

      extrude(20, 10).fuse("none");

      const scene = render();

      expect(countShapes(scene)).toBe(2);
    });
  });

  describe("startFace / endFace", () => {
    it("should expose start and end faces", () => {
      sketch("xy", () => {
        rect(100, 50);
      });

      const e = extrude(20, 10) as ExtrudeTwoDistances;

      render();

      const startFaces = e.startFace().getShapes();
      expect(startFaces).toHaveLength(1);
      expect(startFaces[0].getType()).toBe("face");

      const endFaces = e.endFace().getShapes();
      expect(endFaces).toHaveLength(1);
      expect(endFaces[0].getType()).toBe("face");
    });

    it("start and end faces should be different", () => {
      sketch("xy", () => {
        rect(100, 50);
      });

      const e = extrude(20, 10) as ExtrudeTwoDistances;

      render();

      const startFace = e.startFace().getShapes()[0];
      const endFace = e.endFace().getShapes()[0];
      expect(startFace.isSame(endFace)).toBe(false);
    });

    it("start face should be at z=distance1 and end face at z=-distance2", () => {
      sketch("xy", () => {
        rect(100, 50);
      });

      const e = extrude(20, 10) as ExtrudeTwoDistances;

      render();

      const startBBox = ShapeOps.getBoundingBox(e.startFace().getShapes()[0]);
      expect(startBBox.minZ).toBeCloseTo(20);
      expect(startBBox.maxZ).toBeCloseTo(20);

      const endBBox = ShapeOps.getBoundingBox(e.endFace().getShapes()[0]);
      expect(endBBox.minZ).toBeCloseTo(-10);
      expect(endBBox.maxZ).toBeCloseTo(-10);
    });

    it("should expose specific face by index for separate regions", () => {
      sketch("xy", () => {
        circle(20);
        circle([100, 0], 20);
      });

      const e = extrude(20, 10) as ExtrudeTwoDistances;

      render();

      const face0 = e.startFace(0).getShapes();
      const face1 = e.startFace(1).getShapes();
      expect(face0).toHaveLength(1);
      expect(face1).toHaveLength(1);
      expect(face0[0].isSame(face1[0])).toBe(false);
    });
  });

  describe("sideFace", () => {
    it("should expose side faces spanning full height", () => {
      sketch("xy", () => {
        rect(100, 50);
      });

      const e = extrude(20, 10) as ExtrudeTwoDistances;

      render();

      const sideFaces = e.sideFace(0, 1, 2, 3).getShapes();
      expect(sideFaces.length).toBeGreaterThanOrEqual(4);

      const bbox = ShapeOps.getBoundingBox(e.sideFace(0).getShapes()[0]);
      expect(bbox.minZ).toBeCloseTo(-10, 0);
      expect(bbox.maxZ).toBeCloseTo(20, 0);
    });
  });

  describe("startEdge / endEdge", () => {
    it("should expose start and end edges", () => {
      sketch("xy", () => {
        rect(100, 50);
      });

      const e = extrude(20, 10) as ExtrudeTwoDistances;

      render();

      const startEdges = e.startEdge().getShapes();
      expect(startEdges).toHaveLength(4);

      const endEdges = e.endEdge().getShapes();
      expect(endEdges).toHaveLength(4);
    });

    it("should expose specific edge by index", () => {
      sketch("xy", () => {
        rect(100, 50);
      });

      const e = extrude(20, 10) as ExtrudeTwoDistances;

      render();

      const edge0 = e.endEdge(0).getShapes();
      const edge1 = e.endEdge(1).getShapes();
      expect(edge0).toHaveLength(1);
      expect(edge1).toHaveLength(1);
      expect(edge0[0].isSame(edge1[0])).toBe(false);
    });
  });

  describe("draft", () => {
    it("should taper both directions with draft", () => {
      sketch("xy", () => {
        rect(100, 50);
      });

      const e = extrude(20, 10).draft(10) as ExtrudeTwoDistances;

      render();

      const solid = e.getShapes()[0];
      const bbox = ShapeOps.getBoundingBox(solid);
      // Draft should expand beyond the original rect dimensions
      expect(bbox.maxX - bbox.minX).toBeGreaterThan(100);
      expect(bbox.maxY - bbox.minY).toBeGreaterThan(50);
    });
  });

  describe("drill", () => {
    it("should drill hole when inner shape is nested (default)", () => {
      sketch("xy", () => {
        circle(50);
        circle(20);
      });

      const e = extrude(20, 10) as ExtrudeTwoDistances;

      render();

      const shapes = e.getShapes();
      expect(shapes).toHaveLength(1);

      const solid = shapes[0] as Solid;
      expect(solid.getFaces().length).toBeGreaterThan(3);
    });

    it("should not drill hole when drill is false", () => {
      sketch("xy", () => {
        circle(50);
        circle(20);
      });

      const e = extrude(20, 10).drill(false) as ExtrudeTwoDistances;

      render();

      const shapes = e.getShapes();
      expect(shapes).toHaveLength(1);

      const solid = shapes[0] as Solid;
      expect(solid.getFaces()).toHaveLength(3);
    });
  });

  describe("pick", () => {
    it("should only extrude the picked region", () => {
      sketch("xy", () => {
        circle(30);
        circle([100, 0], 30);
      });

      const e = extrude(20, 10).pick([0, 0]) as ExtrudeTwoDistances;

      render();

      const shapes = e.getShapes();
      expect(shapes).toHaveLength(1);
      expect(shapes[0].getType()).toBe("solid");
    });

    it("should produce no solid when pick point is outside all regions", () => {
      sketch("xy", () => {
        circle(30);
      });

      const e = extrude(20, 10).pick([500, 500]) as ExtrudeTwoDistances;

      render();

      expect(e.getShapes()).toHaveLength(0);
    });
  });
});
