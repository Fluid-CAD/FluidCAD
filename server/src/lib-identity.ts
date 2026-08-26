import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';

/**
 * Guards the "one lib copy per process" invariant.
 *
 * The server imports the kernel by relative path (`../../lib/dist/index.js`),
 * while the workspace's `init.js` imports it as the bare specifier `fluidcad`,
 * resolved from the workspace. When those two land on different installs, the
 * process ends up with two copies of the library — and the param registry
 * (`lib/param-registry.ts`) and `BreakpointHit` (`lib/common/breakpoint-hit.ts`)
 * are module-scoped singletons, not globals. Two registries means parameter
 * overrides are written to one and read from the other, and `instanceof
 * BreakpointHit` returns false so breakpoints become no-ops. Nothing throws and
 * nothing is logged; the model just quietly stops responding to its own
 * parameters.
 *
 * ESM caches modules by resolved URL, so "same file on disk" and "same module
 * instance" are the same question — comparing real paths answers it without
 * importing anything.
 */

export type LibIdentityMismatch = {
  /** Package root of the library the server itself imports. */
  serverRoot: string;
  /** Package root of the library the workspace's `init.js` imports. */
  workspaceRoot: string;
  message: string;
};

function realpathOrNull(filePath: string): string | null {
  try {
    return fs.realpathSync(filePath);
  } catch {
    return null;
  }
}

/** Walk up from a resolved entry file to the directory owning its package.json. */
function packageRootOf(entry: string): string | null {
  let dir = path.dirname(entry);
  for (;;) {
    if (fs.existsSync(path.join(dir, 'package.json'))) {
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      return null;
    }
    dir = parent;
  }
}

/**
 * Compare the library the workspace resolves against the one this server
 * imports.
 *
 * Returns null when the two agree, or when the comparison can't be made — a
 * workspace with no `fluidcad` in its own `node_modules` resolves the bare
 * specifier through the same lookup the server would, so there is no second
 * copy to find and nothing to warn about.
 */
export function findLibIdentityMismatch(workspacePath: string): LibIdentityMismatch | null {
  if (!workspacePath) {
    return null;
  }

  // The same specifier `fluidcad-server.ts` imports, resolved from the same
  // directory — this file is its sibling in both `server/src` and `server/dist`.
  const serverLib = realpathOrNull(path.resolve(import.meta.dirname, '../../lib/dist/index.js'));
  if (!serverLib) {
    return null;
  }

  let workspaceEntry: string | null = null;
  try {
    // Resolve as `init.js` itself would: from the workspace root, walking up.
    const requireFromWorkspace = createRequire(path.join(workspacePath, 'init.js'));
    workspaceEntry = realpathOrNull(requireFromWorkspace.resolve('fluidcad'));
  } catch {
    return null; // Nothing installed to resolve — see the doc comment above.
  }
  if (!workspaceEntry || workspaceEntry === serverLib) {
    return null;
  }

  const serverRoot = packageRootOf(serverLib);
  const workspaceRoot = packageRootOf(workspaceEntry);
  if (!serverRoot || !workspaceRoot) {
    return null;
  }

  // The bare specifier `fluidcad` doesn't always name the kernel. This repo's
  // own npm workspaces symlink `node_modules/fluidcad` to the VS Code
  // extension, which shares the package name — resolving that is not a second
  // copy of the library, it's a different package. Only a root that actually
  // carries `lib/dist/index.js` counts, and it has to be a *different* one.
  const workspaceLib = realpathOrNull(path.join(workspaceRoot, 'lib', 'dist', 'index.js'));
  if (!workspaceLib || workspaceLib === serverLib) {
    return null;
  }

  return {
    serverRoot,
    workspaceRoot,
    message:
      'Two different copies of the fluidcad library are loaded in this process.\n' +
      `  the running server uses: ${serverRoot}\n` +
      `  this workspace imports:  ${workspaceRoot}\n` +
      'Parameter overrides and breakpoints cannot work across two copies. ' +
      "Start the server from the workspace's own install " +
      '(`npx --no-install fluidcad serve`, or the editor extension), ' +
      'or remove the duplicate install so both resolve to one root.',
  };
}
