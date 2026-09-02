import { captureSourceLocation } from "../index.js";
import { getCurrentScene } from "../scene-manager.js";
import { AssemblyScene, AssemblyInstance, AssemblyOccurrence, OccurrenceExport } from "../rendering/assembly-scene.js";
import { Part } from "../features/part.js";
import { PartDefinition } from "../features/part-definition.js";
import { Assembly } from "../features/assembly.js";
import { Instance } from "../features/instance.js";
import { Occurrence } from "../features/occurrence.js";
import { collectedParamValues, validateParamOverrides } from "../features/param-overrides.js";
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
    return insertOccurrence(scene, target, overrides);
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

  const sourceLocation = captureSourceLocation();
  // Counter-based id, stable across source edits. Source-line-derived ids
  // collided when a blank-line insertion shifted later inserts onto a row
  // already used by an earlier one (e.g. new `right` landing on old `front`'s
  // `line:col`), and the UI controller's instance map keyed off id would then
  // reuse the wrong part's mesh. `sourceLocation` is preserved separately on
  // the record for drag-release `.translate(...)` writeback. Ids are counted
  // per scope and path-qualified — see AssemblyScene.nextInstanceId.
  const record: AssemblyInstance = {
    instanceId: scene.nextInstanceId(),
    owner: scene.currentScopePath(),
    part: partObj,
    position: { x: 0, y: 0, z: 0 },
    quaternion: { x: 0, y: 0, z: 0, w: 1 },
    grounded: false,
    name: partObj.name(),
    sourceLocation: sourceLocation ?? undefined,
  };
  scene.addInstance(record);
  return new Instance(record);
}

function insertOccurrence<T>(scene: AssemblyScene, definition: Assembly<T>, overrides?: ParamOverrides): Occurrence<T> {
  const sourceLocation = captureSourceLocation();
  const record: AssemblyOccurrence = {
    occurrenceId: scene.nextOccurrenceId(),
    assemblyName: definition.assemblyName,
    name: definition.assemblyName,
    parentPath: scene.currentScopePath(),
    position: { x: 0, y: 0, z: 0 },
    quaternion: { x: 0, y: 0, z: 0, w: 1 },
    grounded: false,
    sourceLocation: sourceLocation ?? undefined,
  };
  scene.beginOccurrence(record);
  let parts: T;
  try {
    // Always scoped (even with zero overrides): an occurrence's param()
    // calls are its insertion interface, never the consuming file's panel.
    const run = definition.runScoped(overrides ?? {});
    parts = run.parts;
    if (run.scope.collected.size > 0) {
      record.params = Array.from(run.scope.collected.values());
      record.paramValues = collectedParamValues(run.scope);
    }
  } finally {
    scene.endOccurrence();
  }
  // The return value is the occurrence's export surface: whatever handles it
  // chose to expose become addressable from the inserting file as
  // `occ.parts.<path...>` — recorded here so the serialized scene can tell
  // the mate writer HOW to spell a reference into this occurrence.
  record.exports = collectOccurrenceExports(parts);
  return new Occurrence<T>(record, parts);
}

/**
 * Walk the callback's return value for Instance/Occurrence handles, flattening
 * plain-object nesting into key paths (`{ left: { p1 } }` → `["left", "p1"]`).
 * Depth-capped and cycle-guarded — a self-referential return must not hang the
 * render; arrays and exotic objects are skipped (they have no stable member
 * path the writer could render).
 */
function collectOccurrenceExports(parts: unknown): OccurrenceExport[] {
  const out: OccurrenceExport[] = [];
  const seen = new Set<object>();
  const walk = (value: unknown, path: string[]): void => {
    if (value instanceof Instance) {
      out.push({ path, instanceId: value.record.instanceId });
      return;
    }
    if (value instanceof Occurrence) {
      out.push({ path, occurrenceId: value.record.occurrenceId });
      return;
    }
    if (
      path.length >= 4
      || value === null
      || typeof value !== "object"
      || Array.isArray(value)
      || Object.getPrototypeOf(value) !== Object.prototype
      || seen.has(value)
    ) {
      return;
    }
    seen.add(value);
    for (const [key, child] of Object.entries(value)) {
      walk(child, [...path, key]);
    }
  };
  walk(parts, []);
  return out;
}

export default insert;
