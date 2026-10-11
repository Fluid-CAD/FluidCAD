import fs from 'fs';
import path from 'path';
import { normalizePath } from '../normalize-path.ts';
import { PackageArchive } from './package-archive.ts';
import { PackageLayout, type PackageManifest } from './package-manifest.ts';
import { PackageName } from './package-name.ts';
import { PackageRoots, type PackageLocation, type PackageTarget } from './package-roots.ts';
import { PackageScratch } from './package-scratch.ts';
import { TreeHash } from './tree-hash.ts';

export type PackageInstallErrorCode =
  | 'unknown-token'
  | 'conflict'
  | 'not-a-package-folder'
  | 'not-installed'
  | 'which-version'
  | 'copy-changed'
  | 'wrong-name'
  | 'ambiguous-name';

/** A refusal of an install, copy or remove, worded for the user. */
export class PackageInstallError extends Error {
  constructor(readonly code: PackageInstallErrorCode, message: string) {
    super(message);
    this.name = 'PackageInstallError';
  }
}

/** `installed`: new; `unchanged`: the same tree was already there; `replaced`: another tree with the same version was. */
export type PackageInstallStatus = 'installed' | 'unchanged' | 'replaced';

export type PackageInstallResult = PackageLocation & { integrity: string; status: PackageInstallStatus };

/** One installed package, as the lists show it. */
export type InstalledPackage = PackageLocation & {
  /** Null when its `manifest.json` can't be read; `problem` says why. */
  manifest: PackageManifest | null;
  problem?: string;
  /** The bytes its files take. */
  bytes: number;
};

/** One package of {@link PackageInstaller.copyFolder}: copied (`installed`), already there (`unchanged`), or refused with why. */
export type PackageFolderCopy = {
  name: string;
  version: string;
  status: 'installed' | 'unchanged' | 'refused';
  error?: string;
};

export type PackageInstallOptions = {
  /** The open project: required for the `project` target. */
  project?: string | null;
  /** Replace an installed tree of the same version whose contents differ (K8: never silently). */
  replace?: boolean;
};

/** An install of an inspected archive: it goes under the public name `as` (`PackageIdentity.forInstall`). */
export type PackageInstallRequest = PackageInstallOptions & {
  /** `@acme/feature-tests`: the archive knows only its bare name, so the caller names where it goes. */
  as: string;
};

/**
 * Puts packages into the two roots (research §3) and takes them out. The
 * only code that writes inside a root:
 * - **install** renames an inspected tree into `<root>/@scope/name/<version>/`
 *   (atomic on one filesystem), under the public name its caller decided
 *   (`PackageIdentity`), and makes its files read-only (K8);
 * - **copy** is Copy into project and Add to my library: the installed tree
 *   goes through the other root's scratch, unchanged, so its hash — and
 *   with it every pin — stays valid;
 * - **remove** takes a version out;
 * - **sweep** clears what killed installs left in `<root>/.tmp`.
 *
 * Installed packages are immutable: the same version with different
 * contents is refused unless the caller explicitly replaces it, and a
 * folder at the target path that isn't an installed package (no
 * `manifest.json`) is the user's own and is never written over.
 */
export class PackageInstaller {
  /**
   * Install the archive `PackageArchive.inspect` returned `token` for, at
   * `<root>/@scope/name/<version>/` for the public name `options.as` —
   * never a name read from the archive, which holds only the author's bare
   * one. The bare part of `as` must be the archive's.
   */
  static async install(token: string, target: PackageTarget, options: PackageInstallRequest): Promise<PackageInstallResult> {
    const pending = PackageArchive.peek(token);
    if (!pending) {
      throw new PackageInstallError('unknown-token', 'That inspected package is gone (installed already, or it expired); inspect the file again.');
    }
    if (!PackageName.isValid(options.as) || PackageName.bareOf(options.as) !== pending.manifest.name) {
      throw new PackageInstallError('wrong-name', `This file is ${pending.manifest.name}, so it can't install as ${options.as}.`);
    }
    const taken = PackageArchive.take(token)!;
    try {
      const { manifest, integrity } = taken.inspection;
      return await PackageInstaller.place(taken.tree, taken.root, options.as, manifest.version, integrity, target, options);
    } finally {
      taken.scratch.dispose();
    }
  }

  /**
   * Copy an installed `name@version` into `to` from the other root: Copy
   * into project (`to: 'project'`, from the library) or Add to my library
   * (`to: 'library'`, from the project copy). The copy is re-hashed and
   * refused if it differs from the source.
   */
  static async copy(name: string, version: string, to: PackageTarget, project: string): Promise<PackageInstallResult> {
    const from: PackageTarget = to === 'project' ? 'library' : 'project';
    const source = PackageRoots.packageDir(PackageRoots.rootFor(from, project), name, version);
    if (!PackageRoots.isPackageRoot(source, project)) {
      throw new PackageInstallError('not-installed', `${name} ${version} isn't in ${PackageInstaller.describe(from)}, so there is nothing to copy.`);
    }
    return PackageInstaller.copyTree(source, name, version, to, project);
  }

