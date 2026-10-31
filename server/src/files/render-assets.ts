import { existsSync, realpathSync, statSync } from 'fs';
import { isAbsolute, relative } from 'path';
import { normalizePath } from '../normalize-path.ts';
import { ModuleClosure } from '../packages/module-closure.ts';

/**
 * Where a file a render read beside its modules lies:
 * - `missing`: no such file (a sidecar the engine looked for and did not find);
 * - `workspace`: inside the workspace, at `path` (workspace-relative, POSIX);
 * - `node-modules`: inside the workspace's `node_modules`, at `path`;
 * - `outside`: outside the workspace.
 */
export type RenderAssetLocation =
  | { kind: 'missing' }
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
   */
  static locate(assetAbs: string, workspace: string): RenderAssetLocation {
    if (!existsSync(assetAbs)) {
      return { kind: 'missing' };
    }
    const real = realpathSync(assetAbs);
    if (!statSync(real).isFile()) {
      return { kind: 'missing' };
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
}
