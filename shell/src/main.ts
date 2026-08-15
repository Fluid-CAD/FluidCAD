import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron';
import fs from 'fs';
import path from 'path';
import { pruneEngines } from './engine/cache';
import { buildApplicationMenu, refreshApplicationMenu } from './menu';
import { openEngineManager, registerEngineManagerHandlers } from './engine-manager';
import { allProjectWindows, findProjectWindow, openProjectWindow, windowFor } from './project-window';
import { listRecentProjects, pinnedVersions, workspaceForPath } from './state';
import { initAutoUpdate } from './updater';

/**
 * The FluidCAD desktop shell.
 *
 * It does two things: spawn a child process, and load one URL. Everything a
 * user sees inside the window — the viewport, the editor, the dialogs — is the
 * engine's page, served from the engine that this project pins. That is the
 * whole design: see `docs/desktop/00-architecture.md`, and resist every urge
 * to put product UI in here.
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

async function promptForProject(): Promise<string | null> {
  const result = await dialog.showOpenDialog({
    title: 'Open a FluidCAD project',
    properties: ['openDirectory', 'createDirectory'],
    buttonLabel: 'Open project',
  });
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

export async function openProject(target: string | null): Promise<void> {
  const workspacePath = target ? workspaceForPath(target) : await promptForProject();
  if (!workspacePath) {
    return;
  }
  const existing = findProjectWindow(workspacePath);
  if (existing) {
    existing.focus();
    return;
  }
  await openProjectWindow(workspacePath);
  // Open Recent is a snapshot taken when the menu was built; the project just
  // opened has to appear in it without restarting the app.
  refreshApplicationMenu(menuActions);
}

const menuActions = { openProject, openEngineManager };

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
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

if (singleInstance) {
  /** A macOS `open-file` that arrived before the app was ready. */
  let pendingOpen: string | null = null;

  app.on('second-instance', (_event, argv) => {
    const target = pathFromArgv(argv);
    if (target) {
      void openProject(target);
      return;
    }
    allProjectWindows()[0]?.focus();
  });

  // macOS: double-clicking a `.fluid.js` in Finder, or dropping one on the icon.
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

    // `fluidcad --engines` goes straight to the manager, and to nothing else.
    // Useful when a pinned engine won't download and the fix is to look at
    // what *is* installed.
    const enginesOnly = process.argv.includes('--engines');
    if (enginesOnly) {
      await openEngineManager();
    }

    const explicit = pendingOpen ?? pathFromArgv(process.argv);
    if (explicit || !enginesOnly) {
      await openProject(explicit ?? listRecentProjects()[0]?.path ?? null);
    }

    if (BrowserWindow.getAllWindows().length === 0) {
      // The user cancelled the picker with nothing else open — there is no
      // product without a project, so there is nothing to keep running.
      app.quit();
      return;
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
      void openProject(listRecentProjects()[0]?.path ?? null);
    }
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
      app.quit();
    }
  });

  app.on('before-quit', () => {
    for (const window of allProjectWindows()) {
      window.shutdown();
    }
  });
}
