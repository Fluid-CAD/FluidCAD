import { monaco } from './monaco-setup';
import {
  listWorkspaceFiles,
  readWorkspaceFile,
  writeWorkspaceFile,
  type FileKind,
  type WorkspaceFileEntry,
} from './editor-api';

/**
 * One Monaco model per workspace source file, created eagerly and
 * independently of tabs.
 *
 * The TypeScript worker only cross-completes across files it knows about, and
 * FluidCAD models are routinely multi-file — `init.js`, shared constants,
 * `part()` definitions in their own file. Loading every model up front is what
 * lets the surface have **no file tree**: the tree's real job is telling the
 * language service what exists, and this does that invisibly
 * (`docs/desktop/05-editor-surface-design.md`).
 *
 * Closing a tab does not dispose its model.
 */

/** What the editor opens. Everything else in the tree is listed, not loaded. */
const EDITABLE_KINDS: ReadonlySet<FileKind> = new Set<FileKind>(['model', 'source']);

export type ModelEntry = {
  model: monaco.editor.ITextModel;
  /** Workspace-relative path, for labels. */
  relPath: string;
  absPath: string;
  kind: FileKind;
  /** mtime of the last content this page wrote or read. */
  mtimeMs: number;
};

type DirtyListener = (dirtyPaths: string[]) => void;

export class WorkspaceModels {
  private readonly entries = new Map<string, ModelEntry>();
  /** Model version id as of the last save — anything higher is unsaved. */
  private readonly savedVersions = new Map<string, number>();
  private readonly dirtyListeners = new Set<DirtyListener>();
  private lastDirtySignature = '';

  /**
   * Load a model for every editable workspace file. Failures are per-file:
   * one unreadable file must not cost the language service every other one.
   */
  async loadWorkspace(): Promise<void> {
    const { files } = await listWorkspaceFiles();
    await Promise.all(
      files
        .filter((file) => EDITABLE_KINDS.has(file.kind))
        .map((file) => this.load(file).catch(() => undefined)),
    );
  }

  private async load(file: WorkspaceFileEntry): Promise<ModelEntry> {
    const existing = this.entries.get(file.absPath);
    if (existing) {
      return existing;
    }
    const contents = await readWorkspaceFile(file.path);
    return this.create(contents.absPath, contents.path, contents.kind, contents.content, contents.mtimeMs);
  }

  /** Load `path` (relative or absolute) if it isn't loaded already. */
  async ensure(path: string): Promise<ModelEntry> {
    const known = this.entries.get(path);
    if (known) {
      return known;
    }
    const contents = await readWorkspaceFile(path);
    const already = this.entries.get(contents.absPath);
    if (already) {
      return already;
    }
    return this.create(contents.absPath, contents.path, contents.kind, contents.content, contents.mtimeMs);
  }

  private create(
    absPath: string,
    relPath: string,
    kind: FileKind,
    content: string,
    mtimeMs: number,
  ): ModelEntry {
    // A `file:///…` URI is load-bearing: it is what lets the TS worker resolve
    // `import … from 'fluidcad/core'` by walking up to the declarations
    // registered under `file:///node_modules/fluidcad` (see engine-types.ts).
    const uri = monaco.Uri.file(absPath);
    const model = monaco.editor.getModel(uri) ?? monaco.editor.createModel(content, 'javascript', uri);
    const entry: ModelEntry = { model, relPath, absPath, kind, mtimeMs };
    this.entries.set(absPath, entry);
    this.savedVersions.set(absPath, model.getVersionId());
    model.onDidChangeContent(() => this.notifyDirty());
    return entry;
  }

  get(absPath: string): ModelEntry | undefined {
    return this.entries.get(absPath);
  }

  /**
   * The entry a Monaco model belongs to. Deliberately not `model.uri.fsPath`:
   * on Windows that denormalizes back to backslashes while every key here is
   * the server's forward-slash form.
   */
  findByModel(model: monaco.editor.ITextModel): ModelEntry | undefined {
    return this.list().find((entry) => entry.model === model);
  }

  list(): ModelEntry[] {
    return Array.from(this.entries.values());
  }

  isDirty(absPath: string): boolean {
    const entry = this.entries.get(absPath);
    return entry ? entry.model.getVersionId() !== this.savedVersions.get(absPath) : false;
  }

