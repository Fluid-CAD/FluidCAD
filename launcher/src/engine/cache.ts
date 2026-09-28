import fs from 'fs';
import path from 'path';
import {
  enginesDir,
  engineIndexFile,
  engineRoot,
  instancesFile,
  serverEntryFor,
} from '../paths.ts';

/**
 * The on-disk engine cache: `~/.fluidcad/engines/<version>/node_modules/fluidcad`.
 *
 * The launcher's own engine is registered here as a **pre-seeded entry**, so
 * "shipped with the launcher" and "downloaded later" are the same code path
 * everywhere else. For the desktop app that is the engine bundled in
 * `resources/engine/`; for `npx fluidcad` it is the running package itself.
 */

export type InstalledEngine = {
  version: string;
  /**
   * The directory that contains `node_modules/`, which is what a copy of the
   * engine is made from (`retention.ts`). Null for the package `npx fluidcad`
   * runs from: npm owns that directory, and it is never copied.
   */
  root: string | null;
  /** The `fluidcad` package itself. server + lib are siblings inside it. */
  packageRoot: string;
  /** True for the launcher's own engine: the app's bundled one, or the CLI's package. */
  builtin: boolean;
  installedAt: string | null;
  lastUsedAt: string | null;
};

type IndexEntry = { installedAt: string; lastUsedAt: string };
type EngineIndex = { schemaVersion: 1; engines: Record<string, IndexEntry> };

const EMPTY_INDEX: EngineIndex = { schemaVersion: 1, engines: {} };

function readIndex(): EngineIndex {
  try {
    const parsed = JSON.parse(fs.readFileSync(engineIndexFile(), 'utf8'));
    if (parsed?.schemaVersion === 1 && parsed.engines && typeof parsed.engines === 'object') {
      return parsed as EngineIndex;
    }
  } catch {
    // A missing or corrupt index is not an error: the directory listing is the
    // source of truth for *what* is installed, the index only adds timestamps.
  }
  return { ...EMPTY_INDEX, engines: {} };
}

function writeIndex(index: EngineIndex): void {
  const file = engineIndexFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(index, null, 2) + '\n');
  fs.renameSync(tmp, file);
}

/**
 * Where the launcher's own engine lives, set once at startup:
 *
 * - `root`: a directory holding `node_modules/fluidcad`, the shape of every
 *   cached engine. The desktop app's bundled engine (`resources/engine`).
 * - `package`: the `fluidcad` package itself. `npx fluidcad` runs from one,
 *   wherever npm put it.
 */
export type BuiltinEngineLocation = { kind: 'root'; root: string } | { kind: 'package'; packageRoot: string };

let builtinLocation: BuiltinEngineLocation | null = null;

/** Called by the launcher that owns this process: the desktop's main, or `npx fluidcad`. Null forgets it. */
export function setBuiltinEngineLocation(location: BuiltinEngineLocation | null): void {
  builtinLocation = location;
}

/**
 * The launcher's own engine as configured, or as `FLUIDCAD_BUILTIN_ENGINE`
 * (a root) overrides it: how a dev checkout, and the tests, point the
 * launcher at an engine of their choosing.
 */
function builtinEngineLocation(): BuiltinEngineLocation | null {
  const override = process.env.FLUIDCAD_BUILTIN_ENGINE;
  if (override) {
    return { kind: 'root', root: path.resolve(override) };
  }
  return builtinLocation;
}

function readPackageVersion(packageRoot: string): string | null {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8'));
    return typeof pkg.version === 'string' ? pkg.version : null;
  } catch {
    return null;
  }
}

/**
 * An engine root is usable when it has a `fluidcad` package with a built
 * server in it — a half-extracted download has neither.
 */
export function describeEngineAt(root: string, builtin: boolean): InstalledEngine | null {
  const packageRoot = path.join(root, 'node_modules', 'fluidcad');
  if (!fs.existsSync(serverEntryFor(packageRoot))) {
    return null;
  }
  const version = readPackageVersion(packageRoot);
  if (!version) {
    return null;
  }
  const index = readIndex();
  const entry = index.engines[version];
  return {
    version,
    root,
    packageRoot,
    builtin,
    installedAt: entry?.installedAt ?? null,
    lastUsedAt: entry?.lastUsedAt ?? null,
  };
}

/** A `fluidcad` package on its own, outside any engine root. */
function describePackageAt(packageRoot: string, builtin: boolean): InstalledEngine | null {
  if (!fs.existsSync(serverEntryFor(packageRoot))) {
    return null;
  }
  const version = readPackageVersion(packageRoot);
  if (!version) {
    return null;
  }
  const entry = readIndex().engines[version];
  return {
    version,
    root: null,
    packageRoot,
    builtin,
    installedAt: entry?.installedAt ?? null,
    lastUsedAt: entry?.lastUsedAt ?? null,
  };
}

