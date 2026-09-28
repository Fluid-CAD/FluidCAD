import { app, BrowserWindow, dialog, ipcMain, net, shell } from 'electron';
import fs from 'fs';
import path from 'path';
import { builtinEngine, pruneEngines, setBuiltinEngineLocation } from '../../launcher/src/engine/cache';
import { EngineTransport } from '../../launcher/src/engine/download';
import { EngineScratch } from '../../launcher/src/engine/scratch';
import { thumbnailsDir } from '../../launcher/src/paths';
import { pinnedVersions, workspaceForPath } from '../../launcher/src/projects/app-state';
import { StartApi } from '../../launcher/src/start/api';
import { buildApplicationMenu, refreshApplicationMenu, type MenuActions } from './menu';
import { chooseNewProjectFolder } from './new-project';
import { handleAppScheme, registerAppScheme } from './start/app-protocol';
import { registerStartScreenIpc } from './start/ipc';
import { startPageRoot } from './start/page-source';
import { thumbnailUrl } from './start/protocol';
import { initAutoUpdate } from './updater';
import { UpgradePrompt, type UpgradeChoice } from './upgrade-prompt';
import { AppWindow } from './window/app-window';
import { routeOpen } from './window/registry';

/**
 * The FluidCAD desktop shell.
 *
 * It does two things: spawn a child process, and load one URL. Everything a
 * user sees inside a project — the viewport, the editor, the dialogs — is the
 * engine's page, served from the engine that project pins. That is the whole
 * design: see `docs/desktop/00-architecture.md`, and resist every urge to put
 * product UI in here. The start screen is engine UI too, rendered by the engine
 * that ships with the app and served over `fluidcad-app://start/`; the shell
 * owns only its data and actions. The shell's one page of its own is
 * `static/startup.html`, the fallback for when that start page cannot be used.
 */

// The engine that ships inside the app, staged by `scripts/stage-engine.js`
// into the bundle's `resources/engine/`. A dev run has none there and points
// `FLUIDCAD_BUILTIN_ENGINE` at a build instead.
setBuiltinEngineLocation({ kind: 'root', root: path.join(process.resourcesPath, 'engine') });

// An overridden home (E2E runs, a second dev instance) gets its own Electron
// profile too: the single-instance lock lives in userData, so without this an
// isolated instance refuses to start while the real app is open.
if (process.env.FLUIDCAD_HOME) {
  app.setPath('userData', path.join(path.resolve(process.env.FLUIDCAD_HOME), 'electron'));
}

// Before `ready`, or Electron ignores it.
registerAppScheme();

const singleInstance = app.requestSingleInstanceLock();
if (!singleInstance) {
  app.quit();
}

/**
 * A path passed on the command line: `fluidcad-desktop <project|file>`.
 *
 * Scans rather than slices by index. A dev run is `electron <app-dir> <project>`
 * and a packaged run is `fluidcad <project>`, and the `second-instance` event
 * hands over the *other* process's argv, which need not match either shape —
 * an index-based slice picked the app directory itself as the project.
 */
function pathFromArgv(argv: string[]): string | null {
  const appPath = app.getAppPath();
  for (const arg of argv.slice(1)) {
    if (arg.startsWith('-')) {
      continue;
    }
    const resolved = path.resolve(arg);
    if (resolved === appPath || resolved === process.execPath) {
      continue;
    }
    const workspace = workspaceForPath(resolved);
    if (workspace) {
      return workspace;
    }
  }
  return null;
}

async function promptForProject(parent: BrowserWindow | null): Promise<string | null> {
  const options: Electron.OpenDialogOptions = {
    title: 'Open a FluidCAD project',
    properties: ['openDirectory', 'createDirectory'],
    buttonLabel: 'Open project',
  };
  const result =
    parent && !parent.isDestroyed()
      ? await dialog.showOpenDialog(parent, options)
      : await dialog.showOpenDialog(options);
  return result.canceled ? null : result.filePaths[0] ?? null;
}

/**
 * Verification hooks, off unless `FLUIDCAD_SMOKE=1`. A GUI otherwise gives an
 * automated check nothing to assert on; these are how the crash banner, the
 * engine restart and the two-window case were verified.
 *
 *   SIGUSR2 → screenshot the focused window to `$FLUIDCAD_SCREENSHOT`
 *
 * Only SIGUSR2: Chromium's browser process installs its own handlers for
 * SIGHUP/SIGINT/SIGTERM and shuts down before a JS listener sees them. Actions
 * inside the page (clicking the crash banner's Restart button, for one) are
 * driven through `--remote-debugging-port` instead.
 */
