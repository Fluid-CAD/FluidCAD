import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';

/**
 * Lets a workspace with no `node_modules/fluidcad` of its own run against the
 * engine that is executing it.
 *
 * A model's `init.js` imports the kernel as the bare specifier `fluidcad`, and
 * Vite externalizes that (`ssr.external`) so Node loads exactly one copy —
 * Invariant 1. Node resolves bare specifiers by walking up from the *importer*,
 * which is a file in the user's project, so a project that never ran
 * `npm install` has nothing to walk up to and the model fails with "Cannot find
 * module 'fluidcad'".
 *
 * That was fine while the only way to start a server was from a project's own
 * install. The desktop shell resolves an engine from `~/.fluidcad/engines/…`
 * instead, and pinning an engine per project is the whole point of Phase 2, so
 * the engine has to be reachable without being installed into the project.
 *
 * The fix is to answer the bare specifier with **the running server's own
 * package**, and only when the workspace cannot answer it itself. So:
 *
 * - workspace has its own `fluidcad`  → nothing here fires; the workspace wins,
 *   and `lib-identity.ts` is what catches a mismatch with the running server.
 * - workspace has none                → `fluidcad` and its subpaths resolve to
 *   this server's own files, which is by construction the same copy the server
 *   imported — one lib per process, for free.
 */

/** Where `server/dist/host/engine-resolution.js` sits inside the package. */
const PACKAGE_ROOT = path.resolve(import.meta.dirname, '../../..');

/** True when `workspacePath` can resolve `fluidcad` on its own. */
function workspaceResolvesEngine(workspacePath: string): boolean {
  try {
    const requireFromWorkspace = createRequire(path.join(workspacePath, 'init.js'));
    requireFromWorkspace.resolve('fluidcad');
    return true;
  } catch {
    return false;
  }
}

/**
 * `fluidcad` and every subpath in the package's own `exports` map, pointed at
 * absolute paths inside this install. Reading the map rather than hardcoding
 * the subpaths keeps this correct as `exports` grows.
 */
function selfExportMap(): Map<string, string> {
  const links = new Map<string, string>();
  let exportsMap: Record<string, unknown>;
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(PACKAGE_ROOT, 'package.json'), 'utf8'));
    exportsMap = pkg?.exports ?? {};
  } catch {
    return links;
  }

  for (const [subpath, target] of Object.entries(exportsMap)) {
    if (typeof target !== 'string' || !subpath.startsWith('.')) {
      continue;
    }
    const specifier = subpath === '.' ? 'fluidcad' : `fluidcad/${subpath.slice(2)}`;
    const absolute = path.resolve(PACKAGE_ROOT, target);
    if (fs.existsSync(absolute)) {
      links.set(specifier, absolute);
    }
  }
  return links;
}

/**
 * The specifier → absolute-path map to apply for `workspacePath`, or null when
 * the workspace resolves the engine itself and nothing should be rewritten.
 */
export function engineSelfLinks(workspacePath: string): Map<string, string> | null {
  if (!workspacePath || workspaceResolvesEngine(workspacePath)) {
    return null;
  }
  const links = selfExportMap();
  return links.size > 0 ? links : null;
}
