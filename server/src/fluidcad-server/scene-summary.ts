// Scene summaries and shape lists as the MCP and UI read them.

import type { CompileError } from '../ws-protocol.ts';
import type { LengthUnit } from '../project-config.ts';
import type { SceneRenderedData } from './render-types.ts';
import type { AssemblySolution } from '../../../lib/dist/index.js';
import type { SerializedAssembly } from './assembly-types.ts';
import { GeneratedRows } from '../generated-rows.ts';
import { JointSummary } from './joint-summary.ts';
import type { SceneSummaryMate, SceneSummaryRelation, SceneSummarySolve } from './joint-summary.ts';
import { SolvedNumber } from './solved-number.ts';

export type {
  SceneSummaryMate,
  SceneSummaryMateOptions,
  SceneSummaryMateOutcome,
  SceneSummaryMateSide,
  SceneSummarySolve,
  SceneSummaryRelation,
  SceneSummaryRelationMate,
} from './joint-summary.ts';

/**
 * One drawn shape of the scene, labelled the way the Shapes panel lists it:
 * `label` = `<Type> <n>` (n per part and per shape type, timeline order —
 * "Solid 2"), `part` = the enclosing part's name (null for a shape no part
 * holds, listed under "Model"). Both are absent on a meta shape (a sketch's
 * plane quad, a guide), which has no row. `kind` says what the shape is in
 * the user's words — a solid, a surface or a curve — and is absent on
 * anything else (a selected face, a point). `lineageKey` (solids and
 * surfaces) is the body's identity across renders — stable through the
 * agent's own edits, where `shapeId` is minted afresh whenever the holder
 * rebuilds.
 */
export type SceneSummaryShape = {
  shapeId: string;
  type: string;
  kind?: SceneShapeKind;
  label?: string;
  part?: string | null;
  lineageKey?: string;
  isMetaShape?: true;
};

export type SceneSummaryObject = {
  index: number;
  id: string;
  kind: string;
  uniqueKind: string;
  /** The display label: the `.name('…')` chain's text, else `<Type> <n>` (see `hasCustomName`). */
  name: string;
  /** Present (true) when `name` came from a `.name('…')` chain; absent on a default `<Type> <n>` label. */
  hasCustomName?: boolean;
  params: any;
  sourceLocation?: { filePath: string; line: number; column: number };
  shapeIds: string[];
  /** The same shapes as `shapeIds`, with their labels, parts and lineage keys. */
  shapes: SceneSummaryShape[];
  fromCache: boolean;
  hasError: boolean;
  errorMessage?: string;
  /**
   * Non-fatal notices on this row — `Unknown material: <id>` on a part
   * whose material is in neither table. Absent when there are none.
   */
  warnings?: string[];
  /**
   * Part rows only: the material id `.material()` assigned, or null when
   * the part has none. Resolve it through `GET /api/materials`.
   */
  material?: string | null;
  /**
   * Part rows only: the appearance id `.appearance()` assigned, or null
   * when the part has none — a built-in look (`oak`, `steel`, …).
   */
  appearance?: string | null;
  containerId: string | null;
  isContainer: boolean;
  visible: boolean;
};

/**
 * The unit trio every `scene-rendered` message carries, spread by each
 * emitter so none of them can forget a field when the set grows.
 */
export function sceneUnitFields(
  data: Pick<SceneRenderedData, 'unit' | 'declaredUnit' | 'projectUnit'>,
): Pick<SceneRenderedData, 'unit' | 'declaredUnit' | 'projectUnit'> {
  return { unit: data.unit, declaredUnit: data.declaredUnit, projectUnit: data.projectUnit };
}

/**
 * The stop every `scene-rendered` message carries: the row the render stops
 * at, and the part that stop is scoped to (a part-scoped rollback, or a pause
 * inside a part) when there is one, plus its paused history. Spread by every
 * emitter so a rollback or error replay remains self-contained on refresh.
 */
