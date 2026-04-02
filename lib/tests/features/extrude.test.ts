import { describe, it, expect } from "vitest";
import { setupOC, render } from "../setup.js";
import sketch from "../../core/sketch.js";
import extrude from "../../core/extrude.js";
import { circle, move, rect } from "../../core/2d/index.js";
import { Solid } from "../../common/solid.js";
import { Extruder } from "../../features/simple-extruder.js";
import { Extrude } from "../../features/extrude.js";
import { exp } from "three/tsl";
import { Sketch } from "../../features/2d/sketch.js";
import cylinder from "../../core/cylinder.js";
import { Cylinder } from "../../features/cylinder.js";
import { countShapes } from "../utils.js";
import { ShapeOps } from "../../oc/shape-ops.js";

describe("extrude", () => {
  setupOC();

  describe("extrudable", () => {
    it("should extrude last extrudable by default", () => {
      const s = sketch("xy", () => {
        rect(100, 50);
      });

      const e = extrude(30) as Extrude;;

      expect(e.extrudable).toBe(s);
    });

    it("should extrude given extrudable", () => {
      const s1 = sketch("xy", () => {
        circle();
      });

      sketch("xy", () => {
        rect(100, 50);
      });

      const e = extrude(50, s1) as Extrude;;

      render();

      expect(e.extrudable).toBe(s1);
    });

    it("should remove the extrudable", () => {
      const s = sketch("xy", () => {
        rect(100, 50);
      }) as Sketch;

      extrude();

      render();

      const sketchShapes = s.getShapes();
      expect(sketchShapes).toHaveLength(0);
    });
  });

  describe("fuse", () => {
    it("should fuse intersecting faces by default", () => {
      sketch("xy", () => {
        circle([-25, 0], 50);
        circle([25, 0], 50);
      }) as Sketch;

      const e = extrude() as Extrude;

      render();

      const shapes = e.getShapes();
      expect(shapes).toHaveLength(1);
      expect(shapes[0].getType()).toBe('solid');
    });

    it("should fuse with existing scene objects by default", () => {
      cylinder(50, 50) as Cylinder;

      sketch("xy", () => {
        move([25, 0]);
        circle(50);
      }) as Sketch;

      extrude() as Extrude;

      const scene = render();

      expect(countShapes(scene)).toBe(1);
    });

    it("should not fuse with existing scene objects if it does not intersect", () => {
      cylinder(50, 50) as Cylinder;

      sketch("xy", () => {
        move([250, 0]);
        circle(50);
      }) as Sketch;

      extrude() as Extrude;

      const scene = render();

      expect(countShapes(scene)).toBe(2);
    });

    it("should not fuse with existing scene objects if fuse is none", () => {
      cylinder(50, 50) as Cylinder;

      sketch("xy", () => {
        move([0, 0]);
        circle(50);
      }) as Sketch;

      extrude().fuse('none') as Extrude;

      const scene = render();

      expect(countShapes(scene)).toBe(2);
    });
  });

  describe("startFace / endFace", () => {
    it("should expose start face", () => {
      sketch("xy", () => {
        rect(100, 50);
      });

      const e = extrude(30) as Extrude;

      render();

      const startFaces = e.startFace().getShapes();
      expect(startFaces).toHaveLength(1);
      expect(startFaces[0].getType()).toBe("face");
    });

    it("should expose end face", () => {
      sketch("xy", () => {
        rect(100, 50);
      });

      const e = extrude(30) as Extrude;

      render();

      const endFaces = e.endFace().getShapes();
      expect(endFaces).toHaveLength(1);
      expect(endFaces[0].getType()).toBe("face");
    });

    it("start and end faces should be different", () => {
      sketch("xy", () => {
        rect(100, 50);
      });

      const e = extrude(30) as Extrude;

      render();

      const startFace = e.startFace().getShapes()[0];
      const endFace = e.endFace().getShapes()[0];
      expect(startFace.isSame(endFace)).toBe(false);
    });

    it("start face should be at z=0 and end face at z=distance", () => {
      sketch("xy", () => {
        rect(100, 50);
      });

      const e = extrude(30) as Extrude;

      render();

      const startBBox = ShapeOps.getBoundingBox(e.startFace().getShapes()[0]);
      expect(startBBox.minZ).toBeCloseTo(0);
      expect(startBBox.maxZ).toBeCloseTo(0);

      const endBBox = ShapeOps.getBoundingBox(e.endFace().getShapes()[0]);
      expect(endBBox.minZ).toBeCloseTo(30);
      expect(endBBox.maxZ).toBeCloseTo(30);
    });

    it("should expose multiple start and end faces for separate regions", () => {
      sketch("xy", () => {
        circle(20);
        circle([100, 0], 20);
      });

      const e = extrude(30) as Extrude;

      render();

      const startFaces = e.startFace(0, 1).getShapes();
      expect(startFaces).toHaveLength(2);

      const endFaces = e.endFace(0, 1).getShapes();
      expect(endFaces).toHaveLength(2);
    });

    it("should expose specific start face by index", () => {
      sketch("xy", () => {
        circle(20);
        circle([100, 0], 20);
      });

      const e = extrude(30) as Extrude;

      render();

      const face0 = e.startFace(0).getShapes();
      expect(face0).toHaveLength(1);

      const face1 = e.startFace(1).getShapes();
      expect(face1).toHaveLength(1);

      expect(face0[0].isSame(face1[0])).toBe(false);
    });

    it("should expose specific end face by index", () => {
      sketch("xy", () => {
        circle(20);
        circle([100, 0], 20);
      });

      const e = extrude(30) as Extrude;

      render();

      const face0 = e.endFace(0).getShapes();
      expect(face0).toHaveLength(1);

      const face1 = e.endFace(1).getShapes();
      expect(face1).toHaveLength(1);

      expect(face0[0].isSame(face1[0])).toBe(false);
    });

    it("start face should be at z=0 and end face at z=-distance for negative extrude", () => {
      sketch("xy", () => {
        rect(100, 50);
      });

      const e = extrude(-20) as Extrude;

      render();

      const startBBox = ShapeOps.getBoundingBox(e.startFace().getShapes()[0]);
      expect(startBBox.minZ).toBeCloseTo(0);
      expect(startBBox.maxZ).toBeCloseTo(0);

      const endBBox = ShapeOps.getBoundingBox(e.endFace().getShapes()[0]);
      expect(endBBox.minZ).toBeCloseTo(-20);
      expect(endBBox.maxZ).toBeCloseTo(-20);
    });
  });

  describe("sideFace", () => {
    it("should expose side faces", () => {
      sketch("xy", () => {
        rect(100, 50);
      });

      const e = extrude(30) as Extrude;

      render();

      const sideFaces = e.sideFace(0, 1, 2, 3).getShapes();
      expect(sideFaces).toHaveLength(4);
      for (const face of sideFaces) {
        expect(face.getType()).toBe("face");
      }
    });

    it("should return first side face by default", () => {
      sketch("xy", () => {
        rect(100, 50);
      });

      const e = extrude(30) as Extrude;

      render();

      const defaultFace = e.sideFace().getShapes();
      expect(defaultFace).toHaveLength(1);

      const firstFace = e.sideFace(0).getShapes();
      expect(defaultFace[0].isSame(firstFace[0])).toBe(true);
    });

    it("should expose specific side face by index", () => {
      sketch("xy", () => {
        rect(100, 50);
      });

      const e = extrude(30) as Extrude;

      render();

      const face0 = e.sideFace(0).getShapes();
      expect(face0).toHaveLength(1);

      const face1 = e.sideFace(1).getShapes();
      expect(face1).toHaveLength(1);

      expect(face0[0].isSame(face1[0])).toBe(false);
    });

    it("side faces should span from z=0 to z=distance", () => {
      sketch("xy", () => {
        rect(100, 50);
      });

      const e = extrude(30) as Extrude;

      render();

      const bbox = ShapeOps.getBoundingBox(e.sideFace(0).getShapes()[0]);
      expect(bbox.minZ).toBeCloseTo(0, 0);
      expect(bbox.maxZ).toBeCloseTo(30, 0);
    });
  });

  describe("startEdge / endEdge", () => {
    it("should expose start edges", () => {
      sketch("xy", () => {
        rect(100, 50);
      });

      const e = extrude(30) as Extrude;

      render();

      const startEdges = e.startEdge().getShapes();
      expect(startEdges).toHaveLength(4);
      for (const edge of startEdges) {
        expect(edge.getType()).toBe("edge");
      }
    });

    it("should expose end edges", () => {
      sketch("xy", () => {
        rect(100, 50);
      });

      const e = extrude(30) as Extrude;

      render();

      const endEdges = e.endEdge().getShapes();
      expect(endEdges).toHaveLength(4);
      for (const edge of endEdges) {
        expect(edge.getType()).toBe("edge");
      }
    });

    it("start edges should be at z=0 and end edges at z=distance", () => {
      sketch("xy", () => {
        rect(100, 50);
      });

      const e = extrude(30) as Extrude;

      render();

      const startBBox = ShapeOps.getBoundingBox(e.startEdge().getShapes()[0]);
      expect(startBBox.minZ).toBeCloseTo(0, 0);
      expect(startBBox.maxZ).toBeCloseTo(0, 0);

      const endBBox = ShapeOps.getBoundingBox(e.endEdge().getShapes()[0]);
      expect(endBBox.minZ).toBeCloseTo(30, 0);
      expect(endBBox.maxZ).toBeCloseTo(30, 0);
    });

    it("should expose specific start edge by index", () => {
      sketch("xy", () => {
        rect(100, 50);
      });

      const e = extrude(30) as Extrude;

      render();

      const edge0 = e.startEdge(0).getShapes();
      expect(edge0).toHaveLength(1);

      const edge1 = e.startEdge(1).getShapes();
      expect(edge1).toHaveLength(1);

      expect(edge0[0].isSame(edge1[0])).toBe(false);
    });

    it("should expose specific end edge by index", () => {
      sketch("xy", () => {
        rect(100, 50);
      });

      const e = extrude(30) as Extrude;

      render();

      const edge0 = e.endEdge(0).getShapes();
      expect(edge0).toHaveLength(1);

      const edge1 = e.endEdge(1).getShapes();
      expect(edge1).toHaveLength(1);

      expect(edge0[0].isSame(edge1[0])).toBe(false);
    });
  });

  describe("endOffset", () => {
    it("should shorten the extrusion by the offset", () => {
      sketch("xy", () => {
        rect(100, 50);
      });

      const e = extrude(30).endOffset(5) as Extrude;

      render();

      const endBBox = ShapeOps.getBoundingBox(e.endFace().getShapes()[0]);
      expect(endBBox.minZ).toBeCloseTo(25);
      expect(endBBox.maxZ).toBeCloseTo(25);
    });

    it("should shorten negative extrusion by the offset", () => {
      sketch("xy", () => {
        rect(100, 50);
      });

      const e = extrude(-30).endOffset(5) as Extrude;

      render();

      const endBBox = ShapeOps.getBoundingBox(e.endFace().getShapes()[0]);
      expect(endBBox.minZ).toBeCloseTo(-25);
      expect(endBBox.maxZ).toBeCloseTo(-25);
    });
  });

  describe("draft", () => {
    it("should taper outward with positive draft angle", () => {
      sketch("xy", () => {
        rect(100, 50);
      });

      const e = extrude(30).draft(10) as Extrude;

      render();

      const startBBox = ShapeOps.getBoundingBox(e.startFace().getShapes()[0]);
      const endBBox = ShapeOps.getBoundingBox(e.endFace().getShapes()[0]);

      const startWidth = startBBox.maxX - startBBox.minX;
      const endWidth = endBBox.maxX - endBBox.minX;
      expect(endWidth).toBeGreaterThan(startWidth);
    });

    it("should taper inward with negative draft angle", () => {
      sketch("xy", () => {
        rect(100, 50);
      });

      const e = extrude(30).draft(-5) as Extrude;

      render();

      const startBBox = ShapeOps.getBoundingBox(e.startFace().getShapes()[0]);
      const endBBox = ShapeOps.getBoundingBox(e.endFace().getShapes()[0]);

      const startWidth = startBBox.maxX - startBBox.minX;
      const endWidth = endBBox.maxX - endBBox.minX;
      expect(endWidth).toBeLessThan(startWidth);
    });

    it("should produce correct end face dimensions for a given angle", () => {
      const width = 100;
      const height = 50;
      const distance = 30;
      const angleDeg = 10;

      sketch("xy", () => {
        rect(width, height);
      });

      const e = extrude(distance).draft(angleDeg) as Extrude;

      render();

      const endBBox = ShapeOps.getBoundingBox(e.endFace().getShapes()[0]);
      const endWidth = endBBox.maxX - endBBox.minX;
      const endHeight = endBBox.maxY - endBBox.minY;

      // Each side expands by distance * tan(angle)
      const expansion = distance * Math.tan(angleDeg * Math.PI / 180);
      expect(endWidth).toBeCloseTo(width + 2 * expansion, 0);
      expect(endHeight).toBeCloseTo(height + 2 * expansion, 0);
    });

    it("zero draft should not change end face dimensions", () => {
      sketch("xy", () => {
        rect(100, 50);
      });

      const e = extrude(30).draft(0) as Extrude;

      render();

      const startBBox = ShapeOps.getBoundingBox(e.startFace().getShapes()[0]);
      const endBBox = ShapeOps.getBoundingBox(e.endFace().getShapes()[0]);

      const startWidth = startBBox.maxX - startBBox.minX;
      const endWidth = endBBox.maxX - endBBox.minX;
      expect(endWidth).toBeCloseTo(startWidth, 0);
    });
  });

  describe("shape filtering", () => {
    it("should not include meta shapes in getShapes()", () => {
      sketch("xy", () => {
        rect(100, 50);
      });

      const e = extrude(30) as Extrude;

      render();

      const shapes = e.getShapes();
      for (const shape of shapes) {
        expect(shape.isMetaShape()).toBe(false);
      }
    });

    it("should not include guide shapes in getShapes()", () => {
      sketch("xy", () => {
        rect(100, 50);
      });

      const e = extrude(30).guide() as Extrude;

      render();

      const shapes = e.getShapes();
      expect(shapes).toHaveLength(0);

      // All added shapes should be marked as guide
      const allShapes = e.getAddedShapes();
      expect(allShapes.length).toBeGreaterThan(0);
      for (const shape of allShapes) {
        expect(shape.isGuideShape()).toBe(true);
      }
    });

    it("should include meta shapes when filter is disabled", () => {
      sketch("xy", () => {
        rect(100, 50);
      });

      const e = extrude(30).pick([50, 25]) as Extrude;

      render();

      const defaultShapes = e.getShapes();
      const allShapes = e.getShapes({ excludeMeta: false, excludeGuide: false });
      expect(allShapes.length).toBeGreaterThan(defaultShapes.length);
    });
  });

  describe("pick", () => {
    it("should only extrude the picked region", () => {
      sketch("xy", () => {
        circle(30);
        circle([100, 0], 30);
      });

      // Pick point inside the first circle only
      const e = extrude(20).pick([0, 0]) as Extrude;

      render();

      const shapes = e.getShapes();
      expect(shapes).toHaveLength(1);
      expect(shapes[0].getType()).toBe("solid");
    });

    it("should extrude multiple picked regions", () => {
      sketch("xy", () => {
        circle(30);
        circle([100, 0], 30);
      });

      // Pick points inside both circles
      const e = extrude(20).pick([0, 0], [100, 0]) as Extrude;

      render();

      const shapes = e.getShapes();
      expect(shapes).toHaveLength(2);
    });

    it("should extrude only the intersection region of two overlapping circles", () => {
      sketch("xy", () => {
        circle([-20, 0], 40);
        circle([20, 0], 40);
      });

      // Pick at the center — inside the intersection of both circles
      const e = extrude(20).pick([0, 0]) as Extrude;

      render();

      const shapes = e.getShapes();
      expect(shapes).toHaveLength(1);

      // The intersection region should be narrower than either full circle
      const bbox = ShapeOps.getBoundingBox(shapes[0]);
      const solidWidth = bbox.maxX - bbox.minX;
      expect(solidWidth).toBeLessThan(80);
    });

    it("should produce no solid when pick point is outside all regions", () => {
      sketch("xy", () => {
        circle(30);
      });

      const e = extrude(20).pick([500, 500]) as Extrude;

      render();

      const shapes = e.getShapes();
      expect(shapes).toHaveLength(0);
    });

    it("should add meta shapes for all cells", () => {
      sketch("xy", () => {
        circle(30);
        circle([100, 0], 30);
      });

      const e = extrude(20).pick([0, 0]) as Extrude;

      render();

      const allShapes = e.getAddedShapes();
      const metaShapes = allShapes.filter(s => s.isMetaShape());
      expect(metaShapes.length).toBeGreaterThan(0);

      const selected = metaShapes.filter(s => s.metaType === "pick-region-selected");
      const unselected = metaShapes.filter(s => s.metaType === "pick-region");
      expect(selected.length).toBeGreaterThan(0);
      expect(unselected.length).toBeGreaterThan(0);
    });
  });

  describe("drill", () => {
    it("should drill hole when inner shape is nested (default)", () => {
      sketch("xy", () => {
        circle(50);
        circle(20);
      });

      const e = extrude(30) as Extrude;

      render();

      const shapes = e.getShapes();
      expect(shapes).toHaveLength(1);

      const solid = shapes[0] as Solid;
      // A cylinder with a hole has more faces than a simple cylinder
      expect(solid.getFaces().length).toBeGreaterThan(3);
    });

    it("should not drill hole when drill is false", () => {
      sketch("xy", () => {
        circle(50);
        circle(20);
      });

      const e = extrude(30).drill(false) as Extrude;

      render();

      const shapes = e.getShapes();
      expect(shapes).toHaveLength(1);

      const solid = shapes[0] as Solid;
      // Without drilling, inner circle fills in — result is a simple cylinder with 3 faces
      expect(solid.getFaces()).toHaveLength(3);
    });
  });
});
