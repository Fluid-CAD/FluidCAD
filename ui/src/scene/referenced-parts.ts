import type { SceneObjectRender, SerializedAssembly } from '../types';

/**
 * Keep only parts referenced by some `inst.partId` and the entire subtree
 * under each kept part. An assembly file declares every part it might use
 * (typically via factory functions like `getExtrusion(...)`), but only the
 * ones passed to `insert(...)` are in the assembly: the viewport must not
 * materialize an un-inserted part at world origin on a `rebuildSceneMesh()`
 * (theme change, region pick), and the Export list must not offer one.
 */
export function filterToReferencedParts(
  sceneObjects: SceneObjectRender[],
  instances: SerializedAssembly['instances'],
): SceneObjectRender[] {
  const referencedPartIds = new Set(instances.map(i => i.partId));
  const childrenByParent = new Map<string, SceneObjectRender[]>();
  for (const obj of sceneObjects) {
    if (!obj.parentId) {
      continue;
    }
    const list = childrenByParent.get(obj.parentId);
    if (list) {
      list.push(obj);
    } else {
      childrenByParent.set(obj.parentId, [obj]);
    }
  }
  const keep = new Set<string>();
  const stack: SceneObjectRender[] = [];
  for (const obj of sceneObjects) {
    if (obj.type === 'part' && obj.id && referencedPartIds.has(obj.id)) {
      stack.push(obj);
    }
  }
  while (stack.length > 0) {
    const obj = stack.pop()!;
    if (!obj.id || keep.has(obj.id)) {
      continue;
    }
    keep.add(obj.id);
    const children = childrenByParent.get(obj.id);
    if (children) {
      stack.push(...children);
    }
  }
  return sceneObjects.filter(obj => obj.id && keep.has(obj.id));
}
