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

export type WorkspaceArg = { workspace?: string };

/**
 * Resolve a workspace argument to a `RegistryEntry`. Distinct from the
 * inspection-tools variant: source tools rarely need an HTTP client (only
 * `write_file`/`edit_range` do, and only to probe dirty buffers), so we
 * return the entry directly and let callers open a client when required.
 */
function resolveEntry(input: WorkspaceArg): ToolResult<RegistryEntry> {
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
type LintResult = { missing: LintMissingImport[]; suggestion: string };

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
async function lintFluidJsCode(entry: RegistryEntry, code: string): Promise<LintResult | null> {
  const client = new FluidCadClient(entry);
  try {
    const result = await client.postJson<LintResult>('/api/lint-fluid-js', { code });
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

function isFluidJsPath(absPath: string): boolean {
  return absPath.toLowerCase().endsWith('.fluid.js');
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
): Promise<ToolResult<void>> {
  if (force === true) {
    return ok(undefined);
  }
  if (!isFluidJsPath(absPath)) {
    return ok(undefined);
  }
  const lint = await lintFluidJsCode(entry, code);
  if (!lint || lint.missing.length === 0) {
    return ok(undefined);
  }
  const symbolList = lint.missing.map((m) => m.symbol).join(', ');
  return err(
    'missing-imports',
    [
      `Refusing to write "${absPath}" — uses ${lint.missing.length} FluidCAD ` +
        `symbol(s) without an import: ${symbolList}.`,
      'Add this to the top of the file (pass `force: true` to override):',
      lint.suggestion,
    ].join('\n'),
    { missing: lint.missing, suggestion: lint.suggestion },
  );
}

/**
 * Render outcome as reported by `POST /api/render`. Mirrored from
 * `server/src/routes/render.ts` — kept hand-typed here so the MCP package
 * doesn't take a build-time dep on the server package.
 */
export type RenderOutcome =
  | { state: 'rendered'; version: number; absPath: string; durationMs: number }
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
  | { state: 'render-failed'; error: string };

/**
 * Ask the running FluidCAD server to render `code` for `filePath`. Used by
 * `write_file` / `edit_range` to make the agent's edit synchronous: the
 * disk write returns once the render settles, so the caller doesn't need a
 * separate round-trip to observe completion.
 *
 * Non-fatal: any transport error is folded into the outcome as
 * `render-failed` so the agent still sees the write succeeded.
 */
async function triggerRender(
  entry: RegistryEntry,
  filePath: string,
  code: string,
): Promise<RenderOutcome> {
  const client = new FluidCadClient(entry);
  try {
    const outcome = await client.postJson<RenderOutcome>('/api/render', { filePath, code });
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
};
export type WriteFileOutput = {
  path: string;
  bytesWritten: number;
  render: RenderOutcome;
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
  const render = await triggerRender(entry.data, resolved.data.absPath, input.content);
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
};
export type EditRangeOutput = {
  path: string;
  bytesWritten: number;
  replacedRange: { start: Position; end: Position };
  render: RenderOutcome;
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

export async function editRange(input: EditRangeInput): Promise<ToolResult<EditRangeOutput>> {
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
  const startOffset = offsetAt(original, input.start);
  const endOffset = offsetAt(original, input.end);
  const next = original.slice(0, startOffset) + input.newText + original.slice(endOffset);
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
  const render = await triggerRender(entry.data, resolved.data.absPath, next);
  return ok({
    path: resolved.data.absPath,
    bytesWritten: Buffer.byteLength(next, 'utf8'),
    replacedRange: { start: input.start, end: input.end },
    render,
  });
}

// ---------------------------------------------------------------------------
// list_fluid_files
// ---------------------------------------------------------------------------

const SKIP_DIRS = new Set(['node_modules', '.git', '.fluidcad', 'dist', 'build']);
const FLUID_SUFFIX = '.fluid.js';
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
    } else if (e.isFile() && e.name.endsWith(FLUID_SUFFIX)) {
      out.push(path.relative(root, full));
    }
  }
}
