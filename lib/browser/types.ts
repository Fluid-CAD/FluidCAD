import type { ParamDefinition } from "../param-registry.js";
import type { SourceLocation } from "../common/scene-object.js";
import type { createManager } from "../scene-manager.js";
import type { LengthUnit } from "../units/units.js";

/** What kind of model file an entry is — mirrors the server's FluidScriptKind. */
export type BrowserSceneKind = "part" | "assembly";

/** The assembly payload the desktop's scene-rendered message carries (instances, mates, occurrences, connectors, replicates). */
export type BrowserSerializedAssembly = NonNullable<ReturnType<ReturnType<typeof createManager>["getAssemblyData"]>>;

export const VIEWER_PROTOCOL_VERSION = 1;

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
  /** Part-scoped rollback: only this part is truncated at rollbackStop. */
  rollbackScopePartId?: string;
  breakpointHit: boolean;
  params?: ParamDefinition[];
  objectErrors: BrowserObjectBuildError[];
  compileError: { message: string; stack?: string } | null;
}
