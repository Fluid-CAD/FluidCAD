import { BrowserWindow, ipcMain } from 'electron';
import path from 'path';
import {
  builtinEngine,
  directorySize,
  findEngine,
  listEngines,
  removeEngine,
  runningEngineVersions,
} from './engine/cache';
import { describeEngineIncompatibility } from './engine/compat';
import { compareVersionsDescending, downloadEngine, listPublishedEngines } from './engine/download';
import { engineRoot, serverEntryFor } from './engine/paths';
import { projectInstalledEngine, readProjectPin, writeProjectPin } from './engine/project-pin';
import type { ResolvedEngine } from './engine/resolver';
import { compareSnapshots, findModels, snapshotWithEngine, type UpgradeDiff } from './engine/upgrade-diff';
import { findProjectWindow } from './project-window';
import { listRecentProjects } from './state';

/**
 * The engine manager: which engines are installed, which projects pin what,
 * and the upgrade-with-diff flow.
 *
 * **Decision (P2-5): this is a shell window, not a page in the engine UI.** It
 * has to work when no engine is running at all (a pinned version failed to
 * download), it talks about engines *other* than the one running, and it
 * deletes them. None of that is an engine's business — and putting it in the
 * engine would mean every engine version shipping its own copy of the cache
 * protocol, which is exactly the compatibility surface Invariant 3 exists to
 * avoid.
 */

const MANAGER_PAGE = path.join(__dirname, '..', 'static', 'engines.html');
const PRELOAD = path.join(__dirname, 'preload.js');

let managerWindow: BrowserWindow | null = null;

export async function openEngineManager(): Promise<void> {
  if (managerWindow && !managerWindow.isDestroyed()) {
    managerWindow.focus();
    return;
  }
  managerWindow = new BrowserWindow({
    width: 880,
    height: 620,
    title: 'FluidCAD Engines',
    backgroundColor: '#1c1c1c',
    webPreferences: {
      preload: PRELOAD,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  managerWindow.on('closed', () => {
    managerWindow = null;
  });
  await managerWindow.loadFile(MANAGER_PAGE);
}

function progress(message: string): void {
  managerWindow?.webContents.send('shell:upgrade-progress', { message });
}

export type EngineManagerDeps = {
  openProject: (target: string | null) => Promise<void>;
};

export function registerEngineManagerHandlers(deps: EngineManagerDeps): void {
  ipcMain.handle('shell:engines-list', async () => {
    const running = runningEngineVersions();
    const engines = listEngines()
      .map((engine) => ({
        version: engine.version,
        builtin: engine.builtin,
        installedAt: engine.installedAt,
        lastUsedAt: engine.lastUsedAt,
        // Measure the engine *root* in both cases — the package plus its
        // dependencies — so the built-in and a cached engine are comparable.
        bytes: directorySize(engine.builtin ? engine.root : engineRoot(engine.version)),
        running: running.has(engine.version),
      }))
      .sort((a, b) => compareVersionsDescending(a.version, b.version));

    const projects = listRecentProjects().map((entry) => ({
      path: entry.path,
      pin: readProjectPin(entry.path).engine,
      ownInstall: projectInstalledEngine(entry.path),
      open: Boolean(findProjectWindow(entry.path)),
    }));

    const published = await listPublishedEngines();
    return {
      engines,
      projects,
      published,
      builtin: builtinEngine()?.version ?? null,
      newest: published[0] ?? null,
    };
  });

  ipcMain.handle('shell:engines-remove', (_event, version: string) => removeEngine(version));

  ipcMain.handle('shell:engines-open-project', async (_event, workspacePath: string) => {
    await deps.openProject(workspacePath);
  });

  /**
   * Download the target engine if needed, rebuild every model in the project
   * with both engines, and return the diff. **Nothing is committed here** — the
   * pin only moves when the user accepts what they were shown.
   */
  ipcMain.handle(
    'shell:engines-preview-upgrade',
    async (_event, workspacePath: string, version: string): Promise<{ diff?: UpgradeDiff; error?: string }> => {
      try {
        const incompatible = describeEngineIncompatibility(version);
        if (incompatible) {
          return { error: incompatible };
        }

        const current = currentEngineFor(workspacePath);
        if (!current) {
          return { error: 'This project has no engine to compare against yet — open it once first.' };
        }

        let target = findEngine(version);
        if (!target) {
          progress(`Downloading engine ${version}…`);
          target = await downloadEngine(version, {
            onProgress: (state) => {
              if (state.totalBytes) {
                const percent = Math.round((state.receivedBytes / state.totalBytes) * 100);
                progress(`Downloading engine ${version}… ${percent}%`);
              }
            },
          });
        }

        const { models, skipped } = findModels(workspacePath);
        if (models.length === 0) {
          return { error: 'This project has no .fluid.js models to compare.' };
        }

        progress(`Building with the current engine ${current.version}…`);
        const before = await snapshotWithEngine(current, workspacePath, models, progress);
        progress(`Building with engine ${version}…`);
        const after = await snapshotWithEngine(
          { ...current, version: target.version, packageRoot: target.packageRoot, serverEntry: serverEntryFor(target.packageRoot) },
          workspacePath,
          models,
          progress,
        );

        progress('');
        return { diff: compareSnapshots(before, after, skipped) };
      } catch (err: any) {
        progress('');
        return { error: err?.message ?? String(err) };
      }
    },
  );

  /** Commit the pin. Separate from the preview on purpose. */
  ipcMain.handle('shell:engines-apply-pin', async (_event, workspacePath: string, version: string) => {
    try {
      writeProjectPin(workspacePath, version);
      const open = findProjectWindow(workspacePath);
      if (open) {
        // The running engine is the old one; the project has to be reopened to
        // pick up the new pin. Doing it here means the user never sees a window
        // whose title says one version and whose geometry came from another.
        open.close();
        await deps.openProject(workspacePath);
      }
      return { ok: true };
    } catch (err: any) {
      return { ok: false, error: err?.message ?? String(err) };
    }
  });
}

/**
 * The engine a project currently runs on, without opening it: its own install
 * if it has one, otherwise its pin.
 */
function currentEngineFor(workspacePath: string): ResolvedEngine | null {
  const own = projectInstalledEngine(workspacePath);
  if (own) {
    const packageRoot = path.join(workspacePath, 'node_modules', 'fluidcad');
    return {
      version: own,
      packageRoot,
      serverEntry: serverEntryFor(packageRoot),
      source: 'project',
      pin: readProjectPin(workspacePath).engine,
      unpinned: false,
    };
  }

  const pin = readProjectPin(workspacePath).engine;
  const installed = pin ? findEngine(pin) : builtinEngine();
  if (!installed) {
    return null;
  }
  return {
    version: installed.version,
    packageRoot: installed.packageRoot,
    serverEntry: serverEntryFor(installed.packageRoot),
    source: installed.builtin ? 'builtin' : 'cache',
    pin,
    unpinned: pin === null,
  };
}
