import { setupMonaco, monaco } from './monaco-setup';
import { EditorPane } from './editor-pane';
import { WorkspaceModels, type ModelEntry } from './models';
import { loadEngineTypes } from './engine-types';
import { QuickOpen } from './quick-open';
import type { FileTab } from './tabs';
import {
  createWorkspaceFile,
  fetchWorkspaceEditorState,
  openWorkspaceFile,
  readWorkspaceFile,
  renameWorkspaceFile,
  saveWorkspaceEditorState,
  type FileKind,
  type ImportUpdateResult,
  type RenameResult,
} from './editor-api';
import { EditorHost } from './host/editor-host';
import { replaceSpecifiers } from './import-specifiers';
import { Diagnostics, type CompileError } from './diagnostics';
import { Breakpoints } from './breakpoints';
import type { SceneObjectRender, SourceLocation } from '../types';

/**
 * The in-page code editor, assembled.
 *
 * Reached through a dynamic `import()` from `main.ts`, so Monaco lands in its
 * own chunk: a viewport-only host (`?editor=0`, the VS Code webview, the hub)
 * never downloads it, and the scene renders before the editor is even fetched.
 * The scene is the product; the editor is a pane beside it (Invariant 7).
 */

export interface EditorSurfaceDeps {
  /** `#fluidcad-viewer` — the positioning context every overlay shares. */
  container: HTMLElement;
  /** Send a message to the server over the UI WebSocket. */
  send(msg: unknown): boolean;
  /** Hand the top bar the tab strip's state to render. */
  setTabs(tabs: FileTab[], activePath: string | null, currentModelPath: string | null): void;
  /** Name the workspace in the top bar, once loading it reveals its root. */
  setWorkspaceName?(name: string): void;
  initialOpen?: boolean;
  initialWidth?: number;
  onOpenChange?(open: boolean): void;
  onWidthChange?(width: number): void;
  /** Report a refused edit to the user, through the UI's own toast. */
  onEditRefused?(message: string): void;
}

export class EditorSurface {
  readonly pane: EditorPane;
  readonly models = new WorkspaceModels();
  private readonly quickOpen: QuickOpen;
  private readonly host: EditorHost;
  private readonly diagnostics: Diagnostics;
  private readonly breakpoints: Breakpoints;
  /** Open tabs, in strip order. Absolute paths. */
  private openTabs: string[] = [];
  private activePath: string | null = null;
  /** The model (`.part.js` / `.assembly.js` / `.fluid.js`) the scene was last rendered from. */
  private currentModelPath: string | null = null;

  private constructor(private readonly deps: EditorSurfaceDeps) {
    this.pane = new EditorPane({
      container: deps.container,
      initialOpen: deps.initialOpen,
      initialWidth: deps.initialWidth,
      onOpenChange: deps.onOpenChange,
      onWidthChange: deps.onWidthChange,
    });
    this.quickOpen = new QuickOpen({
      onOpen: (entry) => void this.openFile(entry.absPath),
      onCreate: (relPath) => void this.createFile(relPath),
    });
    this.diagnostics = new Diagnostics(this.models);
    this.breakpoints = new Breakpoints({
      models: this.models,
      applyCode: (absPath, newCode) => this.host.applyExternalResult(absPath, newCode),
    });
    this.host = new EditorHost({
      models: this.models,
      currentModelPath: () => this.currentModelPath,
      reveal: (absPath, line, column, revealPane) =>
        this.gotoSource({ filePath: absPath, line: line ?? 1, column: column ?? 0 }, { revealPane }),
      onBreakpointsChanged: (absPath) => this.breakpoints.refresh(absPath),
      onError: (message) => deps.onEditRefused?.(message),
    });
    this.models.onDirtyChange((dirtyPaths) => {
      this.renderTabs();
      // The MCP source tools read this before writing, so an agent never
      // clobbers something the user has unsaved in the page.
      this.deps.send({ type: 'editor-dirty-state', dirtyFiles: dirtyPaths });
    });
  }

