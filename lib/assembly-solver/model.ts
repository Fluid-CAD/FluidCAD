// An assembly as the solver sees it, built from one render's records.
//
// A render describes an assembly as plain records: the instances with their
// statement poses, the mates and relations by id, the assembly's own
// connectors, and — per part — the connector frames and classified
// exposures every instance of that part carries. The solver wants rigid
// bodies carrying frames. This is the one place that turns the first into
// the second, so the viewer (which solves on every drag frame) and the
// engine (which solves once per render, for everything that asks where the
// parts sit) hand the solver the same bodies in the same order: the solve
// picks an ungrounded component's root by input order, so two builders that
// disagreed about it would settle the same assembly in two places.

import { Quaternion, Vector3, type QuatLike, type Vec3Like } from './math.js';
import { makeWorldBody, matesReferenceWorld, worldConnectorRef } from './world-body.js';
import type {
  BodyState,
  ConnectorFrame,
  ConnectorState,
  ContactEntity,
  ContactState,
  MateRecord,
  RelationRecord,
  SolverInput,
} from './types.js';

/** One `expose()` publication of a part with its classified contact geometry. */
export type ExposureContact = {
  name: string;
  /** Null (or absent): the surface form is one a tangent mate cannot solve against. */
  seed?: ContactEntity | null;
  chain?: ContactEntity[];
};

/** What a part gives every instance of it. */
export type PartMateGeometry = {
  connectors: readonly ConnectorFrame[];
  exposures: readonly ExposureContact[];
};

/** A rigid placement in the world frame. */
export type SolvePose = { position: Vec3Like; quaternion: QuatLike };

/** One instance, at its statement pose. */
export type SolveInstance = SolvePose & {
  instanceId: string;
  partId: string;
  /** Effective grounding — what the solve pins. */
  grounded: boolean;
};

/** One mate as a render lists it; `frameA` / `frameB` name an assembly connector. */
export type SolveMate = {
  mateId: string;
  type: MateRecord['type'];
  connectorA?: { instanceId: string; connectorId: string };
  connectorB?: { instanceId: string; connectorId: string };
  geometryA?: { instanceId: string; exposeName: string };
  geometryB?: { instanceId: string; exposeName: string };
  frameA?: { connectorId: string };
  frameB?: { connectorId: string };
  options?: MateRecord['options'];
};

/** One relation as a render lists it. */
export type SolveRelation = {
  relationId: string;
  type: RelationRecord['type'];
  mateA: string;
  mateB: string;
  ratio: number;
  reverse: boolean;
};

export type AssemblySolveSource = {
  /** In record order — the order the solve reads them in. */
  instances: readonly SolveInstance[];
  mates: readonly SolveMate[];
  relations?: readonly SolveRelation[];
  /** The assembly's own connectors (`connector('name', [x, y, z])` at its top level). */
  connectors?: readonly ConnectorFrame[];
  /** A part's connector frames and exposures; null when the render holds no such part. */
  partGeometry(partId: string): PartMateGeometry | null;
};

/** The frames and contacts one body carries — shared by every instance of its part, never mutated. */
export type BodyGeometry = {
  connectors: ConnectorState[];
  contacts: ContactState[];
};

/** What one solve runs against, where it differs from the records. */
export type SolveInputOptions = {
  /**
   * Where an instance sits now; absent, every instance is at its statement
   * pose. An instance it answers null for is left out of the solve (the
   * viewer draws no group for it).
   */
  poseOf?: (instanceId: string) => SolvePose | null;
  /** Bodies beyond the instances (a dialog's preview clones), after them in the input. */
  extraBodies?: readonly BodyState[];
  /** The mates to solve, when not the records' own (a dialog's candidate among them). */
  mates?: MateRecord[];
  /** The relations to solve, when not the records' own. */
  relations?: RelationRecord[];
};

const NO_GEOMETRY: BodyGeometry = { connectors: [], contacts: [] };

export class AssemblySolverModel {
  /** The records' mates, as the solver takes them. */
  readonly mates: MateRecord[];
  /** The records' relations, as the solver takes them. */
  readonly relations: RelationRecord[];

  private readonly instances: readonly SolveInstance[];
  private readonly worldConnectors: readonly ConnectorFrame[];
  private readonly partGeometry: (partId: string) => PartMateGeometry | null;
  private readonly geometryByPart = new Map<string, BodyGeometry>();
  private readonly instancesById = new Map<string, SolveInstance>();

