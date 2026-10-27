import crypto from 'crypto';
import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';
import { FluidcadHome } from '../fluidcad-home.ts';

/**
 * The engine's disk cache of hub files and screenshots (hub-plan H10):
 * `$FLUIDCAD_HOME/cache/hub/`. It holds only what the hub says never
 * changes (`Cache-Control: … immutable`: a published version's files, a
 * public package's screenshots), so an entry is never revalidated: a
 * second read never asks the hub, and works offline.
 *
 * Each entry is two files named by the SHA-256 of its hub URL (origin
 * included, so a local hub and production never share an entry):
 * `<key>.bin` (the bytes) and `<key>.json` (the type and the headers the
 * bridge passes on). Both are written to a temporary sibling and renamed,
 * so a reader never sees half an entry.
 *
 * **Least recently used goes first:** a read touches the entry's `.bin`
 * (its modification time is its last use), and after a write the cache
 * sweeps itself back under its limit (200 MB) by removing the entries
 * used longest ago. The sweep also drops a half-written temporary file
 * and an entry missing one of its two halves.
 */

/** One cached answer: the bytes and what to serve them with. */
export type HubCachedFile = {
  body: Buffer;
  contentType: string;
  /** The hub's headers worth passing on (`content-security-policy`, `content-disposition`), lower-cased. */
  headers: Record<string, string>;
};

export type HubFileCacheOptions = {
  /** Defaults to `$FLUIDCAD_HOME/cache/hub`. */
  dir?: string;
  /** Defaults to {@link HubFileCache.MAX_BYTES}. */
  maxBytes?: number;
};

export type HubCacheSweep = { kept: number; removed: number; bytes: number };

type EntryMeta = { url: string; contentType: string; headers: Record<string, string>; bytes: number; storedAt: string };

export class HubFileCache {
  /** The sweep's limit: the bytes all entries may take together. */
  static readonly MAX_BYTES = 200 * 1024 * 1024;
  /** A larger answer is served but not kept (the hub's own entry limit is 25 MB). */
  static readonly MAX_ENTRY_BYTES = 32 * 1024 * 1024;
  private static readonly TEMP = '.tmp';
  /** How long a temporary file or half an entry is left alone before a sweep takes it for litter. */
  private static readonly LITTER_MS = 60_000;

  readonly dir: string;
  readonly maxBytes: number;
  private sweeping: Promise<HubCacheSweep> | null = null;
  private sweepAgain = false;

  constructor(options: HubFileCacheOptions = {}) {
    this.dir = options.dir ?? HubFileCache.defaultDir();
    this.maxBytes = options.maxBytes ?? HubFileCache.MAX_BYTES;
  }

  /** `$FLUIDCAD_HOME/cache/hub`. */
  static defaultDir(): string {
    return FluidcadHome.file('cache', 'hub');
  }

  /** The entry name for a hub URL. */
  static keyOf(url: string): string {
    return crypto.createHash('sha256').update(url).digest('hex');
  }

  /** True when the hub's `Cache-Control` says the answer never changes and isn't private. */
  static isImmutable(cacheControl: string | null | undefined): boolean {
    const directives = (cacheControl ?? '').toLowerCase().split(',').map((part) => part.trim());
    return directives.includes('immutable') && !directives.includes('private') && !directives.includes('no-store');
  }

  /** The entry for `url`, its use recorded; null when there is none (or half of one). */
  async read(url: string): Promise<HubCachedFile | null> {
    const key = HubFileCache.keyOf(url);
    let meta: EntryMeta;
    let body: Buffer;
    try {
      meta = JSON.parse(await fsp.readFile(this.metaFile(key), 'utf8')) as EntryMeta;
      body = await fsp.readFile(this.bodyFile(key));
    } catch {
      return null;
    }
    if (meta.url !== url || body.length !== meta.bytes) {
      await this.remove(key);
      return null;
    }
    const now = new Date();
    await fsp.utimes(this.bodyFile(key), now, now).catch((): void => undefined);
    return { body, contentType: meta.contentType, headers: meta.headers ?? {} };
  }

