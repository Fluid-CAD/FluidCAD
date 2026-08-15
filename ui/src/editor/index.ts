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
  saveWorkspaceEditorState,
  type FileKind,
} from './editor-api';
import { EditorHost } from './host/editor-host';
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
  /** The `.fluid.js` the scene was last rendered from. */
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
      onOpen: (entry) => void this.openFile(entry.absPath, { reveal: true }),
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
      reveal: (absPath, line, column) =>
        this.gotoSource({ filePath: absPath, line: line ?? 1, column: column ?? 0 }),
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
   * Open a file as a tab and make it active. Activating a `.fluid.js`
   * re-renders the scene from it; a helper leaves the viewport alone.
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
   * @param reveal open the pane as part of activating. Only a user gesture
   * passes true — the editor is hidden by default and following the scene into
   * a new file must not pop it open (Invariant 7).
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

  private async createFile(relPath: string): Promise<void> {
    try {
      const created = await createWorkspaceFile(relPath, scaffoldFor(relPath));
      await this.openFile(created.absPath, { reveal: true });
    } catch (err) {
      console.warn(`FluidCAD: could not create ${relPath}:`, err);
    }
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
   * An explicit "show me this line" — a timeline feature's Go to source, a
   * click on a compile error. Every call site is the user asking for the
   * editor, so opening it is the answer, not a side effect. Passive sync (a
   * viewport click scrolling the editor) is deliberately not a thing.
   */
  async gotoSource(location: Partial<SourceLocation> & { line: number }): Promise<void> {
    const absPath = location.filePath ?? this.currentModelPath;
    if (!absPath) {
      return;
    }
    this.pane.setOpen(true);
    await this.openFile(absPath, { reveal: true });
    const editor = this.pane.getEditor();
    if (!editor) {
      return;
    }
    const position = { lineNumber: location.line, column: (location.column ?? 0) + 1 };
    editor.revealLineInCenter(position.lineNumber);
    editor.setPosition(position);
    editor.focus();
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

/** A new `.fluid.js` starts as something that renders, not an empty file. */
function scaffoldFor(relPath: string): string {
  if (!relPath.endsWith('.fluid.js')) {
    return '';
  }
  return [
    "import { sketch, rect, extrude } from 'fluidcad/core';",
    '',
    "sketch('xy', () => {",
    '  rect(40, 20);',
    '});',
    '',
    'extrude(10);',
    '',
  ].join('\n');
}

export { monaco };
export type { FileTab };
