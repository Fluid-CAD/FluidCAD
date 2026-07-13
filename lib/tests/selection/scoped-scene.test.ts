import { describe, it, expect } from "vitest";
import { setupOC, render } from "../setup.js";
import sketch from "../../core/sketch.js";
import extrude from "../../core/extrude.js";
import cut from "../../core/cut.js";
import { circle, move, rect } from "../../core/2d/index.js";
import { Scene } from "../../rendering/scene.js";
import { Shape } from "../../common/shape.js";
import { getSceneManager } from "../../scene-manager.js";
import { explainSelection, synthesizeApplyFeature } from "../../selection/explain.js";
import { expandBucket } from "../../selection/expand.js";
import { resolveScopedScene, scopedSceneBefore } from "../../selection/types.js";
import { edgeRefsWhere, faceRefsWhere, setLocation } from "./pick-helpers.js";

/** The solid added by the scene's only object of `type`. */
function solidOf(scene: Scene, type: string): Shape {
  const objects = scene.getAllSceneObjects().filter(o => o.getType() === type);
  expect(objects).toHaveLength(1);
  const solids = objects[0].getAddedShapes().filter(s => s.getType() === "solid");
  expect(solids.length).toBeGreaterThan(0);
  return solids[0];
}

/**
 * A box with a round pocket cut into its top. Editing the cut means picking
 * against the pre-cut world: the plain box solid, with no cut buckets in the
 * index. Returns the rendered scene plus the boundary index of the cut.
 */
function pocketScene(): { scene: Scene; cutIndex: number; box: Shape; pocketed: Shape } {
  sketch("xy", () => {
    rect(100, 100);
  });
  const e = extrude(50);
  setLocation(e, 4);
  sketch(e.endFaces(), () => {
    move([50, 50]);
    circle(40);
  });
  const c = cut(30);
  setLocation(c, 9);

  const scene = render();
  const cutIndex = scene.getAllSceneObjects().findIndex(o => o.getType() === "cut");
  expect(cutIndex).toBeGreaterThan(0);
  return { scene, cutIndex, box: solidOf(scene, "extrude"), pocketed: solidOf(scene, "cut") };
}

describe("scoped selection scene", () => {
  setupOC();

  it("slices the object list strictly before the boundary", () => {
    const { scene, cutIndex } = pocketScene();
    const scoped = scopedSceneBefore(scene, cutIndex);
    expect(scoped.getAllSceneObjects()).toHaveLength(cutIndex);
    expect(scoped.getAllSceneObjects().every(o => o.getType() !== "cut")).toBe(true);
    // The facade must not clone objects — identity feeds Sets and Maps downstream.
    expect(scoped.getAllSceneObjects()[0]).toBe(scene.getAllSceneObjects()[0]);
  });

  it("refuses picks on geometry born at or after the boundary", () => {
    const { scene, cutIndex, pocketed } = pocketScene();
    const floorRefs = edgeRefsWhere(pocketed, m => Math.abs(m.z - 20) < 1e-6);
    expect(floorRefs.length).toBeGreaterThan(0);

    // Sanity: the full scene attributes the pocket floor to the cut.
    const full = explainSelection(scene, floorRefs);
    expect(full.picks[0].attributed).toBe(true);
    expect(full.picks[0].producer!.featureType).toBe("cut");

    // Scoped before the cut, the pocketed solid does not exist at all.
    const scoped = scopedSceneBefore(scene, cutIndex);
    const result = explainSelection(scoped, floorRefs);
    expect(result.picks[0].attributed).toBe(false);
    expect(result.picks[0].error).toMatch(/does not resolve/);
  });

  it("attributes pre-boundary picks against the pre-boundary solid", () => {
    const { scene, cutIndex, box } = pocketScene();
    const scoped = scopedSceneBefore(scene, cutIndex);

    const topEdgeRefs = edgeRefsWhere(box, m => Math.abs(m.z - 50) < 1e-6);
    expect(topEdgeRefs).toHaveLength(4);
    const result = explainSelection(scoped, topEdgeRefs);
    for (const pick of result.picks) {
      expect(pick.attributed).toBe(true);
      expect(pick.producer!.featureType).toBe("extrude");
      expect(pick.producer!.accessor).toBe("endEdges");
    }
  });

  it("synthesizes and oracle-verifies selectors inside the scoped world", () => {
    const { scene, cutIndex, box } = pocketScene();
    const scoped = scopedSceneBefore(scene, cutIndex);

    const topFaceRefs = faceRefsWhere(box, m => Math.abs(m.z - 50) < 1e-6);
    expect(topFaceRefs).toHaveLength(1);

    const synthesis = synthesizeApplyFeature(scoped, topFaceRefs, "shell", -2);
    expect(synthesis.ok).toBe(true);
    if (synthesis.ok) {
      expect(synthesis.args).toBe("e.endFaces()");
      expect(synthesis.spec.producers).toHaveLength(1);
      expect(synthesis.spec.producers[0].line).toBe(4);
      expect(synthesis.spec.producers[0].featureType).toBe("extrude");
    }
  });

  it("expands buckets over the scoped index", () => {
    const { scene, cutIndex, box } = pocketScene();
    const scoped = scopedSceneBefore(scene, cutIndex);

    const seed = edgeRefsWhere(box, m => Math.abs(m.z - 50) < 1e-6)[0];
    const result = expandBucket(scoped, seed);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.featureType).toBe("extrude");
      expect(result.accessor).toBe("endEdges");
      expect(result.members).toHaveLength(4);
    }
  });

  it("resolves a boundary only when the index still holds the same call site", () => {
    const { scene, cutIndex } = pocketScene();

    const good = resolveScopedScene(scene, { index: cutIndex, type: "cut", line: 9, column: 0 });
    expect(good.ok).toBe(true);
    if (good.ok) {
      expect(good.scene.getAllSceneObjects()).toHaveLength(cutIndex);
    }

    // Drifted index, wrong feature type, wrong line: each refuses.
    const drifted = [
      { index: cutIndex - 1, type: "cut", line: 9, column: 0 },
      { index: cutIndex, type: "fillet", line: 9, column: 0 },
      { index: cutIndex, type: "cut", line: 10, column: 0 },
      { index: scene.getAllSceneObjects().length + 3, type: "cut", line: 9, column: 0 },
    ];
    for (const boundary of drifted) {
      const result = resolveScopedScene(scene, boundary);
      expect(result.ok).toBe(false);
    }
  });

  it("threads the boundary through SceneManager and refuses stale ones", () => {
    const { scene, cutIndex, box } = pocketScene();
    const manager = getSceneManager()!;
    const topFaceRefs = faceRefsWhere(box, m => Math.abs(m.z - 50) < 1e-6);

    const scoped = manager.synthesizeApplyFeature(
      scene, topFaceRefs, "shell", -2, [], {}, { index: cutIndex, type: "cut", line: 9, column: 0 },
    );
    expect(scoped.ok).toBe(true);
    if (scoped.ok) {
      expect(scoped.args).toBe("e.endFaces()");
    }

    const stale = manager.synthesizeApplyFeature(
      scene, topFaceRefs, "shell", -2, [], {}, { index: cutIndex, type: "cut", line: 12, column: 0 },
    );
    expect(stale.ok).toBe(false);
    if (stale.ok === false) {
      expect(stale.reason).toMatch(/no longer matches/);
    }

    // No boundary keeps today's full-scene behavior.
    const unscoped = manager.explainSelection(scene, topFaceRefs);
    expect("picks" in unscoped && unscoped.picks).toHaveLength(1);
  });
});
