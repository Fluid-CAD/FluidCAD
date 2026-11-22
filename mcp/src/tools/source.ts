// Source-editing tools — let the agent read, write, and walk `.fluid.js`
// sources inside a workspace. Writes are gated by a dirty-buffer check
// against the editor extension, atomic via tmp+rename, and confined to the
// workspace root (symlinks that escape are rejected).

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { findByWorkspace, listLiveInstances } from '../discovery.ts';
import { FluidCadClient, HttpError } from '../client.ts';
import { err, ok, type ToolResult } from '../types.ts';
import type { RegistryEntry } from '../types.ts';
import type { WorkspaceArg } from './inspection.ts';

export type { WorkspaceArg } from './inspection.ts';

/**
 * Resolve a workspace argument to a `RegistryEntry`. Distinct from the
 * inspection-tools variant: source tools rarely need an HTTP client (only
 * `write_file`/`edit_range` do, and only to probe dirty buffers), so we
 * return the entry directly and let callers open a client when required.
 */
function resolveEntry(input: WorkspaceArg): ToolResult<RegistryEntry> {
  if (input?.pinnedWorkspace) {
    return ok(input.pinnedWorkspace);
  }
  if (input?.workspace) {
    const entry = findByWorkspace(input.workspace);
    if (!entry) {
      return err(
        'workspace-not-found',
        `No running FluidCAD workspace at "${input.workspace}". Call list_workspaces to see what's available.`,
      );
    }
    return ok(entry);
  }
  const instances = listLiveInstances();
  if (instances.length === 0) {
    return err('no-server', 'No running FluidCAD workspaces. Start one with `fluidcad serve`.');
  }
  if (instances.length > 1) {
    return err(
      'no-workspace',
      `Multiple FluidCAD workspaces are running (${instances.length}). Pass \`workspace\` to disambiguate.`,
      { workspaces: instances.map((e) => e.workspacePath) },
    );
  }
  return ok(instances[0]);
}

/**
 * Resolve a user-supplied path against the workspace root, then verify the
 * result still lives under the workspace (symlinks included). Returns the
 * canonical absolute path on success.
 */
function resolveWithinWorkspace(
  workspaceRoot: string,
  userPath: string,
  { mustExist }: { mustExist: boolean },
): ToolResult<{ absPath: string; rootReal: string }> {
  if (typeof userPath !== 'string' || userPath.length === 0) {
    return err('invalid-input', '`path` is required and must be a non-empty string.');
  }
  const rootReal = (() => {
    try {
      return fs.realpathSync(workspaceRoot);
    } catch {
      return path.resolve(workspaceRoot);
    }
  })();
  const candidate = path.resolve(rootReal, userPath);
  let canonical = candidate;
  try {
    canonical = fs.realpathSync(candidate);
  } catch (e: any) {
    if (mustExist || e?.code !== 'ENOENT') {
      if (mustExist) {
        return err('invalid-input', `File not found: ${userPath}`);
      }
      return err('internal', e?.message ?? String(e));
    }
    // File doesn't exist yet — for writes, fall back to the parent dir's
    // realpath so we still catch symlink escape via the parent.
    const parent = path.dirname(candidate);
    try {
      const parentReal = fs.realpathSync(parent);
      canonical = path.join(parentReal, path.basename(candidate));
    } catch {
      // Parent doesn't exist either — keep the resolved candidate; the
      // boundary check below still catches `..` escapes.
    }
  }
  const rel = path.relative(rootReal, canonical);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    return err('invalid-input', `Path escapes workspace root: ${userPath}`);
  }
  return ok({ absPath: canonical, rootReal });
}

type DirtyFileEntry = { path: string; lastModifiedMs: number };

type LintMissingImport = { symbol: string; module: string; line: number; column: number };
/**
 * A file-level rule violation the lint can prove statically: `unit()`
 * placement in a model, the params-file rules in a `*.params.js`.
 */
type LintDiagnostic = { message: string; line: number; column: number; rule?: string };
/** `diagnostics` is absent from servers that predate it. */
type LintResult = { missing: LintMissingImport[]; suggestion: string; diagnostics?: LintDiagnostic[] };

/**
 * Static import lint for a `.fluid.js` payload via the server's
 * `POST /api/lint-fluid-js` endpoint. The server owns the tree-sitter parser
 * and the FluidCAD symbol table, so MCP stays a thin proxy.
 *
 * Failure is non-fatal: if the server endpoint is missing (older release) or
 * the request errors, the lint is treated as "no missing imports" so writes
 * still succeed. The render step downstream will catch any resulting
 * `ReferenceError` if the lint was bypassed.
 */
async function lintFluidJsCode(entry: RegistryEntry, absPath: string, code: string): Promise<LintResult | null> {
  const client = new FluidCadClient(entry);
  try {
    // The path travels too: `unit()` is only legal outside `*.assembly.js`.
    const result = await client.postJson<LintResult>('/api/lint-fluid-js', { code, filePath: absPath });
    return result;
  } catch (e) {
    if (e instanceof HttpError && e.statusCode === 404) {
      return null;
    }
    return null;
  } finally {
    await client.close().catch(() => {});
  }
}

/**
 * Every FluidCAD script kind (mirrors `server/src/file-kind.ts`): assembly
 * files are linted too, both for their imports and because `unit()` is the
 * one statement the lint has to REJECT there.
 */
