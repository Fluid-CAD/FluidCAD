import { existsSync, realpathSync, statSync } from 'fs';
import { isAbsolute, relative } from 'path';
import { normalizePath } from '../normalize-path.ts';
import { ModuleClosure } from '../packages/module-closure.ts';
import { PackageRoots, type PackageLocation } from '../packages/package-roots.ts';

/**
 * Where a file a render read beside its modules lies:
 * - `missing`: no such file (a sidecar the engine looked for and did not find);
 * - `package`: a file of an installed package — the project copy's (inside
 *   the workspace, under `packages/`) or the library's — `package` naming
 *   it and `path` the file within it (POSIX);
 * - `workspace`: inside the workspace, at `path` (workspace-relative, POSIX);
 * - `node-modules`: inside the workspace's `node_modules`, at `path`;
 * - `outside`: outside the workspace.
 */
export type RenderAssetLocation =
  | { kind: 'missing' }
  | { kind: 'package'; package: PackageLocation; path: string }
  | { kind: 'workspace'; path: string }
  | { kind: 'node-modules'; path: string }
  | { kind: 'outside' };

/**
 * The files a render reads that no module import shows — a `load()`'s
 * imported `.brep` and its sidecars, a `text()`'s workspace font — as the
 * engine records them (`SceneManager.getRenderInputs`: absolute paths under
 * its root, listed whether or not they exist). What travels with a model
 * beside its module closure: a share link's tree (`collectEntryFiles`) and a
 * package archive (`PackageBuilder`) both place them by {@link locate}, and
 * word their own refusals.
 */
export class RenderAssets {
  /**
   * Where `assetAbs` lies relative to `workspace` (its real path), read
   * through symlinks like the module closure: a file linked in from beyond
   * the workspace lies outside it, whatever path the engine read it by.
   *
   * A file an installed package owns (`PackageRoots.owner`, by the path the
   * engine read it by or its real path) is the package's, wherever it lies:
   * a project copy sits inside the workspace, but its files are the
   * package's to ship, never the model's. An installed package's own
   * `load()` and `.font()` read there (`PackageAssetRoots`).
   */
  static locate(assetAbs: string, workspace: string): RenderAssetLocation {
    if (!existsSync(assetAbs)) {
      return { kind: 'missing' };
    }
    const real = realpathSync(assetAbs);
    if (!statSync(real).isFile()) {
      return { kind: 'missing' };
    }
    const owner = PackageRoots.owner(assetAbs, workspace) ?? PackageRoots.owner(real, workspace);
    if (owner) {
      return { kind: 'package', package: owner, path: RenderAssets.pathIn(owner, assetAbs, real) };
    }
    const rel = normalizePath(relative(workspace, normalizePath(real)));
    if (ModuleClosure.isOutsideWorkspace(rel) || isAbsolute(rel)) {
      return { kind: 'outside' };
    }
    if (ModuleClosure.isInNodeModules(rel)) {
      return { kind: 'node-modules', path: rel };
    }
    return { kind: 'workspace', path: rel };
  }

  /**
   * A package's file for a sentence: `packages/@acme/kit/1.0.0/fonts/x.ttf`
   * for a project copy, its path within the package for a library one.
   */
  static describePackageFile(location: Extract<RenderAssetLocation, { kind: 'package' }>): string {
    const { package: owner, path } = location;
    return owner.target === 'project' ? `${PackageRoots.PROJECT_DIR}/${owner.name}/${owner.version}/${path}` : path;
  }

  /** `file`'s path inside the package directory, by whichever spelling lies under it. */
  private static pathIn(owner: PackageLocation, ...spellings: string[]): string {
    const directory = `${owner.directory.replace(/\/+$/, '')}/`;
    for (const spelling of spellings) {
      const file = normalizePath(spelling);
      if (file.startsWith(directory)) {
        return file.slice(directory.length);
      }
    }
    return normalizePath(relative(owner.directory, normalizePath(spellings[spellings.length - 1])));
  }
}
