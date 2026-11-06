// The joints half of an assembly's scene summary: its mates and relations as
// authored, readable and keyed by the ids the inspection tools take.

import type { GeneratedRows } from '../generated-rows.ts';
import type { SerializedAssembly } from './assembly-types.ts';

type SummaryLocation = { filePath: string; line: number; column: number };
type SerializedMate = SerializedAssembly['mates'][number];
type SerializedRelation = NonNullable<SerializedAssembly['relations']>[number];

/**
 * What every `mates[]` and `relations[]` entry is. `source: 'statement'`:
 * the records the render's `mate()` / `relation()` statements made — and a
 * generator's `g.mate()` / `g.relation()` — with their types, sides and
 * options as authored. `solvedIn: 'viewer'`: the assembly solver runs only
 * in the viewer page, and the server never receives its result, so no
 * entry carries a solve status, a misclosure or a current joint value. A
 * joint that does not close shows in the app (the Joints panel) and in a
 * screenshot, never here.
 */
export type SceneSummaryJoints = { source: 'statement'; solvedIn: 'viewer' };

/**
 * One side of a mate, named the way source code reaches it and keyed by the
 * ids the inspection tools take. `instanceId` is what validate, interfere,
 * measure and resolve_selection take; `connectorId` is the connector's row
 * in `objects[]`.
 * - `connector`: a part connector on an inserted instance, the statement's
 *   `<instance>.connectors.<connector>`; a connector copy reads as code
 *   spells it (`bolt.instance(2)`).
 * - `assembly-connector`: a connector the assembly declares at its top level
 *   (`connector('datum', [x, y, z])`): no instance.
 * - `exposure`: a tangent mate's exposed geometry on an instance, the
 *   statement's `<instance>.features.<exposure>`.
 *
 * `instance` is the instance's name and `connector` its label in the render;
 * each falls back to its id should the render hold no such row.
 */
export type SceneSummaryMateSide =
  | { kind: 'connector'; instanceId: string; instance: string; connector: string; connectorId: string }
  | { kind: 'assembly-connector'; connector: string; connectorId: string }
  | { kind: 'exposure'; instanceId: string; instance: string; exposure: string };

/**
 * A mate's options, only those that differ from the default: `flip` (true),
 * `rotate` (degrees about the joint's Z), `offset` (in the document unit, in
 * the first side's frame), `limits` ([min, max]: degrees on a revolute, the
 * document unit on a slider), `propagate` (false: a tangent mate's
 * `.noPropagate()`). Absent on a mate with none — the values as the mate
 * stores them, a generator's already converted into the document unit.
 */
export type SceneSummaryMateOptions = {
  flip?: true;
  rotate?: number;
  offset?: [number, number, number];
  limits?: [number, number];
  propagate?: false;
};

/** Where a joint was declared: its scope, and whether the engine owns it. */
type SceneSummaryJointScope = {
  /** Owning scope: "" for the root assembly, else the occurrence path ("asm-0", "asm-0/asm-1"). */
  owner: string;
  /** The owning occurrence's name; absent at the root. */
  ownerName?: string;
  /**
   * Present (true) on a joint a generator's layout made (`defineAssembly`):
   * engine-owned and read-only — no statement of the user's declares it, so
   * it changes only through the values of the insert that makes it. Its
   * `sourceLocation` is that insert's (its `defineAssembly()` call when the
   * defining file renders the layout on its own).
   */
  engineOwned?: true;
  sourceLocation?: SummaryLocation;
};

/** One mate of the assembly, sub-assemblies' and generators' included. */
export type SceneSummaryMate = {
  /** `mate-N`, path-qualified in an occurrence (`asm-0/mate-1`). */
  mateId: string;
  /** The authored `.name('…')`; absent when the statement has none. */
  name?: string;
  type: SerializedMate['type'];
  /** The first side: the driver, which the second is placed on. */
  a: SceneSummaryMateSide;
  /** The second side. */
  b: SceneSummaryMateSide;
  options?: SceneSummaryMateOptions;
  /** Present on a replicated mate: the seed mate, the replicate statement, the row. */
  replica?: { of: string; statement: string; row: number };
} & SceneSummaryJointScope;