  /**
   * Copy every package installed in `folder` (read as a library root:
   * `@scope/name/<version>/` holding `manifest.json`) into the library: what
   * Settings → Packages offers after the library folder changed, since a
   * change moves nothing. Each tree goes across unchanged, so every pin of it
   * stays valid; one already in the library with the same contents is
   * `unchanged`, and one there with other contents is refused on its own
   * (the others still copy).
   */
  static async copyFolder(folder: string, project?: string | null): Promise<PackageFolderCopy[]> {
    const copies: PackageFolderCopy[] = [];
    for (const location of PackageRoots.installedAt(folder)) {
      try {
        const result = await PackageInstaller.copyTree(location.directory, location.name, location.version, 'library', project ?? null);
        copies.push({ name: location.name, version: location.version, status: result.status === 'unchanged' ? 'unchanged' : 'installed' });
      } catch (err) {
        if (!(err instanceof PackageInstallError)) {
          throw err;
        }
        copies.push({ name: location.name, version: location.version, status: 'refused', error: err.message });
      }
    }
    return copies;
  }

  /** Copy the installed tree at `source` into `to`'s root through its scratch, re-hashed on the way. */
  private static async copyTree(
    source: string,
    name: string,
    version: string,
    to: PackageTarget,
    project: string | null,
  ): Promise<PackageInstallResult> {
    const sourceHash = await TreeHash.ofDirectory(source);
    const root = PackageRoots.rootFor(to, project);
    const scratch = PackageScratch.create(root);
    try {
      const tree = scratch.file('tree');
      fs.cpSync(source, tree, { recursive: true });
      const copied = await TreeHash.ofDirectory(tree);
      if (copied !== sourceHash) {
        throw new PackageInstallError('copy-changed', `The copy of ${name} ${version} came out different from the original, so nothing was copied.`);
      }
      return await PackageInstaller.place(tree, root, name, version, sourceHash, to, { project });
    } finally {
      scratch.dispose();
    }
  }

  /**
   * Take `name` out of `target`: the given version, or the only one
   * installed. Several versions and none named is refused, naming them.
   */
  static remove(name: string, version: string | null, target: PackageTarget, project?: string | null): PackageLocation {
    const root = PackageRoots.rootFor(target, project);
    let location: PackageLocation;
    if (version) {
      const directory = PackageRoots.packageDir(root, name, version);
      if (!PackageRoots.isPackageRoot(directory, project)) {
        throw new PackageInstallError('not-installed', `${name} ${version} isn't in ${PackageInstaller.describe(target)}.`);
      }
      location = { target, root, name, version, directory };
    } else {
      const versions = PackageRoots.installedIn({ target, root }, project).filter((entry) => entry.name === name);
      if (versions.length === 0) {
        throw new PackageInstallError('not-installed', `${name} isn't in ${PackageInstaller.describe(target)}.`);
      }
      if (versions.length > 1) {
        throw new PackageInstallError('which-version',
          `${name} has ${versions.map((entry) => entry.version).join(', ')} in ${PackageInstaller.describe(target)}; say which version to remove (${name}@${versions[0].version}).`);
      }
      location = versions[0];
    }

    // Out of the root in one rename, then deleted at leisure: a remove
    // interrupted halfway leaves scratch for the sweep, never half a package.
    const scratch = PackageScratch.create(root);
    try {
      fs.renameSync(location.directory, scratch.file('removed'));
    } finally {
      scratch.dispose();
      PackageRoots.forget();
    }
    PackageInstaller.pruneEmptyParents(location.directory, root, { root: target === 'project' });
    return location;
  }

  /** Every package installed in `target`, with its manifest and size. */
  static list(target: PackageTarget, project?: string | null): InstalledPackage[] {
    const root = PackageRoots.rootFor(target, project);
    return PackageRoots.installedIn({ target, root }, project).map((location): InstalledPackage => {
      const bytes = PackageInstaller.sizeOf(location.directory);
      try {
        const manifest = JSON.parse(fs.readFileSync(path.join(location.directory, PackageLayout.MANIFEST), 'utf8'));
        return { ...location, manifest, bytes };
      } catch {
        return { ...location, manifest: null, problem: `Its ${PackageLayout.MANIFEST} can't be read.`, bytes };
      }
    });
  }

  /** Clear the scratch that dead processes left in each root `project` resolves from. Returns the paths removed. */
  static sweep(project?: string | null): string[] {
    const removed: string[] = [];
    for (const { root } of PackageRoots.rootsFor(project)) {
      for (const name of PackageScratch.sweep(root)) {
        removed.push(normalizePath(path.join(PackageScratch.rootOf(root), name)));
      }
    }
    return removed;
  }

  /** "your library" / "this project": how a sentence names a target. */
  static describe(target: PackageTarget): string {
    return target === 'library' ? 'your library' : "this project's packages folder";
  }

