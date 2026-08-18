import type { ParamDefinition } from "../param-registry.js";
import type { SourceLocation } from "../common/scene-object.js";

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
  result: unknown[];
  rollbackStop: number;
  /** Part-scoped rollback: only this part is truncated at rollbackStop. */
  rollbackScopePartId?: string;
  breakpointHit: boolean;
  params?: ParamDefinition[];
  objectErrors: BrowserObjectBuildError[];
  compileError: { message: string; stack?: string } | null;
}
