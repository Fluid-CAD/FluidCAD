// The joints half of an assembly's scene summary: its mates and relations as
// authored, readable and keyed by the ids the inspection tools take, each
// with how the engine's solve left it.

import type {
  AssemblyMateState,
  AssemblyRelationState,
  AssemblySolution,
} from '../../../lib/dist/index.js';
import type { GeneratedRows } from '../generated-rows.ts';
import type { SerializedAssembly } from './assembly-types.ts';
import { SolvedNumber } from './solved-number.ts';

type SummaryLocation = { filePath: string; line: number; column: number };
type SerializedMate = SerializedAssembly['mates'][number];
type SerializedRelation = NonNullable<SerializedAssembly['relations']>[number];

/**
 * How the engine's solve of the assembly's mates came out — the solve every
 * `instances[].pose`, mate `status` and joint `value` of the summary is
 * read from.
 *
 * It is the REST configuration: every instance starts at its `insert()`
 * chain's pose and the mate solver runs once — what a viewer shows when it
 * opens the file, computed by the same solver from the same records. With
 * `dof` above zero the mates leave free motion, and the rest configuration
 * is one of many valid ones: a part a user has since dragged along a free
 * joint, or a mate the Animate bar is driving, moves only in their viewer
 * (and so in a screenshot), never here.
 *
 * - `okay`: every mate and relation the solve enforces holds.
 * - `inconsistent`: at least one does not (`status: "failed"` on it); the
 *   poses are the solver's least-bad configuration.
 * - `unsolved`: the solve could not run (`error`); the poses are the
 *   statement poses and no mate or relation carries a `status`.
 *
 * `okay` does not cover a mate the solve never reached — check for
 * `status: "unenforced"` on the mates and relations too.
 */
export type SceneSummarySolve = {
  status: AssemblySolution['status'];
  /** The degrees of freedom the mates leave the assembly; null when the solve could not run. */
  dof: number | null;
  /** `unsolved` only: what stopped the solve. */
  error?: string;
};

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
} & SceneSummaryJointScope & SceneSummaryMateOutcome;

/**
 * How the solve left a mate; every key is absent when the solve did not run
 * (`solve.status: "unsolved"`, or an engine that predates the solve).
 */
export type SceneSummaryMateOutcome = {
  /**
   * `satisfied`: the mate holds at the solved poses. `failed`: it does not
   * — the assembly cannot close it; `gap`, `gapAxis` and `tiltDeg` say by
   * how much. `unenforced`: it never reached the solve (a side names a
   * connector that did not build, or exposed geometry of a form a tangent
   * mate cannot use) and constrains nothing.
   */
  status?: AssemblyMateState['status'];
  /**
   * Where the joint sits in the solved configuration: a revolute's angle in
   * degrees, a slider's travel in the document unit — the quantity, and the
   * sign, its `limits` clamp (an angle on the turn its limits are on). Only
   * on those two types.
   */
  value?: number;
  /**
   * Present (true) when the solve left the joint outside its `limits`: the
   * mate's geometry holds, its range does not — nothing is free to move it
   * back, or the limits of joints that move together (a relation, a closed
   * loop) cannot all hold at once.
   */
  outsideLimits?: true;
  /** Failed mates: the connector-origin misclosure along the mate's constrained directions, in the document unit. */
  gap?: number;
  /** Failed mates: the world axis the gap runs along, when it is essentially axis-aligned. */
  gapAxis?: 'x' | 'y' | 'z';
  /** Failed mates: the orientation error in degrees. */
  tiltDeg?: number;
};

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
  /**
   * How the solve left the relation: `satisfied` — its mates moved in ratio;
   * `failed` — they did not (a limit, a fastened part or a closed loop held
   * one side back); `contradicted` — its ratio disagrees with the other
   * relations around a cycle of them, so the solve dropped it; `unenforced`
   * — it never reached the solve (a mate it couples is unenforced or has no
   * motion of the kind it needs). Absent when the solve did not run.
   */
  status?: AssemblyRelationState['status'];
} & SceneSummaryJointScope;

/**
 * The joints of one assembly render, projected for the summary: every mate
 * with its two sides named (instance and connector, assembly connector, or
 * exposure) and its options, every relation with the two mates it couples,
 * each with its owning scope and whether a generator made it — the rule the
 * write guard refuses by, by row or by statement ({@link GeneratedRows.owns})
 * — and, when the engine solved the assembly, how the solve left it.
 */
export class JointSummary {
  private readonly instanceNames: ReadonlyMap<string, string>;
  private readonly occurrenceNames: ReadonlyMap<string, string>;
  private readonly connectorLabels: ReadonlyMap<string, string>;
  private readonly mateNames: ReadonlyMap<string, string | undefined>;
  private readonly mateStates: ReadonlyMap<string, AssemblyMateState>;
  private readonly relationStates: ReadonlyMap<string, AssemblyRelationState>;

  /**
   * `rendered` are the render's rows (its connector rows name the part
   * connectors a side holds by id); `owned` is the render's engine-owned
   * rows; `solution` is the engine's solve of the assembly, or null on an
   * engine that predates it.
   */
  constructor(
    private readonly assembly: SerializedAssembly,
    rendered: readonly any[],
    private readonly owned: GeneratedRows,
    solution: AssemblySolution | null = null,
  ) {
    this.mateStates = new Map((solution?.mates ?? []).map(state => [state.mateId, state]));
    this.relationStates = new Map((solution?.relations ?? []).map(state => [state.relationId, state]));
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
      ...JointSummary.outcomeOf(this.mateStates.get(mate.mateId)),
    };
  }

  /** How the solve left a mate, its numbers cleaned of float noise; nothing for a mate the solve has no state for. */
  private static outcomeOf(state: AssemblyMateState | undefined): SceneSummaryMateOutcome {
    if (!state) {
      return {};
    }
    return {
      status: state.status,
      ...(state.value !== undefined ? { value: SolvedNumber.round(state.value) } : {}),
      ...(state.outsideLimits ? { outsideLimits: true as const } : {}),
      ...(state.gap !== undefined ? { gap: SolvedNumber.round(state.gap) } : {}),
      ...(state.gapAxis !== undefined ? { gapAxis: state.gapAxis } : {}),
      ...(state.tiltDeg !== undefined ? { tiltDeg: SolvedNumber.round(state.tiltDeg) } : {}),
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
      ...(this.relationStates.has(relation.relationId)
        ? { status: this.relationStates.get(relation.relationId)!.status }
        : {}),
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
