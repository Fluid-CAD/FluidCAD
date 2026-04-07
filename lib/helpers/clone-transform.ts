import { Matrix4 } from "../math/matrix4.js";
import { SceneObject } from "../common/scene-object.js";

export function cloneWithTransform(
  objects: SceneObject[],
  transform: Matrix4,
  container: SceneObject
): SceneObject[] {
  const visited = new Set<SceneObject>();
  const ordered: SceneObject[] = [];

  const collectDeps = (obj: SceneObject) => {
    if (visited.has(obj)) {
      return;
    }
    visited.add(obj);

    for (const dep of obj.getDependencies()) {
      collectDeps(dep);
    }

    ordered.push(obj);

    // Collect children without following their dependencies —
    // cloned children will reference originals for any deps not in the clone set
    collectChildren(obj);
  };

  const collectChildren = (obj: SceneObject) => {
    for (const child of obj.getChildren()) {
      if (visited.has(child)) {
        continue;
      }
      visited.add(child);
      ordered.push(child);
      collectChildren(child);
    }
  };

  for (const obj of objects) {
    collectDeps(obj);
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