function isFluidScriptPath(absPath: string): boolean {
  const lower = absPath.toLowerCase();
  return lower.endsWith('.fluid.js') || lower.endsWith('.part.js') || lower.endsWith('.assembly.js');
}

/**
 * A `*.params.js` project-parameters module (mirrors `isParamsFile` in
 * `server/src/file-kind.ts`). Not a model: it is linted against its own
 * rules and never rendered as the scene — a write folds into the open model
 * as a dependency instead (`docs/global-parameters-plan.md` §2.2, §3.6).
 */
export function isParamsPath(absPath: string): boolean {
  return absPath.toLowerCase().endsWith('.params.js');
}

/**
 * Refuse a write if the post-edit content uses FluidCAD APIs without the
 * matching `import { … } from "fluidcad/…"` line. Bypassable with
 * `force: true`, identical to the dirty-buffer guard, since both protect
 * against the most common "first draft" mistakes LLMs make.
 */
async function assertImportsPresent(
  entry: RegistryEntry,
  absPath: string,
  code: string,
  force: boolean | undefined,
  purpose: 'write' | 'build' = 'write',
): Promise<ToolResult<void>> {
  if (force === true) {
    return ok(undefined);
  }
  // How a refusal opens and closes: a write names its `force` override; a
  // candidate `try_build` was handed has none, and is told what a write of
  // it would meet.
  const refusing = purpose === 'write'
    ? `Refusing to write "${absPath}"`
    : `Not built: write_file would refuse this candidate of "${absPath}"`;
  const override = purpose === 'write' ? ' (pass `force: true` to override)' : '';
  if (!isFluidScriptPath(absPath) && !isParamsPath(absPath)) {
    return ok(undefined);
  }
  const lint = await lintFluidJsCode(entry, absPath, code);
  if (!lint) {
    return ok(undefined);
  }
  const diagnostics = lint.diagnostics ?? [];
  if (diagnostics.length > 0 && isParamsPath(absPath)) {
    // The params-file rules: only imports and `export const` at the top
    // level, every param() exported, no geometry / unit() / property(), no
    // model-file imports. Refused before the write, with the rows, so the
    // agent fixes the statement instead of every importer failing to build.
    const listed = diagnostics.map((d) => `  line ${d.line + 1}: ${d.message}`).join('\n');
    return err(
      'params-file',
      [
        `${refusing} — ${diagnostics.length} project-parameters file rule violation(s)${override}:`,
        listed,
        'A *.params.js file holds only imports (fluidcad/core, fluidcad/units, other *.params.js files)' +
          ' and `export const <name> = param(…)` / `export const <name> = <expression>` declarations.',
      ].join('\n'),
      { diagnostics },
    );
  }
  if (diagnostics.some((d) => d.rule === 'part-export' || d.rule === 'part-name')) {
    // The part rules (every part exported from the top level, names unique
    // in the file): the render would fail each offending part() with the
    // same message — refusing here gives the agent the rows first.
    const listed = diagnostics.map((d) => `  line ${d.line + 1}: ${d.message}`).join('\n');
    return err(
      'part-rules',
      [
        `${refusing} — ${diagnostics.length} file rule violation(s)${override}:`,
        listed,
        'Every part is `export const <name> = part(\'Name\', () => { … })` at the top level of its file,' +
          ' and no two parts of a file share a name.',
      ].join('\n'),
      { diagnostics },
    );
  }
  if (diagnostics.length > 0) {
    // Placement rules the runtime would reject anyway — refusing here gives
    // the agent the row instead of a compile error after the render.
    const listed = diagnostics.map((d) => `  line ${d.line + 1}: ${d.message}`).join('\n');
    return err(
      'unit-statement',
      [
        `${refusing} — ${diagnostics.length} unit() rule violation(s)${override}:`,
        listed,
      ].join('\n'),
      { diagnostics },
    );
  }
  if (lint.missing.length === 0) {
    return ok(undefined);
  }
  const symbolList = lint.missing.map((m) => m.symbol).join(', ');
  return err(
    'missing-imports',
    [
      `${refusing} — uses ${lint.missing.length} FluidCAD ` +
        `symbol(s) without an import: ${symbolList}.`,
      `Add this to the top of the file${override}:`,
      lint.suggestion,
    ].join('\n'),
    { missing: lint.missing, suggestion: lint.suggestion },
  );
}

/**
 * One feature that failed to build during an otherwise completed render.
 * `line`/`column` are 1-based.
 */
export type ObjectBuildError = {
  index: number;
  id: string;
  name: string;
  uniqueKind: string;
  message: string;
  sourceLocation?: { filePath: string; line: number; column: number };
};

/** Axis-aligned bounds in the document unit, rounded to its meaningful precision. */
export type RenderChangeBounds = { min: [number, number, number]; max: [number, number, number] };

/** One scene object a render built (or built again). */
export type RenderChangeEntry = {
  /** The object's id in this render — what `get_scene_summary` reports now. */
  sceneObjectId: string;
  name: string;
  kind: string;
  sourceLocation?: { filePath: string; line: number; column: number };
  /** Shapes the object added to the scene. */
  shapes: number;
  /** Exact bounds of the object's added solids before and after the render; a side is absent when that instance added no solid. */
  bounds?: { before?: RenderChangeBounds; after?: RenderChangeBounds };
};

/**
 * What a render changed, from the engine's incremental compare. Mirrored
 * from `lib/rendering/render-changes.ts`. Requested with `changes: true` on
 * the render; the tools send it unless `includeChanges: false`.
 */
