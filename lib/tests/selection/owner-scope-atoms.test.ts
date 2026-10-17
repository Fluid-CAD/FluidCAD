import { describe, it, expect } from "vitest";
import { setupOC, render } from "../setup.js";
import sketch from "../../core/sketch.js";
import extrude from "../../core/extrude.js";
import fillet from "../../core/fillet.js";
import select from "../../core/select.js";
import { edge } from "../../filters/index.js";
import { Scene } from "../../rendering/scene.js";
import { Shape } from "../../common/shape.js";
import { Explorer } from "../../oc/explorer.js";
import { EdgeOps } from "../../oc/edge-ops.js";
import { synthesizeApplyFeature } from "../../selection/explain.js";
import { scopedSceneBefore } from "../../selection/types.js";
import { SceneObject } from "../../common/scene-object.js";
import { edgeRefsWhere, findSolids, setLocation } from "./pick-helpers.js";
import { testRect } from "../helpers/profiles.js";

/**
 * Two touching `.new()` boxes from one looped call site share the face
 * x = 10, so every edge on it has a coincident twin on the other solid:
 * same curve, same length, same planes. Neither extrude can be bound (one
 * call site, two features), so a pick on box A goes to the scene-wide
 * select(), where no geometric predicate tells it from its twin. The fillet
 * on A's far edges makes A's solid its own, and naming that owner —
 * `from(f)` — is the one filter that separates the twins.
 */
