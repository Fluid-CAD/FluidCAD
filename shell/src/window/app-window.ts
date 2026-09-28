import { BrowserWindow, dialog, shell, type IpcMainInvokeEvent, type WebContents } from 'electron';
import path from 'path';
import { pathToFileURL } from 'url';
import type { ReopenTarget } from '../../../launcher/src/engine/upgrade';
import { readAppState, rememberWindowBounds } from '../../../launcher/src/projects/app-state';
import { probeDirtyFiles } from '../../../launcher/src/projects/dirty-files';
import {
  INITIAL_STATE,
  pageStateOf,
  projectOf,
  transition,
  type OpenEvent,
  type OpenPhase,
  type OpenState,
} from '../../../launcher/src/projects/open-state';
import type { OpeningProject, PageWindowState, UpgradeProgressMessage } from '../../../launcher/src/start/contract';
import { readSavedTheme, themeBackground } from '../../../launcher/src/start/theme';
import { START_URL, isStartPageUrl } from '../start/protocol';
import type { UpgradeChoice } from '../upgrade-prompt';
import { OpenCancelledError, ProjectSession } from './project-session';
import { afterProject, type WindowSnapshot } from './registry';
import { confirmTeardown, type TeardownAction, type TeardownPrompt } from './unsaved-guard';

/**
 * The app's one kind of window. It shows the start screen while no project is
 * open in it, and the project's own page once one is. A project opens in a
 * window of its own, which shows the start page under the opening overlay and
 * then swaps it for the project's page in place; closing the project closes
 * that window, except the app's last, which swaps back to the start screen. A
 * window holds at most one project and at most one engine child.
 *
 * The two documents come from two places. The start screen is the built-in
 * engine's `ui/dist-start`, served by the shell over `fluidcad-app://start/`
 * with no process behind it; a project's page comes from that project's own
 * engine over http, because it must be the pinned engine's UI (Invariants 2
 * and 3). Only the shell moves the window between them — every navigation a
 * page starts is cancelled — and the history is cleared after each swap, so
 * nothing can go "back" to the page that holds the shell bridge.
 *
 * The lifecycle itself is the pure `window-state.ts`; this class feeds it
 * events and does what each new state asks of Electron.
 */

/** `static/`, next to `dist/` where this code is bundled into `main.js` (`scripts/build.js`). */
const STATIC_DIR = path.join(__dirname, '..', 'static');
/**
 * One preload for every document. It decides what to expose from the page's
 * own protocol — the start page and the fallback get the shell bridge, an
 * engine's http page the small native one — which is what lets a single
 * window move between them without being recreated.
 */
const PRELOAD = path.join(__dirname, 'preload.js');
/** The shell's own page for when the start page cannot be used. */
const FALLBACK_PAGE = path.join(STATIC_DIR, 'startup.html');
const FALLBACK_URL = pathToFileURL(FALLBACK_PAGE).href;
/** The start page's first call must arrive within this long, or the window shows the fallback. */
const HELLO_TIMEOUT_MS = 8_000;
/** A start page whose renderer dies this many times in one window is not tried again. */
const MAX_START_CRASHES = 2;
/** Chromium's `ERR_ABORTED`: a load that a newer one replaced, which the shell did on purpose. */
const ERR_ABORTED = -3;
const CASCADE_OFFSET = 24;

type DocumentKind = 'start' | 'fallback' | 'project';

export type AppWindowHooks = {
  /** Where the start page is served from; null means every window shows the fallback. */
  startPageRoot: string | null;
  /** A window changed state, opened or closed, or the recents changed: menus and start screens refresh. */
  onChanged(): void;
};

function projectFor(workspacePath: string): OpeningProject {
  return { path: workspacePath, name: path.basename(workspacePath) };
}

function isHttpUrl(url: string): boolean {
  return /^https?:\/\//i.test(url);
}

