import fs from 'fs';
import path from 'path';
import { normalizePath } from '../normalize-path.ts';

/**
 * Path containment for the file routes. The server binds to localhost but is
 * reachable by anything on the machine, so `WORKSPACE_PATH` is a real security
 * boundary, not a convenience: every path that arrives over HTTP is resolved
 * and asserted to be inside it before any `fs` call happens.
 *
 * Symlinks are resolved before the check. A link inside the workspace pointing
 * at `/etc` would otherwise pass a purely lexical containment test.
 */

export class WorkspacePathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorkspacePathError';
  }
}

export type WorkspaceFile = {
  /** Absolute, normalized, symlink-resolved path. */
  absPath: string;
  /** Path relative to the workspace root, forward slashes, no leading `./`. */
  relPath: string;
};

/**
 * `fs.realpathSync` fails on a path that doesn't exist yet, but a create or a
 * write targets exactly that. Resolve the deepest ancestor that does exist and
 * re-attach the missing tail, so a not-yet-created file is still checked
 * against the *real* location of its parent directory.
 */
function realpathOfDeepestExisting(target: string): string {
  let current = path.resolve(target);
  const tail: string[] = [];
  for (;;) {
    try {
      return path.resolve(fs.realpathSync(current), ...tail);
    } catch {
      const parent = path.dirname(current);
      if (parent === current) {
        return path.resolve(target);
      }
      tail.unshift(path.basename(current));
      current = parent;
    }
  }
}

/**
 * Resolve a client-supplied path against the workspace root. Accepts both
 * workspace-relative and absolute paths (the UI holds absolute paths for the
 * current model, since that is what `scene-rendered` carries).
 *
 * @throws {WorkspacePathError} when the path is missing, malformed, or lands
 * outside the workspace. Callers answer these with 403.
 */
export function resolveWorkspaceFile(workspacePath: string, requested: unknown): WorkspaceFile {
  if (!workspacePath) {
    throw new WorkspacePathError('This server was started without a workspace, so it cannot serve files.');
  }
  if (typeof requested !== 'string' || requested.trim() === '') {
    throw new WorkspacePathError('A file path is required.');
  }
  if (requested.includes('\0')) {
    throw new WorkspacePathError('Invalid file path.');
  }

  const root = realpathOfDeepestExisting(workspacePath);
  const requestedAbs = path.isAbsolute(requested)
    ? path.resolve(requested)
    : path.resolve(root, requested);
  const absPath = realpathOfDeepestExisting(requestedAbs);

  const rel = path.relative(root, absPath);
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new WorkspacePathError(`Path is outside the workspace: ${requested}`);
  }

  return { absPath: normalizePath(absPath), relPath: normalizePath(rel) };
}

/**
 * The workspace-relative form of an absolute path, or null when it sits
 * outside. Lexical only — used by the watcher and the tree walk, which already
 * produce paths from inside the root.
 */
export function toWorkspaceRelative(workspacePath: string, absPath: string): string | null {
  const rel = path.relative(path.resolve(workspacePath), path.resolve(absPath));
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) {
    return null;
  }
  return normalizePath(rel);
}
