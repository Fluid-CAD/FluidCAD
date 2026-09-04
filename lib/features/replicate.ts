import {
  AssemblyMate,
  AssemblyOccurrence,
  AssemblyScene,
  ReplicaTag,
  ReplicateSeedRef,
  ReplicateSide,
} from "../rendering/assembly-scene.js";
import { SourceLocation } from "../common/scene-object.js";
import { BoundConnector, Connector } from "./connector.js";
import { BoundExposure } from "./exposed.js";
import { IConnector } from "../core/interfaces.js";
import { Instance } from "./instance.js";
import { Occurrence } from "./occurrence.js";
import { createInstance, createOccurrence } from "./insert-records.js";
import { makeAssemblyMate, makeTangentAssemblyMate } from "./mate.js";

/** What `replicate()` accepts as a seed: a handle `insert()` returned in this scope. */
export type ReplicateSeed = Instance<unknown> | Occurrence<unknown>;

/**
 * What a target column or a row cell may be: the same three side kinds
 * `mate()` accepts — `instance.connectors.<name>`, an assembly connector, or
 * `instance.features.<name>` (exposed geometry, tangent mates).
 *
 * `IConnector` is what the public `connector(name, [x, y, z])` returns to
 * user code, so it must be accepted here or the editor's type checker flags
 * every assembly connector passed to `replicate()` ("No overload matches
 * this call"); the runtime still narrows to the concrete classes.
 */
export type ReplicateTarget = BoundConnector | Connector | IConnector | BoundExposure;

type SeedInfo =
  | { kind: "instance"; handle: Instance<unknown>; id: string; name: string }
  | { kind: "occurrence"; handle: Occurrence<unknown>; id: string; name: string };

type IdMap = (id: string) => string;

/**
 * The `replicate(seed, targets, rows)` statement body. Snapshots the seed's
 * mates in this scope, validates the target columns against their OUTER
 * sides, then per row re-inserts the seed (same part template / same
 * definition + overrides), re-targets every snapshotted mate onto the
 * replica — inner sides rebound to the replica's own connectors, outer
 * sides swapped for the row's cells where listed, kept where not — and
 * tags everything with a {@link ReplicaTag}. Replicas land in the flat
 * scene as ordinary records: rendering, compare and the UI solver see
 * nothing new.
 */
export function replicateSeed(
  scene: AssemblyScene,
  seed: unknown,
  targets: unknown,
  rows: unknown,
  sourceLocation: SourceLocation | undefined,
): ReplicateSeed[] {
  const scope = scene.currentScopePath();
  const info = resolveSeed(scene, seed, scope);
  const onSeed = seedMembership(info);

  // Statement order is the contract: only mates declared BEFORE this call
  // replicate (the writer places new seed mates ahead of the statement).
  const mates = scene.getMates().filter(m => m.owner === scope && mateTouches(m, onSeed));
  if (mates.length === 0) {
    throw new Error(
      `replicate(): "${info.name}" has no mates to replicate — mate it first (a free copy is just another insert()).`,
    );
  }

  const outer = collectOuterSides(mates, onSeed);
  const columns = normalizeTargets(scene, targets, outer, info.name);
  const cells = normalizeRows(scene, rows, columns, onSeed, scope);

  const replicateId = scene.nextReplicateId();
  const produced: ReplicateSeedRef[] = [];
  const handles: ReplicateSeed[] = [];

  for (let k = 0; k < cells.length; k++) {
    const tag: ReplicaTag = { of: info.id, statement: replicateId, row: k };
    const replica = cloneSeed(scene, info, tag, k, sourceLocation);
    const mapId = idMapFor(info, replica.id);
    for (const mate of mates) {
      const retargeted = retargetMate(scene, mate, onSeed, mapId, columns, cells[k]);
      const record = mate.type === "tangent"
        ? makeTangentAssemblyMate(
          toMateArg(retargeted.a) as BoundExposure,
          toMateArg(retargeted.b) as BoundExposure,
          scene.nextMateId(),
          scope,
          sourceLocation,
        )
        : makeAssemblyMate(
          mate.type,
          toMateArg(retargeted.a) as BoundConnector | Connector,
          toMateArg(retargeted.b) as BoundConnector | Connector,
          scene.nextMateId(),
          scope,
          sourceLocation,
        );
      record.options = cloneOptions(mate.options);
      record.replica = { of: mate.mateId, statement: replicateId, row: k };
      scene.addMate(record);
    }
    produced.push(replica.ref);
    handles.push(replica.handle);
  }

  scene.addReplicate({
    replicateId,
    owner: scope,
    seed: info.kind === "instance" ? { instanceId: info.id } : { occurrenceId: info.id },
    targets: columns,
    rows: cells,
    produced,
    sourceLocation,
  });
  return handles;
}

