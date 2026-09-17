import fs from 'fs';
import path from 'path';

/**
 * Lets a workspace with no `node_modules/fluidcad` of its own run against the
 * engine that is executing it.
 *
 * A model imports the kernel as the bare specifier `fluidcad`. Vite
 * externalizes it (`ssr.external`) so Node loads one copy — Invariant 1 — and
 * resolves it by walking up from the importer, a file in the user's project.
 * The desktop shell runs engines from `~/.fluidcad/engines/…`, so a project
 * that never ran `npm install` has nothing to walk up to.
 *
 * Two jobs follow, kept apart on purpose:
 *
 * - Loading the model never waits on a write into the project:
 *   `EngineImportResolver` answers the runner's fetch of `fluidcad` with this
 *   package's files whenever `runtimeUsesThisEngine` says the workspace has no
 *   usable install of its own.
 * - Making the path exist is for everything else — tsserver, `npm ls`, a user
 *   looking in `node_modules`: `ensureEngineLink` plants a marked symlink to
 *   this package. When the filesystem refuses (exFAT, SMB, read-only — issue
 *   #66) that is a warning, not a failure.
 *
 * Two earlier attempts to make resolution alone do both jobs failed while
 * *looking* fine: a `resolveId` plugin returning `{ external: true }` for a
 * file id, which dev SSR ignores and inlines — a second kernel copy, split
 * singletons, breakpoints reported as compile errors; and a Node loader hook,
 * which Vite never consults because it resolves externals itself.
 *
 * The link is planted when resolution would fail *or land on a different copy
 * in an ancestor directory*. A project's own install — real or `npm link` —
 * is never touched; `lib-identity.ts` remains the arbiter there. An
 * ancestor's copy is shadowed unless it *is* this engine.
 */

/** Where `server/dist/host/engine-resolution.js` sits inside the package. */
export const ENGINE_PACKAGE_ROOT = path.resolve(import.meta.dirname, '../../..');
const PACKAGE_ROOT = ENGINE_PACKAGE_ROOT;

/** The `skipped` reason of the hub path, which has no workspace to link into. */
export const NO_WORKSPACE_REASON = 'no workspace';

/**
 * Names the sibling `fluidcad` entry as engine-managed, so the desktop shell's
 * resolver can tell it from a real install: a managed link must never win the
 * "project has its own node_modules/fluidcad" branch, or a stale link would
 * shadow the project's pin forever.
 */
export const ENGINE_LINK_MARKER = '.fluidcad-engine-link';

type ResolvedEngineCopy = {
  /** The `node_modules/fluidcad` the walk landed on. */
  root: string;
  /** True when it sits in the workspace's own `node_modules`, not an ancestor's. */
  own: boolean;
};

/**
 * The `fluidcad` that `workspacePath` resolves on its own — decided by the
 * same `node_modules` walk every resolver performs, not by
 * `createRequire().resolve()`, which also consults CJS-only global folders
 * (`$NODE_PATH`, `~/node_modules`) that Node ESM and Vite ignore.
 *
 * A `fluidcad` that isn't the kernel doesn't count: this repo's own npm
 * workspaces symlink `node_modules/fluidcad` to the VS Code extension, which
 * shares the package name. Only a root carrying `lib/dist/index.js` is an
 * engine (the same guard `lib-identity.ts` applies).
 */
function resolveEngineFrom(workspacePath: string): ResolvedEngineCopy | null {
  const start = path.resolve(workspacePath);
  let dir = start;
  for (;;) {
    const candidate = path.join(dir, 'node_modules', 'fluidcad');
    if (fs.existsSync(path.join(candidate, 'lib', 'dist', 'index.js'))) {
      return { root: candidate, own: dir === start };
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      return null;
    }
    dir = parent;
  }
}

/** True when `root` is this very package on disk, through any links. */
function isThisEngine(root: string): boolean {
  try {
    return fs.realpathSync(root) === fs.realpathSync(PACKAGE_ROOT);
  } catch {
    return false;
  }
}

export type EngineLinkResult =
  | { state: 'linked'; linkPath: string }
  /**
   * `own`: the workspace's own install stands — a real directory or an
   * `npm link` the user made, never a managed link or an ancestor's copy.
   */
  | { state: 'already-resolvable'; own: boolean }
  | { state: 'skipped'; reason: string };

/**
 * True when this engine, not a `node_modules` walk, decides what the
 * workspace's `import 'fluidcad'` loads — every case except a workspace with
 * a usable install of its own, and the hub path, which loads no workspace.
 * The link is a courtesy to other tools; this is what keeps the model loading
 * when the link cannot be made (`EngineImportResolver`).
 */
export function runtimeUsesThisEngine(link: EngineLinkResult): boolean {
  if (link.state === 'skipped' && link.reason === NO_WORKSPACE_REASON) {
    return false;
  }
  return !(link.state === 'already-resolvable' && link.own);
}

/**
 * Ensure `workspacePath` can resolve the engine, linking this server's own
 * package in when it cannot. Idempotent, and called on every server start, so
 * a link left behind by another engine version is re-pointed at the one that
 * is actually running.
 */
export function ensureEngineLink(workspacePath: string): EngineLinkResult {
  if (!workspacePath) {
    return { state: 'skipped', reason: NO_WORKSPACE_REASON }; // The hub path.
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
          return { state: 'already-resolvable', own: false };
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

  // The project's own install always stands, whatever it is. An ancestor's
  // stands only when it is this engine; another copy up the tree is shadowed
  // by the link planted below, in the project's own `node_modules`.
  const resolved = resolveEngineFrom(workspacePath);
  if (resolved && (resolved.own || isThisEngine(resolved.root))) {
    return { state: 'already-resolvable', own: resolved.own };
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
    // A read-only workspace, or a filesystem without symlinks (EPERM from
    // `symlink(2)` on exFAT, FAT32 and SMB — issue #66). The model still
    // loads through `EngineImportResolver`; only the on-disk courtesy is lost.
    return { state: 'skipped', reason: err?.message ?? String(err) };
  }
}
