import os from 'os';
import path from 'path';

/**
 * Everything the shell keeps on disk lives under `~/.fluidcad`, next to the
 * `instances.json` registry the engine already writes there.
 *
 *   ~/.fluidcad/
 *     engines/
 *       index.json            ← install + last-used bookkeeping (this file's shape
 *                                is owned by cache.ts)
 *       0.0.41/
 *         node_modules/
 *           fluidcad/…        ← deliberately the same shape as a project's own
 *                                node_modules, so server + lib are siblings
 *                                by construction (Invariant 1)
 *     desktop.json            ← recent projects, window state
 *     instances.json          ← written by each engine process (server/src/global-registry.ts)
 */

export const FLUIDCAD_DIR_NAME = '.fluidcad';

export function fluidcadHome(): string {
  return process.env.FLUIDCAD_HOME
    ? path.resolve(process.env.FLUIDCAD_HOME)
    : path.join(os.homedir(), FLUIDCAD_DIR_NAME);
}

export function enginesDir(): string {
  return path.join(fluidcadHome(), 'engines');
}

/** The root a child process is pointed at: `<engines>/<version>`. */
export function engineRoot(version: string): string {
  return path.join(enginesDir(), version);
}

/** The `fluidcad` package inside an engine root. */
export function enginePackageRoot(version: string): string {
  return path.join(engineRoot(version), 'node_modules', 'fluidcad');
}

/** The file a shell forks to start an engine, given its package root. */
export function serverEntryFor(packageRoot: string): string {
  return path.join(packageRoot, 'server', 'dist', 'index.js');
}

export function engineIndexFile(): string {
  return path.join(enginesDir(), 'index.json');
}

export function desktopStateFile(): string {
  return path.join(fluidcadHome(), 'desktop.json');
}

/**
 * The registry every engine process writes on startup
 * (`server/src/global-registry.ts`), and MCP reads to find running workspaces.
 * Always the real home directory: the engine resolves it from `os.homedir()`
 * with no override, so pointing the shell somewhere else would just make the
 * shell blind to live processes.
 */
export function instancesFile(): string {
  return path.join(os.homedir(), FLUIDCAD_DIR_NAME, 'instances.json');
}

/** `<platform>-<arch>`, the key in engine tarball names and manifests. */
export function currentTarget(): string {
  return `${process.platform}-${process.arch}`;
}