// ---------------------------------------------------------------------------
// Seed
// ---------------------------------------------------------------------------

function resolveSeed(scene: AssemblyScene, seed: unknown, scope: string): SeedInfo {
  const base = "replicate(): the seed must be an instance or sub-assembly inserted in this assembly";
  if (seed instanceof Instance) {
    const record = seed.record;
    if (!scene.getInstances().includes(record)) {
      throw new Error(`${base} — "${record.name}" belongs to another scene.`);
    }
    if (record.owner !== scope) {
      throw new Error(`${base} — "${record.name}" was inserted inside sub-assembly "${record.owner}"; replicate it from the file that inserts it.`);
    }
    return { kind: "instance", handle: seed, id: record.instanceId, name: record.name };
  }
  if (seed instanceof Occurrence) {
    const record = seed.record;
    if (!scene.getOccurrences().includes(record)) {
      throw new Error(`${base} — "${record.name}" belongs to another scene.`);
    }
    if (record.parentPath !== scope) {
      throw new Error(`${base} — "${record.name}" was inserted inside sub-assembly "${record.parentPath}"; replicate it from the file that inserts it.`);
    }
    return { kind: "occurrence", handle: seed, id: record.occurrenceId, name: record.name };
  }
  throw new Error(`${base} (pass the handle insert() returned, e.g. replicate(cyl1, [...], [...])).`);
}

/** Whether an instance id belongs to the seed — the instance itself, or any instance under the seed occurrence's path. */
function seedMembership(info: SeedInfo): (instanceId: string) => boolean {
  if (info.kind === "instance") {
    return id => id === info.id;
  }
  const prefix = `${info.id}/`;
  return id => id === info.id || id.startsWith(prefix);
}

function idMapFor(info: SeedInfo, replicaId: string): IdMap {
  if (info.kind === "instance") {
    return id => (id === info.id ? replicaId : id);
  }
  const prefix = `${info.id}/`;
  return id => {
    if (id === info.id) {
      return replicaId;
    }
    if (id.startsWith(prefix)) {
      return `${replicaId}/${id.slice(prefix.length)}`;
    }
    return id;
  };
}

function cloneSeed(
  scene: AssemblyScene,
  info: SeedInfo,
  tag: ReplicaTag,
  row: number,
  sourceLocation: SourceLocation | undefined,
): { handle: ReplicateSeed; id: string; ref: ReplicateSeedRef } {
  // Replicas copy the seed's LOCAL warm pose — the mates place them — and
  // are never grounded (createInstance/createOccurrence start ungrounded).
  const name = `${info.name} (${row + 2})`;
  if (info.kind === "instance") {
    const seedRecord = info.handle.record;
    const handle = createInstance(scene, seedRecord.part, sourceLocation, {
      position: seedRecord.position,
      quaternion: seedRecord.quaternion,
      name,
      replica: tag,
    });
    return { handle, id: handle.record.instanceId, ref: { instanceId: handle.record.instanceId } };
  }
  const seedRecord: AssemblyOccurrence = info.handle.record;
  if (!seedRecord.definition) {
    throw new Error(
      `replicate(): "${seedRecord.name}" has no definition to re-run — insert it with insert(assembly(...)) so its body can be replayed.`,
    );
  }
  const handle = createOccurrence(scene, seedRecord.definition, seedRecord.overrides, sourceLocation, {
    position: seedRecord.position,
    quaternion: seedRecord.quaternion,
    name,
    replica: tag,
  });
  return { handle, id: handle.record.occurrenceId, ref: { occurrenceId: handle.record.occurrenceId } };
}

// ---------------------------------------------------------------------------
// Sides
// ---------------------------------------------------------------------------

function mateSides(mate: AssemblyMate): { a: ReplicateSide; b: ReplicateSide } {
  const side = (
    connector: { instanceId: string; connector: Connector } | undefined,
    frame: { connector: Connector } | undefined,
    geometry: { instanceId: string; exposed: BoundExposure["exposed"] } | undefined,
  ): ReplicateSide => {
    if (connector) {
      return { kind: "connector", instanceId: connector.instanceId, connector: connector.connector };
    }
    if (frame) {
      return { kind: "frame", connector: frame.connector };
    }
    if (geometry) {
      return { kind: "geometry", instanceId: geometry.instanceId, exposed: geometry.exposed };
    }
    throw new Error(`replicate(): mate "${mate.mateId}" has an unresolved side.`);
  };
  return {
    a: side(mate.connectorA, mate.frameA, mate.geometryA),
    b: side(mate.connectorB, mate.frameB, mate.geometryB),
  };
}

function sideOnSeed(side: ReplicateSide, onSeed: (id: string) => boolean): boolean {
  return side.kind !== "frame" && onSeed(side.instanceId);
}

