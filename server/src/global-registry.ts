// Global instance registry at ~/.fluidcad/instances.json — lets a single MCP
// process enumerate every running FluidCAD workspace on this machine.
//
// Read-modify-write is not crash-safe across multiple writers (we have no
// file lock), but the worst case is a dropped registry entry that the next
// successful write or stale-prune restores. Atomicity for the file itself is
// via tmp + rename.

import fs from 'fs';
import os from 'os';
import path from 'path';

export const REGISTRY_DIR_NAME = '.fluidcad';
export const REGISTRY_FILE_NAME = 'instances.json';

export type RegistryEntry = {
  workspacePath: string;
  port: number;
  pid: number;
  version: string;
  startedAt: string;
};

type RegistryFile = {
  schemaVersion: 1;
  instances: RegistryEntry[];
};

const EMPTY: RegistryFile = { schemaVersion: 1, instances: [] };

function registryDir(): string {
  return path.join(os.homedir(), REGISTRY_DIR_NAME);
}

export function registryFilePath(): string {
  return path.join(registryDir(), REGISTRY_FILE_NAME);
}

function readRaw(): RegistryFile {
  try {
    const raw = fs.readFileSync(registryFilePath(), 'utf8');
    const parsed = JSON.parse(raw);
    if (isRegistryFile(parsed)) {
      return parsed;
    }
    return EMPTY;
  } catch {
    return EMPTY;
  }
}

function writeRaw(file: RegistryFile): void {
  const dir = registryDir();
  fs.mkdirSync(dir, { recursive: true });

  const destination = registryFilePath();
  const tmp = path.join(dir, `${REGISTRY_FILE_NAME}.${process.pid}.tmp`);

  const payload = JSON.stringify(file, null, 2) + '\n';
  fs.writeFileSync(tmp, payload, { encoding: 'utf8', mode: 0o644 });
  fs.renameSync(tmp, destination);
}

/**
 * Add or replace an entry keyed by `workspacePath`. A new entry for an
 * existing workspace (second window) supersedes the prior one.
 */
export function addInstance(entry: RegistryEntry): void {
  const file = readRaw();
  const filtered = file.instances.filter((e) => e.workspacePath !== entry.workspacePath);
  filtered.push(entry);
  writeRaw({ schemaVersion: 1, instances: filtered });
}

/**
 * Remove the entry that matches both workspacePath and pid. Matching on pid
 * prevents a clean shutdown from clobbering a freshly-restarted instance.
 */
export function removeInstance(workspacePath: string, pid: number): void {
  const file = readRaw();
  const filtered = file.instances.filter(
    (e) => !(e.workspacePath === workspacePath && e.pid === pid),
  );
  if (filtered.length === file.instances.length) {
    return;
  }
  writeRaw({ schemaVersion: 1, instances: filtered });
}

/**
 * Read the registry, prune entries whose PIDs are no longer alive, and
 * persist the pruned result. Returns the live entries.
 *
 * Liveness is `process.kill(pid, 0)` — sending signal 0 doesn't deliver
 * anything but throws ESRCH if the process is gone. EPERM (running but owned
 * by another user) counts as alive.
 */
export function readInstances(): RegistryEntry[] {
  const file = readRaw();
  const alive: RegistryEntry[] = [];
  const dead: RegistryEntry[] = [];

  for (const entry of file.instances) {
    if (isPidAlive(entry.pid)) {
      alive.push(entry);
    } else {
      dead.push(entry);
    }
  }

  if (dead.length > 0) {
    try {
      writeRaw({ schemaVersion: 1, instances: alive });
    } catch {
      // Pruning is best-effort; readers still get the live set.
    }
  }

  return alive;
}

export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: any) {
    if (err && err.code === 'EPERM') {
      return true;
    }
    return false;
  }
}

function isRegistryFile(value: unknown): value is RegistryFile {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const v = value as Record<string, unknown>;
  if (v.schemaVersion !== 1 || !Array.isArray(v.instances)) {
    return false;
  }
  return v.instances.every(isRegistryEntry);
}

function isRegistryEntry(value: unknown): value is RegistryEntry {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const v = value as Record<string, unknown>;
  return (
    typeof v.workspacePath === 'string' &&
    typeof v.port === 'number' &&
    typeof v.pid === 'number' &&
    typeof v.version === 'string' &&
    typeof v.startedAt === 'string'
  );
}
