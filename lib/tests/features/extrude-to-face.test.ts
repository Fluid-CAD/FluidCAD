import { describe, it, expect } from "vitest";
import { setupOC, render } from "../setup.js";
import sketch from "../../core/sketch.js";
import extrude from "../../core/extrude.js";
import select from "../../core/select.js";
import rotate from "../../core/rotate.js";
import { circle, move, rect } from "../../core/2d/index.js";
import { Solid } from "../../common/solid.js";
import { ExtrudeToFace } from "../../features/extrude-to-face.js";
import { Extrude } from "../../features/extrude.js";
import { Sketch } from "../../features/2d/sketch.js";
import cylinder from "../../core/cylinder.js";
import { countShapes } from "../utils.js";
import { ShapeOps } from "../../oc/shape-ops.js";
import { face } from "../../filters/index.js";

describe("extrude to face", () => {
  setupOC();

  describe("parallel planar face", () => {
    it("should extrude up to a parallel planar end face", () => {
      sketch("xy", () => {
        rect(100, 50);
      });
      const e1 = extrude(50) as Extrude;

      sketch("xy", () => {
        move([200, 0]);
        rect(30, 30);
      });
      const e2 = extrude(e1.endFaces()) as ExtrudeToFace;

      render();

      const shapes = e2.getShapes();
      expect(shapes).toHaveLength(1);
      expect(shapes[0].getType()).toBe("solid");

      const bbox = ShapeOps.getBoundingBox(shapes[0]);
      expect(bbox.maxZ).toBeCloseTo(50, 0);
    });

    it("should match the height of the target face", () => {
      sketch("xy", () => {
        rect(100, 50);
      });
      const e1 = extrude(20) as Extrude;

      sketch("xy", () => {
        move([200, 0]);
        rect(30, 30);
      });
      const e2 = extrude(e1.endFaces()) as ExtrudeToFace;

      render();

      const shapes = e2.getShapes();
      expect(shapes).toHaveLength(1);

      const bbox = ShapeOps.getBoundingBox(shapes[0]);
      expect(bbox.maxZ).toBeCloseTo(20, 0);
    });
  });

  describe("first-face / last-face", () => {
    it("should extrude up to the first face in the normal direction", () => {
      // Thin slab at z=20..21 — its top face center is at z=21
      sketch("xy", () => {
        move([200, 0]);
        rect(50, 50);
      });
      extrude(21).endOffset(1).new();

      // Thin slab at z=50..51
      sketch("xy", () => {
        move([200, 100]);
        rect(50, 50);
      });
      extrude(51).endOffset(1).new();

      // first-face should reach the closest face center (z=20 bottom of first slab)
      sketch("xy", () => {
        rect(30, 30);
      });
      const e = extrude("first-face") as ExtrudeToFace;

      render();

      const shapes = e.getShapes();
      expect(shapes).toHaveLength(1);

      const bbox = ShapeOps.getBoundingBox(shapes[0]);
      // Should reach the first slab, not the second
      expect(bbox.maxZ).toBeLessThan(50);
    });

    it("should extrude up to the last face in the normal direction", () => {
      // Short box
      sketch("xy", () => {
        move([200, 0]);
        rect(50, 50);
      });
      extrude(30).new();

      // Tall box
      sketch("xy", () => {
        move([200, 100]);
        rect(50, 50);
      });
      extrude(60).new();

      // last-face should reach the farthest face
      sketch("xy", () => {
        rect(30, 30);
      });
      const e = extrude("last-face") as ExtrudeToFace;

      render();

      const shapes = e.getShapes();
      expect(shapes).toHaveLength(1);

      const bbox = ShapeOps.getBoundingBox(shapes[0]);
      expect(bbox.maxZ).toBeCloseTo(60, 0);
    });

    it("first-face and last-face should produce different heights", () => {
      sketch("xy", () => {
        move([200, 0]);
        rect(50, 50);
      });
      extrude(30).new();

      sketch("xy", () => {
        move([200, 100]);
        rect(50, 50);
      });
      extrude(80).new();

      sketch("xy", () => {
        rect(20, 20);
      });
      const eFirst = extrude("first-face") as ExtrudeToFace;

      sketch("xy", () => {
        move([0, 30]);
        rect(20, 20);
      });
      const eLast = extrude("last-face") as ExtrudeToFace;

      render();

      const firstBBox = ShapeOps.getBoundingBox(eFirst.getShapes()[0]);
      const lastBBox = ShapeOps.getBoundingBox(eLast.getShapes()[0]);

      expect(lastBBox.maxZ).toBeGreaterThan(firstBBox.maxZ);
    });
  });

  describe("first-face / last-face with filters", () => {
    it("should narrow the candidate set with a face filter", () => {
      // Cylinder at origin and a planar slab nearby. Without a filter,
      // 'first-face' would pick the slab's top (at z=20). The cylinder
      // filter forces selection of the cylindrical side face (z=40).
      cylinder(50, 80);

      sketch("xy", () => {
        move([200, 0]);
        rect(50, 50);
      });
      extrude(20).new();

      sketch("xy", () => {
        move([200, 100]);
        rect(30, 30);
      });
      const e = extrude("first-face", face().cylinder()) as ExtrudeToFace;

      render();

      const shapes = e.getShapes();
      expect(shapes).toHaveLength(1);
      expect(shapes[0].getType()).toBe("solid");
    });

    it("should record an error when the filter eliminates all candidate faces", () => {
      // Scene contains only planar geometry — cylinder filter matches nothing
      sketch("xy", () => {
        move([200, 0]);
        rect(50, 50);
      });
      extrude(30).new();

      sketch("xy", () => {
        rect(20, 20);
      });
      const e = extrude("first-face", face().cylinder()) as ExtrudeToFace;

      render();

      expect(e.getError()).toMatch(/No face found for 'first-face' extrusion/);
    });

    it("should accept a filter together with an explicit target", () => {
      cylinder(50, 80);

      const target = sketch("xy", () => {
        move([200, 100]);
        rect(20, 20);
      }) as Sketch;

      // Some other sketch in scope so the sketch context is non-trivial.
      sketch("xy", () => {
        rect(10, 10);
      });

      const e = extrude("first-face", face().cylinder(), target) as ExtrudeToFace;

      render();

      const shapes = e.getShapes();
      expect(shapes).toHaveLength(1);
      expect(shapes[0].getType()).toBe("solid");
    });
  });

  describe("non-parallel planar face", () => {
    it("should extrude up to a drafted side face", () => {
      // Create a box with drafted sides — side faces are inclined planes
      sketch("xy", () => {
        rect(100, 50);
      });
      const e1 = extrude(50).draft(10) as Extrude;

      sketch("xy", () => {
        move([200, 0]);
        rect(30, 30);
      });
      const e2 = extrude(e1.sideFaces(0)) as ExtrudeToFace;

      render();

      const shapes = e2.getShapes();
      expect(shapes).toHaveLength(1);
      expect(shapes[0].getType()).toBe("solid");
    });
  });

  describe("cylindrical face", () => {
    it("should extrude up to a cylindrical face", () => {
      cylinder(50, 80);
      const cylFace = select(face().cylinder());

      sketch("xy", () => {
        move([200, 0]);
        rect(30, 30);
      });
      const e = extrude(cylFace) as ExtrudeToFace;

      render();

      const shapes = e.getShapes();
      expect(shapes).toHaveLength(1);
      expect(shapes[0].getType()).toBe("solid");
    });
  });

  describe("inclined cylindrical face", () => {
    it("should extrude up to a rotated cylindrical face", () => {
      const cyl = cylinder(50, 80);
      rotate("y", 45, cyl);
      const cylFace = select(face().cylinder());

      sketch("xy", () => {
        move([200, 0]);
        rect(30, 30);
      });
      const e = extrude(cylFace) as ExtrudeToFace;

      render();

      const shapes = e.getShapes();
      expect(shapes).toHaveLength(1);
      expect(shapes[0].getType()).toBe("solid");
    });
  });

  describe("fuse", () => {
    it("should not fuse with non-intersecting objects", () => {
      sketch("xy", () => {
        rect(100, 50);
      });
      const e1 = extrude(50) as Extrude;

      sketch("xy", () => {
        move([200, 0]);
        rect(30, 30);
      });
      const e2 = extrude(e1.endFaces()) as ExtrudeToFace;

      render();

      // Two solids: the original box and the extruded-to-face box
      expect(e1.getShapes({}, 'solid')).toHaveLength(1);
      expect(e2.getShapes({}, 'solid')).toHaveLength(1);
    });

    it("should fuse with intersecting objects by default", () => {
      sketch("xy", () => {
        rect(100, 50);
      });
      const e1 = extrude(50) as Extrude;

      sketch("xy", () => {
        move([25, 10]);
        rect(30, 30);
      });
      extrude(e1.endFaces());

      const scene = render();

      // Fused into 1 solid (lazy face selection is not a solid)
      const solids = scene.getAllSceneObjects().flatMap(o => o.getShapes({}, 'solid'));
      expect(solids).toHaveLength(1);
    });

    it("should not fuse with intersecting objects when fuse is none", () => {
      sketch("xy", () => {
        rect(100, 50);
      });
      const e1 = extrude(50) as Extrude;

      sketch("xy", () => {
        move([25, 10]);
        rect(30, 30);
      });
      const e2 = extrude(e1.endFaces()).new() as ExtrudeToFace;

      render();

      // Two solids: the original box and the unfused extruded-to-face box
      expect(e1.getShapes({}, 'solid')).toHaveLength(1);
      expect(e2.getShapes({}, 'solid')).toHaveLength(1);
    });
  });

  describe("drill", () => {
    it("should drill hole when inner shape is nested (default)", () => {
      sketch("xy", () => {
        rect(100, 50);
      });
      const e1 = extrude(50) as Extrude;

      sketch("xy", () => {
        move([200, 0]);
        circle(100);
        circle([200, 0], 40);
      });
      const e2 = extrude(e1.endFaces()) as ExtrudeToFace;

      render();

      const shapes = e2.getShapes();
      expect(shapes).toHaveLength(1);

      const solid = shapes[0] as Solid;
      expect(solid.getFaces().length).toBeGreaterThan(3);
    });
  });

  describe("pick", () => {
    it("should only extrude the picked region", () => {
      sketch("xy", () => {
        rect(100, 50);
      });
      const e1 = extrude(50) as Extrude;

      sketch("xy", () => {
        move([200, 0]);
        circle(60);
        circle([200, 100], 60);
      });
      const e2 = extrude(e1.endFaces()).pick([200, 0]) as ExtrudeToFace;

      render();

      const shapes = e2.getShapes();
      expect(shapes).toHaveLength(1);
    });
  });
});
