import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { FluidcadHome } from './fluidcad-home.ts';

/**
 * The API keys of the in-app agent's model providers (docs/agent-chat-plan.md
 * §20.2): `$FLUIDCAD_HOME/agent-credentials.json`, mode 0600, written whole
 * to a temporary sibling and renamed, as `HubCredentials` is:
 *
 * ```json
 * { "schemaVersion": 1, "providers": { "anthropic": { "apiKey": "…", "savedAt": "…" } } }
 * ```
 *
 * A built-in provider's environment variable wins over the file
 * (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `OPENROUTER_API_KEY`); custom
 * entries have none. A key is never logged, put in an error, or sent to the
 * page: callers learn only whether there is one and where it comes from. The
 * agent's own API backend is the only reader; Claude Code and Codex never get
 * these keys.
 */

export type AgentKeySource = 'env' | 'stored';

export type ResolvedAgentKey = { apiKey: string; source: AgentKeySource };

type StoredKey = { apiKey: string; savedAt: string };

type CredentialsFile = { schemaVersion: 1; providers: Record<string, StoredKey> };

/** The environment variable each built-in provider's key may come from. */
export const AGENT_PROVIDER_ENV_VARS: Readonly<Record<string, string>> = Object.freeze({
  anthropic: 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY',
  openrouter: 'OPENROUTER_API_KEY',
});

/** Longest key the store takes. */
export const MAX_AGENT_KEY_CHARS = 512;
/** A key is one token of printable ASCII: no spaces, no line breaks a header could carry. */
const KEY_PATTERN = /^[\x21-\x7e]+$/;
/** Provider ids: built-in names and the custom-entry slugs (`agent.providers`). */
const PROVIDER_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,31}$/;

export class AgentCredentials {
  static readonly FILE_NAME = 'agent-credentials.json';
  static readonly FILE_MODE = 0o600;
  static readonly SCHEMA_VERSION = 1;

  readonly filePath: string;

  /** `filePath` defaults to `$FLUIDCAD_HOME/agent-credentials.json`, resolved when each call is made. */
  constructor(filePath?: string) {
    this.filePath = filePath ?? '';
  }

  /** `$FLUIDCAD_HOME/agent-credentials.json`. */
  static defaultPath(): string {
    return FluidcadHome.file(AgentCredentials.FILE_NAME);
  }

  /** Whether `apiKey` is a key the store takes (after trimming). */
  static isValidKey(apiKey: unknown): apiKey is string {
    if (typeof apiKey !== 'string') {
      return false;
    }
    const key = apiKey.trim();
    return key !== '' && key.length <= MAX_AGENT_KEY_CHARS && KEY_PATTERN.test(key);
  }

  /** The environment variable for provider `id`, when it is a built-in. */
  static envVar(id: string): string | undefined {
    return Object.hasOwn(AGENT_PROVIDER_ENV_VARS, id) ? AGENT_PROVIDER_ENV_VARS[id] : undefined;
  }

  /** The key in the environment for provider `id`, trimmed; null when unset or blank. */
  static fromEnv(id: string, env: NodeJS.ProcessEnv = process.env): string | null {
    const name = AgentCredentials.envVar(id);
    const value = name ? env[name]?.trim() : undefined;
    return value ? value : null;
  }

  /** The key a request to provider `id` uses: the environment's, else the stored one, else null. */
  resolve(id: string, env: NodeJS.ProcessEnv = process.env): ResolvedAgentKey | null {
    const fromEnv = AgentCredentials.fromEnv(id, env);
    if (fromEnv) {
      return { apiKey: fromEnv, source: 'env' };
    }
    const stored = this.stored(id);
    return stored ? { apiKey: stored, source: 'stored' } : null;
  }

  /** The stored key of provider `id`, whatever the environment says. */
  stored(id: string): string | null {
    return this.load().providers[id]?.apiKey ?? null;
  }

  /** Providers with a stored key. */
  storedIds(): string[] {
    return Object.keys(this.load().providers);
  }

  /** Stores `apiKey` (trimmed) for provider `id`, keeping every other provider's. */
  write(id: string, apiKey: string): void {
    if (!PROVIDER_ID_PATTERN.test(id)) {
      throw new Error('Invalid provider id.');
    }
    if (!AgentCredentials.isValidKey(apiKey)) {
      // Never the key itself in the message.
      throw new Error('Invalid API key.');
    }
    const file = this.load();
    file.providers[id] = { apiKey: apiKey.trim(), savedAt: new Date().toISOString() };
    this.save(file);
  }

  /** Forgets provider `id`'s stored key. False when there was none (nothing is written). */
  delete(id: string): boolean {
    const file = this.load();
    if (!Object.hasOwn(file.providers, id)) {
      return false;
    }
    delete file.providers[id];
    this.save(file);
    return true;
  }

  private path(): string {
    return this.filePath || AgentCredentials.defaultPath();
  }

  /** The file, or an empty one when it is missing or unreadable (a broken file is replaced on the next write). */
  private load(): CredentialsFile {
    let raw: string;
    try {
      raw = fs.readFileSync(this.path(), 'utf8');
    } catch {
      return { schemaVersion: 1, providers: {} };
    }
    const providers: Record<string, StoredKey> = {};
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && parsed.schemaVersion === AgentCredentials.SCHEMA_VERSION && parsed.providers && typeof parsed.providers === 'object') {
        for (const [id, value] of Object.entries(parsed.providers as Record<string, unknown>)) {
          const entry = value as Partial<StoredKey> | null;
          if (PROVIDER_ID_PATTERN.test(id) && entry && AgentCredentials.isValidKey(entry.apiKey)) {
            providers[id] = { apiKey: entry.apiKey.trim(), savedAt: typeof entry.savedAt === 'string' ? entry.savedAt : '' };
          }
        }
      }
    } catch {
      // A torn or foreign file holds no keys.
    }
    return { schemaVersion: 1, providers };
  }

  private save(file: CredentialsFile): void {
    const target = this.path();
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const temp = `${target}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
    try {
      fs.writeFileSync(temp, JSON.stringify(file, null, 2) + '\n', { mode: AgentCredentials.FILE_MODE, flag: 'wx' });
      // The umask can only take bits away; this makes sure of 0600 whatever it is.
      fs.chmodSync(temp, AgentCredentials.FILE_MODE);
      fs.renameSync(temp, target);
    } catch (err) {
      fs.rmSync(temp, { force: true });
      throw err;
    }
  }
}
