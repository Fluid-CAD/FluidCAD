import { Matrix4 } from "../math/matrix4.js";
import { SceneObject } from "../common/scene-object.js";
import { LazySceneObject } from "../features/lazy-scene-object.js";

export function cloneWithTransform(
  objects: SceneObject[],
  transform: Matrix4,
  container: SceneObject
): SceneObject[] {
  const allCloned: SceneObject[] = [];

  for (const obj of objects) {
    const clonedTree = obj.clone();

    for (const cloned of clonedTree) {
      if (cloned instanceof LazySceneObject) {
        continue;
      }

      cloned.setTransform(transform);
      allCloned.push(cloned);

      if (!cloned.parentId) {
        container.addChildObject(cloned);
      }
    }
  }

  return allCloned;
}
