import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { HubCredentials } from '../../src/hub/hub-credentials.ts';

/**
 * `$FLUIDCAD_HOME/credentials.json` (HD9): 0600, keyed by origin, written
 * atomically; `FLUIDCAD_HUB_TOKEN` wins and is never written. Every case
 * points FLUIDCAD_HOME at a temp directory.
 */

const LOCAL = 'http://localhost:8787';
const PROD = 'https://hub.fluidcad.io';
const ENV_KEYS = ['FLUIDCAD_HOME', 'FLUIDCAD_HUB_TOKEN'] as const;
let saved: Record<string, string | undefined>;
let home: string;

function entry(token: string, handle = 'acme') {
  return { token, tokenId: `id-${token}`, handle, email: `${handle}@example.com` };
}

beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'fluidcad-hub-home-'));
  process.env.FLUIDCAD_HOME = path.join(home, 'nested', 'home');
  delete process.env.FLUIDCAD_HUB_TOKEN;
});

afterEach(() => {
  vi.restoreAllMocks();
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = saved[key];
    }
  }
  fs.rmSync(home, { recursive: true, force: true });
});

describe('HubCredentials', () => {
  it('lives at $FLUIDCAD_HOME/credentials.json', () => {
    expect(HubCredentials.path()).toBe(path.join(home, 'nested', 'home', 'credentials.json'));
  });

  it('writes the file at mode 0600, creating FLUIDCAD_HOME', () => {
    const file = HubCredentials.write(LOCAL, entry('fch_a'));

    expect(file).toBe(HubCredentials.path());
    if (process.platform !== 'win32') {
      expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    }
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({ hubs: { [LOCAL]: entry('fch_a') } });
  });

  it('makes a looser existing file 0600 again on the next write', () => {
    fs.mkdirSync(path.dirname(HubCredentials.path()), { recursive: true });
    fs.writeFileSync(HubCredentials.path(), '{"hubs":{}}', { mode: 0o644 });
    HubCredentials.write(LOCAL, entry('fch_a'));
    if (process.platform !== 'win32') {
      expect(fs.statSync(HubCredentials.path()).mode & 0o777).toBe(0o600);
    }
  });

  it('round-trips two origins, and clearing one keeps the other', () => {
    HubCredentials.write(LOCAL, entry('fch_local'));
    HubCredentials.write(PROD, entry('fch_prod', 'bea'));

    expect(HubCredentials.stored(LOCAL)).toEqual(entry('fch_local'));
    expect(HubCredentials.stored(PROD)).toEqual(entry('fch_prod', 'bea'));
    expect(HubCredentials.read(PROD)).toEqual({ ...entry('fch_prod', 'bea'), source: 'file' });

    // Signing in again to one hub replaces only its entry.
    HubCredentials.write(LOCAL, entry('fch_local2'));
    expect(HubCredentials.stored(LOCAL)?.token).toBe('fch_local2');
    expect(HubCredentials.stored(PROD)?.token).toBe('fch_prod');

    expect(HubCredentials.clear(LOCAL)).toBe(true);
    expect(HubCredentials.stored(LOCAL)).toBeNull();
    expect(HubCredentials.stored(PROD)?.token).toBe('fch_prod');
    expect(HubCredentials.clear(LOCAL)).toBe(false);
  });

  it('reads nothing when there is no file, or a broken one, and replaces a broken one on write', () => {
    expect(HubCredentials.read(LOCAL)).toBeNull();
    fs.mkdirSync(path.dirname(HubCredentials.path()), { recursive: true });
    fs.writeFileSync(HubCredentials.path(), '{ not json');
    expect(HubCredentials.read(LOCAL)).toBeNull();
    HubCredentials.write(LOCAL, entry('fch_a'));
    expect(HubCredentials.stored(LOCAL)?.token).toBe('fch_a');
  });

  it('skips an entry without a token', () => {
    fs.mkdirSync(path.dirname(HubCredentials.path()), { recursive: true });
    fs.writeFileSync(HubCredentials.path(), JSON.stringify({ hubs: { [LOCAL]: { handle: 'acme' }, [PROD]: { token: 'fch_p' } } }));
    expect(HubCredentials.stored(LOCAL)).toBeNull();
    expect(HubCredentials.stored(PROD)).toEqual({ token: 'fch_p', tokenId: null, handle: null, email: null });
  });

  it('writes through a temporary sibling renamed into place, and leaves no temporary file behind', () => {
    HubCredentials.write(LOCAL, entry('fch_old'));
    const renames: Array<[string, string]> = [];
    const realRename = fs.renameSync;
    vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
      renames.push([String(from), String(to)]);
      // Until the rename, readers still see the whole old file.
      expect(JSON.parse(fs.readFileSync(HubCredentials.path(), 'utf8')).hubs[LOCAL].token).toBe('fch_old');
      return realRename(from, to);
    });

    HubCredentials.write(LOCAL, entry('fch_new'));

    expect(renames).toHaveLength(1);
    expect(path.dirname(renames[0][0])).toBe(path.dirname(HubCredentials.path()));
    expect(renames[0][0]).toMatch(/credentials\.json\.\d+\.[0-9a-f]+\.tmp$/);
    expect(renames[0][1]).toBe(HubCredentials.path());
    expect(fs.readdirSync(path.dirname(HubCredentials.path()))).toEqual(['credentials.json']);
  });

  it('keeps the old file whole and removes the temporary one when the rename fails', () => {
    HubCredentials.write(LOCAL, entry('fch_old'));
    vi.spyOn(fs, 'renameSync').mockImplementation(() => {
      throw new Error('disk full');
    });

    expect(() => HubCredentials.write(LOCAL, entry('fch_new'))).toThrow('disk full');
    expect(HubCredentials.stored(LOCAL)?.token).toBe('fch_old');
    expect(fs.readdirSync(path.dirname(HubCredentials.path()))).toEqual(['credentials.json']);
  });

  it('lets FLUIDCAD_HUB_TOKEN win over the file, for any hub, and never writes it', () => {
    HubCredentials.write(LOCAL, entry('fch_file'));
    process.env.FLUIDCAD_HUB_TOKEN = 'fch_env';

    expect(HubCredentials.read(LOCAL)).toEqual({ token: 'fch_env', tokenId: null, handle: null, email: null, source: 'env' });
    expect(HubCredentials.read(PROD)?.token).toBe('fch_env');
    // The file's own entry is still there, and still only the file's.
    expect(HubCredentials.stored(LOCAL)?.token).toBe('fch_file');
    HubCredentials.write(PROD, entry('fch_prod'));
    expect(fs.readFileSync(HubCredentials.path(), 'utf8')).not.toContain('fch_env');
  });

  it('reads the environment it is given', () => {
    HubCredentials.write(LOCAL, entry('fch_file'));
    expect(HubCredentials.read(LOCAL, { FLUIDCAD_HUB_TOKEN: ' fch_given ' })?.token).toBe('fch_given');
    expect(HubCredentials.read(LOCAL, {})?.token).toBe('fch_file');
  });
});
