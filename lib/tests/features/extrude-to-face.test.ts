import { describe, it, expect } from "vitest";
import { setupOC, render } from "../setup.js";
import sketch from "../../core/sketch.js";
import extrude from "../../core/extrude.js";
import select from "../../core/select.js";
import rotate from "../../core/rotate.js";
import { arc, circle, line } from "../../core/2d/index.js";
import { coincident } from "../../core/constraints/index.js";
import plane from "../../core/plane.js";
import { ShapeProps } from "../../oc/props.js";
import { getSceneManager } from "../../scene-manager.js";
import { Solid } from "../../common/solid.js";
import { ExtrudeToFace } from "../../features/extrude-to-face.js";
import { Extrude } from "../../features/extrude.js";
import { Sketch } from "../../features/2d/sketch.js";
import cylinder from "../../core/cylinder.js";
import { countShapes } from "../utils.js";
import { ShapeOps } from "../../oc/shape-ops.js";
import { face } from "../../filters/index.js";
import { testRect } from "../helpers/profiles.js";
import { Point } from "../../math/point.js";

describe("extrude to face", () => {
  setupOC();

  describe("parallel planar face", () => {
    it("should extrude up to a parallel planar end face", () => {
      sketch("xy", () => {
          testRect(100, 50);
        });
      const e1 = extrude(50) as Extrude;

      sketch("xy", () => {
          testRect(30, 30, { at: [200, 0] });
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
          testRect(100, 50);
        });
      const e1 = extrude(20) as Extrude;

      sketch("xy", () => {
          testRect(30, 30, { at: [200, 0] });
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
          testRect(50, 50, { at: [200, 0] });
        });
      extrude(21).endOffset(1).new();

      // Thin slab at z=50..51
      sketch("xy", () => {
          testRect(50, 50, { at: [200, 100] });
        });
      extrude(51).endOffset(1).new();

      // first-face should reach the closest face center (z=20 bottom of first slab)
      sketch("xy", () => {
          testRect(30, 30);
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
          testRect(50, 50, { at: [200, 0] });
        });
      extrude(30).new();

      // Tall box
      sketch("xy", () => {
          testRect(50, 50, { at: [200, 100] });
        });
      extrude(60).new();

      // last-face should reach the farthest face
      sketch("xy", () => {
          testRect(30, 30);
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
          testRect(50, 50, { at: [200, 0] });
        });
      extrude(30).new();

      sketch("xy", () => {
          testRect(50, 50, { at: [200, 100] });
        });
      extrude(80).new();

      sketch("xy", () => {
          testRect(20, 20);
        });
      const eFirst = extrude("first-face") as ExtrudeToFace;

      sketch("xy", () => {
          testRect(20, 20, { at: [0, 30] });
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
          testRect(50, 50, { at: [200, 0] });
        });
      extrude(20).new();

      sketch("xy", () => {
          testRect(30, 30, { at: [200, 100] });
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
          testRect(50, 50, { at: [200, 0] });
        });
      extrude(30).new();

      sketch("xy", () => {
          testRect(20, 20);
        });
      const e = extrude("first-face", face().cylinder()) as ExtrudeToFace;

      render();

      expect(e.getError()).toMatch(/No face found for 'first-face' extrusion/);
    });

    it("should accept a filter together with an explicit target", () => {
      cylinder(50, 80);

      const target = sketch("xy", () => {
          testRect(20, 20, { at: [200, 100] });
        }) as Sketch;

      // Some other sketch in scope so the sketch context is non-trivial.
      sketch("xy", () => {
          testRect(10, 10);
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
          testRect(100, 50);
        });
      const e1 = extrude(50).draft(10) as Extrude;

      sketch("xy", () => {
          testRect(30, 30, { at: [200, 0] });
        });
      const e2 = extrude(e1.sideFaces(0)) as ExtrudeToFace;

      render();

      const shapes = e2.getShapes();
      expect(shapes).toHaveLength(1);
      expect(shapes[0].getType()).toBe("solid");
    });
  });

  describe("drill", () => {
    function buildDrillScenario(drill: boolean): number {
      getSceneManager().startScene();

      sketch("xy", () => {
          testRect(100, 50, { at: [200, 0] });
        });
      const e1 = extrude(50) as Extrude;

      sketch("xy", () => {
          circle([0, 0], 30);
          circle([0, 0], 10);
        });
      const e2 = extrude(e1.endFaces()).drill(drill).new() as ExtrudeToFace;

      render();

      let volume = 0;
      for (const s of e2.getShapes()) {
        volume += ShapeProps.getProperties(s.getShape()).volumeMm3;
      }
      return volume;
    }

    it("should drill nested regions by default and honor drill(false)", () => {
      // The nested circle drills through: a ⌀30/⌀10 tube up to the 50-high face.
      expect(buildDrillScenario(true)).toBeCloseTo(Math.PI * (15 * 15 - 5 * 5) * 50, 0);
      // Without drilling the inner circle fills in — the full cylinder.
      expect(buildDrillScenario(false)).toBeCloseTo(Math.PI * 15 * 15 * 50, 0);
    });
  });

  describe("cylindrical face", () => {
    it("should extrude up to a cylindrical face", () => {
      cylinder(50, 80);
      const cylFace = select(face().cylinder());

      sketch("xy", () => {
          testRect(30, 30, { at: [200, 0] });
        });
      const e = extrude(cylFace) as ExtrudeToFace;

      render();

      const shapes = e.getShapes();
      expect(shapes).toHaveLength(1);
      expect(shapes[0].getType()).toBe("solid");
    });
  });

  describe("conical face", () => {
    function buildDraftedScenario(endOffset?: number): number {
      getSceneManager().startScene();

      sketch("top", () => {
          circle([0, 0], 50);
        });
      const base = extrude(50).draft(-8) as Extrude;

      // legacy slot([0, 10], [0, 30], 5): cap centers [0,10]/[0,30], r=5.
      sketch(plane("front", 50), () => {
          const side1 = line([-5, 10], [-5, 30]);
          const capTop = arc([-5, 30], [5, 30], [0, 30]).cw();
          const side2 = line([5, 30], [5, 10]);
          const capBottom = arc([5, 10], [-5, 10], [0, 10]).cw();
          coincident(side1.end(), capTop.start());
          coincident(capTop.end(), side2.start());
          coincident(side2.end(), capBottom.start());
          coincident(capBottom.end(), side1.start());
        });

      let e = extrude(base.sideFaces()) as ExtrudeToFace;
      if (endOffset !== undefined) {
        e = e.endOffset(endOffset) as ExtrudeToFace;
      }

      render();

      let volume = 0;
      for (const s of e.getShapes()) {
        volume += ShapeProps.getProperties(s.getShape()).volumeMm3;
      }
      return volume;
    }

    it("should extrude up to a drafted (conical) side face", () => {
      const volume = buildDraftedScenario();
      expect(volume).toBeGreaterThan(0);
    });

    it("should respect endOffset against a conical target face", () => {
      const without = buildDraftedScenario();
      const withOffset = buildDraftedScenario(2);

      // endOffset(2) stops the extrusion short of the cone, so the result
      // stays a separate, smaller solid instead of fusing with the base.
      expect(withOffset).not.toBeCloseTo(without, 1);
      expect(withOffset).toBeLessThan(without);
    });
  });

  describe("surrounding cylindrical face", () => {
    it("extrudes along the sketch normal when the target cylinder surrounds the sketch", () => {
      // The target cylinder straddles the sketch plane: the sketch sits inside
      // the bore, offset from the axis, so the wall is deeper behind the plane
      // (axis side) than in front. The extrusion must still follow the sketch
      // normal, not run off toward the farther wall.
      cylinder(50, 80);
      const cylFace = select(face().cylinder());

      const s = sketch(plane("xz", 19), () => {
          testRect(20, 20, { at: [-10, 20] });
        }) as Sketch;
      const e = extrude(cylFace).new() as ExtrudeToFace;

      render();

      const shapes = e.getShapes();
      expect(shapes).toHaveLength(1);

      const sketchPlane = s.getPlane();
      const bbox = ShapeOps.getBoundingBox(shapes[0]);
      const corners = [
        new Point(bbox.minX, bbox.minY, bbox.minZ),
        new Point(bbox.maxX, bbox.maxY, bbox.maxZ),
      ];
      const dists = corners.map(c => sketchPlane.signedDistanceToPoint(c));
      // The whole solid lies on the sketch-normal side of the plane…
      expect(Math.min(...dists)).toBeGreaterThan(-0.5);
      // …and reaches out to the near cylinder wall (~31mm away), not 0.
      expect(Math.max(...dists)).toBeGreaterThan(10);
    });
  });

  describe("inclined cylindrical face", () => {
    it("should extrude up to a rotated cylindrical face", () => {
      const cyl = cylinder(50, 80);
      rotate("y", 45, cyl);
      const cylFace = select(face().cylinder());

      sketch("xy", () => {
          testRect(30, 30, { at: [200, 0] });
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
          testRect(100, 50);
        });
      const e1 = extrude(50) as Extrude;

      sketch("xy", () => {
          testRect(30, 30, { at: [200, 0] });
        });
      const e2 = extrude(e1.endFaces()) as ExtrudeToFace;

      render();

      // Two solids: the original box and the extruded-to-face box
      expect(e1.getShapes({}, 'solid')).toHaveLength(1);
      expect(e2.getShapes({}, 'solid')).toHaveLength(1);
    });

    it("should fuse with intersecting objects by default", () => {
      sketch("xy", () => {
          testRect(100, 50);
        });
      const e1 = extrude(50) as Extrude;

      sketch("xy", () => {
          testRect(30, 30, { at: [25, 10] });
        });
      extrude(e1.endFaces());

      const scene = render();

      // Fused into 1 solid (lazy face selection is not a solid)
      const solids = scene.getAllSceneObjects().flatMap(o => o.getShapes({}, 'solid'));
      expect(solids).toHaveLength(1);
    });

    it("should not fuse with intersecting objects when fuse is none", () => {
      sketch("xy", () => {
          testRect(100, 50);
        });
      const e1 = extrude(50) as Extrude;

      sketch("xy", () => {
          testRect(30, 30, { at: [25, 10] });
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
          testRect(100, 50);
        });
      const e1 = extrude(50) as Extrude;

      sketch("xy", () => {
          circle([200, 0], 100);
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
          testRect(100, 50);
        });
      const e1 = extrude(50) as Extrude;

      sketch("xy", () => {
          circle([200, 0], 60);
          circle([200, 100], 60);
        });
      const e2 = extrude(e1.endFaces()).pick([200, 0]) as ExtrudeToFace;

      render();

      const shapes = e2.getShapes();
      expect(shapes).toHaveLength(1);
    });
  });
});
