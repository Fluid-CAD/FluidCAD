import { describe, it, expect } from "vitest";
import { setupOC, render, expectDisplayConsumed } from "../setup.js";
import sketch from "../../core/sketch.js";
import extrude from "../../core/extrude.js";
import plane from "../../core/plane.js";
import select from "../../core/select.js";
import split from "../../core/split.js";
import translate from "../../core/translate.js";
import repeat from "../../core/repeat.js";
import { line, arc, circle, bezier } from "../../core/2d/index.js";
import rect from "../../core/shapes/rect.js";
import { coincident, fix, distance, vertical, horizontal } from "../../core/constraints/index.js";
import { face } from "../../filters/index.js";
import { ExtrudeBase } from "../../features/extrude-base.js";
import { RepeatBase } from "../../features/repeat-base.js";
import { Sketch } from "../../features/2d/sketch.js";
import { Split } from "../../features/split.js";
import { SceneObject } from "../../common/scene-object.js";
import { Shape } from "../../common/shape.js";
import { ShapeOps } from "../../oc/shape-ops.js";
import { ShapeProps } from "../../oc/props.js";
import { PlaneObjectBase } from "../../features/plane-renderable-base.js";
import { testRect } from "../helpers/profiles.js";

function volume(shape: Shape): number {
  return ShapeProps.getProperties(shape.getShape()).volumeMm3;
}

function box(): ExtrudeBase {
  // 40 × 30 footprint centred on the origin, 10 tall: x ∈ [-20, 20], y ∈ [-15, 15], z ∈ [0, 10].
  sketch("xy", () => {
    testRect(40, 30, { at: [-20, -15] });
  });
  return extrude(10).new() as ExtrudeBase;
}

function sceneSolids(scene: ReturnType<typeof render>): Shape[] {
  const all = new Set(scene.getAllSceneObjects());
  return scene.getAllSceneObjects().flatMap(o => o.getShapes({}, 'solid', all));
}

