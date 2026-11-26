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
  /** Solids, surfaces and curves the file produced (absent from older engines). */
  contents?: { solids: number; surfaces: number; curves: number };
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

export type ExportFormat = 'step' | 'stl' | 'dxf' | 'svg';
export type ExportResolution = 'coarse' | 'medium' | 'fine';
export type ExportScaleTo = 'mm' | 'document';

/**
 * The standard planes a drawing (`format: "dxf"` or `"svg"`) is made on: six planes,
 * each under its view name and its axis name. The model is seen from the
 * side the plane's normal points to — `top` / `xy` looks down the Z axis,
 * `front` / `xz` from the −Y side, `right` / `yz` from the +X side.
 */
export const EXPORT_PLANES = [
  'top', 'bottom', 'front', 'back', 'right', 'left',
  'xy', '-xy', 'xz', '-xz', 'yz', '-yz',
] as const;
export type ExportPlane = typeof EXPORT_PLANES[number];

/** The formats that draw the model's view on a plane instead of writing its solids. */
const DRAWING_FORMATS: readonly ExportFormat[] = ['dxf', 'svg'];

/** The response header a drawing's warnings travel in: a URI-encoded JSON array of strings. */
const EXPORT_WARNINGS_HEADER = 'x-fluidcad-export-warnings';

export type ExportInput = WorkspaceArg & {
  format: ExportFormat;
  /** Solids to export. Exactly one of `shapeIds` / `assembly`. */
  shapeIds?: string[];
  /**
   * Export the whole current assembly — every instance where it sits, as
   * one STEP assembly, one STL mesh or one DXF or SVG drawing. Exactly one
   * of `shapeIds` / `assembly`.
   */
  assembly?: boolean;
  saveAsPath?: string;
  resolution?: ExportResolution;
  includeColors?: boolean;
  /** STL only: scale the mesh into mm (default) or keep the document's units. */
  scaleTo?: ExportScaleTo;
  /** DXF and SVG only, and required for them: the standard plane the model's view is drawn on. */
  plane?: ExportPlane;
  /** DXF and SVG only: draw the edges behind the model too, dashed, on their own layer. */
  hiddenLines?: boolean;
  /** DXF and SVG only: draw smooth (tangent) edges such as a fillet's borders, on their own layer. */
  tangentEdges?: boolean;
  /** SVG only: the stroke width of the visible edges, in millimetres on paper (0.25 by default). */
  strokeWidth?: number;
  /** SVG only: the blank margin around the drawing, in millimetres on paper (5 by default). */
  margin?: number;
  /**
   * A `configurations()` row to export instead of the one on screen; the
   * server renders it for this export alone and the session stays as it is.
   */
  configuration?: string;
};

/**
 * Assembly exports only, where the instance poses written came from: `live`
 * — poses handed in with the request (a viewer's); `solved` — the engine's
 * own mate solve from the statement poses, what an export without poses
 * writes; `statement` — the source's `insert()` chains alone, the mates not
 * applied (the solve could not run, or the engine predates it).
 */
export type ExportPosesSource = 'live' | 'solved' | 'statement';

const EXPORT_POSES_SOURCES: readonly string[] = ['live', 'solved', 'statement'];

/**
 * `warnings`: what the user should be told about the file — a drawing whose
 * curves had to be approximated by polylines. Absent when there is nothing
 * to say.
 */
export type ExportSavedOutput = { savedTo: string; bytesWritten: number; posesSource?: ExportPosesSource; warnings?: string[] };
export type ExportBase64Output = {
  format: ExportFormat;
  mimeType: string;
  base64: string;
  bytes: number;
  posesSource?: ExportPosesSource;
  warnings?: string[];
};
/**
 * An SVG that was not saved comes back as its own source: it is text, and
 * compact enough to read — the drawing's paths in model numbers.
 */
export type ExportTextOutput = {
  format: 'svg';
  mimeType: string;
  text: string;
  bytes: number;
  /** A whole assembly's drawing: where its parts were put, as for STEP and STL. */
  posesSource?: ExportPosesSource;
  warnings?: string[];
};
export type ExportOutput = ExportSavedOutput | ExportBase64Output | ExportTextOutput;

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

/** The strings of a warnings list, whatever else was sent in it. */
function exportWarningList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string' && entry.length > 0) : [];
}

/**
 * The warnings of a binary export answer (`X-FluidCAD-Export-Warnings`).
 * Empty for a header that is absent or unreadable: a note that cannot be
 * read is no reason to fail a file that was written.
 */
function headerWarnings(header: unknown): string[] {
  if (typeof header !== 'string' || header === '') {
    return [];
  }
  try {
    return exportWarningList(JSON.parse(decodeURIComponent(header)));
  } catch {
    return [];
  }
}