function originOf(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

export class AppWindow implements ReopenTarget {
  private static readonly windows = new Set<AppWindow>();
  private static hooks: AppWindowHooks = { startPageRoot: null, onChanged: () => undefined };
  /**
   * Why the start page is out of use for this run, once it has proven
   * unusable (missing, failing to load, crashing, silent, or speaking another
   * protocol). Every window then shows the fallback; the reason is logged once.
   */
  private static fallbackReason: string | null = null;

  readonly browserWindow: BrowserWindow;
  readonly id: number;
  private state: OpenState = INITIAL_STATE;
  private session: ProjectSession | null = null;
  /** Set the project up before opening it: a New Project, until it has been scaffolded. */
  private create = false;
  private openAbort: AbortController | null = null;
  private document: DocumentKind | null = null;
  private helloTimer: NodeJS.Timeout | null = null;
  private startCrashes = 0;
  /** Set once the window may close without asking anything more. */
  private closeReady = false;
  private closePreparation: Promise<boolean> | null = null;
  private teardown: Promise<boolean> | null = null;

  static configure(hooks: AppWindowHooks): void {
    AppWindow.hooks = hooks;
  }

  /** A new window on the start screen. */
  static create(): AppWindow {
    const window = new AppWindow();
    void window.showStartDocument();
    return window;
  }

  static all(): AppWindow[] {
    return [...AppWindow.windows];
  }

  static byId(id: number): AppWindow | undefined {
    return AppWindow.all().find((window) => window.id === id);
  }

  static fromWebContents(contents: WebContents): AppWindow | undefined {
    return AppWindow.all().find((window) => !window.browserWindow.isDestroyed() && window.browserWindow.webContents === contents);
  }

  static focused(): AppWindow | undefined {
    const focused = BrowserWindow.getFocusedWindow();
    return focused ? AppWindow.all().find((window) => window.browserWindow === focused) : undefined;
  }

  /** The window that holds `workspacePath` — opening it, failed on it, or showing it. */
  static holding(workspacePath: string): AppWindow | undefined {
    return AppWindow.all().find((window) => projectOf(window.state)?.path === workspacePath);
  }

  /** The window showing `workspacePath` as a running project, if any. */
  static showing(workspacePath: string): AppWindow | undefined {
    return AppWindow.all().find((window) => window.state.phase === 'project' && window.state.project.path === workspacePath);
  }

  static snapshots(): WindowSnapshot[] {
    return AppWindow.all().map((window) => window.snapshot());
  }

  /** Tell every other part of the shell that something a menu or a start screen shows has changed. */
  static changed(): void {
    AppWindow.hooks.onChanged();
  }

  /**
   * The window a start-screen IPC call came from, or null when it did not come
   * from a start screen: only the main frame of an app window, showing the
   * start page or the fallback, may use the shell bridge. The preload never
   * gives an engine page that API; this is what holds even if one got hold of it.
   */
  static forStartScreenSender(event: IpcMainInvokeEvent): AppWindow | null {
    const frame = event.senderFrame;
    if (!frame || frame.parent !== null) {
      return null;
    }
    const window = AppWindow.fromWebContents(event.sender);
    if (!window) {
      return null;
    }
    const url = frame.url.split(/[?#]/)[0];
    return isStartPageUrl(frame.url) || url === FALLBACK_URL ? window : null;
  }

  /**
   * Before the app quits: ask every open project about unsaved buffers, one
   * window at a time, then take every thumbnail at once. False when the user
   * cancelled anywhere — the app then keeps running, untouched.
   */
  static async prepareQuit(): Promise<boolean> {
    const projects = AppWindow.all().filter((window) => window.state.phase === 'project');
    for (const window of projects) {
      if (!(await window.confirmTeardown('quit'))) {
        return false;
      }
    }
    await Promise.allSettled(projects.map((window) => window.session?.captureThumbnail()));
    for (const window of AppWindow.all()) {
      window.closeReady = true;
    }
    return true;
  }

  /** On quit, once everything is prepared: stop every engine without waiting for windows to go. */
  static shutdownAll(): void {
    for (const window of AppWindow.all()) {
      window.openAbort?.abort();
      window.session?.stop();
    }
  }

  private constructor() {
    const theme = readSavedTheme();
    this.browserWindow = new BrowserWindow({
      ...AppWindow.initialBounds(),
      minWidth: 720,
      minHeight: 480,
      title: 'FluidCAD',
      icon: path.join(STATIC_DIR, 'icon.png'),
      backgroundColor: themeBackground(theme),
      show: false,
      webPreferences: {
        preload: PRELOAD,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webSecurity: true,
      },
    });
    this.id = this.browserWindow.id;
    AppWindow.windows.add(this);
    this.browserWindow.once('ready-to-show', () => this.browserWindow.show());
    this.wireWindow();
    this.wireContents(this.browserWindow.webContents);
    AppWindow.changed();
  }

  /** The remembered size; a window opened next to another is offset from it rather than stacked exactly on top. */
  private static initialBounds(): { width: number; height: number; x?: number; y?: number } {
    const saved = readAppState().windowBounds;
    const size = { width: saved?.width ?? 1440, height: saved?.height ?? 900 };
    const front = BrowserWindow.getFocusedWindow() ?? AppWindow.all().at(-1)?.browserWindow;
    if (front && !front.isDestroyed()) {
      const bounds = front.getNormalBounds();
      return { ...size, x: bounds.x + CASCADE_OFFSET, y: bounds.y + CASCADE_OFFSET };
    }
    return { ...size, x: saved?.x, y: saved?.y };
  }

  get phase(): OpenPhase {
    return this.state.phase;
  }

  get projectPath(): string | null {
    return projectOf(this.state)?.path ?? null;
  }

  snapshot(): WindowSnapshot {
    return { id: this.id, projectPath: this.projectPath };
  }

  /** What the start page shows; `home` while the project's own page is up, which the start page never sees. */
  pageState(): PageWindowState {
    return pageStateOf(this.state) ?? { phase: 'home' };
  }

  focus(): void {
    if (this.browserWindow.isDestroyed()) {
      return;
    }
    if (this.browserWindow.isMinimized()) {
      this.browserWindow.restore();
    }
    this.browserWindow.show();
    this.browserWindow.focus();
  }

  // -------------------------------------------------------------------------
  // Opening
  // -------------------------------------------------------------------------

  /**
   * Open `workspacePath` in this window, from its start screen (home, or after
   * a failure). `create` sets a new project up first. Returns once the open
   * has begun — its progress, and its failure, show on the start page's
   * overlay, and success replaces the page with the project's.
   */
  openProject(workspacePath: string, options: { create?: boolean } = {}): void {
    const create = options.create === true;
    if (this.dispatch({ type: 'open', project: projectFor(workspacePath), status: { step: create ? 'creating' : 'resolving' } })) {
      this.create = create;
      void this.runOpen();
    }
  }

  /** Try again after a failure. */
  retryOpen(): void {
    if (this.dispatch({ type: 'retry', status: { step: this.create ? 'creating' : 'resolving' } })) {
      void this.runOpen();
    }
  }

  /**
   * Cancel, or Back to projects after a failure: abandon the open, and let
   * the window go — it was opened for this project — unless it is the last
   * one, which shows the start screen instead.
   */
  cancelOpen(): void {
    if (this.abandonOpen() && afterProject(AppWindow.all().length) === 'close-window') {
      this.browserWindow.close();
    }
  }

  /** Stop the open in progress, or leave a failed one; the window is back on its start screen. False when it held none. */
  private abandonOpen(): boolean {
    if (this.state.phase === 'opening') {
      this.openAbort?.abort();
      this.openAbort = null;
      this.session?.stop();
      this.session = null;
    }
    return this.dispatch({ type: 'cancel' });
  }

  private async runOpen(): Promise<void> {
    const state = this.state;
    if (state.phase !== 'opening') {
      return;
    }
    const attempt = state.attempt;
    const abort = new AbortController();
    this.openAbort = abort;
    const session = new ProjectSession(state.project.path, this.browserWindow);
    this.session = session;
    try {
      const url = await session.start(abort.signal, (status) => this.dispatch({ type: 'progress', attempt, status }), {
        create: this.create,
      });
      // Opened: a reopen after a pin change is an ordinary open. (A retry
      // after a failure may scaffold again; that is a no-op on a project.)
      this.create = false;
      if (!this.dispatch({ type: 'ready', attempt, url })) {
        // Cancelled or superseded while the engine came up.
        session.stop();
        return;
      }
      await this.showProjectDocument(url);
      await session.afterLoad();
    } catch (err: any) {
      session.stop();
      if (this.session === session) {
        this.session = null;
      }
      if (!(err instanceof OpenCancelledError)) {
        this.dispatch({ type: 'fail', attempt, message: err?.message ?? String(err) });
      }
    } finally {
      if (this.openAbort === abort) {
        this.openAbort = null;
      }
    }
  }

  // -------------------------------------------------------------------------
  // Closing the project
  // -------------------------------------------------------------------------

  /**
   * Close Project: ask about unsaved buffers, take the preview, and let the
   * window go with its engine — or, in the app's last window, show the start
   * screen (instant — it is a local page) and then stop the engine. False
   * when the user chose Cancel and the project stays open.
   */
  closeProject(): Promise<boolean> {
    return this.teardownProject(afterProject(AppWindow.all().length) === 'close-window' ? 'close' : 'home', false);
  }

  /**
   * Close the project and open it again in this window, on whatever it pins
   * now (a pin change). The caller asked about unsaved buffers already —
   * before the pin moved — through {@link confirmTeardown}.
   */
  async reopenProject(): Promise<void> {
    await this.teardownProject('reopen', true);
  }

  /** Ask about unsaved buffers before a teardown. True when it may go ahead. */
  confirmTeardown(action: TeardownAction = 'reopen'): Promise<boolean> {
    if (this.state.phase !== 'project') {
      return Promise.resolve(true);
    }
    const session = this.session;
    return confirmTeardown(
      {
        probe: () => probeDirtyFiles(session?.engineUrl ?? null),
        ask: (prompt) => this.ask(prompt),
        saveAll: () => this.sendMenuCommand('save-all'),
        sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      },
      { workspacePath: this.state.project.path, action },
    );
  }

  private teardownProject(then: 'home' | 'reopen' | 'close', confirmed: boolean): Promise<boolean> {
    if (this.state.phase !== 'project') {
      return Promise.resolve(true);
    }
    this.teardown ??= (async () => {
      if (!confirmed && !(await this.confirmTeardown('close-project'))) {
        return false;
      }
      const session = this.session;
      await session?.captureThumbnail();
      if (then === 'close') {
        // Asked and photographed already; `closed` stops the engine and
        // tells every start screen.
        this.closeReady = true;
        this.browserWindow.close();
        return true;
      }
      // The state first, so the start page asks for it and finds it current.
      this.dispatch(then === 'home' ? { type: 'close-project' } : { type: 'reopen' });
      await this.showStartDocument();
      session?.stop();
      if (this.session === session) {
        this.session = null;
      }
      // The new thumbnail, and the "open" chip gone, on every start screen.
      AppWindow.changed();
      if (then === 'reopen') {
        void this.runOpen();
      }
      return true;
    })().finally(() => {
      this.teardown = null;
    });
    return this.teardown;
  }

  /**
   * File › Close Project (Ctrl/Cmd+W), whatever the window is doing: close
   * the project (and with it the window, unless it is the last one), abandon
   * an open, and close the window when it is on the start screen.
   */
  closeProjectCommand(): void {
    switch (this.state.phase) {
      case 'home':
        this.browserWindow.close();
        return;
      case 'opening':
      case 'failed':
        this.cancelOpen();
        return;
      case 'project':
        void this.closeProject();
        return;
    }
  }

  // -------------------------------------------------------------------------
  // The project's engine
  // -------------------------------------------------------------------------

  async restartEngine(): Promise<void> {
    if (this.state.phase === 'project') {
      await this.session?.restartEngine();
    }
  }

  async respondToUpgrade(choice: UpgradeChoice): Promise<void> {
    if (this.state.phase === 'project') {
      await this.session?.respondToUpgrade(choice);
    }
  }

  /** A menu command for the project's page; nothing on the start screen, where no page would act on it. */
  sendMenuCommand(command: string, payload?: unknown): void {
    if (this.state.phase === 'project' && this.document === 'project' && !this.browserWindow.isDestroyed()) {
      this.browserWindow.webContents.send('desktop:menu-command', command, payload);
    }
  }

  // -------------------------------------------------------------------------
  // The start page
  // -------------------------------------------------------------------------

  /** The start page introduced itself; a protocol it does not share with this shell means the fallback. */
  helloReceived(ok: boolean): void {
    this.clearHelloTimer();
    if (!ok) {
      void this.showFallback('the start page speaks a different protocol');
    }
  }

  /** The recents or a preview changed: a start screen in this window re-reads them. */
  notifyStartChanged(): void {
    if (this.showingStartScreen() && !this.browserWindow.isDestroyed()) {
      this.browserWindow.webContents.send('shell:start-changed');
    }
  }

  sendUpgradeProgress(progress: UpgradeProgressMessage): void {
    if (this.showingStartScreen() && !this.browserWindow.isDestroyed()) {
      this.browserWindow.webContents.send('shell:upgrade-progress', progress);
    }
  }

  private showingStartScreen(): boolean {
    return this.document === 'start' || this.document === 'fallback';
  }

  // -------------------------------------------------------------------------
  // State and documents
  // -------------------------------------------------------------------------

  /** Apply an event; false when it did not change anything. */
  private dispatch(event: OpenEvent): boolean {
    const previous = this.state;
    const next = transition(previous, event);
    if (next === previous) {
      return false;
    }
    this.state = next;
    const pageState = pageStateOf(next);
    if (pageState && this.showingStartScreen() && !this.browserWindow.isDestroyed()) {
      this.browserWindow.webContents.send('shell:window-state', pageState);
    }
    this.updateTitle();
    // Menus and other start screens care which phase a window is in and which
    // project it holds — not about every download progress tick.
    if (next.phase !== previous.phase || projectOf(next)?.path !== projectOf(previous)?.path) {
      AppWindow.changed();
    }
    return true;
  }

  private async showStartDocument(): Promise<void> {
    if (!AppWindow.hooks.startPageRoot) {
      await this.showFallback('no start page is installed with this app');
      return;
    }
    if (AppWindow.fallbackReason) {
      await this.showFallback(AppWindow.fallbackReason);
      return;
    }
    this.document = 'start';
    this.armHelloTimer();
    await this.load(() => this.browserWindow.loadURL(START_URL));
  }

  private async showFallback(reason: string): Promise<void> {
    if (!AppWindow.fallbackReason) {
      AppWindow.fallbackReason = reason;
      // Where every other shell failure is diagnosed: a terminal launch.
      console.warn(`[shell] start screen unavailable (${reason}); showing the fallback page`);
    }
    this.clearHelloTimer();
    this.document = 'fallback';
    await this.load(() => this.browserWindow.loadFile(FALLBACK_PAGE, { query: { theme: readSavedTheme() } }));
  }

  private async showProjectDocument(url: string): Promise<void> {
    this.clearHelloTimer();
    this.document = 'project';
    await this.load(() => this.browserWindow.loadURL(url));
  }

  /**
   * Swap the document. The background is set first, from the saved theme, so
   * a light-theme user never sees a dark frame in between; the history is
   * cleared after, so there is no page to go back to.
   */
  private async load(navigate: () => Promise<void>): Promise<void> {
    if (this.browserWindow.isDestroyed()) {
      return;
    }
    this.browserWindow.setBackgroundColor(themeBackground(readSavedTheme()));
    try {
      await navigate();
    } catch {
      // Failed, or replaced by a newer load: `did-fail-load` decides what that means.
    }
    if (!this.browserWindow.isDestroyed()) {
      this.browserWindow.webContents.navigationHistory.clear();
      this.updateTitle();
    }
  }

  private updateTitle(): void {
    if (this.browserWindow.isDestroyed()) {
      return;
    }
    const project = this.state.phase === 'project' ? this.state.project : null;
    this.browserWindow.setTitle(project ? `${project.name} — FluidCAD` : 'FluidCAD');
  }

  private armHelloTimer(): void {
    this.clearHelloTimer();
    this.helloTimer = setTimeout(() => {
      this.helloTimer = null;
      if (this.document === 'start') {
        void this.showFallback(`the start page did not answer within ${HELLO_TIMEOUT_MS / 1000} s`);
      }
    }, HELLO_TIMEOUT_MS);
  }

  private clearHelloTimer(): void {
    if (this.helloTimer) {
      clearTimeout(this.helloTimer);
      this.helloTimer = null;
    }
  }

  private async ask(prompt: TeardownPrompt): Promise<number> {
    if (this.browserWindow.isDestroyed()) {
      return prompt.cancelId;
    }
    this.focus();
    const result = await dialog.showMessageBox(this.browserWindow, {
      type: 'warning',
      message: prompt.message,
      detail: prompt.detail,
      buttons: prompt.buttons,
      defaultId: prompt.defaultId,
      cancelId: prompt.cancelId,
      noLink: true,
    });
    return result.response;
  }

  /** Everything that has to happen before this window may go: unsaved buffers, the preview, an open in flight. */
  private prepareToClose(): Promise<boolean> {
    this.closePreparation ??= (async () => {
      if (this.state.phase === 'opening') {
        this.abandonOpen();
        return true;
      }
      if (this.state.phase !== 'project') {
        return true;
      }
      if (!(await this.confirmTeardown('close-window'))) {
        return false;
      }
      await this.session?.captureThumbnail();
      return true;
    })().finally(() => {
      this.closePreparation = null;
    });
    return this.closePreparation;
  }

  private wireWindow(): void {
    const browserWindow = this.browserWindow;
    browserWindow.on('close', (event) => {
      rememberWindowBounds(browserWindow.getNormalBounds());
      if (this.closeReady) {
        return;
      }
      // Hold the window: the question about unsaved buffers and the
      // thumbnail both need the live page and engine.
      event.preventDefault();
      void this.prepareToClose().then((ok) => {
        if (ok && !browserWindow.isDestroyed()) {
          this.closeReady = true;
          browserWindow.close();
        }
      });
    });
    // The title follows the window's state ("FluidCAD", or "<project> —
    // FluidCAD"), not whichever document last loaded: every page's own
    // <title> is just "FluidCAD", and a reload would otherwise wipe the
    // project's name off the window.
    browserWindow.on('page-title-updated', (event) => event.preventDefault());
    browserWindow.on('closed', () => {
      AppWindow.windows.delete(this);
      this.clearHelloTimer();
      this.openAbort?.abort();
      this.session?.stop();
      this.session = null;
      AppWindow.changed();
    });
  }

  private wireContents(contents: WebContents): void {
    // Links to the docs, the hub, anything external: the user's browser, never
    // a second Electron window with no chrome.
    contents.setWindowOpenHandler(({ url }) => {
      if (isHttpUrl(url)) {
        void shell.openExternal(url);
      }
      return { action: 'deny' };
    });
    // The navigation lock. Only the shell moves a window between documents,
    // with `loadURL`; a page asking to go anywhere is refused. Without this an
    // engine page could send its window to the start page and inherit the
    // shell bridge (observed in the P4-0 spike). A link off-site still opens,
    // in the browser.
    contents.on('will-navigate', (event, url) => {
      event.preventDefault();
      if (isHttpUrl(url) && originOf(url) !== originOf(contents.getURL())) {
        void shell.openExternal(url);
      }
    });
    // No frame may load a shell document. The start page's CSP already
    // refuses to be framed; this stops the request from being made at all.
    contents.on('will-frame-navigate', (event) => {
      if (!event.isMainFrame && !isHttpUrl(event.url)) {
        event.preventDefault();
      }
    });
    contents.on('did-fail-load', (_event, errorCode, description, _url, isMainFrame) => {
      if (isMainFrame && errorCode !== ERR_ABORTED && this.document === 'start') {
        void this.showFallback(`the start page failed to load: ${description} (${errorCode})`);
      }
    });
    contents.on('render-process-gone', (_event, details) => {
      if (this.document !== 'start') {
        return;
      }
      this.startCrashes += 1;
      if (this.startCrashes >= MAX_START_CRASHES) {
        void this.showFallback(`the start page's renderer exited ${this.startCrashes} times (${details.reason})`);
      } else {
        void this.showStartDocument();
      }
    });
  }
}