describe("owner-scoped selectors", () => {
  setupOC();

  function touchingBoxes({ later = false } = {}): { scene: Scene; boxA: Shape; boxB: Shape } {
    for (const x of [0, 10]) {
      sketch("xy", () => {
        testRect(10, 10, { at: [x, 0] });
      });
      setLocation(extrude(10).new(), 4);
    }
    const f = fillet(1, select(edge().onPlane('yz').verticalTo('xy')));
    setLocation(f, 6);
    if (later) {
      // A later modifier on A (the statement an edit session re-opens).
      setLocation(fillet(1, select(edge().onPlane('xy', 10).farthest('y').nearest('x'))), 8);
    }

    const scene = render();
    const solids = findSolids(scene);
    expect(solids).toHaveLength(2);
    const minX = (s: Shape) => Math.min(...Explorer.findEdgesWrapped(s).map(e => EdgeOps.getEdgeMidPoint(e).x));
    const [boxA, boxB] = [...solids].sort((a, b) => minX(a) - minX(b));
    return { scene, boxA, boxB };
  }

  const onSharedFace = (m: { x: number }) => Math.abs(m.x - 10) < 1e-6;
  const sharedVertical = (m: { x: number; y: number; z: number }) =>
    onSharedFace(m) && Math.abs(m.y) < 1e-6 && Math.abs(m.z - 5) < 1e-6;

  it("names the owning feature when a coincident twin defeats every geometric filter", () => {
    const { scene, boxA, boxB } = touchingBoxes();
    const refs = edgeRefsWhere(boxA, sharedVertical);
    expect(refs).toHaveLength(1);
    // The twin is really there: same location, other solid.
    expect(edgeRefsWhere(boxB, sharedVertical)).toHaveLength(1);

    const result = synthesizeApplyFeature(scene, refs, 'fillet', 2);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.spec.parts).toHaveLength(1);
      expect(result.spec.parts[0].accessor).toBe('select');
      expect(result.spec.parts[0].filterArgs).toContain('.from({{r0}})');
      // The fillet rides the producers list so the transform binds it — as a
      // whole-feature reference: fillet() has no accessors to chain.
      expect(result.spec.producers).toHaveLength(1);
      expect(result.spec.producers[0].featureType).toBe('feature');
      expect(result.spec.producers[0].bind).toBe(true);
      expect(result.spec.producers[0].line).toBe(6);
      expect(result.spec.parts[0].refs).toEqual([0]);
    }
  });

  it("asks the statement probe about whole-feature use, as the transform validates it", () => {
    // The server's probe accepts fillet() only as a whole-feature reference
    // (`'feature'`), never as an accessor producer of its own type.
    const { scene, boxA } = touchingBoxes();
    const refs = edgeRefsWhere(boxA, sharedVertical);
    const asked: string[] = [];
    const result = synthesizeApplyFeature(scene, refs, 'fillet', 2, [], {
      bindable: ({ featureType }) => {
        asked.push(featureType);
        return featureType !== 'fillet';
      },
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.spec.parts[0].filterArgs).toContain('.from({{r0}})');
    }
    expect(asked).toContain('feature');
    expect(asked).not.toContain('fillet');

    // A statement the transform cannot bind at all leaves nothing to name.
    const refused = synthesizeApplyFeature(scene, refs, 'fillet', 2, [], { bindable: () => false });
    expect(refused.ok).toBe(false);
  });

  it("names the owner when editing a later feature that consumed its solid", () => {
    // Re-picking the sources of a fillet that came after `f` (an edit
    // session) sees the world before that fillet: A's solid still belongs
    // to `f` there, even though the edited fillet consumed it since.
    const { scene } = touchingBoxes({ later: true });
    const objects = scene.getTimelineObjects();
    const edited = objects.findIndex(o => o.getSourceLocation()?.line === 8);
    expect(edited).toBeGreaterThan(0);
    const owner = objects.find(o => o.getType() === 'fillet' && o.getSourceLocation()?.line === 6) as SceneObject;
    const preEditA = owner.getAddedShapes().find(sh => sh.getType() === 'solid')!;
    const refs = edgeRefsWhere(preEditA, sharedVertical);
    expect(refs).toHaveLength(1);

    const result = synthesizeApplyFeature(scopedSceneBefore(scene, edited), refs, 'fillet', 2);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.spec.parts[0].filterArgs).toContain('.from({{r0}})');
      expect(result.spec.producers.map(p => [p.featureType, p.line])).toEqual([['feature', 6]]);
    }
  });

  it("covers several picks on the owner with one scoped conjunction", () => {
    const { scene, boxA } = touchingBoxes();
    const refs = edgeRefsWhere(boxA, m => onSharedFace(m) && Math.abs(m.z - 5) < 1e-6);
    expect(refs).toHaveLength(2);

    const result = synthesizeApplyFeature(scene, refs, 'fillet', 2);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.spec.parts).toHaveLength(1);
      expect(result.spec.parts[0].filterArgs).toContain('.from({{r0}})');
      expect(result.spec.producers.map(p => p.featureType)).toEqual(['feature']);
    }
  });

  it("keeps a geometric filter when one separates the pick", () => {
    // A's far vertical edge has no twin; ownership must not leak into a
    // selector that geometry alone can express.
    const { scene, boxA } = touchingBoxes();
    const refs = edgeRefsWhere(boxA, m =>
      Math.abs(m.x) < 1e-6 && Math.abs(m.y - 5) < 1e-6 && Math.abs(m.z - 10) < 1e-6);
    expect(refs).toHaveLength(1);

    const result = synthesizeApplyFeature(scene, refs, 'fillet', 2);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.args).not.toContain('.from(');
    }
  });

  it("still refuses when the owner cannot be bound", () => {
    // Without the fillet, each box's owner is its own looped extrude —
    // a shared call site no variable can name — so nothing separates the
    // twins and the refusal stands.
    for (const x of [0, 10]) {
      sketch("xy", () => {
        testRect(10, 10, { at: [x, 0] });
      });
      setLocation(extrude(10).new(), 4);
    }
    const scene = render();
    const solids = findSolids(scene);
    const boxA = solids.find(s =>
      Explorer.findEdgesWrapped(s).every(e => EdgeOps.getEdgeMidPoint(e).x < 10 + 1e-6))!;
    const refs = edgeRefsWhere(boxA, sharedVertical);
    expect(refs).toHaveLength(1);

    const result = synthesizeApplyFeature(scene, refs, 'fillet', 2);
    expect(result.ok).toBe(false);
  });
});