  /**
   * Keeps `file` for `url` (nothing when it is over
   * {@link MAX_ENTRY_BYTES}), then sweeps. A failure to write is swallowed:
   * the answer was already served, and the next read asks the hub again.
   */
  async write(url: string, file: HubCachedFile): Promise<void> {
    if (file.body.length > HubFileCache.MAX_ENTRY_BYTES) {
      return;
    }
    const key = HubFileCache.keyOf(url);
    const meta: EntryMeta = { url, contentType: file.contentType, headers: file.headers, bytes: file.body.length, storedAt: new Date().toISOString() };
    try {
      await fsp.mkdir(this.dir, { recursive: true });
      await this.writeAtomic(this.bodyFile(key), file.body);
      await this.writeAtomic(this.metaFile(key), JSON.stringify(meta));
    } catch {
      await this.remove(key);
      return;
    }
    await this.sweep();
  }

  /**
   * Back under {@link maxBytes}: the entries used longest ago go first.
   * One sweep runs at a time; a write during a sweep asks for one more
   * after it.
   */
  async sweep(): Promise<HubCacheSweep> {
    if (this.sweeping) {
      this.sweepAgain = true;
      return this.sweeping;
    }
    this.sweeping = this.sweepOnce();
    try {
      let result = await this.sweeping;
      while (this.sweepAgain) {
        this.sweepAgain = false;
        this.sweeping = this.sweepOnce();
        result = await this.sweeping;
      }
      return result;
    } finally {
      this.sweeping = null;
    }
  }

  private async sweepOnce(): Promise<HubCacheSweep> {
    let names: string[];
    try {
      names = await fsp.readdir(this.dir);
    } catch {
      return { kept: 0, removed: 0, bytes: 0 };
    }
    const stats = new Map<string, fs.Stats>();
    for (const name of names) {
      try {
        stats.set(name, await fsp.stat(path.join(this.dir, name)));
      } catch {
        // Gone since the listing (a rename, another sweep).
      }
    }
    // A temporary file or half an entry may be a write still in progress:
    // only one left alone for a while is litter.
    const litter = (name: string) => (stats.get(name)?.mtimeMs ?? Infinity) < Date.now() - HubFileCache.LITTER_MS;
    const entries: { key: string; bytes: number; usedAt: number }[] = [];
    let removed = 0;
    for (const [name, stat] of stats) {
      if (name.includes(HubFileCache.TEMP) || name.endsWith('.json')) {
        const half = name.endsWith('.json') && !stats.has(`${name.slice(0, -5)}.bin`);
        if ((name.includes(HubFileCache.TEMP) || half) && litter(name)) {
          await fsp.rm(path.join(this.dir, name), { force: true }).catch((): void => undefined);
        }
        continue;
      }
      if (!name.endsWith('.bin')) {
        continue;
      }
      const key = name.slice(0, -4);
      if (!stats.has(`${key}.json`)) {
        if (litter(name)) {
          await this.remove(key);
          removed += 1;
        }
        continue;
      }
      entries.push({ key, bytes: stat.size, usedAt: stat.mtimeMs });
    }
    entries.sort((a, b) => a.usedAt - b.usedAt || (a.key < b.key ? -1 : 1));
    let total = entries.reduce((sum, entry) => sum + entry.bytes, 0);
    let kept = entries.length;
    for (const entry of entries) {
      if (total <= this.maxBytes) {
        break;
      }
      await this.remove(entry.key);
      total -= entry.bytes;
      kept -= 1;
      removed += 1;
    }
    return { kept, removed, bytes: total };
  }

  private async writeAtomic(target: string, data: string | Buffer): Promise<void> {
    const temp = `${target}.${process.pid}.${crypto.randomBytes(6).toString('hex')}${HubFileCache.TEMP}`;
    try {
      await fsp.writeFile(temp, data);
      await fsp.rename(temp, target);
    } catch (err) {
      fs.rmSync(temp, { force: true });
      throw err;
    }
  }

  private async remove(key: string): Promise<void> {
    await fsp.rm(this.bodyFile(key), { force: true }).catch((): void => undefined);
    await fsp.rm(this.metaFile(key), { force: true }).catch((): void => undefined);
  }

  private bodyFile(key: string): string {
    return path.join(this.dir, `${key}.bin`);
  }

  private metaFile(key: string): string {
    return path.join(this.dir, `${key}.json`);
  }
}