function installSmokeHooks(): void {
  if (process.env.FLUIDCAD_SMOKE !== '1') {
    return;
  }
  process.on('SIGUSR2', async () => {
    const target = process.env.FLUIDCAD_SCREENSHOT;
    const window = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
    if (!target || !window) {
      return;
    }
    const image = await window.webContents.capturePage();
    await fs.promises.writeFile(target, image.toPNG());
  });
}

// ---------------------------------------------------------------------------
// Opening projects
// ---------------------------------------------------------------------------

/**
 * Open a project where it belongs (see `window/registry.ts`): the window that
 * already holds it comes forward, and any other project gets a new window —
 * the start screen that asked stays as it is.
 */
function requestOpen(workspacePath: string, options: { create?: boolean } = {}): void {
  const route = routeOpen(AppWindow.snapshots(), workspacePath);
  switch (route.action) {
    case 'focus':
      AppWindow.byId(route.windowId)?.focus();
      return;
    case 'new-window':
      AppWindow.create().openProject(workspacePath, options);
      return;
  }
}

/** A path from outside the app: the command line, a second launch, Finder or Explorer. False when it names nothing. */
function openFromOs(target: string): boolean {
  const workspacePath = workspaceForPath(target);
  if (workspacePath) {
    requestOpen(workspacePath);
  }
  return workspacePath !== null;
}

/** File › Open Project… (null asks, as a sheet on the focused window) and Open Recent. */
async function openFromMenu(target: string | null): Promise<void> {
  const workspacePath = target ? workspaceForPath(target) : await promptForProject(BrowserWindow.getFocusedWindow());
  if (workspacePath) {
    requestOpen(workspacePath);
  }
}

/** File › New Project…: the same `fluidcad init` scaffold the start screen offers. */
async function newProjectFromMenu(): Promise<void> {
  const choice = await chooseNewProjectFolder(BrowserWindow.getFocusedWindow());
  if (choice) {
    requestOpen(choice.path, { create: choice.create });
  }
}

const menuActions: MenuActions = {
  openProject: openFromMenu,
  newProject: newProjectFromMenu,
  newWindow: () => void AppWindow.create(),
};

/**
 * Something a menu or a start screen shows has changed — a window's phase,
 * the recents, a pin. Coalesced: one burst of changes rebuilds the menu once.
 */
let changePending = false;
function onAppChanged(): void {
  if (changePending) {
    return;
  }
  changePending = true;
  setImmediate(() => {
    changePending = false;
    refreshApplicationMenu(menuActions);
    for (const window of AppWindow.all()) {
      window.notifyStartChanged();
    }
  });
}

// ---------------------------------------------------------------------------
// Renderer bridge
// ---------------------------------------------------------------------------

/** The start screen's data and actions, the same `npx fluidcad` serves; what is desktop about them comes from here. */
const startApi = new StartApi({
  appVersion: app.getVersion(),
  isOpen: (workspacePath) => AppWindow.holding(workspacePath) !== undefined,
  thumbnailUrl,
  openProjectFor: (workspacePath) => AppWindow.showing(workspacePath) ?? null,
  changed: () => AppWindow.changed(),
});