type SceneStopFields = Pick<SceneRenderedData, 'rollbackStop' | 'rollbackScopePartId' | 'breakpointHit' | 'breakpointStop' | 'breakpointAt' | 'breakpoints' | 'timeline'>;

export function sceneStopFields(data: SceneStopFields): SceneStopFields {
  return {
    rollbackStop: data.rollbackStop,
    ...(data.rollbackScopePartId ? { rollbackScopePartId: data.rollbackScopePartId } : {}),
    ...(data.breakpointHit !== undefined ? { breakpointHit: data.breakpointHit } : {}),
    ...(data.breakpointStop !== undefined ? { breakpointStop: data.breakpointStop } : {}),
    ...(data.breakpointAt ? { breakpointAt: data.breakpointAt } : {}),
    ...(data.breakpoints ? { breakpoints: data.breakpoints } : {}),
    ...(data.timeline ? { timeline: data.timeline } : {}),
  };
}

/**
 * The preview mark a `scene-rendered` message carries when its scene is an
 * assembly preview's (`SceneRenderedData.preview`): spread by every emitter
 * of a scene, so a rollback that re-emits a preview's scene says so too.
 * Empty for a scene of the session's own code.
 */
export function scenePreviewFields(data: Pick<SceneRenderedData, 'preview'>): Pick<SceneRenderedData, 'preview'> {
  return data.preview ? { preview: { token: data.preview.token } } : {};
}

/**
 * One instance's pose in exactly the shape an `interfere` `poses` entry
 * takes, so an agent can pass it back unchanged. What the pose is — its
 * frame and where it comes from — is `SceneSummary.instancePoses`.
 */
export type SceneSummaryInstancePose = {
  instanceId: string;
  position: { x: number; y: number; z: number };
  quaternion: { x: number; y: number; z: number; w: number };
};

/**
 * What every `instances[].pose` is. `frame: 'world'`: occurrence frames are
 * composed in, so a sub-assembly's instance is placed where its parent puts
 * it. `source` is where the pose comes from:
 * - `solved`: where the mates put the instance — the engine's own solve of
 *   the assembly (`SceneSummary.solve`), the pose `interfere`, `measure`,
 *   `resolve_selection` and an assembly export use when none is passed.
 * - `statement`: the pose the `insert()` chain sets (`.translate()` /
 *   `.rotate()`; a replica copies its seed's), mates not applied — the solve
 *   could not run, or the engine predates it.
 */
export type SceneSummaryInstancePoses = { frame: 'world'; source: 'solved' | 'statement' };

/** One inserted assembly instance, addressed the way the inspection tools take it. */
export type SceneSummaryInstance = {
  instanceId: string;
  name: string;
  /** The inserted part's `part` row id in `objects[]` — what `partId` on the shape-properties route takes. */
  partId: string;
  partName: string;
  /** Owning scope: "" for the root assembly, else the occurrence path ("asm-0", "asm-0/asm-1"). */
  owner: string;
  /** Effective grounding — fixed in the world, the scoped-grounding rule applied (what the viewer's solver pins). */
  grounded: boolean;
  /**
   * The rendered solids this instance shows: its part prototype's, so every
   * instance of one part lists the same ids — the shapes `validate` checks
   * for this `instanceId` and the bodies `interfere` places for it. Empty
   * when the part shows no solid (rolled back, or its build failed). Absent
   * on an engine that predates the lookup.
   */
  shapeIds?: string[];
  pose: SceneSummaryInstancePose;
  /**
   * The pose the instance's `insert()` chain sets, present only when the
   * mates moved the instance off it — the number a `.translate()` /
   * `.rotate()` edit changes, where `pose` is the one geometry is at.
   */
  statementPose?: SceneSummaryInstancePose;
  sourceLocation?: { filePath: string; line: number; column: number };
  /** Present on a `replicate()` copy: the seed instance, the replicate statement, the row. */
  replica?: { of: string; statement: string; row: number };
  /**
   * Present (true) on a part a generator made (`defineAssembly`):
   * engine-owned and read-only — its `sourceLocation` is the insert of the
   * generated assembly, whose values are the only way to change it.
   */
  engineOwned?: true;
};

