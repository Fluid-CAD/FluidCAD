import { Scene } from "./scene.js";
import { Part } from "../features/part.js";
import { Connector } from "../features/connector.js";
import { Exposed } from "../features/exposed.js";
import { SourceLocation } from "../common/scene-object.js";
import type { ParamDefinition, ParamOverrides, ParamVal } from "../param-registry.js";
import type { Assembly } from "../features/assembly.js";
import { serializableParamDefs } from "../features/param-overrides.js";
import { Quaternion } from "../math/quaternion.js";
import { Vector3d } from "../math/vector3d.js";

export type Vec3 = { x: number; y: number; z: number };
export type Quat = { x: number; y: number; z: number; w: number };

/**
 * Stamped on every record a `replicate()` statement produced: `of` is the
 * SEED record's id (instance, occurrence or mate id — whichever kind this
 * record is), `statement` the replicate record's id, `row` the 0-based row
 * that produced it. The UI gates statement writebacks on it the way it
 * gates occurrence-owned records: the replica's statement is the
 * `replicate()` call, not an `insert()` of its own.
 */
export type ReplicaTag = { of: string; statement: string; row: number };

export type AssemblyInstance = {
  instanceId: string;
  /** Owning scope: "" for the root assembly, else an occurrence path ("asm-0", "asm-0/asm-1"). */
  owner: string;
  part: Part;
  /** Warm-start pose, LOCAL to the owning scope's frame. */
  position: Vec3;
  quaternion: Quat;
  /**
   * Declared flag: fixed in the OWNING assembly's frame (the assembly's
   * anchor). Becomes world grounding only when the owning scope is
   * ground-connected — see scopeGroundConnected().
   */
  grounded: boolean;
  name: string;
  sourceLocation?: SourceLocation;
  /** Present on a replica: the seed instance, the replicate statement, the row. */
  replica?: ReplicaTag;
};

/**
 * One handle the occurrence's callback RETURNED, addressed by its key path
 * within the return object (plain-object nesting flattened into the path:
 * `{ left: { p1 } }` → `["left", "p1"]`). This is what makes a nested
 * instance referenceable from the inserting file — the mate writer renders
 * `<occBinding>.parts.<path...>.connectors.<name>` from it. Exactly one of
 * `instanceId`/`occurrenceId` is set.
 */
export type OccurrenceExport = {
  path: string[];
  instanceId?: string;
  occurrenceId?: string;
};

/**
 * One inserted sub-assembly: `insert(assembly('name', cb))`. The callback's
 * records all land in this same flat scene (rendering, compare, and the UI
 * solver keep seeing a flat assembly), tagged with the occurrence path as
 * their owner.
 */
export type AssemblyOccurrence = {
  /** Path id: parentPath + "/asm-N" (root scope: just "asm-N"). */
  occurrenceId: string;
  /** The assembly('name', …) definition name. */
  assemblyName: string;
  /** Display name — defaults to assemblyName, overridden by .name(). */
  name: string;
  parentPath: string;
  /** Warm-start pose of this occurrence's frame, local to the parent scope. */
  position: Vec3;
  quaternion: Quat;
  /** .grounded() on the handle: this frame is fixed in the parent scope. */
  grounded: boolean;
  /** The definition's `param()` interface, collected while this occurrence's body ran. */
  params?: ParamDefinition[];
  /** Resolved parameter values of this occurrence's run. */
  paramValues?: Record<string, ParamVal>;
  /** Handles the callback returned — always set on insert (possibly empty). */
  exports?: OccurrenceExport[];
  sourceLocation?: SourceLocation;
  /**
   * The definition this occurrence ran, with the overrides it was inserted
   * with — live refs, never serialized. `replicate()` re-runs the body from
   * these so a replica is the same sub-assembly with the same parameters.
   */
  definition?: Assembly<unknown>;
  overrides?: ParamOverrides;
  /** Present on a replica: the seed occurrence, the replicate statement, the row. */
  replica?: ReplicaTag;
};

