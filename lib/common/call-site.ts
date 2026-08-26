import { SceneObject } from "./scene-object.js";

/**
 * Stable identity for the statement call site that created `obj` — the type
 * plus the stamped source location. A loop, helper, or repeat that executes
 * one call site N times produces N objects sharing this key. Shared by
 * selection attribution (SelectionIndex) and the render payload's
 * per-call-site occurrence indexing.
 */
export function callSiteKey(obj: SceneObject): string | null {
  const loc = obj.getSourceLocation();
  if (!loc) {
    return null;
  }
  return `${obj.getType()}@${loc.filePath}:${loc.line}:${loc.column}`;
}