  dirtyPaths(): string[] {
    return this.list().filter((entry) => this.isDirty(entry.absPath)).map((entry) => entry.absPath);
  }

  /** Fires only when the *set* of dirty files changes, not per keystroke. */
  onDirtyChange(listener: DirtyListener): () => void {
    this.dirtyListeners.add(listener);
    return () => this.dirtyListeners.delete(listener);
  }

  private notifyDirty(): void {
    const paths = this.dirtyPaths();
    const signature = paths.slice().sort().join('\n');
    if (signature === this.lastDirtySignature) {
      return;
    }
    this.lastDirtySignature = signature;
    for (const listener of this.dirtyListeners) {
      listener(paths);
    }
  }

  async save(absPath: string): Promise<void> {
    const entry = this.entries.get(absPath);
    if (!entry) {
      return;
    }
    // Captured before the write: a keystroke landing mid-request must stay
    // dirty rather than being marked saved by a stale version id.
    const version = entry.model.getVersionId();
    const written = await writeWorkspaceFile(entry.relPath, entry.model.getValue());
    entry.mtimeMs = written.mtimeMs;
    this.savedVersions.set(absPath, version);
    this.notifyDirty();
  }

  async saveAllDirty(): Promise<void> {
    await Promise.all(this.dirtyPaths().map((absPath) => this.save(absPath)));
  }

  /**
   * Replace a model's text with what a *server-side* transform produced. The
   * edit is applied through the undo stack as one step rather than
   * `setValue`, which would clear the stack and break undo delegation.
   */
  setContentAsEdit(absPath: string, content: string): boolean {
    const entry = this.entries.get(absPath);
    if (!entry || entry.model.getValue() === content) {
      return false;
    }
    applyTextAsSingleEdit(entry.model, content);
    return true;
  }

  /**
   * A file changed on disk outside this page. Adopt it when the buffer is
   * clean; when it isn't, leave the user's work alone and report the clash so
   * the caller can say something.
   */
  adoptExternalChange(absPath: string, content: string, mtimeMs: number): 'adopted' | 'conflict' | 'unknown' {
    const entry = this.entries.get(absPath);
    if (!entry) {
      return 'unknown';
    }
    if (entry.model.getValue() === content) {
      entry.mtimeMs = mtimeMs;
      this.savedVersions.set(absPath, entry.model.getVersionId());
      this.notifyDirty();
      return 'adopted';
    }
    if (this.isDirty(absPath)) {
      return 'conflict';
    }
    applyTextAsSingleEdit(entry.model, content);
    entry.mtimeMs = mtimeMs;
    this.savedVersions.set(absPath, entry.model.getVersionId());
    this.notifyDirty();
    return 'adopted';
  }

  forget(absPath: string): void {
    const entry = this.entries.get(absPath);
    if (!entry) {
      return;
    }
    entry.model.dispose();
    this.entries.delete(absPath);
    this.savedVersions.delete(absPath);
    this.notifyDirty();
  }
}

/**
 * Replace a model's whole text with a **minimal** edit: the common prefix and
 * suffix are left untouched, so the cursor and selection survive and the whole
 * transform lands as one undo step.
 *
 * This is what makes `editor-hello { capabilities: { undoRedo: true } }`
 * correct — `model.undo()` has to step one *feature edit*, not one character.
 */
export function applyTextAsSingleEdit(model: monaco.editor.ITextModel, next: string): void {
  const current = model.getValue();
  if (current === next) {
    return;
  }

  let prefix = 0;
  const maxPrefix = Math.min(current.length, next.length);
  while (prefix < maxPrefix && current.charCodeAt(prefix) === next.charCodeAt(prefix)) {
    prefix++;
  }
  let suffix = 0;
  const maxSuffix = Math.min(current.length - prefix, next.length - prefix);
  while (
    suffix < maxSuffix &&
    current.charCodeAt(current.length - 1 - suffix) === next.charCodeAt(next.length - 1 - suffix)
  ) {
    suffix++;
  }

  const range = monaco.Range.fromPositions(
    model.getPositionAt(prefix),
    model.getPositionAt(current.length - suffix),
  );
  const text = next.slice(prefix, next.length - suffix);

  model.pushStackElement(); // Close whatever the user was typing…
  model.pushEditOperations([], [{ range, text }], () => null);
  model.pushStackElement(); // …and make this transform its own step.
}
