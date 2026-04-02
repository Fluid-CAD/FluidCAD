import { beforeEach } from "vitest";
import { getSceneManager, getCurrentScene } from "../scene-manager.js";
import { renderScene } from "../rendering/render.js";
import { Scene } from "../rendering/scene.js";

export function setupOC() {
  beforeEach(() => {
    getSceneManager().startScene();
  });
}

export function render(): Scene {
  return renderScene(getCurrentScene());
}
