import fs from 'fs';
import { Router } from 'express';
import { normalizePath } from '../normalize-path.ts';

export type DirtyFileEntry = {
  /** Absolute, normalized path of the dirty file. */
  path: string;
  /** Editor-observed mtime when the file was last seen on disk, or 0 if unknown. */
  lastModifiedMs: number;
};

/**
 * Holds the set of files the editor currently considers dirty (unsaved
 * changes). The MCP source-editing tools query this before writing so a
 * remote agent never silently clobbers a user's in-flight changes.
 *
 * The set is volatile by design — it gets replaced wholesale on every
 * `editor-dirty-state` IPC and resets when the server restarts. Editors
 * resend their state on startup.
 */
export class DirtyBufferState {
  private files = new Map<string, number>();

  setDirtyFiles(paths: string[]): void {
    const next = new Map<string, number>();
    for (const p of paths) {
      const normalized = normalizePath(p);
      next.set(normalized, this.readMtime(normalized));
    }
    this.files = next;
  }

  list(): DirtyFileEntry[] {
    return Array.from(this.files, ([path, lastModifiedMs]) => ({ path, lastModifiedMs }));
  }

  isDirty(absPath: string): boolean {
    return this.files.has(normalizePath(absPath));
  }

  private readMtime(absPath: string): number {
    try {
      return fs.statSync(absPath).mtimeMs;
    } catch {
      return 0;
    }
  }
}

export function createEditorRouter(state: DirtyBufferState): Router {
  const router = Router();

  router.get('/editor/dirty-files', (_req, res) => {
    res.json(state.list());
  });

  return router;
}
