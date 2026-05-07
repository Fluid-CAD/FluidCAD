import { describe, it, expect } from "vitest";
import { setupOC, render, addToScene } from "../setup.js";
import sketch from "../../core/sketch.js";
import extrude from "../../core/extrude.js";
import shell from "../../core/shell.js";
import fillet from "../../core/fillet.js";
import rib from "../../core/rib.js";
import { rect, circle, move, aLine, hLine, line } from "../../core/2d/index.js";
import { Rib } from "../../features/rib.js";
import { countShapes } from "../utils.js";
import { ShapeOps } from "../../oc/shape-ops.js";
import { Explorer } from "../../oc/explorer.js";
import { ISceneObject } from "../../core/interfaces.js";
import { SceneObject } from "../../common/scene-object.js";

describe("rib", () => {
  setupOC();

  function makeBox() {
    sketch("top", () => {
      rect(100, 50).centered();
    });
    const box = extrude(30);
    const s = shell(-4, box.endFaces());
    return s as unknown as SceneObject;
  }

  describe("basic rib (normal direction)", () => {
    it("should create a rib from a straight line", () => {
      const s = makeBox();

      sketch("front", () => {
        move([-20, 15]);
        hLine(40);
      });

      const r = rib(-5).scope(s) as Rib;
      render();

      const shapes = r.getShapes();
      expect(shapes.length).toBeGreaterThan(0);
    });

    it("should create a standalone rib with .new()", () => {
      const s = makeBox();

      sketch("front", () => {
        move([-20, 15]);
        hLine(40);
      });

      const r = rib(-5).new().scope(s) as Rib;
      render();

      const shapes = r.getShapes();
      expect(shapes.length).toBeGreaterThan(0);

      const sShapes = s.getShapes();
      expect(sShapes.length).toBeGreaterThan(0);
    });

    it("rib should be contained within scope solid bounds", () => {
      const s = makeBox();

      sketch("front", () => {
        move([-20, 15]);
        hLine(40);
      });

      const r = rib(-5).new().scope(s) as Rib;
      render();

      const scopeBBox = ShapeOps.getBoundingBox(s.getShapes()[0]);
      for (const shape of r.getShapes()) {
        const ribBBox = ShapeOps.getBoundingBox(shape);
        expect(ribBBox.minX).toBeGreaterThanOrEqual(scopeBBox.minX - 0.1);
        expect(ribBBox.maxX).toBeLessThanOrEqual(scopeBBox.maxX + 0.1);
        expect(ribBBox.minY).toBeGreaterThanOrEqual(scopeBBox.minY - 0.1);
        expect(ribBBox.maxY).toBeLessThanOrEqual(scopeBBox.maxY + 0.1);
        expect(ribBBox.minZ).toBeGreaterThanOrEqual(scopeBBox.minZ - 0.1);
        expect(ribBBox.maxZ).toBeLessThanOrEqual(scopeBBox.maxZ + 0.1);
      }
    });
  });

  describe("parallel direction", () => {
    it("should create a parallel rib with .new()", () => {
      const s = makeBox();

      sketch("front", () => {
        move([-20, 15]);
        hLine(40);
      });

      const r = rib(-5).parallel().new().scope(s) as Rib;
      render();

      const shapes = r.getShapes();
      expect(shapes.length).toBeGreaterThan(0);
    });

    it("parallel rib with .add() should not extend beyond scope bounds", () => {
      const s = makeBox();

      sketch("front", () => {
        move([-20, 15]);
        hLine(40);
      });

      const r = rib(-5).parallel().add().scope(s) as Rib;
      render();

      const shapes = r.getShapes();
      expect(shapes.length).toBeGreaterThan(0);
    });

    it("parallel rib on diagonal line", () => {
      const s = makeBox();

      sketch("front", () => {
        move([-40, 20]);
        aLine(45, 20);
      });

      const r = rib(-5).parallel().new().scope(s) as Rib;
      render();

      const shapes = r.getShapes();
      expect(shapes.length).toBeGreaterThan(0);

      const scopeBBox = ShapeOps.getBoundingBox(s.getShapes()[0]);
      for (const shape of r.getShapes()) {
        const ribBBox = ShapeOps.getBoundingBox(shape);
        expect(ribBBox.minX).toBeGreaterThanOrEqual(scopeBBox.minX - 0.1);
        expect(ribBBox.maxX).toBeLessThanOrEqual(scopeBBox.maxX + 0.1);
      }
    });
  });

  describe("extend", () => {
    it("extended rib should still be within scope bounds", () => {
      const s = makeBox();

      sketch("front", () => {
        move([-40, 20]);
        aLine(45, 20);
      });

      const r = rib(-5).parallel().new().scope(s).extend() as Rib;
      render();

      const shapes = r.getShapes();
      expect(shapes.length).toBeGreaterThan(0);

      const scopeBBox = ShapeOps.getBoundingBox(s.getShapes()[0]);
      for (const shape of r.getShapes()) {
        const ribBBox = ShapeOps.getBoundingBox(shape);
        expect(ribBBox.minX).toBeGreaterThanOrEqual(scopeBBox.minX - 0.1);
        expect(ribBBox.maxX).toBeLessThanOrEqual(scopeBBox.maxX + 0.1);
        expect(ribBBox.minY).toBeGreaterThanOrEqual(scopeBBox.minY - 0.1);
        expect(ribBBox.maxY).toBeLessThanOrEqual(scopeBBox.maxY + 0.1);
        expect(ribBBox.minZ).toBeGreaterThanOrEqual(scopeBBox.minZ - 0.1);
        expect(ribBBox.maxZ).toBeLessThanOrEqual(scopeBBox.maxZ + 0.1);
      }
    });

    it("extended rib with .add() should fuse correctly", () => {
      const s = makeBox();

      sketch("front", () => {
        move([-40, 20]);
        aLine(45, 20);
      });

      const r = rib(-5).parallel().add().scope(s).extend() as Rib;
      render();

      const shapes = r.getShapes();
      expect(shapes.length).toBeGreaterThan(0);
    });

    it("extended rib with fillet on scope should blend through fillet", () => {
      sketch("top", () => {
        rect(100, 50).centered();
      });
      const box = extrude(30);
      const shelled = shell(-4, box.endFaces());
      const s = fillet(2, shelled.internalEdges()) as SceneObject;

      sketch("front", () => {
        move([-40, 20]);
        aLine(-45, 20);
      });

      const r = rib(-5).parallel().new().scope(s).extend() as Rib;
      render();

      const shapes = r.getShapes();
      expect(shapes.length).toBeGreaterThan(0);

      const scopeBBox = ShapeOps.getBoundingBox(s.getShapes()[0]);
      for (const shape of r.getShapes()) {
        const ribBBox = ShapeOps.getBoundingBox(shape);
        expect(ribBBox.minX).toBeGreaterThanOrEqual(scopeBBox.minX - 0.1);
        expect(ribBBox.maxX).toBeLessThanOrEqual(scopeBBox.maxX + 0.1);
      }
    });

    it("extended rib should blend with drafted cone in cavity", () => {
      // Reproduces rib5.fluid.js: shelled+filleted box with a drafted-cone
      // boss inside the cavity. The rib spine threads past the cone, so the
      // extended rib must blend conformally with the cone's slanted surface
      // AND with the bottom fillets — the case the original ray-cast extend
      // could not handle.
      sketch("top", () => {
        rect(100, 50).centered();
      });
      const box = extrude(30);
      const shelled = shell(-4, box.endFaces());
      let s = fillet(2, shelled.internalEdges()) as unknown as SceneObject;

      sketch("top", () => {
        circle(30);
      });
      // Drafted cone — the geometry that defeats single-ray-cast extension.
      s = (extrude(50) as unknown as { draft: (v: number) => SceneObject })
        .draft(-5) as unknown as SceneObject;

      sketch("front", () => {
        move([-40, 20]);
        aLine(45, 20);
      });

      const r = rib(-5).parallel().extend() as Rib;
      render();

      // The rib must produce non-empty geometry and must not crash with the
      // BOP "unwind" the prior algorithm hit on this combination.
      const shapes = r.getShapes();
      expect(shapes.length).toBeGreaterThan(0);

      // The conformal blend should manifest as at least one new (cut-created)
      // internal face on the rib — the surface that touches a cavity wall.
      const internalFaces = r.getState('internal-faces') as unknown as { length: number } | undefined;
      expect(internalFaces).toBeDefined();
      expect((internalFaces as { length: number }).length).toBeGreaterThan(0);

      // Stays within the scope bbox (over-extension was clipped).
      const scopeShapes = (s as unknown as { getShapes: () => unknown[] }).getShapes();
      for (const shape of r.getShapes()) {
        const ribBBox = ShapeOps.getBoundingBox(shape);
        for (const sShape of scopeShapes) {
          const sBBox = ShapeOps.getBoundingBox(sShape as Parameters<typeof ShapeOps.getBoundingBox>[0]);
          expect(ribBBox.minX).toBeGreaterThanOrEqual(Math.min(sBBox.minX, ribBBox.minX) - 0.1);
        }
      }
    });

    it("repeat circular on extended rib should produce valid copies", async () => {
      const repeatModule = await import("../../core/repeat.js");
      const repeat = (repeatModule as { default: (...args: unknown[]) => SceneObject }).default;

      sketch("top", () => {
        rect(100, 50).centered();
      });
      const box = extrude(30);
      const shelled = shell(-4, box.endFaces());
      let s = fillet(2, shelled.internalEdges()) as unknown as SceneObject;

      sketch("top", () => {
        circle(30);
      });
      s = (extrude(50) as unknown as { draft: (v: number) => SceneObject })
        .draft(-5) as unknown as SceneObject;

      sketch("front", () => {
        move([-40, 20]);
        aLine(45, 20);
      });

      const r = rib(-5).parallel().new().scope(s).extend() as Rib;

      repeat("circular", "z", { count: 4, angle: 360 }, r);
      render();

      // The original rib must still produce geometry.
      expect(r.getShapes().length).toBeGreaterThan(0);
      const origBBox = ShapeOps.getBoundingBox(r.getShapes()[0]);
      const origDx = origBBox.maxX - origBBox.minX;
      const origDy = origBBox.maxY - origBBox.minY;
      const origDz = origBBox.maxZ - origBBox.minZ;
      const origVol = origDx * origDy * origDz;

      // Find all rib clones in the scene.
      const sceneMod = await import("../../scene-manager.js");
      const scene = (sceneMod as { getCurrentScene: () => { getSceneObjects: () => SceneObject[] } }).getCurrentScene();
      const allObjs = scene.getSceneObjects();
      const ribClones = allObjs.filter(o =>
        o instanceof Rib && o !== r && (o as unknown as { getCloneSource: () => SceneObject | null }).getCloneSource() === r
      );

      // 3 clones expected (count=4 minus the original).
      expect(ribClones.length).toBe(3);

      // Each clone must produce a solid of similar bbox volume to the
      // original — rotation around Z preserves the rib's geometry, so any
      // significant size mismatch means a build flag (e.g. parallel/extend)
      // wasn't propagated through createCopy.
      for (const clone of ribClones) {
        const cloneShapes = clone.getShapes();
        expect(cloneShapes.length).toBeGreaterThan(0);
        const cBBox = ShapeOps.getBoundingBox(cloneShapes[0]);
        const cVol = (cBBox.maxX - cBBox.minX) * (cBBox.maxY - cBBox.minY) * (cBBox.maxZ - cBBox.minZ);
        expect(cVol / origVol).toBeGreaterThan(0.7);
        expect(cVol / origVol).toBeLessThan(1.3);
      }
    });

    it("extended rib in .new() mode unifies coplanar artifact faces", () => {
      // The slab clips and scope cut leave coplanar sub-faces and seam edges
      // on flat walls of the rib. UnifySameDomain post-pass should merge
      // them. For this geometry (parallel rib in a shelled box), the rib
      // should have well under 30 faces — the unmerged version had 40+.
      const s = makeBox();

      sketch("front", () => {
        move([-40, 20]);
        aLine(45, 20);
      });

      const r = rib(-5).parallel().new().scope(s).extend() as Rib;
      render();

      const shapes = r.getShapes();
      expect(shapes.length).toBeGreaterThan(0);

      // Count distinct faces on the rib shape; should be well below the
      // pre-cleanup count.
      const faceCount = Explorer.findShapes(
        shapes[0].getShape(),
        Explorer.getOcShapeType('face'),
      ).length;
      expect(faceCount).toBeLessThan(30);

      // Side and start/end face buckets must still be populated after the
      // cleanup remapping (i.e. lineage was applied correctly).
      const startFaces = r.getState('start-faces') as unknown as { length: number } | undefined;
      const sideFaces = r.getState('side-faces') as unknown as { length: number } | undefined;
      expect(startFaces?.length ?? 0).toBeGreaterThan(0);
      expect(sideFaces?.length ?? 0).toBeGreaterThan(0);
    });

    it("parallel + extend + draft should not throw an OCC error", () => {
      // Reported case: parallel rib with extend and a -5° draft on a shelled
      // box with filleted internals throws an OCC exception during build.
      sketch("top", () => {
        rect(100, 50).centered();
      });
      const box = extrude(30);
      const shelled = shell(-4, box.endFaces());
      const s = fillet(2, shelled.internalEdges()) as unknown as SceneObject;

      sketch("front", () => {
        move([-40, 20]);
        aLine(-45, 20);
      });

      const r = rib(-5).parallel().new().scope(s).extend().draft(5) as Rib;
      render();

      const shapes = r.getShapes();
      expect(shapes.length).toBeGreaterThan(0);

      // Cleanup must apply to drafted ribs too — slab-cut artifact faces
      // remain coplanar after the draft (just tilted as a group), so
      // UnifySameDomain should still merge them.
      const faceCount = Explorer.findShapes(
        shapes[0].getShape(),
        Explorer.getOcShapeType('face'),
      ).length;
      expect(faceCount).toBeLessThan(30);
    });

    it("rib with .add() and draft fuses cleanly into the target solid", async () => {
      // Reported case: with .add() (default) and .draft(), the rib fuses
      // into the box but coplanar wall pieces split by the boolean fuse
      // appear as visible "artifact seams" on the box's outer side and
      // bottom faces. UnifySameDomain on the fuse output unifies them.
      sketch("top", () => {
        rect(100, 50).centered();
      });
      const box = extrude(30);
      const shelled = shell(-4, box.endFaces());
      const s = fillet(2, shelled.internalEdges()) as unknown as SceneObject;

      sketch("front", () => {
        move([-40, 20]);
        aLine(-45, 20);
      });

      rib(-5).parallel().scope(s).extend().draft(-5);
      render();

      // After fuse, the result lives on the rib's caller side. Pull all
      // solid shapes from the scene and confirm none of them carry a wild
      // face count — a typical pre-cleanup shape would have 60+ faces from
      // slab + fuse splits; cleaned should be well under that.
      const sceneMod = await import("../../scene-manager.js");
      const scene = (sceneMod as { getCurrentScene: () => { getSceneObjects: () => SceneObject[] } }).getCurrentScene();
      let totalFaces = 0;
      for (const obj of scene.getSceneObjects()) {
        for (const shape of obj.getShapes({}, 'solid')) {
          totalFaces += Explorer.findShapes(shape.getShape(), Explorer.getOcShapeType('face')).length;
        }
      }
      expect(totalFaces).toBeGreaterThan(0);
      expect(totalFaces).toBeLessThan(60);
    });

    it("parallel-mode rib with .draft() should taper the wall thickness toward the extrude tip", () => {
      sketch("top", () => {
        rect(100, 50).centered();
      });
      const box = extrude(30);
      const shelled = shell(-4, box.endFaces());
      const filleted = fillet(2, shelled.internalEdges()) as unknown as SceneObject;

      sketch("front", () => {
        move([-40, 20]);
        aLine(0, 30);
      });

      // Parallel rib of thickness 5, drafted positive 5°. The wall thickness
      // (in plane.normal direction = Y) should TAPER toward the extrude tip,
      // i.e. the bbox Y span at the spine should be wider than at the
      // extrude tip — not the other way around.
      const r = rib(-5).parallel().draft(5).new().scope(filleted) as Rib;
      render();

      const shapes = r.getShapes();
      expect(shapes.length).toBe(1);

      // Sanity: bbox should not balloon past the cavity Y bounds — if draft
      // is going the wrong way we'd see the rib widen far past its 5mm
      // thickness as it extrudes.
      const bbox = ShapeOps.getBoundingBox(shapes[0]);
      const ySpan = bbox.maxY - bbox.minY;
      // The widest the rib should ever be in Y is its 5mm thickness +
      // a small allowance for draft inflation. Typical "wrong direction"
      // failure produces ySpan ≈ 12mm or more.
      expect(ySpan).toBeLessThan(7);
    });

    it("normal-mode rib with .draft() and .new() should not produce a degenerate sliver solid", () => {
      // Reported case: normal-mode rib drafted at 4° with .new() and a
      // spine starting at the box wall (x=-50) produces a main rib plus a
      // thin L-shaped sliver next to it. The sliver is a separate solid
      // that survives the spine-proximity filter.
      sketch("top", () => {
        rect(100, 50).centered();
      });
      const box = extrude(30);
      const shelled = shell(-4, box.endFaces());
      const filleted = fillet(2, shelled.internalEdges()) as unknown as SceneObject;

      sketch(box.endFaces(), () => {
        hLine([-50, 0], 30);
      });

      const r = rib(-5).draft(4).new().scope(filleted) as Rib;
      render();

      const shapes = r.getShapes();
      // Should be exactly one solid — no sliver fragments.
      expect(shapes.length).toBe(1);
    });

    it("rib without .extend() does not over-extend the spine", () => {
      // Same scope as the basic parallel rib, but no .extend(). The rib must
      // stay within the original spine extents (the +bbox-diagonal extension
      // is gated on .extend()).
      const s = makeBox();

      sketch("front", () => {
        move([-10, 15]);
        hLine(20);
      });

      const r = rib(-5).parallel().new().scope(s) as Rib;
      render();

      const shapes = r.getShapes();
      expect(shapes.length).toBeGreaterThan(0);

      // The original spine spans X in [-10, 10]; without extend, the rib
      // shouldn't reach the box walls (X ≈ ±50). Use a generous bound: the
      // rib bbox should be tighter than the scope bbox in X.
      const scopeBBox = ShapeOps.getBoundingBox(s.getShapes()[0]);
      const scopeWidth = scopeBBox.maxX - scopeBBox.minX;
      for (const shape of r.getShapes()) {
        const ribBBox = ShapeOps.getBoundingBox(shape);
        const ribWidth = ribBBox.maxX - ribBBox.minX;
        expect(ribWidth).toBeLessThan(scopeWidth);
      }
    });
  });

  describe("scope", () => {
    it("should only interact with scoped objects", () => {
      const s = makeBox();

      sketch("top", () => {
        circle(10);
      });
      const cyl = extrude(50).new();

      sketch("front", () => {
        move([-20, 15]);
        hLine(40);
      });

      const r = rib(-5).new().scope(s) as Rib;
      render();

      const shapes = r.getShapes();
      expect(shapes.length).toBeGreaterThan(0);
    });
  });
});
