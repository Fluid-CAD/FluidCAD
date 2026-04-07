import { describe, it, expect } from "vitest";
import { setupOC, render, addToScene } from "../setup.js";
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
        circle([-25, 0], 100);
        circle([25, 0], 100);
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
        circle(100);
      });

      extrude(30, true);

      const scene = render();

      expect(countShapes(scene)).toBe(1);
    });

    it("should not fuse when fuse is none", () => {
      cylinder(50, 50);

      sketch("xy", () => {
        move([0, 0]);
        circle(100);
      });

      extrude(30, true).fuse("none");

      const scene = render();

      expect(countShapes(scene)).toBe(2);
    });
  });

  describe("startFaces / endFaces", () => {
    it("should expose start and end faces", () => {
      sketch("xy", () => {
        rect(100, 50);
      });

      const e = extrude(30, true) as ExtrudeSymmetric;
      const sf = e.startFaces();
      const ef = e.endFaces();
      addToScene(sf);
      addToScene(ef);

      render();

      expect(sf.getShapes()).toHaveLength(1);
      expect(sf.getShapes()[0].getType()).toBe("face");
      expect(ef.getShapes()).toHaveLength(1);
      expect(ef.getShapes()[0].getType()).toBe("face");
    });

    it("start and end faces should be different", () => {
      sketch("xy", () => {
        rect(100, 50);
      });

      const e = extrude(30, true) as ExtrudeSymmetric;
      const sf = e.startFaces();
      const ef = e.endFaces();
      addToScene(sf);
      addToScene(ef);

      render();

      expect(sf.getShapes()[0].isSame(ef.getShapes()[0])).toBe(false);
    });

    it("start face should be at z=distance/2 and end face at z=-distance/2", () => {
      sketch("xy", () => {
        rect(100, 50);
      });

      const e = extrude(30, true) as ExtrudeSymmetric;
      const sf = e.startFaces();
      const ef = e.endFaces();
      addToScene(sf);
      addToScene(ef);

      render();

      const startBBox = ShapeOps.getBoundingBox(sf.getShapes()[0]);
      expect(startBBox.minZ).toBeCloseTo(15);
      expect(startBBox.maxZ).toBeCloseTo(15);

      const endBBox = ShapeOps.getBoundingBox(ef.getShapes()[0]);
      expect(endBBox.minZ).toBeCloseTo(-15);
      expect(endBBox.maxZ).toBeCloseTo(-15);
    });

    it("should expose specific face by index for separate regions", () => {
      sketch("xy", () => {
        circle(40);
        circle([100, 0], 40);
      });

      const e = extrude(30, true) as ExtrudeSymmetric;
      const face0 = e.startFaces(0);
      const face1 = e.startFaces(1);
      addToScene(face0);
      addToScene(face1);

      render();

      expect(face0.getShapes()).toHaveLength(1);
      expect(face1.getShapes()).toHaveLength(1);
      expect(face0.getShapes()[0].isSame(face1.getShapes()[0])).toBe(false);
    });
  });

  describe("sideFaces", () => {
    it("should expose side faces spanning full height", () => {
      sketch("xy", () => {
        rect(100, 50);
      });

      const e = extrude(30, true) as ExtrudeSymmetric;
      const sf = e.sideFaces(0, 1, 2, 3);
      const sf0 = e.sideFaces(0);
      addToScene(sf);
      addToScene(sf0);

      render();

      expect(sf.getShapes().length).toBeGreaterThanOrEqual(4);

      const bbox = ShapeOps.getBoundingBox(sf0.getShapes()[0]);
      expect(bbox.minZ).toBeCloseTo(-15, 0);
      expect(bbox.maxZ).toBeCloseTo(15, 0);
    });
  });

  describe("startEdges / endEdges", () => {
    it("should expose start and end edges", () => {
      sketch("xy", () => {
        rect(100, 50);
      });

      const e = extrude(30, true) as ExtrudeSymmetric;
      const se = e.startEdges();
      const ee = e.endEdges();
      addToScene(se);
      addToScene(ee);

      render();

      expect(se.getShapes()).toHaveLength(4);
      expect(ee.getShapes()).toHaveLength(4);
    });

    it("should expose specific edge by index", () => {
      sketch("xy", () => {
        rect(100, 50);
      });

      const e = extrude(30, true) as ExtrudeSymmetric;
      const edge0 = e.startEdges(0);
      const edge1 = e.startEdges(1);
      addToScene(edge0);
      addToScene(edge1);

      render();

      expect(edge0.getShapes()).toHaveLength(1);
      expect(edge1.getShapes()).toHaveLength(1);
      expect(edge0.getShapes()[0].isSame(edge1.getShapes()[0])).toBe(false);
    });
  });

  describe("drill", () => {
    it("should drill hole when inner shape is nested (default)", () => {
      sketch("xy", () => {
        circle(100);
        circle(40);
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
        circle(100);
        circle(40);
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
        circle(60);
        circle([100, 0], 60);
      });

      const e = extrude(20, true).pick([0, 0]) as ExtrudeSymmetric;

      render();

      const shapes = e.getShapes();
      expect(shapes).toHaveLength(1);
      expect(shapes[0].getType()).toBe("solid");
    });

    it("should produce no solid when pick point is outside all regions", () => {
      sketch("xy", () => {
        circle(60);
      });

      const e = extrude(20, true).pick([500, 500]) as ExtrudeSymmetric;

      render();

      expect(e.getShapes()).toHaveLength(0);
    });
  });
});
