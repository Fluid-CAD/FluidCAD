import { AssetRoots, type AssetRoot } from '../../../lib/dist/io/asset-roots.js';
import { PackageRoots, type PackageLocation } from './package-roots.ts';

/**
 * Where an installed package's `load()` and `.font()` read their files: the
 * package's own directory, which ships its `imports/` and its font files
 * (pack's check 8), the way a relative import resolves against the
 * importing file. The engine asks with the file that wrote the call
 * (`AssetRoots`); this answers with the installed package that owns it —
 * `PackageRoots.owner`, location plus marker, so a project copy and a
 * library copy each read their own directory and a fork elsewhere in the
 * workspace is ordinary workspace code. Every other file reads under the
 * workspace, as it always has.
 *
 * The engine is one per process, so the source is one per process too:
 * the server installs its project's whenever it roots the engine at its
 * workspace (`FluidCadServer.rootEngine`), before every evaluation.
 */
export class PackageAssetRoots {
  /** Make `project`'s installed packages the engine's asset-root source; null removes it. */
  static install(project: string | null): void {
    AssetRoots.use(project ? (file) => PackageAssetRoots.rootOf(file, project) : null);
  }

  /** The asset root of a call written in `file`: the installed package that owns it, or null. */
  static rootOf(file: string, project: string): AssetRoot | null {
    const location = PackageRoots.owner(file, project);
    return location ? PackageAssetRoots.rootAt(location) : null;
  }

  /**
   * An installed package's directory as an asset root. A project copy is
   * keyed by its path in the project (`packages/@acme/kit/1.2.0/`), where a
   * tree that carries the project's files would hold it; a library copy is
   * in no such tree, so it has no key.
   */
  static rootAt(location: PackageLocation): AssetRoot {
    return {
      dir: location.directory,
      key: location.target === 'project' ? `${PackageRoots.PROJECT_DIR}/${location.name}/${location.version}/` : null,
      label: `${location.name}@${location.version}`,
    };
  }
}
