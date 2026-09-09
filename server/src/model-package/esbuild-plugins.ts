import type { Plugin } from 'esbuild';
import { getBlockedNodeModule } from '../host/blocked-imports.ts';

/**
 * Refuses the Node built-ins model scripts may not touch — the same deny
 * list the render host enforces, applied at bundle/resolve time so a packed
 * or shared model cannot smuggle one past it.
 */
export function blockNodeBuiltinsPlugin(): Plugin {
  return {
    name: 'block-node-builtins',
    setup(b) {
      b.onResolve({ filter: /.*/ }, (args) => {
        const blocked = getBlockedNodeModule(args.path);
        if (!blocked) return null;
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
