import fs from 'fs';
import path from 'path';
import { desktopStateFile, fluidcadHome } from './engine/paths';
import { deleteThumbnail } from './thumbnails';

/**
 * Shell-owned state: which projects were opened recently, and how big the last
 * window was. Nothing here describes a project's *contents* — where the tabs
 * were and which file was active belongs to the project and is written next to
 * it by the engine (`<workspace>/.fluidcad/editor-state.json`).
 */

export type RecentProject = {
  path: string;
  lastOpenedAt: string;
  /** Recorded so the engine manager can say what a project pins without opening it. */
  pin: string | null;
};

export type WindowBounds = { width: number; height: number; x?: number; y?: number };

export type DesktopState = {
  schemaVersion: 1;
  recentProjects: RecentProject[];
  windowBounds: WindowBounds | null;
};

const MAX_RECENTS = 12;

const EMPTY: DesktopState = { schemaVersion: 1, recentProjects: [], windowBounds: null };

export function readDesktopState(): DesktopState {
  try {
    const parsed = JSON.parse(fs.readFileSync(desktopStateFile(), 'utf8'));
    if (parsed?.schemaVersion === 1) {
      return {
        schemaVersion: 1,
        recentProjects: Array.isArray(parsed.recentProjects) ? parsed.recentProjects : [],
        windowBounds: parsed.windowBounds ?? null,
      };
    }
  } catch {
    // First run, or a file we can't read — either way, start clean.
  }
  return { ...EMPTY, recentProjects: [] };
}

function writeDesktopState(state: DesktopState): void {
  try {
    fs.mkdirSync(fluidcadHome(), { recursive: true });
    const file = desktopStateFile();
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2) + '\n');
    fs.renameSync(tmp, file);
  } catch {
    // Losing the recents list is a nuisance, never a failure.
  }
}

export function rememberProject(workspacePath: string, pin: string | null): void {
  const state = readDesktopState();
  const others = state.recentProjects.filter((entry) => entry.path !== workspacePath);
  const recents = [{ path: workspacePath, lastOpenedAt: new Date().toISOString(), pin }, ...others];
  writeDesktopState({ ...state, recentProjects: recents.slice(0, MAX_RECENTS) });
  // A project that fell off the list takes its start-screen preview with it;
  // the preview only ever exists to be shown there.
  for (const evicted of recents.slice(MAX_RECENTS)) {
    deleteThumbnail(evicted.path);
  }
}

export function forgetProject(workspacePath: string): void {
  const state = readDesktopState();
  writeDesktopState({
    ...state,
    recentProjects: state.recentProjects.filter((entry) => entry.path !== workspacePath),
  });
  deleteThumbnail(workspacePath);
}

/** Recents that still exist on disk, newest first. */
export function listRecentProjects(): RecentProject[] {
  return readDesktopState().recentProjects.filter((entry) => {
    try {
      return fs.statSync(entry.path).isDirectory();
    } catch {
      return false;
    }
  });
}

export function rememberWindowBounds(bounds: WindowBounds): void {
  writeDesktopState({ ...readDesktopState(), windowBounds: bounds });
}

/** Every engine version a known project pins — these are never LRU-pruned. */
export function pinnedVersions(): string[] {
  const versions = new Set<string>();
  for (const entry of listRecentProjects()) {
    if (entry.pin) {
      versions.add(entry.pin);
    }
  }
  return [...versions];
}

/**
 * The workspace a path belongs to: a directory is itself, a file is its
 * directory. Double-clicking `part.fluid.js` opens the folder that holds it,
 * because a FluidCAD project is a workspace, not a single file.
 */
export function workspaceForPath(target: string): string | null {
  try {
    const stat = fs.statSync(target);
    return stat.isDirectory() ? path.resolve(target) : path.dirname(path.resolve(target));
  } catch {
    return null;
  }
}
