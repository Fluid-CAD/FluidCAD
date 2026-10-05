import fs from 'fs';
import path from 'path';
import { holdsProject, isValidFolderName } from './scaffold.ts';

/**
 * A folder every project lives in: `npx fluidcad --projects <dir>`.
 *
 * With one, the start screen lists that folder's projects instead of the
 * recents, New Project asks for a name only (the project becomes
 * `<dir>/<name>`), and the launcher refuses every path that is not a project
 * in the folder. The refusal is the point when the start screen is reached
 * over a network: without it the page's calls list folders anywhere the
 * launcher's user can read, open any of them as a workspace, and set projects
 * up in any of them.
 *
 * A project is a *direct* subfolder of the root, so that what the start screen
 * lists and what the launcher will open are the same set. Both the lexical
 * path and the real one (symlinks followed) must sit in the root: a link in
 * the root that points elsewhere does not turn elsewhere into a project.
 */

export class ProjectsRootError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProjectsRootError';
  }
}

/** Hidden folders never hold a project the start screen shows. */
function isProjectName(name: string): boolean {
  return isValidFolderName(name) && !name.startsWith('.');
}

function realPathOrNull(folder: string): string | null {
  try {
    return fs.realpathSync.native(folder);
  } catch {
    return null;
  }
}

export class ProjectsRoot {
  /** The folder, resolved as given: what project paths are built from and shown as. */
  readonly path: string;
  /** The folder with symlinks followed: what a candidate's real place is compared against. */
  private readonly realPath: string;

  private constructor(folder: string, realPath: string) {
    this.path = folder;
    this.realPath = realPath;
  }

  /** Use `folder` as the projects root. It has to exist and be a folder that can be read. */
  static open(folder: string): ProjectsRoot {
    const resolved = path.resolve(folder);
    let stat: fs.Stats;
    try {
      stat = fs.statSync(resolved);
    } catch {
      throw new ProjectsRootError(`The projects folder ${resolved} does not exist.`);
    }
    if (!stat.isDirectory()) {
      throw new ProjectsRootError(`The projects folder ${resolved} is not a folder.`);
    }
    const realPath = realPathOrNull(resolved);
    if (realPath === null) {
      throw new ProjectsRootError(`The projects folder ${resolved} could not be read.`);
    }
    try {
      fs.readdirSync(resolved);
    } catch {
      throw new ProjectsRootError(`The projects folder ${resolved} could not be read.`);
    }
    return new ProjectsRoot(resolved, realPath);
  }

  /** Where a project named `name` lives, or would. */
  projectPath(name: string): string {
    return path.join(this.path, name);
  }

  /**
   * `candidate`, normalised, when it is a project's place in this root: a
   * direct subfolder with a name a folder can have, whether or not it exists
   * yet. Anything else is refused with a sentence.
   */
  confine(candidate: string): string {
    const resolved = path.resolve(candidate);
    const name = path.basename(resolved);
    const refuse = () => new ProjectsRootError(`${resolved} is not a project in the projects folder ${this.path}.`);
    if (!isProjectName(name) || !this.isRoot(path.dirname(resolved))) {
      throw refuse();
    }
    // A link inside the root must lead inside the root too.
    const real = realPathOrNull(resolved);
    if (real !== null && (path.basename(real) !== name || !this.isRoot(path.dirname(real)))) {
      throw refuse();
    }
    return resolved;
  }

  /** The folder `parent` is this root, by its lexical or its real path. */
  private isRoot(parent: string): boolean {
    if (parent === this.path || parent === this.realPath) {
      return true;
    }
    const real = realPathOrNull(parent);
    return real !== null && real === this.realPath;
  }

  /** The projects in the root: its subfolders that hold one, by name. */
  list(): { name: string; path: string }[] {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(this.path, { withFileTypes: true });
    } catch {
      return [];
    }
    const projects: { name: string; path: string }[] = [];
    for (const entry of entries) {
      if (!isProjectName(entry.name)) {
        continue;
      }
      const full = path.join(this.path, entry.name);
      let contents: string[];
      try {
        // The same rule as opening: a link that leads out of the root is not listed either.
        this.confine(full);
        if (!fs.statSync(full).isDirectory()) {
          continue;
        }
        contents = fs.readdirSync(full);
      } catch {
        continue;
      }
      if (holdsProject(contents)) {
        projects.push({ name: entry.name, path: full });
      }
    }
    return projects.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base', numeric: true }));
  }
}