/** One mate a relation couples, by id and authored name. */
export type SceneSummaryRelationMate = { mateId: string; name?: string };

/** One `relation()`: a coupling between the free motions of two mates. */
export type SceneSummaryRelation = {
  /** `rel-N`, path-qualified in an occurrence (`asm-0/rel-0`). */
  relationId: string;
  name?: string;
  type: SerializedRelation['type'];
  /**
   * Gear: turns of `mateB` per turn of `mateA`. Rack-and-pinion: `mateB`'s
   * travel per revolution of `mateA`, in the document unit. Always positive.
   */
  ratio: number;
  /** `mateB` runs against `mateA`'s sense (`.reverse()`). */
  reverse: boolean;
  /** The mate whose motion is measured. */
  mateA: SceneSummaryRelationMate;
  /** The mate that follows it. */
  mateB: SceneSummaryRelationMate;
} & SceneSummaryJointScope;

/**
 * The joints of one assembly render, projected for the summary: every mate
 * with its two sides named (instance and connector, assembly connector, or
 * exposure) and its options, every relation with the two mates it couples,
 * each with its owning scope and whether a generator made it — the rule the
 * write guard refuses by, by row or by statement ({@link GeneratedRows.owns}).
 * Authored records only (see {@link SceneSummaryJoints}).
 */
export class JointSummary {
  static readonly JOINTS: SceneSummaryJoints = { source: 'statement', solvedIn: 'viewer' };

  private readonly instanceNames: ReadonlyMap<string, string>;
  private readonly occurrenceNames: ReadonlyMap<string, string>;
  private readonly connectorLabels: ReadonlyMap<string, string>;
  private readonly mateNames: ReadonlyMap<string, string | undefined>;

  /**
   * `rendered` are the render's rows (its connector rows name the part
   * connectors a side holds by id); `owned` is the render's engine-owned
   * rows.
   */
  constructor(
    private readonly assembly: SerializedAssembly,
    rendered: readonly any[],
    private readonly owned: GeneratedRows,
  ) {
    this.instanceNames = new Map(assembly.instances.map(instance => [instance.instanceId, instance.name]));
    this.occurrenceNames = new Map((assembly.occurrences ?? []).map(occurrence => [occurrence.occurrenceId, occurrence.name]));
    this.connectorLabels = JointSummary.connectorLabelsOf(rendered, assembly);
    this.mateNames = new Map(assembly.mates.map(mate => [mate.mateId, JointSummary.authoredName(mate.name)]));
  }

  mates(): SceneSummaryMate[] {
    return this.assembly.mates.map(mate => this.mateOf(mate));
  }

  relations(): SceneSummaryRelation[] {
    return (this.assembly.relations ?? []).map(relation => this.relationOf(relation));
  }

  /**
   * How code spells a connector, by its id: its name, or `name.instance(slot)`
   * for a copy — the rendered `connector` rows (every part connector, the
   * assembly's own included), the assembly's connector list over them.
   */
  static connectorLabelsOf(rendered: readonly any[], assembly: SerializedAssembly): Map<string, string> {
    const labels = new Map<string, string>();
    for (const row of rendered) {
      const name = row?.object?.name;
      if (row?.type !== 'connector' || typeof row.id !== 'string' || typeof name !== 'string') {
        continue;
      }
      labels.set(row.id, JointSummary.connectorLabel(name, row.object.copy?.slot));
    }
    for (const connector of assembly.connectors ?? []) {
      labels.set(connector.connectorId, JointSummary.connectorLabel(connector.name, connector.copy?.slot));
    }
    return labels;
  }

  /** A connector as code names it: `bolt`, or `bolt.instance(2)` for copy slot 2. */
  static connectorLabel(name: string, slot?: unknown): string {
    return typeof slot === 'number' ? `${name}.instance(${slot})` : name;
  }

