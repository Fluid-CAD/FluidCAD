// Scene summaries and shape lists as the MCP and UI read them.

import type { CompileError } from '../ws-protocol.ts';
import type { LengthUnit } from '../project-config.ts';
import type { SceneRenderedData } from './render-types.ts';
import type { SerializedAssembly } from './assembly-types.ts';

/**
 * One drawn shape of the scene, labelled the way the Shapes panel lists it:
 * `label` = `<Type> <n>` (n per part and per shape type, timeline order —
 * "Solid 2"), `part` = the enclosing part's name (null for a shape no part
 * holds, listed under "Model"). Both are absent on a meta shape (a sketch's
 * plane quad, a guide), which has no row. `lineageKey` (solids only) is the
 * body's identity across renders — stable through the agent's own edits,
 * where `shapeId` is minted afresh whenever the holder rebuilds.
 */
export type SceneSummaryShape = {
  shapeId: string;
  type: string;
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
 * it. `source: 'statement'`: the warm-start pose the `insert()` chain sets
 * (`.translate()` / `.rotate()`; a replica copies its seed's) — the pose
 * `interfere`, `measure` and `resolve_selection` use when none is passed.
 * Never the mate-solved pose the viewport draws: mates are solved only in
 * the viewer, and the server never sees the result.
 */
export type SceneSummaryInstancePoses = { frame: 'world'; source: 'statement' };

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
  sourceLocation?: { filePath: string; line: number; column: number };
  /** Present on a `replicate()` copy: the seed instance, the replicate statement, the row. */
  replica?: { of: string; statement: string; row: number };
};

/** One inserted sub-assembly — the scope an instance's `owner` names. */
export type SceneSummaryOccurrence = {
  occurrenceId: string;
  name: string;
  assemblyName: string;
  /** The parent scope's occurrence path; "" when inserted at the root. */
  parentPath: string;
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
};

/**
 * The assembly half of a scene summary, projected from the serialized
 * assembly a render hands the UI. Additive: a part file's summary carries
 * none of these keys.
 */
export class AssemblySummary {
  static readonly POSES: SceneSummaryInstancePoses = { frame: 'world', source: 'statement' };

  /**
   * The summary keys for an assembly render. `shapeIds` maps an instance id
   * to the rendered solids it shows, or is null on an engine without that
   * lookup (the entries then carry no `shapeIds`).
   */
  static fields(
    assembly: SerializedAssembly,
    shapeIds: Map<string, string[]> | null,
  ): Pick<SceneSummary, 'instancePoses' | 'instances' | 'occurrences'> {
    const occurrences = assembly.occurrences ?? [];
    return {
      instancePoses: { ...AssemblySummary.POSES },
      instances: assembly.instances.map(instance => AssemblySummary.instanceOf(instance, shapeIds)),
      ...(occurrences.length > 0 ? { occurrences: occurrences.map(AssemblySummary.occurrenceOf) } : {}),
    };
  }

  private static instanceOf(
    instance: SerializedAssembly['instances'][number],
    shapeIds: Map<string, string[]> | null,
  ): SceneSummaryInstance {
    return {
      instanceId: instance.instanceId,
      name: instance.name,
      partId: instance.partId,
      partName: instance.partName,
      owner: instance.owner ?? '',
      grounded: instance.grounded,
      ...(shapeIds ? { shapeIds: [...(shapeIds.get(instance.instanceId) ?? [])] } : {}),
      pose: {
        instanceId: instance.instanceId,
        position: { x: instance.position.x, y: instance.position.y, z: instance.position.z },
        quaternion: { x: instance.quaternion.x, y: instance.quaternion.y, z: instance.quaternion.z, w: instance.quaternion.w },
      },
      ...(instance.sourceLocation ? { sourceLocation: instance.sourceLocation } : {}),
      ...(instance.replica ? { replica: { ...instance.replica } } : {}),
    };
  }

  private static occurrenceOf(occurrence: NonNullable<SerializedAssembly['occurrences']>[number]): SceneSummaryOccurrence {
    return {
      occurrenceId: occurrence.occurrenceId,
      name: occurrence.name,
      assemblyName: occurrence.assemblyName,
      parentPath: occurrence.parentPath,
    };
  }
}

export type ShapeListEntry = SceneSummaryShape & {
  sceneObjectId: string;
};

export type ShapeList = {
  shapes: ShapeListEntry[];
};