export type MateType =
  | 'fastened'
  | 'revolute'
  | 'slider'
  | 'cylindrical'
  | 'planar'
  | 'parallel'
  | 'pin-slot'
  | 'tangent';

export type MateOptions = {
  rotate?: number;
  flip?: boolean;
  offset?: [number, number, number];
  limits?: [number, number];
  /** Tangent only: false = contact restricted to the picked seed ( `.noPropagate()` ). Absent = on. */
  propagate?: boolean;
};

/** Wire form of a tangent mate side: the exposure is resolved per instance. */
export type MateGeometrySide = { instanceId: string; exposeName: string };

/**
 * Wire form of an assembly-connector mate side: a `connector('name', [x, y,
 * z])` declared at assembly level, referenced by its scene id. The UI
 * solver pins every assembly connector on one synthetic grounded world
 * body, so the side needs no instance.
 */
export type MateFrameSide = { connectorId: string };

/**
 * One assembly connector as the UI reads it: the built frame in assembly
 * coordinates (root scope only in v1, so local equals world) plus the
 * statement to edit. `connectorId` is read live at serialize time — the
 * same staleness rule as mate sides.
 */
export type SerializedAssemblyConnector = {
  connectorId: string;
  name: string;
  /** Scope path the statement ran in; "" for the root assembly (v1: always). */
  owner: string;
  origin: Vec3;
  xDirection: Vec3;
  yDirection: Vec3;
  normal: Vec3;
  sourceLocation?: SourceLocation;
};

/**
 * Live mate record. `connectorA/B.connector` is a live SceneObject
 * reference, not a snapshotted id. SceneCompare may rewrite a Connector's
 * id during scene-diff to inherit the prior render's id; reading
 * `connector.id` at serialize time picks up that rewrite, while a
 * snapshotted id taken at mate() call time would point at the
 * fresh-UUID value before the inherit. Mirrors how `AssemblyInstance`
 * keeps a live `part: Part` ref and reads `part.id` live.
 *
 * Sides are per-type: lower-pair mates carry two connector sides (either
 * of which may instead be an assembly-connector side — a live `Connector`
 * ref, no instance); tangent mates carry two geometry sides (live `Exposed`
 * refs, names read at serialize time for the same staleness reason as
 * connector ids).
 */
export type AssemblyMate = {
  mateId: string;
  /** Scope the mate() statement ran in: "" for root, else an occurrence path. */
  owner: string;
  type: MateType;
  options?: MateOptions;
  sourceLocation?: SourceLocation;
  /** Assembly-connector sides — lower-pair mates only, at most one of the two. */
  frameA?: { connector: Connector };
  frameB?: { connector: Connector };
  /** Present on a replicated mate: the seed mate, the replicate statement, the row. */
  replica?: ReplicaTag;
} & (
  | {
    connectorA?: { instanceId: string; connector: Connector };
    connectorB?: { instanceId: string; connector: Connector };
    geometryA?: undefined;
    geometryB?: undefined;
  }
  | {
    connectorA?: undefined;
    connectorB?: undefined;
    geometryA: { instanceId: string; exposed: Exposed };
    geometryB: { instanceId: string; exposed: Exposed };
  }
);

export type SerializedInstance = {
  instanceId: string;
  partId: string;
  partName: string;
  /** World warm-start pose — occurrence-chain transforms already composed in. */
  position: Vec3;
  quaternion: Quat;
  /** EFFECTIVE grounding (scoped-grounding rule applied) — what the solver pins. */
  grounded: boolean;
  /** Owning scope path; "" for root-scope instances. */
  owner: string;
  name: string;
  /** Resolved parameter values of the instance's template variant (insert-path builds only). */
  paramValues?: Record<string, ParamVal>;
  sourceLocation?: SourceLocation;
  /** Present on a replica produced by a `replicate()` statement. */
  replica?: ReplicaTag;
};