export function builtinEngine(): InstalledEngine | null {
  const location = builtinEngineLocation();
  if (!location) {
    return null;
  }
  return location.kind === 'root' ? describeEngineAt(location.root, true) : describePackageAt(location.packageRoot, true);
}

/** Every engine the launcher can start without downloading anything. */
export function listEngines(): InstalledEngine[] {
  const found: InstalledEngine[] = [];
  const builtin = builtinEngine();
  if (builtin) {
    found.push(builtin);
  }

  let entries: fs.Dirent[] = [];
  try {
    entries = fs.readdirSync(enginesDir(), { withFileTypes: true });
  } catch {
    return found;
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    // The built-in engine also exists in the cache when a project pinned that
    // version before the launcher that ships it was installed. One version, one
    // entry — and the built-in copy is the one that can't be deleted.
    if (entry.name === builtin?.version) {
      continue;
    }
    const engine = describeEngineAt(path.join(enginesDir(), entry.name), false);
    // A directory whose name doesn't match the package it holds is a cache
    // corruption, not an engine — the resolver looks up by directory name.
    if (engine && engine.version === entry.name) {
      found.push(engine);
    }
  }
  return found;
}

export function findEngine(version: string): InstalledEngine | null {
  const builtin = builtinEngine();
  if (builtin?.version === version) {
    return builtin;
  }
  const cached = describeEngineAt(engineRoot(version), false);
  return cached?.version === version ? cached : null;
}

/** Record that `version` was started, for LRU pruning and the manager UI. */
export function markEngineUsed(version: string): void {
  const index = readIndex();
  const now = new Date().toISOString();
  const existing = index.engines[version];
  index.engines[version] = { installedAt: existing?.installedAt ?? now, lastUsedAt: now };
  try {
    writeIndex(index);
  } catch {
    // Bookkeeping only — never fail an engine start over it.
  }
}

export function markEngineInstalled(version: string): void {
  const index = readIndex();
  const now = new Date().toISOString();
  index.engines[version] = { installedAt: now, lastUsedAt: now };
  try {
    writeIndex(index);
  } catch {
    // As above.
  }
}

/** Versions with a live engine process, read from the registry the engine writes. */
export function runningEngineVersions(): Set<string> {
  const versions = new Set<string>();
  let parsed: any;
  try {
    parsed = JSON.parse(fs.readFileSync(instancesFile(), 'utf8'));
  } catch {
    return versions;
  }
  for (const instance of parsed?.instances ?? []) {
    if (typeof instance?.version !== 'string' || typeof instance?.pid !== 'number') {
      continue;
    }
    try {
      process.kill(instance.pid, 0);
      versions.add(instance.version);
    } catch (err: any) {
      if (err?.code === 'EPERM') {
        versions.add(instance.version); // Alive, just not ours.
      }
    }
  }
  return versions;
}

export type RemoveResult = { removed: boolean; reason?: string };

/** Delete a cached engine. The built-in one is part of the app, not the cache. */
export function removeEngine(version: string): RemoveResult {
  const builtin = builtinEngine();
  if (builtin?.version === version) {
    return { removed: false, reason: 'That engine ships with the app and cannot be deleted.' };
  }
  if (runningEngineVersions().has(version)) {
    return { removed: false, reason: `Engine ${version} is in use by a running project.` };
  }
  const root = engineRoot(version);
  if (!fs.existsSync(root)) {
    return { removed: false, reason: `Engine ${version} is not installed.` };
  }
  fs.rmSync(root, { recursive: true, force: true });

  const index = readIndex();
  delete index.engines[version];
  try {
    writeIndex(index);
  } catch {
    // Bookkeeping only.
  }
  return { removed: true };
}

export type PruneOptions = {
  /** Never drop below this many cached engines. */
  keep?: number;
  /** Versions pinned by known projects — never pruned. */
  protectedVersions?: Iterable<string>;
};

/**
 * LRU prune with a floor. Never touches the built-in engine, a version pinned
 * by a known project, or one with a server currently running against it —
 * deleting an engine out from under a live process is how you get a CAD user
 * staring at a half-loaded model.
 */
export function pruneEngines(options: PruneOptions = {}): string[] {
  const keep = options.keep ?? 3;
  const protectedVersions = new Set(options.protectedVersions ?? []);
  for (const version of runningEngineVersions()) {
    protectedVersions.add(version);
  }

  const cached = listEngines().filter((engine) => !engine.builtin);
  const candidates = cached
    .filter((engine) => !protectedVersions.has(engine.version))
    .sort((a, b) => (a.lastUsedAt ?? '').localeCompare(b.lastUsedAt ?? ''));

  const removable = Math.max(0, cached.length - keep);
  const pruned: string[] = [];
  for (const engine of candidates.slice(0, removable)) {
    if (removeEngine(engine.version).removed) {
      pruned.push(engine.version);
    }
  }
  return pruned;
}