export type RenderChanges = {
  /** Objects whose geometry was built again, paired with their previous instance. */
  rebuilt: RenderChangeEntry[];
  /** Objects the previous render did not have. */
  added: RenderChangeEntry[];
  /** Objects the previous render had and this one does not (`sceneObjectId` is the old id). */
  removed: { sceneObjectId: string; name: string; kind: string; sourceLocation?: { filePath: string; line: number; column: number } }[];
  /** Objects served from cache, geometry untouched. */
  reused: number;
  /** Entries dropped from the lists above by the size cap. */
  truncated?: number;
};

/**
 * Render outcome as reported by `POST /api/render`. Mirrored from
 * `server/src/routes/render.ts` — kept hand-typed here so the MCP package
 * doesn't take a build-time dep on the server package.
 *
 * `build-error` is the "the code ran, the model is wrong" case: a feature's
 * build threw, the renderer recorded it on that object and carried on, so a
 * scene is being served but it's missing whatever that feature produced.
 *
 * `uiApplied` separates "built" from "visible": true once a connected viewer
 * has this render on screen, false when none is connected or it is still
 * applying the scene. Absent on servers that predate the field.
 */
export type RenderOutcome =
  | { state: 'rendered'; version: number; absPath: string; durationMs: number; changes?: RenderChanges; uiApplied?: boolean }
  | {
      state: 'build-error';
      version: number;
      absPath: string;
      durationMs: number;
      objectErrors: ObjectBuildError[];
      changes?: RenderChanges;
      uiApplied?: boolean;
    }
  | {
      state: 'compile-error';
      version: number;
      durationMs: number;
      compileError: {
        message: string;
        filePath?: string;
        sourceLocation?: { filePath: string; line: number; column: number };
      };
    }
  | { state: 'superseded'; version: number; durationMs: number }
  | { state: 'no-scene-manager'; version: number; durationMs: number }
  /** A `*.params.js` write with no model open: nothing to re-render; the file is on disk. */
  | { state: 'no-model'; version: number; absPath: string; durationMs: number }
  | { state: 'render-failed'; error: string };

/**
 * What writing a file that is not a model did to the scene (see
 * `OpenModelRender`): the open model re-rendered with the file's new
 * contents in effect — `rendered` / `build-error` as for a model, with
 * `openModel: true` — or nothing re-rendered, and why.
 */
export type OpenModelRenderOutcome =
  | {
      state: 'rendered' | 'build-error';
      /** The model that re-rendered is the open one, not the file written. */
      openModel: true;
      objectErrors?: ObjectBuildError[];
      changes?: RenderChanges;
      uiApplied?: boolean;
    }
  | { state: 'no-open-model'; reason: string }
  | { state: 'not-rendered'; reason: string }
  | { state: 'render-failed'; error: string };

/**
 * After a write to a file that is not a model (`.fluid.js`, `.part.js`,
 * `.assembly.js`): such a file never becomes the rendered model — a
 * `*.feature.js` custom feature module rendered as one would leave the
 * viewport on an empty scene, or on a misleading compile error. A file the
 * open model can read — a JavaScript module it may import (a feature
 * module, a helper) or `fluidcad.json` — re-renders the open model instead,
 * rebuilt in full so a module's new code takes effect even where a
 * statement's values match its cached build. Any other file (an icon, a
 * note) re-renders nothing.
 */
export class OpenModelRender {

  private static readonly MODULE = /\.(m|c)?js$/i;

  /** Whether a model may read `absPath`: a JavaScript module or the project's `fluidcad.json`. */
  static isModelInput(absPath: string): boolean {
    return OpenModelRender.MODULE.test(absPath) || path.basename(absPath) === 'fluidcad.json';
  }

  static async after(entry: RegistryEntry, absPath: string, changes: boolean): Promise<OpenModelRenderOutcome> {
    if (!OpenModelRender.isModelInput(absPath)) {
      return { state: 'not-rendered', reason: 'Not a model, nor a module or fluidcad.json a model reads: nothing re-rendered.' };
    }
    const client = new FluidCadClient(entry);
    try {
      const report = await client.postJson<{
        state?: 'rendered' | 'build-error';
        objectErrors?: ObjectBuildError[];
        changes?: RenderChanges;
        uiApplied?: boolean;
      }>('/api/recompute', { awaitUi: true, ...(changes ? { changes: true } : {}) });
      return {
        state: report.state ?? ((report.objectErrors?.length ?? 0) > 0 ? 'build-error' : 'rendered'),
        openModel: true,
        ...(report.objectErrors ? { objectErrors: report.objectErrors } : {}),
        ...(report.changes ? { changes: report.changes } : {}),
        ...(report.uiApplied !== undefined ? { uiApplied: report.uiApplied } : {}),
      };
    } catch (e: any) {
      if (e instanceof HttpError && e.statusCode === 404) {
        return {
          state: 'no-open-model',
          reason: 'No model is open, so nothing re-rendered. Write (or open) the model that imports the file to see it build.',
        };
      }
      if (e instanceof HttpError) {
        return {
          state: 'render-failed',
          error: `The open model failed to re-render with the new file: ${OpenModelRender.messageOf(e.body)} — call get_compile_error for where.`,
        };
      }
      return { state: 'render-failed', error: e?.message ?? String(e) };
    } finally {
      await client.close().catch(() => {});
    }
  }

