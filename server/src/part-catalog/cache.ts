import { statSync } from 'fs';
import type { PartScanResult } from './scan.ts';

type CacheEntry = {
  /** mtimeMs per dependency file at scan time. */
  deps: Map<string, number>;
  result: PartScanResult;
};

/**
 * In-memory scan cache keyed by file path, invalidated by dependency mtimes:
 * an entry is served only while every workspace file the scanned module
 * imported (itself included) is byte-identical on disk by mtime. A scan that
 * reported no dependencies (host without module-graph access) is never
 * cached. Files with live editor buffers bypass this cache entirely — the
 * caller checks that, since buffer content changes without touching disk.
 */
export class PartScanCache {
  private entries = new Map<string, CacheEntry>();

  get(absPath: string): PartScanResult | null {
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

  set(absPath: string, result: PartScanResult): void {
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

  clear(): void {
    this.entries.clear();
  }
}