  static async install(deps: EditorSurfaceDeps): Promise<EditorSurface> {
    setupMonaco();
    const surface = new EditorSurface(deps);
    // Models first: they are what the language service knows about, and the
    // declarations are only useful once there is something to check.
    await surface.models.loadWorkspace().catch((err) => {
      console.warn('FluidCAD: could not load workspace files:', err);
    });
    const root = surface.models.workspacePath;
    if (root) {
      deps.setWorkspaceName?.(root.split(/[\\/]/).pop() || root);
    }
    void loadEngineTypes();
    surface.installEditorCommands();
    await surface.restoreTabs().catch(() => undefined);
    return surface;
  }

  // ---------------------------------------------------------------------------
  // Pane
  // ---------------------------------------------------------------------------

  isOpen(): boolean {
    return this.pane.isOpen();
  }

  toggle(): void {
    this.pane.toggle();
    if (this.pane.isOpen() && this.activePath) {
      void this.showFile(this.activePath);
    }
  }

  setOpen(open: boolean): void {
    this.pane.setOpen(open);
  }

  // ---------------------------------------------------------------------------
  // Tabs
  // ---------------------------------------------------------------------------

  /** The `+` button in the top bar — and the desktop menu's Find File. */
  showQuickOpen(anchor: HTMLElement): void {
    void this.quickOpen.open(anchor);
  }

  /**
   * Save the active buffer.
   *
   * Public because the desktop shell's File ▸ Save takes the accelerator before
   * the page ever sees the keystroke: a native menu item claims Cmd/Ctrl+S at
   * the application level, so Monaco's own binding never fires and the menu has
   * to reach the same code.
   */
  async saveActive(): Promise<void> {
    if (this.activePath) {
      await this.models.save(this.activePath);
    }
  }

  /** Every dirty buffer, for File ▸ Save All. */
  async saveAll(): Promise<void> {
    for (const absPath of this.openTabs) {
      if (this.models.isDirty(absPath)) {
        await this.models.save(absPath);
      }
    }
  }

  /**
   * Open a file as a tab and make it active. Activating a model (any fluid
   * script kind) re-renders the scene from it; a helper leaves the viewport
   * alone.
   */
  async openFile(path: string, options: { activate?: boolean; reveal?: boolean } = {}): Promise<void> {
    let entry: ModelEntry;
    try {
      entry = await this.models.ensure(path);
    } catch (err) {
      console.warn(`FluidCAD: could not open ${path}:`, err);
      return;
    }
    if (!this.openTabs.includes(entry.absPath)) {
      this.openTabs.push(entry.absPath);
      this.persistTabs();
    }
    if (options.activate !== false) {
      await this.activateTab(entry.absPath, { reveal: options.reveal });
    } else {
      this.renderTabs();
    }
  }

  /**
   * @param reveal open the pane as part of activating. Only an explicit
   * "show me the code" gesture ({@link gotoSource}) passes true — the editor
   * is hidden by default and neither a tab click, a quick-open pick nor
   * following the scene into a new file may pop it open (Invariant 7). If the
   * file has to be loaded into Monaco first, that happens while the pane is
   * still hidden.
   */
  async activateTab(absPath: string, options: { reveal?: boolean } = {}): Promise<void> {
    const entry = this.models.get(absPath);
    if (!entry) {
      return;
    }
    this.activePath = absPath;
    this.persistTabs();
    if (options.reveal) {
      this.pane.setOpen(true);
    }
    await this.showFile(absPath);
    // A model tab owns the scene. `currentModelPath` follows the render, not
    // the click, so it doesn't lie while the render is still in flight.
    if (entry.kind === 'model' && absPath !== this.currentModelPath) {
      await openWorkspaceFile(entry.relPath).catch((err) => {
        console.warn(`FluidCAD: could not render ${entry.relPath}:`, err);
      });
    }
    this.renderTabs();
  }

  closeTab(absPath: string): void {
    const index = this.openTabs.indexOf(absPath);
    if (index === -1) {
      return;
    }
    this.openTabs.splice(index, 1);
    this.persistTabs();

    if (this.activePath === absPath) {
      // Never orphan the scene: prefer another model tab, then anything.
      const next =
        this.openTabs.find((path) => this.models.get(path)?.kind === 'model') ??
        this.openTabs[Math.min(index, this.openTabs.length - 1)] ??
        null;
      this.activePath = next;
      if (next) {
        void this.activateTab(next, { reveal: this.pane.isOpen() });
        return;
      }
    }
    // Closing a tab does not dispose its model — the language service still
    // needs it to cross-complete.
    this.renderTabs();
  }