  /**
   * The error an engine's failing route answered with: a JSON `{ error }`,
   * or the HTML page the HTTP server writes for a thrown error, read down to
   * the error's first line.
   */
  static messageOf(body: string): string {
    try {
      const parsed = JSON.parse(body);
      if (parsed && typeof parsed.error === 'string') {
        return parsed.error;
      }
    } catch {
      // Not JSON: the HTML error page.
    }
    const pre = body.match(/<pre>([\s\S]*?)<\/pre>/i);
    const text = (pre ? pre[1] : body)
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<[^>]+>/g, '')
      .replace(/&nbsp;/g, ' ')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&amp;/g, '&');
    const lines = text.split('\n').map(line => line.trim()).filter(line => line.length > 0);
    const message = lines.filter(line => !line.startsWith('at ')).slice(0, 3).join(' ');
    return (message || text.trim()).slice(0, 500);
  }
}

/**
 * Ask the running FluidCAD server to render `code` for `filePath`. Used by
 * `write_file` / `edit_range` to make the agent's edit synchronous: the
 * disk write returns once the render settles, so the caller doesn't need a
 * separate round-trip to observe completion.
 *
 * Non-fatal: any transport error is folded into the outcome as
 * `render-failed` so the agent still sees the write succeeded.
 *
 * `changes` asks the server for the render's change summary (see
 * `RenderChanges`); the flag is only sent when set, so an older server
 * sees the request it always did.
 *
 * `fitView` asks every connected page to frame the model once the render
 * is on screen: the person watching an agent model sees each edit land in
 * frame instead of off-screen. An older server ignores the flag.
 *
 * A `*.params.js` file is never the model: it is sent with `keepCurrent`,
 * which re-renders the open model against the new text as a dependency
 * (the server refuses the file with 422 otherwise), and answers `no-model`
 * when nothing is open.
 */
async function triggerRender(
  entry: RegistryEntry,
  filePath: string,
  code: string,
  changes: boolean,
): Promise<RenderOutcome> {
  const client = new FluidCadClient(entry);
  try {
    const outcome = await client.postJson<RenderOutcome>('/api/render', {
      filePath,
      code,
      awaitUi: true,
      fitView: true,
      ...(changes ? { changes: true } : {}),
      ...(isParamsPath(filePath) ? { keepCurrent: true } : {}),
    });
    return outcome;
  } catch (e: any) {
    if (e instanceof HttpError && e.statusCode === 404) {
      // Older server without /api/render — silently degrade. The agent still
      // gets `written: true`; the file watcher (under `fluidcad serve`) or
      // the next editor save will eventually trigger the render.
      return { state: 'render-failed', error: 'Server has no /api/render endpoint (upgrade fluidcad).' };
    }
    return { state: 'render-failed', error: e?.message ?? String(e) };
  } finally {
    await client.close().catch(() => {});
  }
}

/**
 * Fetch the editor's dirty-buffer set. Failure to reach the server is
 * non-fatal — the tool will treat the set as empty so the agent can still
 * write when the editor extension is not connected. The MCP description
 * surfaces this caveat.
 */
async function fetchDirtyFiles(entry: RegistryEntry): Promise<DirtyFileEntry[]> {
  const client = new FluidCadClient(entry);
  try {
    const dirty = await client.getJson<DirtyFileEntry[]>('/api/editor/dirty-files');
    return Array.isArray(dirty) ? dirty : [];
  } catch (e) {
    if (e instanceof HttpError && e.statusCode === 404) {
      // Older server with no dirty-files endpoint — treat as none dirty.
      return [];
    }
    throw e;
  } finally {
    await client.close().catch(() => {});
  }
}

function pathsEqual(a: string, b: string): boolean {
  // Best-effort case-insensitive compare on Windows. On Linux/macOS file
  // systems we still mostly want exact match, but realpath canonicalizes
  // case on macOS HFS+, so direct `===` is usually enough.
  if (process.platform === 'win32') {
    return a.toLowerCase() === b.toLowerCase();
  }
  return a === b;
}

async function assertNotDirty(
  entry: RegistryEntry,
  absPath: string,
  force: boolean | undefined,
): Promise<ToolResult<void>> {
  if (force === true) {
    return ok(undefined);
  }
  let dirty: DirtyFileEntry[];
  try {
    dirty = await fetchDirtyFiles(entry);
  } catch (e: any) {
    return err('http-error', `Could not check dirty buffers: ${e?.message ?? String(e)}`);
  }
  const conflict = dirty.find((d) => pathsEqual(d.path, absPath));
  if (conflict) {
    return err(
      'dirty-buffer',
      `Refusing to write "${absPath}" — the editor has unsaved changes. Save in the editor, or pass \`force: true\` to overwrite.`,
      { dirtyFiles: dirty.map((d) => d.path) },
    );
  }
  return ok(undefined);
}

/**
 * Atomic file write: write to a sibling tmp file, fsync it, then rename
 * over the destination. Mirrors `server/src/instance-file.ts` so a crash
 * mid-write never leaves a half-written `.fluid.js` on disk.
 */
