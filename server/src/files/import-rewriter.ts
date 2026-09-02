import fs from 'fs';
import path from 'path';
import { getJavaScriptParser, spliceCode, walkTree, type TSNode } from '../code-editor.ts';
import { normalizePath } from '../normalize-path.ts';
import { listWorkspaceFiles } from './file-tree.ts';
import { relativeSpecifierFromDir } from './relative-specifier.ts';
import { writeFileAtomically } from './atomic-write.ts';

/**
 * Keeping imports pointed at a file that was just renamed.
 *
 * Workspace files reach each other only through relative module specifiers
 * (`import { bracket } from './bracket.part.js'`), so a rename is a matter of
 * finding every specifier that resolves to the old path and re-aiming it at
 * the new one — and, when the file moved folders, re-basing the moved file's
 * own relative imports. Nothing else in a file is touched: each edit
 * replaces the text *between the quotes* of one string literal that
 * tree-sitter identified as a module source, so a rewrite can neither
 * reformat nor truncate.
 *
 * Two-phase on purpose. {@link planImportUpdates} reads and rewrites in
 * memory before the rename happens, so a parse failure or an unreadable file
 * surfaces while the disk is still untouched. {@link applyImportUpdates}
 * then writes each file atomically, and only if it hasn't changed since it
 * was read. A file this can't handle is *skipped and reported*, never
 * half-done: the rename still goes through, and the caller says which
 * importers are left pointing at the old name.
 */

/** Vite resolves `./helpers` to `helpers.js`; nothing else gets left off in a workspace. */
const OMITTABLE_SUFFIXES: readonly string[] = ['', '.js'];

/** What the JavaScript grammar can parse. `.json` is listed as `source` too, but has no imports. */
const REWRITABLE_EXTENSIONS: ReadonlySet<string> = new Set(['.js', '.mjs', '.cjs']);

/** Same ceiling as `/files/read`: past this it isn't a source file the editor deals with. */
const MAX_FILE_BYTES = 8 * 1024 * 1024;

export type SpecifierReplacement = { from: string; to: string };

/** A module specifier literal: the character span *inside* its quotes, and what it says. */
type SpecifierRef = { start: number; end: number; value: string };

export type RewriteRequest = {
  /** The file's text, as the caller holds it — disk, or an unsaved buffer. */
  content: string;
  /** The folder the text's relative specifiers were written from. */
  fromDir: string;
  /** The folder the text will live in. Differs from `fromDir` only for the file being moved. */
  toDir: string;
  oldAbsPath: string;
  newAbsPath: string;
};

export type RewriteOutcome =
  | { kind: 'unchanged' }
  | { kind: 'rewritten'; content: string; replacements: SpecifierReplacement[] }
  | { kind: 'skipped'; reason: string };

/** Every string literal that names a module: `import … from`, `export … from`, `import()`. */
export function collectModuleSpecifiers(root: TSNode): SpecifierRef[] {
  const out: SpecifierRef[] = [];
  for (const node of walkTree(root)) {
    let source: TSNode | null = null;
    if (node.type === 'import_statement' || node.type === 'export_statement') {
      source = node.childForFieldName('source');
    } else if (node.type === 'call_expression' && node.childForFieldName('function')?.type === 'import') {
      source = node.childForFieldName('arguments')?.namedChild(0) ?? null;
    }
    if (!source || source.type !== 'string') {
      continue;
    }
    // `text` includes the quotes. An escape sequence inside would need
    // decoding to compare and re-encoding to write; no workspace path needs
    // one, so such a literal is left alone rather than guessed at.
    const raw = source.text.slice(1, -1);
    if (raw.includes('\\')) {
      continue;
    }
    out.push({ start: source.startIndex + 1, end: source.endIndex - 1, value: raw });
  }
  return out;
}

function hasSyntaxError(root: TSNode): boolean {
  const flag = (root as { hasError?: boolean | (() => boolean) }).hasError;
  if (typeof flag === 'function') {
    return Boolean(flag.call(root));
  }
  if (typeof flag === 'boolean') {
    return flag;
  }
  for (const node of walkTree(root)) {
    if (node.type === 'ERROR') {
      return true;
    }
  }
  return false;
}

