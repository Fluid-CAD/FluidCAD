import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AgentCredentials, MAX_AGENT_KEY_CHARS } from '../src/agent-credentials.ts';

/**
 * `$FLUIDCAD_HOME/agent-credentials.json` (docs/agent-chat-plan.md §20.2):
 * 0600, written atomically, keyed by provider id; a built-in provider's
 * environment variable wins. Every case points FLUIDCAD_HOME at a temp dir.
 */

let saved: string | undefined;
let home: string;

beforeEach(() => {
  saved = process.env.FLUIDCAD_HOME;
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'fluidcad-agent-keys-'));
  process.env.FLUIDCAD_HOME = path.join(home, 'nested');
});

afterEach(() => {
  if (saved === undefined) {
    delete process.env.FLUIDCAD_HOME;
  } else {
    process.env.FLUIDCAD_HOME = saved;
  }
  fs.rmSync(home, { recursive: true, force: true });
});

describe('AgentCredentials', () => {
  it('lives at $FLUIDCAD_HOME/agent-credentials.json and writes it at 0600 with a schema version', () => {
    const store = new AgentCredentials();
    expect(AgentCredentials.defaultPath()).toBe(path.join(home, 'nested', 'agent-credentials.json'));
    store.write('anthropic', '  sk-ant-test-1  ');
    const file = AgentCredentials.defaultPath();
    if (process.platform !== 'win32') {
      expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    }
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    expect(raw.schemaVersion).toBe(1);
    expect(raw.providers.anthropic.apiKey).toBe('sk-ant-test-1');
    expect(typeof raw.providers.anthropic.savedAt).toBe('string');
    // No temp file is left beside it.
    expect(fs.readdirSync(path.dirname(file))).toEqual(['agent-credentials.json']);
  });

  it('keeps every provider apart, deletes one and leaves the others', () => {
    const store = new AgentCredentials();
    store.write('openai', 'sk-o');
    store.write('ollama', 'local-key');
    expect(store.storedIds().sort()).toEqual(['ollama', 'openai']);
    expect(store.delete('openai')).toBe(true);
    expect(store.delete('openai')).toBe(false);
    expect(store.stored('openai')).toBeNull();
    expect(store.stored('ollama')).toBe('local-key');
  });

  it('lets the environment win for built-ins, and custom entries have no variable', () => {
    const store = new AgentCredentials();
    store.write('anthropic', 'sk-stored');
    store.write('ollama', 'stored-local');
    expect(store.resolve('anthropic', {})).toEqual({ apiKey: 'sk-stored', source: 'stored' });
    expect(store.resolve('anthropic', { ANTHROPIC_API_KEY: ' sk-env ' })).toEqual({ apiKey: 'sk-env', source: 'env' });
    // A blank variable is no key.
    expect(store.resolve('anthropic', { ANTHROPIC_API_KEY: '  ' })).toEqual({ apiKey: 'sk-stored', source: 'stored' });
    expect(store.resolve('openrouter', { OPENROUTER_API_KEY: 'or-env' })).toEqual({ apiKey: 'or-env', source: 'env' });
    expect(store.resolve('ollama', { OLLAMA_API_KEY: 'x' })).toEqual({ apiKey: 'stored-local', source: 'stored' });
    expect(store.resolve('openai', {})).toBeNull();
    expect(AgentCredentials.envVar('openai')).toBe('OPENAI_API_KEY');
    expect(AgentCredentials.envVar('toString')).toBeUndefined();
  });

  it('refuses keys that are empty, too long or not one printable token, without the key in the error', () => {
    const store = new AgentCredentials();
    for (const bad of ['', '   ', 'a b', 'line\nbreak', 'x'.repeat(MAX_AGENT_KEY_CHARS + 1)]) {
      expect(AgentCredentials.isValidKey(bad)).toBe(false);
      let message = '';
      try {
        store.write('openai', bad);
      } catch (e) {
        message = (e as Error).message;
      }
      expect(message).toBe('Invalid API key.');
    }
    expect(() => store.write('../etc', 'sk-x')).toThrow('Invalid provider id.');
    expect(fs.existsSync(AgentCredentials.defaultPath())).toBe(false);
  });

  it('reads a missing, torn or foreign file as empty and replaces it on the next write', () => {
    const file = path.join(home, 'keys.json');
    const store = new AgentCredentials(file);
    expect(store.stored('anthropic')).toBeNull();
    fs.writeFileSync(file, '{ torn');
    expect(store.stored('anthropic')).toBeNull();
    fs.writeFileSync(file, JSON.stringify({ schemaVersion: 2, providers: { anthropic: { apiKey: 'sk-future' } } }));
    expect(store.stored('anthropic')).toBeNull();
    store.write('anthropic', 'sk-new');
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toMatchObject({ schemaVersion: 1, providers: { anthropic: { apiKey: 'sk-new' } } });
  });
});