function mateTouches(mate: AssemblyMate, onSeed: (id: string) => boolean): boolean {
  const { a, b } = mateSides(mate);
  return sideOnSeed(a, onSeed) || sideOnSeed(b, onSeed);
}

function sameSide(x: ReplicateSide, y: ReplicateSide): boolean {
  if (x.kind === "connector" && y.kind === "connector") {
    return x.instanceId === y.instanceId && x.connector === y.connector;
  }
  if (x.kind === "frame" && y.kind === "frame") {
    return x.connector === y.connector;
  }
  if (x.kind === "geometry" && y.kind === "geometry") {
    return x.instanceId === y.instanceId && x.exposed === y.exposed;
  }
  return false;
}

/** The seed's outer sides in mate order, deduplicated — the only legal target columns. */
function collectOuterSides(mates: AssemblyMate[], onSeed: (id: string) => boolean): ReplicateSide[] {
  const out: ReplicateSide[] = [];
  for (const mate of mates) {
    const { a, b } = mateSides(mate);
    for (const side of [a, b]) {
      if (!sideOnSeed(side, onSeed) && !out.some(o => sameSide(o, side))) {
        out.push(side);
      }
    }
  }
  return out;
}

/** A user value → side, or null when it is none of the three side kinds. */
function toSide(value: unknown): ReplicateSide | null {
  if (value instanceof BoundConnector) {
    return { kind: "connector", instanceId: value.instanceId, connector: value.connector };
  }
  if (value instanceof BoundExposure) {
    return { kind: "geometry", instanceId: value.instanceId, exposed: value.exposed };
  }
  if (value instanceof Connector) {
    if (!value.isAssemblyConnector()) {
      throw new Error(
        `replicate(): connector "${value.connectorName}" is a part connector with no instance — pass instance.connectors.${value.connectorName} from an inserted instance.`,
      );
    }
    return { kind: "frame", connector: value };
  }
  return null;
}

function toMateArg(side: ReplicateSide): BoundConnector | Connector | BoundExposure {
  if (side.kind === "connector") {
    return new BoundConnector(side.connector, side.instanceId);
  }
  if (side.kind === "frame") {
    return side.connector;
  }
  return new BoundExposure(side.exposed, side.instanceId);
}

function instanceLabel(scene: AssemblyScene, instanceId: string): string {
  return scene.getInstance(instanceId)?.name ?? instanceId;
}

function sideLabel(scene: AssemblyScene, side: ReplicateSide): string {
  if (side.kind === "connector") {
    return `${instanceLabel(scene, side.instanceId)}.${side.connector.connectorName}`;
  }
  if (side.kind === "frame") {
    return side.connector.connectorName;
  }
  return `${instanceLabel(scene, side.instanceId)}.${side.exposed.exposeName}`;
}

function describeValue(value: unknown): string {
  if (value instanceof BoundExposure) {
    return "exposed geometry";
  }
  if (value instanceof BoundConnector || value instanceof Connector) {
    return "a connector";
  }
  if (value === null) {
    return "null";
  }
  return typeof value;
}

// ---------------------------------------------------------------------------
// Targets and rows
// ---------------------------------------------------------------------------

function normalizeTargets(
  scene: AssemblyScene,
  targets: unknown,
  outer: ReplicateSide[],
  seedName: string,
): ReplicateSide[] {
  if (!Array.isArray(targets)) {
    throw new Error(
      "replicate(): the second argument lists the seed's mate targets that vary per replica, e.g. replicate(seed, [base.connectors.top], [[base.connectors.side]]).",
    );
  }
  if (targets.length === 0) {
    throw new Error("replicate(): list at least one mate target to vary per replica.");
  }
  const columns: ReplicateSide[] = [];
  const outerLabels = outer.map(s => sideLabel(scene, s)).join(", ");
  targets.forEach((target, j) => {
    const side = toSide(target);
    if (!side) {
      throw new Error(
        `replicate(): target ${j + 1} must be a connector (instance.connectors.<name> or an assembly connector) or exposed geometry (instance.features.<name>) — got ${describeValue(target)}.`,
      );
    }
    const label = sideLabel(scene, side);
    if (!outer.some(o => sameSide(o, side))) {
      throw new Error(
        `replicate(): ${label} is not a mate target of "${seedName}" — its targets are: ${outerLabels}.`,
      );
    }
    const dup = columns.findIndex(c => sameSide(c, side));
    if (dup >= 0) {
      throw new Error(`replicate(): target ${j + 1} (${label}) repeats target ${dup + 1}.`);
    }
    columns.push(side);
  });
  return columns;
}