async function atomicWrite(absPath: string, content: string): Promise<void> {
  const dir = path.dirname(absPath);
  await fsp.mkdir(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(absPath)}.${process.pid}.tmp`);
  const fh = await fsp.open(tmp, 'w', 0o644);
  try {
    await fh.writeFile(content, { encoding: 'utf8' });
    await fh.sync();
  } finally {
    await fh.close();
  }
  await fsp.rename(tmp, absPath);
}

// ---------------------------------------------------------------------------
// read_file
// ---------------------------------------------------------------------------

export type ReadFileInput = WorkspaceArg & { path: string };
export type ReadFileOutput = { path: string; content: string };

export async function readFile(input: ReadFileInput): Promise<ToolResult<ReadFileOutput>> {
  const entry = resolveEntry(input);
  if (entry.ok === false) {
    return entry as ToolResult<ReadFileOutput>;
  }
  const resolved = resolveWithinWorkspace(entry.data.workspacePath, input?.path, { mustExist: true });
  if (resolved.ok === false) {
    return resolved as ToolResult<ReadFileOutput>;
  }
  try {
    const content = await fsp.readFile(resolved.data.absPath, 'utf8');
    return ok({ path: resolved.data.absPath, content });
  } catch (e: any) {
    return err('internal', e?.message ?? String(e));
  }
}

// ---------------------------------------------------------------------------
// write_file
// ---------------------------------------------------------------------------

export type WriteFileInput = WorkspaceArg & {
  path: string;
  content: string;
  force?: boolean;
  /** Ask for `render.changes` (default true); false skips the summary on a huge model. */
  includeChanges?: boolean;
};

/** The tools ask for the change summary unless told not to. */
function wantsChanges(input: { includeChanges?: boolean }): boolean {
  return input.includeChanges !== false;
}
export type WriteFileOutput = {
  path: string;
  bytesWritten: number;
  /** A model's own render, or — for any other file — what became of the open model (see `OpenModelRender`). */
  render: RenderOutcome | OpenModelRenderOutcome;
};

export async function writeFile(input: WriteFileInput): Promise<ToolResult<WriteFileOutput>> {
  if (typeof input?.content !== 'string') {
    return err('invalid-input', '`content` is required and must be a string.');
  }
  const entry = resolveEntry(input);
  if (entry.ok === false) {
    return entry as ToolResult<WriteFileOutput>;
  }
  const resolved = resolveWithinWorkspace(entry.data.workspacePath, input?.path, { mustExist: false });
  if (resolved.ok === false) {
    return resolved as ToolResult<WriteFileOutput>;
  }
  const guard = await assertNotDirty(entry.data, resolved.data.absPath, input.force);
  if (guard.ok === false) {
    return guard as ToolResult<WriteFileOutput>;
  }
  const importGuard = await assertImportsPresent(
    entry.data,
    resolved.data.absPath,
    input.content,
    input.force,
  );
  if (importGuard.ok === false) {
    return importGuard as ToolResult<WriteFileOutput>;
  }
  try {
    await atomicWrite(resolved.data.absPath, input.content);
  } catch (e: any) {
    return err('internal', e?.message ?? String(e));
  }
  // A model renders itself; a *.params.js file folds into the open model as
  // a dependency (keepCurrent, see triggerRender); any other file re-renders
  // the open model through OpenModelRender.
  const render = isFluidScriptPath(resolved.data.absPath) || isParamsPath(resolved.data.absPath)
    ? await triggerRender(entry.data, resolved.data.absPath, input.content, wantsChanges(input))
    : await OpenModelRender.after(entry.data, resolved.data.absPath, wantsChanges(input));
  return ok({
    path: resolved.data.absPath,
    bytesWritten: Buffer.byteLength(input.content, 'utf8'),
    render,
  });
}

// ---------------------------------------------------------------------------
// edit_range
// ---------------------------------------------------------------------------

export type Position = { line: number; column: number };
export type EditRangeInput = WorkspaceArg & {
  path: string;
  start: Position;
  end: Position;
  newText: string;
  force?: boolean;
  /** Ask for `render.changes` (default true); false skips the summary on a huge model. */
  includeChanges?: boolean;
};
export type EditRangeOutput = {
  path: string;
  bytesWritten: number;
  replacedRange: { start: Position; end: Position };
  /** As `WriteFileOutput.render`. */
  render: RenderOutcome | OpenModelRenderOutcome;
};

function isValidPosition(value: unknown): value is Position {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const v = value as Record<string, unknown>;
  return (
    typeof v.line === 'number' &&
    Number.isInteger(v.line) &&
    v.line >= 0 &&
    typeof v.column === 'number' &&
    Number.isInteger(v.column) &&
    v.column >= 0
  );
}

function comparePositions(a: Position, b: Position): number {
  if (a.line !== b.line) {
    return a.line - b.line;
  }
  return a.column - b.column;
}

/**
 * Convert a `{ line, column }` position to a UTF-16 character offset into
 * `text`. Columns past end-of-line clamp to the line's length; lines past
 * end-of-file clamp to the file's length. Both behaviours match LSP's
 * forgiving range semantics and match VSCode's `TextDocument.offsetAt`.
 */
function offsetAt(text: string, pos: Position): number {
  let lineStart = 0;
  let line = 0;
  while (line < pos.line) {
    const nl = text.indexOf('\n', lineStart);
    if (nl === -1) {
      return text.length;
    }
    lineStart = nl + 1;
    line++;
  }
  const lineEnd = (() => {
    const nl = text.indexOf('\n', lineStart);
    return nl === -1 ? text.length : nl;
  })();
  return Math.min(lineStart + pos.column, lineEnd);
}

/**
 * The text `edit_range` writes: `original` with `[start, end)` replaced by
 * `newText`, positions clamped as `offsetAt` clamps them.
 */
export function applyRangeEdit(original: string, start: Position, end: Position, newText: string): string {
  return original.slice(0, offsetAt(original, start)) + newText + original.slice(offsetAt(original, end));
}

function checkEditRangeInput(input: EditRangeInput): ToolResult<void> {
  if (typeof input?.newText !== 'string') {
    return err('invalid-input', '`newText` is required and must be a string.');
  }
  if (!isValidPosition(input?.start)) {
    return err('invalid-input', '`start` must be `{ line: number >= 0, column: number >= 0 }`.');
  }
  if (!isValidPosition(input?.end)) {
    return err('invalid-input', '`end` must be `{ line: number >= 0, column: number >= 0 }`.');
  }
  if (comparePositions(input.start, input.end) > 0) {
    return err('invalid-input', '`start` must be at or before `end`.');
  }
  return ok(undefined);
}

/** What a `write_file` or `edit_range` call would change: the file now, and after. */
export type SourceEditPreview = {
  /** Canonical absolute path, as the tool resolves it. */
  absPath: string;
  /** False when `write_file` would create the file; `before` is then ''. */
  existed: boolean;
  before: string;
  after: string;
};

/**
 * What `write_file` / `edit_range` would write, without writing: the same
 * input checks, path confinement and edit as the tools, on the file as it is
 * now. The dirty-buffer and lint guards need the engine and are not run, so
 * the real call may still refuse. A host uses this to show a diff before
 * approving a call, and to keep a copy of the file before it runs.
 */
export async function previewSourceEdit(
  tool: 'write_file' | 'edit_range',
  input: WriteFileInput | EditRangeInput,
): Promise<ToolResult<SourceEditPreview>> {
  if (tool === 'write_file') {
    if (typeof (input as WriteFileInput)?.content !== 'string') {
      return err('invalid-input', '`content` is required and must be a string.');
    }
  } else {
    const checked = checkEditRangeInput(input as EditRangeInput);
    if (checked.ok === false) {
      return checked as ToolResult<SourceEditPreview>;
    }
  }
  const entry = resolveEntry(input);
  if (entry.ok === false) {
    return entry as ToolResult<SourceEditPreview>;
  }
  const resolved = resolveWithinWorkspace(entry.data.workspacePath, input?.path, { mustExist: tool === 'edit_range' });
  if (resolved.ok === false) {
    return resolved as ToolResult<SourceEditPreview>;
  }
  const absPath = resolved.data.absPath;
  let before = '';
  let existed = true;
  try {
    before = await fsp.readFile(absPath, 'utf8');
  } catch (e: any) {
    if (e?.code !== 'ENOENT' || tool === 'edit_range') {
      return err('internal', e?.message ?? String(e));
    }
    existed = false;
  }
  const after = tool === 'write_file'
    ? (input as WriteFileInput).content
    : applyRangeEdit(before, (input as EditRangeInput).start, (input as EditRangeInput).end, (input as EditRangeInput).newText);
  return ok({ absPath, existed, before, after });
}

export async function editRange(input: EditRangeInput): Promise<ToolResult<EditRangeOutput>> {
  const checked = checkEditRangeInput(input);
  if (checked.ok === false) {
    return checked as ToolResult<EditRangeOutput>;
  }

  const entry = resolveEntry(input);
  if (entry.ok === false) {
    return entry as ToolResult<EditRangeOutput>;
  }
  const resolved = resolveWithinWorkspace(entry.data.workspacePath, input?.path, { mustExist: true });
  if (resolved.ok === false) {
    return resolved as ToolResult<EditRangeOutput>;
  }
  const guard = await assertNotDirty(entry.data, resolved.data.absPath, input.force);
  if (guard.ok === false) {
    return guard as ToolResult<EditRangeOutput>;
  }
  let original: string;
  try {
    original = await fsp.readFile(resolved.data.absPath, 'utf8');
  } catch (e: any) {
    return err('internal', e?.message ?? String(e));
  }
  const next = applyRangeEdit(original, input.start, input.end, input.newText);
  const importGuard = await assertImportsPresent(
    entry.data,
    resolved.data.absPath,
    next,
    input.force,
  );
  if (importGuard.ok === false) {
    return importGuard as ToolResult<EditRangeOutput>;
  }
  try {
    await atomicWrite(resolved.data.absPath, next);
  } catch (e: any) {
    return err('internal', e?.message ?? String(e));
  }
  // A model renders itself; a *.params.js file folds into the open model as
  // a dependency (keepCurrent, see triggerRender); any other file re-renders
  // the open model through OpenModelRender.
  const render = isFluidScriptPath(resolved.data.absPath) || isParamsPath(resolved.data.absPath)
    ? await triggerRender(entry.data, resolved.data.absPath, next, wantsChanges(input))
    : await OpenModelRender.after(entry.data, resolved.data.absPath, wantsChanges(input));
  return ok({
    path: resolved.data.absPath,
    bytesWritten: Buffer.byteLength(next, 'utf8'),
    replacedRange: { start: input.start, end: input.end },
    render,
  });
}

// ---------------------------------------------------------------------------
// try_build
// ---------------------------------------------------------------------------

/** One `edit_range` replacement: `[start, end)` of the file as it is now becomes `newText`. */
export type RangeEdit = { start: Position; end: Position; newText: string };

/**
 * `original` with every edit applied, each range addressed in `original`
 * (not in the text an earlier edit of the list left), positions clamped as
 * {@link applyRangeEdit} clamps them. Edits may come in any order; two that
 * overlap are refused, since their result would depend on it.
 */
export function applyRangeEdits(original: string, edits: RangeEdit[]): ToolResult<string> {
  const spans: { from: number; to: number; newText: string }[] = [];
  for (const [index, edit] of edits.entries()) {
    if (typeof edit?.newText !== 'string' || !isValidPosition(edit?.start) || !isValidPosition(edit?.end)) {
      return err('invalid-input', `\`edits[${index}]\` must be \`{ start, end, newText }\` with 0-based \`{ line, column }\` positions.`);
    }
    if (comparePositions(edit.start, edit.end) > 0) {
      return err('invalid-input', `\`edits[${index}].start\` must be at or before its \`end\`.`);
    }
    spans.push({ from: offsetAt(original, edit.start), to: offsetAt(original, edit.end), newText: edit.newText });
  }
  // Last range first, so the offsets of the ranges before it still hold.
  spans.sort((a, b) => b.from - a.from || b.to - a.to);
  let text = original;
  let floor = Infinity;
  for (const span of spans) {
    if (span.to > floor) {
      return err('invalid-input', '`edits` overlap: give each range of the file once.');
    }
    text = text.slice(0, span.from) + span.newText + text.slice(span.to);
    floor = span.from;
  }
  return ok(text);
}

