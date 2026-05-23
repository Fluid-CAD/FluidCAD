// Read-only access to the FluidCAD instance registry.
//
// The MCP process never writes the registry — that's owned by the server.
// We re-implement just the read path here so the MCP package doesn't depend
// on the entire server package surface.

import fs from 'fs';
import os from 'os';
import path from 'path';
import type { RegistryEntry } from './types.ts';

const REGISTRY_DIR_NAME = '.fluidcad';
const REGISTRY_FILE_NAME = 'instances.json';

export function registryFilePath(): string {
  return path.join(os.homedir(), REGISTRY_DIR_NAME, REGISTRY_FILE_NAME);
}

/**
 * Read the on-disk registry and return entries whose PID is still alive.
 *
 * Unlike the server-side `readInstances()`, this never writes back the pruned
 * set — a read-only MCP process should not modify shared global state.
 */
export function listLiveInstances(): RegistryEntry[] {
  const file = readRegistryFile();
  return file.instances.filter((entry) => isPidAlive(entry.pid));
}

export function findByWorkspace(workspacePath: string): RegistryEntry | null {
  for (const entry of listLiveInstances()) {
    if (entry.workspacePath === workspacePath) {
      return entry;
    }
  }
  return null;
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

type RegistryFile = { schemaVersion: 1; instances: RegistryEntry[] };

const EMPTY: RegistryFile = { schemaVersion: 1, instances: [] };

function readRegistryFile(): RegistryFile {
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
