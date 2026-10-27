import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { FluidcadHome } from '../fluidcad-home.ts';

/**
 * The hub sign-ins of this machine (HD9): `$FLUIDCAD_HOME/credentials.json`,
 * mode 0600, keyed by hub origin so local, staging and production stay
 * apart:
 *
 * ```json
 * { "hubs": { "https://hub.fluidcad.io": { "token": "fch_…", "tokenId": "…", "handle": "acme", "email": "…" } } }
 * ```
 *
 * The token resolves in this order (hub-plan "FluidCAD code"):
 * `FLUIDCAD_HUB_TOKEN`, then the file's entry for that origin. The
 * environment token is for CI and headless use: it is read, never written.
 *
 * The old `~/.config/fluidcad/credentials.json` belonged to the abandoned
 * hub and is ignored.
 */

export type HubCredentialEntry = {
  token: string;
  /** The hub's id for the token; null when unknown. */
  tokenId: string | null;
  handle: string | null;
  email: string | null;
};

export type HubCredentialSource = 'env' | 'file';

/** The token a request to one hub would carry, and where it came from. */
export type ResolvedHubCredential = HubCredentialEntry & { source: HubCredentialSource };

type CredentialsFile = { hubs: Record<string, HubCredentialEntry> };

export class HubCredentials {
  static readonly FILE_NAME = 'credentials.json';
  static readonly ENV_TOKEN = 'FLUIDCAD_HUB_TOKEN';
  static readonly FILE_MODE = 0o600;

  /** `$FLUIDCAD_HOME/credentials.json`. */
  static path(): string {
    return FluidcadHome.file(HubCredentials.FILE_NAME);
  }

  /**
   * The credential for `origin`: `FLUIDCAD_HUB_TOKEN` when set (the same
   * token for whichever hub is asked), else the file's entry, else null.
   */
  static read(origin: string, env: NodeJS.ProcessEnv = process.env): ResolvedHubCredential | null {
    const fromEnv = env[HubCredentials.ENV_TOKEN]?.trim();
    if (fromEnv) {
      return { token: fromEnv, tokenId: null, handle: null, email: null, source: 'env' };
    }
    const stored = HubCredentials.stored(origin);
    return stored ? { ...stored, source: 'file' } : null;
  }

  /** The file's entry for `origin` alone, whatever the environment says. */
  static stored(origin: string): HubCredentialEntry | null {
    const entry = HubCredentials.load().hubs[origin];
    return entry ?? null;
  }

  /**
   * Saves `entry` for `origin` and keeps every other origin's. The file is
   * written whole to a temporary sibling at 0600 and renamed over the old
   * one, so a reader never sees half a file and a crash leaves the old one.
   * Returns the file's path.
   */
  static write(origin: string, entry: HubCredentialEntry): string {
    const file = HubCredentials.load();
    file.hubs[origin] = {
      token: entry.token,
      tokenId: entry.tokenId ?? null,
      handle: entry.handle ?? null,
      email: entry.email ?? null,
    };
    return HubCredentials.save(file);
  }

  /** Forgets `origin`'s entry and keeps the others. False when there was none. */
  static clear(origin: string): boolean {
    const file = HubCredentials.load();
    if (!(origin in file.hubs)) {
      return false;
    }
    delete file.hubs[origin];
    HubCredentials.save(file);
    return true;
  }

  /** The file, or an empty one when it is missing or not ours to read (a broken file is replaced on the next write). */
  private static load(): CredentialsFile {
    let raw: string;
    try {
      raw = fs.readFileSync(HubCredentials.path(), 'utf8');
    } catch {
      return { hubs: {} };
    }
    try {
      const parsed = JSON.parse(raw);
      const hubs: Record<string, HubCredentialEntry> = {};
      if (parsed && typeof parsed === 'object' && parsed.hubs && typeof parsed.hubs === 'object') {
        for (const [origin, value] of Object.entries(parsed.hubs as Record<string, unknown>)) {
          const entry = HubCredentials.entryOf(value);
          if (entry) {
            hubs[origin] = entry;
          }
        }
      }
      return { hubs };
    } catch {
      return { hubs: {} };
    }
  }

  private static entryOf(value: unknown): HubCredentialEntry | null {
    if (!value || typeof value !== 'object') {
      return null;
    }
    const record = value as Record<string, unknown>;
    if (typeof record.token !== 'string' || record.token === '') {
      return null;
    }
    const text = (key: string) => (typeof record[key] === 'string' ? (record[key] as string) : null);
    return { token: record.token, tokenId: text('tokenId'), handle: text('handle'), email: text('email') };
  }

  private static save(file: CredentialsFile): string {
    const target = HubCredentials.path();
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const temp = `${target}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
    try {
      fs.writeFileSync(temp, JSON.stringify(file, null, 2) + '\n', { mode: HubCredentials.FILE_MODE, flag: 'wx' });
      // The umask can only take bits away; this makes sure of 0600 whatever it is.
      fs.chmodSync(temp, HubCredentials.FILE_MODE);
      fs.renameSync(temp, target);
    } catch (err) {
      fs.rmSync(temp, { force: true });
      throw err;
    }
    return target;
  }
}
