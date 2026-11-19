import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { APICallError, LoadAPIKeyError, RetryError, type ModelMessage } from 'ai';
import { AgentCredentials } from '../../server/dist/agent-credentials.js';
import { mapProviderError, redact } from '../src/api/errors.ts';
import { readHistory, writeHistory } from '../src/api/history.ts';
import { IMAGE_OMITTED_NOTE, moveToolImagesToUserMessages, providerOptionsFor, systemMessage, withoutImages } from '../src/api/language-model.ts';
import { parseAnthropicModels, parseCompatibleModels, parseOpenAIModels, parseOpenRouterModels } from '../src/api/models.ts';
import { ProviderKeyError, ProviderRegistry, keyPreview, type ResolvedProvider } from '../src/api/providers.ts';

// The API agent's providers, model lists, errors and history (§20), without
// a network: model lists come from a fake fetch.

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fluidcad-api-providers-'));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const ANTHROPIC_LIST = {
  data: [
    {
      id: 'claude-opus-5-5',
      display_name: 'Claude Opus 5.5',
      max_input_tokens: 1_000_000,
      capabilities: {
        effort: { supported: true, low: { supported: true }, medium: { supported: true }, high: { supported: true }, xhigh: { supported: true }, max: { supported: true } },
        image_input: { supported: true },
        thinking: { supported: true, types: { adaptive: { supported: true } } },
      },
    },
    { id: 'claude-haiku-4-5-20251001', display_name: 'Claude Haiku 4.5', capabilities: { effort: { supported: false }, image_input: { supported: true }, thinking: { types: { adaptive: { supported: false } } } } },
  ],
  has_more: false,
};

describe('model lists', () => {
  it('reads efforts, images, context and adaptive thinking from Anthropic\'s list', () => {
    expect(parseAnthropicModels(ANTHROPIC_LIST.data)).toEqual([
      { id: 'claude-opus-5-5', label: 'Claude Opus 5.5', acceptsImages: true, contextWindow: 1_000_000, efforts: ['low', 'medium', 'high', 'xhigh', 'max'], defaultEffort: 'high', adaptiveThinking: true },
      { id: 'claude-haiku-4-5-20251001', label: 'Claude Haiku 4.5', acceptsImages: true },
    ]);
  });

  it('keeps OpenAI\'s chat models only, without dated snapshots of a listed alias', () => {
    const ids = ['gpt-5.4', 'gpt-5.4-2026-03-05', 'gpt-4.1-mini', 'gpt-realtime-2', 'gpt-image-2', 'tts-1', 'whisper-1', 'text-embedding-3-small', 'o3', 'gpt-5-chat-latest', 'gpt-4o-mini-tts', 'gpt-5-search-api', 'omni-moderation-latest', 'gpt-6-sol', 'gpt-4o-2024-08-06'];
    const models = parseOpenAIModels({ data: ids.map((id) => ({ id })) });
    expect(models.map((m) => m.id)).toEqual(['gpt-4.1-mini', 'gpt-4o-2024-08-06', 'gpt-5.4', 'gpt-6-sol', 'o3']);
    expect(models.find((m) => m.id === 'gpt-5.4')).toMatchObject({ reasoning: true, efforts: ['low', 'medium', 'high'], defaultEffort: 'medium', acceptsImages: true });
    expect(models.find((m) => m.id === 'gpt-4.1-mini')!.efforts).toBeUndefined();
  });

  it('keeps OpenRouter models that take tools, with images and reasoning as listed', () => {
    const models = parseOpenRouterModels({
      data: [
        { id: 'anthropic/claude-sonnet-5-5', name: 'Anthropic: Claude Sonnet 5.5', context_length: 1000000, architecture: { input_modalities: ['text', 'image'] }, supported_parameters: ['tools', 'reasoning'] },
        { id: 'some/text-only', name: 'Text', architecture: { input_modalities: ['text'] }, supported_parameters: ['tools'] },
        { id: 'no/tools', supported_parameters: ['temperature'] },
      ],
    });
    expect(models).toEqual([
      { id: 'anthropic/claude-sonnet-5-5', label: 'Anthropic: Claude Sonnet 5.5', acceptsImages: true, contextWindow: 1000000, reasoning: true, efforts: ['low', 'medium', 'high'], defaultEffort: 'medium' },
      { id: 'some/text-only', label: 'Text', acceptsImages: false },
    ]);
  });

  it('lists an OpenAI-compatible server\'s ids with the entry\'s image setting', () => {
    expect(parseCompatibleModels({ data: [{ id: 'qwen3-vl:4b' }, { id: 'llama3:8b' }, { id: 'qwen3-vl:4b' }] }, false)).toEqual([
      { id: 'llama3:8b', acceptsImages: false },
      { id: 'qwen3-vl:4b', acceptsImages: false },
    ]);
  });
});

