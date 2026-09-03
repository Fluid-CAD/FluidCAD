import { captureSourceLocation } from "../index.js";
import { getCurrentScene } from "../scene-manager.js";
import { AssemblyScene } from "../rendering/assembly-scene.js";
import { Part } from "../features/part.js";
import { PartDefinition } from "../features/part-definition.js";
import { Assembly } from "../features/assembly.js";
import { Instance } from "../features/instance.js";
import { Occurrence } from "../features/occurrence.js";
import { validateParamOverrides } from "../features/param-overrides.js";
import { createInstance, createOccurrence } from "../features/insert-records.js";
import type { ParamOverrides } from "../param-registry.js";
import { IPart } from "./interfaces.js";

/**
 * Place a part or sub-assembly definition in the current assembly.
 *
 * Units: a part built from a file with a different `unit()` than the
 * project is rescaled into the assembly's unit at render time — an inch
 * part inserted into an mm project renders 25.4× larger, connectors and all,
 * with the instance pose untouched. Parameter overrides are NOT converted:
 * `insert(def, { width: 10 })` reads `10` in the PART's unit (10 in for an
 * inch part), whatever the assembly runs in — the values feed the part's
 * own `param()` calls, whose numbers are the part file's numbers.
 */
function insert<T>(definition: PartDefinition<T>, overrides?: ParamOverrides): Instance<T>;
function insert<T>(definition: Assembly<T>, overrides?: ParamOverrides): Occurrence<T>;
function insert<P extends IPart>(part: P, overrides?: ParamOverrides): Instance<P>;
function insert(target: unknown, overrides?: ParamOverrides): Instance<unknown> | Occurrence<unknown> {
  const scene = getCurrentScene();
  if (!(scene instanceof AssemblyScene)) {
    throw new Error("insert() can only be used in *.assembly.js files.");
  }
  if (overrides !== undefined) {
    validateParamOverrides("insert()", overrides);
  }
  if (target instanceof Assembly) {
    return createOccurrence(scene, target, overrides, captureSourceLocation() ?? undefined);
  }

  let partObj: Part;
  if (target instanceof PartDefinition) {
    // First insert of a variant builds its template synchronously (the
    // Instance binds named connectors right below); repeats share it via
    // the definition's per-scene variant cache.
    partObj = target.materializeVariant(scene, overrides);
  } else if (target instanceof Part) {
    if (overrides && Object.keys(overrides).length > 0) {
      throw new Error("insert(): parameter overrides need a part definition — this part is already built.");
    }
    partObj = target;
  } else {
    throw new Error("insert(): expected a part(...) or assembly(...) definition — got " + typeof target + ".");
  }

  // Counter-based ids, stable across source edits — see
  // AssemblyScene.nextInstanceId; `sourceLocation` is preserved separately
  // on the record for drag-release `.translate(...)` writeback.
  return createInstance(scene, partObj, captureSourceLocation() ?? undefined);
}

export default insert;
