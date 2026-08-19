import { describe, it, expect } from "vitest";
import { setupOC, render } from "../../setup.js";
import { getSceneManager } from "../../../scene-manager.js";
import { SceneCompare } from "../../../rendering/scene-compare.js";
import { SceneObject } from "../../../common/scene-object.js";
import sketch from "../../../core/sketch.js";
import extrude from "../../../core/extrude.js";
import { line } from "../../../core/2d/index.js";
import {
  coincident, horizontal, vertical, fix, distance,
} from "../../../core/constraints/index.js";
import { Scene } from "../../../rendering/scene.js";

function declareModel(width: number) {
  sketch('xy', () => {
    const b = line([0, 0], [width, 0]);
    const r = line([width, 0], [width, 50]);
    const t = line([width, 50], [0, 50]);
    const l = line([0, 50], [0, 0]);
    coincident(b.end(), r.start());
    coincident(r.end(), t.start());
    coincident(t.end(), l.start());
    coincident(l.end(), b.start());
    horizontal(b);
    vertical(r);
    fix(b.start());
    distance(b.start(), b.end(), width);
  }, true);
  extrude(30);
}

function byUniqueType(scene: Scene, uniqueType: string): SceneObject[] {
  return scene.getSceneObjects().filter(o => o.getUniqueType() === uniqueType);
}

describe("solved sketch cache atomicity (SceneCompare)", () => {
  setupOC();

  it("caches the whole subtree when nothing changed, preserving ids", () => {
    declareModel(100);
    render();
    const previousScene = getSceneManager().currentScene;
    const previousIds = previousScene.getSceneObjects().map(o => o.id);

    const newScene = getSceneManager().startScene();
    declareModel(100);
    SceneCompare.compare(previousScene, newScene);

    expect(newScene.getSceneObjects().map(o => o.id)).toEqual(previousIds);
    for (const obj of newScene.getSceneObjects()) {
      expect(newScene.isCached(obj)).toBe(true);
    }
  });

  it("rebuilds the WHOLE sketch subtree when one dimension changes", () => {
    declareModel(100);
    render();
    const previousScene = getSceneManager().currentScene;

    const newScene = getSceneManager().startScene();
    declareModel(120);
    SceneCompare.compare(previousScene, newScene);

    // The prefix before the sketch (its internal plane) is still cached.
    const plane = newScene.getSceneObjectAt(0);
    expect(newScene.isCached(plane)).toBe(true);

    // The sketch container itself is NOT cached even though its own
    // compareTo matches — atomicity: a child (the dim) diverged.
    const sketchObj = byUniqueType(newScene, 'sketch')[0];
    expect(newScene.isCached(sketchObj)).toBe(false);

    // No solved child is cached — geometry that structurally matches
    // (the two untouched lines) rebuilds with the new solve.
    for (const child of sketchObj.getChildren()) {
      expect(newScene.isCached(child)).toBe(false);
    }

    // Downstream rebuilds too (prefix semantics).
    const extrudeObj = byUniqueType(newScene, 'extrude-by-distance')[0];
    expect(newScene.isCached(extrudeObj)).toBe(false);

    // And the recompare render solves with the new dimension.
    const scene = render();
    const bottom = scene.getRenderedObjects().find(r => r.uniqueType === 'solved-line')!;
    expect(bottom.object.end.x).toBeCloseTo(120, 6);
  });

  it("still prefix-caches legacy sketches child by child", () => {
    sketch('xy', () => {
      line([0, 0], [50, 0]);
      line([50, 0], [50, 30]);
    });
    render();
    const previousScene = getSceneManager().currentScene;

    const newScene = getSceneManager().startScene();
    sketch('xy', () => {
      line([0, 0], [50, 0]);
      line([50, 0], [80, 30]);
    });
    SceneCompare.compare(previousScene, newScene);

    // Legacy behavior: the sketch and the first (unchanged) child stay
    // cached; only the diverging child onward rebuilds.
    const sketchObj = byUniqueType(newScene, 'sketch')[0];
    expect(newScene.isCached(sketchObj)).toBe(true);
    const children = sketchObj.getChildren();
    expect(newScene.isCached(children[0])).toBe(true);
    expect(newScene.isCached(children[children.length - 1])).toBe(false);
  });
});
