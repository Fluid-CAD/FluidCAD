import { describe, it, expect } from "vitest";
import { setupOC, render } from "./setup.js";
import { getSceneManager, getCurrentScene } from "../scene-manager.js";
import sketch from "../core/sketch.js";
import extrude from "../core/extrude.js";
import shell from "../core/shell.js";
import { rect } from "../core/2d/index.js";
import { face } from "../filters/index.js";
import { Extrude } from "../features/extrude.js";

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
