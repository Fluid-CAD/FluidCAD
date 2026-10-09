import fs from 'fs';
import path from 'path';
import { normalizePath } from '../normalize-path.ts';
import { FluidcadHome } from '../fluidcad-home.ts';
import { loadPreferencesSync } from '../preferences.ts';
import { PackageName } from './package-name.ts';
import { PackageLayout } from './package-manifest.ts';
import { PackageScratch } from './package-scratch.ts';
import { Semver } from './semver.ts';

/** Where a package is installed: the user library, or a project's own copy. */
export type PackageTarget = 'library' | 'project';

export const PACKAGE_TARGETS: readonly PackageTarget[] = ['library', 'project'];

/** One of the directories packages install under. */
export type PackageRootDir = {
  target: PackageTarget;
  /** `<project>/packages`, or the user library. */
  root: string;
};

/** An installed package directory, `<root>/@scope/name/<version>/`. */
export type PackageLocation = PackageRootDir & {
  name: string;
  version: string;
  directory: string;
};

/**
 * Where installed packages live (research §3, K6), and the one test of
 * whether a directory is one.
 *
 * - **The user library** is resolved, first match wins: `FLUIDCAD_PACKAGES`
 *   (CI and E2E isolation), the `packageLibraryPath` preference, then
 *   `$FLUIDCAD_HOME/packages`, then the home directory's
 *   `~/.fluidcad/packages`. It is never hard-coded anywhere else.
 * - **The project copy** is `<project>/packages`, optional, a visible
 *   folder committed with the project. It wins over the library.
 *
 * A package root is recognised by **location plus marker**: a
 * `<root>/@scope/name/<version>/` directory under one of those roots that
 * holds `manifest.json`. The marker alone makes nothing special — a fork
 * copied to `vendor/gears/` with its `manifest.json` is ordinary workspace
 * code — and the open workspace's root is never a package root. The rest
 * of a user's own `packages/` folder stays ordinary workspace code too.
 */
export class PackageRoots {
  /** The project copy's folder, next to the project's `fluidcad.json`. */
  static readonly PROJECT_DIR = 'packages';

  private static readonly verdicts = new Set<string>();
  private static readonly realPaths = new Map<string, string>();
  private static libraryPreference: string | null | undefined;

  static isTarget(value: unknown): value is PackageTarget {
    return (PACKAGE_TARGETS as readonly unknown[]).includes(value);
  }

  /** The user library, resolved as the class comment says. */
  static libraryPath(): string {
    const override = process.env.FLUIDCAD_PACKAGES;
    if (override) {
      return PackageRoots.canonical(override);
    }
    const preferred = PackageRoots.preferredLibrary();
    if (preferred) {
      return PackageRoots.canonical(preferred);
    }
    return PackageRoots.canonical(FluidcadHome.file('packages'));
  }

  /** `<project>/packages`. */
  static projectCopyPath(project: string): string {
    return PackageRoots.canonical(path.join(project, PackageRoots.PROJECT_DIR));
  }

  /** The root a target installs into; the project copy needs a project. */
  static rootFor(target: PackageTarget, project?: string | null): string {
    if (target === 'library') {
      return PackageRoots.libraryPath();
    }
    if (!project) {
      throw new Error('A project copy needs an open project.');
    }
    return PackageRoots.projectCopyPath(project);
  }

  /** The roots a project resolves packages from, in order: its own copy first, then the library. */
  static rootsFor(project?: string | null): PackageRootDir[] {
    const roots: PackageRootDir[] = [];
    if (project) {
      roots.push({ target: 'project', root: PackageRoots.projectCopyPath(project) });
    }
    roots.push({ target: 'library', root: PackageRoots.libraryPath() });
    return roots;
  }

  /** `<root>/@scope/name/<version>`. */
  static packageDir(root: string, name: string, version: string): string {
    if (!PackageName.isValid(name)) {
      throw new Error(`${JSON.stringify(name)} is not a package name: ${PackageName.RULE}.`);
    }
    return normalizePath(path.join(root, ...name.split('/'), version));
  }

  /**
   * True for an installed package directory: `<root>/@scope/name/<version>/`
   * under one of {@link rootsFor}(`project`), holding `manifest.json`. The
   * walks, the editor tree, the watcher and the read-only guard all ask
   * this, and only this.
   *
   * A yes is cached by path (the installer calls {@link forget} after it
   * changes a root); a no is not, so a package another process installs
   * while this one runs — `fluidcad install` beside a running engine — is
   * seen on the next question. Only directories shaped like a package root
   * under a root ever reach the disk check, so a no costs one `stat`.
   */
  static isPackageRoot(dir: string, project?: string | null): boolean {
    const target = PackageRoots.canonical(dir);
    const key = `${project ?? ''}\u0000${target}`;
    if (PackageRoots.verdicts.has(key)) {
      return true;
    }
    const verdict = PackageRoots.judge(target, project ?? null);
    if (verdict) {
      PackageRoots.verdicts.add(key);
    }
    return verdict;
  }

