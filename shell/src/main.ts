import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron';
import fs from 'fs';
import path from 'path';
import { builtinEngine, pruneEngines } from './engine/cache';
import { thumbnailsDir } from './engine/paths';
import { buildApplicationMenu, refreshApplicationMenu, type MenuActions } from './menu';
import { createNewProject } from './new-project';
import { handleAppScheme, registerAppScheme } from './start/app-protocol';
import { registerStartScreenIpc } from './start/ipc';
import { startPageRoot } from './start/page-source';
import { pinnedVersions, workspaceForPath } from './state';
import { initAutoUpdate } from './updater';
import { UpgradePrompt, type UpgradeChoice } from './upgrade-prompt';
import { AppWindow } from './window/app-window';
import { routeOpen, type OpenRequest } from './window/registry';

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

// `cache.ts` reads this to find the engine that ships inside the app. Set from
// here because `process.resourcesPath` only exists once Electron is running.
process.env.FLUIDCAD_RESOURCES_PATH ??= process.resourcesPath;

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
 * Send an open to the window it belongs in (see `window/registry.ts`): focus
 * the window that already holds the project, open it in an idle start
 * screen, or open a new window for it.
 */
function requestOpen(request: OpenRequest): void {
  const route = routeOpen(AppWindow.snapshots(), request);
  switch (route.action) {
    case 'focus':
      AppWindow.byId(route.windowId)?.focus();
      return;
    case 'open-in':
      AppWindow.byId(route.windowId)?.openProject(request.path);
      return;
    case 'new-window':
      AppWindow.create().openProject(request.path);
      return;
  }
}

/** A path from outside the app: the command line, a second launch, Finder or Explorer. */
function openFromOs(target: string): void {
  const workspacePath = workspaceForPath(target);
  if (workspacePath) {
    requestOpen({ source: 'os', path: workspacePath });
  }
}

/** File › Open Project… (null asks, as a sheet on the focused window) and Open Recent. */
async function openFromMenu(target: string | null): Promise<void> {
  const workspacePath = target ? workspaceForPath(target) : await promptForProject(BrowserWindow.getFocusedWindow());
  if (workspacePath) {
    requestOpen({ source: 'menu', path: workspacePath });
  }
}

/** File › New Project…: the same `fluidcad init` scaffold the start screen offers. */
async function newProjectFromMenu(): Promise<void> {
  const outcome = await createNewProject(BrowserWindow.getFocusedWindow());
  if (outcome) {
    requestOpen({ source: 'menu', path: outcome.path });
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
    openFromStartScreen: (window, target) => {
      const workspacePath = workspaceForPath(target);
      if (workspacePath) {
        requestOpen({ source: 'start-screen', windowId: window.id, path: workspacePath });
      }
    },
    promptForProject: (window) => promptForProject(window.browserWindow),
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
    const root = startPageRoot({
      packaged: app.isPackaged,
      env: process.env,
      builtinPackageRoot: builtinEngine()?.packageRoot ?? null,
    });
    handleAppScheme({ start: root, thumbnails: thumbnailsDir() });
    AppWindow.configure({ startPageRoot: root, onChanged: onAppChanged });
    UpgradePrompt.configure({ openWindowFor: (workspacePath) => AppWindow.showing(workspacePath) ?? null });
    registerIpcHandlers();
    installSmokeHooks();
    buildApplicationMenu(menuActions);
    // The menu's enablement follows the window in front.
    app.on('browser-window-focus', () => refreshApplicationMenu(menuActions));
    // A staged update shows up as a menu item; the menu is a snapshot, so rebuild.
    initAutoUpdate(() => refreshApplicationMenu(menuActions));

    // Every launch starts on the start screen; a path on the command line (or
    // a Finder double-click) then opens in that same window. It never assumes
    // the last project is the one wanted now.
    AppWindow.create();
    const explicit = pendingOpen ?? pathFromArgv(process.argv);
    if (explicit) {
      openFromOs(explicit);
    }

    // Reclaim disk from engines nothing pins any more. Never touches a version
    // a known project pins, or one with a live process against it.
    try {
      pruneEngines({ keep: 3, protectedVersions: pinnedVersions() });
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
