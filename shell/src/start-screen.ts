import { BrowserWindow, ipcMain, shell } from 'electron';
import os from 'os';
import path from 'path';
import { projectInstalledEngine, readProjectPin } from './engine/project-pin';
import { defaultEngine, isEngineManagedLink } from './engine/resolver';
import { createNewProject } from './new-project';
import { findProjectWindow, type ProjectWindow } from './project-window';
import { forgetProject, listRecentProjects } from './state';
import { readThumbnail } from './thumbnails';

/**
 * The start screen: the window the app opens on when nothing told it which
 * project to open. A grid of recent projects — folder name, cached preview,
 * the engine each one pins — and two buttons: open a folder, or scaffold a
 * new project into an empty one.
 *
 * Like the engine manager it is a shell page, not engine UI: it exists before
 * any engine is running, and it lists projects across every engine version.
 * It closes itself when a project opens from it and comes back when the last
 * project window closes (see `main.ts`), so it behaves as the app's home.
 */

const START_PAGE = path.join(__dirname, '..', 'static', 'start.html');
const PRELOAD = path.join(__dirname, 'preload.js');

let startWindow: BrowserWindow | null = null;

export function isStartScreenOpen(): boolean {
  return startWindow !== null && !startWindow.isDestroyed();
}

/**
 * Show the start screen, focusing it if it is already up. The window is
 * created synchronously on purpose: called from a project window's `closed`
 * handler, that is what keeps Electron from seeing "all windows closed" (and
 * quitting on Windows/Linux) in between.
 */
export function openStartScreen(): void {
  if (startWindow && !startWindow.isDestroyed()) {
    if (startWindow.isMinimized()) {
      startWindow.restore();
    }
    startWindow.focus();
    return;
  }
  startWindow = new BrowserWindow({
    width: 1040,
    height: 700,
    minWidth: 720,
    minHeight: 480,
    title: 'FluidCAD',
    backgroundColor: '#1c1c1c',
    show: false,
    webPreferences: {
      preload: PRELOAD,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  startWindow.once('ready-to-show', () => startWindow?.show());
  startWindow.on('closed', () => {
    startWindow = null;
  });
  startWindow.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: 'deny' };
  });
  void startWindow.loadFile(START_PAGE);
}

export function closeStartScreen(): void {
  if (startWindow && !startWindow.isDestroyed()) {
    startWindow.close();
  }
  startWindow = null;
}

/** Tell an open start screen that the recents (or a thumbnail) changed. */
export function refreshStartScreen(): void {
  if (startWindow && !startWindow.isDestroyed()) {
    startWindow.webContents.send('shell:start-changed');
  }
}

export type StartScreenDeps = {
  openProject: (target: string | null, parent?: BrowserWindow | null) => Promise<ProjectWindow | null>;
};

export type StartScreenProject = {
  path: string;
  name: string;
  /** The engine version the project runs on, and where that comes from. */
  engine: string | null;
  engineSource: 'pin' | 'own' | null;
  lastOpenedAt: string;
  open: boolean;
  thumbnail: string | null;
};

function describeProject(workspacePath: string, lastOpenedAt: string): StartScreenProject {
  // Same rule as the engine manager: an install the user made wins, a link the
  // engine planted does not count as one, and the pin is read live so a pin
  // moved in the manager shows up here without reopening.
  const own = isEngineManagedLink(workspacePath) ? null : projectInstalledEngine(workspacePath);
  const pin = readProjectPin(workspacePath).engine;
  return {
    path: workspacePath,
    name: path.basename(workspacePath),
    engine: own ?? pin,
    engineSource: own ? 'own' : pin ? 'pin' : null,
    lastOpenedAt,
    open: Boolean(findProjectWindow(workspacePath)),
    thumbnail: readThumbnail(workspacePath)?.dataUrl ?? null,
  };
}

export function registerStartScreenHandlers(deps: StartScreenDeps): void {
  ipcMain.handle('shell:start-list', () => ({
    projects: listRecentProjects().map((entry) => describeProject(entry.path, entry.lastOpenedAt)),
    defaultEngine: defaultEngine()?.version ?? null,
    /** For `~/…` in the cards; the page has no `os` of its own. */
    home: os.homedir(),
  }));

  ipcMain.handle('shell:start-open', async (_event, workspacePath: string) => {
    await deps.openProject(workspacePath, startWindow);
  });

  ipcMain.handle('shell:start-open-dialog', async () => {
    await deps.openProject(null, startWindow);
  });

  ipcMain.handle('shell:start-new-project', async () => {
    const outcome = await createNewProject(startWindow);
    if (outcome) {
      await deps.openProject(outcome.path, startWindow);
    }
  });

  ipcMain.handle('shell:start-forget', (_event, workspacePath: string) => {
    forgetProject(workspacePath);
  });

  ipcMain.handle('shell:start-show-in-folder', (_event, workspacePath: string) => {
    shell.showItemInFolder(workspacePath);
  });
}
