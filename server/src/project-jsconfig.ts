/**
 * The `jsconfig.json` `fluidcad init` writes into a new project: what VS
 * Code's and Neovim's tsserver check the project's JavaScript with. The
 * in-page editor mirrors it (`ui/src/editor/monaco-setup.ts`).
 *
 * - `checkJs`: models and feature modules are type-checked from their
 *   JavaScript alone, the engine's declarations doing the rest.
 * - `module: node20`: ES modules as the engine loads them.
 * - `maxNodeModuleJsDepth`: how deep tsserver follows JavaScript reached
 *   through `node_modules`. A pinned package's types come from its own
 *   JavaScript, reached through the project's `node_modules/@types` shim
 *   (Stage P8, `PackageTypeShims`): the shim counts one level, a feature
 *   or part module the next, and every helper module the package's code
 *   imports one more. A jsconfig's default (2) types a package's features
 *   and parts but reads what they import from their own helpers as `any`;
 *   this leaves room for any package's own module chain.
 *
 * An existing project keeps its `jsconfig.json`: `init` never rewrites one.
 */
export class ProjectJsconfig {
  static readonly FILENAME = 'jsconfig.json';

  /** Deep enough for a package's helper modules, which the shim's one level plus the module's own leave room for. */
  static readonly MAX_NODE_MODULE_JS_DEPTH = 8;

  static readonly COMPILER_OPTIONS = {
    checkJs: true,
    module: 'node20',
    maxNodeModuleJsDepth: ProjectJsconfig.MAX_NODE_MODULE_JS_DEPTH,
  } as const;

  /** The file's text, as `init` writes it. */
  static text(): string {
    return JSON.stringify({ compilerOptions: ProjectJsconfig.COMPILER_OPTIONS }, null, 2) + '\n';
  }
}
