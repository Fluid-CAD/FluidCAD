import fs from 'fs';
import path from 'path';

/**
 * Lets a workspace with no `node_modules/fluidcad` of its own run against the
 * engine that is executing it.
 *
 * A model's `init.js` imports the kernel as the bare specifier `fluidcad`, and
 * Vite externalizes that (`ssr.external`) so Node loads exactly one copy —
 * Invariant 1. Resolution walks up from the *importer*, which is a file in the
 * user's project, so a project that never ran `npm install` has nothing to walk
 * up to and the model fails with "Cannot find module 'fluidcad'".
 *
 * That was fine while the only way to start a server was from a project's own
 * install. The desktop shell resolves an engine from `~/.fluidcad/engines/…`
 * instead, and pinning an engine per project is the whole point of Phase 2, so
 * the engine has to be reachable without being installed into the project.
 *
 * The fix is the boring one: **make the path exist.** When the workspace cannot
 * resolve the engine, the server links `node_modules/fluidcad` to its own
 * package root and drops a marker file naming the link as engine-managed. A
 * symlink is the only mechanism that satisfies every resolver that will ever
 * ask — Node ESM, CJS, an editor reading `jsconfig.json`, and above all
 * **Vite's own `tryNodeResolve`**, which dev SSR uses to resolve externalized
 * deps and which consults neither plugins nor Node loader hooks.
 *
 * Two cleverer mechanisms were tried first and measured to fail, in ways worth
 * recording because both *looked* like they worked (geometry rendered fine):
 *
 * - a Vite `resolveId` plugin returning `{ id: fileURL, external: true }` —
 *   dev SSR ignores the external flag for non-bare ids and **inlines** the
 *   kernel through its module runner, a second evaluation of every lib module.
 *   The singletons split: `instanceof BreakpointHit` fails, so a breakpoint
 *   reports as the compile error "FluidCAD breakpoint hit", and param
 *   overrides write to a registry nobody reads.
 * - a Node loader hook (`module.register`) answering failed resolutions —
 *   never consulted: Vite resolves externals with its own JS implementation
 *   (`fetchModule` → `tryNodeResolve`) and throws before Node is involved.
 *
 * The link is created only when resolution would otherwise fail, so a project
 * with any real install — including an npm-linked dev checkout — is never
 * touched, and `lib-identity.ts` remains the arbiter of mismatches.
 */

/** Where `server/dist/host/engine-resolution.js` sits inside the package. */
const PACKAGE_ROOT = path.resolve(import.meta.dirname, '../../..');

/**
 * Names the sibling `fluidcad` entry as engine-managed, so the desktop shell's
 * resolver can tell it from a real install: a managed link must never win the
 * "project has its own node_modules/fluidcad" branch, or a stale link would
 * shadow the project's pin forever.
 */
export const ENGINE_LINK_MARKER = '.fluidcad-engine-link';

/**
 * True when `workspacePath` can resolve `fluidcad` on its own — decided by the
 * same `node_modules` walk every resolver performs, not by
 * `createRequire().resolve()`, which also consults CJS-only global folders
 * (`$NODE_PATH`, `~/node_modules`) that Node ESM and Vite ignore.
 *
 * A `fluidcad` that isn't the kernel doesn't count: this repo's own npm
 * workspaces symlink `node_modules/fluidcad` to the VS Code extension, which
 * shares the package name. Only a root carrying `lib/dist/index.js` is an
 * engine (the same guard `lib-identity.ts` applies).
 */
function workspaceResolvesEngine(workspacePath: string): boolean {
  let dir = path.resolve(workspacePath);
  for (;;) {
    const candidate = path.join(dir, 'node_modules', 'fluidcad');
    if (fs.existsSync(path.join(candidate, 'lib', 'dist', 'index.js'))) {
      return true;
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      return false;
    }
    dir = parent;
  }
}

export type EngineLinkResult =
  | { state: 'linked'; linkPath: string }
  | { state: 'already-resolvable' }
  | { state: 'skipped'; reason: string };

/**
 * Ensure `workspacePath` can resolve the engine, linking this server's own
 * package in when it cannot. Idempotent, and called on every server start, so
 * a link left behind by another engine version is re-pointed at the one that
 * is actually running.
 */
export function ensureEngineLink(workspacePath: string): EngineLinkResult {
  if (!workspacePath) {
    return { state: 'skipped', reason: 'no workspace' }; // The hub path.
  }

  const nodeModules = path.join(workspacePath, 'node_modules');
  const linkPath = path.join(nodeModules, 'fluidcad');

  // A marked link is ours regardless of where it points. It has to be handled
  // *before* the resolvability walk: a link left behind by another engine
  // version still resolves, so the walk would report "already resolvable",
  // the stale link would stand — and the lib-identity check would then fail
  // this very startup for running against a workspace that imports the other
  // copy. Re-pointing is what makes the link follow the pin.
  if (fs.existsSync(path.join(nodeModules, ENGINE_LINK_MARKER))) {
    let managed = false;
    try {
      managed = fs.lstatSync(linkPath).isSymbolicLink();
    } catch {
      managed = false;
    }
    if (managed) {
      try {
        if (fs.realpathSync(linkPath) === fs.realpathSync(PACKAGE_ROOT)) {
          return { state: 'already-resolvable' };
        }
      } catch {
        // Dangling — replace it below like any other stale link.
      }
      try {
        fs.unlinkSync(linkPath);
        fs.symlinkSync(PACKAGE_ROOT, linkPath, 'junction');
        return { state: 'linked', linkPath };
      } catch (err: any) {
        return { state: 'skipped', reason: err?.message ?? String(err) };
      }
    }
  }

  if (workspaceResolvesEngine(workspacePath)) {
    return { state: 'already-resolvable' };
  }

  // Whatever sits there resolves nothing (the check above) — but only replace
  // it if it is a symlink. A real directory is someone's broken install, and
  // deleting their files to plant a link is not this function's call to make.
  let existing: fs.Stats | null = null;
  try {
    existing = fs.lstatSync(linkPath);
  } catch {
    existing = null;
  }
  if (existing && !existing.isSymbolicLink()) {
    return {
      state: 'skipped',
      reason: `${linkPath} exists but is not a usable fluidcad install`,
    };
  }

  try {
    fs.mkdirSync(nodeModules, { recursive: true });
    if (existing) {
      // unlink, not rm: rmSync refuses a symlink to a directory, and unlink
      // removes the link itself without ever touching what it points at.
      fs.unlinkSync(linkPath);
    }
    // A junction on Windows: directory junctions need no privileges, symlinks
    // may. Elsewhere the type argument is ignored.
    fs.symlinkSync(PACKAGE_ROOT, linkPath, 'junction');
    fs.writeFileSync(
      path.join(nodeModules, ENGINE_LINK_MARKER),
      'This fluidcad entry is a link to the running engine, maintained by the\n' +
        'FluidCAD server. Installing fluidcad with npm replaces it.\n',
    );
    return { state: 'linked', linkPath };
  } catch (err: any) {
    // A read-only workspace can't be linked into; the model will fail to
    // import with Node's own error, exactly as it did before this existed.
    return { state: 'skipped', reason: err?.message ?? String(err) };
  }
}
