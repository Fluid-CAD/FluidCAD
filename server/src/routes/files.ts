import fs from 'fs';
import path from 'path';
import { Router, type Response } from 'express';
import { listWorkspaceFiles, classifyFile } from '../files/file-tree.ts';
import { newFileContent } from '../file-kind.ts';
import { resolveWorkspaceFile, WorkspacePathError, type WorkspaceFile } from '../files/workspace-paths.ts';
import { applyImportUpdates, planImportUpdates } from '../files/import-rewriter.ts';

/**
 * File I/O for the in-page editor. With Monaco in the page there is no editor
 * host holding the buffers, so the server owns the disk — the same way it
 * already owns the engine and the source transforms.
 *
 * Every route resolves its path through {@link resolveWorkspaceFile}, which
 * refuses anything outside `WORKSPACE_PATH`.
 */

export interface FilesRouterDeps {
  workspacePath: string;
  /**
   * Render `absPath` as the current model — the HTTP equivalent of the IPC
   * `process-file` message a host would send.
   */
  openFile(absPath: string): Promise<void>;
  /**
   * The page just put `content` on disk at `absPath` (write or create). The
   * server keeps a short ledger of these so the `fluidcad serve` disk
   * watcher's echo of the same bytes is recognised as one, not as an edit.
   */
  onWrite?(absPath: string, content: string): void;
}

/** Text files only: Monaco has nothing to do with a STEP binary. */
const MAX_READ_BYTES = 8 * 1024 * 1024;

function fileInfo(file: WorkspaceFile, stat: fs.Stats) {
  return {
    path: file.relPath,
    absPath: file.absPath,
    kind: classifyFile(file.relPath),
    size: stat.size,
    mtimeMs: stat.mtimeMs,
  };
}

/** `buffers` as sent by the page: a plain map of workspace-relative path → text, anything else ignored. */
function readBuffers(raw: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
      if (typeof value === 'string') {
        out[key] = value;
      }
    }
  }
  return out;
}

/** Whether two paths name one file on disk (same device and inode). */
function isSameFile(a: string, b: string): boolean {
  try {
    const sa = fs.statSync(a);
    const sb = fs.statSync(b);
    return sa.dev === sb.dev && sa.ino === sb.ino && sa.ino !== 0;
  } catch {
    return false;
  }
}

/** Answers a thrown `WorkspacePathError` with 403 and anything else with 500. */
function respondToError(res: Response, err: unknown): void {
  if (err instanceof WorkspacePathError) {
    res.status(403).json({ error: err.message });
    return;
  }
  res.status(500).json({ error: (err as any)?.message ?? String(err) });
}