  /** The strip was dragged into a new order. Only a permutation of the open tabs is accepted. */
  reorderTabs(absPaths: string[]): void {
    const current = this.openTabs.slice().sort();
    const proposed = absPaths.slice().sort();
    if (current.length !== proposed.length || current.some((path, index) => path !== proposed[index])) {
      return;
    }
    this.openTabs = absPaths.slice();
    this.persistTabs();
    this.renderTabs();
  }

  /**
   * Rename the file behind a tab, in its own folder. The tab keeps its slot
   * and its buffer — unsaved edits included — and if the scene was rendered
   * from the file, the server is re-pointed at the new name so the viewport
   * keeps following the same file.
   */
  async renameTab(absPath: string, newBasename: string): Promise<void> {
    const entry = this.models.get(absPath);
    if (!entry) {
      return;
    }
    const folder = entry.relPath.includes('/') ? entry.relPath.slice(0, entry.relPath.lastIndexOf('/') + 1) : '';
    const newRelPath = `${folder}${newBasename}`;
    if (newRelPath === entry.relPath) {
      return;
    }
    // Unsaved buffers go along: their imports are rewritten in the text we
    // hold, not on the disk underneath them.
    const buffers: Record<string, string> = {};
    for (const dirtyPath of this.models.dirtyPaths()) {
      const dirty = this.models.get(dirtyPath);
      if (dirty) {
        buffers[dirty.relPath] = dirty.model.getValue();
      }
    }
    let renamed: RenameResult;
    try {
      renamed = await renameWorkspaceFile(entry.relPath, newRelPath, { updateImports: true, buffers });
    } catch (err) {
      this.deps.onEditRefused?.(`Could not rename ${entry.relPath}: ${(err as Error).message}`);
      this.renderTabs();
      return;
    }
    const next = this.models.rename(absPath, renamed.absPath, renamed.path, renamed.kind, renamed.mtimeMs);
    if (!next) {
      return;
    }

    // Same slot, new key — and never the same file twice, should the watcher
    // have opened the new path in the meantime.
    const index = this.openTabs.indexOf(absPath);
    this.openTabs = this.openTabs.filter((path) => path !== next.absPath);
    if (index !== -1) {
      this.openTabs.splice(Math.min(index, this.openTabs.length), 0, next.absPath);
    }
    if (this.activePath === absPath) {
      this.activePath = next.absPath;
    }
    const wasCurrentModel = this.currentModelPath === absPath;
    if (wasCurrentModel) {
      this.currentModelPath = next.absPath;
    }

    // Swap the visible buffer before the old model goes, keeping the caret
    // and scroll where they were.
    const editor = this.pane.getEditor();
    if (editor && editor.getModel() === entry.model) {
      const viewState = editor.saveViewState();
      editor.setModel(next.model);
      if (viewState) {
        editor.restoreViewState(viewState);
      }
    }
    this.breakpoints.forget(absPath);
    this.models.forget(absPath);
    this.adoptImportUpdates(renamed.imports, buffers, entry.relPath, next.relPath);
    this.breakpoints.refreshAll();
    this.persistTabs();
    this.renderTabs();
    this.reportSkippedImports(renamed.imports, entry.relPath, next.relPath);

    // The server still holds the old name as its current file. A live render
    // of the buffer under the new one re-points it — and, unlike re-opening
    // from disk, keeps whatever is unsaved on screen.
    if (wasCurrentModel) {
      this.host.scheduleLiveRender(next.absPath);
    }
  }

  private async createFile(relPath: string): Promise<void> {
    try {
      const created = await createWorkspaceFile(relPath);
      await this.openFile(created.absPath);
    } catch (err) {
      console.warn(`FluidCAD: could not create ${relPath}:`, err);
    }
  }

