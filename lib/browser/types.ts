import type { ParamDefinition } from "../param-registry.js";
import type { SourceLocation } from "../common/scene-object.js";
import type { createManager } from "../scene-manager.js";

/** What kind of model file an entry is — mirrors the server's FluidScriptKind. */
export type BrowserSceneKind = "part" | "assembly";

/** The assembly payload the desktop's scene-rendered message carries (instances, mates, occurrences). */
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
  /** Assembly scenes only: the instances/mates/occurrences the rail and the viewer's assembly controller consume. */
  assembly?: BrowserSerializedAssembly;
  rollbackStop: number;
  /** Part-scoped rollback: only this part is truncated at rollbackStop. */
  rollbackScopePartId?: string;
  breakpointHit: boolean;
  params?: ParamDefinition[];
  objectErrors: BrowserObjectBuildError[];
  compileError: { message: string; stack?: string } | null;
}
