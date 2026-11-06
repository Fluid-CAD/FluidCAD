import fs from 'fs';
import path from 'path';
import { createWorkspaceIgnore } from './workspace-ignore.ts';
import { normalizePath } from '../normalize-path.ts';
import { isFluidScriptFile, isParamsFile } from '../file-kind.ts';
import { PackageRoots } from '../packages/package-roots.ts';

/**
 * A flat listing of the workspace's editable files. Flat rather than nested
 * because there is no file tree in the UI — the `+` picker fuzzy-filters this
 * list (`docs/desktop/05-editor-surface-design.md`).
 */

export type FileKind =
  /**
   * A FluidCAD script — `.part.js`, `.assembly.js`, or the legacy `.fluid.js`
   * (`file-kind.ts`). Opening it changes the rendered scene.
   */
  | 'model'
  /**
   * A plain source file the model may import. Editor-only. A `*.params.js`
   * global-parameters module is a `source` file too — the editor opens it
   * like any other module — and carries `params: true` beside its kind, so
   * every consumer that switches on the three kinds keeps working.
   */
  | 'source'
  /** Everything else — listed, but not something the editor opens by default. */
  | 'other';

export type FileTreeEntry = {
  /** Workspace-relative, forward slashes. */
  path: string;
  /** Absolute, normalized — what `/api/files/*` and `scene-rendered` use. */
  absPath: string;
  kind: FileKind;
  /** True for a `*.params.js` global-parameters module (`file-kind.ts`). */
  params?: true;
  size: number;
  mtimeMs: number;
};

const SOURCE_EXTENSIONS = new Set(['.js', '.mjs', '.cjs', '.json']);

/** Cap the walk so a workspace that happens to contain a huge tree can't hang the server. */
const MAX_ENTRIES = 20_000;

export function classifyFile(filePath: string): FileKind {
  if (isFluidScriptFile(filePath)) {
    return 'model';
  }
  return SOURCE_EXTENSIONS.has(path.extname(filePath)) ? 'source' : 'other';
}

/**
 * The `kind` of a listed file plus the params flag a `*.params.js` module
 * carries — what a {@link FileTreeEntry} and a file event spread in.
 */
export function describeFile(filePath: string): { kind: FileKind; params?: true } {
  const kind = classifyFile(filePath);
  return isParamsFile(filePath) ? { kind, params: true } : { kind };
}

export type ListWorkspaceFilesResult = {
  files: FileTreeEntry[];
  /**
   * Every directory the walk entered, workspace-relative and sorted. Listed
   * separately from `files` because an empty folder — one the `+` picker just
   * created — has no file to be inferred from.
   */
  folders: string[];
  /** True when the walk hit {@link MAX_ENTRIES} and stopped early. */
  truncated: boolean;
};

export function listWorkspaceFiles(workspacePath: string): ListWorkspaceFilesResult {
  if (!workspacePath) {
    return { files: [], folders: [], truncated: false };
  }
  // Built per call rather than cached: a `.gitignore` edit must take effect on
  // the next listing, and the walk re-reads them anyway.
  const workspaceIgnore = createWorkspaceIgnore(workspacePath);
  const files: FileTreeEntry[] = [];
  const folders: string[] = [];
  let truncated = false;
  // Folders that directly hold something listed, and folders the walk
  // pruned an installed package (or the installer's scratch) out of.
  const holdsListed = new Set<string>();
  const heldPackage = new Set<string>();

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
        if (entry.isDirectory() && PackageRoots.isManaged(path.join(workspacePath, relPath), workspacePath)) {
          heldPackage.add(dirRel);
        }
        continue;
      }
      if (entry.isDirectory()) {
        folders.push(relPath);
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
      holdsListed.add(dirRel);
      files.push({
        path: relPath,
        absPath: normalizePath(path.join(workspacePath, relPath)),
        ...describeFile(relPath),
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

  folders.sort((a, b) => a.localeCompare(b));

  return { files, folders: FileTreeFolders.withoutPackageParents(folders, holdsListed, heldPackage), truncated };
}

/**
 * The folder list without the folders that exist only to hold installed
 * packages: a project copy's `packages/@scope/name/<version>/` is pruned
 * (K8), and its `packages/@scope/name`, `packages/@scope` — and `packages`
 * itself when that is all it holds — would otherwise linger in the editor's
 * list as empty folders. A folder the user made empty, or one holding
 * anything else (their own `packages/models/`), stays.
 */
class FileTreeFolders {
  static withoutPackageParents(
    folders: string[],
    holdsListed: ReadonlySet<string>,
    heldPackage: ReadonlySet<string>,
  ): string[] {
    const kept = new Set(folders);
    // Deepest first, so a folder's verdict sees its children's.
    for (const folder of [...folders].sort((a, b) => b.split('/').length - a.split('/').length)) {
      const keptChild = [...kept].some((other) => other !== folder && other.startsWith(`${folder}/`) && !other.slice(folder.length + 1).includes('/'));
      const droppedChild = folders.some((other) => !kept.has(other) && other.startsWith(`${folder}/`) && !other.slice(folder.length + 1).includes('/'));
      if (holdsListed.has(folder) || keptChild) {
        continue;
      }
      if (heldPackage.has(folder) || droppedChild) {
        kept.delete(folder);
      }
    }
    return folders.filter((folder) => kept.has(folder));
  }
}
