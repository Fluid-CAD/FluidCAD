// Scene summaries and shape lists as the MCP and UI read them.

import type { CompileError } from '../ws-protocol.ts';
import type { LengthUnit } from '../project-config.ts';
import type { SceneRenderedData } from './render-types.ts';

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
export function sceneStopFields(
  data: Pick<SceneRenderedData, 'rollbackStop' | 'rollbackScopePartId' | 'breakpointHit' | 'breakpointStop' | 'timeline'>,
): Pick<SceneRenderedData, 'rollbackStop' | 'rollbackScopePartId' | 'breakpointHit' | 'breakpointStop' | 'timeline'> {
  return {
    rollbackStop: data.rollbackStop,
    ...(data.rollbackScopePartId ? { rollbackScopePartId: data.rollbackScopePartId } : {}),
    ...(data.breakpointHit !== undefined ? { breakpointHit: data.breakpointHit } : {}),
    ...(data.breakpointStop !== undefined ? { breakpointStop: data.breakpointStop } : {}),
    ...(data.timeline ? { timeline: data.timeline } : {}),
  };
}

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
};

export type ShapeListEntry = SceneSummaryShape & {
  sceneObjectId: string;
};

export type ShapeList = {
  shapes: ShapeListEntry[];
};
