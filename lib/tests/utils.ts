import { Scene } from "../rendering/scene.js";

export function countShapes(scene: Scene): number {
  return scene.getRenderedObjects().reduce((acc, obj) => acc + obj.sceneShapes.length, 0);
}
