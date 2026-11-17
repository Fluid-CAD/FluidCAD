import fs from 'fs';
import { Router } from 'express';
import { normalizePath } from '../normalize-path.ts';
import type { FeatureEditDispatcher } from '../edit-dispatch.ts';

export type DirtyFileEntry = {
  /** Absolute, normalized path of the dirty file. */
  path: string;
  /** Editor-observed mtime when the file was last seen on disk, or 0 if unknown. */
  lastModifiedMs: number;
};

/** The source of a dirty-state report that names none: the IPC editor host. */
export const IPC_DIRTY_SOURCE = 'ipc';

/**
 * Holds the set of files the editors currently consider dirty (unsaved
 * changes). The MCP source-editing tools query this before writing so a
 * remote agent never silently clobbers a user's in-flight changes.
 *
 * Each editor reports its own set (`source`: the IPC host, or one page's
 * WebSocket connection), replaced wholesale on every `editor-dirty-state`
 * it sends; the dirty files are their union. A page that goes away takes
 * its set with it ({@link forget}): its unsaved buffers went with the tab,
 * and must not keep refusing writes until the engine restarts. Volatile by
 * design: it resets when the server restarts, and editors resend their
 * state on startup.
 */
export class DirtyBufferState {
  private readonly sources = new Map<string, Map<string, number>>();

  setDirtyFiles(paths: string[], source: string = IPC_DIRTY_SOURCE): void {
    const next = new Map<string, number>();
    for (const p of paths) {
      const normalized = normalizePath(p);
      next.set(normalized, this.readMtime(normalized));
    }
    if (next.size === 0) {
      this.sources.delete(source);
    } else {
      this.sources.set(source, next);
    }
  }

  /** Drop what `source` reported (its editor is gone); true when it had dirty files. */
  forget(source: string): boolean {
    return this.sources.delete(source);
  }

  list(): DirtyFileEntry[] {
    const out = new Map<string, number>();
    for (const files of this.sources.values()) {
      for (const [path, lastModifiedMs] of files) {
        if (!out.has(path)) {
          out.set(path, lastModifiedMs);
        }
      }
    }
    return Array.from(out, ([path, lastModifiedMs]) => ({ path, lastModifiedMs }));
  }

  isDirty(absPath: string): boolean {
    const normalized = normalizePath(absPath);
    for (const files of this.sources.values()) {
      if (files.has(normalized)) {
        return true;
      }
    }
    return false;
  }

  private readMtime(absPath: string): number {
    try {
      return fs.statSync(absPath).mtimeMs;
    } catch {
      return 0;
    }
  }
}

export function createEditorRouter(state: DirtyBufferState, dispatcher: FeatureEditDispatcher): Router {
  const router = Router();

  router.get('/editor/dirty-files', (_req, res) => {
    res.json(state.list());
  });

  // Editor-native history. The attached editor owns the source of truth (its
  // buffer) and every UI-applied operation lands on its undo stack as one
  // edit, so undo/redo delegate to it instead of keeping a parallel history.
  for (const action of ['undo', 'redo'] as const) {
    router.post(`/editor/${action}`, async (req, res) => {
      const { filePath } = req.body ?? {};
      if (typeof filePath !== 'string' || filePath === '') {
        res.status(400).json({ error: 'Invalid request body' });
        return;
      }
      await dispatcher.dispatchAction(res, (editId) => ({ type: action, filePath, editId }));
    });
  }

  // The ack channel for hosts without an IPC pipe. An IPC host settles
  // `undo`/`redo` with the `edit-ack` message; the in-page host has the UI
  // socket for that, and this route for anything that would rather not.
  router.post('/editor/ack', (req, res) => {
    const { editId, error } = req.body ?? {};
    if (typeof editId !== 'string' || editId === '') {
      res.status(400).json({ error: 'Invalid request body' });
      return;
    }
    dispatcher.settle(editId, typeof error === 'string' && error !== '' ? error : undefined);
    res.json({ success: true });
  });

  return router;
}
