import { Matrix4 } from "../math/matrix4.js";
import { SceneObject } from "../common/scene-object.js";

export function cloneWithTransform(
  objects: SceneObject[],
  transform: Matrix4,
  container: SceneObject
): SceneObject[] {
  const visited = new Set<SceneObject>();
  const ordered: SceneObject[] = [];

  const collect = (obj: SceneObject) => {
    if (visited.has(obj)) {
      return;
    }
    visited.add(obj);

    for (const dep of obj.getDependencies()) {
      collect(dep);
    }

    ordered.push(obj);

    for (const child of obj.getChildren()) {
      collect(child);
    }
  };

  for (const obj of objects) {
    collect(obj);
  }

  const remap = new Map<SceneObject, SceneObject>();
  const allCloned: SceneObject[] = [];

  for (const obj of ordered) {
    const copy = obj.createCopy(remap);
    remap.set(obj, copy);
    copy.setTransform(transform);
    allCloned.push(copy);

    const parent = obj.getParent();
    if (parent && remap.has(parent)) {
      remap.get(parent)!.addChildObject(copy);
    } else if (!copy.parentId) {
      container.addChildObject(copy);
    }
  }

  return allCloned;
}
