import { describe, it, expect } from "vitest";
import { setupOC, render } from "../setup.js";
import sketch from "../../core/sketch.js";
import extrude from "../../core/extrude.js";
import { circle, move, rect } from "../../core/2d/index.js";
import { Solid } from "../../common/solid.js";
import { ExtrudeSymmetric } from "../../features/extrude-symmetric.js";
import { Sketch } from "../../features/2d/sketch.js";
import cylinder from "../../core/cylinder.js";
import { countShapes } from "../utils.js";
import { ShapeOps } from "../../oc/shape-ops.js";

describe("extrude symmetric", () => {
  setupOC();

  describe("extrudable", () => {
    it("should extrude last extrudable by default", () => {
      const s = sketch("xy", () => {
        rect(100, 50);
      });

      const e = extrude(30, true) as ExtrudeSymmetric;

      expect(e.extrudable).toBe(s);
    });

    it("should remove the extrudable", () => {
      const s = sketch("xy", () => {
        rect(100, 50);
      }) as Sketch;

      extrude(30, true);

      render();

      expect(s.getShapes()).toHaveLength(0);
    });
  });

  describe("symmetric behavior", () => {
    it("should extrude equally in both directions", () => {
      sketch("xy", () => {
        rect(100, 50);
      });

      const e = extrude(30, true) as ExtrudeSymmetric;

      render();

      const shapes = e.getShapes();
      expect(shapes).toHaveLength(1);
      expect(shapes[0].getType()).toBe("solid");

      const bbox = ShapeOps.getBoundingBox(shapes[0]);
      expect(bbox.minZ).toBeCloseTo(-15, 0);
      expect(bbox.maxZ).toBeCloseTo(15, 0);
    });

    it("should produce a solid with correct height", () => {
      sketch("xy", () => {
        rect(100, 50);
      });

      const e = extrude(40, true) as ExtrudeSymmetric;

      render();

      const bbox = ShapeOps.getBoundingBox(e.getShapes()[0]);
      const height = bbox.maxZ - bbox.minZ;
      expect(height).toBeCloseTo(40, 0);
    });
  });

  describe("fuse", () => {
    it("should fuse intersecting faces by default", () => {
      sketch("xy", () => {
        circle([-25, 0], 50);
        circle([25, 0], 50);
      });

      const e = extrude(30, true) as ExtrudeSymmetric;

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

      extrude(30, true);

      const scene = render();

      expect(countShapes(scene)).toBe(1);
    });

    it("should not fuse when fuse is none", () => {
      cylinder(50, 50);

      sketch("xy", () => {
        move([0, 0]);
        circle(50);
      });

      extrude(30, true).fuse("none");

      const scene = render();

      expect(countShapes(scene)).toBe(2);
    });
  });

  describe("startFace / endFace", () => {
    it("should expose start and end faces", () => {
      sketch("xy", () => {
        rect(100, 50);
      });

      const e = extrude(30, true) as ExtrudeSymmetric;

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

      const e = extrude(30, true) as ExtrudeSymmetric;

      render();

      const startFace = e.startFace().getShapes()[0];
      const endFace = e.endFace().getShapes()[0];
      expect(startFace.isSame(endFace)).toBe(false);
    });

    it("start face should be at z=distance/2 and end face at z=-distance/2", () => {
      sketch("xy", () => {
        rect(100, 50);
      });

      const e = extrude(30, true) as ExtrudeSymmetric;

      render();

      const startBBox = ShapeOps.getBoundingBox(e.startFace().getShapes()[0]);
      expect(startBBox.minZ).toBeCloseTo(15);
      expect(startBBox.maxZ).toBeCloseTo(15);

      const endBBox = ShapeOps.getBoundingBox(e.endFace().getShapes()[0]);
      expect(endBBox.minZ).toBeCloseTo(-15);
      expect(endBBox.maxZ).toBeCloseTo(-15);
    });

    it("should expose specific face by index for separate regions", () => {
      sketch("xy", () => {
        circle(20);
        circle([100, 0], 20);
      });

      const e = extrude(30, true) as ExtrudeSymmetric;

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

      const e = extrude(30, true) as ExtrudeSymmetric;

      render();

      const sideFaces = e.sideFace(0, 1, 2, 3).getShapes();
      expect(sideFaces.length).toBeGreaterThanOrEqual(4);

      const bbox = ShapeOps.getBoundingBox(e.sideFace(0).getShapes()[0]);
      expect(bbox.minZ).toBeCloseTo(-15, 0);
      expect(bbox.maxZ).toBeCloseTo(15, 0);
    });
  });

  describe("startEdge / endEdge", () => {
    it("should expose start and end edges", () => {
      sketch("xy", () => {
        rect(100, 50);
      });

      const e = extrude(30, true) as ExtrudeSymmetric;

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

      const e = extrude(30, true) as ExtrudeSymmetric;

      render();

      const edge0 = e.startEdge(0).getShapes();
      const edge1 = e.startEdge(1).getShapes();
      expect(edge0).toHaveLength(1);
      expect(edge1).toHaveLength(1);
      expect(edge0[0].isSame(edge1[0])).toBe(false);
    });
  });

  describe("drill", () => {
    it("should drill hole when inner shape is nested (default)", () => {
      sketch("xy", () => {
        circle(50);
        circle(20);
      });

      const e = extrude(30, true) as ExtrudeSymmetric;

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

      const e = extrude(30, true).drill(false) as ExtrudeSymmetric;

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

      const e = extrude(20, true).pick([0, 0]) as ExtrudeSymmetric;

      render();

      const shapes = e.getShapes();
      expect(shapes).toHaveLength(1);
      expect(shapes[0].getType()).toBe("solid");
    });

    it("should produce no solid when pick point is outside all regions", () => {
      sketch("xy", () => {
        circle(30);
      });

      const e = extrude(20, true).pick([500, 500]) as ExtrudeSymmetric;

      render();

      expect(e.getShapes()).toHaveLength(0);
    });
  });
});
