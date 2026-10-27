import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

/**
 * Private working directories under `<root>/.tmp`, one per inspected
 * archive, copy or replace, the launcher's `EngineScratch` pattern. Being
 * inside the root they install into keeps the final rename on one
 * filesystem, so a package appears whole or not at all.
 *
 * The owning process id leads the directory name: that is how a later
 * start tells a directory abandoned mid-install (its process is gone) from
 * one still in use, and {@link sweep} removes only the former.
 */
export class PackageScratch {
  static readonly DIR_NAME = '.tmp';

  private constructor(readonly dir: string) {}

  /** `<root>/.tmp`. */
  static rootOf(root: string): string {
    return path.join(root, PackageScratch.DIR_NAME);
  }

  static create(root: string): PackageScratch {
    const dir = path.join(PackageScratch.rootOf(root), `${process.pid}-${crypto.randomUUID()}`);
    fs.mkdirSync(dir, { recursive: true });
    return new PackageScratch(dir);
  }

  /** A path inside this directory. */
  file(...segments: string[]): string {
    return path.join(this.dir, ...segments);
  }

  /**
   * Delete the directory and everything in it. Installed files are
   * read-only; they are made writable first, which Windows needs to delete
   * them at all.
   */
  dispose(): void {
    PackageScratch.removeTree(this.dir);
    // The last one out takes `.tmp` with it, so a project's packages/
    // folder holds only packages between installs.
    try {
      fs.rmdirSync(path.dirname(this.dir));
    } catch {
      // Another operation's directory is still in it.
    }
  }

  /**
   * Delete what processes that are gone left behind under `<root>/.tmp`: a
   * killed install can strand a whole package's files there. Returns the
   * entries removed.
   */
  static sweep(root: string): string[] {
    const scratchRoot = PackageScratch.rootOf(root);
    let entries: string[];
    try {
      entries = fs.readdirSync(scratchRoot);
    } catch {
      return [];
    }
    const removed: string[] = [];
    for (const name of entries) {
      if (PackageScratch.inUse(name)) {
        continue;
      }
      try {
        PackageScratch.removeTree(path.join(scratchRoot, name));
        removed.push(name);
      } catch {
        // Housekeeping: the next start tries again.
      }
    }
    try {
      fs.rmdirSync(scratchRoot);
    } catch {
      // Still in use, or not empty.
    }
    return removed;
  }

  /** Remove `target` and everything under it, read-only files included. */
  static removeTree(target: string): void {
    PackageScratch.makeWritable(target);
    fs.rmSync(target, { recursive: true, force: true });
  }

  private static makeWritable(target: string): void {
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(target);
    } catch {
      return;
    }
    if (stat.isSymbolicLink()) {
      return;
    }
    if (stat.isDirectory()) {
      fs.chmodSync(target, 0o755);
      for (const name of fs.readdirSync(target)) {
        PackageScratch.makeWritable(path.join(target, name));
      }
      return;
    }
    if ((stat.mode & 0o200) === 0) {
      fs.chmodSync(target, 0o644);
    }
  }

  private static inUse(name: string): boolean {
    const owner = /^(\d+)-/.exec(name);
    if (!owner) {
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
