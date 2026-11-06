import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { HubFileCache } from '../../src/hub/hub-file-cache.ts';

/**
 * The bridge's disk cache (hub-plan H10): immutable answers only, keyed by
 * hub URL, a read records its use, and a write sweeps back under the
 * limit, the least recently used first.
 */

let dir: string;

const file = (text: string) => ({ body: Buffer.from(text), contentType: 'image/svg+xml', headers: { 'content-security-policy': "default-src 'none'; sandbox" } });

/** Sets an entry's last use `secondsAgo` in the past. */
function usedAgo(url: string, secondsAgo: number): void {
  const when = new Date(Date.now() - secondsAgo * 1000);
  fs.utimesSync(path.join(dir, `${HubFileCache.keyOf(url)}.bin`), when, when);
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fluidcad-hub-cache-'));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('HubFileCache', () => {
  it('lives in $FLUIDCAD_HOME/cache/hub', () => {
    const saved = process.env.FLUIDCAD_HOME;
    process.env.FLUIDCAD_HOME = dir;
    try {
      expect(HubFileCache.defaultDir()).toBe(path.join(dir, 'cache', 'hub'));
      expect(new HubFileCache().maxBytes).toBe(200 * 1024 * 1024);
    } finally {
      if (saved === undefined) {
        delete process.env.FLUIDCAD_HOME;
      } else {
        process.env.FLUIDCAD_HOME = saved;
      }
    }
  });

  it("keeps only what the hub calls immutable and public", () => {
    expect(HubFileCache.isImmutable('public, max-age=31536000, immutable')).toBe(true);
    expect(HubFileCache.isImmutable('private, no-store')).toBe(false);
    expect(HubFileCache.isImmutable('private, max-age=60, immutable')).toBe(false);
    expect(HubFileCache.isImmutable('public, max-age=60')).toBe(false);
    expect(HubFileCache.isImmutable(null)).toBe(false);
  });

  it('reads back what it wrote, by URL, with the type and headers', async () => {
    const cache = new HubFileCache({ dir });
    expect(await cache.read('http://hub/a.svg')).toBeNull();
    await cache.write('http://hub/a.svg', file('<svg/>'));
    expect(await cache.read('http://hub/a.svg')).toEqual(file('<svg/>'));
    // Another hub's same path is another entry.
    expect(await cache.read('http://other/a.svg')).toBeNull();
    expect(fs.readdirSync(dir).sort()).toEqual([`${HubFileCache.keyOf('http://hub/a.svg')}.bin`, `${HubFileCache.keyOf('http://hub/a.svg')}.json`].sort());
  });

  it('treats half an entry as none', async () => {
    const cache = new HubFileCache({ dir });
    await cache.write('http://hub/a.svg', file('<svg/>'));
    fs.rmSync(path.join(dir, `${HubFileCache.keyOf('http://hub/a.svg')}.json`));
    expect(await cache.read('http://hub/a.svg')).toBeNull();
  });

  it('sweeps back under its limit after a write, the entry used longest ago first', async () => {
    const cache = new HubFileCache({ dir, maxBytes: 250 });
    const hundred = 'x'.repeat(100);
    await cache.write('http://hub/1', file(hundred));
    await cache.write('http://hub/2', file(hundred));
    usedAgo('http://hub/1', 30);
    usedAgo('http://hub/2', 20);
    // A read is a use: 1 is now the most recent.
    expect(await cache.read('http://hub/1')).not.toBeNull();
    await cache.write('http://hub/3', file(hundred));
    expect(await cache.read('http://hub/2')).toBeNull();
    expect(await cache.read('http://hub/1')).not.toBeNull();
    expect(await cache.read('http://hub/3')).not.toBeNull();
    const sweep = await cache.sweep();
    expect(sweep).toEqual({ kept: 2, removed: 0, bytes: 200 });
  });

  it('removes a temporary file or half an entry left alone for a while, and not a fresh one (a write in progress)', async () => {
    const cache = new HubFileCache({ dir });
    const old = new Date(Date.now() - 5 * 60 * 1000);
    fs.writeFileSync(path.join(dir, 'abc.bin.123.deadbeef.tmp'), 'half');
    fs.utimesSync(path.join(dir, 'abc.bin.123.deadbeef.tmp'), old, old);
    fs.writeFileSync(path.join(dir, 'fresh.bin.123.cafe.tmp'), 'half');
    fs.writeFileSync(path.join(dir, 'lonely.bin'), 'no meta');
    fs.utimesSync(path.join(dir, 'lonely.bin'), old, old);
    fs.writeFileSync(path.join(dir, 'young.bin'), 'meta coming');
    await cache.sweep();
    expect(fs.readdirSync(dir).sort()).toEqual(['fresh.bin.123.cafe.tmp', 'young.bin']);
  });
});