/**
 * What `value` should say after the rename, or null when it neither points
 * at the renamed file nor needs re-basing. Bare specifiers (`fluidcad`,
 * `three`) name packages and are never relative to anything.
 */
function retarget(value: string, req: RewriteRequest): string | null {
  if (!value.startsWith('./') && !value.startsWith('../')) {
    return null;
  }
  const resolved = normalizePath(path.resolve(req.fromDir, value));
  for (const suffix of OMITTABLE_SUFFIXES) {
    if (resolved + suffix === req.oldAbsPath) {
      // Keep the author's style: a specifier that left `.js` off keeps leaving it off.
      const target =
        suffix !== '' && req.newAbsPath.endsWith(suffix)
          ? req.newAbsPath.slice(0, -suffix.length)
          : req.newAbsPath;
      return relativeSpecifierFromDir(req.toDir, target);
    }
  }
  if (req.fromDir === req.toDir) {
    return null;
  }
  // The moved file's own import of something else: same target, new vantage point.
  return relativeSpecifierFromDir(req.toDir, resolved);
}

/**
 * Rewrite one file's module specifiers for a rename. Pure over its input:
 * the result is text, and whether it can be trusted.
 */
export async function rewriteModuleSpecifiers(req: RewriteRequest): Promise<RewriteOutcome> {
  const parser = await getJavaScriptParser();
  const tree = parser.parse(req.content);
  const refs = collectModuleSpecifiers(tree.rootNode);
  const edits: { ref: SpecifierRef; value: string }[] = [];
  for (const ref of refs) {
    const next = retarget(ref.value, req);
    if (next !== null && next !== ref.value) {
      edits.push({ ref, value: next });
    }
  }
  if (edits.length === 0) {
    return { kind: 'unchanged' };
  }
  // Error recovery can attach an import to the wrong statement; a file that
  // doesn't parse is reported rather than edited on a guess.
  if (hasSyntaxError(tree.rootNode)) {
    return { kind: 'skipped', reason: 'it has syntax errors' };
  }

  let content = req.content;
  for (const edit of edits.slice().sort((a, b) => b.ref.start - a.ref.start)) {
    content = spliceCode(content, edit.ref.start, edit.ref.end, edit.value);
  }

  // Prove the edit did only what it meant to: the result parses, and its
  // specifiers are the old list with exactly the planned substitutions.
  const check = parser.parse(content);
  if (hasSyntaxError(check.rootNode)) {
    return { kind: 'skipped', reason: 'the rewritten file would not parse' };
  }
  const expected = refs.map((ref) => edits.find((edit) => edit.ref === ref)?.value ?? ref.value);
  const actual = collectModuleSpecifiers(check.rootNode).map((ref) => ref.value);
  if (actual.length !== expected.length || actual.some((value, index) => value !== expected[index])) {
    return { kind: 'skipped', reason: 'the rewrite touched more than its import paths' };
  }
  return { kind: 'rewritten', content, replacements: edits.map((edit) => ({ from: edit.ref.value, to: edit.value })) };
}

export type ImportUpdate = {
  /** Workspace-relative, forward slashes — the file's path *after* the rename. */
  path: string;
  absPath: string;
  content: string;
  replacements: SpecifierReplacement[];
  /** The disk file's mtime after writing; null when the caller's unsaved buffer was rewritten and the disk left alone. */
  mtimeMs: number | null;
};

export type ImportSkip = { path: string; reason: string };

type PlannedFile = {
  path: string;
  absPath: string;
  content: string;
  replacements: SpecifierReplacement[];
  /** Came from an unsaved buffer: hand the text back, don't write it. */
  fromBuffer: boolean;
  /** What the disk looked like when read, so a file edited meanwhile is left alone. */
  guard: { mtimeMs: number; size: number } | null;
};

export type ImportUpdatePlan = {
  files: PlannedFile[];
  skipped: ImportSkip[];
  /** The workspace walk hit its cap: an importer past it would not have been seen. */
  truncated: boolean;
};

export type ImportUpdateResult = {
  updated: ImportUpdate[];
  skipped: ImportSkip[];
  truncated: boolean;
};

