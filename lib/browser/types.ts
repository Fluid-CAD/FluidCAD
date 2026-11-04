import type { ConfigurationsSummary, ParamDefinition, ParamVal } from "../param-registry.js";
import type { SourceLocation } from "../common/scene-object.js";
import type { createManager } from "../scene-manager.js";
import type { GeneratedKind } from "../sdk/generated-schema.js";
import type { RenderDetail } from "../rendering/scene.js";
import type { LengthUnit } from "../units/units.js";

/** What one render pass of `BrowserEngineHost.render()` is told. */
export interface BrowserRenderOptions {
  /** The tier the pass builds generated parts at (`SceneOptions.detail`); `'full'` when left out. */
  detail?: RenderDetail;
  /**
   * Values to set before the pass, by the export name of a generated
   * definition (`definePart` / `defineAssembly`), each set replacing that
   * export's earlier values and kept for later passes — a load's values,
   * rendered in the load's own pass. See `BrowserEngineHost.setGeneratedValues`.
   */
  generated?: Record<string, Record<string, unknown>>;
}

/** What kind of model file an entry is — mirrors the server's FluidScriptKind. */
export type BrowserSceneKind = "part" | "assembly";

/** The assembly payload the desktop's scene-rendered message carries (instances, mates, occurrences, connectors, replicates). */
export type BrowserSerializedAssembly = NonNullable<ReturnType<ReturnType<typeof createManager>["getAssemblyData"]>>;

/**
 * The engine worker's message protocol (FluidCAD-Viewer's `engine-worker.js`),
 * reported in `EngineInfo` so an evergreen shell knows what a pinned engine
 * understands. Additive: 2 added `select-configuration` and `load-model`'s
 * `configuration` (the `configurations()` row to open on); 3 added generated
 * definitions with values — `set-generated-values { exportName, values,
 * detail }`, `load-model`'s `generated` (values by export name) and
 * `detail`, `reset-params` forgetting the generated values too, and the
 * outcome's `generated` ({@link GeneratedOutcome}, what each generated
 * export of the entry was rendered with).
 */
export const VIEWER_PROTOCOL_VERSION = 3;

/**
 * One generated export of the entry (`definePart` / `defineAssembly`) as a
 * render built it: `exportName` the module's export, `id` the definition's
 * (its feature's or generator's catalog key), `kind` what it inserts,
 * `label` its schema's, and `values` what the render used — the values a
 * host set for the export, completed by the schema (defaults filled, in
 * declaration order), or the defaults for an export without values. When
 * the schema refuses the values (an unknown id, a value out of range) they
 * are reported as given, uncompleted: the refusal is the export's
 * `objectErrors` row, as it is for an `insert()`.
 */
export interface GeneratedOutcome {
  exportName: string;
  id: string;
  kind: GeneratedKind;
  label: string;
  values: Record<string, ParamVal>;
}

export interface EngineInfo {
  protocolVersion: number;
  engineVersion: string;
}

/** Mirrors the server's ObjectBuildError (ws-protocol.ts) field-for-field. */
export interface BrowserObjectBuildError {
  index: number;
  id: string;
  name: string;
  uniqueKind: string;
  message: string;
  sourceLocation?: SourceLocation | null;
}

/**
 * One render pass's outcome. Field names deliberately match the desktop
 * `scene-rendered` WebSocket message so the viewer UI can consume either.
 * `params` is omitted (not emptied) on a compile error, matching the desktop
 * contract the params panel relies on.
 */
export interface BrowserRenderResult {
  /** Derived from the entry's suffix (`.assembly.js` → assembly); absent on a compile error. */
  sceneKind?: BrowserSceneKind;
  result: unknown[];
  /** Assembly scenes only: the whole payload (instances, mates, occurrences, connectors, replicates) the rail and the viewer's assembly controller consume. */
  assembly?: BrowserSerializedAssembly;
  rollbackStop: number;
  /** The root document's unit (unit() statement, else the project unit); `mm` when undeclared. */
  unit: LengthUnit;
  /** The unit the root document declares with unit(), or null when it follows the project unit. */
  declaredUnit: LengthUnit | null;
  /** The project unit the host was booted with (`options.unit`, else mm) — what an undeclared file follows. */
  projectUnit: LengthUnit;
  /** Part-scoped stop — a rollback, or a pause inside a part: only this part is truncated at rollbackStop. */
  rollbackScopePartId?: string;
  breakpointHit: boolean;
  params?: ParamDefinition[];
  /**
   * The `configurations()` rows the render declared and which one is
   * showing (`active`, `'Default'` for the literals). Omitted with `params`
   * on a compile error.
   */
  configurations?: ConfigurationsSummary;
  /**
   * Every generated export of the entry, in export order, with the values
   * it was rendered with (see {@link GeneratedOutcome}); empty when the entry
   * has none. Omitted with `params` on a compile error.
   */
  generated?: GeneratedOutcome[];
  objectErrors: BrowserObjectBuildError[];
  /**
   * Non-fatal notices per row (`Unknown material: <id>` on a part row),
   * same shape and numbering as `objectErrors`; absent on a compile error.
   */
  objectWarnings?: BrowserObjectBuildError[];
  compileError: { message: string; stack?: string } | null;
}
