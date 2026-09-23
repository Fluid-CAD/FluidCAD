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
