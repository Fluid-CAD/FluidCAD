import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { enginesDir } from './paths';

/**
 * Private working directories under `<engines>/.tmp`, one per download or
 * copy. Two operations on the same engine version therefore never share a
 * file. This matters for a window reopened while its first download is still
 * running, and for a retention copy running beside a download. When both used
 * `<file>.<pid>.part`, whichever finished first deleted the other's tarball.
 *
 * The owning process id leads the directory name. That is how a later launch
 * tells a directory abandoned mid-operation (its process is gone) from one
 * still in use.
 */
export class EngineScratch {
  private constructor(readonly dir: string) {}

  static root(): string {
    return path.join(enginesDir(), '.tmp');
  }

  static create(): EngineScratch {
    const dir = path.join(EngineScratch.root(), `${process.pid}-${crypto.randomUUID()}`);
    fs.mkdirSync(dir, { recursive: true });
    return new EngineScratch(dir);
  }

  /** A path inside this directory. */
  file(name: string): string {
    return path.join(this.dir, name);
  }

  dispose(): void {
    fs.rmSync(this.dir, { recursive: true, force: true });
  }

  /**
   * Delete what processes that are gone left behind. Quitting or crashing in
   * the middle of a download or copy can strand an engine's worth of files
   * here. Returns the entries removed.
   */
  static sweep(): string[] {
    let entries: string[];
    try {
      entries = fs.readdirSync(EngineScratch.root());
    } catch {
      return [];
    }
    const removed: string[] = [];
    for (const name of entries) {
      if (EngineScratch.inUse(name)) {
        continue;
      }
      try {
        fs.rmSync(path.join(EngineScratch.root(), name), { recursive: true, force: true });
        removed.push(name);
      } catch {
        // Housekeeping: the next launch tries again.
      }
    }
    return removed;
  }

  private static inUse(name: string): boolean {
    const owner = /^(\d+)-/.exec(name);
    if (!owner) {
      // Named by a shell that predates this layout, so it was made by an
      // earlier run and is no longer in use.
      return false;
    }
    const pid = Number(owner[1]);
    if (pid === process.pid) {
      return true;
    }
    try {
      process.kill(pid, 0);
      return true;
    } catch (err: any) {
      // EPERM: alive, just not ours to signal.
      return err?.code === 'EPERM';
    }
  }
}
