import { SceneObject } from "../common/scene-object.js";
import { SceneParserContext } from "../index.js";
import { SelectSceneObject } from "../features/select.js";

/**
 * Adds SceneObject targets (lazy accessors like `r.edge('top')`, select
 * statements) to the scene so they build before the consuming op. Objects
 * already in the scene are skipped by addSceneObject; filter builders and
 * other non-SceneObject args are ignored.
 */
export function addTargetObjects(objects: unknown[], context: SceneParserContext): void {
  for (const obj of objects) {
    if (obj instanceof SceneObject) {
      context.addSceneObject(obj);
    }
  }
}

/**
 * The last `select(...)` statement as an implicit target — only when it
 * belongs to the active sketch, mirroring the 3D last-selection contract.
 */
export function sketchLastSelection(context: SceneParserContext, activeSketch: SceneObject): SelectSceneObject[] {
  const lastSelection = context.getLastSelection();
  if (lastSelection && lastSelection.getParent() === activeSketch) {
    return [lastSelection];
  }
  return [];
}
