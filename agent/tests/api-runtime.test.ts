import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { APICallError } from 'ai';
import { MockLanguageModelV4, simulateReadableStream } from 'ai/test';
import { AgentCredentials } from '../../server/dist/agent-credentials.js';
import { ApiBackend } from '../src/api/api-backend.ts';
import { readHistory } from '../src/api/history.ts';
import { ProviderRegistry } from '../src/api/providers.ts';
import { composeInstructions } from '../src/instructions.ts';
import { createRuntimeRouter } from '../src/router.ts';
import { AgentRuntime } from '../src/runtime.ts';
import type { ChatPart, SessionSnapshot, ToolPart } from '../src/types.ts';

// The API agent end to end (§20): a real runtime, router, MCP endpoint and
// gate; the model is the AI SDK's mock, scripted per request. The driver
// reaches FluidCAD's tools over the session's MCP URL, as in the app.

const KEY = 'sk-ant-api03-test-key-0123456789';
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8cfc0f01f0005000201c2a3a4f30000000049454e44ae426082', 'hex');
/** The start of a JPEG: all the engine looks at. */
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from('jpeg-body')]);

type Chunk = Record<string, any>;
const usage = (input = 100, output = 10) => ({ inputTokens: { total: input, noCache: input, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: output, text: output, reasoning: 0 } });
const finish = (unified: string, input?: number) => ({ type: 'finish', finishReason: { unified, raw: unified }, usage: usage(input) });
const text = (id: string, words: string): Chunk[] => [{ type: 'text-start', id }, { type: 'text-delta', id, delta: words }, { type: 'text-end', id }];
const toolCall = (id: string, toolName: string, input: unknown): Chunk => ({ type: 'tool-call', toolCallId: id, toolName, input: JSON.stringify(input) });

/** A mock model answering request n with `script[n]` (chunks, or an error to throw). */
class ScriptedModel {
  readonly script: (Chunk[] | Error | { chunks: Chunk[]; delayMs: number })[] = [];
  readonly model: MockLanguageModelV4;
  calls = 0;
  constructor() {
    this.model = new MockLanguageModelV4({
      provider: 'mock',
      modelId: 'mock',
      doStream: async () => {
        const next = this.script[this.calls++] ?? [...text('x', 'No script left.'), finish('stop')];
        if (next instanceof Error) {
          throw next;
        }
        const { chunks, delayMs } = Array.isArray(next) ? { chunks: next, delayMs: 0 } : next;
        return { stream: simulateReadableStream({ chunks: [{ type: 'stream-start', warnings: [] }, ...chunks] as any, chunkDelayInMs: delayMs }) };
      },
    });
  }
  get requests() {
    return this.model.doStreamCalls;
  }
}

let workspace: string;
let server: http.Server;
let base: string;
let runtime: AgentRuntime;
let scripted: ScriptedModel;
let prefs: any;
let env: NodeJS.ProcessEnv;
let credentials: AgentCredentials;
let modelRequests: { provider: string; model: string; images: boolean }[];

async function start(options: { stepLimit?: number; fetch?: typeof fetch; realModels?: boolean } = {}): Promise<void> {
  scripted = new ScriptedModel();
  modelRequests = [];
  const app = express();
  app.use(express.json({ limit: '50mb' }));
  app.get('/api/editor/dirty-files', (_req, res) => res.json([]));
  server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const port = (server.address() as AddressInfo).port;
  base = `http://127.0.0.1:${port}/api/agent`;
  const loadPreferences = async () => prefs;
  const providers = new ProviderRegistry({
    loadPreferences,
    env,
    credentials,
    // No network: every model list fails, and the providers fall back (§20.3).
    fetch: options.fetch ?? (options.realModels ? undefined : ((async () => { throw new TypeError('fetch failed'); }) as typeof fetch)),
  });
  const api = new ApiBackend({
    providers,
    stepLimit: options.stepLimit,
    // realModels: the provider packages themselves, against a server the test runs.
    ...(options.realModels
      ? {}
      : {
          createModel: (p, model, o) => {
            modelRequests.push({ provider: p.id, model, images: o.images });
            return scripted.model;
          },
        }),
  });
  runtime = new AgentRuntime(
    {
      workspacePath: workspace,
      port,
      version: '0.0.0',
      startedAt: new Date(0).toISOString(),
      currentFile: () => path.join(workspace, 'plate.part.js'),
      renderState: () => ({ state: 'rendered' }),
      unit: () => 'mm',
      loadPreferences,
    },
    { backends: { api }, providers, env },
  );
  app.use('/api/agent', createRuntimeRouter(runtime, { heartbeatMs: 50 }));
}

