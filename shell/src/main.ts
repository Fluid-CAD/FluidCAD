import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron';
import fs from 'fs';
import path from 'path';
import { pruneEngines } from './engine/cache';
import { buildApplicationMenu, refreshApplicationMenu } from './menu';
import { openEngineManager, registerEngineManagerHandlers } from './engine-manager';
import {
  allProjectWindows,
  findProjectWindow,
  onProjectWindowClosed,
  openProjectWindow,
  windowFor,
  type ProjectWindow,
} from './project-window';
import {
  closeStartScreen,
  isStartScreenOpen,
  openStartScreen,
  refreshStartScreen,
  registerStartScreenHandlers,
} from './start-screen';
import { pinnedVersions, workspaceForPath } from './state';
import { initAutoUpdate } from './updater';

/**
 * The FluidCAD desktop shell.
 *
 * It does two things: spawn a child process, and load one URL. Everything a
 * user sees inside the window — the viewport, the editor, the dialogs — is the
 * engine's page, served from the engine that this project pins. That is the
 * whole design: see `docs/desktop/00-architecture.md`, and resist every urge
 * to put product UI in here. The two shell pages — the start screen and the
 * engine manager — are the exceptions, and both exist precisely for the
 * moments when there is no engine to show anything.
 */

// `cache.ts` reads this to find the engine that ships inside the app. Set from
// here because `process.resourcesPath` only exists once Electron is running.
process.env.FLUIDCAD_RESOURCES_PATH ??= process.resourcesPath;

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

/** The window that a menu action or an IPC call belongs to. */
function callerWindow(event?: Electron.IpcMainInvokeEvent) {
  const browserWindow = event
    ? BrowserWindow.fromWebContents(event.sender)
    : BrowserWindow.getFocusedWindow();
  return windowFor(browserWindow);
}

/**
 * Open (or focus) a project; `null` asks the user for one, as a sheet on
 * `parent` when given. Returns the window, or null when nothing was opened —
 * the start screen uses that to know whether it should stay up.
 */
export async function openProject(
  target: string | null,
  parent: BrowserWindow | null = null,
): Promise<ProjectWindow | null> {
  const workspacePath = target ? workspaceForPath(target) : await promptForProject(parent);
  if (!workspacePath) {
    return null;
  }
  const existing = findProjectWindow(workspacePath);
  if (existing) {
    existing.focus();
    closeStartScreen();
    return existing;
  }
  const opened = await openProjectWindow(workspacePath);
  // The start screen is a launcher: once a project is up it has done its job.
  closeStartScreen();
  // Open Recent is a snapshot taken when the menu was built; the project just
  // opened has to appear in it without restarting the app.
  refreshApplicationMenu(menuActions);
  return opened;
}

const menuActions = { openProject, openEngineManager, openStartScreen };

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
    await callerWindow(event)?.restartEngine();
  });

  // The startup splash, when an engine could not be resolved.
  ipcMain.handle('shell:retry', async (event) => {
    await callerWindow(event)?.open();
  });

  ipcMain.handle('shell:open-project', async () => {
    await openProject(null);
  });

  registerEngineManagerHandlers({ openProject });
  registerStartScreenHandlers({ openProject });
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

if (singleInstance) {
  /** A macOS `open-file` that arrived before the app was ready. */
  let pendingOpen: string | null = null;
  /** Set on the first `before-quit`; the start screen must not reappear while windows go down. */
  let quitting = false;

  app.on('second-instance', (_event, argv) => {
    const target = pathFromArgv(argv);
    if (target) {
      void openProject(target);
      return;
    }
    const front = allProjectWindows()[0];
    if (front) {
      front.focus();
    } else {
      openStartScreen();
    }
  });

  // macOS: double-clicking a model file in Finder, or dropping one on the icon.
  app.on('open-file', (event, filePath) => {
    event.preventDefault();
    if (app.isReady()) {
      void openProject(filePath);
    } else {
      pendingOpen = filePath;
    }
  });

  app.whenReady().then(async () => {
    registerIpcHandlers();
    installSmokeHooks();
    buildApplicationMenu(menuActions);
    initAutoUpdate();

    // Closing a project window closes it, full stop — no start screen pops
    // up in its place. An already-open start screen just refreshes so the
    // thumbnail captured on close shows up.
    onProjectWindowClosed((_window, info) => {
      if (quitting || info.reopening) {
        return;
      }
      if (isStartScreenOpen()) {
        refreshStartScreen();
      }
    });

    // `fluidcad --engines` goes straight to the manager, and to nothing else.
    // Useful when a pinned engine won't download and the fix is to look at
    // what *is* installed.
    const enginesOnly = process.argv.includes('--engines');
    if (enginesOnly) {
      await openEngineManager();
    }

    // A path on the command line (or a Finder double-click) opens that
    // project; otherwise the app starts on the start screen and the user
    // picks — it never assumes the last project is the one wanted now.
    const explicit = pendingOpen ?? pathFromArgv(process.argv);
    if (explicit) {
      await openProject(explicit);
    } else if (!enginesOnly) {
      openStartScreen();
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
    if (BrowserWindow.getAllWindows().length === 0) {
      openStartScreen();
    }
  });

  app.on('window-all-closed', () => {
    // A pin-change reopen may already be spinning up the next window; only a
    // truly empty app quits.
    if (process.platform !== 'darwin' && BrowserWindow.getAllWindows().length === 0) {
      app.quit();
    }
  });

  app.on('before-quit', (event) => {
    quitting = true;
    // Thumbnails come from the live pages, and the engines die below — so on
    // the first pass hold the quit, capture every open project at once, and
    // quit again with the pictures in hand.
    const pending = allProjectWindows().filter((window) => !window.readyToClose);
    if (pending.length > 0) {
      event.preventDefault();
      void Promise.allSettled(pending.map((window) => window.prepareClose())).then(() => app.quit());
      return;
    }
    for (const window of allProjectWindows()) {
      window.shutdown();
    }
  });
}