export async function exportShapes(input: ExportInput): Promise<ToolResult<ExportOutput>> {
  if (input?.format !== 'step' && input?.format !== 'stl' && input?.format !== 'dxf' && input?.format !== 'svg') {
    return err('invalid-input', '`format` is required and must be "step", "stl", "dxf" or "svg".');
  }
  const formatName = input.format.toUpperCase();
  const drawing = DRAWING_FORMATS.includes(input.format);
  const wholeAssembly = input?.assembly === true;
  if (input?.assembly !== undefined && typeof input.assembly !== 'boolean') {
    return err('invalid-input', '`assembly` must be a boolean when provided.');
  }
  if (wholeAssembly === (input?.shapeIds !== undefined)) {
    return err('invalid-input', 'Pass exactly one of `shapeIds` (solids and surfaces to export) or `assembly: true` (the whole assembly).');
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
  if (drawing) {
    // A drawing is a view on a plane; the mesh and colour options belong to
    // the 3D formats, and the server refuses them on a drawing.
    const stray = (['resolution', 'includeColors', 'scaleTo'] as const).filter((name) => input[name] !== undefined);
    if (stray.length > 0) {
      return err(
        'invalid-input',
        `${stray.map((name) => `\`${name}\``).join(', ')} ${stray.length === 1 ? 'does' : 'do'} not apply to a ${formatName} drawing. It takes \`plane\`, \`hiddenLines\` and \`tangentEdges\`${input.format === 'svg' ? ', and `strokeWidth` and `margin`' : ''}.`,
      );
    }
    if (typeof input.plane !== 'string' || !(EXPORT_PLANES as readonly string[]).includes(input.plane)) {
      return err(
        'invalid-input',
        `\`plane\` is required for a ${formatName} drawing — the plane the model's view is drawn on. One of: ${EXPORT_PLANES.join(', ')}.`,
        { planes: [...EXPORT_PLANES] },
      );
    }
  } else if (input.plane !== undefined || input.hiddenLines !== undefined || input.tangentEdges !== undefined) {
    return err('invalid-input', '`plane`, `hiddenLines` and `tangentEdges` describe a drawing: they need `format: "dxf"` or `"svg"`.');
  }
  // The page an SVG is put on; no other format has one, and the server refuses them there.
  if (input.format !== 'svg' && (input.strokeWidth !== undefined || input.margin !== undefined)) {
    return err('invalid-input', '`strokeWidth` and `margin` describe an SVG\'s page: they need `format: "svg"`.');
  }
  if (input.strokeWidth !== undefined && !(typeof input.strokeWidth === 'number' && Number.isFinite(input.strokeWidth) && input.strokeWidth > 0)) {
    return err('invalid-input', '`strokeWidth` must be a number of millimetres greater than 0.');
  }
  if (input.margin !== undefined && !(typeof input.margin === 'number' && Number.isFinite(input.margin) && input.margin >= 0)) {
    return err('invalid-input', '`margin` must be a number of millimetres, 0 or more.');
  }
  for (const name of ['hiddenLines', 'tangentEdges'] as const) {
    if (input[name] !== undefined && typeof input[name] !== 'boolean') {
      return err('invalid-input', `\`${name}\` must be a boolean when provided.`);
    }
  }
  const configuration = validateConfiguration(input.configuration);
  if (configuration.ok === false) {
    return configuration as ToolResult<ExportOutput>;
  }

  const body: Record<string, unknown> = {
    format: input.format,
    ...(wholeAssembly ? { assembly: {} } : { shapeIds: input.shapeIds }),
    ...(drawing ? { plane: input.plane } : { resolution: input.resolution ?? 'medium' }),
  };
  if (input.hiddenLines !== undefined) {
    body.hiddenLines = input.hiddenLines;
  }
  if (input.tangentEdges !== undefined) {
    body.tangentEdges = input.tangentEdges;
  }
  if (input.strokeWidth !== undefined) {
    body.strokeWidth = input.strokeWidth;
  }
  if (input.margin !== undefined) {
    body.margin = input.margin;
  }
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
      typeof posesHeader === 'string' && EXPORT_POSES_SOURCES.includes(posesHeader)
        ? posesHeader as ExportPosesSource
        : undefined;
    if (raw.contentType.includes('application/json')) {
      const parsed = JSON.parse(raw.data.toString('utf8')) as ExportSavedOutput;
      // Mirror the server's `savedTo` so the agent always returns absolute
      // paths to the user; double-check the file exists for friendlier errors.
      if (parsed?.savedTo && !fs.existsSync(parsed.savedTo)) {
        return err('internal', `Server reported savedTo=${parsed.savedTo} but the file is missing.`);
      }
      // A saved export says its warnings in the body; anything else there is dropped.
      const saved = exportWarningList(parsed?.warnings);
      const { warnings: _warnings, ...rest } = parsed;
      return ok({ ...rest, ...(posesSource ? { posesSource } : {}), ...(saved.length > 0 ? { warnings: saved } : {}) });
    }
    const warnings = headerWarnings(raw.headers[EXPORT_WARNINGS_HEADER]);
    if (input.format === 'svg') {
      // An SVG is text: handed over as itself, readable without decoding.
      return ok({
        format: 'svg',
        mimeType: raw.contentType,
        text: raw.data.toString('utf8'),
        bytes: raw.data.length,
        ...(posesSource ? { posesSource } : {}),
        ...(warnings.length > 0 ? { warnings } : {}),
      });
    }
    return ok({
      format: input.format,
      mimeType: raw.contentType,
      base64: raw.data.toString('base64'),
      bytes: raw.data.length,
      ...(posesSource ? { posesSource } : {}),
      ...(warnings.length > 0 ? { warnings } : {}),
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
