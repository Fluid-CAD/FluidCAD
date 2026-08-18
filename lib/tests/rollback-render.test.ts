import { describe, it, expect } from "vitest";
import { setupOC, render } from "./setup.js";
import { getSceneManager, getCurrentScene } from "../scene-manager.js";
import sketch from "../core/sketch.js";
import extrude from "../core/extrude.js";
import shell from "../core/shell.js";
import part from "../core/part.js";
import { rect } from "../core/2d/index.js";
import { face } from "../filters/index.js";
import { Extrude } from "../features/extrude.js";
import { Part } from "../features/part.js";
import { Sketch } from "../features/2d/sketch.js";

/** A scene whose last feature fails to build: `sketch → extrude → shell`. */
function sceneWithFailingShell() {
  sketch("xy", () => {
    rect(100, 100);
  });
  const e = extrude(50) as Extrude;
  // Lazy accessor selection resolving to no faces — fails inside build().
  shell(-2, e.endFaces(face().circle(999)));
  render();
  return getCurrentScene();
}

describe("rollback rendering", () => {
  setupOC();

  it("keeps a failed feature's error when it is inside the rollback scope", () => {
    const scene = sceneWithFailingShell();
    const lastIndex = scene.getAllSceneObjects().length - 1;

    getSceneManager().rollbackScene(scene, lastIndex);

    // A rollback re-emits already-built objects instead of rebuilding them.
    // Reporting hasError: false there would call a broken feature clean.
    const errored = scene.getRenderedObjects().filter(o => o.hasError);
    expect(errored).toHaveLength(1);
    expect(errored[0].uniqueType).toContain("shell");
    expect(errored[0].errorMessage).toContain("no faces");
  });

  it("drops the error once the failed feature is rolled past", () => {
    const scene = sceneWithFailingShell();

    // Stop before the shell — that feature isn't part of the shown scene, so
    // isolating a build failure by rolling back still clears the error.
    getSceneManager().rollbackScene(scene, 0);

    expect(scene.getRenderedObjects().filter(o => o.hasError)).toEqual([]);
  });
});

/** Two parts, each `sketch → extrude` — each sketch consumed by its own extrude. */
function twoPartScene() {
  part("p1", () => {
    sketch("xy", () => {
      rect(100, 100);
    });
    extrude(50);
  });
  part("p2", () => {
    sketch("xy", () => {
      rect(30, 30);
    });
    extrude(20);
  });
  render();
  return getCurrentScene();
}

describe("part-scoped rollback rendering", () => {
  setupOC();

  it("hides only the target part's tail; other parts keep their full render", () => {
    const scene = twoPartScene();
    const objects = scene.getAllSceneObjects();
    const [p1] = objects.filter(o => o instanceof Part);
    const [p1Extrude, p2Extrude] = objects.filter(o => o instanceof Extrude);
    const [p1Sketch, p2Sketch] = objects.filter(o => o instanceof Sketch);

    // Stop on the last object before p1's extrude — the whole sketch stays
    // in scope, the extrude falls out.
    const stop = scene.indexOf(p1Extrude) - 1;
    const meta = getSceneManager().rollbackScene(scene, stop, { partScoped: true });

    expect(meta).toEqual({ stop, scopePartId: p1.id });
    expect(scene.getRenderedObject(p1Extrude)!.visible).toBe(false);
    expect(scene.getRenderedObject(p1Extrude)!.sceneShapes).toHaveLength(0);
    // p1's sketch is unconsumed again — its consumer left the scope.
    expect(scene.getRenderedObject(p1Sketch)!.visible).toBe(true);
    // p2 renders exactly like the full render: extrude visible with shapes,
    // its sketch still consumed (that consumer stayed in scope).
    expect(scene.getRenderedObject(p2Extrude)!.visible).toBe(true);
    expect(scene.getRenderedObject(p2Extrude)!.sceneShapes.length).toBeGreaterThan(0);
    expect(scene.getRenderedObject(p2Sketch)!.visible).toBe(false);
  });

  it("falls back to the global prefix when the target has no enclosing part", () => {
    sketch("xy", () => {
      rect(100, 100);
    });
    extrude(50);
    part("p2", () => {
      sketch("xy", () => {
        rect(30, 30);
      });
      extrude(20);
    });
    render();
    const scene = getCurrentScene();
    const objects = scene.getAllSceneObjects();
    const [topExtrude, p2Extrude] = objects.filter(o => o instanceof Extrude);

    const stop = scene.indexOf(topExtrude);
    const meta = getSceneManager().rollbackScene(scene, stop, { partScoped: true });

    expect(meta).toEqual({ stop, scopePartId: null });
    expect(scene.getRenderedObject(topExtrude)!.visible).toBe(true);
    expect(scene.getRenderedObject(p2Extrude)!.visible).toBe(false);
  });

  it("keeps the stop on the clicked row when the scope hides nothing", () => {
    const scene = twoPartScene();
    const objects = scene.getAllSceneObjects();
    const [p1] = objects.filter(o => o instanceof Part);
    const [p1Extrude, p2Extrude] = objects.filter(o => o instanceof Extrude);
    const [p1Sketch] = objects.filter(o => o instanceof Sketch);

    // p1's last feature: the scoped view IS the full render, but the echoed
    // stop stays on the clicked row — the timeline's current marker belongs
    // there, and the UI derives "nothing hidden" from stop + part id.
    const stop = scene.indexOf(p1Extrude);
    const meta = getSceneManager().rollbackScene(scene, stop, { partScoped: true });

    expect(meta).toEqual({ stop, scopePartId: p1.id });
    expect(scene.getRenderedObject(p1Extrude)!.visible).toBe(true);
    expect(scene.getRenderedObject(p2Extrude)!.visible).toBe(true);
    // Full-render semantics all the way: p1's sketch reads consumed again.
    expect(scene.getRenderedObject(p1Sketch)!.visible).toBe(false);
  });
});