  /**
   * Land the importer rewrites a rename produced. A file the server wrote on
   * disk is adopted as saved text; one it rewrote from a buffer we sent lands
   * as an edit and stays unsaved. Either way the buffer may have moved on
   * during the round trip — then only the import paths are substituted, so
   * nothing typed meanwhile is lost.
   */
  private adoptImportUpdates(
    imports: ImportUpdateResult | undefined,
    sent: Record<string, string>,
    oldRelPath: string,
    newRelPath: string,
  ): void {
    if (!imports) {
      return;
    }
    for (const update of imports.updated) {
      const target = this.models.get(update.absPath);
      if (!target) {
        continue;
      }
      // The renamed file was sent under its old name.
      const sentText = sent[update.path === newRelPath ? oldRelPath : update.path];
      const current = target.model.getValue();
      const unchangedSinceSent = sentText !== undefined ? current === sentText : !this.models.isDirty(update.absPath);
      if (unchangedSinceSent) {
        this.models.setContentAsEdit(update.absPath, update.content);
        if (update.mtimeMs !== null) {
          this.models.markSaved(update.absPath, update.mtimeMs);
        }
      } else {
        this.models.setContentAsEdit(update.absPath, replaceSpecifiers(current, update.replacements));
      }
    }
  }

  /** The rename went through, but these importers still name the old file — say so. */
  private reportSkippedImports(imports: ImportUpdateResult | undefined, oldRelPath: string, newRelPath: string): void {
    if (!imports || (imports.skipped.length === 0 && !imports.truncated)) {
      return;
    }
    const reasons = imports.skipped.map((skip) => `${skip.path} (${skip.reason})`);
    if (imports.truncated) {
      reasons.push('files past the workspace listing cap were not checked');
    }
    this.deps.onEditRefused?.(
      `Renamed to ${newRelPath}, but some imports still point at ${oldRelPath}: ${reasons.join('; ')}.`,
    );
  }

  private tabRelPaths(): string[] {
    return this.openTabs.map((absPath) => this.models.get(absPath)?.relPath).filter((p): p is string => !!p);
  }

  /**
   * Losing which tabs were open is a papercut, not a failure — a read-only
   * workspace still edits fine, so this never surfaces an error.
   */
  private persistTabs(): void {
    void saveWorkspaceEditorState({
      openTabs: this.tabRelPaths(),
      activeTab: this.activePath ? this.models.get(this.activePath)?.relPath ?? null : null,
    }).catch(() => undefined);
  }

  /**
   * Reopen last session's tabs. Called after the workspace's models are
   * loaded; anything that has since been deleted is skipped rather than
   * reported — the file is simply gone.
   */
  private async restoreTabs(): Promise<void> {
    const state = await fetchWorkspaceEditorState().catch(() => null);
    if (!state || state.openTabs.length === 0) {
      return;
    }
    for (const relPath of state.openTabs) {
      await this.openFile(relPath, { activate: false }).catch(() => undefined);
    }
    const active = state.activeTab
      ? this.models.list().find((entry) => entry.relPath === state.activeTab)
      : undefined;
    if (active) {
      await this.activateTab(active.absPath);
    }
  }

  private renderTabs(): void {
    const tabs: FileTab[] = this.openTabs.flatMap((absPath) => {
      const entry = this.models.get(absPath);
      return entry
        ? [{
            absPath,
            relPath: entry.relPath,
            kind: entry.kind as FileKind,
            dirty: this.models.isDirty(absPath),
          }]
        : [];
    });
    this.deps.setTabs(tabs, this.activePath, this.currentModelPath);
  }

  // ---------------------------------------------------------------------------
  // Following the scene
  // ---------------------------------------------------------------------------

  /** The file the scene was last rendered from — the editor follows it. */
  setSceneFile(absPath: string): void {
    if (this.currentModelPath === absPath) {
      return;
    }
    this.currentModelPath = absPath;
    void this.openFile(absPath, { activate: this.activePath === null }).then(() => this.renderTabs());
  }

