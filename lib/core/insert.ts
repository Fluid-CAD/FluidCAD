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
import { DEFAULT_CONFIGURATION } from "../param-registry.js";
import type { ParamOverrides } from "../param-registry.js";
import { IPart } from "./interfaces.js";

/**
 * Place a part or sub-assembly definition in the current assembly.
 *
 *     const left = insert(bracket);                          // the literals
 *     const wide = insert(frame, 'Wide');                    // a configurations() row
 *     const deep = insert(frame, 'Wide', { Depth: 1000 });   // the row, with one value changed
 *     const long = insert(bracket, { Length: 380 });         // values only
 *
 * A string second argument names a row of the definition's
 * `configurations()` table; the override object then moves to the third
 * position and layers on top of the row. A name the table does not declare
 * is an error on this statement, listing the declared names. `'Default'`
 * is the literals — the same as no name.
 *
 * Units: a part built from a file with a different `unit()` than the
 * project is rescaled into the assembly's unit at render time — an inch
 * part inserted into an mm project renders 25.4× larger, connectors and all,
 * with the instance pose untouched. Parameter overrides and configuration
 * cells are NOT converted: `insert(def, { width: 10 })` reads `10` in the
 * PART's unit (10 in for an inch part), whatever the assembly runs in — the
 * values feed the part's own `param()` calls, whose numbers are the part
 * file's numbers.
 *
 * @param definition - A `part()` or `assembly()` definition.
 * @param configuration - A row name from the definition's `configurations()`.
 * @param overrides - `{ label: value }` for the definition's `param()` calls.
 */
function insert<T>(definition: PartDefinition<T>, overrides?: ParamOverrides): Instance<T>;
function insert<T>(definition: PartDefinition<T>, configuration: string, overrides?: ParamOverrides): Instance<T>;
function insert<T>(definition: Assembly<T>, overrides?: ParamOverrides): Occurrence<T>;
function insert<T>(definition: Assembly<T>, configuration: string, overrides?: ParamOverrides): Occurrence<T>;
function insert<P extends IPart>(part: P, overrides?: ParamOverrides): Instance<P>;
function insert(target: unknown, second?: ParamOverrides | string, third?: ParamOverrides): Instance<unknown> | Occurrence<unknown> {
  const scene = getCurrentScene();
  if (!(scene instanceof AssemblyScene)) {
    throw new Error("insert() can only be used in *.assembly.js files.");
  }
  const { configuration, overrides } = insertArguments(second, third);
  if (overrides !== undefined) {
    validateParamOverrides("insert()", overrides);
  }
  if (target instanceof Assembly) {
    return createOccurrence(scene, target, overrides, captureSourceLocation() ?? undefined, { configuration });
  }

  let partObj: Part;
  if (target instanceof PartDefinition) {
    // First insert of a variant builds its template synchronously (the
    // Instance binds named connectors right below); repeats share it via
    // the definition's per-scene variant cache.
    partObj = target.materializeVariant(scene, overrides, configuration);
  } else if (target instanceof Part) {
    if (configuration !== undefined) {
      throw new Error("insert(): a configuration name needs a part definition — this part is already built.");
    }
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
  return createInstance(scene, partObj, captureSourceLocation() ?? undefined, { configuration });
}

/**
 * The two shapes after the definition: `(overrides?)` and
 * `('Name', overrides?)`. `'Default'` names the literals, so it is the same
 * as no name — the record then carries no configuration.
 */
function insertArguments(
  second: ParamOverrides | string | undefined,
  third: ParamOverrides | undefined,
): { configuration?: string; overrides?: ParamOverrides } {
  if (typeof second === "string") {
    if (second.length === 0) {
      throw new Error("insert(): the configuration name is empty — name a row of the definition's configurations(), e.g. insert(def, 'Wide').");
    }
    return { configuration: second === DEFAULT_CONFIGURATION ? undefined : second, overrides: third };
  }
  if (third !== undefined) {
    throw new Error("insert(): overrides go in the second position unless a configuration name comes first — insert(def, { Length: 380 }) or insert(def, 'Wide', { Length: 380 }).");
  }
  return { overrides: second };
}

export default insert;