  /**
   * Rename `tree` (whose hash is `integrity`, held in `treeRoot`'s scratch)
   * into `target`. A tree held in another root's scratch is first copied
   * into this root's, so the final rename never crosses a filesystem.
   */
  private static async place(
    tree: string,
    treeRoot: string,
    name: string,
    version: string,
    integrity: string,
    target: PackageTarget,
    options: PackageInstallOptions,
  ): Promise<PackageInstallResult> {
    const project = options.project ?? null;
    const root = PackageRoots.rootFor(target, project);
    const directory = PackageRoots.packageDir(root, name, version);
    const location: PackageLocation = { target, root, name, version, directory };

    const existing = await PackageInstaller.existing(location, project);
    if (existing === integrity) {
      return { ...location, integrity, status: 'unchanged' };
    }
    if (existing !== null && !options.replace) {
      throw PackageInstaller.conflict(location);
    }

    let staging: PackageScratch | null = null;
    let staged = tree;
    try {
      if (normalizePath(path.resolve(treeRoot)) !== root) {
        staging = PackageScratch.create(root);
        staged = staging.file('tree');
        fs.cpSync(tree, staged, { recursive: true });
      }
      fs.mkdirSync(path.dirname(directory), { recursive: true });
      if (existing !== null) {
        PackageInstaller.swap(staged, directory, root);
      } else {
        try {
          fs.renameSync(staged, directory);
        } catch (err: any) {
          if (err?.code !== 'EEXIST' && err?.code !== 'ENOTEMPTY') {
            throw err;
          }
          // Another install landed first; it is the same tree or a conflict.
          if ((await PackageInstaller.existing(location, project)) === integrity) {
            return { ...location, integrity, status: 'unchanged' };
          }
          throw PackageInstaller.conflict(location);
        }
      }
      PackageInstaller.makeReadOnly(directory);
    } finally {
      staging?.dispose();
      PackageRoots.forget();
    }
    return { ...location, integrity, status: existing !== null ? 'replaced' : 'installed' };
  }

  /**
   * The hash of what is already at `location`, or null when nothing is.
   * A folder there that isn't an installed package is the user's own.
   */
  private static async existing(location: PackageLocation, project: string | null): Promise<string | null> {
    if (!fs.existsSync(location.directory)) {
      return null;
    }
    if (!PackageRoots.isPackageRoot(location.directory, project)) {
      throw new PackageInstallError('not-a-package-folder',
        `${location.directory} already exists and isn't an installed package (it has no ${PackageLayout.MANIFEST}), so it was left alone. ` +
        'Move it away, then install again.');
    }
    try {
      return await TreeHash.ofDirectory(location.directory);
    } catch {
      // Something unhashable (a link) sits inside it: different by definition.
      return '';
    }
  }

  /** Replace `directory` with `staged`: the old tree steps aside first, and comes back if the new one can't go in. */
  private static swap(staged: string, directory: string, root: string): void {
    const aside = PackageScratch.create(root);
    try {
      const old = aside.file('replaced');
      fs.renameSync(directory, old);
      try {
        fs.renameSync(staged, directory);
      } catch (err) {
        fs.renameSync(old, directory);
        throw err;
      }
    } finally {
      aside.dispose();
    }
  }

  private static conflict(location: PackageLocation): PackageInstallError {
    return new PackageInstallError('conflict',
      `${location.name} ${location.version} is already in ${PackageInstaller.describe(location.target)} with different contents. ` +
      'An installed version never changes; replace it explicitly, or install it under a new version.');
  }

  /** Every file read-only (K8); directories stay writable so the installer can still remove the package. */
  private static makeReadOnly(dir: string): void {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const child = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        PackageInstaller.makeReadOnly(child);
      } else if (entry.isFile()) {
        fs.chmodSync(child, 0o444);
      }
    }
  }

  /**
   * Remove the `@scope/name` and `@scope` folders a remove left empty,
   * stopping at the first that still holds something (another version,
   * another package of the scope). With `root`, the root goes too once it is
   * empty: a project's `packages/` folder that held only this copy, so the
   * project no longer looks like it carries packages (a user's own file in
   * it keeps it). The library root always stays.
   */
  private static pruneEmptyParents(directory: string, root: string, options: { root?: boolean } = {}): void {
    let dir = path.dirname(directory);
    while (normalizePath(dir) !== root && normalizePath(dir).startsWith(`${root}/`)) {
      try {
        fs.rmdirSync(dir);
      } catch {
        return;
      }
      dir = path.dirname(dir);
    }
    if (options.root && normalizePath(dir) === root) {
      try {
        fs.rmdirSync(dir);
      } catch {
        // Not empty: the user's own files, or another package.
      }
    }
  }

  private static sizeOf(dir: string): number {
    let total = 0;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const child = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        total += PackageInstaller.sizeOf(child);
      } else if (entry.isFile()) {
        total += fs.statSync(child).size;
      }
    }
    return total;
  }
}
