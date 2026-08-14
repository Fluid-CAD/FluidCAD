import fs from 'fs';
import path from 'path';
import { createWorkspaceIgnore } from './workspace-ignore.ts';
import { normalizePath } from '../normalize-path.ts';

/**
 * A flat listing of the workspace's editable files. Flat rather than nested
 * because there is no file tree in the UI — the `+` picker fuzzy-filters this
 * list (`docs/desktop/05-editor-surface-design.md`).
 */

export type FileKind =
  /** A `.fluid.js` model. Opening it changes the rendered scene. */
  | 'model'
  /** A plain source file the model may import. Editor-only. */
  | 'source'
  /** Everything else — listed, but not something the editor opens by default. */
  | 'other';

export type FileTreeEntry = {
  /** Workspace-relative, forward slashes. */
  path: string;
  /** Absolute, normalized — what `/api/files/*` and `scene-rendered` use. */
  absPath: string;
  kind: FileKind;
  size: number;
  mtimeMs: number;
};

const SOURCE_EXTENSIONS = new Set(['.js', '.mjs', '.cjs', '.json']);

/** Cap the walk so a workspace that happens to contain a huge tree can't hang the server. */
const MAX_ENTRIES = 20_000;

export function classifyFile(filePath: string): FileKind {
  if (filePath.endsWith('.fluid.js')) {
    return 'model';
  }
  return SOURCE_EXTENSIONS.has(path.extname(filePath)) ? 'source' : 'other';
}

export type ListWorkspaceFilesResult = {
  files: FileTreeEntry[];
  /** True when the walk hit {@link MAX_ENTRIES} and stopped early. */
  truncated: boolean;
};

export function listWorkspaceFiles(workspacePath: string): ListWorkspaceFilesResult {
  if (!workspacePath) {
    return { files: [], truncated: false };
  }
  // Built per call rather than cached: a `.gitignore` edit must take effect on
  // the next listing, and the walk re-reads them anyway.
  const workspaceIgnore = createWorkspaceIgnore(workspacePath);
  const files: FileTreeEntry[] = [];
  let truncated = false;

  const queue: string[] = [''];
  while (queue.length > 0 && !truncated) {
    const dirRel = queue.shift()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(path.join(workspacePath, dirRel), { withFileTypes: true });
    } catch {
      continue; // Unreadable directory — skip it rather than failing the listing.
    }

    for (const entry of entries) {
      const relPath = dirRel === '' ? entry.name : `${dirRel}/${entry.name}`;
      // Symlinked directories are skipped outright: following them risks
      // cycles and escaping the workspace, and no real project needs it.
      if (entry.isSymbolicLink()) {
        continue;
      }
      if (workspaceIgnore.isIgnored(relPath, entry.isDirectory())) {
        continue;
      }
      if (entry.isDirectory()) {
        queue.push(relPath);
        continue;
      }
      if (!entry.isFile()) {
        continue;
      }
      if (files.length >= MAX_ENTRIES) {
        truncated = true;
        break;
      }
      let stat: fs.Stats;
      try {
        stat = fs.statSync(path.join(workspacePath, relPath));
      } catch {
        continue;
      }
      files.push({
        path: relPath,
        absPath: normalizePath(path.join(workspacePath, relPath)),
        kind: classifyFile(relPath),
        size: stat.size,
        mtimeMs: stat.mtimeMs,
      });
    }
  }

  // Models first, then everything else alphabetically — the picker shows this
  // order and shouldn't have to re-sort.
  files.sort((a, b) => {
    if (a.kind !== b.kind) {
      if (a.kind === 'model') {
        return -1;
      }
      if (b.kind === 'model') {
        return 1;
      }
    }
    return a.path.localeCompare(b.path);
  });

  return { files, truncated };
}
