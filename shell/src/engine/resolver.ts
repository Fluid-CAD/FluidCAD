import fs from 'fs';
import path from 'path';
import {
  builtinEngine,
  findEngine,
  listEngines,
  markEngineUsed,
  type InstalledEngine,
} from './cache';
import { describeEngineIncompatibility } from './compat';
import { downloadEngine, compareVersionsDescending, type DownloadOptions } from './download';
import { serverEntryFor } from './paths';
import { projectInstalledEngine, readProjectPin, writeProjectPin } from './project-pin';

/**
 * The engine resolution order, from `docs/desktop/00-architecture.md`:
 *
 *   project/node_modules/fluidcad  →  use it (respects the project's lockfile)
 *   fluidcad.json pin present      →  ~/.fluidcad/engines/<version>/
 *      …not on disk                →  download, verify sha256, extract
 *   no pin                         →  built-in engine, and write the pin
 *
 * Branch 1 preserves today's behaviour exactly: every project that already
 * works with the VS Code extension keeps working, byte for byte, because it
 * keeps running the engine its own `node_modules` holds.
 */

export type EngineSource = 'project' | 'cache' | 'builtin' | 'downloaded';

export type ResolvedEngine = {
  version: string;
  /** The `fluidcad` package. server + lib are siblings inside it (Invariant 1). */
  packageRoot: string;
  /** The file to fork. */
  serverEntry: string;
  source: EngineSource;
  /** What the project pins, before any write. */
  pin: string | null;
  /** True when this project has no pin and should be given one. */
  unpinned: boolean;
};

export class EngineResolutionError extends Error {
  constructor(message: string, readonly cause?: unknown) {
    super(message);
    this.name = 'EngineResolutionError';
  }
}

function asResolved(
  engine: InstalledEngine,
  source: EngineSource,
  pin: string | null,
  unpinned: boolean,
): ResolvedEngine {
  return {
    version: engine.version,
    packageRoot: engine.packageRoot,
    serverEntry: serverEntryFor(engine.packageRoot),
    source,
    pin,
    unpinned,
  };
}

/** The project's own install, when it has a usable one. */
function projectEngine(workspacePath: string): InstalledEngine | null {
  const packageRoot = path.join(workspacePath, 'node_modules', 'fluidcad');
  if (!fs.existsSync(serverEntryFor(packageRoot))) {
    return null;
  }
  const version = projectInstalledEngine(workspacePath);
  if (!version) {
    return null;
  }
  return {
    version,
    root: workspacePath,
    packageRoot,
    builtin: false,
    installedAt: null,
    lastUsedAt: null,
  };
}

/** The newest engine already on disk — the fallback when nothing ships built-in. */
function newestInstalled(): InstalledEngine | null {
  const engines = listEngines().sort((a, b) => compareVersionsDescending(a.version, b.version));
  return engines[0] ?? null;
}

export type ResolveOptions = DownloadOptions & {
  /** Called when a pinned engine has to be fetched, before the download starts. */
  onDownloadStart?: (version: string) => void;
};

export async function resolveEngine(
  workspacePath: string,
  options: ResolveOptions = {},
): Promise<ResolvedEngine> {
  const pin = readProjectPin(workspacePath);

  // 1 — the project's own install always wins. It is what `npm install`
  //     resolved and what the extensions already run; changing that silently
  //     would be exactly the geometry surprise the pin exists to prevent.
  const own = projectEngine(workspacePath);
  if (own) {
    markEngineUsed(own.version);
    return asResolved(own, 'project', pin.engine, pin.engine === null);
  }

  // 2 — the pin.
  if (pin.engine) {
    const incompatible = describeEngineIncompatibility(pin.engine);
    if (incompatible) {
      throw new EngineResolutionError(incompatible);
    }

    const installed = findEngine(pin.engine);
    if (installed) {
      markEngineUsed(installed.version);
      return asResolved(installed, installed.builtin ? 'builtin' : 'cache', pin.engine, false);
    }

    options.onDownloadStart?.(pin.engine);
    const downloaded = await downloadEngine(pin.engine, options);
    markEngineUsed(downloaded.version);
    return asResolved(downloaded, 'downloaded', pin.engine, false);
  }

  // 3 — no pin: the engine that ships with the app.
  const builtin = builtinEngine() ?? newestInstalled();
  if (!builtin) {
    throw new EngineResolutionError(
      'This installation has no FluidCAD engine. Reinstall the app, or open a ' +
        'project that pins a version so one can be downloaded.',
    );
  }
  markEngineUsed(builtin.version);
  return asResolved(builtin, builtin.builtin ? 'builtin' : 'cache', null, true);
}

/**
 * Give an unpinned project the pin for the engine it just opened with.
 *
 * Only for a workspace that already holds a model: opening a folder to look
 * around must not write files into it. Once there is a `.fluid.js` there, the
 * pin is a record of which kernel that geometry was authored against, which is
 * worth having before the first edit rather than after.
 */
export function pinProjectIfNeeded(workspacePath: string, engine: ResolvedEngine): string | null {
  if (!engine.unpinned || !workspaceHasModel(workspacePath)) {
    return null;
  }
  try {
    writeProjectPin(workspacePath, engine.version);
    return engine.version;
  } catch {
    // A read-only project is unusual but not fatal — it just doesn't get a pin.
    return null;
  }
}

function workspaceHasModel(workspacePath: string): boolean {
  try {
    return fs
      .readdirSync(workspacePath, { withFileTypes: true })
      .some((entry) => entry.isFile() && entry.name.endsWith('.fluid.js'));
  } catch {
    return false;
  }
}