function normalizeRows(
  scene: AssemblyScene,
  rows: unknown,
  columns: ReplicateSide[],
  onSeed: (id: string) => boolean,
  scope: string,
): ReplicateSide[][] {
  if (!Array.isArray(rows) || rows.length === 0) {
    throw new Error(
      "replicate(): at least one row (one replica) is required — each row lists the replacement for every target.",
    );
  }
  return rows.map((row, k) => {
    if (!Array.isArray(row)) {
      throw new Error(`replicate(): row ${k + 1} must be an array of replacements, one per target.`);
    }
    if (row.length !== columns.length) {
      const entries = row.length === 1 ? "entry" : "entries";
      throw new Error(
        `replicate(): row ${k + 1} has ${row.length} ${entries}, expected ${columns.length} (one per target).`,
      );
    }
    return row.map((cell, j) => normalizeCell(scene, cell, columns[j], k, j, onSeed, scope));
  });
}

function normalizeCell(
  scene: AssemblyScene,
  cell: unknown,
  column: ReplicateSide,
  k: number,
  j: number,
  onSeed: (id: string) => boolean,
  scope: string,
): ReplicateSide {
  const where = `replicate(): row ${k + 1}, column ${j + 1}`;
  const columnLabel = sideLabel(scene, column);
  const expected = column.kind === "geometry"
    ? `exposed geometry like ${columnLabel}`
    : `a connector like ${columnLabel}`;
  const side = toSide(cell);
  if (!side) {
    throw new Error(`${where} — expected ${expected}, got ${describeValue(cell)}.`);
  }
  if ((column.kind === "geometry") !== (side.kind === "geometry")) {
    throw new Error(`${where} — expected ${expected}, got ${describeValue(cell)}.`);
  }
  if (sideOnSeed(side, onSeed)) {
    throw new Error(`${where} — the replacement sits on the seed itself.`);
  }
  if (side.kind === "frame" && scope !== "") {
    throw new Error(
      `${where} — assembly connectors are root-scope only for now; mate to "${side.connector.connectorName}" from the file that declares it.`,
    );
  }
  return side;
}

// ---------------------------------------------------------------------------
// Re-targeting
// ---------------------------------------------------------------------------

/**
 * Inner side → the replica's own connector/exposure, resolved BY NAME on the
 * mapped instance record (the replica shares the seed's part template, but
 * resolving by name keeps a non-deterministic body from binding the wrong
 * object silently).
 */
function rebindInnerSide(scene: AssemblyScene, side: ReplicateSide, mapId: IdMap): ReplicateSide {
  if (side.kind === "frame") {
    return side;
  }
  const instanceId = mapId(side.instanceId);
  const record = scene.getInstance(instanceId);
  if (!record) {
    throw new Error(
      `replicate(): the replica's body did not produce "${instanceId}" — a sub-assembly must insert the same parts on every run.`,
    );
  }
  if (side.kind === "connector") {
    const name = side.connector.connectorName;
    const connector = record.part.getNamedConnectors()[name];
    if (!connector) {
      throw new Error(`replicate(): the replica "${record.name}" has no connector "${name}".`);
    }
    return { kind: "connector", instanceId, connector };
  }
  const name = side.exposed.exposeName;
  const exposed = record.part.getExposed().find(e => e.exposeName === name);
  if (!exposed) {
    throw new Error(`replicate(): the replica "${record.name}" exposes no "${name}".`);
  }
  return { kind: "geometry", instanceId, exposed };
}

function retargetMate(
  scene: AssemblyScene,
  mate: AssemblyMate,
  onSeed: (id: string) => boolean,
  mapId: IdMap,
  columns: ReplicateSide[],
  cells: ReplicateSide[],
): { a: ReplicateSide; b: ReplicateSide } {
  const { a, b } = mateSides(mate);
  const retarget = (side: ReplicateSide): ReplicateSide => {
    if (sideOnSeed(side, onSeed)) {
      return rebindInnerSide(scene, side, mapId);
    }
    const column = columns.findIndex(c => sameSide(c, side));
    return column >= 0 ? cells[column] : side;
  };
  return { a: retarget(a), b: retarget(b) };
}

function cloneOptions(options: AssemblyMate["options"]): NonNullable<AssemblyMate["options"]> {
  if (!options) {
    return {};
  }
  const out: NonNullable<AssemblyMate["options"]> = {};
  if (options.rotate !== undefined) {
    out.rotate = options.rotate;
  }
  if (options.flip !== undefined) {
    out.flip = options.flip;
  }
  if (options.offset !== undefined) {
    out.offset = [options.offset[0], options.offset[1], options.offset[2]];
  }
  if (options.limits !== undefined) {
    out.limits = [options.limits[0], options.limits[1]];
  }
  if (options.propagate !== undefined) {
    out.propagate = options.propagate;
  }
  return out;
}