describe("split", () => {
  setupOC();

  describe("by an origin plane", () => {
    it("cuts a box into the two bodies either side of the plane", () => {
      const e = box();
      const s = split("yz") as unknown as Split;

      const scene = render();

      const pieces = s.getShapes();
      expect(pieces.length).toBe(2);
      expect(pieces.every(p => p.isSolid())).toBe(true);
      // Front (the +x side the YZ normal points to) first.
      const front = ShapeOps.getBoundingBox(pieces[0]);
      const back = ShapeOps.getBoundingBox(pieces[1]);
      expect(front.minX).toBeCloseTo(0, 5);
      expect(front.maxX).toBeCloseTo(20, 5);
      expect(back.minX).toBeCloseTo(-20, 5);
      expect(back.maxX).toBeCloseTo(0, 5);
      expect(volume(pieces[0]) + volume(pieces[1])).toBeCloseTo(40 * 30 * 10, 3);
      // Each piece is a closed box with a flat cap: six faces.
      expect(pieces[0].getSubShapes('face').length).toBe(6);
      expect(pieces[1].getSubShapes('face').length).toBe(6);

      // The source body left its extrude for the split's pieces.
      expect(e.getShapes().length).toBe(0);
      expect(sceneSolids(scene).length).toBe(2);
      expect(s.getError()).toBeNull();
    });

    it("keeps the front side only", () => {
      box();
      const s = split("yz", { keep: 'front' }) as unknown as Split;

      const scene = render();

      const pieces = s.getShapes();
      expect(pieces.length).toBe(1);
      const bbox = ShapeOps.getBoundingBox(pieces[0]);
      expect(bbox.minX).toBeCloseTo(0, 5);
      expect(bbox.maxX).toBeCloseTo(20, 5);
      expect(volume(pieces[0])).toBeCloseTo(20 * 30 * 10, 3);
      expect(sceneSolids(scene).length).toBe(1);
    });

    it("keeps the back side only", () => {
      box();
      const s = split("yz", { keep: 'back' }) as unknown as Split;

      render();

      const pieces = s.getShapes();
      expect(pieces.length).toBe(1);
      const bbox = ShapeOps.getBoundingBox(pieces[0]);
      expect(bbox.minX).toBeCloseTo(-20, 5);
      expect(bbox.maxX).toBeCloseTo(0, 5);
    });

    it("leaves a solid the plane misses untouched and flags the statement", () => {
      const e = box();
      const s = split(plane("yz", 100)) as unknown as Split;

      const scene = render();

      expect(s.getShapes().length).toBe(0);
      expect(e.getShapes().length).toBe(1);
      expect(sceneSolids(scene).length).toBe(1);
      expect(s.getError()).toContain("nothing was split");
    });

    it("leaves a solid the plane only grazes along a face untouched", () => {
      const e = box();
      // z = 0 is the bottom face of the box.
      const s = split("xy") as unknown as Split;

      render();

      expect(s.getShapes().length).toBe(0);
      expect(e.getShapes().length).toBe(1);
      expect(s.getError()).toContain("nothing was split");
    });

    it("refuses to build with no solid in scope", () => {
      const s = split("yz") as unknown as Split;

      const scene = render();

      const row = scene.getRenderedObjects().find(r => r.type === 'split');
      expect(row).toBeDefined();
      expect(s.getError() ?? row?.errorMessage).toContain("nothing to split");
    });

    it("splits every solid in scope when no target is named", () => {
      box();
      sketch("xy", () => {
        testRect(10, 10, { at: [-5, 30] });
      });
      extrude(10).new();
      const s = split("yz") as unknown as Split;

      const scene = render();

      expect(s.getShapes().length).toBe(4);
      expect(sceneSolids(scene).length).toBe(4);
    });

    it("splits only the named target", () => {
      const a = box();
      sketch("xy", () => {
        testRect(10, 10, { at: [-5, 30] });
      });
      const b = extrude(10).new() as ExtrudeBase;
      const s = split("yz", b) as unknown as Split;

      const scene = render();

      expect(s.getShapes().length).toBe(2);
      expect(a.getShapes().length).toBe(1);
      expect(b.getShapes().length).toBe(0);
      expect(sceneSolids(scene).length).toBe(3);
    });

    it("hides the plane for display only", () => {
      box();
      const p = plane("yz") as unknown as PlaneObjectBase;
      split(p);

      const scene = render();

      expectDisplayConsumed(scene, p);
    });

    it("is a body a later feature can move as a whole", () => {
      box();
      const s = split("yz") as unknown as Split;
      const t = translate([0, 0, 50], s) as unknown as SceneObject;

      const scene = render();

      expect(s.getShapes().length).toBe(0);
      const moved = t.getShapes();
      expect(moved.length).toBe(2);
      expect(ShapeOps.getExactBoundingBox(moved[0]).minZ).toBeCloseTo(50, 5);
      expect(sceneSolids(scene).length).toBe(2);
    });
  });

  describe("by a plane statement and a face", () => {
    it("cuts at an offset plane statement", () => {
      box();
      const p = plane("xy", 4) as unknown as PlaneObjectBase;
      const s = split(p) as unknown as Split;

      render();

      const pieces = s.getShapes();
      expect(pieces.length).toBe(2);
      expect(ShapeOps.getBoundingBox(pieces[0]).minZ).toBeCloseTo(4, 5);
      expect(ShapeOps.getBoundingBox(pieces[1]).maxZ).toBeCloseTo(4, 5);
    });

    it("cuts at the plane of a selected face, offset into the body", () => {
      const e = box();
      // The +x side face of the box, lifted to a plane and moved 8 inward.
      const s = split(plane(select(face().onPlane('yz', 20)), -8), e) as unknown as Split;

      render();

      const pieces = s.getShapes();
      expect(pieces.length).toBe(2);
      expect(ShapeOps.getBoundingBox(pieces[0]).minX).toBeCloseTo(12, 5);
      expect(ShapeOps.getBoundingBox(pieces[1]).maxX).toBeCloseTo(12, 5);
    });
  });

  describe("by a sketched line", () => {
    it("cuts along the plane the line sweeps out of its sketch", () => {
      box();
      let seed: any;
      sketch("xy", () => {
        // A vertical construction line at x = 6.
        seed = line([6, -40], [6, 40]).guide();
        vertical(seed);
        fix(seed.start(), [6, -40]);
        distance(seed.start(), seed.end(), 80);
      });
      const s = split(seed) as unknown as Split;

      const scene = render();

      const pieces = s.getShapes();
      expect(pieces.length).toBe(2);
      // The line's own direction is the plane's x; its normal (line × sketch
      // normal = +y × +z = +x) points at the +x piece, which comes first.
      expect(ShapeOps.getBoundingBox(pieces[0]).minX).toBeCloseTo(6, 5);
      expect(ShapeOps.getBoundingBox(pieces[1]).maxX).toBeCloseTo(6, 5);
      expect(s.getPlane().normal.x).toBeCloseTo(1, 9);
      expect(sceneSolids(scene).length).toBe(2);
      // The seed line stays readable by later features; its sketch is hidden
      // for display from the split on, like an extrude's profile.
      expect((seed as SceneObject).getShapes({ excludeGuide: false }).length).toBe(1);
      const seedSketch = (seed as SceneObject).getParent()!;
      expectDisplayConsumed(scene, seedSketch);
    });

    it("cuts along a slanted line", () => {
      box();
      let seed: any;
      sketch("xy", () => {
        seed = line([-10, -10], [10, 10]).guide();
        fix(seed.start(), [-10, -10]);
        fix(seed.end(), [10, 10]);
      });
      const s = split(seed) as unknown as Split;

      render();

      const pieces = s.getShapes();
      expect(pieces.length).toBe(2);
      const plane = s.getPlane();
      expect(Math.abs(plane.normal.z)).toBeLessThan(1e-9);
      expect(Math.abs(plane.normal.x)).toBeCloseTo(Math.SQRT1_2, 9);
      expect(Math.abs(plane.normal.y)).toBeCloseTo(Math.SQRT1_2, 9);
      expect(volume(pieces[0]) + volume(pieces[1])).toBeCloseTo(40 * 30 * 10, 3);
    });

    it("cuts along a line of a sketch on a side face", () => {
      box();
      let seed: any;
      // A sketch on the front face (y = -15) of the box, with a horizontal
      // line at height 3 — the plane it sweeps is z = 3.
      sketch(select(face().onPlane('xz', -15)), () => {
        seed = line([-30, 3], [30, 3]).guide();
        horizontal(seed);
        fix(seed.start(), [-30, 3]);
        distance(seed.start(), seed.end(), 60);
      });
      const s = split(seed) as unknown as Split;

      render();

      const pieces = s.getShapes();
      expect(pieces.length).toBe(2);
      const zs = pieces.map(p => ShapeOps.getBoundingBox(p)).map(b => [b.minZ, b.maxZ]).flat().sort((a, b) => a - b);
      expect(zs[0]).toBeCloseTo(0, 5);
      expect(zs[1]).toBeCloseTo(3, 5);
      expect(zs[2]).toBeCloseTo(3, 5);
      expect(zs[3]).toBeCloseTo(10, 5);
    });

    it("keeps one side of the seeded plane", () => {
      box();
      let seed: any;
      sketch("xy", () => {
        seed = line([0, -40], [0, 40]).guide();
        vertical(seed);
        fix(seed.start(), [0, -40]);
        distance(seed.start(), seed.end(), 80);
      });
      const s = split(seed, { keep: 'back' }) as unknown as Split;

      render();

      const pieces = s.getShapes();
      expect(pieces.length).toBe(1);
      expect(ShapeOps.getBoundingBox(pieces[0]).maxX).toBeCloseTo(0, 5);
      expect(ShapeOps.getBoundingBox(pieces[0]).minX).toBeCloseTo(-20, 0);
    });

    it("cuts along an arc's curved sheet, front to the right of the arc", () => {
      const e = box();
      let seed: any;
      // An arc bulging into the box from the left, drawn bottom to top: it
      // crosses the top and bottom faces near x = 14.5 and reaches x = 16.6
      // at y = 0. Travelled from the sketch's front its right is +x.
      sketch("xy", () => {
        seed = arc([0, -40], [0, 40], [-40, 0]).guide();
        fix(seed.start(), [0, -40]);
        fix(seed.end(), [0, 40]);
        fix(seed.center(), [-40, 0]);
      });
      const s = split(seed) as unknown as Split;

      const scene = render();

      const pieces = s.getShapes();
      expect(pieces.length).toBe(2);
      expect(pieces.every(p => p.isSolid())).toBe(true);
      const front = ShapeOps.getBoundingBox(pieces[0]);
      const back = ShapeOps.getBoundingBox(pieces[1]);
      // Curved pieces carry the kernel's loose curve bounds (a few hundredths).
      expect(front.minX).toBeCloseTo(14.5, 0);
      expect(front.maxX).toBeCloseTo(20, 1);
      expect(back.minX).toBeCloseTo(-20, 1);
      expect(back.maxX).toBeCloseTo(16.6, 0);
      expect(volume(pieces[0]) + volume(pieces[1])).toBeCloseTo(40 * 30 * 10, 2);
      // A sheet has no plane; the cut reports itself as one.
      expect(s.getPlane()).toBeNull();
      expect(s.getCutKind()).toBe('sheet');
      expect(e.getShapes().length).toBe(0);
      expect(sceneSolids(scene).length).toBe(2);
      expect(s.getError()).toBeNull();
      expectDisplayConsumed(scene, (seed as SceneObject).getParent()!);
    });

    it("keeps the outside of a counter-clockwise circle as its front", () => {
      box();
      let seed: any;
      sketch("xy", () => {
        seed = circle([0, 0], 20).guide();
        fix(seed.center(), [0, 0]);
      });
      const s = split(seed, { keep: 'front' }) as unknown as Split;

      render();

      const pieces = s.getShapes();
      expect(pieces.length).toBe(1);
      // The plate minus the core the circle's sheet cored out of it.
      expect(volume(pieces[0])).toBeCloseTo(40 * 30 * 10 - Math.PI * 10 * 10 * 10, 1);
      expect(ShapeOps.getBoundingBox(pieces[0]).minX).toBeCloseTo(-20, 1);
    });

    it("splits along every edge of a rect, its inside being the back", () => {
      box();
      let seed: any;
      sketch("xy", () => {
        seed = rect([-5, -5], 10, 10).guide();
      });
      const s = split(seed, { keep: 'back' }) as unknown as Split;

      render();

      const pieces = s.getShapes();
      expect(pieces.length).toBe(1);
      expect(volume(pieces[0])).toBeCloseTo(10 * 10 * 10, 3);
      const bbox = ShapeOps.getBoundingBox(pieces[0]);
      expect(bbox.minX).toBeCloseTo(-5, 5);
      expect(bbox.maxX).toBeCloseTo(5, 5);
    });

    it("cuts along a bezier's sheet", () => {
      box();
      let seed: any;
      // An S-curve from below the box to above it, crossing it once.
      sketch("xy", () => {
        seed = bezier([-5, -40], [-25, 0], [25, 0], [5, 40]).guide();
      });
      const s = split(seed) as unknown as Split;

      render();

      const pieces = s.getShapes();
      expect(pieces.length).toBe(2);
      expect(volume(pieces[0]) + volume(pieces[1])).toBeCloseTo(40 * 30 * 10, 2);
      expect(s.getCutKind()).toBe('sheet');
      expect(s.getError()).toBeNull();
    });

    it("leaves a solid untouched when the curve stops inside it", () => {
      const e = box();
      let seed: any;
      sketch("xy", () => {
        seed = arc([-10, 0], [10, 0], [0, 0]).guide();
        fix(seed.start(), [-10, 0]);
        fix(seed.end(), [10, 0]);
        fix(seed.center(), [0, 0]);
      });
      const s = split(seed) as unknown as Split;

      const scene = render();

      expect(s.getShapes().length).toBe(0);
      expect(e.getShapes().length).toBe(1);
      expect(sceneSolids(scene).length).toBe(1);
      expect(s.getError()).toContain("passes through none of the solids");
    });
  });

  describe("repeated", () => {
    /** The scene's solids, by their min x. */
    function piecesByX(scene: ReturnType<typeof render>): Shape[] {
      // Containers (the repeat) hand out their children's solids again.
      const all = new Set(scene.getAllSceneObjects());
      const solids = scene.getAllSceneObjects().filter(o => !o.isContainer()).flatMap(o => o.getShapes({}, 'solid', all));
      return solids.sort((a, b) => ShapeOps.getBoundingBox(a).minX - ShapeOps.getBoundingBox(b).minX);
    }

    function expectSpan(shape: Shape, minX: number, maxX: number): void {
      const bbox = ShapeOps.getBoundingBox(shape);
      expect(bbox.minX).toBeCloseTo(minX, 5);
      expect(bbox.maxX).toBeCloseTo(maxX, 5);
    }

    it("a mirror repeat re-cuts the target's pieces at the mirrored plane instead of rebuilding the body", () => {
      const e = box();
      const s = split(plane('yz', 10), e) as unknown as Split;
      const r = repeat('mirror', 'yz', s) as unknown as RepeatBase;

      const scene = render();

      // The target names a body to read live, not a chain to clone: the box
      // was extruded once, and the instance cut the original split's pieces.
      expect(scene.getAllSceneObjects().filter(o => o instanceof ExtrudeBase).length).toBe(1);
      const pieces = piecesByX(scene);
      expect(pieces.length).toBe(3);
      expectSpan(pieces[0], -20, -10);
      expectSpan(pieces[1], -10, 10);
      expectSpan(pieces[2], 10, 20);

      const clone = r.getInstanceRoots(1)[0] as Split;
      expect(clone.getShapes().length).toBe(2);
      expect(clone.getPlane()!.origin.x).toBeCloseTo(-10, 9);
      expect(clone.getPlane()!.normal.x).toBeCloseTo(-1, 9);
    });

    it("a mirrored split with no targets cuts the bodies in scope, not its instance's other clones", () => {
      box();
      split(plane('yz', 10));
      repeat('mirror', 'yz');

      const scene = render();

      const pieces = piecesByX(scene);
      expect(pieces.length).toBe(3);
      expectSpan(pieces[0], -20, -10);
      expectSpan(pieces[1], -10, 10);
      expectSpan(pieces[2], 10, 20);
    });

    it("a mirrored split seeded by a sketched line cuts at the line's image without cloning the sketch", () => {
      box();
      let seed: any;
      sketch("xy", () => {
        seed = line([6, -40], [6, 40]).guide();
        vertical(seed);
        fix(seed.start(), [6, -40]);
        distance(seed.start(), seed.end(), 80);
      });
      const s = split(seed) as unknown as Split;
      const r = repeat('mirror', 'yz', s) as unknown as RepeatBase;

      const scene = render();

      // The box profile and the seed sketch: the repeat moved the seed, not the sketch.
      expect(scene.getAllSceneObjects().filter(o => o instanceof Sketch).length).toBe(2);
      const pieces = piecesByX(scene);
      expect(pieces.length).toBe(3);
      expectSpan(pieces[0], -20, -6);
      expectSpan(pieces[1], -6, 6);
      expectSpan(pieces[2], 6, 20);

      // The plane moves with its normal: the instance's front is the image
      // of the original's (+x), so it points to -x.
      const clone = r.getInstanceRoots(1)[0] as Split;
      expect(clone.getPlane()!.origin.x).toBeCloseTo(-6, 9);
      expect(clone.getPlane()!.normal.x).toBeCloseTo(-1, 9);
    });

    it("a mirrored split keeps the image of the side the original keeps", () => {
      box();
      let seed: any;
      sketch("xy", () => {
        seed = line([6, -40], [6, 40]).guide();
        vertical(seed);
        fix(seed.start(), [6, -40]);
        distance(seed.start(), seed.end(), 80);
      });
      // The original keeps x < 6; its image keeps x > -6.
      split(seed, { keep: 'back' });
      repeat('mirror', 'yz');

      const scene = render();

      const pieces = piecesByX(scene);
      expect(pieces.length).toBe(1);
      expectSpan(pieces[0], -6, 6);
    });

    it("a mirrored split along a sheet keeps the sheet's front on the image side", () => {
      box();
      let seed: any;
      // The arc of the sheet test above: it crosses the box between x = 14.5
      // (top and bottom faces) and 16.6 (at y = 0), its front +x.
      sketch("xy", () => {
        seed = arc([0, -40], [0, 40], [-40, 0]).guide();
        fix(seed.start(), [0, -40]);
        fix(seed.end(), [0, 40]);
        fix(seed.center(), [-40, 0]);
      });
      const s = split(seed) as unknown as Split;
      const r = repeat('mirror', 'yz', s) as unknown as RepeatBase;

      render();

      expect(s.getCutKind()).toBe('sheet');
      // The original's sliver lies beyond x = 14.5; the image took its other piece.
      expect(s.getShapes().length).toBe(1);
      expect(ShapeOps.getBoundingBox(s.getShapes()[0]).minX).toBeCloseTo(14.54, 1);

      // The image's front is the image of the original's: its sliver lies
      // beyond x = -14.5, and the middle piece spans the two cuts.
      const clone = r.getInstanceRoots(1)[0] as Split;
      expect(clone.getCutKind()).toBe('sheet');
      const pieces = clone.getShapes();
      expect(pieces.length).toBe(2);
      expect(ShapeOps.getBoundingBox(pieces[0]).maxX).toBeCloseTo(-14.54, 1);
      expect(ShapeOps.getBoundingBox(pieces[0]).minX).toBeCloseTo(-20, 0);
      expect(ShapeOps.getBoundingBox(pieces[1]).minX).toBeCloseTo(-16.57, 1);
      expect(ShapeOps.getBoundingBox(pieces[1]).maxX).toBeCloseTo(16.57, 1);
    });
  });

  describe("argument errors", () => {
    it("rejects a bad keep value", () => {
      box();
      expect(() => split("yz", { keep: 'left' } as any)).toThrow(/keep must be/);
    });

    it("points an offset option at the plane itself", () => {
      box();
      expect(() => split("yz", { offset: 5 } as any)).toThrow(/no offset option/);
    });

    it("rejects an unknown option", () => {
      box();
      expect(() => split("yz", { flip: true } as any)).toThrow(/unknown option 'flip'/);
    });

    it("rejects a cut that is neither a plane nor a line", () => {
      box();
      expect(() => split(42 as any)).toThrow(/first argument is the cut/);
    });

    it("rejects a non-feature target", () => {
      box();
      expect(() => split("yz", 'body' as any)).toThrow(/target 1 is not a feature/);
    });

    it("is not available inside a sketch", () => {
      expect(() => {
        sketch("xy", () => {
          testRect(10, 10);
          split("yz");
        });
      }).toThrow(/inside a sketch/);
    });
  });
});