type FetchCall = { url: string; headers: Record<string, string> };

function fakeFetch(routes: Record<string, () => Response>): { fetch: typeof fetch; calls: FetchCall[] } {
  const calls: FetchCall[] = [];
  const fn = (async (input: any, init?: any) => {
    const url = String(input);
    calls.push({ url, headers: { ...(init?.headers ?? {}) } });
    for (const [prefix, respond] of Object.entries(routes)) {
      if (url.startsWith(prefix)) {
        return respond();
      }
    }
    throw new TypeError('fetch failed', { cause: Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }) });
  }) as typeof fetch;
  return { fetch: fn, calls };
}

const json = (body: unknown, status = 200) => () => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function registry(options: { env?: NodeJS.ProcessEnv; prefs?: any; fetch?: typeof fetch; now?: () => number } = {}) {
  const credentials = new AgentCredentials(path.join(dir, 'agent-credentials.json'));
  const prefs = options.prefs ?? { agent: { defaultAgent: null, permissionMode: 'ask' } };
  return new ProviderRegistry({ loadPreferences: async () => prefs, env: options.env ?? {}, credentials, fetch: options.fetch, now: options.now });
}

const OLLAMA = { id: 'ollama', kind: 'openai-compatible', label: 'Ollama', baseURL: 'http://localhost:11434/v1', models: ['qwen3-vl:4b'], contextWindow: 4096 };

describe('keyPreview', () => {
  it('shows at most 10 characters and a quarter of the key', () => {
    expect(keyPreview('sk-or-v1-0123456789abcdef0123456789abcdef0123456789')).toBe('sk-or-v1-0…');
    expect(keyPreview('abcdefgh')).toBe('ab…');
    expect(keyPreview('abc')).toBe('…');
  });
});