  private mateOf(mate: SerializedMate): SceneSummaryMate {
    const name = JointSummary.authoredName(mate.name);
    const options = JointSummary.optionsOf(mate.options);
    return {
      mateId: mate.mateId,
      ...(name !== undefined ? { name } : {}),
      type: mate.type,
      a: this.sideOf(mate.connectorA, mate.frameA, mate.geometryA),
      b: this.sideOf(mate.connectorB, mate.frameB, mate.geometryB),
      ...(options ? { options } : {}),
      ...this.scopeOf(mate.mateId, mate.owner ?? '', mate.sourceLocation),
      ...(mate.replica ? { replica: { ...mate.replica } } : {}),
    };
  }

  private relationOf(relation: SerializedRelation): SceneSummaryRelation {
    const name = JointSummary.authoredName(relation.name);
    return {
      relationId: relation.relationId,
      ...(name !== undefined ? { name } : {}),
      type: relation.type,
      ratio: relation.ratio,
      reverse: relation.reverse,
      mateA: this.relationMateOf(relation.mateA),
      mateB: this.relationMateOf(relation.mateB),
      ...this.scopeOf(relation.relationId, relation.owner, relation.sourceLocation),
    };
  }

  private relationMateOf(mateId: string): SceneSummaryRelationMate {
    const name = this.mateNames.get(mateId);
    return { mateId, ...(name !== undefined ? { name } : {}) };
  }

  /**
   * One side: a part connector, an assembly connector or an exposure — the
   * three kinds `mate()` takes. A mate always carries one of the three on
   * each side; a record with none (an engine this server doesn't know)
   * reads as an assembly connector with no id rather than failing the
   * summary.
   */
  private sideOf(
    connector: SerializedMate['connectorA'],
    frame: SerializedMate['frameA'],
    geometry: SerializedMate['geometryA'],
  ): SceneSummaryMateSide {
    if (connector) {
      return {
        kind: 'connector',
        instanceId: connector.instanceId,
        instance: this.instanceNames.get(connector.instanceId) ?? connector.instanceId,
        connector: this.connectorLabels.get(connector.connectorId) ?? connector.connectorId,
        connectorId: connector.connectorId,
      };
    }
    if (geometry) {
      return {
        kind: 'exposure',
        instanceId: geometry.instanceId,
        instance: this.instanceNames.get(geometry.instanceId) ?? geometry.instanceId,
        exposure: geometry.exposeName,
      };
    }
    const connectorId = frame?.connectorId ?? '';
    return { kind: 'assembly-connector', connector: this.connectorLabels.get(connectorId) ?? connectorId, connectorId };
  }

  private scopeOf(id: string, owner: string, sourceLocation: SummaryLocation | undefined): SceneSummaryJointScope {
    const ownerName = owner !== '' ? this.occurrenceNames.get(owner) : undefined;
    return {
      owner,
      ...(ownerName !== undefined ? { ownerName } : {}),
      ...(this.owned.owns({ row: id, location: sourceLocation }) ? { engineOwned: true as const } : {}),
      ...(sourceLocation ? { sourceLocation: JointSummary.locationOf(sourceLocation) } : {}),
    };
  }

  /** The options that differ from the default, or null when none do. */
  private static optionsOf(options: SerializedMate['options']): SceneSummaryMateOptions | null {
    if (!options) {
      return null;
    }
    const out: SceneSummaryMateOptions = {};
    if (options.flip === true) {
      out.flip = true;
    }
    if (typeof options.rotate === 'number' && options.rotate !== 0) {
      out.rotate = options.rotate;
    }
    if (options.offset && options.offset.some(component => component !== 0)) {
      out.offset = [options.offset[0], options.offset[1], options.offset[2]];
    }
    if (options.limits) {
      out.limits = [options.limits[0], options.limits[1]];
    }
    if (options.propagate === false) {
      out.propagate = false;
    }
    return Object.keys(out).length > 0 ? out : null;
  }

  /** An authored name, or undefined when there is none (absent or blank). */
  private static authoredName(name: string | undefined): string | undefined {
    const trimmed = typeof name === 'string' ? name.trim() : '';
    return trimmed !== '' ? trimmed : undefined;
  }

  /** A location as the summary reports it: the file path a live render's module carries, without its virtual prefix. */
  private static locationOf(location: SummaryLocation): SummaryLocation {
    return { filePath: location.filePath.replace(/^virtual:live-render:/, ''), line: location.line, column: location.column };
  }
}