/** One inserted sub-assembly — the scope an instance's `owner` names. */
export type SceneSummaryOccurrence = {
  occurrenceId: string;
  name: string;
  assemblyName: string;
  /** The parent scope's occurrence path; "" when inserted at the root. */
  parentPath: string;
  /**
   * An occurrence of a generated assembly (`defineAssembly`): its
   * definition's id and the values its insert resolved to, by id. Every
   * record it owns is engine-owned (`engineOwned`); the occurrence itself
   * is the inserting file's.
   */
  generated?: { definition: string; values: Record<string, unknown> };
};

export type SceneSummary = {
  schemaVersion: 1;
  file: string;
  /** The unit every length in `objects[].params` is in (see SceneRenderedData.unit). */
  unit: LengthUnit;
  objects: SceneSummaryObject[];
  rollbackStop: number;
  /** Present while a part-scoped rollback is displayed — see SceneRenderedData. */
  rollbackScopePartId?: string;
  compileError: CompileError | null;
  /** Assembly files only: what every `instances[].pose` is. */
  instancePoses?: SceneSummaryInstancePoses;
  /** Assembly files only: every inserted instance, sub-assemblies' included. */
  instances?: SceneSummaryInstance[];
  /** Assembly files that insert a sub-assembly only. */
  occurrences?: SceneSummaryOccurrence[];
  /** Assembly files only, on an engine that solves mates: how the solve of the assembly came out. */
  solve?: SceneSummarySolve;
  /** Assembly files only: every mate, sub-assemblies' and generators' included, in statement order (possibly empty). */
  mates?: SceneSummaryMate[];
  /** Assembly files with a `relation()` (their own or a generator's) only. */
  relations?: SceneSummaryRelation[];
};

/**
 * The assembly half of a scene summary, projected from the serialized
 * assembly a render hands the UI. Additive: a part file's summary carries
 * none of these keys.
 */
export class AssemblySummary {
  /**
   * The summary keys for an assembly render. `shapeIds` maps an instance id
   * to the rendered solids it shows, or is null on an engine without that
   * lookup (the entries then carry no `shapeIds`). `rendered` are the
   * render's rows: they name the connectors mate sides hold by id, and with
   * the assembly records they decide which records are engine-owned
   * ({@link GeneratedRows}, the write guard's rule). `solution` is the
   * engine's solve of the assembly — where its mates put the instances and
   * how each joint came out — or null on an engine that predates it: the
   * summary then reports the statement poses and no `solve`.
   */
  static fields(
    assembly: SerializedAssembly,
    shapeIds: Map<string, string[]> | null,
    rendered: readonly any[] = [],
    solution: AssemblySolution | null = null,
  ): Pick<SceneSummary, 'instancePoses' | 'instances' | 'occurrences' | 'solve' | 'mates' | 'relations'> {
    const occurrences = assembly.occurrences ?? [];
    const owned = GeneratedRows.of(rendered, assembly);
    const joints = new JointSummary(assembly, rendered, owned, solution);
    const relations = joints.relations();
    const solved = solution?.posesSource === 'solved'
      ? new Map(solution.poses.map(pose => [pose.instanceId, pose]))
      : null;
    return {
      instancePoses: { frame: 'world', source: solved ? 'solved' : 'statement' },
      instances: assembly.instances.map(instance => AssemblySummary.instanceOf(instance, shapeIds, owned, solved)),
      ...(occurrences.length > 0 ? { occurrences: occurrences.map(AssemblySummary.occurrenceOf) } : {}),
      ...(solution ? { solve: AssemblySummary.solveOf(solution) } : {}),
      mates: joints.mates(),
      ...(relations.length > 0 ? { relations } : {}),
    };
  }

  private static solveOf(solution: AssemblySolution): SceneSummarySolve {
    return {
      status: solution.status,
      dof: solution.dof,
      ...(solution.error !== undefined ? { error: solution.error } : {}),
    };
  }

