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
import type { ObjectBuildError, RenderChanges } from './source.ts';
import type { PackageContents } from '../../../server/dist/packages/package-manifest.js';
import type { PackJsonResponse } from '../../../server/dist/routes/pack.js';
import type { PackWarning } from '../../../server/dist/packages/package-builder.js';

/**
 * Shared shape of the scene-mutating routes: the render ran, but individual
 * features may still have failed to build. `state` mirrors `RenderOutcome`
 * so the agent checks the same field on every tool that changes the scene.
 * Both fields are absent on servers older than the build-error report.
 */
type RenderReport = {
  state?: 'rendered' | 'build-error';
  objectErrors?: ObjectBuildError[];
  /** A connected viewer has this render on screen — see `RenderOutcome.uiApplied`. */
  uiApplied?: boolean;
};

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

export type RecomputeInput = WorkspaceArg & {
  /** Ask for `changes` (default true); false skips the summary on a huge model. */
  includeChanges?: boolean;
  /**
   * A `configurations()` row to switch the session to first (what
   * select_configuration does), `'Default'` for the literals.
   */
  configuration?: string;
};
/** `changes`: every object rebuilt (a recompute caches nothing), with bounds before and after. */
export type RecomputeOutput = { success: boolean; changes?: RenderChanges } & RenderReport;

export async function recompute(input: RecomputeInput): Promise<ToolResult<RecomputeOutput>> {
  const configuration = validateConfiguration(input?.configuration);
  if (configuration.ok === false) {
    return configuration as ToolResult<RecomputeOutput>;
  }
  if (configuration.data !== undefined) {
    const selected = await selectConfiguration({ ...input, name: configuration.data });
    if (selected.ok === false) {
      return selected as ToolResult<RecomputeOutput>;
    }
  }
  const body = { awaitUi: true, ...(input?.includeChanges === false ? {} : { changes: true }) };
  return callWithClient(input, (client) => client.postJson<RecomputeOutput>('/api/recompute', body));
}

// ---------------------------------------------------------------------------
// select_configuration
// ---------------------------------------------------------------------------

/** The `configurations()` table as the server's last render declared it. */
export type ConfigurationsSummary = {
  active: string;
  names: string[];
  rows: Record<string, Record<string, unknown>>;
  modified: boolean;
};

export type SelectConfigurationInput = WorkspaceArg & { name: string };
export type SelectConfigurationOutput = { success: boolean; configurations?: ConfigurationsSummary };

/**
 * `configuration` as a tool argument: absent, or a non-empty row name.
 */
function validateConfiguration(value: unknown): ToolResult<string | undefined> {
  if (value === undefined) {
    return ok(undefined);
  }
  if (typeof value !== 'string' || value.trim() === '') {
    return err('invalid-input', '`configuration` must be a non-empty string — a configurations() row name, or "Default".');
  }
  return ok(value);
}

/**
 * Switch the session to a `configurations()` row — what the Parameters
 * panel's dropdown does: the row's values show, the session's tweaks go,
 * and the choice is remembered for the file. A name the model does not
 * declare is refused with the declared names (the server alone would fall
 * back to Default).
 */
export async function selectConfiguration(
  input: SelectConfigurationInput,
): Promise<ToolResult<SelectConfigurationOutput>> {
  if (typeof input?.name !== 'string' || input.name.trim() === '') {
    return err('invalid-input', '`name` is required — a configurations() row name, or "Default".');
  }
  const name = input.name;
  const table = await callWithClient(input, (client) => client.getJson<ConfigurationsSummary>('/api/configurations'));
  if (table.ok === false) {
    return table as ToolResult<SelectConfigurationOutput>;
  }
  const names = Array.isArray(table.data?.names) ? table.data.names : [];
  if (name !== 'Default' && !names.includes(name)) {
    return err(
      'unknown-configuration',
      names.length > 0
        ? `Unknown configuration '${name}'. Declared: ${names.map((n) => `'${n}'`).join(', ')} (and Default).`
        : `Unknown configuration '${name}': the model declares no configurations() table (only Default).`,
      { names },
    );
  }
  return callWithClient(input, (client) =>
    client.postJson<SelectConfigurationOutput>('/api/configurations/select', { name }),
  );
}

