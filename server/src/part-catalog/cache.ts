import { statSync } from 'fs';
import type { PartScanResult } from './scan.ts';

/** A scan's answer, with the workspace files it was read from (itself included). */
export type DependencyScan = { deps: string[] };

type CacheEntry<T> = {
  /** mtimeMs per dependency file at scan time. */
  deps: Map<string, number>;
  result: T;
};

/**
 * In-memory scan cache keyed by file path, invalidated by dependency mtimes:
 * an entry is served only while every workspace file the scanned module
 * imported (itself included) is byte-identical on disk by mtime. A scan that
 * reported no dependencies (host without module-graph access, or a module
 * that failed to load) is never cached. Files with live editor buffers
 * bypass this cache entirely — the caller checks that, since buffer content
 * changes without touching disk.
 */
export class ScanCache<T extends DependencyScan> {
  private entries = new Map<string, CacheEntry<T>>();

  get(absPath: string): T | null {
    const entry = this.entries.get(absPath);
    if (!entry) {
      return null;
    }
    for (const [dep, mtimeMs] of entry.deps) {
      let stat;
      try {
        stat = statSync(dep);
      } catch {
        this.entries.delete(absPath);
        return null;
      }
      if (stat.mtimeMs !== mtimeMs) {
        this.entries.delete(absPath);
        return null;
      }
    }
    return entry.result;
  }

  set(absPath: string, result: T): void {
    if (result.deps.length === 0) {
      return;
    }
    const deps = new Map<string, number>();
    for (const dep of result.deps) {
      try {
        deps.set(dep, statSync(dep).mtimeMs);
      } catch {
        return;
      }
    }
    this.entries.set(absPath, { deps, result });
  }

  /**
   * Drop every entry `file` is a dependency of (its own included), and say
   * whether there was one — a change the watcher saw lands here, so two
   * writes inside one mtime tick can't leave a stale entry behind.
   */
  dropDependents(file: string): boolean {
    let dropped = false;
    for (const [absPath, entry] of this.entries) {
      if (absPath === file || entry.deps.has(file)) {
        this.entries.delete(absPath);
        dropped = true;
      }
    }
    return dropped;
  }

  clear(): void {
    this.entries.clear();
  }
}

/** The Insert dialog's per-file part scans. */
export class PartScanCache extends ScanCache<PartScanResult> {}
