import { beforeAll, beforeEach } from "vitest";
import { init } from "../index.js";
import { getSceneManager, getCurrentScene } from "../scene-manager.js";
import { renderScene } from "../rendering/render.js";
import { Scene } from "../rendering/scene.js";

export function setupOC() {
  beforeAll(async () => {
    await init("/tmp/fluidcad-test");
  });

  beforeEach(() => {
    getSceneManager().startScene();
  });
}

export function render(): Scene {
  return renderScene(getCurrentScene());
}
