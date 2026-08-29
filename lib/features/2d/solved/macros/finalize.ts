// The pre-solve hook macro shapes implement, kept import-free so the
// Sketch can duck-type its children without a module cycle (the same
// reason isReferenceProducer lives beside its interface).

import type { SceneObject } from "../../../../common/scene-object.js";

/**
 * What a macro shape statement (fluidcad/shapes) implements to
 * participate in the sketch's pre-solve pass. Chained modifiers
 * (`.radius()`, `.centered()`) change the sub-entity count, so
 * registration waits until the callback has fully executed:
 * `finalizeMacro` is idempotent and runs before deferred-constraint
 * resolution, registering the shape's solver entities and internal
 * constraint rows.
 */
export interface MacroProducer {
  finalizeMacro(): void;
}

export function isMacroProducer(obj: SceneObject): obj is MacroProducer & SceneObject {
  return typeof (obj as unknown as Partial<MacroProducer>).finalizeMacro === 'function';
}