export type SerializedOccurrence = {
  occurrenceId: string;
  assemblyName: string;
  name: string;
  parentPath: string;
  /** Local to the parent scope's frame (writeback-friendly), NOT world. */
  position: Vec3;
  quaternion: Quat;
  /** Declared .grounded() on the occurrence handle. */
  grounded: boolean;
  /** Whether the grounded-frame chain reaches the root from here. */
  groundConnected: boolean;
  /** Control metadata for per-occurrence parameter editing (sourceLocation stripped). */
  params?: Omit<ParamDefinition, 'sourceLocation'>[];
  /** Resolved parameter values of this occurrence's run. */
  paramValues?: Record<string, ParamVal>;
  /**
   * Handles the callback returned, keyed by return-object path — what the
   * mate writer dereferences as `<binding>.parts.<path...>`. Always an
   * array (possibly empty) on current engines; absent only on engines
   * predating occurrence exports.
   */
  exports?: OccurrenceExport[];
  sourceLocation?: SourceLocation;
  /** Present on a replica produced by a `replicate()` statement. */
  replica?: ReplicaTag;
};

export type SerializedMate = {
  mateId: string;
  owner: string;
  type: MateType;
  /** Connector sides — every mate type except tangent. */
  connectorA?: { instanceId: string; connectorId: string };
  connectorB?: { instanceId: string; connectorId: string };
  /** Geometry sides — tangent mates only. */
  geometryA?: MateGeometrySide;
  geometryB?: MateGeometrySide;
  /** Assembly-connector sides — lower-pair mates only, at most one of the two. */
  frameA?: MateFrameSide;
  frameB?: MateFrameSide;
  status: 'satisfied' | 'redundant' | 'inconsistent';
  options?: MateOptions;
  sourceLocation?: SourceLocation;
  /** Present on a replicated mate produced by a `replicate()` statement. */
  replica?: ReplicaTag;
};

/**
 * One mate side as `replicate()` holds it: a part connector bound to an
 * instance, an assembly connector (no instance), or exposed geometry bound
 * to an instance — the same three side kinds `mate()` accepts, in one
 * discriminated shape. Live refs; ids are read at serialize time (same
 * staleness rule as mate sides).
 */
export type ReplicateSide =
  | { kind: 'connector'; instanceId: string; connector: Connector }
  | { kind: 'frame'; connector: Connector }
  | { kind: 'geometry'; instanceId: string; exposed: Exposed };

/** Wire form of {@link ReplicateSide}. */
export type SerializedReplicateSide =
  | { kind: 'connector'; instanceId: string; connectorId: string }
  | { kind: 'frame'; connectorId: string }
  | { kind: 'geometry'; instanceId: string; exposeName: string };

/** The seed of a replicate statement — exactly one of the two ids is set. */
export type ReplicateSeedRef = { instanceId?: string; occurrenceId?: string };

/**
 * One `replicate(seed, targets, rows)` statement. `targets` are the seed's
 * outer mate sides that vary per replica (the columns); `rows[k][j]`
 * replaces `targets[j]` in replica `k`'s mates. `produced[k]` is the record
 * replica `k` became — its instances/mates carry a {@link ReplicaTag}
 * pointing back here.
 */
export type AssemblyReplicate = {
  /** Per-scope counter id, path-qualified like instance ids: `rep-N`, `asm-0/rep-N`. */
  replicateId: string;
  /** Scope the statement ran in: "" for root, else an occurrence path. */
  owner: string;
  seed: ReplicateSeedRef;
  targets: ReplicateSide[];
  rows: ReplicateSide[][];
  produced: ReplicateSeedRef[];
  sourceLocation?: SourceLocation;
};

export type SerializedReplicate = {
  replicateId: string;
  owner: string;
  seed: ReplicateSeedRef;
  targets: SerializedReplicateSide[];
  rows: SerializedReplicateSide[][];
  produced: ReplicateSeedRef[];
  sourceLocation?: SourceLocation;
};

function serializeReplicateSide(side: ReplicateSide): SerializedReplicateSide {
  if (side.kind === 'connector') {
    return { kind: 'connector', instanceId: side.instanceId, connectorId: side.connector.id };
  }
  if (side.kind === 'frame') {
    return { kind: 'frame', connectorId: side.connector.id };
  }
  return { kind: 'geometry', instanceId: side.instanceId, exposeName: side.exposed.exposeName };
}