describe('ProviderRegistry', () => {
  it('reports the built-ins and custom entries, the environment winning, and never a key', async () => {
    const r = registry({ env: { OPENAI_API_KEY: 'sk-env-openai-1234567890' }, prefs: { agent: { providers: [OLLAMA] } } });
    r.credentials.write('anthropic', 'sk-ant-stored-1234567890');
    r.credentials.write('openai', 'sk-stored-openai-1234567890');
    const statuses = await r.statuses();
    expect(statuses).toEqual([
      { id: 'anthropic', kind: 'anthropic', label: 'Anthropic API', builtIn: true, hasKey: true, keySource: 'stored', keyPreview: 'sk-ant…', envVar: 'ANTHROPIC_API_KEY', ready: true, images: true },
      { id: 'openai', kind: 'openai', label: 'OpenAI API', builtIn: true, hasKey: true, keySource: 'env', keyPreview: 'sk-env…', envVar: 'OPENAI_API_KEY', ready: true, images: true },
      { id: 'openrouter', kind: 'openrouter', label: 'OpenRouter', builtIn: true, hasKey: false, keySource: null, envVar: 'OPENROUTER_API_KEY', ready: false, images: true, problem: 'No API key.' },
      { id: 'ollama', kind: 'openai-compatible', label: 'Ollama', builtIn: false, baseURL: 'http://localhost:11434/v1', hasKey: false, keySource: null, ready: true, images: false, contextWindow: 4096 },
    ]);
    // Only a short prefix of a key ever reaches the page.
    const text = JSON.stringify(statuses);
    for (const key of ['sk-env-openai-1234567890', 'sk-ant-stored-1234567890', 'sk-stored-openai-1234567890', '1234567890']) {
      expect(text).not.toContain(key);
    }
    expect((await r.resolve('openai'))!.apiKey).toBe('sk-env-openai-1234567890');
  });

  it('lists the models of ready providers, provider-qualified, cached, with Anthropic\'s suggested default', async () => {
    const { fetch, calls } = fakeFetch({
      'https://api.anthropic.com/v1/models': json(ANTHROPIC_LIST),
      'http://localhost:11434/v1/models': json({ data: [{ id: 'llama3:8b' }] }),
    });
    let now = 1000;
    const r = registry({ env: { ANTHROPIC_API_KEY: 'sk-ant-env-1234567890' }, prefs: { agent: { providers: [OLLAMA] } }, fetch, now: () => now });
    const models = await r.models();
    expect(models.map((m) => m.id)).toEqual(['anthropic/claude-opus-5-5', 'anthropic/claude-haiku-4-5-20251001', 'ollama/llama3:8b', 'ollama/qwen3-vl:4b']);
    expect(models[0]).toMatchObject({ provider: 'anthropic', label: 'Claude Opus 5.5', isDefault: true, efforts: ['low', 'medium', 'high', 'xhigh', 'max'], defaultEffort: 'high', acceptsImages: true, contextWindow: 1_000_000 });
    expect(models[2]).toEqual({ id: 'ollama/llama3:8b', label: 'llama3:8b', provider: 'ollama', acceptsImages: false });
    // The key went in the header the provider expects, the local server got none.
    expect(calls[0].headers['x-api-key']).toBe('sk-ant-env-1234567890');
    expect(calls[1].headers.authorization).toBeUndefined();
    await r.models();
    expect(calls).toHaveLength(2);
    now += 6 * 60 * 1000;
    await r.models();
    expect(calls).toHaveLength(4);
  });

  it('falls back to the suggested default or the entry\'s own models, and says when a key was refused', async () => {
    const { fetch } = fakeFetch({
      'https://api.anthropic.com/v1/models': json({ type: 'error', error: { type: 'authentication_error' } }, 401),
    });
    const r = registry({ env: { ANTHROPIC_API_KEY: 'sk-ant-bad-1234567890' }, prefs: { agent: { providers: [OLLAMA] } }, fetch });
    const models = await r.models();
    expect(models.map((m) => m.id)).toEqual(['anthropic/claude-opus-5-5', 'ollama/qwen3-vl:4b']);
    expect(models[0].isDefault).toBe(true);
    const anthropic = (await r.statuses())[0];
    expect(anthropic).toMatchObject({ ready: true, problem: 'The API key was refused (HTTP 401).' });
  });

  it('stores and deletes keys, refusing unknown ids, keys from the environment and bad keys', async () => {
    const { fetch, calls } = fakeFetch({ 'https://api.openai.com/v1/models': json({ data: [{ id: 'gpt-5.4' }] }) });
    const r = registry({ env: { ANTHROPIC_API_KEY: 'sk-ant-env-1234567890' }, prefs: { agent: { providers: [OLLAMA] } }, fetch });
    await expect(r.setKey('nope', 'sk-x-12345678')).rejects.toMatchObject({ reason: 'not-found' });
    await expect(r.setKey('anthropic', 'sk-x-12345678')).rejects.toMatchObject({ reason: 'env' });
    await expect(r.setKey('openai', 'two words')).rejects.toBeInstanceOf(ProviderKeyError);
    await expect(r.deleteKey('nope')).rejects.toMatchObject({ reason: 'not-found' });
    expect((await r.models()).some((m) => m.provider === 'openai')).toBe(false);
    await r.setKey('openai', ' sk-openai-stored-1234567890 ');
    expect(r.credentials.stored('openai')).toBe('sk-openai-stored-1234567890');
    expect((await r.models()).map((m) => m.id)).toContain('openai/gpt-5.4');
    // A custom entry's key is optional, and stored the same way.
    await r.setKey('ollama', 'local-key');
    expect((await r.statuses()).find((s) => s.id === 'ollama')).toMatchObject({ hasKey: true, keySource: 'stored' });
    const before = calls.length;
    await r.deleteKey('openai');
    expect((await r.statuses()).find((s) => s.id === 'openai')).toMatchObject({ hasKey: false, ready: false });
    expect(calls.length).toBe(before);
  });

  it('refuses a model on a provider that is not ready, as a sign-in problem', async () => {
    const r = registry();
    await expect(r.forModel('anthropic')).rejects.toMatchObject({ error: { kind: 'auth', message: 'Anthropic API has no API key. Add one in Settings → Agent.' } });
    await expect(r.forModel('ghost')).rejects.toMatchObject({ error: { kind: 'other' } });
  });
});

