import fs from 'fs';
import { PackageIntegrity } from '../packages/package-integrity.ts';
import type { PackageRoot } from '../packages/resolver.ts';

/** What a kept transform was made from: its package directory's tree hash and its own file's stat signature. */
type TransformSource = { directory: string; tree: string; file: string };

export type PackageModuleTransformsOptions = {
  /** The installed package that owns a file, or null (`PackageResolver.rootOf`: location plus marker). */
  rootOf: (file: string) => PackageRoot | null;
  /**
   * Whether the host serves a file's text from somewhere other than its
   * bytes on disk: a live editor buffer, a render overlay's code.
   */
  overridden: (file: string) => boolean;
  /** A package directory's tree hash; throws when the tree can't be read. Defaults to `PackageIntegrity.of`. */
  treeOf?: (directory: string) => string;
  /** A file's stat signature, or null when it can't be read. Defaults to size, mtime, ctime and inode. */
  fileOf?: (file: string) => string | null;
};

/**
 * Which modules of installed packages keep Vite's transform from one render
 * to the next.
 *
 * Every render evaluates every module of the model again, an installed
 * package's included (K9), and that does not change here: whatever a package
 * module's evaluation registers for a scene — the part definitions its
 * `part()` and `definePart()` calls track on the scene and the names they
 * claim, its `assembly()` and `defineAssembly()` definitions, a `unit()` or
 * top-level `param()`, the feature namespace claims and the package stamp its
 * classes take, its generated definitions, module-level shapes, the package's
 * own module state — happens on every render, from a fresh evaluation, exactly
 * as before.
 *
 * What is kept is the step before evaluation: Vite's SSR transform of the
 * file, most of what re-evaluating an installed package cost per render (F1:
 * ~42 of ~55 ms a tick for the cabinets package). A transform is a function of
 * the file's text and of the files its imports resolve to, and an installed
 * package is immutable (K8: installed read-only, its tree pinned by hash). So
 * a package module keeps its transform while all of these hold, and is
 * invalidated like any workspace module otherwise:
 * - it is a file of an installed package (location plus marker, the library
 *   or a project copy), read from disk when it was transformed and still now —
 *   never text from a live editor buffer or a render overlay;
 * - its package directory's tree hash is the one the directory had when the
 *   module was transformed — read once per render ({@link startPass}); a tree
 *   replaced in place, a file edited with its read-only bit lifted, a
 *   directory removed or reinstalled with other contents all move it;
 * - its own file is the one it was transformed from (size, mtime, ctime,
 *   inode: any write to it moves its ctime).
 *
 * Another version, or the project copy beside the library's, is another
 * directory and so other module ids: their transforms are their own. A
 * package author's workspace is not a package root: its modules are
 * workspace modules, transformed and evaluated again on every render.
 *
 * One per host (its Vite module graph). A record lives while its module's
 * transform is kept: a miss drops it, the next transform writes it again.
 */
export class PackageModuleTransforms {
  /** Per module id, what its kept transform was made from. */
  private readonly sources = new Map<string, TransformSource>();
  /** Per package directory, its tree hash this pass (null: unreadable). */
  private readonly trees = new Map<string, string | null>();
  private readonly rootOf: (file: string) => PackageRoot | null;
  private readonly overridden: (file: string) => boolean;
  private readonly treeOf: (directory: string) => string;
  private readonly fileOf: (file: string) => string | null;

  constructor(options: PackageModuleTransformsOptions) {
    this.rootOf = options.rootOf;
    this.overridden = options.overridden;
    this.treeOf = options.treeOf ?? PackageIntegrity.of;
    this.fileOf = options.fileOf ?? PackageModuleTransforms.statSignature;
  }

  /** Start a render: every package directory's tree hash is read again, once, when first asked. */
  startPass(): void {
    this.trees.clear();
  }

  /** Whether `file` (a module id, its query ignored) belongs to an installed package. */
  isPackageModule(file: string): boolean {
    return this.rootOf(PackageModuleTransforms.fileOfId(file)) !== null;
  }

  /**
   * Vite just transformed module `id`: remember what from, when it is an
   * installed package's file read from disk; forget it otherwise.
   */
  noteTransformed(id: string): void {
    const file = PackageModuleTransforms.fileOfId(id);
    const root = this.rootOf(file);
    if (!root || this.overridden(file)) {
      this.sources.delete(id);
      return;
    }
    const tree = this.treeNow(root.directory);
    const signature = this.fileOf(file);
    if (tree === null || signature === null) {
      this.sources.delete(id);
      return;
    }
    this.sources.set(id, { directory: root.directory, tree, file: signature });
  }

  /**
   * Whether module `id` keeps its transform this render (see the class
   * comment). False for every module that is not an installed package's;
   * a package module that misses loses its record.
   */
  keeps(id: string): boolean {
    const file = PackageModuleTransforms.fileOfId(id);
    const root = this.rootOf(file);
    const source = this.sources.get(id);
    if (!root || !source) {
      this.sources.delete(id);
      return false;
    }
    const kept = root.directory === source.directory
      && !this.overridden(file)
      && this.treeNow(root.directory) === source.tree
      && this.fileOf(file) === source.file;
    if (!kept) {
      this.sources.delete(id);
    }
    return kept;
  }

  /** How many module transforms are kept at the moment (diagnostics, tests). */
  size(): number {
    return this.sources.size;
  }

  private treeNow(directory: string): string | null {
    if (!this.trees.has(directory)) {
      let tree: string | null;
      try {
        tree = this.treeOf(directory);
      } catch {
        tree = null;
      }
      this.trees.set(directory, tree);
    }
    return this.trees.get(directory) ?? null;
  }

  /** A module id's file: the id without its query. */
  private static fileOfId(id: string): string {
    return id.split('?')[0];
  }

  /** `<size>:<mtime>:<ctime>:<inode>` of `file`, or null when it can't be read. */
  private static statSignature(file: string): string | null {
    try {
      const stat = fs.statSync(file);
      return `${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}:${stat.ino}`;
    } catch {
      return null;
    }
  }
}