export type TryBuildInput = WorkspaceArg & {
  path: string;
  /** The whole candidate text of the file, as `write_file` takes it. */
  content?: string;
  /** Or the candidate as replacements in the file on disk, each as `edit_range` takes one. */
  edits?: RangeEdit[];
  /** Parameter values for this build only, by label. */
  params?: Record<string, string | number | boolean | (string | number)[]>;
};

/**
 * What a scratch build produced. Mirrored from
 * `server/src/fluidcad-server/scratch-build.ts` (`ScratchBuildOutcome`) —
 * hand-typed here like `RenderOutcome`.
 */
export type TryBuildFacts = {
  /** Names the build's meshes on the engine (`GET /api/scratch-build/:id/meshes`) while it keeps them. */
  id: string;
  file: string;
  sceneKind: 'part' | 'assembly';
  unit: string;
  durationMs: number;
  builtFrom: 'source' | 'buffer' | 'disk';
  configuration: string;
  sessionOverrides: number;
  unusedParams: string[];
  solidCount: number;
  bounds: RenderChangeBounds | null;
  volume: number | null;
  validation: {
    ok: boolean;
    checked: number;
    findings: { kind: string; shapeId: string; sceneObjectId: string; part: string | null; message: string }[];
    skipped: number;
  } | null;
  instanceCount?: number;
  breakpointHit?: true;
};