  /**
   * An explicit "show me this line" — a "Show in source" action, a click on a
   * compile error. The call site is the user asking for the editor, so
   * opening it is the answer, not a side effect.
   *
   * @param revealPane false for a passive navigation — a timeline row click,
   * whose subject is the scene, not the code. The caret follows along in a
   * pane that is already open; a hidden pane stays hidden, and the jump is
   * dropped rather than queued for whenever the pane next opens (Invariant 7:
   * nothing but an explicit gesture pops the editor).
   */
  async gotoSource(
    location: Partial<SourceLocation> & { line: number },
    options: { revealPane?: boolean } = {},
  ): Promise<void> {
    const absPath = location.filePath ?? this.currentModelPath;
    if (!absPath) {
      return;
    }
    const reveal = options.revealPane !== false;
    if (!reveal && !this.pane.isOpen()) {
      return;
    }
    if (reveal) {
      this.pane.setOpen(true);
    }
    await this.openFile(absPath, { reveal });
    const editor = this.pane.getEditor();
    if (!editor) {
      return;
    }
    const position = { lineNumber: location.line, column: (location.column ?? 0) + 1 };
    editor.revealLineInCenter(position.lineNumber);
    editor.setPosition(position);
    // A passive jump scrolls the caret into view but leaves the keyboard
    // where the user put it — they clicked the timeline, so Escape and the
    // arrow keys still belong to the scene, not to Monaco.
    if (reveal) {
      editor.focus();
    }
  }

  private async showFile(absPath: string): Promise<void> {
    const entry = this.models.get(absPath) ?? await this.models.ensure(absPath).catch(() => undefined);
    if (!entry) {
      return;
    }
    const editor = this.pane.ensureEditor();
    if (editor.getModel() !== entry.model) {
      editor.setModel(entry.model);
    }
  }

  // ---------------------------------------------------------------------------
  // Host contract
  // ---------------------------------------------------------------------------

  /** A message the server addressed to the editor host. */
  handleServerMessage(msg: { type: string; [key: string]: any }): void {
    void this.host.handle(msg);
  }

  /**
   * A render finished. Two things follow from it: the failures it reported
   * become markers, and the breakpoint dots are re-derived — the source may
   * have been rewritten by the very transform that triggered this render.
   */
  onSceneRendered(objects: SceneObjectRender[], compileError: CompileError | null): void {
    this.diagnostics.update(objects, compileError);
    this.breakpoints.refreshAll();
  }

  /** The server process died — its verdicts are stale. */
  onServerLost(): void {
    this.diagnostics.clear();
  }

  /**
   * A workspace file changed on disk outside this page (an agent through MCP,
   * a `git checkout`). Adopt it when the buffer is clean; leave the user's
   * unsaved work alone when it isn't.
   */
  async onFileEvent(event: {
    type: string;
    absPath: string;
    path: string;
    kind: FileKind;
    mtimeMs?: number;
  }): Promise<void> {
    if (event.kind === 'other') {
      return;
    }
    // Our own writes come back through the watcher. Nothing older than what
    // this page last wrote can tell it anything it doesn't know.
    const known = this.models.get(event.absPath);
    if (known && event.mtimeMs !== undefined && event.mtimeMs <= known.mtimeMs) {
      return;
    }
    if (event.type === 'file-removed') {
      // The model stays: a file deleted out from under an open tab is more
      // often a `git checkout` mid-flight than an intent to lose the buffer.
      return;
    }
    if (!this.models.get(event.absPath)) {
      if (event.type === 'file-added') {
        // New file in the workspace — the language service should know about
        // it even though nothing opened it.
        await this.models.ensure(event.path).catch(() => undefined);
      }
      return;
    }
    const contents = await readWorkspaceFile(event.path).catch(() => null);
    if (!contents) {
      return;
    }
    const outcome = this.models.adoptExternalChange(event.absPath, contents.content, contents.mtimeMs);
    if (outcome === 'conflict') {
      this.deps.onEditRefused?.(
        `${event.path} changed on disk, but you have unsaved changes here — save or undo to pick up the new version.`,
      );
      return;
    }
    this.breakpoints.refresh(event.absPath);
  }

  /** Re-announce after a reconnect — the server forgets hosts on disconnect. */
  onSocketOpen(): void {
    this.deps.send({ type: 'editor-hello', editor: 'monaco', capabilities: { undoRedo: true } });
  }

  private installEditorCommands(): void {
    const editor = this.pane.ensureEditor();
    this.breakpoints.attach(editor);
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
      const absPath = this.activePath;
      if (absPath) {
        void this.models.save(absPath);
      }
    });
    // Typing re-renders the scene, the way saving a buffer does in VS Code.
    editor.onDidChangeModelContent(() => {
      const entry = editor.getModel() ? this.models.findByModel(editor.getModel()!) : undefined;
      if (entry) {
        this.host.scheduleLiveRender(entry.absPath);
      }
    });
  }
}

export { monaco };
export type { FileTab };
