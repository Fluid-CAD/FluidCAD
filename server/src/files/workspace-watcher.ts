import fs from 'fs';
import path from 'path';
import chokidar, { type FSWatcher } from 'chokidar';
import { createWorkspaceIgnore } from './workspace-ignore.ts';
import { classifyFile, type FileKind } from './file-tree.ts';
import { toWorkspaceRelative } from './workspace-paths.ts';
import { normalizePath } from '../normalize-path.ts';

/**
 * Watches the workspace and reports changes to the page, so an edit made
 * outside the in-page editor — an agent writing through MCP, a `git checkout`,
 * another editor — reaches Monaco instead of being silently overwritten by the
 * next save.
 *
 * This is *not* the CLI's watcher (`bin/watcher.js`), which exists to re-render
 * the scene on an external change and keeps doing exactly that. This one only
 * announces; nothing here triggers a render.
 */

export type WorkspaceFileEventType = 'file-added' | 'file-changed' | 'file-removed';

export type WorkspaceFileEvent = {
  type: WorkspaceFileEventType;
  /** Workspace-relative, forward slashes. */
  path: string;
  absPath: string;
  kind: FileKind;
  /** Absent for `file-removed`. */
  mtimeMs?: number;
};

/** Coalesce the burst an editor's save-in-place produces into one event. */
const DEBOUNCE_MS = 100;

export interface WorkspaceWatcher {
  close(): Promise<void>;
}

export function createWorkspaceWatcher(
  workspacePath: string,
  onEvent: (event: WorkspaceFileEvent) => void,
): WorkspaceWatcher {
  const workspaceIgnore = createWorkspaceIgnore(workspacePath);
  const pending = new Map<string, { type: WorkspaceFileEventType; timer: NodeJS.Timeout }>();

  const watcher: FSWatcher = chokidar.watch(workspacePath, {
    ignoreInitial: true,
    ignored: (target: string, stats?: fs.Stats) => {
      const relPath = toWorkspaceRelative(workspacePath, target);
      if (relPath === null) {
        return false; // The root itself.
      }
      return workspaceIgnore.isIgnored(relPath, stats?.isDirectory() ?? false);
    },
  });

  function flush(absPath: string, type: WorkspaceFileEventType): void {
    const relPath = toWorkspaceRelative(workspacePath, absPath);
    if (relPath === null) {
      return;
    }
    let mtimeMs: number | undefined;
    if (type !== 'file-removed') {
      try {
        mtimeMs = fs.statSync(absPath).mtimeMs;
      } catch {
        return; // Gone again already — the removal event will speak for it.
      }
    }
    onEvent({ type, path: relPath, absPath: normalizePath(absPath), kind: classifyFile(relPath), mtimeMs });
  }

  function schedule(absPath: string, type: WorkspaceFileEventType): void {
    // A changed .gitignore changes what everything else is, so drop the cached
    // matchers before the next path is tested.
    if (path.basename(absPath) === '.gitignore') {
      workspaceIgnore.reset();
    }
    const existing = pending.get(absPath);
    if (existing) {
      clearTimeout(existing.timer);
    }
    // A remove that lands on a queued add/change wins; an add that lands on a
    // queued change is still an add as far as the page is concerned.
    const resolvedType = type === 'file-removed' || !existing ? type : existing.type;
    pending.set(absPath, {
      type: resolvedType,
      timer: setTimeout(() => {
        pending.delete(absPath);
        flush(absPath, resolvedType);
      }, DEBOUNCE_MS),
    });
  }

  watcher.on('add', (target) => schedule(target, 'file-added'));
  watcher.on('change', (target) => schedule(target, 'file-changed'));
  watcher.on('unlink', (target) => schedule(target, 'file-removed'));
  watcher.on('error', (err) => {
    console.warn(`FluidCAD workspace watcher error: ${(err as Error)?.message ?? err}`);
  });

  return {
    async close() {
      for (const { timer } of pending.values()) {
        clearTimeout(timer);
      }
      pending.clear();
      await watcher.close();
    },
  };
}