export type TryBuildOutput =
  | ({ state: 'rendered' } & TryBuildFacts)
  | ({ state: 'build-error'; objectErrors: ObjectBuildError[] } & TryBuildFacts)
  | {
      state: 'compile-error';
      file: string;
      durationMs: number;
      compileError: { message: string; filePath?: string; sourceLocation?: { filePath: string; line: number; column: number } };
    };

/** A candidate version of a model file, as `try_build` and `propose_variants` take one. */
export type CandidateInput = WorkspaceArg & {
  path: string;
  /** The whole candidate text of the file, as `write_file` takes it. */
  content?: string;
  /** Or the candidate as replacements in the file on disk, each as `edit_range` takes one. */
  edits?: RangeEdit[];
  /**
   * Also refuse a file the editor has unsaved changes for (`dirty-buffer`),
   * as a write would: for a caller that means to write the candidate.
   */
  refuseDirty?: boolean;
};

/** A candidate that passed the checks a write of it would: where it goes, the file as it is, and its text. */
export type Candidate = {
  /** Canonical absolute path, as the write tools resolve it. */
  absPath: string;
  /** False when the file does not exist yet; `before` is then ''. */
  existed: boolean;
  /** The file on disk when the candidate was read. */
  before: string;
  /** The whole text of the candidate. */
  text: string;
};

/**
 * The candidate an input names, checked as a write of it would be: the path
 * confined to the workspace, a model file, `content` or `edits` (applied to
 * the file on disk) or neither for the file as it is, then the lint guards
 * `write_file` applies (`missing-imports`, `part-rules`, `unit-statement`).
 * The dirty-buffer guard runs only on `refuseDirty`. Nothing is built or
 * written. `tool` names the caller in a refusal.
 */
export async function resolveCandidate(input: CandidateInput, tool: string = 'try_build'): Promise<ToolResult<Candidate>> {
  if (input?.content !== undefined && typeof input.content !== 'string') {
    return err('invalid-input', '`content` must be a string: the whole candidate text of the file.');
  }
  if (input?.edits !== undefined && (!Array.isArray(input.edits) || input.edits.length === 0)) {
    return err('invalid-input', '`edits` must be a non-empty array of `{ start, end, newText }`.');
  }
  if (input?.content !== undefined && input?.edits !== undefined) {
    return err('invalid-input', 'Pass the candidate as `content` or as `edits`, not both.');
  }
  const entry = resolveEntry(input);
  if (entry.ok === false) {
    return entry as ToolResult<Candidate>;
  }
  // Only a whole candidate may be of a file that does not exist yet.
  const resolved = resolveWithinWorkspace(entry.data.workspacePath, input?.path, { mustExist: input.content === undefined });
  if (resolved.ok === false) {
    return resolved as ToolResult<Candidate>;
  }
  const absPath = resolved.data.absPath;
  if (!isFluidScriptPath(absPath)) {
    return err(
      'invalid-input',
      `${tool} builds a model file (.fluid.js, .part.js, .assembly.js); "${input.path}" is not one. `
        + 'To see what a change to another file does to a model, write it: the write reports the open model\'s render.',
    );
  }
  let before = '';
  let existed = true;
  try {
    before = await fsp.readFile(absPath, 'utf8');
  } catch (e: any) {
    if (e?.code !== 'ENOENT' || input.content === undefined) {
      return err('internal', e?.message ?? String(e));
    }
    existed = false;
  }
  let text = input.content;
  if (text === undefined) {
    const edited = input.edits ? applyRangeEdits(before, input.edits) : ok(before);
    if (edited.ok === false) {
      return edited as ToolResult<Candidate>;
    }
    text = edited.data;
  }
  if (input.refuseDirty === true) {
    const dirty = await assertNotDirty(entry.data, absPath, false);
    if (dirty.ok === false) {
      return dirty as ToolResult<Candidate>;
    }
  }
  const guard = await assertImportsPresent(entry.data, absPath, text, false, 'build');
  if (guard.ok === false) {
    return guard as ToolResult<Candidate>;
  }
  return ok({ absPath, existed, before, text });
}