  /**
   * The installed package `file` (or directory) is inside, or null. Only
   * the one directory three levels below each root can be a package root,
   * so this is string work until that candidate is asked.
   */
  static containing(file: string, project?: string | null): PackageLocation | null {
    const target = PackageRoots.canonical(file);
    for (const { target: kind, root } of PackageRoots.rootsFor(project)) {
      for (const spelling of PackageRoots.spellings(root)) {
        if (!target.startsWith(`${spelling}/`)) {
          continue;
        }
        const segments = target.slice(spelling.length + 1).split('/');
        if (segments.length < 3) {
          continue;
        }
        const directory = `${spelling}/${segments.slice(0, 3).join('/')}`;
        if (PackageRoots.isPackageRoot(directory, project)) {
          return { target: kind, root: spelling, name: `${segments[0]}/${segments[1]}`, version: segments[2], directory };
        }
      }
    }
    return null;
  }

  /**
   * The installed package that owns `file`: the one guard every edit asks
   * before it writes (K8). Installed packages are immutable, so an edit
   * aimed at one of their files is refused with
   * {@link PackageRoots.readOnlySentence}. Same answer as
   * {@link containing}: location plus marker, so a fork elsewhere in the
   * workspace is never claimed.
   */
  static owner(file: string, project?: string | null): PackageLocation | null {
    return PackageRoots.containing(file, project);
  }

  /**
   * The K8 refusal of an edit aimed at `file`, inside `location`:
   * "`parts/spur.part.js` belongs to `@acme/gears` 1.2.0 and is read-only."
   */
  static readOnlySentence(location: PackageLocation, file: string): string {
    const target = PackageRoots.canonical(file);
    const inside = target.startsWith(`${location.directory}/`) ? target.slice(location.directory.length + 1) : null;
    const what = inside ? `\`${inside}\`` : 'This file';
    return `${what} belongs to \`${location.name}\` ${location.version} and is read-only.`;
  }

  /**
   * True for anything the installer owns inside a root: an installed
   * package's files, and the root's scratch (`<root>/.tmp`, where archives
   * are extracted and removed packages step aside). The workspace walks,
   * the editor tree and the watcher prune exactly these.
   */
  static isManaged(file: string, project?: string | null): boolean {
    const target = PackageRoots.canonical(file);
    for (const { root } of PackageRoots.rootsFor(project)) {
      for (const spelling of PackageRoots.spellings(root)) {
        const scratch = `${spelling}/${PackageScratch.DIR_NAME}`;
        if (target === scratch || target.startsWith(`${scratch}/`)) {
          return true;
        }
      }
    }
    return PackageRoots.containing(target, project) !== null;
  }

  /** Where `name@version` is installed for `project`: the project copy first, then the library; null when neither has it. */
  static locate(name: string, version: string, project?: string | null): PackageLocation | null {
    for (const { target, root } of PackageRoots.rootsFor(project)) {
      const directory = PackageRoots.packageDir(root, name, version);
      if (PackageRoots.isPackageRoot(directory, project)) {
        return { target, root, name, version, directory };
      }
    }
    return null;
  }

  /** Every installed package under one root, sorted by name, then by version precedence. */
  static installedIn(rootDir: PackageRootDir, project?: string | null): PackageLocation[] {
    const found: PackageLocation[] = [];
    for (const scope of PackageRoots.subdirectories(rootDir.root)) {
      if (!scope.startsWith('@')) {
        continue;
      }
      for (const bare of PackageRoots.subdirectories(path.join(rootDir.root, scope))) {
        const name = `${scope}/${bare}`;
        if (!PackageName.isValid(name)) {
          continue;
        }
        for (const version of PackageRoots.subdirectories(path.join(rootDir.root, scope, bare))) {
          const directory = PackageRoots.packageDir(rootDir.root, name, version);
          if (PackageRoots.isPackageRoot(directory, project)) {
            found.push({ ...rootDir, name, version, directory });
          }
        }
      }
    }
    return found.sort((a, b) =>
      a.name === b.name ? Semver.compare(Semver.parse(a.version)!, Semver.parse(b.version)!) : a.name < b.name ? -1 : 1);
  }