  private static instanceOf(
    instance: SerializedAssembly['instances'][number],
    shapeIds: Map<string, string[]> | null,
    owned: GeneratedRows,
    solved: ReadonlyMap<string, AssemblySolution['poses'][number]> | null,
  ): SceneSummaryInstance {
    const statementPose = AssemblySummary.poseOf(instance.instanceId, instance);
    const solvedPose = solved?.get(instance.instanceId);
    // The solved pose goes out exactly as the engine holds it: it is the
    // pose measure, interfere and resolve_selection place the instance at,
    // and an agent passes it back to them unchanged.
    const pose = solvedPose ? AssemblySummary.poseOf(instance.instanceId, solvedPose) : statementPose;
    return {
      instanceId: instance.instanceId,
      name: instance.name,
      partId: instance.partId,
      partName: instance.partName,
      owner: instance.owner ?? '',
      grounded: instance.grounded,
      ...(shapeIds ? { shapeIds: [...(shapeIds.get(instance.instanceId) ?? [])] } : {}),
      pose,
      ...(solvedPose && AssemblySummary.moved(statementPose, pose) ? { statementPose } : {}),
      ...(instance.sourceLocation ? { sourceLocation: instance.sourceLocation } : {}),
      ...(instance.replica ? { replica: { ...instance.replica } } : {}),
      ...(owned.owns({ row: instance.instanceId, location: instance.sourceLocation }) ? { engineOwned: true as const } : {}),
    };
  }

  private static poseOf(
    instanceId: string,
    pose: Pick<SceneSummaryInstancePose, 'position' | 'quaternion'>,
  ): SceneSummaryInstancePose {
    return {
      instanceId,
      position: { x: pose.position.x, y: pose.position.y, z: pose.position.z },
      quaternion: { x: pose.quaternion.x, y: pose.quaternion.y, z: pose.quaternion.z, w: pose.quaternion.w },
    };
  }

  /**
   * Whether the solve put the instance somewhere other than its statement
   * pose — beyond the float noise a solve leaves on a part it only
   * re-derives in place.
   */
  private static moved(statement: SceneSummaryInstancePose, solved: SceneSummaryInstancePose): boolean {
    const numbers = (pose: SceneSummaryInstancePose) => [
      pose.position.x, pose.position.y, pose.position.z,
      pose.quaternion.x, pose.quaternion.y, pose.quaternion.z, pose.quaternion.w,
    ].map(SolvedNumber.round);
    const before = numbers(statement);
    return numbers(solved).some((value, index) => value !== before[index]);
  }

  private static occurrenceOf(occurrence: NonNullable<SerializedAssembly['occurrences']>[number]): SceneSummaryOccurrence {
    return {
      occurrenceId: occurrence.occurrenceId,
      name: occurrence.name,
      assemblyName: occurrence.assemblyName,
      parentPath: occurrence.parentPath,
      ...(occurrence.generated
        ? { generated: { definition: occurrence.generated.definition, values: { ...occurrence.generated.values } } }
        : {}),
    };
  }
}

/** What a drawn shape is, as a user names it. */
export type SceneShapeKind = 'solid' | 'surface' | 'curve';

/** The kind a rendered shape type stands for; null for a face, a point or anything else. */
export function sceneShapeKindOf(shapeType: string): SceneShapeKind | null {
  switch (shapeType) {
    case 'solid':
      return 'solid';
    case 'surface':
      return 'surface';
    case 'edge':
    case 'wire':
      return 'curve';
    default:
      return null;
  }
}

/**
 * One shape of the list: the summary's fields, and its natural size — the
 * `area` of a solid or a surface, the `length` of a curve — on an engine
 * that measures it (meta shapes are not measured).
 */
export type ShapeListEntry = SceneSummaryShape & {
  sceneObjectId: string;
  area?: number;
  length?: number;
};

export type ShapeList = {
  shapes: ShapeListEntry[];
};
