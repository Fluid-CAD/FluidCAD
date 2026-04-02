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
      const e2 = extrude(e1.endFace()) as ExtrudeToFace;

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
      const e2 = extrude(e1.endFace()) as ExtrudeToFace;

      render();

      const shapes = e2.getShapes();
      expect(shapes).toHaveLength(1);

      const bbox = ShapeOps.getBoundingBox(shapes[0]);
      expect(bbox.maxZ).toBeCloseTo(20, 0);
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
      const e2 = extrude(e1.sideFace(0)) as ExtrudeToFace;

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
      extrude(e1.endFace());

      const scene = render();

      expect(countShapes(scene)).toBe(2);
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
      extrude(e1.endFace()).fuse("none");

      const scene = render();

      expect(countShapes(scene)).toBe(2);
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
        circle(50);
        circle([200, 0], 20);
      });
      const e2 = extrude(e1.endFace()) as ExtrudeToFace;

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
        circle(30);
        circle([200, 100], 30);
      });
      const e2 = extrude(e1.endFace()).pick([200, 0]) as ExtrudeToFace;

      render();

      const shapes = e2.getShapes();
      expect(shapes).toHaveLength(1);
    });
  });
});