function registerIpcHandlers(): void {
  ipcMain.handle('desktop:show-open-dialog', async (event, request) => {
    const browserWindow = BrowserWindow.fromWebContents(event.sender);
    const result = browserWindow
      ? await dialog.showOpenDialog(browserWindow, request ?? {})
      : await dialog.showOpenDialog(request ?? {});
    return result.canceled ? null : result.filePaths;
  });

  ipcMain.handle('desktop:show-save-dialog', async (event, request) => {
    const browserWindow = BrowserWindow.fromWebContents(event.sender);
    const result = browserWindow
      ? await dialog.showSaveDialog(browserWindow, request ?? {})
      : await dialog.showSaveDialog(request ?? {});
    return result.canceled ? null : result.filePath ?? null;
  });

  ipcMain.handle('desktop:write-file', async (_event, filePath: string, base64: string) => {
    try {
      await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
      await fs.promises.writeFile(filePath, Buffer.from(base64, 'base64'));
      return { ok: true };
    } catch (err: any) {
      return { ok: false, error: err?.message ?? String(err) };
    }
  });

  ipcMain.handle('desktop:read-file', async (_event, filePath: string) => {
    try {
      const data = await fs.promises.readFile(filePath);
      return { ok: true, base64: data.toString('base64') };
    } catch (err: any) {
      return { ok: false, error: err?.message ?? String(err) };
    }
  });

  ipcMain.handle('desktop:show-item-in-folder', (_event, filePath: string) => {
    shell.showItemInFolder(filePath);
  });

  ipcMain.handle('desktop:set-title', (event, title: string) => {
    BrowserWindow.fromWebContents(event.sender)?.setTitle(title);
  });

  ipcMain.handle('desktop:restart-engine', async (event) => {
    await AppWindow.fromWebContents(event.sender)?.restartEngine();
  });

  // The upgrade prompt drawn onto a project's page. The choice is validated
  // here, not trusted: the page is engine-versioned and could be anything.
  const UPGRADE_CHOICES = new Set<UpgradeChoice>(['upgrade', 'preview', 'keep', 'never', 'dismiss']);
  ipcMain.handle('desktop:engine-upgrade-respond', async (event, choice: unknown) => {
    if (typeof choice === 'string' && UPGRADE_CHOICES.has(choice as UpgradeChoice)) {
      await AppWindow.fromWebContents(event.sender)?.respondToUpgrade(choice as UpgradeChoice);
    }
  });

  registerStartScreenIpc({
    api: startApi,
    openFromStartScreen: (_window, target, options) => {
      // A new project's folder is empty, not missing: the dialog only returns folders that exist.
      const workspacePath = workspaceForPath(target);
      if (workspacePath) {
        requestOpen(workspacePath, options);
      }
    },
    promptForProject: (window) => promptForProject(window.browserWindow),
    promptForNewProject: (window) => chooseNewProjectFolder(window.browserWindow),
  });
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

if (singleInstance) {
  /** A macOS `open-file` that arrived before the app was ready. */
  let pendingOpen: string | null = null;
  /** Unsaved buffers and thumbnails are handled; the next `before-quit` goes through. */
  let quitApproved = false;
  /** A quit is being prepared (a question may be up); further requests wait for it. */
  let quitPending = false;

  app.on('second-instance', (_event, argv) => {
    const target = pathFromArgv(argv);
    if (target) {
      openFromOs(target);
      return;
    }
    const front = AppWindow.focused() ?? AppWindow.all()[0];
    if (front) {
      front.focus();
    } else {
      AppWindow.create();
    }
  });

  // macOS: double-clicking a model file in Finder, or dropping one on the icon.
  app.on('open-file', (event, filePath) => {
    event.preventDefault();
    if (app.isReady()) {
      openFromOs(filePath);
    } else {
      pendingOpen = filePath;
    }
  });

  app.whenReady().then(() => {
    // Engine downloads go through Chromium's network stack, so they follow the
    // system proxy and PAC settings the same way the updater does.
    EngineTransport.use((url, init) => net.fetch(url, init));
    const root = startPageRoot({
      packaged: app.isPackaged,
      env: process.env,
      builtinPackageRoot: builtinEngine()?.packageRoot ?? null,
    });
    handleAppScheme({ start: root, thumbnails: thumbnailsDir() });
    AppWindow.configure({ startPageRoot: root, onChanged: onAppChanged });
    UpgradePrompt.configure({ openProjectFor: (workspacePath) => AppWindow.showing(workspacePath) ?? null });
    registerIpcHandlers();
    installSmokeHooks();
    buildApplicationMenu(menuActions);
    // The menu's enablement follows the window in front.
    app.on('browser-window-focus', () => refreshApplicationMenu(menuActions));
    // A staged update shows up as a menu item; the menu is a snapshot, so rebuild.
    initAutoUpdate(() => refreshApplicationMenu(menuActions));

    // A launch with a path (the command line, a Finder double-click) opens
    // just that project's window; any other launch starts on the start
    // screen. It never assumes the last project is the one wanted now.
    const explicit = pendingOpen ?? pathFromArgv(process.argv);
    if (!explicit || !openFromOs(explicit)) {
      AppWindow.create();
    }

    // Reclaim disk from engines nothing pins any more. Never touches a version
    // a known project pins, or one with a live process against it. Then clear
    // out downloads and copies that an earlier run quit in the middle of.
    try {
      pruneEngines({ keep: 3, protectedVersions: pinnedVersions() });
      EngineScratch.sweep();
    } catch {
      // Housekeeping; never worth a dialog.
    }
  });

  app.on('activate', () => {
    if (AppWindow.all().length === 0) {
      AppWindow.create();
    }
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin' && BrowserWindow.getAllWindows().length === 0) {
      app.quit();
    }
  });

  app.on('before-quit', (event) => {
    if (quitApproved) {
      AppWindow.shutdownAll();
      return;
    }
    // Unsaved buffers and thumbnails both need the live pages and engines, so
    // hold the quit: ask each project in turn, capture every preview at once,
    // then quit again with everything in hand. A Cancel anywhere keeps the
    // app running as it was.
    event.preventDefault();
    if (quitPending) {
      return;
    }
    quitPending = true;
    void AppWindow.prepareQuit().then((ok) => {
      quitPending = false;
      if (ok) {
        quitApproved = true;
        app.quit();
      }
    });
  });
}
