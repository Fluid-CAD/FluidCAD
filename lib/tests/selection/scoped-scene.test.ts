import { describe, it, expect } from "vitest";
import { setupOC, render } from "../setup.js";
import sketch from "../../core/sketch.js";
import extrude from "../../core/extrude.js";
import cut from "../../core/cut.js";
import fillet from "../../core/fillet.js";
import shell from "../../core/shell.js";
import { edge } from "../../filters/index.js";
import { arc, circle, line } from "../../core/2d/index.js";
import { coincident } from "../../core/constraints/index.js";
import { Scene } from "../../rendering/scene.js";
import { Shape } from "../../common/shape.js";
import { getSceneManager } from "../../scene-manager.js";
import { explainSelection, synthesizeApplyFeature } from "../../selection/explain.js";
import { expandBucket } from "../../selection/expand.js";
import { resolveScopedScene, scopedSceneBefore } from "../../selection/types.js";
import { edgeRefsWhere, faceRefsWhere, setLocation } from "./pick-helpers.js";
import { testRect } from "../helpers/profiles.js";

/** Solved stand-in for legacy `rect(w, h).centered().radius(r)`: four lines
 * and four CCW corner arcs around the origin, exact coordinates. */
function testRoundedRectCentered(w: number, h: number, r: number) {
  const x = w / 2;
  const y = h / 2;
  const segs = [
    line([-(x - r), -y], [x - r, -y]),
    arc([x - r, -y], [x, -(y - r)], [x - r, -(y - r)]),
    line([x, -(y - r)], [x, y - r]),
    arc([x, y - r], [x - r, y], [x - r, y - r]),
    line([x - r, y], [-(x - r), y]),
    arc([-(x - r), y], [-x, y - r], [-(x - r), y - r]),
    line([-x, y - r], [-x, -(y - r)]),
    arc([-x, -(y - r)], [-(x - r), -y], [-(x - r), -(y - r)]),
  ];
  for (let i = 0; i < segs.length; i++) {
    coincident(segs[i].end(), segs[(i + 1) % segs.length].start());
  }
}

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
      testRect(100, 100);
    });
  const e = extrude(50);
  setLocation(e, 4);
  sketch(e.endFaces(), () => {
      circle([50, 50], 40);
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

  it("synthesizes a global select() for a pick on a solid consumed by the edited statement", () => {
    // extrude → fillet (reshapes the side face) → shell. Editing the shell,
    // the rollback displays the fillet's solid — consumed by the shell itself,
    // i.e. by a feature OUTSIDE the boundary. The picked side face was trimmed
    // by the fillet, so no bucket names it and synthesis must go through the
    // scene-wide select() tier — whose universe has to treat the fillet solid
    // as present (its consumer is not part of the scoped world).
    sketch("xy", () => {
      testRoundedRectCentered(100, 60, 8);
    });
    const e = extrude(30);
    setLocation(e, 4);
    const f = fillet(3, e.startEdges(edge().above("xz").above("yz")));
    setLocation(f, 6);
    const sh = shell(-2, e.endFaces());
    setLocation(sh, 7);

    const scene = render();
    const shellIndex = scene.getAllSceneObjects().findIndex(o => o.getType() === "shell");
    expect(shellIndex).toBeGreaterThan(0);
    const filleted = solidOf(scene, "fillet");

    // The side face at y = -30, trimmed by the fillet (not the extrude's
    // original side face, so it belongs to no bucket).
    const sideRefs = faceRefsWhere(filleted, m => Math.abs(m.y + 30) < 1e-6);
    expect(sideRefs).toHaveLength(1);

    const scoped = scopedSceneBefore(scene, shellIndex);
    const explain = explainSelection(scoped, sideRefs);
    expect(explain.picks[0].error).toBeUndefined();
    expect(explain.picks[0].attributed).toBe(false); // guards the select() routing

    const synthesis = synthesizeApplyFeature(scoped, sideRefs, "shell", -2);
    expect(synthesis.ok).toBe(true);
    if (synthesis.ok) {
      expect(synthesis.args).toMatch(/^select\(face\(\)/);
      expect(synthesis.spec.imports).toContain("select");
      expect(synthesis.spec.producers).toHaveLength(1);
      expect(synthesis.spec.producers[0].bind).toBe(false); // anchor-only
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
