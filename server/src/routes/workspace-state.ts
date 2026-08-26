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
 * `fluidcad init`.
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

export function createWorkspaceStateRouter(workspacePath: string): Router {
  const router = Router();

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
