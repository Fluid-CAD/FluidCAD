import fs from 'fs';
import path from 'path';
import { launcherInstanceFile } from '../paths.ts';

/**
 * One start server per machine user, like the desktop app's single-instance
 * lock: two would both start engines, and could open one project twice. The
 * running one writes `~/.fluidcad/launcher.json`; a second `npx fluidcad`
 * finds it, opens the browser at it, and exits.
 *
 * The record holds the sign-in link, so it is written readable by its owner
 * only.
 */

export type LauncherInstance = {
  schemaVersion: 1;
  pid: number;
  port: number;
  version: string;
  /** The start screen's URL with this session's key: what a second launch opens. */
  loginUrl: string;
  startedAt: string;
};

/** What `GET /api/launcher/health` answers; enough to tell a live start server from a stale record. */
export type LauncherHealth = { ok: true; app: 'fluidcad-launcher'; version: string; pid: number };

const HEALTH_TIMEOUT_MS = 2_000;

function isInstance(value: any): value is LauncherInstance {
  return (
    value?.schemaVersion === 1 &&
    typeof value.pid === 'number' &&
    typeof value.port === 'number' &&
    typeof value.version === 'string' &&
    typeof value.loginUrl === 'string' &&
    typeof value.startedAt === 'string'
  );
}

export function readLauncherInstance(): LauncherInstance | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(launcherInstanceFile(), 'utf8'));
    return isInstance(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function writeLauncherInstance(instance: LauncherInstance): void {
  const file = launcherInstanceFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(instance, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, file);
}

/** Remove the record, if it is still this process's own. Never throws: it runs on the way out. */
export function removeLauncherInstance(pid: number): void {
  try {
    if (readLauncherInstance()?.pid === pid) {
      fs.unlinkSync(launcherInstanceFile());
    }
  } catch {
    // A stale record is recognised as stale by the next launch.
  }
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: any) {
    return err?.code === 'EPERM';
  }
}

/**
 * The start server already running, or null. A crashed one leaves its record
 * behind, so its process and its health route both have to answer — and
 * answer as the same process, not some other program that got the port.
 */
export async function findRunningLauncher(): Promise<LauncherInstance | null> {
  const instance = readLauncherInstance();
  if (!instance || instance.pid === process.pid || !isPidAlive(instance.pid)) {
    return null;
  }
  try {
    const response = await fetch(`http://127.0.0.1:${instance.port}/api/launcher/health`, {
      signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS),
    });
    const health = (await response.json()) as Partial<LauncherHealth>;
    return response.ok && health.app === 'fluidcad-launcher' && health.pid === instance.pid ? instance : null;
  } catch {
    return null;
  }
}
