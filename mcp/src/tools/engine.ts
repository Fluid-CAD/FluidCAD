// Engine-control tools — wrappers around existing FluidCAD REST routes that
// let the agent recompute, rollback, set breakpoints, and import/export
// geometry. All workspace resolution and HTTP-error mapping is shared with
// the inspection tools.

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { resolveClient, type WorkspaceArg } from './inspection.ts';
import { FluidCadClient, HttpError } from '../client.ts';
import { err, ok, type ToolResult } from '../types.ts';

async function callWithClient<T>(
  input: WorkspaceArg,
  fn: (client: FluidCadClient) => Promise<T>,
): Promise<ToolResult<T>> {
  const resolved = resolveClient(input);
  if (resolved.ok === false) {
    return resolved as ToolResult<T>;
  }
  const { client } = resolved.data;
  try {
    const data = await fn(client);
    return ok(data);
  } catch (e: any) {
    if (e instanceof HttpError) {
      return err('http-error', `HTTP ${e.statusCode}: ${e.body.slice(0, 200)}`, {
        statusCode: e.statusCode,
      });
    }
    return err('internal', e?.message ?? String(e));
  } finally {
    await client.close().catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// recompute
// ---------------------------------------------------------------------------

export type RecomputeInput = WorkspaceArg;
export type RecomputeOutput = { success: boolean };

export async function recompute(input: RecomputeInput): Promise<ToolResult<RecomputeOutput>> {
  return callWithClient(input, (client) => client.postJson<RecomputeOutput>('/api/recompute', {}));
}

// ---------------------------------------------------------------------------
// rollback_to
// ---------------------------------------------------------------------------

export type RollbackToInput = WorkspaceArg & { index: number };
export type RollbackToOutput = { success: boolean };

export async function rollbackTo(input: RollbackToInput): Promise<ToolResult<RollbackToOutput>> {
  if (typeof input?.index !== 'number' || !Number.isInteger(input.index) || input.index < 0) {
    return err('invalid-input', '`index` is required and must be a non-negative integer.');
  }
  const { index } = input;
  return callWithClient(input, (client) =>
    client.postJson<RollbackToOutput>('/api/rollback', { index }),
  );
}

// ---------------------------------------------------------------------------
// add_breakpoint
// ---------------------------------------------------------------------------

export type AddBreakpointInput = WorkspaceArg & { file: string; line: number };
export type AddBreakpointOutput = { success: boolean };

export async function addBreakpoint(
  input: AddBreakpointInput,
): Promise<ToolResult<AddBreakpointOutput>> {
  if (!input?.file || typeof input.file !== 'string') {
    return err('invalid-input', '`file` is required and must be a non-empty string.');
  }
  if (typeof input?.line !== 'number' || !Number.isInteger(input.line) || input.line < 0) {
    return err('invalid-input', '`line` is required and must be a non-negative integer.');
  }
  const sourceLocation = { filePath: input.file, line: input.line };
  return callWithClient(input, (client) =>
    client.postJson<AddBreakpointOutput>('/api/add-breakpoint', { sourceLocation }),
  );
}

// ---------------------------------------------------------------------------
// clear_breakpoints
// ---------------------------------------------------------------------------

export type ClearBreakpointsInput = WorkspaceArg;
export type ClearBreakpointsOutput = { success: boolean };

export async function clearBreakpoints(
  input: ClearBreakpointsInput,
): Promise<ToolResult<ClearBreakpointsOutput>> {
  return callWithClient(input, (client) =>
    client.postJson<ClearBreakpointsOutput>('/api/clear-breakpoints', {}),
  );
}

// ---------------------------------------------------------------------------
// import_step
// ---------------------------------------------------------------------------

export type ImportStepInput = WorkspaceArg & { path: string };
export type ImportStepOutput = { success: boolean; fileName: string };

export async function importStep(input: ImportStepInput): Promise<ToolResult<ImportStepOutput>> {
  if (!input?.path || typeof input.path !== 'string') {
    return err('invalid-input', '`path` is required and must be a non-empty string.');
  }
  const absPath = path.resolve(input.path);
  let bytes: Buffer;
  try {
    bytes = await fsp.readFile(absPath);
  } catch (e: any) {
    if (e?.code === 'ENOENT') {
      return err('invalid-input', `File not found: ${input.path}`);
    }
    return err('internal', e?.message ?? String(e));
  }
  const fileName = path.basename(absPath);
  const data = bytes.toString('base64');
  return callWithClient(input, (client) =>
    client.postJson<ImportStepOutput>('/api/import-file', { fileName, data }),
  );
}

// ---------------------------------------------------------------------------
// export
// ---------------------------------------------------------------------------

export type ExportFormat = 'step' | 'stl';
export type ExportResolution = 'coarse' | 'medium' | 'fine';

export type ExportInput = WorkspaceArg & {
  format: ExportFormat;
  shapeIds: string[];
  saveAsPath?: string;
  resolution?: ExportResolution;
  includeColors?: boolean;
};

export type ExportSavedOutput = { savedTo: string; bytesWritten: number };
export type ExportBase64Output = {
  format: ExportFormat;
  mimeType: string;
  base64: string;
  bytes: number;
};
export type ExportOutput = ExportSavedOutput | ExportBase64Output;

export async function exportShapes(input: ExportInput): Promise<ToolResult<ExportOutput>> {
  if (input?.format !== 'step' && input?.format !== 'stl') {
    return err('invalid-input', '`format` is required and must be "step" or "stl".');
  }
  if (!Array.isArray(input?.shapeIds) || input.shapeIds.length === 0) {
    return err('invalid-input', '`shapeIds` is required and must be a non-empty array.');
  }
  if (input.shapeIds.some((id) => typeof id !== 'string' || id.length === 0)) {
    return err('invalid-input', '`shapeIds` entries must be non-empty strings.');
  }
  if (
    input.resolution !== undefined &&
    input.resolution !== 'coarse' &&
    input.resolution !== 'medium' &&
    input.resolution !== 'fine'
  ) {
    return err('invalid-input', '`resolution` must be "coarse", "medium", or "fine".');
  }
  if (input.saveAsPath !== undefined && typeof input.saveAsPath !== 'string') {
    return err('invalid-input', '`saveAsPath` must be a string when provided.');
  }

  const body: Record<string, unknown> = {
    format: input.format,
    shapeIds: input.shapeIds,
    resolution: input.resolution ?? 'medium',
  };
  if (input.includeColors !== undefined) {
    body.includeColors = input.includeColors;
  }
  if (input.saveAsPath !== undefined) {
    body.saveAsPath = input.saveAsPath;
  }

  const resolved = resolveClient(input);
  if (resolved.ok === false) {
    return resolved as ToolResult<ExportOutput>;
  }
  const { client } = resolved.data;
  try {
    const raw = await client.postRaw('/api/export', body);
    if (raw.statusCode >= 400) {
      const text = raw.data.toString('utf8');
      return err('http-error', `HTTP ${raw.statusCode}: ${text.slice(0, 200)}`, {
        statusCode: raw.statusCode,
      });
    }
    if (raw.contentType.includes('application/json')) {
      const parsed = JSON.parse(raw.data.toString('utf8')) as ExportSavedOutput;
      // Mirror the server's `savedTo` so the agent always returns absolute
      // paths to the user; double-check the file exists for friendlier errors.
      if (parsed?.savedTo && !fs.existsSync(parsed.savedTo)) {
        return err('internal', `Server reported savedTo=${parsed.savedTo} but the file is missing.`);
      }
      return ok(parsed);
    }
    return ok({
      format: input.format,
      mimeType: raw.contentType,
      base64: raw.data.toString('base64'),
      bytes: raw.data.length,
    });
  } catch (e: any) {
    if (e instanceof HttpError) {
      return err('http-error', `HTTP ${e.statusCode}: ${e.body.slice(0, 200)}`, {
        statusCode: e.statusCode,
      });
    }
    return err('internal', e?.message ?? String(e));
  } finally {
    await client.close().catch(() => {});
  }
}