export function createFilesRouter(deps: FilesRouterDeps): Router {
  const router = Router();
  const { workspacePath } = deps;

  router.get('/files/tree', (_req, res) => {
    try {
      const { files, truncated } = listWorkspaceFiles(workspacePath);
      res.json({ workspacePath, files, truncated });
    } catch (err) {
      respondToError(res, err);
    }
  });

  router.get('/files/read', (req, res) => {
    try {
      const file = resolveWorkspaceFile(workspacePath, req.query.path);
      const stat = fs.statSync(file.absPath);
      if (!stat.isFile()) {
        res.status(400).json({ error: `Not a file: ${file.relPath}` });
        return;
      }
      if (stat.size > MAX_READ_BYTES) {
        res.status(413).json({ error: `${file.relPath} is too large to open in the editor.` });
        return;
      }
      res.json({ ...fileInfo(file, stat), content: fs.readFileSync(file.absPath, 'utf8') });
    } catch (err: any) {
      if (err?.code === 'ENOENT') {
        res.status(404).json({ error: 'File not found.' });
        return;
      }
      respondToError(res, err);
    }
  });

  router.post('/files/write', (req, res) => {
    const { content } = req.body ?? {};
    if (typeof content !== 'string') {
      res.status(400).json({ error: 'Invalid request body: content must be a string.' });
      return;
    }
    try {
      const file = resolveWorkspaceFile(workspacePath, req.body?.path);
      fs.mkdirSync(path.dirname(file.absPath), { recursive: true });
      fs.writeFileSync(file.absPath, content, 'utf8');
      deps.onWrite?.(file.absPath, content);
      res.json(fileInfo(file, fs.statSync(file.absPath)));
    } catch (err) {
      respondToError(res, err);
    }
  });

  router.post('/files/open', async (req, res) => {
    let file: WorkspaceFile;
    try {
      file = resolveWorkspaceFile(workspacePath, req.body?.path);
      if (!fs.existsSync(file.absPath)) {
        res.status(404).json({ error: 'File not found.' });
        return;
      }
    } catch (err) {
      respondToError(res, err);
      return;
    }
    // The render itself reports through the WS scene-rendered / compile-error
    // channel, exactly as the IPC path does — the route only confirms it started.
    await deps.openFile(file.absPath);
    res.json({ success: true, path: file.relPath, absPath: file.absPath });
  });

  router.post('/files/create', (req, res) => {
    const content = req.body?.content;
    if (content !== undefined && typeof content !== 'string') {
      res.status(400).json({ error: 'Invalid request body: content must be a string.' });
      return;
    }
    try {
      const file = resolveWorkspaceFile(workspacePath, req.body?.path);
      if (fs.existsSync(file.absPath)) {
        res.status(409).json({ error: `${file.relPath} already exists.` });
        return;
      }
      // A file created with no content still starts useful: an assembly
      // file gets its assembly() wrapper so inserts land inside the body.
      const initial = content || newFileContent(file.relPath);
      fs.mkdirSync(path.dirname(file.absPath), { recursive: true });
      fs.writeFileSync(file.absPath, initial, 'utf8');
      deps.onWrite?.(file.absPath, initial);
      res.json(fileInfo(file, fs.statSync(file.absPath)));
    } catch (err) {
      respondToError(res, err);
    }
  });

  /**
   * Rename (or move) a file. With `updateImports`, every workspace file that
   * imports it is re-pointed at the new name and, if it changed folders, its
   * own relative imports are re-based — see `files/import-rewriter.ts`.
   * `buffers` carries the caller's unsaved texts by workspace-relative path:
   * those are rewritten from the buffer and handed back in `imports.updated`
   * with `mtimeMs: null` instead of being written over on disk.
   *
   * Ordering is the safety story. The rewrite is *planned* (read, parsed,
   * verified in memory) before the rename, so a failure there leaves the
   * disk exactly as it was; the rename is one atomic `rename(2)` that never
   * replaces an existing file; and only then are the planned files written,
   * atomically and one by one. Whatever couldn't be rewritten is listed in
   * `imports.skipped` — the response is 200, because the rename itself did
   * happen, and the caller says which importers still name the old file.
   */
  router.post('/files/rename', async (req, res) => {
    const updateImports = req.body?.updateImports === true;
    const buffers = readBuffers(req.body?.buffers);
    let from: WorkspaceFile;
    let to: WorkspaceFile;
    try {
      from = resolveWorkspaceFile(workspacePath, req.body?.path);
      to = resolveWorkspaceFile(workspacePath, req.body?.newPath);
    } catch (err) {
      respondToError(res, err);
      return;
    }
    try {
      let stat: fs.Stats;
      try {
        stat = fs.statSync(from.absPath);
      } catch (err: any) {
        if (err?.code === 'ENOENT') {
          res.status(404).json({ error: 'File not found.' });
          return;
        }
        throw err;
      }
      if (!stat.isFile()) {
        res.status(400).json({ error: `Not a file: ${from.relPath}` });
        return;
      }
      if (from.absPath === to.absPath) {
        res.status(400).json({ error: 'The new name is the same as the old one.' });
        return;
      }
      // Never replace another file. The one exception is a case-only rename
      // on a case-insensitive filesystem, where "the destination exists"
      // means the source itself.
      if (fs.existsSync(to.absPath) && !isSameFile(from.absPath, to.absPath)) {
        res.status(409).json({ error: `${to.relPath} already exists.` });
        return;
      }

      const plan = updateImports
        ? await planImportUpdates({
            workspacePath,
            oldAbsPath: from.absPath,
            oldRelPath: from.relPath,
            newAbsPath: to.absPath,
            newRelPath: to.relPath,
            buffers,
          })
        : null;

      fs.mkdirSync(path.dirname(to.absPath), { recursive: true });
      fs.renameSync(from.absPath, to.absPath);
      // The `fluidcad serve` watcher sees the rename as a fresh model file and
      // would switch the viewport to it; the ledger lets it recognise the bytes.
      if (deps.onWrite && classifyFile(to.relPath) === 'model') {
        deps.onWrite(to.absPath, fs.readFileSync(to.absPath, 'utf8'));
      }

      const imports = plan ? applyImportUpdates(plan, deps.onWrite) : undefined;
      res.json({
        from: from.relPath,
        ...fileInfo(to, fs.statSync(to.absPath)),
        ...(imports ? { imports } : {}),
      });
    } catch (err) {
      respondToError(res, err);
    }
  });

  router.post('/files/delete', (req, res) => {
    try {
      const file = resolveWorkspaceFile(workspacePath, req.body?.path);
      const stat = fs.statSync(file.absPath);
      if (!stat.isFile()) {
        res.status(400).json({ error: `Not a file: ${file.relPath}` });
        return;
      }
      fs.unlinkSync(file.absPath);
      res.json({ success: true, path: file.relPath, absPath: file.absPath });
    } catch (err: any) {
      if (err?.code === 'ENOENT') {
        res.status(404).json({ error: 'File not found.' });
        return;
      }
      respondToError(res, err);
    }
  });

  return router;
}