const anthropic: ResolvedProvider = { id: 'anthropic', kind: 'anthropic', label: 'Anthropic API', builtIn: true, apiKey: 'sk-ant-api03-secretsecretsecret', keySource: 'stored', images: true };
const ollama: ResolvedProvider = { id: 'ollama', kind: 'openai-compatible', label: 'Ollama', builtIn: false, baseURL: 'http://localhost:11434/v1', apiKey: null, keySource: null, images: false };

function apiError(statusCode: number | undefined, body?: unknown, extra: Partial<ConstructorParameters<typeof APICallError>[0]> = {}): APICallError {
  return new APICallError({ message: 'request failed', url: 'https://api.anthropic.com/v1/messages', requestBodyValues: {}, statusCode, responseBody: body === undefined ? undefined : JSON.stringify(body), ...extra });
}

describe('provider errors', () => {
  const ctx = { label: anthropic.label, kind: anthropic.kind, builtIn: true, apiKey: anthropic.apiKey };

  it('names where to change a refused key, and never shows it', () => {
    const e = mapProviderError(apiError(401, { error: { type: 'authentication_error', message: `invalid x-api-key ${anthropic.apiKey}` } }), ctx);
    expect(e).toEqual({ kind: 'auth', message: 'The Anthropic API key was refused. Change it in Settings → Agent.' });
    expect(mapProviderError(new LoadAPIKeyError({ message: 'x' }), ctx).kind).toBe('auth');
  });

  it('reports a rate limit with its reset, and unwraps retries', () => {
    const e = mapProviderError(new RetryError({ message: 'Failed after 3 attempts', reason: 'maxRetriesExceeded', errors: [apiError(429, { error: { message: 'Rate limited.' } }, { responseHeaders: { 'retry-after': '30' } })] }), ctx);
    expect(e.kind).toBe('rate-limit');
    expect(e.message).toBe('Anthropic API is limiting requests: Rate limited.');
    expect(Date.parse(e.resetsAt!)).toBeGreaterThan(Date.now());
  });

  it('names an unreachable local server\'s URL', () => {
    const refused = apiError(undefined, undefined, { message: 'Cannot connect to API: connect ECONNREFUSED 127.0.0.1:11434', url: 'http://localhost:11434/v1/chat/completions', isRetryable: true });
    expect(mapProviderError(refused, { label: 'Ollama', kind: 'openai-compatible', builtIn: false, baseURL: ollama.baseURL })).toEqual({
      kind: 'other',
      message: 'Could not reach Ollama at http://localhost:11434/v1. Is the server running?',
    });
  });

  it('says when the conversation no longer fits, and otherwise passes the provider\'s words without the key', () => {
    expect(mapProviderError(apiError(400, { error: { message: 'prompt is too long: 1000001 tokens > 1000000 maximum' } }), ctx).message).toContain('context window');
    const other = mapProviderError(apiError(500, { error: { message: `Overloaded, key ${anthropic.apiKey} and sk-proj-AAAAAAAAAAAAAAAAAAAA` } }), ctx);
    expect(other.kind).toBe('other');
    expect(other.message).toBe('Anthropic API: Overloaded, key [key] and [key] (HTTP 500)');
    expect(redact('Authorization: Bearer abc.def', {})).toBe('Authorization: Bearer [key]');
  });
});