  /**
   * Why `value` can't be the library folder, or null when it can: absolute,
   * and either an existing directory (writable, or at least readable for a
   * read-only team share) or a path whose nearest existing parent is a
   * writable directory, so the first install can create it. Nothing is
   * created here.
   */
  static checkLibraryPath(value: string): string | null {
    if (!path.isAbsolute(value)) {
      return `The library folder must be an absolute path, not ${JSON.stringify(value)}.`;
    }
    const target = path.resolve(value);
    let stat: fs.Stats | null = null;
    try {
      stat = fs.statSync(target);
    } catch {
      stat = null;
    }
    if (stat) {
      if (!stat.isDirectory()) {
        return `${target} is a file, not a folder.`;
      }
      if (!PackageRoots.canAccess(target, fs.constants.R_OK)) {
        return `${target} can't be read.`;
      }
      return null;
    }
    let parent = path.dirname(target);
    for (;;) {
      try {
        const parentStat = fs.statSync(parent);
        if (!parentStat.isDirectory()) {
          return `${target} can't be created: ${parent} is a file.`;
        }
        if (!PackageRoots.canAccess(parent, fs.constants.W_OK)) {
          return `${target} can't be created: ${parent} isn't writable.`;
        }
        return null;
      } catch {
        const next = path.dirname(parent);
        if (next === parent) {
          return `${target} can't be created.`;
        }
        parent = next;
      }
    }
  }

  /** Drop every cached verdict and the cached preference: a root, or the library setting, changed. */
  static forget(): void {
    PackageRoots.forgetInstalled();
    PackageRoots.libraryPreference = undefined;
  }

  /**
   * Drop the cached verdicts only, keeping the library preference: what a
   * render does before it resolves, so a package another process removed
   * (`fluidcad remove` beside a running engine) reads as missing at once.
   */
  static forgetInstalled(): void {
    PackageRoots.verdicts.clear();
    PackageRoots.realPaths.clear();
  }

  private static judge(target: string, project: string | null): boolean {
    if (project && PackageRoots.spellings(PackageRoots.canonical(project)).includes(target)) {
      return false;
    }
    const version = path.posix.basename(target);
    const nameDir = path.posix.dirname(target);
    const scopeDir = path.posix.dirname(nameDir);
    const root = path.posix.dirname(scopeDir);
    const name = `${path.posix.basename(scopeDir)}/${path.posix.basename(nameDir)}`;
    if (!PackageName.isValid(name) || !Semver.isValid(version)) {
      return false;
    }
    const underARoot = PackageRoots.rootsFor(project).some(({ root: candidate }) => {
      const spellings = PackageRoots.spellings(candidate);
      return spellings.includes(root) || spellings.includes(PackageRoots.real(root));
    });
    if (!underARoot) {
      return false;
    }
    try {
      return fs.statSync(path.join(target, PackageLayout.MANIFEST)).isFile();
    } catch {
      return false;
    }
  }

  /** The `packageLibraryPath` preference when it is set and absolute; read once until {@link forget}. */
  private static preferredLibrary(): string | null {
    if (PackageRoots.libraryPreference === undefined) {
      const value = loadPreferencesSync().packageLibraryPath;
      PackageRoots.libraryPreference = typeof value === 'string' && path.isAbsolute(value) ? value : null;
    }
    return PackageRoots.libraryPreference;
  }

  /** A root as given and with its links resolved (macOS `/var` → `/private/var`). */
  private static spellings(root: string): string[] {
    const real = PackageRoots.real(root);
    return real === root ? [root] : [root, real];
  }

  /** `dir` with its links resolved, cached until {@link forget}; `dir` itself when it doesn't exist (yet). */
  private static real(dir: string): string {
    const cached = PackageRoots.realPaths.get(dir);
    if (cached !== undefined) {
      return cached;
    }
    let real = dir;
    try {
      real = normalizePath(fs.realpathSync(dir)).replace(/\/+$/, '');
    } catch {
      // Not there yet: nothing under it can be a package root, and an
      // uncached miss lets the root's creation be seen.
      return dir;
    }
    PackageRoots.realPaths.set(dir, real);
    return real;
  }

  private static canonical(dir: string): string {
    return normalizePath(path.resolve(dir)).replace(/(.)\/+$/, '$1');
  }

  private static subdirectories(dir: string): string[] {
    try {
      return fs.readdirSync(dir, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
        .map((entry) => entry.name);
    } catch {
      return [];
    }
  }

  private static canAccess(target: string, mode: number): boolean {
    try {
      fs.accessSync(target, mode);
      return true;
    } catch {
      return false;
    }
  }
}