type Pose = { position: Vec3; quaternion: Quat };

const IDENTITY_POSE: Pose = {
  position: { x: 0, y: 0, z: 0 },
  quaternion: { x: 0, y: 0, z: 0, w: 1 },
};

/** parent ∘ local — rotate the local offset into the parent frame, chain the rotations. */
function composePose(parent: Pose, localPosition: Vec3, localQuaternion: Quat): Pose {
  const pq = new Quaternion(parent.quaternion.x, parent.quaternion.y, parent.quaternion.z, parent.quaternion.w);
  const lq = new Quaternion(localQuaternion.x, localQuaternion.y, localQuaternion.z, localQuaternion.w);
  const q = pq.multiply(lq);
  const rotated = pq.rotateVector(new Vector3d(localPosition.x, localPosition.y, localPosition.z));
  return {
    position: {
      x: parent.position.x + rotated.x,
      y: parent.position.y + rotated.y,
      z: parent.position.z + rotated.z,
    },
    quaternion: { x: q.x, y: q.y, z: q.z, w: q.w },
  };
}

export class AssemblyScene extends Scene {
  private _instances: AssemblyInstance[] = [];
  private _mates: AssemblyMate[] = [];
  private _occurrences: AssemblyOccurrence[] = [];
  /** Connectors declared at assembly level (`connector('name', [x, y, z])`), in statement order. */
  private _connectors: Connector[] = [];
  /** `replicate()` statements, in statement order. */
  private _replicates: AssemblyReplicate[] = [];
  /** Occurrence paths currently executing — insert(assembly) runs its callback under its path. */
  private _scopeStack: string[] = [];

  private _definitions: { assemblyName: string; wasRun(): boolean }[] = [];

  currentScopePath(): string {
    return this._scopeStack.length > 0 ? this._scopeStack[this._scopeStack.length - 1] : "";
  }

  /**
   * Counter-based ids, stable across source edits (see insert.ts for why
   * line-derived ids collided) — but counted PER SCOPE and path-qualified,
   * so editing the parent file never renumbers a sub-assembly's instances
   * and two occurrences of the same definition can't interleave.
   */
  nextInstanceId(): string {
    const owner = this.currentScopePath();
    const local = `inst-${this._instances.filter(i => i.owner === owner).length}`;
    return owner ? `${owner}/${local}` : local;
  }

  nextMateId(): string {
    const owner = this.currentScopePath();
    const local = `mate-${this._mates.filter(m => m.owner === owner).length}`;
    return owner ? `${owner}/${local}` : local;
  }

  nextOccurrenceId(): string {
    const parent = this.currentScopePath();
    const local = `asm-${this._occurrences.filter(o => o.parentPath === parent).length}`;
    return parent ? `${parent}/${local}` : local;
  }

  beginOccurrence(record: AssemblyOccurrence): void {
    this._occurrences.push(record);
    this._scopeStack.push(record.occurrenceId);
  }

  endOccurrence(): void {
    if (this._scopeStack.length === 0) {
      throw new Error("endOccurrence(): no occurrence scope is active.");
    }
    this._scopeStack.pop();
  }

  addInstance(instance: AssemblyInstance): void {
    this._instances.push(instance);
  }

  addMate(mate: AssemblyMate): void {
    this._mates.push(mate);
  }

  registerAssemblyConnector(connector: Connector): void {
    this._connectors.push(connector);
  }

  getAssemblyConnectors(): Connector[] {
    return this._connectors;
  }

  /**
   * The assembly's own connectors with their built frames. A connector whose
   * build failed has no frame and is skipped — the mate referencing it will
   * report its side as unresolved, and the statement's error shows on the
   * render object itself.
   */
  getSerializedAssemblyConnectors(): SerializedAssemblyConnector[] {
    const out: SerializedAssemblyConnector[] = [];
    for (const connector of this._connectors) {
      let frame;
      try {
        frame = connector.getFrame();
      } catch {
        continue;
      }
      out.push({
        connectorId: connector.id,
        name: connector.connectorName,
        owner: connector.owner ?? "",
        origin: { x: frame.origin.x, y: frame.origin.y, z: frame.origin.z },
        xDirection: { x: frame.xDirection.x, y: frame.xDirection.y, z: frame.xDirection.z },
        yDirection: { x: frame.yDirection.x, y: frame.yDirection.y, z: frame.yDirection.z },
        normal: { x: frame.normal.x, y: frame.normal.y, z: frame.normal.z },
        sourceLocation: connector.getSourceLocation() ?? undefined,
      });
    }
    return out;
  }

