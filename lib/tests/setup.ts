import { beforeEach } from "vitest";
import { getSceneManager, getCurrentScene } from "../scene-manager.js";
import { SceneRenderer } from "../rendering/render.js";
import { Scene } from "../rendering/scene.js";
import { AssemblyScene } from "../rendering/assembly-scene.js";
import { SceneObject } from "../common/scene-object.js";
import { DEFAULT_MESH_CONFIG } from "../oc/mesh.js";

const renderer = new SceneRenderer(DEFAULT_MESH_CONFIG);

export function setupOC() {
  beforeEach(() => {
    getSceneManager().startScene();
  });
}

export function render(): Scene {
  const scene = getCurrentScene();
  // Mirror the entry-render flow: part scenes materialize their tracked
  // part() definitions before rendering (assembly scenes build via insert).
  if (!(scene instanceof AssemblyScene)) {
    scene.materializeLeftoverDefinitions();
  }
  return renderer.render(scene);
}

export function addToScene(obj: SceneObject): void {
  getCurrentScene().addSceneObject(obj);
}

/**
 * A sketch (or any object) its consumer took for display only: the render's
 * scoped read is empty, the scope-less feature read still serves the shapes.
 * `scene` is the full render.
 */
export function expectDisplayConsumed(scene: Scene, obj: SceneObject): void {
  if (obj.getShapes(undefined, undefined, new Set(scene.getAllSceneObjects())).length !== 0) {
    throw new Error(`${obj.getType()} still renders after its consumer`);
  }
  if (obj.getShapes().length === 0) {
    throw new Error(`${obj.getType()} was taken from feature reads — a display-only consumer must keep it`);
  }
}
