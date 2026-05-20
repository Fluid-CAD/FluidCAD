// Coordination tools — let the agent sequence `edit → render → screenshot`
// without sleeping. Both tools open a WebSocket against the target server
// and listen for `render-version` lifecycle pings.

import { resolveClient, type WorkspaceArg } from './inspection.ts';
import { TimeoutError, WsError, type RenderEndResult, type IdleResult } from '../client.ts';
import { err, ok, type ToolResult } from '../types.ts';

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_STABLE_MS = 200;

export type WaitForRenderInput = WorkspaceArg & { timeoutMs?: number };

export type WaitForRenderResult =
  | { state: 'rendered'; version: number; absPath?: string; durationMs: number };

export async function waitForRender(
  input: WaitForRenderInput,
): Promise<ToolResult<WaitForRenderResult>> {
  const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (typeof timeoutMs !== 'number' || !Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return err('invalid-input', '`timeoutMs` must be a positive finite number when provided.');
  }

  const resolved = resolveClient(input);
  if (resolved.ok === false) {
    return resolved as ToolResult<WaitForRenderResult>;
  }
  const { client } = resolved.data;

  try {
    const result = await client.nextSceneRendered(timeoutMs);
    if (result.state === 'error') {
      return err('compile-error', 'Render produced a compile error.', {
        version: result.version,
        absPath: result.absPath,
        durationMs: result.durationMs,
      });
    }
    return ok({
      state: 'rendered',
      version: result.version,
      absPath: result.absPath,
      durationMs: result.durationMs,
    } satisfies RenderEndResult & { state: 'rendered' });
  } catch (e: any) {
    return wrapWaitError<WaitForRenderResult>(e);
  } finally {
    await client.close().catch(() => {});
  }
}

export type WaitForIdleInput = WorkspaceArg & {
  timeoutMs?: number;
  stableMs?: number;
};

export type WaitForIdleResult = IdleResult;

export async function waitForIdle(
  input: WaitForIdleInput,
): Promise<ToolResult<WaitForIdleResult>> {
  const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const stableMs = input.stableMs ?? DEFAULT_STABLE_MS;
  if (typeof timeoutMs !== 'number' || !Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return err('invalid-input', '`timeoutMs` must be a positive finite number when provided.');
  }
  if (typeof stableMs !== 'number' || !Number.isFinite(stableMs) || stableMs < 0) {
    return err('invalid-input', '`stableMs` must be a non-negative finite number when provided.');
  }
  if (stableMs >= timeoutMs) {
    return err('invalid-input', '`stableMs` must be less than `timeoutMs`.');
  }

  const resolved = resolveClient(input);
  if (resolved.ok === false) {
    return resolved as ToolResult<WaitForIdleResult>;
  }
  const { client } = resolved.data;

  try {
    const result = await client.nextIdle(stableMs, timeoutMs);
    return ok(result);
  } catch (e: any) {
    return wrapWaitError<WaitForIdleResult>(e);
  } finally {
    await client.close().catch(() => {});
  }
}

function wrapWaitError<T>(e: any): ToolResult<T> {
  if (e instanceof TimeoutError) {
    return err('timeout', e.message) as ToolResult<T>;
  }
  if (e instanceof WsError) {
    return err('ws-error', e.message) as ToolResult<T>;
  }
  return err('internal', e?.message ?? String(e)) as ToolResult<T>;
}
