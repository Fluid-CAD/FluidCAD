import { captureSourceLocation } from "../index.js";
import { getCurrentScene } from "../scene-manager.js";
import { AssemblyScene, AssemblyInstance, AssemblyOccurrence } from "../rendering/assembly-scene.js";
import { Part } from "../features/part.js";
import { Assembly } from "../features/assembly.js";
import { Instance } from "../features/instance.js";
import { Occurrence } from "../features/occurrence.js";
import { Connector, BoundConnector } from "../features/connector.js";
import { IPart } from "./interfaces.js";

function insert<P extends IPart>(part: P): Instance<P>;
function insert<T>(definition: Assembly<T>): Occurrence<T>;
function insert(target: unknown): Instance<unknown> | Occurrence<unknown> {
  const scene = getCurrentScene();
  if (!(scene instanceof AssemblyScene)) {
    throw new Error("insert() can only be used in *.assembly.js files.");
  }
  if (target instanceof Assembly) {
    return insertOccurrence(scene, target);
  }
  if (!(target instanceof Part)) {
    throw new Error("insert(): expected a Part or an assembly(...) definition — got " + typeof target + ".");
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
    part: target,
    position: { x: 0, y: 0, z: 0 },
    quaternion: { x: 0, y: 0, z: 0, w: 1 },
    grounded: false,
    name: target.name(),
    sourceLocation: sourceLocation ?? undefined,
  };
  scene.addInstance(record);
  return new Instance(record);
}

function insertOccurrence<T>(scene: AssemblyScene, definition: Assembly<T>): Occurrence<T> {
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
    parts = definition.run();
  } finally {
    scene.endOccurrence();
  }
  return new Occurrence<T>(record, parts, collectOwnConnectors(scene, record.occurrenceId));
}

/**
 * The occurrence's public connectors: assembly-scoped `connector()`
 * statements declared in THIS assembly's own body (ownerPath === the
 * occurrence path). A connector declared here may bind to an instance
 * nested deeper (e.g. `connector('m', xAxisOcc.parts.beam.select(...))`) —
 * it still belongs to this occurrence's interface, which is why attribution
 * runs on the declaration scope, not the bound instance's owner.
 */
function collectOwnConnectors(scene: AssemblyScene, occurrenceId: string): Record<string, BoundConnector> {
  const out: Record<string, BoundConnector> = {};
  for (const obj of scene.getAllSceneObjects()) {
    if (obj instanceof Connector && obj.ownerPath === occurrenceId && obj.boundInstanceId !== undefined) {
      out[obj.connectorName] = obj.boundTo(obj.boundInstanceId);
    }
  }
  return out;
}

export default insert;
