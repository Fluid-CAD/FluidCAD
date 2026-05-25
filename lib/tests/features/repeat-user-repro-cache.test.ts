import { describe, it, expect } from "vitest";
import { setupOC, render } from "../setup.js";
import { getSceneManager } from "../../scene-manager.js";
import { SceneCompare } from "../../rendering/scene-compare.js";
import { Scene } from "../../rendering/scene.js";
import sketch from "../../core/sketch.js";
import extrude from "../../core/extrude.js";
import axis from "../../core/axis.js";
import repeat from "../../core/repeat.js";
import sweep from "../../core/sweep.js";
import cut from "../../core/cut.js";
import remove from "../../core/remove.js";
import { rect, circle, vLine, tArc, tLine, slot, move, hMove } from "../../core/2d/index.js";
import copy from "../../core/copy.js";

// Regression: re-rendering a scene whose `repeat("circular", ...)` axis is an
// AxisFromEdge derived from a sketch line used to crash inside
// SceneCompare.compare with "Cannot read properties of undefined (reading
// 'origin')". RepeatCircular.compareTo eagerly called getAxis() on the
// new-scene axis source, which hadn't been built yet (compare runs pre-render).
describe("repeat circular cache-compare on unbuilt axis source", () => {
  setupOC();

  function buildScene(includeRemove: boolean) {
    const spine = sketch("front", () => {
      vLine(1.5);
      tArc(-4, 45);
      const topSegment = tLine(1.5);
      return { topSegment };
    }).reusable();

    const profile = sketch("top", () => {
      const innerPipe = circle(1.5);
      const outerPipe = circle(2);
      return { innerPipe, outerPipe };
    });

    const pipe = sweep(spine, profile.regions.outerPipe);

    sketch("top", () => {
      rect(3.5).centered().radius(0.5);
      move([-2.5 / 2, -2.5 / 2]);
      const c = circle(0.5);
      copy("circular", [0, 0], { count: 4, angle: 360 }, c);
    });

    extrude(0.375);

    sketch(pipe.endFaces(), () => {
      circle(4);
    });

    const upperFlange = extrude(-0.625);

    sweep(spine, profile.regions.innerPipe).remove();

    const slots = sketch(upperFlange.endFaces(), () => {
      hMove(3.25 / 2);
      const outerSlot = slot(1, 0.75 / 2);
      const innerSlot = slot(1, 0.45 / 2);
      return { outerSlot, innerSlot };
    });

    const s1 = cut(slots.regions.innerSlot);
    const s2 = cut(0.25, slots.regions.outerSlot);

    const a = axis(spine.regions.topSegment);

    repeat("circular", a, { count: 4, angle: 360 }, s1, s2);

    if (includeRemove) {
      remove(spine);
    }
  }

  function currentScene(): Scene {
    const mgr = getSceneManager();
    if (!mgr) {
      throw new Error("Scene manager not initialized");
    }
    return mgr.currentScene;
  }

  function startNewScene(): Scene {
    const mgr = getSceneManager();
    if (!mgr) {
      throw new Error("Scene manager not initialized");
    }
    return mgr.startScene();
  }

  it("re-parsing the same script with cache compare does not throw", () => {
    buildScene(false);
    render();
    const previousScene = currentScene();
    expect(previousScene.getAllSceneObjects().some(o => o.getError())).toBe(false);

    const newScene = startNewScene();
    buildScene(false);
    SceneCompare.compare(previousScene, newScene);
    const rendered = render();

    const errored = rendered.getAllSceneObjects().filter(o => o.getError());
    expect(errored.map(o => `${o.getUniqueType()}: ${o.getError()}`)).toEqual([]);
  });

  it("appending remove(spine) after a cached render does not throw", () => {
    buildScene(false);
    render();
    const previousScene = currentScene();

    const newScene = startNewScene();
    buildScene(true);
    SceneCompare.compare(previousScene, newScene);
    const rendered = render();

    const errored = rendered.getAllSceneObjects().filter(o => o.getError());
    expect(errored.map(o => `${o.getUniqueType()}: ${o.getError()}`)).toEqual([]);
  });
});
