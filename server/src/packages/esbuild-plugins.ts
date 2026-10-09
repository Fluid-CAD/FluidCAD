import type { Plugin } from 'esbuild';
import { getBlockedNodeModule } from '../host/blocked-imports.ts';

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
}