// ---------------------------------------------------------------------------
// rollback_to
// ---------------------------------------------------------------------------

export type RollbackToInput = WorkspaceArg & { index: number };
export type RollbackToOutput = { success: boolean } & RenderReport;

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
export type ImportStepOutput = {
  success: boolean;
  fileName: string;
  /** Solids the file produced (absent from older servers). */
  solidCount?: number;
  /** Unit names the STEP file declared; the cache is always mm (absent from older servers). */
  sourceUnits?: { length: string[]; angle: string[] };
};

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
export type ExportScaleTo = 'mm' | 'document';

export type ExportInput = WorkspaceArg & {
  format: ExportFormat;
  /** Solids to export. Exactly one of `shapeIds` / `assembly`. */
  shapeIds?: string[];
  /**
   * Export the whole current assembly — every instance where it sits, as
   * one STEP assembly or one STL mesh. Exactly one of `shapeIds` / `assembly`.
   */
  assembly?: boolean;
  saveAsPath?: string;
  resolution?: ExportResolution;
  includeColors?: boolean;
  /** STL only: scale the mesh into mm (default) or keep the document's units. */
  scaleTo?: ExportScaleTo;
  /**
   * A `configurations()` row to export instead of the one on screen; the
   * server renders it for this export alone and the session stays as it is.
   */
  configuration?: string;
};

/**
 * Assembly exports only: `statement` means the parts sit where the source
 * places them — mates are solved in the viewer, which the server never sees.
 */
export type ExportPosesSource = 'live' | 'statement';

export type ExportSavedOutput = { savedTo: string; bytesWritten: number; posesSource?: ExportPosesSource };
export type ExportBase64Output = {
  format: ExportFormat;
  mimeType: string;
  base64: string;
  bytes: number;
  posesSource?: ExportPosesSource;
};
export type ExportOutput = ExportSavedOutput | ExportBase64Output;

// ---------------------------------------------------------------------------
// pack
// ---------------------------------------------------------------------------

export type PackInput = WorkspaceArg & {
  saveAsPath?: string;
};

/**
 * The archive's identity, and what it holds by folder: the features in
 * `features/`, the parts in `parts/`, the assemblies in `assemblies/`,
 * `models` (parts + assemblies) and the `docs/` pages. `contents` and
 * `warnings` (undocumented fields, broken doc links; the package still
 * packed) are what `fluidcad pack --json` prints under the same keys.
 */
type PackIdentity = { packageName: string; version: string; fileName: string; contents: PackageContents; warnings: PackWarning[] };

export type PackOutput =
  | ({ savedTo: string; bytesWritten: number } & PackIdentity)
  | ({ mimeType: string; base64: string; bytes: number } & PackIdentity);

/**
 * Pack the workspace's package (`POST /api/pack` in its JSON form, the
 * same packer as `fluidcad pack`). A refusal — not a package, a failed pack
 * check — comes back as `pack-refused` with the packer's sentence, and its
 * `code` (`wrong-folder`, `outside-layout`, `no-exports`, `docs-file`,
 * `docs-too-large`, else `refused`) in `details`. The pack's warnings pass
 * through as `warnings`.
 */
