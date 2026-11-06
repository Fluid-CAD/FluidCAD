import type { Plugin } from 'esbuild';
import { getBlockedNodeModule } from '../host/blocked-imports.ts';
import { PackageResolver } from './resolver.ts';

/**
 * The esbuild plugins every closure walk runs with: share-by-link's
 * source tree, the package packer, and the old model packer `fluidcad
 * publish` still uses.
 */
export class EsbuildPlugins {
  /**
   * Refuses the Node built-ins model scripts may not touch — the same deny
   * list the render host enforces, applied at bundle/resolve time so a packed
   * or shared model cannot smuggle one past it.
   */
  static blockNodeBuiltins(): Plugin {
    return {
      name: 'block-node-builtins',
      setup(b) {
        b.onResolve({ filter: /.*/ }, (args) => {
          const blocked = getBlockedNodeModule(args.path);
          if (!blocked) {
            return null;
          }
          return {
            errors: [
              {
                text:
                  `Module "${args.path}" is not allowed in FluidCAD scripts. ` +
                  `Access to Node.js "${blocked}" module is restricted for security.`,
              },
            ],
          };
        });
      },
    };
  }

  /**
   * Refuses an import of a package (`@scope/name`, any subpath): a package
   * can't depend on another package yet (packages K12), whether or not the
   * name would resolve. Runs before esbuild's own resolution, so a
   * `node_modules` copy of the name is refused the same way.
   */
  static refusePackageImports(): Plugin {
    return {
      name: 'refuse-package-imports',
      setup(b) {
        b.onResolve({ filter: /^@/ }, (args) => {
          const parsed = PackageResolver.parseSpecifier(args.path);
          if (!parsed) {
            return null;
          }
          return {
            errors: [
              {
                text:
                  `"${args.path}" is the package ${parsed.name}: ` +
                  'a package can\'t import another package yet.',
              },
            ],
          };
        });
      },
    };
  }
}
