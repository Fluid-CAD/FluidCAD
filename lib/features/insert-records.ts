import {
  AssemblyInstance,
  AssemblyOccurrence,
  AssemblyScene,
  OccurrenceExport,
  Quat,
  ReplicaTag,
  Vec3,
} from "../rendering/assembly-scene.js";
import { SourceLocation } from "../common/scene-object.js";
import type { ParamOverrides } from "../param-registry.js";
import { Assembly } from "./assembly.js";
import { Instance } from "./instance.js";
import { Occurrence } from "./occurrence.js";
import { Part } from "./part.js";
import { collectedParamValues } from "./param-overrides.js";

/**
 * What a record creator may override beyond the statement defaults —
 * `replicate()` seeds a replica with its seed's local warm pose, a derived
 * display name and the replica tag; a plain `insert()` passes nothing.
 */
export type InsertRecordExtras = {
  position?: Vec3;
  quaternion?: Quat;
  name?: string;
  replica?: ReplicaTag;
};

const IDENTITY_QUAT: Quat = { x: 0, y: 0, z: 0, w: 1 };

/**
 * Record one inserted part instance in `scene` and return its handle.
 * Shared by `insert()` and `replicate()` so a replica is an ordinary
 * instance record: counter-based, per-scope id (see AssemblyScene
 * .nextInstanceId for why ids are not line-derived), never grounded at
 * creation, owner = the current scope.
 */
export function createInstance(
  scene: AssemblyScene,
  part: Part,
  sourceLocation: SourceLocation | undefined,
  extras: InsertRecordExtras = {},
): Instance<unknown> {
  const record: AssemblyInstance = {
    instanceId: scene.nextInstanceId(),
    owner: scene.currentScopePath(),
    part,
    position: extras.position ? { ...extras.position } : { x: 0, y: 0, z: 0 },
    quaternion: extras.quaternion ? { ...extras.quaternion } : { ...IDENTITY_QUAT },
    grounded: false,
    name: extras.name ?? part.name(),
    sourceLocation,
  };
  if (extras.replica) {
    record.replica = extras.replica;
  }
  scene.addInstance(record);
  return new Instance(record);
}

/**
 * Record one sub-assembly occurrence: push its scope, run the definition
 * body under that scope (always parameter-scoped, even with zero
 * overrides — an occurrence's `param()` calls are its insertion interface,
 * never the consuming file's panel), pop, and return the handle. The
 * definition and overrides stay on the record so `replicate()` can re-run
 * the same body with the same parameters.
 */
export function createOccurrence<T>(
  scene: AssemblyScene,
  definition: Assembly<T>,
  overrides: ParamOverrides | undefined,
  sourceLocation: SourceLocation | undefined,
  extras: InsertRecordExtras = {},
): Occurrence<T> {
  const record: AssemblyOccurrence = {
    occurrenceId: scene.nextOccurrenceId(),
    assemblyName: definition.assemblyName,
    name: extras.name ?? definition.assemblyName,
    parentPath: scene.currentScopePath(),
    position: extras.position ? { ...extras.position } : { x: 0, y: 0, z: 0 },
    quaternion: extras.quaternion ? { ...extras.quaternion } : { ...IDENTITY_QUAT },
    grounded: false,
    sourceLocation,
    definition: definition as Assembly<unknown>,
    overrides,
  };
  if (extras.replica) {
    record.replica = extras.replica;
  }
  scene.beginOccurrence(record);
  let parts: T;
  try {
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
 * plain-object nesting into key paths (`{ left: { p1 } }` → `["left", "p1"]`)
 * and arrays into index keys (`{ copies: [a, b] }` → `["copies", "0"]`, so
 * the handles `replicate()` returns stay addressable when a body exports
 * them). Depth-capped and cycle-guarded — a self-referential return must not
 * hang the render; exotic objects are skipped (they have no stable member
 * path the writer could render).
 */
export function collectOccurrenceExports(parts: unknown): OccurrenceExport[] {
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
    if (path.length >= 4 || value === null || typeof value !== "object" || seen.has(value)) {
      return;
    }
    if (Array.isArray(value)) {
      seen.add(value);
      value.forEach((child, index) => walk(child, [...path, String(index)]));
      return;
    }
    if (Object.getPrototypeOf(value) !== Object.prototype) {
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
