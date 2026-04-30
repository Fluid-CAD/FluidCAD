import { describe, it, expect } from "vitest";
import { setupOC, render } from "./setup.js";
import { getSceneManager } from "../scene-manager.js";
import { SceneCompare } from "../rendering/scene-compare.js";
import { SceneObject } from "../common/scene-object.js";
import sketch from "../core/sketch.js";
import extrude from "../core/extrude.js";
import { rect } from "../core/2d/index.js";

function findByType(objects: SceneObject[], uniqueType: string): SceneObject {
  const found = objects.find(o => o.getUniqueType() === uniqueType);
  if (!found) {
    throw new Error(`No object with uniqueType ${uniqueType}`);
  }
  return found;
}

describe("SceneCompare id preservation", () => {
  setupOC();

  it("inherits ids on matched objects across re-renders", () => {
    sketch("xy", () => {
      rect(100, 50);
    });
    extrude(30);
    render();

    const previousScene = getSceneManager().currentScene;
    const previousIds = previousScene.getSceneObjects().map(o => o.id);

    const newScene = getSceneManager().startScene();
    sketch("xy", () => {
      rect(100, 50);
    });
    extrude(30);

    SceneCompare.compare(previousScene, newScene);

    const newIds = newScene.getSceneObjects().map(o => o.id);
    expect(newIds).toEqual(previousIds);
  });

  it("inherits ids only up to the divergence point", () => {
    sketch("xy", () => {
      rect(100, 50);
    });
    extrude(30);
    render();

    const previousScene = getSceneManager().currentScene;
    const previousSketchId = findByType(previousScene.getSceneObjects(), "sketch").id;
    const previousExtrudeId = findByType(previousScene.getSceneObjects(), "extrude-by-distance").id;

    const newScene = getSceneManager().startScene();
    sketch("xy", () => {
      rect(100, 50);
    });
    extrude(50);

    const staleExtrudeId = findByType(newScene.getSceneObjects(), "extrude-by-distance").id;

    SceneCompare.compare(previousScene, newScene);

    const newSketchId = findByType(newScene.getSceneObjects(), "sketch").id;
    const newExtrudeId = findByType(newScene.getSceneObjects(), "extrude-by-distance").id;

    expect(newSketchId).toBe(previousSketchId);
    expect(newExtrudeId).toBe(staleExtrudeId);
    expect(newExtrudeId).not.toBe(previousExtrudeId);
  });

  it("keeps idMap consistent after id inheritance", () => {
    sketch("xy", () => {
      rect(100, 50);
    });
    extrude(30);
    render();

    const previousScene = getSceneManager().currentScene;
    const previousSketchId = findByType(previousScene.getSceneObjects(), "sketch").id;

    const newScene = getSceneManager().startScene();
    sketch("xy", () => {
      rect(100, 50);
    });
    extrude(30);

    const newSketch = findByType(newScene.getSceneObjects(), "sketch");
    const staleSketchId = newSketch.id;

    SceneCompare.compare(previousScene, newScene);

    expect(newScene.getSceneObjectById(previousSketchId)).toBe(newSketch);
    if (staleSketchId !== previousSketchId) {
      expect(newScene.getSceneObjectById(staleSketchId)).toBe(null);
    }
  });
});
