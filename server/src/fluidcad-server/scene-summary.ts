// Scene summaries and shape lists as the MCP and UI read them.

import type { CompileError } from '../ws-protocol.ts';
import type { LengthUnit } from '../project-config.ts';
import type { SceneRenderedData } from './render-types.ts';

export type SceneSummaryObject = {
  index: number;
  id: string;
  kind: string;
  uniqueKind: string;
  name: string;
  params: any;
  sourceLocation?: { filePath: string; line: number; column: number };
  shapeIds: string[];
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
  data: Pick<SceneRenderedData, 'rollbackStop' | 'rollbackScopePartId' | 'breakpointHit' | 'timeline'>,
): Pick<SceneRenderedData, 'rollbackStop' | 'rollbackScopePartId' | 'breakpointHit' | 'timeline'> {
  return {
    rollbackStop: data.rollbackStop,
    ...(data.rollbackScopePartId ? { rollbackScopePartId: data.rollbackScopePartId } : {}),
    ...(data.breakpointHit !== undefined ? { breakpointHit: data.breakpointHit } : {}),
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

export type ShapeListEntry = {
  shapeId: string;
  type: string;
  sceneObjectId: string;
};

export type ShapeList = {
  shapes: ShapeListEntry[];
};
