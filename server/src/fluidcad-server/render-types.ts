// Render outcomes: object build errors, the rendered scene payload and render options.

import type { FluidScriptKind } from '../file-kind.ts';
import type { ParamDefinition, ParamVal, RenderChanges } from '../../../lib/dist/index.js';
import type { LengthUnit } from '../project-config.ts';
import type { SerializedAssembly } from './assembly-types.ts';
import type { ScenePropertyDefinition } from './properties.ts';
import type { TimelineEntry } from '../../../lib/dist/common/timeline.js';

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

/**
 * A non-fatal per-object notice — today only a `part` row whose
 * `.material(id)` names neither a built-in nor a project material. Same
 * numbering and location fields as `ObjectBuildError`; the row built and
 * its geometry is right, only what depends on the material (mass) is not.
 */
export type ObjectBuildWarning = ObjectBuildError;

export type SceneConfigurations = {
  active: string;
  names: string[];
  rows: Record<string, Record<string, ParamVal>>;
  modified: boolean;
  notice?: string;
};

/**
 * A render of the current file with one configuration row active, made for
 * an export and nothing else — see `FluidCadServer.renderWithConfiguration`.
 * `scene` is the caller's until `dispose()`; `ok: false` names the row the
 * file does not declare, with the rows it does.
 */
export type ScratchRender =
  | { ok: true; scene: any; configurations: { active: string; names: string[]; rows: Record<string, Record<string, ParamVal>> }; dispose: () => void }
  | { ok: false; reason: string; names: string[] };

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
   * stop stays on the clicked row for the timeline's current marker). A
   * render a breakpoint paused inside a part sets it too, with the stop on
   * the part's paused row. Absent on global rollbacks and full renders.
   */
  rollbackScopePartId?: string;
  breakpointHit?: boolean;
  /** Actual source breakpoint boundary, unchanged by view-only rollback previews. */
  breakpointStop?: number;
  /** The `breakpoint();` statement the build paused on, when it is in the rendered file. */
  breakpointAt?: { line: number; column: number };
  /**
   * Every `breakpoint();` statement of the rendered file, in document order
   * — the one the build paused on and the ones still pending after it. The
   * timeline marks each; absent on engines predating the list.
   */
  breakpoints?: { line: number; column: number }[];
  /** Paused history display, separate from the live scene and its indices. */
  timeline?: TimelineEntry[];
  assembly?: SerializedAssembly;
  params?: ParamDefinition[];
  /**
   * The `configurations()` rows the render declared and which one it showed
   * (`docs/assembly-configurations-plan.md` §3.3). `names` is empty when no
   * body declared a table; `modified` says the session's override layer is
   * non-empty — tweaks sit on top of the row; `notice` explains a fallback
   * (the remembered row is no longer declared, so Default rendered).
   */
  configurations?: SceneConfigurations;
  /** The `property()` declarations of the rendered file's parts — see `collectSceneProperties`. */
  properties?: ScenePropertyDefinition[];
  /**
   * Features whose `build()` threw. Non-empty means the render completed but
   * the scene is wrong — see `FluidCadServer.collectObjectErrors`.
   */
  objectErrors: ObjectBuildError[];
  /**
   * Non-fatal notices per row (`Unknown material: <id>` on a part row) —
   * see `PartPropertiesAggregator.collectWarnings`. Empty on a clean render.
   */
  objectWarnings: ObjectBuildWarning[];
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
