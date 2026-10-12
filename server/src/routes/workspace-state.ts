import fs from 'fs';
import path from 'path';
import { Router } from 'express';
import { INSTANCE_DIR_NAME } from '../instance-file.ts';

/**
 * Per-workspace editor state, at `<workspace>/.fluidcad/editor-state.json`.
 *
 * Which files a user had open belongs to the project, not to the machine, so
 * it lives beside the project rather than in global preferences (where
 * `editorOpen` and `editorWidth` do belong — those describe the window, and
 * are the same whichever project is loaded).
 *
 * `.fluidcad/` already exists for instance discovery and is gitignored by
 * `fluidcad init` (`ProjectGitignore`).
 */

const STATE_FILE_NAME = 'editor-state.json';

export type WorkspaceEditorState = {
  /** Open tab paths, workspace-relative, in strip order. */
  openTabs: string[];
  /** Which of them was focused. */
  activeTab: string | null;
};

const EMPTY: WorkspaceEditorState = { openTabs: [], activeTab: null };

function stateFilePath(workspacePath: string): string {
  return path.join(workspacePath, INSTANCE_DIR_NAME, STATE_FILE_NAME);
}

export function readWorkspaceEditorState(workspacePath: string): WorkspaceEditorState {
  if (!workspacePath) {
    return { ...EMPTY };
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(stateFilePath(workspacePath), 'utf8'));
    const openTabs = Array.isArray(parsed?.openTabs)
      ? parsed.openTabs.filter((tab: unknown): tab is string => typeof tab === 'string')
      : [];
    return {
      openTabs,
      activeTab: typeof parsed?.activeTab === 'string' ? parsed.activeTab : null,
    };
  } catch {
    // Absent or unreadable — a workspace opened for the first time, which is
    // the normal case and not a problem.
    return { ...EMPTY };
  }
}

export function writeWorkspaceEditorState(workspacePath: string, state: WorkspaceEditorState): void {
  const dir = path.join(workspacePath, INSTANCE_DIR_NAME);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(stateFilePath(workspacePath), JSON.stringify(state, null, 2) + '\n');
}

/** Per-project UI choices beside the editor's tabs (`.fluidcad/ui-state.json`): each key what one surface remembers for this project. */
export type WorkspaceUiState = {
  /** Where the Hub panel's installs go in this project (its Install dropdown, H12); null until chosen. */
  hubInstallTarget: 'library' | 'project' | null;
};

/**
 * Per-project UI state, at `<workspace>/.fluidcad/ui-state.json`: choices a
 * surface keeps for this project across reloads and restarts, apart from
 * the editor's tabs (`editor-state.json`) and from the user's preferences
 * (which are the same whichever project is loaded). `.fluidcad/` holds this
 * machine's state for the project (instance discovery, the editor's tabs),
 * never the project's content, so a choice made here belongs with it.
 *
 * Every key is listed in {@link KEYS} with its check: a write names only
 * the keys it changes, and an unknown key or value is refused rather than
 * stored. A missing or unreadable file reads as the defaults.
 */
export class WorkspaceUiStateStore {
  static readonly FILE_NAME = 'ui-state.json';

  static readonly DEFAULTS: WorkspaceUiState = { hubInstallTarget: null };

  /** Each key, and the values it takes. */
  private static readonly KEYS: { [K in keyof WorkspaceUiState]: (value: unknown) => value is WorkspaceUiState[K] } = {
    hubInstallTarget: (value): value is WorkspaceUiState['hubInstallTarget'] => value === 'library' || value === 'project' || value === null,
  };

  static read(workspacePath: string): WorkspaceUiState {
    const state: WorkspaceUiState = { ...WorkspaceUiStateStore.DEFAULTS };
    if (!workspacePath) {
      return state;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(fs.readFileSync(WorkspaceUiStateStore.filePath(workspacePath), 'utf8'));
    } catch {
      return state;
    }
    for (const key of Object.keys(WorkspaceUiStateStore.KEYS) as (keyof WorkspaceUiState)[]) {
      const value = (parsed as Record<string, unknown> | null)?.[key];
      if (WorkspaceUiStateStore.KEYS[key](value)) {
        state[key] = value;
      }
    }
    return state;
  }

  /**
   * The keys `patch` names, checked, merged over what is stored and written;
   * answers the whole state. A key or value it doesn't know throws
   * {@link WorkspaceUiStateError}, and nothing is written.
   */
  static write(workspacePath: string, patch: unknown): WorkspaceUiState {
    if (typeof patch !== 'object' || patch === null || Array.isArray(patch)) {
      throw new WorkspaceUiStateError('Send an object of the keys to change.');
    }
    const state = WorkspaceUiStateStore.read(workspacePath);
    for (const [key, value] of Object.entries(patch)) {
      const check = WorkspaceUiStateStore.KEYS[key as keyof WorkspaceUiState];
      if (!check) {
        throw new WorkspaceUiStateError(`${JSON.stringify(key)} isn't a UI state key: use ${Object.keys(WorkspaceUiStateStore.KEYS).join(', ')}.`);
      }
      if (!check(value)) {
        throw new WorkspaceUiStateError(`${JSON.stringify(value)} isn't a value of ${key}.`);
      }
      (state as Record<string, unknown>)[key] = value;
    }
    const dir = path.join(workspacePath, INSTANCE_DIR_NAME);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(WorkspaceUiStateStore.filePath(workspacePath), JSON.stringify(state, null, 2) + '\n');
    return state;
  }

  static filePath(workspacePath: string): string {
    return path.join(workspacePath, INSTANCE_DIR_NAME, WorkspaceUiStateStore.FILE_NAME);
  }
}

/** A UI state write the store refused: an unknown key or value. */
export class WorkspaceUiStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorkspaceUiStateError';
  }
}

export function createWorkspaceStateRouter(workspacePath: string): Router {
  const router = Router();

  router.get('/workspace/ui-state', (_req, res) => {
    res.json(WorkspaceUiStateStore.read(workspacePath));
  });

  router.patch('/workspace/ui-state', (req, res) => {
    if (!workspacePath) {
      res.status(400).json({ error: 'This server has no workspace to store state for.' });
      return;
    }
    try {
      res.json(WorkspaceUiStateStore.write(workspacePath, req.body));
    } catch (err: any) {
      if (err instanceof WorkspaceUiStateError) {
        res.status(400).json({ error: err.message });
        return;
      }
      // Losing a remembered choice is a papercut, not a failure worth surfacing.
      res.status(500).json({ error: err?.message ?? String(err) });
    }
  });

  router.get('/workspace/editor-state', (_req, res) => {
    res.json(readWorkspaceEditorState(workspacePath));
  });

  router.post('/workspace/editor-state', (req, res) => {
    if (!workspacePath) {
      res.status(400).json({ error: 'This server has no workspace to store state for.' });
      return;
    }
    const { openTabs, activeTab } = req.body ?? {};
    if (!Array.isArray(openTabs) || openTabs.some((tab) => typeof tab !== 'string')) {
      res.status(400).json({ error: '`openTabs` must be an array of strings.' });
      return;
    }
    const state: WorkspaceEditorState = {
      openTabs,
      activeTab: typeof activeTab === 'string' ? activeTab : null,
    };
    try {
      writeWorkspaceEditorState(workspacePath, state);
      res.json(state);
    } catch (err: any) {
      // Losing tab state is a papercut, not a failure worth surfacing —
      // a read-only workspace still edits fine.
      res.status(500).json({ error: err?.message ?? String(err) });
    }
  });

  return router;
}