  getInstances(): AssemblyInstance[] {
    return this._instances;
  }

  getInstance(instanceId: string): AssemblyInstance | null {
    return this._instances.find(i => i.instanceId === instanceId) ?? null;
  }

  getOccurrences(): AssemblyOccurrence[] {
    return this._occurrences;
  }

  /**
   * Every `assembly()` definition created while this scene was current —
   * used after an entry render to name definitions that were declared but
   * never run (nothing exported or inserted them), which would otherwise
   * render a silently empty scene.
   */
  trackDefinition(definition: { assemblyName: string; wasRun(): boolean }): void {
    this._definitions.push(definition);
  }

  /**
   * Names of never-run definitions, reported only when the scene ended
   * EMPTY — a scene with instances means composition happened and unused
   * definitions are legitimate (e.g. a conditional picking one of two).
   */
  getDanglingDefinitionNames(): string[] {
    if (this._instances.length > 0 || this._occurrences.length > 0) {
      return [];
    }
    return this._definitions.filter(d => !d.wasRun()).map(d => d.assemblyName);
  }

  getMates(): AssemblyMate[] {
    return this._mates;
  }

  /** Counter-based, per scope and path-qualified — see nextInstanceId. */
  nextReplicateId(): string {
    const owner = this.currentScopePath();
    const local = `rep-${this._replicates.filter(r => r.owner === owner).length}`;
    return owner ? `${owner}/${local}` : local;
  }

  addReplicate(replicate: AssemblyReplicate): void {
    this._replicates.push(replicate);
  }

  getReplicates(): AssemblyReplicate[] {
    return this._replicates;
  }

  getSerializedReplicates(): SerializedReplicate[] {
    // Connector ids / exposure names read live at serialize time — same
    // SceneCompare staleness rule as mate sides.
    return this._replicates.map(rep => ({
      replicateId: rep.replicateId,
      owner: rep.owner,
      seed: { ...rep.seed },
      targets: rep.targets.map(serializeReplicateSide),
      rows: rep.rows.map(row => row.map(serializeReplicateSide)),
      produced: rep.produced.map(p => ({ ...p })),
      sourceLocation: rep.sourceLocation,
    }));
  }

  ground(instanceId: string): void {
    for (const inst of this._instances) {
      if (inst.instanceId === instanceId) {
        inst.grounded = true;
      }
    }
  }

  /**
   * The scoped-grounding rule. A scope is ground-connected when the chain
   * of `.grounded()` declarations reaches the root: the root scope always
   * is; an occurrence scope is iff its own handle was grounded AND its
   * parent scope is. Declared `grounded` flags inside an assembly body mean
   * "fixed in THIS assembly's frame" and only become world grounding when
   * that frame chain is grounded all the way up — which is what removes the
   * old "pass grounded=false when composing" parameter hack.
   *
   * Creation order guarantees a parent occurrence precedes its children
   * (a child occurrence is created during its parent's callback), so one
   * forward pass resolves the chain.
   */
  private scopeGroundConnected(): Map<string, boolean> {
    const connected = new Map<string, boolean>([["", true]]);
    for (const occ of this._occurrences) {
      connected.set(occ.occurrenceId, occ.grounded && (connected.get(occ.parentPath) ?? false));
    }
    return connected;
  }

  /** World pose of each occurrence frame — parent-chain composition, one forward pass. */
  private occurrenceWorldPoses(): Map<string, Pose> {
    const world = new Map<string, Pose>([["", IDENTITY_POSE]]);
    for (const occ of this._occurrences) {
      world.set(
        occ.occurrenceId,
        composePose(world.get(occ.parentPath) ?? IDENTITY_POSE, occ.position, occ.quaternion),
      );
    }
    return world;
  }