export async function packPackage(input: PackInput): Promise<ToolResult<PackOutput>> {
  if (input.saveAsPath !== undefined && typeof input.saveAsPath !== 'string') {
    return err('invalid-input', '`saveAsPath` must be a string when provided.');
  }
  const resolved = resolveClient(input);
  if (resolved.ok === false) {
    return resolved as ToolResult<PackOutput>;
  }
  const { client } = resolved.data;
  try {
    const raw = await client.postRaw('/api/pack', { format: 'json' });
    const text = raw.data.toString('utf8');
    let body: any = null;
    try {
      body = JSON.parse(text);
    } catch {
      body = null;
    }
    if (raw.statusCode >= 400) {
      const refusal = typeof body?.error === 'string' ? body.error : null;
      if (raw.statusCode === 400 && refusal !== null) {
        const details: Record<string, unknown> = { statusCode: raw.statusCode };
        if (typeof body.code === 'string') {
          details.code = body.code;
        }
        return err('pack-refused', refusal, details);
      }
      return err('http-error', `HTTP ${raw.statusCode}: ${text.slice(0, 200)}`, {
        statusCode: raw.statusCode,
      });
    }
    const packed = body as PackJsonResponse | null;
    if (!packed || typeof packed.archive !== 'string') {
      return err('internal', 'The engine answered the pack without an archive.');
    }
    const archive = Buffer.from(packed.archive, 'base64');
    const identity: PackIdentity = {
      packageName: packed.packageName,
      version: packed.version,
      fileName: packed.fileName,
      contents: packed.contents,
      // An engine from before the warnings sends none.
      warnings: Array.isArray(packed.warnings) ? packed.warnings : [],
    };
    if (input.saveAsPath) {
      const absPath = path.resolve(input.saveAsPath);
      await fsp.writeFile(absPath, archive);
      return ok({ savedTo: absPath, bytesWritten: archive.length, ...identity });
    }
    return ok({
      mimeType: 'application/zip',
      base64: packed.archive,
      bytes: archive.length,
      ...identity,
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

export async function exportShapes(input: ExportInput): Promise<ToolResult<ExportOutput>> {
  if (input?.format !== 'step' && input?.format !== 'stl') {
    return err('invalid-input', '`format` is required and must be "step" or "stl".');
  }
  const wholeAssembly = input?.assembly === true;
  if (input?.assembly !== undefined && typeof input.assembly !== 'boolean') {
    return err('invalid-input', '`assembly` must be a boolean when provided.');
  }
  if (wholeAssembly === (input?.shapeIds !== undefined)) {
    return err('invalid-input', 'Pass exactly one of `shapeIds` (solids to export) or `assembly: true` (the whole assembly).');
  }
  if (!wholeAssembly) {
    if (!Array.isArray(input.shapeIds) || input.shapeIds.length === 0) {
      return err('invalid-input', '`shapeIds` must be a non-empty array.');
    }
    if (input.shapeIds.some((id) => typeof id !== 'string' || id.length === 0)) {
      return err('invalid-input', '`shapeIds` entries must be non-empty strings.');
    }
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
  if (input.scaleTo !== undefined && input.scaleTo !== 'mm' && input.scaleTo !== 'document') {
    return err('invalid-input', '`scaleTo` must be "mm" or "document".');
  }
  const configuration = validateConfiguration(input.configuration);
  if (configuration.ok === false) {
    return configuration as ToolResult<ExportOutput>;
  }

  const body: Record<string, unknown> = {
    format: input.format,
    ...(wholeAssembly ? { assembly: {} } : { shapeIds: input.shapeIds }),
    resolution: input.resolution ?? 'medium',
  };
  if (input.includeColors !== undefined) {
    body.includeColors = input.includeColors;
  }
  if (input.scaleTo !== undefined) {
    body.scaleTo = input.scaleTo;
  }
  if (input.saveAsPath !== undefined) {
    body.saveAsPath = input.saveAsPath;
  }
  if (configuration.data !== undefined) {
    body.configuration = configuration.data;
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
    const posesHeader = raw.headers['x-fluidcad-assembly-poses'];
    const posesSource: ExportPosesSource | undefined =
      posesHeader === 'live' || posesHeader === 'statement' ? posesHeader : undefined;
    if (raw.contentType.includes('application/json')) {
      const parsed = JSON.parse(raw.data.toString('utf8')) as ExportSavedOutput;
      // Mirror the server's `savedTo` so the agent always returns absolute
      // paths to the user; double-check the file exists for friendlier errors.
      if (parsed?.savedTo && !fs.existsSync(parsed.savedTo)) {
        return err('internal', `Server reported savedTo=${parsed.savedTo} but the file is missing.`);
      }
      return ok(posesSource ? { ...parsed, posesSource } : parsed);
    }
    return ok({
      format: input.format,
      mimeType: raw.contentType,
      base64: raw.data.toString('base64'),
      bytes: raw.data.length,
      ...(posesSource ? { posesSource } : {}),
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