describe('provider options and images', () => {
  it('asks Anthropic for summarized adaptive thinking, the effort and caching, and no temperature', () => {
    const info = { id: 'claude-opus-5-5', acceptsImages: true, efforts: ['low', 'high'], adaptiveThinking: true };
    expect(providerOptionsFor(anthropic, info, 'high')).toEqual({
      anthropic: { thinking: { type: 'adaptive', display: 'summarized' }, effort: 'high', cacheControl: { type: 'ephemeral' } },
    });
    // An effort the model does not list is left out.
    expect(providerOptionsFor(anthropic, info, 'max')).toEqual({ anthropic: { thinking: { type: 'adaptive', display: 'summarized' }, cacheControl: { type: 'ephemeral' } } });
    expect(systemMessage(anthropic, 'Be brief.')).toEqual({ role: 'system', content: 'Be brief.', providerOptions: { anthropic: { cacheControl: { type: 'ephemeral' } } } });
    expect(systemMessage(ollama, 'Be brief.')).toEqual({ role: 'system', content: 'Be brief.' });
  });

  it('asks OpenAI reasoning models for summaries and keeps nothing on OpenAI\'s side', () => {
    const openai: ResolvedProvider = { ...anthropic, id: 'openai', kind: 'openai', label: 'OpenAI API' };
    expect(providerOptionsFor(openai, { id: 'gpt-5.4', acceptsImages: true, reasoning: true, efforts: ['low', 'medium', 'high'] }, 'low')).toEqual({
      openai: { store: false, include: ['reasoning.encrypted_content'], reasoningSummary: 'auto', reasoningEffort: 'low' },
    });
    expect(providerOptionsFor(openai, { id: 'gpt-4.1', acceptsImages: true }, 'low')).toEqual({ openai: { store: false } });
    expect(providerOptionsFor(ollama, { id: 'qwen3-vl:4b', acceptsImages: false }, 'low')).toEqual({});
  });

  it('replaces images with a note for a model without images, never base64 as text', () => {
    const messages: ModelMessage[] = [
      { role: 'user', content: [{ type: 'text', text: 'look' }, { type: 'file', mediaType: 'image/png', data: 'iVBORw0KGgo=' }] },
      { role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'c1', toolName: 'screenshot', input: {} }] },
      {
        role: 'tool',
        content: [{
          type: 'tool-result', toolCallId: 'c1', toolName: 'screenshot',
          output: { type: 'content', value: [{ type: 'text', text: 'Captured.' }, { type: 'file', mediaType: 'image/png', data: { type: 'data', data: 'iVBORw0KGgo=' } }] },
        }],
      },
    ];
    const out = withoutImages(messages);
    expect(JSON.stringify(out)).not.toContain('iVBORw0KGgo');
    expect(out[0].content).toEqual([{ type: 'text', text: 'look' }, { type: 'text', text: IMAGE_OMITTED_NOTE }]);
    expect((out[2].content as any)[0].output).toEqual({ type: 'text', value: `Captured.\n${IMAGE_OMITTED_NOTE}` });
    expect(withoutImages(out)).toBe(out);
  });

  it('moves tool-result images into a user message for OpenAI-compatible servers', () => {
    const image = { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } };
    const body = moveToolImagesToUserMessages({
      model: 'qwen3-vl:4b',
      messages: [
        { role: 'user', content: 'go' },
        { role: 'assistant', content: '', tool_calls: [{ id: 'a' }, { id: 'b' }] },
        { role: 'tool', tool_call_id: 'a', content: [{ type: 'text', text: 'Shot 1.' }, image] },
        { role: 'tool', tool_call_id: 'b', content: [{ type: 'text', text: 'Summary.' }] },
        { role: 'assistant', content: 'Done.' },
      ],
    });
    expect(body.messages.map((m: any) => m.role)).toEqual(['user', 'assistant', 'tool', 'tool', 'user', 'assistant']);
    expect(body.messages[2].content).toEqual([{ type: 'text', text: 'Shot 1.' }]);
    expect(body.messages[4].content).toEqual([{ type: 'text', text: 'The images the tool calls above returned:' }, image]);
  });
});

describe('the model history file', () => {
  it('round-trips messages atomically, binary data as base64', () => {
    const file = path.join(dir, 'api-history.json');
    const messages: ModelMessage[] = [
      { role: 'user', content: [{ type: 'text', text: 'hi' }, { type: 'file', mediaType: 'image/png', data: new Uint8Array([1, 2, 3]) }] },
      { role: 'assistant', content: [{ type: 'reasoning', text: 'hm', providerOptions: { anthropic: { signature: 'sig' } } }, { type: 'text', text: 'Hello.' }] },
    ];
    writeHistory(file, 'anthropic', messages);
    expect(fs.readdirSync(dir)).toEqual(['api-history.json']);
    const read = readHistory(file)!;
    expect(read.provider).toBe('anthropic');
    expect((read.messages[0].content as any)[1].data).toBe('AQID');
    expect(read.messages[1]).toEqual(messages[1]);
    fs.writeFileSync(file, '{ torn');
    expect(readHistory(file)).toBeNull();
    expect(readHistory(path.join(dir, 'missing.json'))).toBeNull();
  });
});