  constructor(source: AssemblySolveSource) {
    this.instances = source.instances;
    this.worldConnectors = source.connectors ?? [];
    this.partGeometry = source.partGeometry;
    this.mates = source.mates.map(AssemblySolverModel.mateRecord);
    this.relations = (source.relations ?? []).map(AssemblySolverModel.relationRecord);
    for (const instance of source.instances) {
      this.instancesById.set(instance.instanceId, instance);
    }
  }

  /** An assembly with nothing in it — what a viewer holds before its first render. */
  static empty(): AssemblySolverModel {
    return new AssemblySolverModel({ instances: [], mates: [], partGeometry: () => null });
  }

  /**
   * The solver's record of a mate. An assembly-connector side becomes an
   * ordinary connector reference on the synthetic grounded world body, so
   * the solver needs no notion of a frame without an instance.
   */
  static mateRecord(mate: SolveMate): MateRecord {
    return {
      mateId: mate.mateId,
      type: mate.type,
      connectorA: mate.frameA ? worldConnectorRef(mate.frameA) : mate.connectorA,
      connectorB: mate.frameB ? worldConnectorRef(mate.frameB) : mate.connectorB,
      geometryA: mate.geometryA,
      geometryB: mate.geometryB,
      options: mate.options,
    };
  }

  static relationRecord(relation: SolveRelation): RelationRecord {
    return {
      relationId: relation.relationId,
      type: relation.type,
      mateA: relation.mateA,
      mateB: relation.mateB,
      ratio: relation.ratio,
      reverse: relation.reverse,
    };
  }

  static connectorState(frame: ConnectorFrame): ConnectorState {
    return {
      connectorId: frame.connectorId,
      localOrigin: new Vector3().copy(frame.origin),
      localXDirection: new Vector3().copy(frame.xDirection),
      localNormal: new Vector3().copy(frame.normal),
    };
  }

  static contactState(exposure: ExposureContact): ContactState {
    return {
      exposeName: exposure.name,
      seed: exposure.seed ?? null,
      chain: exposure.chain ?? [],
    };
  }

  /** The frames and contacts every instance of a part carries (none for a part the render does not hold). */
  geometryOfPart(partId: string): BodyGeometry {
    const known = this.geometryByPart.get(partId);
    if (known) {
      return known;
    }
    const part = this.partGeometry(partId);
    const geometry: BodyGeometry = part
      ? {
        connectors: part.connectors.map(AssemblySolverModel.connectorState),
        contacts: part.exposures.map(AssemblySolverModel.contactState),
      }
      : NO_GEOMETRY;
    this.geometryByPart.set(partId, geometry);
    return geometry;
  }

  /** The frames and contacts one instance carries; null for an id the records do not hold. */
  geometryOf(instanceId: string): BodyGeometry | null {
    const instance = this.instancesById.get(instanceId);
    return instance ? this.geometryOfPart(instance.partId) : null;
  }

  /**
   * One body per instance, in record order, each a fresh object at a fresh
   * pose — the solve writes its result into the bodies it is given.
   */
  bodies(poseOf?: SolveInputOptions['poseOf']): BodyState[] {
    const bodies: BodyState[] = [];
    for (const instance of this.instances) {
      const pose = poseOf ? poseOf(instance.instanceId) : instance;
      if (!pose) {
        continue;
      }
      const geometry = this.geometryOfPart(instance.partId);
      bodies.push({
        instanceId: instance.instanceId,
        position: new Vector3().copy(pose.position),
        quaternion: new Quaternion().copy(pose.quaternion),
        grounded: instance.grounded,
        connectors: geometry.connectors,
        contacts: geometry.contacts,
      });
    }
    return bodies;
  }

  /**
   * The input of one solve: the instances, any extra bodies, then — when a
   * mate of the solve references it — the world body carrying the
   * assembly's connectors.
   */
  input(options: SolveInputOptions = {}): SolverInput {
    const mates = options.mates ?? this.mates;
    const bodies = this.bodies(options.poseOf);
    if (options.extraBodies) {
      bodies.push(...options.extraBodies);
    }
    if (matesReferenceWorld(mates)) {
      bodies.push(makeWorldBody(this.worldConnectors));
    }
    return { bodies, mates, relations: options.relations ?? this.relations };
  }
}
