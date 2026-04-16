import { describe, it, expect } from "vitest";
import { setupOC, render, addToScene } from "../setup.js";
import sketch from "../../core/sketch.js";
import extrude from "../../core/extrude.js";
import { circle, move, rect } from "../../core/2d/index.js";
import { Solid } from "../../common/solid.js";
import { ExtrudeTwoDistances } from "../../features/extrude-two-distances.js";
import { Sketch } from "../../features/2d/sketch.js";
import cylinder from "../../core/cylinder.js";
import { countShapes } from "../utils.js";
import { ShapeOps } from "../../oc/shape-ops.js";
import { Face } from "../../common/face.js";

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
        circle([-25, 0], 100);
        circle([25, 0], 100);
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
        circle(100);
      });

      extrude(20, 10);

      const scene = render();

      expect(countShapes(scene)).toBe(1);
    });

    it("should not fuse when fuse is none", () => {
      cylinder(50, 50);

      sketch("xy", () => {
        move([0, 0]);
        circle(100);
      });

      extrude(20, 10).new();

      const scene = render();

      expect(countShapes(scene)).toBe(2);
    });
  });

  describe("startFaces / endFaces", () => {
    it("should expose start and end faces", () => {
      sketch("xy", () => {
        rect(100, 50);
      });

      const e = extrude(20, 10) as ExtrudeTwoDistances;
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

      const e = extrude(20, 10) as ExtrudeTwoDistances;
      const sf = e.startFaces();
      const ef = e.endFaces();
      addToScene(sf);
      addToScene(ef);

      render();

      expect(sf.getShapes()[0].isSame(ef.getShapes()[0])).toBe(false);
    });

    it("start face should be at z=distance1 and end face at z=-distance2", () => {
      sketch("xy", () => {
        rect(100, 50);
      });

      const e = extrude(20, 10) as ExtrudeTwoDistances;
      const sf = e.startFaces();
      const ef = e.endFaces();
      addToScene(sf);
      addToScene(ef);

      render();

      const startBBox = ShapeOps.getBoundingBox(sf.getShapes()[0]);
      expect(startBBox.minZ).toBeCloseTo(20);
      expect(startBBox.maxZ).toBeCloseTo(20);

      const endBBox = ShapeOps.getBoundingBox(ef.getShapes()[0]);
      expect(endBBox.minZ).toBeCloseTo(-10);
      expect(endBBox.maxZ).toBeCloseTo(-10);
    });

    it("should expose specific face by index for separate regions", () => {
      sketch("xy", () => {
        circle(40);
        circle([100, 0], 40);
      });

      const e = extrude(20, 10) as ExtrudeTwoDistances;
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

      const e = extrude(20, 10) as ExtrudeTwoDistances;
      const sf = e.sideFaces(0, 1, 2, 3);
      const sf0 = e.sideFaces(0);
      addToScene(sf);
      addToScene(sf0);

      render();

      expect(sf.getShapes().length).toBeGreaterThanOrEqual(4);

      const bbox = ShapeOps.getBoundingBox(sf0.getShapes()[0]);
      expect(bbox.minZ).toBeCloseTo(-10, 0);
      expect(bbox.maxZ).toBeCloseTo(20, 0);
    });
  });

  describe("startEdges / endEdges", () => {
    it("should expose start and end edges", () => {
      sketch("xy", () => {
        rect(100, 50);
      });

      const e = extrude(20, 10) as ExtrudeTwoDistances;
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

      const e = extrude(20, 10) as ExtrudeTwoDistances;
      const edge0 = e.endEdges(0);
      const edge1 = e.endEdges(1);
      addToScene(edge0);
      addToScene(edge1);

      render();

      expect(edge0.getShapes()).toHaveLength(1);
      expect(edge1.getShapes()).toHaveLength(1);
      expect(edge0.getShapes()[0].isSame(edge1.getShapes()[0])).toBe(false);
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

    it("should apply different draft angles per direction", () => {
      sketch("xy", () => {
        rect(100, 50);
      });

      const e = extrude(20, 20).draft([8, 2]) as ExtrudeTwoDistances;

      render();

      const startFaces = e.getState('start-faces') as Face[];
      const endFaces = e.getState('end-faces') as Face[];

      const startBbox = ShapeOps.getBoundingBox(startFaces[0].getShape());
      const endBbox = ShapeOps.getBoundingBox(endFaces[0].getShape());

      const startWidth = startBbox.maxX - startBbox.minX;
      const endWidth = endBbox.maxX - endBbox.minX;

      // Start face (distance1=20, draft=8°) should be wider than
      // end face (distance2=20, draft=2°) due to greater taper
      expect(startWidth).toBeGreaterThan(endWidth);
    });
  });

  describe("drill", () => {
    it("should drill hole when inner shape is nested (default)", () => {
      sketch("xy", () => {
        circle(100);
        circle(40);
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
        circle(100);
        circle(40);
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
        circle(60);
        circle([100, 0], 60);
      });

      const e = extrude(20, 10).pick([0, 0]) as ExtrudeTwoDistances;

      render();

      const shapes = e.getShapes();
      expect(shapes).toHaveLength(1);
      expect(shapes[0].getType()).toBe("solid");
    });

    it("should produce no solid when pick point is outside all regions", () => {
      sketch("xy", () => {
        circle(60);
      });

      const e = extrude(20, 10).pick([500, 500]) as ExtrudeTwoDistances;

      render();

      expect(e.getShapes()).toHaveLength(0);
    });
  });
});
