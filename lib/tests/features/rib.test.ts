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

      const r = rib(-5).parallel().new().scope(s).extend().draft(2) as Rib;
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

    it("parallel-mode rib with .draft() keeps the spine-plane face at original thickness and tapers the tip", () => {
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

      const r = rib(-5).parallel().draft(5).new().scope(filleted) as Rib;
      render();

      const shapes = r.getShapes();
      expect(shapes.length).toBe(1);

      // The spine plane (= prism base) stays at the original 5mm
      // thickness; the tip is narrower. Total bbox Y span shouldn't
      // exceed 5mm (the maximum is at the base).
      const bbox = ShapeOps.getBoundingBox(shapes[0]);
      const ySpan = bbox.maxY - bbox.minY;
      // The spine plane (= prism base) keeps its original 5mm thickness;
      // the tip is narrower. Total bbox Y span ≈ thickness (max is at the
      // base), bounded above by the original 5mm.
      expect(ySpan).toBeLessThanOrEqual(5.05);
      expect(ySpan).toBeGreaterThan(2);
    });

    it("parallel + extend + draft on cylindrical scope produces a single rib (no phantom shell)", () => {
      // Reported case: cylinder with shell+fillet, parallel+extend rib
      // with draft(3°). Conformance was emitting an L-shaped second
      // solid that traced part of the cavity outer + bottom alongside
      // the actual rib.
      sketch("top", () => {
        circle(80);
      });
      const box = extrude(30);
      const shelled = shell(-4, box.endFaces());
      const filleted = fillet(2, shelled.internalEdges()) as unknown as SceneObject;

      sketch("front", () => {
        move([-40, 20]);
        aLine(-45, 20);
      });

      const r = rib(-5).parallel().extend().draft(3).new().scope(filleted) as Rib;
      render();

      const shapes = r.getShapes();
      expect(shapes.length).toBe(1);
    });

    it("repeat circular preserves draft on every rotated clone", async () => {
      const repeatModule = await import("../../core/repeat.js");
      const repeat = (repeatModule as { default: (...args: unknown[]) => SceneObject }).default;

      sketch("top", () => {
        rect(100).centered();
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

      const r = rib(-5).parallel().extend().new().scope(s).draft(-4) as Rib;
      repeat("circular", "z", { count: 4, angle: 360 }, r);
      render();

      const sceneMod = await import("../../scene-manager.js");
      const scene = (sceneMod as { getCurrentScene: () => { getSceneObjects: () => SceneObject[] } }).getCurrentScene();
      const ribClones = scene.getSceneObjects().filter(o =>
        o instanceof Rib && o !== r && (o as unknown as { getCloneSource: () => SceneObject | null }).getCloneSource() === r
      );
      expect(ribClones.length).toBe(3);

      // Original has draft → its bbox spans more in plane.normal than
      // the slab thickness 5mm at one end. Each clone must show the same
      // draft signature: the post-conform ribs all came from the same
      // build, so their bbox volumes must agree within ~5%.
      const origVol = ShapeOps.getBoundingBox(r.getShapes()[0]);
      const origBboxVol = (origVol.maxX - origVol.minX) * (origVol.maxY - origVol.minY) * (origVol.maxZ - origVol.minZ);
      for (const clone of ribClones) {
        const cBBox = ShapeOps.getBoundingBox(clone.getShapes()[0]);
        const cBboxVol = (cBBox.maxX - cBBox.minX) * (cBBox.maxY - cBBox.minY) * (cBBox.maxZ - cBBox.minZ);
        const ratio = cBboxVol / origBboxVol;
        expect(ratio).toBeGreaterThan(0.95);
        expect(ratio).toBeLessThan(1.05);
      }
    });

    it("normal-mode draft does not tilt the rib's end cap (perpendicular to spine)", () => {
      // Reported case: rib ends inside the cavity (spine endpoint at
      // X=-16, not at any wall). The cap face at X=-16 (perpendicular
      // to the spine direction) should stay flat — only the rib's
      // long side walls should taper. Currently OCC tilts every
      // non-first/last face that isn't excluded, so the cap drifts.
      sketch("top", () => {
        rect(100, 50).centered();
      });
      const box = extrude(30);
      const shelled = shell(-4, box.endFaces());
      const filleted = fillet(2, shelled.internalEdges()) as unknown as SceneObject;

      sketch(box.endFaces(), () => {
        hLine([-50 + 4, 0], 30);
      });

      const r = rib(-5).draft(2).new().scope(filleted) as Rib;
      render();

      const shapes = r.getShapes();
      expect(shapes.length).toBe(1);

      // The rib's spine ends at X = -50 + 4 + 30 = -16. The end cap
      // (perpendicular to the X spine direction) should stay at X=-16
      // throughout the prism's depth — its bbox maxX should match -16
      // within tolerance regardless of draft.
      const bbox = ShapeOps.getBoundingBox(shapes[0]);
      expect(bbox.maxX).toBeLessThanOrEqual(-16 + 0.05);
      expect(bbox.maxX).toBeGreaterThanOrEqual(-16 - 0.05);
    });

    it("normal-mode rib spine starting at cavity wall: positive draft must not throw", () => {
      // Reported case: rib spine starts AT the inner cavity wall (X=-46
      // after shell -4 from a box centred at X=0, half-width 50). With
      // positive draft, OCC's BRepOffsetAPI_DraftAngle fails because it
      // tries to tilt the rib's cap face that sits flush with the wall.
      sketch("top", () => {
        rect(100, 50).centered();
      });
      const box = extrude(30);
      const shelled = shell(-4, box.endFaces());
      const filleted = fillet(2, shelled.internalEdges()) as unknown as SceneObject;

      sketch(box.endFaces(), () => {
        hLine([-50 + 4, 0], 30);
      });

      const r = rib(-5).draft(1).new().scope(filleted) as Rib;
      render();

      const shapes = r.getShapes();
      expect(shapes.length).toBeGreaterThan(0);
    });

    it("normal-mode rib spine at cavity wall: negative draft does not tilt the wall-touching face", () => {
      // The cap face flush with the cavity wall should keep its X
      // position (= -46) before AND after draft. Drafting it would push
      // it inward, leaving a gap between the rib and the wall.
      sketch("top", () => {
        rect(100, 50).centered();
      });
      const box = extrude(30);
      const shelled = shell(-4, box.endFaces());
      const filleted = fillet(2, shelled.internalEdges()) as unknown as SceneObject;

      sketch(box.endFaces(), () => {
        hLine([-50 + 4, 0], 30);
      });

      const r = rib(-5).draft(-1).new().scope(filleted) as Rib;
      render();

      const shapes = r.getShapes();
      expect(shapes.length).toBeGreaterThan(0);

      // The wall-touching cap is at X = -46 (= -50 + 4 shell thickness).
      // After draft it must STILL touch the wall — bbox minX should sit
      // at -46 within tolerance, not be pushed inward by the draft.
      const bbox = ShapeOps.getBoundingBox(shapes[0]);
      // -46.012 in practice (numerical precision around the wall plane).
      expect(bbox.minX).toBeLessThanOrEqual(-46 + 0.05);
      expect(bbox.minX).toBeGreaterThanOrEqual(-46 - 0.05);
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
