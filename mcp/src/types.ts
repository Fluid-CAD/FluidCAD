// Types shared across the MCP server.
//
// We deliberately re-export the discovery types from the server package
// rather than redefining them — the contract is owned by `server/src/` and
// imported via the project reference to the built `.d.ts` output.

export type { InstanceFile } from '../../server/dist/instance-file.js';
export type { RegistryEntry } from '../../server/dist/global-registry.js';

/**
 * Discriminated result type used by every tool handler so the MCP layer can
 * render success/failure consistently and the agent can branch on `code`.
 */
export type ToolResult<T> =
  | { ok: true; data: T }
  | { ok: false; code: ToolErrorCode; message: string; details?: unknown };

export type ToolErrorCode =
  | 'no-server'
  | 'no-workspace'
  | 'workspace-not-found'
  | 'http-error'
  | 'ws-error'
  | 'invalid-input'
  | 'timeout'
  | 'compile-error'
  | 'dirty-buffer'
  | 'missing-imports'
  | 'internal';

export function ok<T>(data: T): ToolResult<T> {
  return { ok: true, data };
}

export function err(
  code: ToolErrorCode,
  message: string,
  details?: unknown,
): ToolResult<never> {
  return { ok: false, code, message, details };
}