beforeEach(async () => {
  workspace = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fluidcad-api-runtime-')));
  credentials = new AgentCredentials(path.join(workspace, 'home', 'agent-credentials.json'));
  env = { ANTHROPIC_API_KEY: KEY };
  prefs = { agent: { defaultAgent: 'api', permissionMode: 'ask' } };
  await start();
});

afterEach(async () => {
  await runtime.shutdown();
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  fs.rmSync(workspace, { recursive: true, force: true });
});

async function json(method: string, url: string, body?: unknown): Promise<{ status: number; body: any }> {
  const res = await fetch(url, {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const raw = await res.text();
  return { status: res.status, body: raw ? JSON.parse(raw) : null };
}

async function until<T>(get: () => Promise<T> | T, check: (v: T) => boolean, ms = 8000): Promise<T> {
  const startAt = Date.now();
  for (;;) {
    const value = await get();
    if (check(value)) {
      return value;
    }
    if (Date.now() - startAt > ms) {
      throw new Error(`timed out; last value: ${JSON.stringify(value).slice(0, 800)}`);
    }
    await new Promise((r) => setTimeout(r, 20));
  }
}

const snapshot = async (id: string): Promise<SessionSnapshot> => (await json('GET', `${base}/sessions/${id}`)).body;
const settled = (id: string) => until(() => snapshot(id), (s) => !['running', 'starting', 'awaiting-approval'].includes(s.status.state));
const lastAssistant = (s: SessionSnapshot) => [...s.messages].reverse().find((m) => m.role === 'assistant')!;
const historyOf = (id: string) => readHistory(path.join(workspace, '.fluidcad', 'agent', 'sessions', id, 'api-history.json'));

async function newSession(): Promise<string> {
  const created = await json('POST', `${base}/sessions`, { agent: 'api' });
  expect(created.status).toBe(201);
  return created.body.id;
}

describe('the API agent', () => {
  it('runs a turn on the model, its FluidCAD tool calls reported by the gate only, and keeps the history', async () => {
    scripted.script.push(
      [{ type: 'reasoning-start', id: 'r' }, { type: 'reasoning-delta', id: 'r', delta: 'Read the skill.' }, { type: 'reasoning-end', id: 'r' }, ...text('0', 'Let me look.'), toolCall('c1', 'read_skill', { name: 'fluidcad' }), finish('tool-calls', 120)],
      [...text('0', 'A plate.'), finish('stop', 150)],
    );
    const id = await newSession();
    const sent = await json('POST', `${base}/sessions/${id}/messages`, { text: 'what is this?', model: 'anthropic/claude-opus-5-5', effort: 'high' });
    expect(sent.status).toBe(202);
    const done = await settled(id);
    expect(done.status).toEqual({ state: 'idle' });
    expect(done).toMatchObject({ agent: 'api', model: 'anthropic/claude-opus-5-5', effort: 'high' });

    const assistant = lastAssistant(done);
    expect(assistant.parts.map((p) => p.type)).toEqual(['reasoning', 'text', 'tool', 'text']);
    expect(assistant.parts[0]).toMatchObject({ text: 'Read the skill.' });
    expect(assistant.parts[1]).toMatchObject({ text: 'Let me look.' });
    expect(assistant.parts[2]).toMatchObject({ source: 'fluidcad', name: 'read_skill', state: 'done', kind: 'read' });
    expect((assistant.parts[2] as ToolPart).output?.text).toContain('FluidCAD');
    expect(assistant.parts[3]).toMatchObject({ text: 'A plate.' });
    expect(assistant.parts.some((p: ChatPart) => p.type === 'tool' && p.source === 'agent')).toBe(false);
    expect(done.turns[0]).toMatchObject({ endReason: 'done', usage: { inputTokens: 270, outputTokens: 20 } });
    // The session list names the provider-qualified model.
    expect((await json('GET', `${base}/sessions`)).body.sessions[0]).toMatchObject({ id, agent: 'api', model: 'anthropic/claude-opus-5-5' });

    // What the model got: the API agent's instructions (cached), the tools, the options, the user's words with the state.
    const first = scripted.requests[0] as any;
    expect(first.prompt[0]).toEqual({ role: 'system', content: composeInstructions('api'), providerOptions: { anthropic: { cacheControl: { type: 'ephemeral' } } } });
    expect(composeInstructions('api')).toContain('Read files with read_file.');
    expect(composeInstructions('api')).not.toContain('fluidcad_app');
    expect(first.tools.map((t: any) => t.name)).toContain('write_file');
    // FluidCAD's 43 tools, and the three only a chat offers: ask_user (§22), propose_variants (§24) and offer_params (§26).
    expect(first.tools.map((t: any) => t.name)).toContain('ask_user');
    expect(first.tools.map((t: any) => t.name)).toContain('propose_variants');
    expect(first.tools.map((t: any) => t.name)).toContain('offer_params');
    expect(first.tools).toHaveLength(46);
    expect(first.providerOptions.anthropic.cacheControl).toEqual({ type: 'ephemeral' });
    expect(first.temperature).toBeUndefined();
    expect(JSON.stringify(first.prompt[1])).toContain('<workspace_state');
    expect(modelRequests[0]).toEqual({ provider: 'anthropic', model: 'claude-opus-5-5', images: true });

    // The history beside session.json: the user, then each step's messages.
    const record = runtime.get(id)!.record;
    expect(record.agent.ref).toBe('api-history.json');
    const history = historyOf(id)!;
    expect(history.provider).toBe('anthropic');
    expect(history.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'tool', 'assistant']);

    // The next turn replays it.
    scripted.script.push([...text('0', 'Still a plate.'), finish('stop')]);
    await json('POST', `${base}/sessions/${id}/messages`, { text: 'and now?' });
    await settled(id);
    const third = scripted.requests[2] as any;
    expect(third.prompt.map((m: any) => m.role)).toEqual(['system', 'user', 'assistant', 'tool', 'assistant', 'user']);
    // No model named: the chat kept its own.
    expect((await snapshot(id)).model).toBe('anthropic/claude-opus-5-5');

    // Another model of the same provider: a new run, which loads the history from disk.
    scripted.script.push([...text('0', 'Haiku here.'), finish('stop')]);
    await json('POST', `${base}/sessions/${id}/messages`, { text: 'short answer', model: 'anthropic/claude-haiku-5-5' });
    const after = await settled(id);
    expect(after.model).toBe('anthropic/claude-haiku-5-5');
    // The second message named no effort (a new run, as for the CLIs), the third another model.
    expect(modelRequests.map((r) => r.model)).toEqual(['claude-opus-5-5', 'claude-opus-5-5', 'claude-haiku-5-5']);
    expect((scripted.requests[3] as any).prompt.map((m: any) => m.role)).toEqual(['system', 'user', 'assistant', 'tool', 'assistant', 'user', 'assistant', 'user']);

    // A chat stays on its provider (§20.1).
    const other = await json('POST', `${base}/sessions/${id}/messages`, { text: 'x', model: 'openai/gpt-5.4' });
    expect(other.status).toBe(400);
    expect(other.body.error).toContain('start a new chat');
    expect((await json('POST', `${base}/sessions/${id}/messages`, { text: 'x', model: 'claude-opus-5-5' })).status).toBe(400);
  });

  it('ends a turn whose key is refused as a sign-in problem, without the key, and forgets the message for the model', async () => {
    scripted.script.push(
      new APICallError({
        message: 'invalid x-api-key',
        url: 'https://api.anthropic.com/v1/messages',
        requestBodyValues: {},
        statusCode: 401,
        responseBody: JSON.stringify({ type: 'error', error: { type: 'authentication_error', message: `invalid x-api-key ${KEY}` } }),
      }),
    );
    const id = await newSession();
    await json('POST', `${base}/sessions/${id}/messages`, { text: 'hello', model: 'anthropic/claude-opus-5-5' });
    const done = await settled(id);
    expect(done.status).toEqual({ state: 'error', kind: 'auth', message: 'The Anthropic API key was refused. Change it in Settings → Agent.' });
    expect(JSON.stringify(done)).not.toContain(KEY);
    expect(historyOf(id)?.messages ?? []).toEqual([]);

    // A chat on a provider with no key fails as a sign-in problem too.
    const id2 = await newSession();
    await json('POST', `${base}/sessions/${id2}/messages`, { text: 'hello', model: 'openai/gpt-5.4' });
    expect((await settled(id2)).status).toEqual({ state: 'error', kind: 'auth', message: 'OpenAI API has no API key. Add one in Settings → Agent.' });
  });

  it('says no provider is ready when none is', async () => {
    env = {};
    await runtime.shutdown();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await start();
    const agents = (await json('GET', `${base}/agents`)).body.agents;
    const api = agents.find((a: any) => a.kind === 'api');
    expect(api).toMatchObject({ kind: 'api', path: null, version: null, minVersion: '', supported: true, loggedIn: false, problem: expect.stringContaining('Settings → Agent') });
    expect(api.providers.map((p: any) => [p.id, p.ready])).toEqual([['anthropic', false], ['openai', false], ['openrouter', false]]);
    const id = await newSession();
    await json('POST', `${base}/sessions/${id}/messages`, { text: 'hello', model: 'anthropic/claude-opus-5-5' });
    expect((await settled(id)).status).toMatchObject({ state: 'error', kind: 'auth' });
  });

  it('stops a turn mid-reply, keeps what was said for the model and carries on', async () => {
    scripted.script.push({ chunks: [{ type: 'text-start', id: '0' }, ...Array.from({ length: 200 }, (_, i) => ({ type: 'text-delta', id: '0', delta: `w${i} ` })), { type: 'text-end', id: '0' }, finish('stop')], delayMs: 20 });
    const id = await newSession();
    await json('POST', `${base}/sessions/${id}/messages`, { text: 'talk', model: 'anthropic/claude-opus-5-5' });
    await until(() => snapshot(id), (s) => s.messages.some((m) => m.role === 'assistant' && m.parts.some((p) => p.type === 'text' && p.text.length > 10)));
    expect((await json('POST', `${base}/sessions/${id}/cancel`)).status).toBe(204);
    const done = await settled(id);
    expect(done.status).toEqual({ state: 'idle' });
    expect(done.turns[0].endReason).toBe('interrupted');
    const history = historyOf(id)!.messages;
    expect(history.map((m) => m.role)).toEqual(['user', 'assistant']);
    expect(JSON.stringify(history[1])).toContain('[Stopped by the user.]');

    scripted.script.push([...text('0', 'OK.'), finish('stop')]);
    await json('POST', `${base}/sessions/${id}/messages`, { text: 'go on' });
    expect((await settled(id)).status).toEqual({ state: 'idle' });
    expect((scripted.requests[1] as any).prompt.map((m: any) => m.role)).toEqual(['system', 'user', 'assistant', 'user']);
  });

  it('settles a pending approval on cancel and closes its MCP session, so the call never runs', async () => {
    const file = path.join(workspace, 'plate.part.js');
    fs.writeFileSync(file, 'export const a = 1;\n');
    scripted.script.push([toolCall('c1', 'write_file', { path: file, content: 'export const a = 2;\n' }), finish('tool-calls')]);
    const id = await newSession();
    await json('POST', `${base}/sessions/${id}/messages`, { text: 'change it', model: 'anthropic/claude-opus-5-5', mode: 'ask' });
    await until(() => snapshot(id), (s) => s.status.state === 'awaiting-approval');
    const endpoint = runtime.get(id)!.mcpEndpoint!;
    expect(endpoint.sessionCount).toBe(1);
    await json('POST', `${base}/sessions/${id}/cancel`);
    const done = await settled(id);
    expect(done.turns[0].endReason).toBe('interrupted');
    const card = lastAssistant(done).parts.find((p): p is ToolPart => p.type === 'tool')!;
    expect(card).toMatchObject({ name: 'write_file', source: 'fluidcad' });
    expect(['error', 'denied']).toContain(card.state);
    expect(fs.readFileSync(file, 'utf8')).toBe('export const a = 1;\n');
    await until(() => endpoint.sessionCount, (n) => n === 0);
    const history = historyOf(id)!.messages;
    expect(JSON.stringify(history[history.length - 1])).toContain('while calling write_file');
  });

  it('stops at the step limit and says so', async () => {
    await runtime.shutdown();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await start({ stepLimit: 2 });
    scripted.script.push([toolCall('c1', 'list_docs', {}), finish('tool-calls')], [toolCall('c2', 'list_docs', {}), finish('tool-calls')]);
    const id = await newSession();
    await json('POST', `${base}/sessions/${id}/messages`, { text: 'loop', model: 'anthropic/claude-opus-5-5' });
    const done = await settled(id);
    expect(scripted.calls).toBe(2);
    expect(lastAssistant(done).parts.filter((p) => p.type === 'notice').map((p: any) => p.text)).toEqual(['Stopped after 2 model steps in one turn. Send "continue" to let it carry on.']);
  });

  it('leaves images out for a model that does not take them, and warns when the server\'s context is too small', async () => {
    prefs.agent.providers = [{ id: 'ollama', kind: 'openai-compatible', label: 'Ollama', baseURL: 'http://127.0.0.1:9/v1', models: ['qwen3-vl:4b'], contextWindow: 4096 }];
    scripted.script.push([...text('0', 'Hi.'), finish('stop', 4096)]);
    const id = await newSession();
    const sent = await json('POST', `${base}/sessions/${id}/messages`, {
      text: 'look',
      model: 'ollama/qwen3-vl:4b',
      attachments: [{ mediaType: 'image/jpeg', base64: JPEG.toString('base64'), name: 'drawing.jpg' }],
      image: { mediaType: 'image/png', base64: PNG.toString('base64') },
    });
    expect(sent.status).toBe(202);
    const done = await settled(id);
    expect(modelRequests[0]).toEqual({ provider: 'ollama', model: 'qwen3-vl:4b', images: false });
    const user = (scripted.requests[0] as any).prompt[1];
    expect(user.content.map((p: any) => p.type)).toEqual(['text']);
    expect(user.content[0].text).toContain('(The 2 images of this message are not attached: this model does not take images.)');
    const notices = lastAssistant(done).parts.filter((p) => p.type === 'notice').map((p: any) => p.text);
    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain('context of 4096 tokens');
  });
});

describe('provider routes', () => {
  it('lists providers, stores a key at 0600, refuses one the environment sets, and deletes it', async () => {
    prefs.agent.providers = [{ id: 'lm-studio', kind: 'openai-compatible', label: 'LM Studio', baseURL: 'http://localhost:1234/v1', images: false }];
    const list = await json('GET', `${base}/providers`);
    expect(list.status).toBe(200);
    expect(list.body.providers.map((p: any) => [p.id, p.keySource, p.ready])).toEqual([['anthropic', 'env', true], ['openai', null, false], ['openrouter', null, false], ['lm-studio', null, true]]);
    expect(JSON.stringify(list.body)).not.toContain(KEY);

    expect((await json('PUT', `${base}/providers/openai/key`, { apiKey: 'sk-openai-0123456789' })).status).toBe(204);
    if (process.platform !== 'win32') {
      expect(fs.statSync(credentials.filePath).mode & 0o777).toBe(0o600);
    }
    expect((await json('GET', `${base}/providers`)).body.providers[1]).toMatchObject({ id: 'openai', hasKey: true, keySource: 'stored', ready: true });
    // A custom entry saved a moment ago takes a key at once.
    expect((await json('PUT', `${base}/providers/lm-studio/key`, { apiKey: 'local' })).status).toBe(204);

    const fromEnv = await json('PUT', `${base}/providers/anthropic/key`, { apiKey: 'sk-ant-other-0123456789' });
    expect(fromEnv.status).toBe(409);
    expect(fromEnv.body.error).toContain('ANTHROPIC_API_KEY');
    expect((await json('PUT', `${base}/providers/nope/key`, { apiKey: 'sk-x' })).status).toBe(404);
    expect((await json('PUT', `${base}/providers/openai/key`, { apiKey: '' })).status).toBe(400);
    expect((await json('PUT', `${base}/providers/openai/key`, { apiKey: 'x'.repeat(513) })).status).toBe(400);
    const spaced = await json('PUT', `${base}/providers/openai/key`, { apiKey: 'two words' });
    expect(spaced.status).toBe(400);
    expect(spaced.body.error).not.toContain('two words');

    expect((await json('DELETE', `${base}/providers/openai/key`)).status).toBe(204);
    expect(credentials.stored('openai')).toBeNull();
    expect((await json('DELETE', `${base}/providers/nope/key`)).status).toBe(404);
  });

  it('lists the models of the ready providers', async () => {
    await runtime.shutdown();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await start({
      fetch: (async (url: any) => {
        if (String(url).startsWith('https://api.anthropic.com/v1/models')) {
          return new Response(JSON.stringify({ data: [{ id: 'claude-opus-5-5', display_name: 'Claude Opus 5.5' }, { id: 'claude-haiku-5-5', display_name: 'Claude Haiku 5.5' }] }), { status: 200 });
        }
        throw new TypeError('fetch failed');
      }) as typeof fetch,
    });
    const models = await json('GET', `${base}/agents/api/models`);
    expect(models.status).toBe(200);
    expect(models.body.models).toEqual([
      { id: 'anthropic/claude-opus-5-5', label: 'Claude Opus 5.5', provider: 'anthropic', acceptsImages: true, isDefault: true },
      { id: 'anthropic/claude-haiku-5-5', label: 'Claude Haiku 5.5', provider: 'anthropic', acceptsImages: true },
    ]);
  });
});

/**
 * A local OpenAI-compatible server (what Ollama or LM Studio answer), with
 * its replies scripted per request: no network, no model.
 */
async function fakeCompatibleServer(replies: object[][]): Promise<{ url: string; requests: any[]; close(): Promise<void> }> {
  const requests: any[] = [];
  const app = express();
  app.use(express.json({ limit: '50mb' }));
  app.get('/v1/models', (_req, res) => res.json({ object: 'list', data: [{ id: 'tiny:1b', object: 'model' }] }));
  app.post('/v1/chat/completions', (req, res) => {
    requests.push(req.body);
    const chunks = replies[requests.length - 1] ?? [];
    res.setHeader('content-type', 'text/event-stream');
    for (const chunk of chunks) {
      res.write(`data: ${JSON.stringify({ id: 'x', object: 'chat.completion.chunk', created: 1, model: req.body.model, ...chunk })}\n\n`);
    }
    res.end('data: [DONE]\n\n');
  });
  const fake = http.createServer(app);
  await new Promise<void>((resolve) => fake.listen(0, '127.0.0.1', () => resolve()));
  return {
    url: `http://127.0.0.1:${(fake.address() as AddressInfo).port}/v1`,
    requests,
    close: () => new Promise<void>((resolve) => {
      fake.closeAllConnections();
      fake.close(() => resolve());
    }),
  };
}

const delta = (d: object, finish: string | null = null) => ({ choices: [{ index: 0, delta: d, finish_reason: finish }] });
const usageChunk = (prompt: number, completion: number) => ({ choices: [], usage: { prompt_tokens: prompt, completion_tokens: completion, total_tokens: prompt + completion } });

describe('the API agent on a local OpenAI-compatible server', () => {
  async function restartReal(): Promise<void> {
    await runtime.shutdown();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await start({ realModels: true });
  }

  it('lists its models, sends the capture as an image, runs a tool call through the gate and warns of a cut prompt', async () => {
    const local = await fakeCompatibleServer([
      [
        delta({ role: 'assistant', reasoning: 'I should read the skill.' }),
        delta({ tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'read_skill', arguments: JSON.stringify({ name: 'fluidcad' }) } }] }),
        delta({}, 'tool_calls'),
        // A server with a 4k context reports what it read.
        usageChunk(4096, 12),
      ],
      [delta({ role: 'assistant', content: 'A plate.' }), delta({}, 'stop'), usageChunk(4096, 3)],
    ]);
    try {
      prefs.agent.providers = [{ id: 'lm-studio', kind: 'openai-compatible', label: 'LM Studio', baseURL: local.url, images: true }];
      credentials.write('lm-studio', 'local-key-123');
      await restartReal();
      const models = (await json('GET', `${base}/agents/api/models`)).body.models.filter((m: any) => m.provider === 'lm-studio');
      expect(models).toEqual([{ id: 'lm-studio/tiny:1b', label: 'tiny:1b', provider: 'lm-studio', acceptsImages: true }]);

      const id = await newSession();
      await json('POST', `${base}/sessions/${id}/messages`, {
        text: 'what is this?',
        model: 'lm-studio/tiny:1b',
        attachments: [{ mediaType: 'image/jpeg', base64: JPEG.toString('base64'), name: 'drawing.jpg' }],
        image: { mediaType: 'image/png', base64: PNG.toString('base64') },
      });
      const done = await settled(id);
      expect(done.status).toEqual({ state: 'idle' });
      const assistant = lastAssistant(done);
      expect(assistant.parts.map((p) => p.type)).toEqual(['reasoning', 'tool', 'notice', 'text']);
      expect(assistant.parts[1]).toMatchObject({ source: 'fluidcad', name: 'read_skill', state: 'done' });
      expect((assistant.parts[2] as any).text).toContain('LM Studio read only 4096 tokens');
      expect(done.turns[0].usage).toEqual({ inputTokens: 8192, outputTokens: 15 });

      const [first, second] = local.requests;
      expect(first.model).toBe('tiny:1b');
      expect(first.stream_options).toEqual({ include_usage: true });
      expect(first.temperature).toBeUndefined();
      expect(first.tools).toHaveLength(46);
      expect(first.messages[0]).toEqual({ role: 'system', content: composeInstructions('api') });
      // The user's image and the capture went with their words, each under its own type.
      expect(first.messages[1].role).toBe('user');
      expect(first.messages[1].content.map((p: any) => p.type)).toEqual(['text', 'image_url', 'image_url']);
      expect(first.messages[1].content.slice(1).map((p: any) => p.image_url.url.split(';')[0])).toEqual(['data:image/jpeg', 'data:image/png']);
      expect(first.messages[1].content[0].text).toContain('<attached_images count="1">\n  1: drawing.jpg\n</attached_images>');
      // The tool's result went back as content parts (images would follow in a user message).
      const tool = second.messages.find((m: any) => m.role === 'tool');
      expect(tool.tool_call_id).toBe('call_1');
      expect(Array.isArray(tool.content)).toBe(true);
      expect(tool.content[0].type).toBe('text');
      expect(JSON.stringify(local.requests)).not.toContain('local-key-123');
    } finally {
      await local.close();
    }
  });

  it('names the URL of a server that is not running', async () => {
    const local = await fakeCompatibleServer([]);
    const url = local.url;
    await local.close();
    prefs.agent.providers = [{ id: 'ollama', kind: 'openai-compatible', label: 'Ollama', baseURL: url, models: ['qwen3-vl:4b'] }];
    await restartReal();
    const id = await newSession();
    await json('POST', `${base}/sessions/${id}/messages`, { text: 'hello', model: 'ollama/qwen3-vl:4b' });
    expect((await settled(id)).status).toEqual({ state: 'error', kind: 'other', message: `Could not reach Ollama at ${url}. Is the server running?` });
  });
});
