// Render outcomes: object build errors, the rendered scene payload and render options.

import type { FluidScriptKind } from '../file-kind.ts';
import type { ParamDefinition, RenderChanges } from '../../../lib/dist/index.js';
import type { LengthUnit } from '../project-config.ts';
import type { SerializedAssembly } from './assembly-types.ts';

/**
 * A single feature that failed to build during an otherwise successful render.
 * `line`/`column` are 1-based, matching every other `sourceLocation` on the
 * wire.
 */
export type ObjectBuildError = {
  /** Index into the render result — same numbering as `SceneSummary.objects`. */
  index: number;
  id: string;
  name: string;
  uniqueKind: string;
  message: string;
  sourceLocation?: { filePath: string; line: number; column: number };
};

export type SceneRenderedData = {
  absPath: string;
  sceneKind: FluidScriptKind;
  /**
   * The unit every length in `result` is in — the file's own `unit()`
   * statement, else the project unit, else mm (see `sceneUnitOf`).
   */
  unit: LengthUnit;
  /**
   * The unit the file declares with `unit()`, or null when it has none and
   * follows the project unit — the unit chip's "Same as project" state.
   */
  declaredUnit: LengthUnit | null;
  /** The project unit this render ran under (`fluidcad.json`, else mm). */
  projectUnit: LengthUnit;
  result: any[];
  rollbackStop: number;
  /**
   * Set when this render is a part-scoped rollback: only this part's
   * features after `rollbackStop` are hidden, everything else is fully
   * rendered — and when the stop is the part's last feature, nothing is
   * hidden at all (the UI derives truncation from stop + part id, and the
   * stop stays on the clicked row for the timeline's current marker).
   * Absent on global rollbacks and full renders.
   */
  rollbackScopePartId?: string;
  breakpointHit?: boolean;
  assembly?: SerializedAssembly;
  params?: ParamDefinition[];
  /**
   * Features whose `build()` threw. Non-empty means the render completed but
   * the scene is wrong — see `FluidCadServer.collectObjectErrors`.
   */
  objectErrors: ObjectBuildError[];
  /**
   * What this render rebuilt, added, removed and reused, with exact bounds
   * — present only when the render was requested with `changes: true`.
   */
  changes?: RenderChanges;
};

/**
 * Per-render options a caller can set. `changes` asks for a
 * `SceneRenderedData.changes` summary: the incremental compare records the
 * objects it replaces (with their bounds, before the old scene is disposed)
 * and the rendered scene is summarized against them. Only the MCP's
 * write/edit/recompute set it; editor hosts and the UI never do, and a
 * render without it runs exactly the code it always has.
 */
export type RenderOptions = { changes?: boolean };