/**
 * Build `text` as the model file `absPath` on the engine without writing it
 * (`POST /api/scratch-build`). Nothing live changes — see
 * `FluidCadServer.scratchBuild`. The text is built as given: check it with
 * {@link resolveCandidate} first.
 */
export async function buildCandidate(
  input: WorkspaceArg & { absPath: string; text: string; params?: TryBuildInput['params'] },
): Promise<ToolResult<TryBuildOutput>> {
  const entry = resolveEntry(input);
  if (entry.ok === false) {
    return entry as ToolResult<TryBuildOutput>;
  }
  const client = new FluidCadClient(entry.data);
  try {
    return ok(await client.postJson<TryBuildOutput>('/api/scratch-build', {
      file: input.absPath,
      source: input.text,
      ...(input.params !== undefined ? { params: input.params } : {}),
    }));
  } catch (e: any) {
    if (e instanceof HttpError && e.statusCode === 404) {
      // The candidate always travels, so the route itself never answers 404:
      // an engine without the route does.
      return err('http-error', 'This FluidCAD engine has no scratch builds (upgrade fluidcad).', { statusCode: 404 });
    }
    if (e instanceof HttpError) {
      return err(e.statusCode === 400 || e.statusCode === 422 ? 'invalid-input' : 'http-error', OpenModelRender.messageOf(e.body), { statusCode: e.statusCode });
    }
    return err('internal', e?.message ?? String(e));
  } finally {
    await client.close().catch(() => {});
  }
}

/**
 * Build a candidate version of a model file on the engine without writing
 * it: the file as it would be with `content`, or with `edits` applied to
 * what is on disk, or as it is. The candidate passes the lint guards
 * `write_file` applies first ({@link resolveCandidate}), so one that builds
 * here is one a write would accept (the dirty-buffer guard aside: nothing
 * is written, so an unsaved editor buffer is not in the way).
 */
export async function tryBuild(input: TryBuildInput): Promise<ToolResult<TryBuildOutput>> {
  const candidate = await resolveCandidate(input);
  if (candidate.ok === false) {
    return candidate as ToolResult<TryBuildOutput>;
  }
  return buildCandidate({
    ...(input.pinnedWorkspace ? { pinnedWorkspace: input.pinnedWorkspace } : {}),
    ...(input.workspace !== undefined ? { workspace: input.workspace } : {}),
    absPath: candidate.data.absPath,
    text: candidate.data.text,
    ...(input.params !== undefined ? { params: input.params } : {}),
  });
}

// ---------------------------------------------------------------------------
// list_fluid_files
// ---------------------------------------------------------------------------

const SKIP_DIRS = new Set(['node_modules', '.git', '.fluidcad', 'dist', 'build']);
/** Every FluidCAD file kind: the models, and the custom feature modules they import. */
const FLUID_SUFFIXES = ['.fluid.js', '.part.js', '.assembly.js', '.feature.js'];
const WALK_FILE_LIMIT = 5000;

export type ListFluidFilesInput = WorkspaceArg;
export type ListFluidFilesOutput = { files: string[] };

export async function listFluidFiles(
  input: ListFluidFilesInput,
): Promise<ToolResult<ListFluidFilesOutput>> {
  const entry = resolveEntry(input);
  if (entry.ok === false) {
    return entry as ToolResult<ListFluidFilesOutput>;
  }
  const root = (() => {
    try {
      return fs.realpathSync(entry.data.workspacePath);
    } catch {
      return path.resolve(entry.data.workspacePath);
    }
  })();
  const files: string[] = [];
  try {
    await walk(root, root, files);
  } catch (e: any) {
    return err('internal', e?.message ?? String(e));
  }
  files.sort();
  return ok({ files });
}

async function walk(root: string, dir: string, out: string[]): Promise<void> {
  if (out.length >= WALK_FILE_LIMIT) {
    return;
  }
  let entries: fs.Dirent[];
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (out.length >= WALK_FILE_LIMIT) {
      return;
    }
    if (e.name.startsWith('.') && e.isDirectory()) {
      // Hidden dirs (`.git`, `.fluidcad`, …) — always skip.
      continue;
    }
    if (e.isDirectory() && SKIP_DIRS.has(e.name)) {
      continue;
    }
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      await walk(root, full, out);
    } else if (e.isFile() && FLUID_SUFFIXES.some((suffix) => e.name.endsWith(suffix))) {
      out.push(path.relative(root, full));
    }
  }
}
