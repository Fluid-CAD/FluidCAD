import { build, type Metafile, type Plugin } from 'esbuild';
import { normalizePath } from '../normalize-path.ts';
import { EsbuildPlugins } from './esbuild-plugins.ts';

export type ModuleClosureOptions = {
  /** The modules to start from, as specifiers relative to the workspace root (`./model.part.js`). */
  entries: string[];
  /**
   * The name the virtual module importing the entries goes by in esbuild's
   * messages. It is never a file and never listed.
   */
  wrapperName?: string;
  /** Plugins that run before the refusal of blocked Node built-ins. */
  plugins?: Plugin[];
};

/**
 * The modules a set of entries transitively imports, read off esbuild's
 * metafile: the resolution a bundler would do, without keeping the bundle.
 * `fluidcad/*` stays external (whoever loads the files links its own
 * engine) and Node built-ins the render host refuses are refused here too.
 *
 * Share-by-link carries a model's closure as a viewer link's source tree
 * ({@link collectEntryFiles}), and the package packer ships the closure of
 * a package's exports. Each caller words its own refusal of a module
 * outside the workspace or under `node_modules`; the closure only says
 * which modules those are.
 */
export class ModuleClosure {
  static readonly DEFAULT_WRAPPER = '__closure_entry__.js';

  private constructor(
    private readonly metafile: Metafile,
    private readonly wrapperName: string,
  ) {}

  /** Resolve `options.entries` from `workspaceAbs`; a resolution error rejects, as esbuild reports it. */
  static async of(workspaceAbs: string, options: ModuleClosureOptions): Promise<ModuleClosure> {
    const workspace = normalizePath(workspaceAbs);
    const wrapperName = options.wrapperName ?? ModuleClosure.DEFAULT_WRAPPER;
    const result = await build({
      stdin: {
        contents: options.entries.map((rel) => `import ${JSON.stringify(rel)};\n`).join(''),
        resolveDir: workspace,
        sourcefile: wrapperName,
        loader: 'js',
      },
      absWorkingDir: workspace,
      format: 'esm',
      bundle: true,
      write: false,
      metafile: true,
      platform: 'node',
      external: ['fluidcad', 'fluidcad/*'],
      plugins: [...(options.plugins ?? []), EsbuildPlugins.blockNodeBuiltins()],
      logLevel: 'silent',
    });
    if (result.errors.length) {
      throw new Error(result.errors.map((e) => e.text).join('\n'));
    }
    return new ModuleClosure(result.metafile, wrapperName);
  }

  /** A closure path that lies outside the workspace it was resolved from. */
  static isOutsideWorkspace(rel: string): boolean {
    return rel.startsWith('..') || rel.startsWith('/');
  }

  /** A closure path inside a `node_modules` folder: an npm dependency. */
  static isInNodeModules(rel: string): boolean {
    return rel.split('/').includes('node_modules');
  }

  /**
   * Every module reached, entries included, as workspace-relative POSIX
   * paths in esbuild's order. The virtual wrapper and external engine
   * imports are never listed.
   */
  get files(): string[] {
    return Object.keys(this.metafile.inputs)
      .filter((input) => !this.isWrapper(input))
      .map((input) => normalizePath(input));
  }

  /** The modules that import `rel` (a path {@link files} lists); the virtual wrapper is left out. */
  importersOf(rel: string): string[] {
    const importers: string[] = [];
    for (const [input, { imports }] of Object.entries(this.metafile.inputs)) {
      if (this.isWrapper(input)) {
        continue;
      }
      if (imports.some((imported) => !imported.external && normalizePath(imported.path) === rel)) {
        importers.push(normalizePath(input));
      }
    }
    return importers;
  }

  // The virtual wrapper lists itself under its sourcefile name.
  private isWrapper(input: string): boolean {
    return input === this.wrapperName || input === '<stdin>';
  }
}