  /**
   * A grounded occurrence whose assembly declared no grounded instance
   * still needs something pinned — otherwise `.grounded()` on the handle
   * would be a silent no-op. Its first directly-owned instance stands in
   * as the anchor.
   */
  private fallbackAnchors(connected: Map<string, boolean>): Set<AssemblyInstance> {
    const anchors = new Set<AssemblyInstance>();
    for (const occ of this._occurrences) {
      if (!connected.get(occ.occurrenceId)) {
        continue;
      }
      const owned = this._instances.filter(i => i.owner === occ.occurrenceId);
      if (owned.length > 0 && !owned.some(i => i.grounded)) {
        anchors.add(owned[0]);
      }
    }
    return anchors;
  }

  getSerializedInstances(): SerializedInstance[] {
    const connected = this.scopeGroundConnected();
    const world = this.occurrenceWorldPoses();
    const anchors = this.fallbackAnchors(connected);
    return this._instances.map(inst => {
      const pose = composePose(world.get(inst.owner) ?? IDENTITY_POSE, inst.position, inst.quaternion);
      return {
        instanceId: inst.instanceId,
        // Read live from inst.part — SceneCompare.inheritIdentityFrom may
        // rewrite Part.id after the AssemblyInstance was created, so any
        // value snapshotted at insert() time would be stale by render time.
        partId: inst.part.id,
        partName: inst.part.partName,
        position: pose.position,
        quaternion: pose.quaternion,
        grounded: (inst.grounded && (connected.get(inst.owner) ?? false)) || anchors.has(inst),
        owner: inst.owner,
        name: inst.name,
        paramValues: inst.part.paramValues,
        sourceLocation: inst.sourceLocation,
        replica: inst.replica,
      };
    });
  }

  getSerializedOccurrences(): SerializedOccurrence[] {
    const connected = this.scopeGroundConnected();
    return this._occurrences.map(occ => ({
      occurrenceId: occ.occurrenceId,
      assemblyName: occ.assemblyName,
      name: occ.name,
      parentPath: occ.parentPath,
      position: occ.position,
      quaternion: occ.quaternion,
      grounded: occ.grounded,
      groundConnected: connected.get(occ.occurrenceId) ?? false,
      params: occ.params ? serializableParamDefs(occ.params) : undefined,
      paramValues: occ.paramValues,
      exports: occ.exports ?? [],
      sourceLocation: occ.sourceLocation,
      replica: occ.replica,
    }));
  }

  getSerializedMates(): SerializedMate[] {
    // Read connector ids / exposure names live — SceneCompare's
    // inheritIdentityFrom may have rewritten them after the mate was added
    // during parse.
    return this._mates.map(mate => ({
      mateId: mate.mateId,
      owner: mate.owner,
      type: mate.type,
      connectorA: mate.connectorA && {
        instanceId: mate.connectorA.instanceId,
        connectorId: mate.connectorA.connector.id,
      },
      connectorB: mate.connectorB && {
        instanceId: mate.connectorB.instanceId,
        connectorId: mate.connectorB.connector.id,
      },
      geometryA: mate.geometryA && {
        instanceId: mate.geometryA.instanceId,
        exposeName: mate.geometryA.exposed.exposeName,
      },
      geometryB: mate.geometryB && {
        instanceId: mate.geometryB.instanceId,
        exposeName: mate.geometryB.exposed.exposeName,
      },
      frameA: mate.frameA && { connectorId: mate.frameA.connector.id },
      frameB: mate.frameB && { connectorId: mate.frameB.connector.id },
      // Parse-time placeholder: the UI solver evaluates real mate
      // health per solve (SolverOutput.failed) and overrides this live
      // via matesWithStatus — the server never re-checks it.
      status: 'satisfied',
      options: mate.options,
      sourceLocation: mate.sourceLocation,
      replica: mate.replica,
    }));
  }
}