export type PlanOptions = {
  workspacePath: string;
  oldAbsPath: string;
  oldRelPath: string;
  newAbsPath: string;
  newRelPath: string;
  /**
   * Unsaved editor buffers, by workspace-relative path. A file listed here is
   * rewritten from this text instead of the disk, and the result is returned
   * rather than written: the unsaved work stays unsaved, and only the editor
   * that owns it decides when it lands.
   */
  buffers: Readonly<Record<string, string>>;
};

/**
 * Work out every rewrite the rename calls for, from the workspace as it is
 * *before* the rename. Reads and parses; writes nothing.
 */
export async function planImportUpdates(options: PlanOptions): Promise<ImportUpdatePlan> {
  const { files: entries, truncated } = listWorkspaceFiles(options.workspacePath);
  const newDir = path.dirname(options.newAbsPath);
  const files: PlannedFile[] = [];
  const skipped: ImportSkip[] = [];

  for (const entry of entries) {
    if (entry.kind === 'other' || !REWRITABLE_EXTENSIONS.has(path.extname(entry.path))) {
      continue;
    }
    const isRenamed = entry.absPath === options.oldAbsPath;
    // The renamed file is read where it is now and will be written where it ends up.
    const location = isRenamed
      ? { path: options.newRelPath, absPath: options.newAbsPath }
      : { path: entry.path, absPath: entry.absPath };
    const ownDir = path.dirname(entry.absPath);
    const buffer = options.buffers[entry.path];

    let content: string;
    let guard: PlannedFile['guard'] = null;
    if (buffer !== undefined) {
      content = buffer;
    } else {
      if (entry.size > MAX_FILE_BYTES) {
        // Only worth reporting if it could have mattered — but we can't parse
        // it to know, and a source file this large is not one of ours anyway.
        continue;
      }
      try {
        content = fs.readFileSync(entry.absPath, 'utf8');
        const stat = fs.statSync(entry.absPath);
        guard = { mtimeMs: stat.mtimeMs, size: stat.size };
      } catch (err) {
        skipped.push({ path: location.path, reason: `it could not be read (${(err as Error).message})` });
        continue;
      }
    }

    const outcome = await rewriteModuleSpecifiers({
      content,
      fromDir: ownDir,
      toDir: isRenamed ? newDir : ownDir,
      oldAbsPath: options.oldAbsPath,
      newAbsPath: options.newAbsPath,
    });
    if (outcome.kind === 'skipped') {
      skipped.push({ path: location.path, reason: outcome.reason });
    } else if (outcome.kind === 'rewritten') {
      files.push({
        ...location,
        content: outcome.content,
        replacements: outcome.replacements,
        fromBuffer: buffer !== undefined,
        guard,
      });
    }
  }
  return { files, skipped, truncated };
}

/**
 * Land a plan on disk, after the rename itself has happened. Each file is
 * written atomically, and only if it still looks the way it did when the
 * plan read it — anything edited in between is skipped and reported, since
 * overwriting it would lose that edit.
 */
export function applyImportUpdates(
  plan: ImportUpdatePlan,
  onWrite?: (absPath: string, content: string) => void,
): ImportUpdateResult {
  const updated: ImportUpdate[] = [];
  const skipped = plan.skipped.slice();

  for (const file of plan.files) {
    if (file.fromBuffer) {
      updated.push({ path: file.path, absPath: file.absPath, content: file.content, replacements: file.replacements, mtimeMs: null });
      continue;
    }
    try {
      const before = fs.statSync(file.absPath);
      if (file.guard && (before.mtimeMs !== file.guard.mtimeMs || before.size !== file.guard.size)) {
        skipped.push({ path: file.path, reason: 'it changed on disk while the rename was running' });
        continue;
      }
      writeFileAtomically(file.absPath, file.content);
      onWrite?.(file.absPath, file.content);
      const after = fs.statSync(file.absPath);
      updated.push({ path: file.path, absPath: file.absPath, content: file.content, replacements: file.replacements, mtimeMs: after.mtimeMs });
    } catch (err) {
      skipped.push({ path: file.path, reason: `it could not be written (${(err as Error).message})` });
    }
  }
  return { updated, skipped, truncated: plan.truncated };
}
