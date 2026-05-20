// Per-workspace instance discovery file at <workspace>/.fluidcad/instance.json.
//
// Written when the HTTP server is listening, deleted on graceful shutdown. A
// standalone MCP process reads this file to learn the workspace's random port
// without scanning. The on-disk format is intentionally small and stable.

import fs from 'fs';
import path from 'path';

export const INSTANCE_DIR_NAME = '.fluidcad';
export const INSTANCE_FILE_NAME = 'instance.json';

export type InstanceFile = {
  /** Schema version; bump when changing the shape. */
  schemaVersion: 1;
  /** Port the HTTP+WS server is listening on. */
  port: number;
  /** PID of the server process — used by MCP for liveness probes. */
  pid: number;
  /** Absolute path to the workspace this instance serves. */
  workspacePath: string;
  /** FluidCAD package version. */
  version: string;
  /** ISO 8601 timestamp captured when the server began listening. */
  startedAt: string;
};

function instanceDir(workspacePath: string): string {
  return path.join(workspacePath, INSTANCE_DIR_NAME);
}

export function instanceFilePath(workspacePath: string): string {
  return path.join(instanceDir(workspacePath), INSTANCE_FILE_NAME);
}

/**
 * Atomically write the instance file. Uses a PID-suffixed tmp file plus
 * `renameSync` so a concurrent reader never observes a half-written file.
 */
export function writeInstanceFile(entry: InstanceFile): void {
  const dir = instanceDir(entry.workspacePath);
  fs.mkdirSync(dir, { recursive: true });

  const destination = path.join(dir, INSTANCE_FILE_NAME);
  const tmp = path.join(dir, `${INSTANCE_FILE_NAME}.${entry.pid}.tmp`);

  const payload = JSON.stringify(entry, null, 2) + '\n';
  fs.writeFileSync(tmp, payload, { encoding: 'utf8', mode: 0o644 });
  fs.renameSync(tmp, destination);
}

/**
 * Best-effort delete; never throws. Called from SIGINT/SIGTERM and `exit`
 * handlers, where we cannot afford to interrupt shutdown over an I/O error.
 *
 * `expectedPid` guards against deleting another process's file on race —
 * e.g., a second window started for the same workspace after a crash.
 */
export function deleteInstanceFile(workspacePath: string, expectedPid: number): void {
  const file = instanceFilePath(workspacePath);
  try {
    const existing = readInstanceFile(workspacePath);
    if (existing && existing.pid !== expectedPid) {
      return;
    }
    fs.unlinkSync(file);
  } catch {
    // File missing, permissions, partial write — nothing useful to do during shutdown.
  }
}

export function readInstanceFile(workspacePath: string): InstanceFile | null {
  try {
    const raw = fs.readFileSync(instanceFilePath(workspacePath), 'utf8');
    const parsed = JSON.parse(raw);
    if (!isInstanceFile(parsed)) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function isInstanceFile(value: unknown): value is InstanceFile {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const v = value as Record<string, unknown>;
  return (
    v.schemaVersion === 1 &&
    typeof v.port === 'number' &&
    typeof v.pid === 'number' &&
    typeof v.workspacePath === 'string' &&
    typeof v.version === 'string' &&
    typeof v.startedAt === 'string'
  );
}
