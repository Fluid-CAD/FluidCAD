import { describe, it, expect } from "vitest";
import { setupOC, render } from "../setup.js";
import sketch from "../../core/sketch.js";
import extrude from "../../core/extrude.js";
import select from "../../core/select.js";
import rotate from "../../core/rotate.js";
import { arc, circle, line, region } from "../../core/2d/index.js";
import { coincident } from "../../core/constraints/index.js";
import plane from "../../core/plane.js";
import { ShapeProps } from "../../oc/props.js";
import { getSceneManager } from "../../scene-manager.js";
import { Solid } from "../../common/solid.js";
import { ExtrudeToFace } from "../../features/extrude-to-face.js";
import { Extrude } from "../../features/extrude.js";
import { Sketch } from "../../features/2d/sketch.js";
import cylinder from "../../core/cylinder.js";
import shell from "../../core/shell.js";
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
    // A 10 x 50 wall standing beside the path, 100 tall: its big faces
    // are parallel to the sweep and their centres (z = 50) are nearer
    // than anything the extrusion actually meets.
    function wallBesidePath() {
      sketch("xy", () => {
          testRect(10, 50, { at: [40, -25] });
        });
      extrude(100).new();
    }

    // A slab across the whole path, `thickness` thick from `z` up.
    function slabAcrossPath(z: number, thickness: number) {
      sketch(plane("xy", z), () => {
          testRect(100, 100, { at: [-50, -50] });
        });
      extrude(thickness).new();
    }

    it("should extrude up to the first face the extrusion runs into", () => {
      // A slab beside the path, nearest of all by face centre (z = 20).
      sketch(plane("xy", 20), () => {
          testRect(50, 50, { at: [200, 0] });
        });
      extrude(1).new();
      wallBesidePath();
      slabAcrossPath(80, 10);

      sketch("xy", () => {
          testRect(30, 30);
        });
      const e = extrude("first-face").new() as ExtrudeToFace;

      render();

      const shapes = e.getShapes();
      expect(shapes).toHaveLength(1);

      const bbox = ShapeOps.getBoundingBox(shapes[0]);
      expect(bbox.maxZ).toBeCloseTo(80, 0);
    });

    it("should extrude up to the last face the extrusion runs into", () => {
      slabAcrossPath(30, 10);
      slabAcrossPath(60, 10);
      // Taller than both slabs, but beside the path.
      sketch("xy", () => {
          testRect(10, 50, { at: [40, -25] });
        });
      extrude(200).new();

      sketch("xy", () => {
          testRect(30, 30);
        });
      const e = extrude("last-face").new() as ExtrudeToFace;

      render();

      const shapes = e.getShapes();
      expect(shapes).toHaveLength(1);

      const bbox = ShapeOps.getBoundingBox(shapes[0]);
      expect(bbox.maxZ).toBeCloseTo(70, 0);
    });

    it("first-face and last-face should produce different heights", () => {
      slabAcrossPath(30, 10);
      slabAcrossPath(80, 10);

      sketch("xy", () => {
          testRect(20, 20);
        });
      const eFirst = extrude("first-face").new() as ExtrudeToFace;

      sketch("xy", () => {
          testRect(20, 20, { at: [0, 30] });
        });
      const eLast = extrude("last-face").new() as ExtrudeToFace;

      render();

      const firstBBox = ShapeOps.getBoundingBox(eFirst.getShapes()[0]);
      const lastBBox = ShapeOps.getBoundingBox(eLast.getShapes()[0]);

      expect(firstBBox.maxZ).toBeCloseTo(30, 0);
      expect(lastBBox.maxZ).toBeCloseTo(90, 0);
    });

    it("should ignore a face the extrusion only runs along", () => {
      // The profile shares an edge with a block standing beside it: the
      // block's side face at x = 30 lies in the sweep direction and must
      // not count, so the extrusion reaches the slab above.
      sketch("xy", () => {
          testRect(20, 30, { at: [30, 0] });
        });
      extrude(40).new();
      slabAcrossPath(60, 10);

      sketch("xy", () => {
          testRect(30, 30);
        });
      const e = extrude("first-face").new() as ExtrudeToFace;

      render();

      const bbox = ShapeOps.getBoundingBox(e.getShapes()[0]);
      expect(bbox.maxZ).toBeCloseTo(60, 0);
    });

    it("should record an error when nothing lies ahead of the sketch", () => {
      sketch(plane("xy", 20), () => {
          testRect(50, 50, { at: [200, 0] });
        });
      extrude(10).new();

      sketch("xy", () => {
          testRect(20, 20);
        });
      const e = extrude("first-face") as ExtrudeToFace;

      render();

      expect(e.getError()).toMatch(/No face found for 'first-face' extrusion/);
    });
  });

  describe("first-face inside a shelled box", () => {
    it("should stop at the rib across the path, not at the box's side walls", () => {
      // An open box with 2 mm walls, a rib standing across its inside,
      // and a rod sketched on the inner face of the +X wall pointing at
      // the rib. The side walls' centres are the nearest faces ahead of
      // the sketch but the rod never touches them: it ends on the rib
      // (x = -30), a 98 mm rod, and never leaves the box.
      sketch("xy", () => {
          testRect(140, 90, { at: [-70, -45] });
        });
      const box = extrude(50) as Extrude;
      const sh = shell(-2, box.endFaces());

      sketch(sh.internalFaces(4), () => {
          testRect(8.13, 66.74, { at: [-38.13, -40] });
        });
      extrude(50);

      sketch(sh.internalFaces(2), () => {
          circle([0, 28.68], 17.7);
        });
      const rod = extrude("first-face").new() as ExtrudeToFace;

      render();

      expect(rod.getError()).toBeNull();
      const shapes = rod.getShapes();
      expect(shapes).toHaveLength(1);

      const bbox = ShapeOps.getBoundingBox(shapes[0]);
      expect(bbox.minX).toBeCloseTo(-30, 0);
      expect(bbox.maxX).toBeCloseTo(68, 0);
    });
  });

  describe("first-face / last-face with filters", () => {
    // A ⌀20 rod across the path along X, its axis at y = 0, z = 60.
    function rodAcrossPath() {
      sketch(plane("yz", -50), () => {
          circle([0, 60], 20);
        });
      extrude(100).new();
    }

    it("should narrow the candidate set with a face filter", () => {
      // A slab across the path at z = 20 and the rod above it. Without a
      // filter 'first-face' stops at the slab; the cylinder filter skips
      // it and the extrusion ends on the rod.
      sketch(plane("xy", 20), () => {
          testRect(100, 100, { at: [-50, -50] });
        });
      extrude(10).new();
      rodAcrossPath();

      sketch("xy", () => {
          testRect(10, 10, { at: [-5, -5] });
        });
      const e = extrude("first-face", face().cylinder()).new() as ExtrudeToFace;

      render();

      const shapes = e.getShapes();
      expect(shapes).toHaveLength(1);
      expect(shapes[0].getType()).toBe("solid");

      const bbox = ShapeOps.getBoundingBox(shapes[0]);
      expect(bbox.maxZ).toBeGreaterThan(50);
      expect(bbox.maxZ).toBeLessThan(60);
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
      rodAcrossPath();

      const target = sketch("xy", () => {
          testRect(10, 10, { at: [-5, -5] });
        }) as Sketch;

      // Some other sketch in scope so the sketch context is non-trivial.
      sketch("xy", () => {
          testRect(10, 10, { at: [200, 200] });
        });

      const e = extrude("first-face", face().cylinder(), target).new() as ExtrudeToFace;

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

  describe("region", () => {
    it("should only extrude the picked region", () => {
      sketch("xy", () => {
          testRect(100, 50);
        });
      const e1 = extrude(50) as Extrude;

      sketch("xy", () => {
          const a = circle([200, 0], 60);
          circle([200, 100], 60);
          region('a', a);
        });
      const e2 = extrude(e1.endFaces()).region('a') as ExtrudeToFace;

      render();

      const shapes = e2.getShapes();
      expect(shapes).toHaveLength(1);
    });
  });
});
