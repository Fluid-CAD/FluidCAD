import fs from 'fs';
import os from 'os';
import path from 'path';
import { listRecentProjects } from '../projects/app-state.ts';
import { holdsProject, inspectFolder, isValidFolderName } from '../projects/scaffold.ts';
import type { FolderCheck, FolderEntry, FolderListing } from '../start/contract.ts';

/**
 * The folder picker's side on the server. A browser page cannot show the
 * operating system's folder dialog and get a real path back, so the start
 * page draws its own picker and asks here what a folder holds. The desktop
 * app has native dialogs and never calls any of this.
 */

/** A folder with more subfolders than this lists the first ones only. */
const MAX_ENTRIES = 1000;

/** Never offered: tooling folders no project lives in, and hidden ones. */
const SKIPPED = new Set(['node_modules', '__pycache__', '$RECYCLE.BIN', 'System Volume Information']);

export class FolderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FolderError';
  }
}

/** A folder that exists and can be listed, whatever it holds. */
function isReadableFolder(folder: string): boolean {
  const state = inspectFolder(folder);
  return state === 'empty' || state === 'project' || state === 'not-empty';
}

/** Where the picker opens when the page names no folder: next to the last project, else home. */
export function defaultFolder(): string {
  const recent = listRecentProjects()[0];
  const parent = recent ? path.dirname(recent.path) : null;
  return parent && isReadableFolder(parent) ? parent : os.homedir();
}

/** Where browsing can start over: `/`, or each drive that exists on Windows. */
export function fileSystemRoots(platform: NodeJS.Platform = process.platform): string[] {
  if (platform !== 'win32') {
    return ['/'];
  }
  const drives: string[] = [];
  for (let code = 'A'.charCodeAt(0); code <= 'Z'.charCodeAt(0); code++) {
    const drive = `${String.fromCharCode(code)}:\\`;
    if (fs.existsSync(drive)) {
      drives.push(drive);
    }
  }
  return drives;
}

function isFolder(entry: fs.Dirent, parent: string): boolean {
  if (entry.isDirectory()) {
    return true;
  }
  if (!entry.isSymbolicLink()) {
    return false;
  }
  try {
    return fs.statSync(path.join(parent, entry.name)).isDirectory();
  } catch {
    return false;
  }
}

function holdsProjectAt(folder: string): boolean {
  try {
    return holdsProject(fs.readdirSync(folder));
  } catch {
    return false;
  }
}

/** The subfolders of `folder`, projects marked, sorted as a file manager would. */
export function listFolder(folder: string): FolderListing {
  const resolved = path.resolve(folder);
  let dirents: fs.Dirent[];
  try {
    dirents = fs.readdirSync(resolved, { withFileTypes: true });
  } catch (err: any) {
    throw new FolderError(
      err?.code === 'ENOENT'
        ? `${resolved} does not exist.`
        : err?.code === 'ENOTDIR'
          ? `${resolved} is not a folder.`
          : `${resolved} could not be read.`,
    );
  }
  const entries: FolderEntry[] = dirents
    .filter((entry) => !entry.name.startsWith('.') && !SKIPPED.has(entry.name) && isFolder(entry, resolved))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base', numeric: true }))
    .slice(0, MAX_ENTRIES)
    .map((entry) => {
      const full = path.join(resolved, entry.name);
      return { name: entry.name, path: full, project: holdsProjectAt(full) };
    });
  const parent = path.dirname(resolved);
  return {
    path: resolved,
    project: holdsProject(dirents.map((entry) => entry.name)),
    parent: parent === resolved ? null : parent,
    home: os.homedir(),
    roots: fileSystemRoots(),
    entries,
  };
}

/** What opening `folder` would find there. */
export function checkFolder(folder: string): FolderCheck {
  const resolved = path.resolve(folder);
  return { path: resolved, state: inspectFolder(resolved) };
}

/** What creating a project named `name` inside `parent` would do. */
export function checkNewProject(parent: string, name: string): FolderCheck {
  const resolvedParent = path.resolve(parent);
  if (!isValidFolderName(name)) {
    return { path: resolvedParent, state: 'invalid-name' };
  }
  const target = path.join(resolvedParent, name);
  // The project's folder may be new, but the one it goes in must be there.
  if (!isReadableFolder(resolvedParent)) {
    return { path: target, state: 'unreadable' };
  }
  return { path: target, state: inspectFolder(target) };
}
