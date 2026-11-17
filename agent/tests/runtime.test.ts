import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { AsyncQueue } from '../src/async-queue.ts';
import type { AgentBackend, AgentInstall, AgentRun, BackendEvent, OpenOptions } from '../src/backend.ts';
import { AgentRuntime } from '../src/runtime.ts';
import { createRuntimeRouter } from '../src/router.ts';
import { McpEndpoints } from '../src/mcp-endpoint.ts';
import { RESTART_REASON } from '../src/session.ts';
import { SessionStore, type SessionRecord } from '../src/session-store.ts';
import { NO_TURN_MESSAGE, STOPPED_MESSAGE } from '../src/tool-gate.ts';
import type { ChatEventEnvelope, SessionSnapshot, ToolPart } from '../src/types.ts';

// The runtime end to end, with a fake backend in place of a CLI: the fake run
// connects to the session's MCP endpoint over HTTP the way Claude Code does,
// calls tools, and streams a reply.

const INSTALL: AgentInstall = { kind: 'claude', path: '/fake/claude', version: '2.1.326', minVersion: '2.1.259', supported: true, loggedIn: true, authMethod: 'claude.ai' };

class FakeRun implements AgentRun {
  readonly ref: string;
  readonly queue = new AsyncQueue<BackendEvent>();
  readonly sent: string[] = [];
  /** What each scripted tool call returned to the "model". */
  readonly results: any[] = [];
  closed = false;
  client: Client | null = null;
  private interrupted: (() => void) | null = null;
  private scripted: { stopped: boolean } | null = null;

  constructor(private readonly opts: OpenOptions) {
    this.ref = opts.resume ?? `ref-${Math.random().toString(16).slice(2)}`;
  }

  get events(): AsyncIterable<BackendEvent> {
    return this.queue;
  }

  send(input: { text: string; imagePath?: string }): void {
    this.sent.push(input.text);
    void this.turn(input.text);
  }

  private async turn(text: string): Promise<void> {
    if (text.startsWith('calls ')) {
      // `calls [{ name, arguments }, …]` on the first line: make those tool
      // calls in order, as a model would, then answer and end the turn.
      const calls = JSON.parse(text.split('\n')[0].slice('calls '.length)) as { name: string; arguments: object }[];
      const script = { stopped: false };
      this.scripted = script;
      this.client ??= await connectMcp(this.opts.mcpUrl);
      for (const call of calls) {
        if (script.stopped) {
          return;
        }
        try {
          this.results.push(await this.client.callTool({ name: call.name, arguments: call.arguments as Record<string, unknown> }));
        } catch (e) {
          // The run was closed under the call (the test ended).
          this.results.push({ thrown: e });
          return;
        }
      }
      if (!script.stopped) {
        this.scripted = null;
        this.queue.push({ type: 'text-delta', id: 'b1', delta: 'Done.' });
        this.queue.push({ type: 'turn-end', reason: 'done' });
      }
      return;
    }
    if (text.startsWith('slow')) {
      this.queue.push({ type: 'text-delta', id: 'b0', delta: 'working…' });
      await new Promise<void>((resolve) => (this.interrupted = resolve));
      this.queue.push({ type: 'turn-end', reason: 'interrupted' });
      return;
    }
    if (text.startsWith('fail')) {
      this.queue.push({ type: 'turn-end', reason: 'error', error: { kind: 'rate-limit', message: 'Limit reached.', resetsAt: '2026-11-18T00:00:00.000Z' } });
      return;
    }
    this.client ??= await connectMcp(this.opts.mcpUrl);
    this.queue.push({ type: 'reasoning-delta', id: 'b0', delta: 'Let me look.' });
    this.queue.push({ type: 'block-end', id: 'b0' });
    await this.client.callTool({ name: 'read_skill', arguments: { name: 'fluidcad' } });
    this.queue.push({ type: 'tool', id: 'g1', name: 'Grep', title: 'Search: hole', state: 'running', input: { pattern: 'hole' } });
    this.queue.push({ type: 'tool', id: 'g1', name: 'Grep', title: 'Search: hole', state: 'done', output: 'a.fluid.js:3' });
    this.queue.push({ type: 'text-delta', id: 'b1', delta: 'A plate ' });
    this.queue.push({ type: 'text-delta', id: 'b1', delta: 'with four holes.' });
    this.queue.push({ type: 'usage', inputTokens: 10, outputTokens: 5, costUsd: 0.01 });
    this.queue.push({ type: 'turn-end', reason: 'done' });
  }

  async interrupt(): Promise<void> {
    this.interrupted?.();
    this.interrupted = null;
    if (this.scripted) {
      this.scripted.stopped = true;
      this.scripted = null;
      this.queue.push({ type: 'turn-end', reason: 'interrupted' });
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    await this.client?.close().catch(() => {});
    this.queue.end();
  }
}

class FakeBackend implements AgentBackend {
  readonly kind = 'claude' as const;
  readonly runs: FakeRun[] = [];
  readonly opened: OpenOptions[] = [];
  install: AgentInstall = INSTALL;
  async detect(): Promise<AgentInstall> {
    return this.install;
  }
  async models() {
    return [{ id: 'default', label: 'Default' }];
  }
  async open(opts: OpenOptions): Promise<AgentRun> {
    this.opened.push(opts);
    const run = new FakeRun(opts);
    this.runs.push(run);
    return run;
  }
}

async function connectMcp(url: string): Promise<Client> {
  const client = new Client({ name: 'fake-cli', version: '0.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(url)));
  return client;
}

let workspace: string;
let server: http.Server;
let base: string;
let runtime: AgentRuntime;
let backend: FakeBackend;
let prefs: any;
/** What this test engine reports as unsaved editor buffers (write_file asks before writing). */
let dirtyFiles: string[] = [];

async function start(options: { idleMs?: number } = {}): Promise<void> {
  backend = new FakeBackend();
  const app = express();
  app.use(express.json({ limit: '50mb' }));
  // The engine routes the MCP write tools use: dirty buffers only; the lint
  // and the render answer 404 (an older engine), and the tools carry on.
  app.get('/api/editor/dirty-files', (_req, res) => {
    res.json(dirtyFiles.map((p) => ({ path: p, lastModifiedMs: 0 })));
  });
  server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const port = (server.address() as AddressInfo).port;
  base = `http://127.0.0.1:${port}/api/agent`;
  runtime = new AgentRuntime(
    {
      workspacePath: workspace,
      port,
      version: '0.0.0',
      startedAt: new Date(0).toISOString(),
      currentFile: () => path.join(workspace, 'plate.part.js'),
      renderState: () => ({ state: 'rendered' }),
      unit: () => 'mm',
      loadPreferences: async () => prefs,
    },
    { backends: { claude: backend }, env: { PATH: '/bin', ANTHROPIC_API_KEY: 'sk-x' }, ...options },
  );
  app.use('/api/agent', createRuntimeRouter(runtime, { heartbeatMs: 50 }));
}

beforeEach(async () => {
  workspace = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fluidcad-agent-runtime-')));
  dirtyFiles = [];
  prefs = { agent: { defaultAgent: null, permissionMode: 'ask' } };
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
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

async function until<T>(get: () => Promise<T> | T, check: (v: T) => boolean, ms = 5000): Promise<T> {
  const startAt = Date.now();
  for (;;) {
    const value = await get();
    if (check(value)) {
      return value;
    }
    if (Date.now() - startAt > ms) {
      throw new Error(`timed out; last value: ${JSON.stringify(value).slice(0, 500)}`);
    }
    await new Promise((r) => setTimeout(r, 20));
  }
}

const snapshot = async (id: string): Promise<SessionSnapshot> => (await json('GET', `${base}/sessions/${id}`)).body;
const idle = (id: string) => until(() => snapshot(id), (s) => s.status.state !== 'running' && s.status.state !== 'starting');

type Sse = { events: ChatEventEnvelope[]; ids: string[]; comments: number; retry: string | null; close: () => void };

/** Reads an SSE stream until `done` holds (or `ms` passes). */
async function readSse(url: string, done: (s: Sse) => boolean, headers: Record<string, string> = {}, ms = 5000): Promise<Sse> {
  const controller = new AbortController();
  const res = await fetch(url, { headers, signal: controller.signal });
  expect(res.headers.get('content-type')).toContain('text/event-stream');
  const sse: Sse = { events: [], ids: [], comments: 0, retry: null, close: () => controller.abort() };
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const deadline = Date.now() + ms;
  try {
    while (!done(sse) && Date.now() < deadline) {
      const { value, done: ended } = await reader.read();
      if (ended) {
        break;
      }
      buffer += decoder.decode(value, { stream: true });
      let index: number;
      while ((index = buffer.indexOf('\n\n')) >= 0) {
        const block = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);
        for (const line of block.split('\n')) {
          if (line.startsWith(':')) {
            sse.comments += 1;
          } else if (line.startsWith('retry: ')) {
            sse.retry = line.slice(7);
          } else if (line.startsWith('id: ')) {
            sse.ids.push(line.slice(4));
          } else if (line.startsWith('data: ')) {
            sse.events.push(JSON.parse(line.slice(6)));
          }
        }
      }
    }
  } finally {
    controller.abort();
  }
  return sse;
}

describe('agent sessions API', () => {
  it('creates a session, runs a turn through the gate and streams it', async () => {
    const created = await json('POST', `${base}/sessions`, { agent: 'claude' });
    expect(created.status).toBe(201);
    const id = created.body.id;
    const empty = await snapshot(id);
    expect(empty).toMatchObject({ id, title: 'New chat', agent: 'claude', status: { state: 'idle' }, messages: [], turns: [] });

    // Attach first, as the page does: snapshot, then events after its seq.
    const stream = readSse(`${base}/sessions/${id}/events?after=${empty.seq}&epoch=${empty.epoch}`, (s) =>
      s.events.some((e) => e.event.type === 'status' && (e.event as any).status.state === 'idle'),
    );
    await new Promise((r) => setTimeout(r, 50));

    const sent = await json('POST', `${base}/sessions/${id}/messages`, { text: 'what is in this model? one sentence', model: 'haiku' });
    expect(sent.status).toBe(202);
    const done = await idle(id);
    const sse = await stream;

    // The CLI got the user's words and the workspace state, and the instructions.
    const run = backend.runs[0];
    expect(run.sent[0]).toBe(
      `what is in this model? one sentence\n\n<workspace_state file="${path.join(workspace, 'plate.part.js')}" render="rendered" unit="mm"/>`,
    );
    const opened = backend.opened[0];
    expect(opened).toMatchObject({ cwd: workspace, resume: null, model: 'haiku' });
    expect(opened.instructions).toContain('You are running inside the FluidCAD app');
    expect(opened.mcpUrl).toMatch(new RegExp(`^http://127\\.0\\.0\\.1:\\d+/api/agent/mcp/[A-Za-z0-9_-]{43}$`));
    expect(opened.env.ANTHROPIC_API_KEY).toBe('sk-x');

    expect(done.title).toBe('what is in this model? one sentence');
    expect(done.model).toBe('haiku');
    expect(done.turns).toHaveLength(1);
    expect(done.turns[0]).toMatchObject({ endReason: 'done', revertible: false });
    const [user, assistant] = done.messages;
    expect(user.role).toBe('user');
    expect(user.parts).toEqual([{ type: 'text', id: expect.any(String), text: 'what is in this model? one sentence' }]);
    expect(assistant.role).toBe('assistant');
    expect(assistant.parts.map((p) => p.type)).toEqual(['reasoning', 'tool', 'tool', 'text']);
    const [read, grep] = assistant.parts.filter((p): p is ToolPart => p.type === 'tool');
    expect(read).toMatchObject({ source: 'fluidcad', name: 'read_skill', state: 'done', kind: 'read' });
    expect(grep).toMatchObject({ source: 'agent', name: 'Grep', state: 'done', output: { text: 'a.fluid.js:3' } });
    expect(assistant.parts[3]).toMatchObject({ type: 'text', text: 'A plate with four holes.' });

    // The stream carried the same events, in seq order, ids matching.
    expect(sse.retry).toBe('1000');
    const seqs = sse.events.map((e) => e.seq);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    expect(sse.ids).toEqual(seqs.map(String));
    expect(sse.events[0].seq).toBe(empty.seq + 1);
    expect(sse.events.every((e) => e.epoch === empty.epoch)).toBe(true);
    const types = sse.events.map((e) => e.event.type);
    expect(types.slice(0, 4)).toEqual(['message-start', 'part-start', 'message-end', 'title']);
    expect(sse.events.find((e) => e.event.type === 'usage')!.event).toEqual({
      type: 'usage',
      turnId: done.turns[0].id,
      inputTokens: 10,
      outputTokens: 5,
      costUsd: 0.01,
    });
    // The turn keeps what it used, for the page after a reload.
    expect(done.turns[0].usage).toEqual({ inputTokens: 10, outputTokens: 5, costUsd: 0.01 });
    expect(types[types.length - 1]).toBe('status');

    // Saved to disk.
    const stored = new SessionStore(path.join(workspace, '.fluidcad', 'agent', 'sessions')).read(id)!;
    expect(stored.messages).toEqual(done.messages);
    expect(stored.agent).toEqual({ kind: 'claude', ref: run.ref, model: 'haiku' });

    const list = await json('GET', `${base}/sessions`);
    expect(list.body.sessions).toEqual([{ id, title: done.title, agent: 'claude', updatedAt: done.updatedAt, status: { state: 'idle' } }]);
  });

  it('replays from the right place on reconnect and asks for a resync when it cannot', async () => {
    const id = (await json('POST', `${base}/sessions`, { agent: 'claude' })).body.id;
    await json('POST', `${base}/sessions/${id}/messages`, { text: 'hello' });
    const done = await idle(id);
    const total = done.seq;
    expect(total).toBeGreaterThan(10);

    // `after` replays what came later, then the stream stays open (heartbeats).
    const middle = 5;
    const replay = await readSse(`${base}/sessions/${id}/events?after=${middle}`, (s) => s.comments >= 1);
    expect(replay.events.map((e) => e.seq)).toEqual(Array.from({ length: total - middle }, (_, i) => middle + 1 + i));

    // Last-Event-ID (the browser's reconnect) wins over `after`.
    const resumed = await readSse(`${base}/sessions/${id}/events?after=0`, (s) => s.comments >= 1, { 'Last-Event-ID': String(total - 2) });
    expect(resumed.events.map((e) => e.seq)).toEqual([total - 1, total]);

    // Another engine process's epoch, or a seq from the future: resync.
    const otherEpoch = await readSse(`${base}/sessions/${id}/events?after=${total}&epoch=old`, (s) => s.events.length >= 1);
    expect(otherEpoch.events[0].event).toEqual({ type: 'resync' });
    const future = await readSse(`${base}/sessions/${id}/events`, (s) => s.events.length >= 1, { 'Last-Event-ID': String(total + 100) });
    expect(future.events[0].event).toEqual({ type: 'resync' });

    // A new turn drops the previous turn's events from the log.
    await json('POST', `${base}/sessions/${id}/messages`, { text: 'again' });
    await idle(id);
    const stale = await readSse(`${base}/sessions/${id}/events?after=1`, (s) => s.events.length >= 1);
    expect(stale.events[0].event).toEqual({ type: 'resync' });
    // The same process, resumed: one CLI for both turns.
    expect(backend.runs).toHaveLength(1);
  });

  it('refuses a second message while a turn runs, and cancel keeps the partial answer', async () => {
    const id = (await json('POST', `${base}/sessions`, { agent: 'claude' })).body.id;
    expect((await json('POST', `${base}/sessions/${id}/messages`, { text: 'slow one' })).status).toBe(202);
    await until(() => snapshot(id), (s) => s.status.state === 'running' && s.messages.length === 2);
    expect((await json('POST', `${base}/sessions/${id}/messages`, { text: 'another' })).status).toBe(409);

    expect((await json('POST', `${base}/sessions/${id}/cancel`)).status).toBe(204);
    const after = await snapshot(id);
    expect(after.status).toEqual({ state: 'idle' });
    expect(after.turns[0].endReason).toBe('interrupted');
    expect(after.messages[1].parts.map((p) => p.type)).toEqual(['text', 'notice']);
    expect(after.messages[1].parts[0]).toMatchObject({ text: 'working…' });
  });

  it('sets the error status with the reset time when a turn fails', async () => {
    const id = (await json('POST', `${base}/sessions`, { agent: 'claude' })).body.id;
    await json('POST', `${base}/sessions/${id}/messages`, { text: 'fail please' });
    const done = await idle(id);
    expect(done.status).toEqual({ state: 'error', kind: 'rate-limit', message: 'Limit reached.', resetsAt: '2026-11-18T00:00:00.000Z' });
    // The reset time rides apart from the words: the page says it in local time.
    expect(done.messages[1].parts).toEqual([
      { type: 'notice', id: expect.any(String), level: 'warning', text: 'Limit reached.', resetsAt: '2026-11-18T00:00:00.000Z' },
    ]);
  });

  it('says what is missing when Claude Code is not installed or not signed in', async () => {
    const id = (await json('POST', `${base}/sessions`, { agent: 'claude' })).body.id;
    backend.install = { ...INSTALL, path: null, version: null, supported: false, loggedIn: null, problem: 'Claude Code was not found.' };
    await json('POST', `${base}/sessions/${id}/messages`, { text: 'hi' });
    expect((await idle(id)).status).toEqual({ state: 'error', kind: 'not-installed', message: 'Claude Code was not found.' });
    backend.install = { ...INSTALL, loggedIn: false, problem: 'Run `claude auth login`.' };
    await json('POST', `${base}/sessions/${id}/messages`, { text: 'hi' });
    expect((await idle(id)).status).toMatchObject({ state: 'error', kind: 'auth' });
    expect(backend.runs).toHaveLength(0);
  });

  it('respawns with --resume when the model changes, and after the idle shutdown', async () => {
    await runtime.shutdown();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await start({ idleMs: 100 });

    const id = (await json('POST', `${base}/sessions`, { agent: 'claude' })).body.id;
    await json('POST', `${base}/sessions/${id}/messages`, { text: 'one' });
    await idle(id);
    await json('POST', `${base}/sessions/${id}/messages`, { text: 'two', model: 'sonnet' });
    await idle(id);
    expect(backend.runs.map((r) => r.closed)).toEqual([true, false]);
    expect(backend.opened[1]).toMatchObject({ resume: backend.runs[0].ref, model: 'sonnet' });

    // Ten idle minutes (100 ms here) close the CLI; the next message resumes it.
    await until(() => backend.runs[1].closed, (closed) => closed);
    await json('POST', `${base}/sessions/${id}/messages`, { text: 'three', model: 'sonnet' });
    await idle(id);
    expect(backend.opened[2]).toMatchObject({ resume: backend.runs[0].ref });
  });

  it('leaves ANTHROPIC_API_KEY out of the CLI\'s environment when the preference says so', async () => {
    prefs = { agent: { defaultAgent: null, permissionMode: 'ask', claudeIgnoreApiKey: true, claudeModel: 'opus', effort: 'low' } };
    const id = (await json('POST', `${base}/sessions`, { agent: 'claude' })).body.id;
    await json('POST', `${base}/sessions/${id}/messages`, { text: 'hi' });
    await idle(id);
    expect(backend.opened[0].env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(backend.opened[0]).toMatchObject({ model: 'opus', effort: 'low' });
  });

  it('validates messages, renames and deletes sessions, and serves session files', async () => {
    const id = (await json('POST', `${base}/sessions`, { agent: 'claude' })).body.id;
    expect((await json('POST', `${base}/sessions`, { agent: 'codex' })).status).toBe(400);
    expect((await json('POST', `${base}/sessions`, { agent: 'other' })).status).toBe(400);
    expect((await json('POST', `${base}/sessions/${id}/messages`, { text: '' })).status).toBe(400);
    expect((await json('POST', `${base}/sessions/${id}/messages`, { text: 'x', model: '--dangerous flag' })).status).toBe(400);
    expect((await json('POST', `${base}/sessions/${id}/messages`, { text: 'x', image: { mediaType: 'image/png', base64: 'aGVsbG8=' } })).status).toBe(400);
    expect((await json('GET', `${base}/sessions/nope`)).status).toBe(404);
    expect((await json('GET', `${base}/sessions/..%2F..`)).status).toBe(404);

    // A message with a PNG: kept as a file and shown in the user message.
    const png = fs.readFileSync(path.join(import.meta.dirname, '..', '..', 'ui', 'public', 'logo.png'));
    expect((await json('POST', `${base}/sessions/${id}/messages`, { text: 'look', image: { mediaType: 'image/png', base64: png.toString('base64') } })).status).toBe(202);
    const done = await idle(id);
    const image = done.messages[0].parts.find((p) => p.type === 'image') as { file: string };
    const file = await fetch(`${base}/sessions/${id}/files/${image.file}`);
    expect(file.status).toBe(200);
    expect(file.headers.get('content-type')).toBe('image/png');
    expect(Buffer.from(await file.arrayBuffer()).equals(png)).toBe(true);
    expect((await fetch(`${base}/sessions/${id}/files/session.json`)).status).toBe(404);
    expect((await fetch(`${base}/sessions/${id}/files/..%2Fsession.json`)).status).toBe(404);

    expect((await json('PATCH', `${base}/sessions/${id}`, { title: 'Plate questions' })).status).toBe(204);
    expect((await snapshot(id)).title).toBe('Plate questions');

    expect((await json('DELETE', `${base}/sessions/${id}`)).status).toBe(204);
    expect((await json('GET', `${base}/sessions/${id}`)).status).toBe(404);
    expect(fs.existsSync(path.join(workspace, '.fluidcad', 'agent', 'sessions', id))).toBe(false);
    expect(runtime.endpoints.size).toBe(0);
  });

  it('lists the agents and Claude Code\'s models', async () => {
    const agents = await json('GET', `${base}/agents`);
    expect(agents.body.agents.map((a: AgentInstall) => [a.kind, a.supported])).toEqual([
      ['claude', true],
      ['codex', false],
    ]);
    expect((await json('POST', `${base}/agents/recheck`)).body.agents).toHaveLength(2);
    expect((await json('GET', `${base}/agents/claude/models`)).body.models).toEqual([{ id: 'default', label: 'Default' }]);
    expect((await json('GET', `${base}/agents/nope/models`)).status).toBe(404);
  });
});

describe('the MCP endpoint', () => {
  it('answers only the session\'s secret', async () => {
    const id = (await json('POST', `${base}/sessions`, { agent: 'claude' })).body.id;
    await json('POST', `${base}/sessions/${id}/messages`, { text: 'hello' });
    await idle(id);
    const url = backend.opened[0].mcpUrl;
    const secret = url.split('/').pop()!;
    expect(Buffer.from(secret, 'base64url')).toHaveLength(32);

    const initialize = (target: string) =>
      fetch(target, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } } }),
      });
    expect((await initialize(url.replace(secret, secret.slice(0, -1)))).status).toBe(404);
    expect((await initialize(url.replace(secret, `${secret}x`))).status).toBe(404);
    expect((await initialize(url.replace(secret, ''))).status).toBe(404);
    const ok = await initialize(url);
    expect(ok.status).toBe(200);
    await ok.body?.cancel();
  });

  it('finds an endpoint by its secret alone', () => {
    const endpoints = new McpEndpoints();
    const a = { digest: Buffer.alloc(32, 1) } as any;
    endpoints.add(a);
    expect(endpoints.find('')).toBeNull();
    expect(endpoints.find('x'.repeat(300))).toBeNull();
    expect(endpoints.find('anything')).toBeNull();
  });
});

describe('restart recovery', () => {
  it('marks a session whose last turn never ended as interrupted, with its running tools failed', async () => {
    const store = new SessionStore(path.join(workspace, '.fluidcad', 'agent', 'sessions'));
    const id = '7a1d2c3e-0000-4000-8000-000000000001';
    const record: SessionRecord = {
      schemaVersion: 1,
      id,
      title: 'Cut off',
      createdAt: '2026-11-17T10:00:00.000Z',
      updatedAt: '2026-11-17T10:00:00.000Z',
      agent: { kind: 'claude', ref: 'cli-ref', model: null },
      messages: [
        { id: 'u', role: 'user', turnId: 't', createdAt: '', parts: [{ type: 'text', id: 'p', text: 'go' }] },
        {
          id: 'a',
          role: 'assistant',
          turnId: 't',
          createdAt: '',
          parts: [
            { type: 'tool', id: 'x', source: 'fluidcad', name: 'get_scene_summary', title: 't', kind: 'read', state: 'done', input: {} },
            { type: 'tool', id: 'y', source: 'fluidcad', name: 'write_file', title: 't', kind: 'edit', state: 'running', input: {} },
            {
              type: 'tool',
              id: 'z',
              source: 'fluidcad',
              name: 'edit_range',
              title: 't',
              kind: 'edit',
              state: 'awaiting-approval',
              input: {},
              approval: { id: 'ap-1', canAllowSession: true },
            },
          ],
        },
      ],
      turns: [{ id: 't', userMessageId: 'u', revertible: false }],
    };
    store.write(record);

    const snap = await snapshot(id);
    expect(snap.status).toEqual({ state: 'interrupted', reason: RESTART_REASON });
    const parts = snap.messages[1].parts as ToolPart[];
    expect(parts.map((p) => p.state)).toEqual(['done', 'error', 'error']);
    expect(parts[1].error).toBe('The app restarted while this was running; its effect is unknown.');
    expect(parts[2].error).toBe('The app restarted while this was running; its effect is unknown.');
    // The approval no one answered is settled: answering it now is a conflict.
    expect((await json('POST', `${base}/sessions/${id}/approvals/ap-1`, { decision: 'allow' })).status).toBe(409);
    expect(snap.turns[0].endReason).toBe('interrupted');
    // Persisted, so another restart does not lose it.
    expect(store.read(id)?.interrupted).toEqual({ reason: RESTART_REASON });

    // Continue resumes the CLI's conversation and tells it what happened.
    expect((await json('POST', `${base}/sessions/${id}/continue`)).status).toBe(202);
    const done = await idle(id);
    expect(done.status).toEqual({ state: 'idle' });
    expect(backend.opened[0].resume).toBe('cli-ref');
    expect(backend.runs[0].sent[0]).toContain('The app restarted while you were working.');
    expect(store.read(id)?.interrupted).toBeUndefined();
    expect((await json('POST', `${base}/sessions/${id}/continue`)).status).toBe(409);
  });
});

/** The text that makes the fake CLI call these tools in order (see FakeRun). */
const calls = (...list: { name: string; arguments: object }[]) => `calls ${JSON.stringify(list)}`;
const write = (file: string, content: string) => ({ name: 'write_file', arguments: { path: file, content } });
const toolParts = (snap: SessionSnapshot) => snap.messages.flatMap((m) => m.parts).filter((p): p is ToolPart => p.type === 'tool');
const awaitingApproval = (id: string) => until(() => snapshot(id), (s) => s.status.state === 'awaiting-approval');
const textOf = (result: any) => (result.content as any[]).map((b) => b.text).join('');
const inWorkspace = (name: string) => path.join(workspace, name);
const readFile = (name: string) => fs.readFileSync(inWorkspace(name), 'utf8');
const checkpointDir = (id: string, turnId: string) => path.join(workspace, '.fluidcad', 'agent', 'sessions', id, 'checkpoints', turnId);

describe('approval, checkpoints and revert', () => {
  it('asks before an edit, applies it on allow, and keeps a checkpoint', async () => {
    fs.writeFileSync(inWorkspace('plate.part.js'), 'a\nb\nc\n');
    const id = (await json('POST', `${base}/sessions`, { agent: 'claude' })).body.id;
    const sent = await json('POST', `${base}/sessions/${id}/messages`, {
      text: calls({ name: 'edit_range', arguments: { path: 'plate.part.js', start: { line: 1, column: 0 }, end: { line: 1, column: 1 }, newText: 'B' } }),
    });
    const turnId = sent.body.turnId;
    const waiting = await awaitingApproval(id);
    const [part] = toolParts(waiting);
    expect(part).toMatchObject({
      name: 'edit_range',
      title: 'Edit plate.part.js, line 2',
      state: 'awaiting-approval',
      approval: { canAllowSession: true },
      diff: '--- a/plate.part.js\n+++ b/plate.part.js\n@@ -1,3 +1,3 @@\n a\n-b\n+B\n c\n',
    });
    const approvalId = part.approval!.id;
    expect(waiting.status).toEqual({ state: 'awaiting-approval', turnId, approvalIds: [approvalId] });
    expect(readFile('plate.part.js')).toBe('a\nb\nc\n');

    expect((await json('POST', `${base}/sessions/${id}/approvals/${approvalId}`, { decision: 'maybe' })).status).toBe(400);
    expect((await json('POST', `${base}/sessions/${id}/approvals/nope`, { decision: 'allow' })).status).toBe(404);
    expect((await json('POST', `${base}/sessions/${id}/approvals/${approvalId}`, { decision: 'allow' })).status).toBe(204);
    const done = await idle(id);
    expect((await json('POST', `${base}/sessions/${id}/approvals/${approvalId}`, { decision: 'deny' })).status).toBe(409);

    expect(readFile('plate.part.js')).toBe('a\nB\nc\n');
    expect(toolParts(done)[0]).toMatchObject({ state: 'done', approval: { id: approvalId, decision: 'allow' } });
    expect(done.turns[0]).toMatchObject({ id: turnId, revertible: true, files: ['plate.part.js'] });
    expect(JSON.parse(fs.readFileSync(path.join(checkpointDir(id, turnId), '1.json'), 'utf8'))).toEqual({
      path: inWorkspace('plate.part.js'),
      existed: true,
      content: 'a\nb\nc\n',
    });
    // The model was told the edit ran.
    expect(backend.runs[0].results[0].isError).not.toBe(true);
  });

  it('keeps one checkpoint per file per turn, reverts later turns too, newest first, and tells the CLI once', async () => {
    fs.writeFileSync(inWorkspace('plate.part.js'), 'v1');
    const id = (await json('POST', `${base}/sessions`, { agent: 'claude' })).body.id;

    // Turn 1, edits applied without asking: the plate twice, and a new file.
    const t1 = (
      await json('POST', `${base}/sessions/${id}/messages`, {
        text: calls(write('plate.part.js', 'v2'), write('plate.part.js', 'v3'), write('new.fluid.js', 'n1')),
        mode: 'auto-edits',
      })
    ).body.turnId;
    const s1 = await idle(id);
    expect(s1.turns[0]).toMatchObject({ revertible: true, files: ['plate.part.js', 'new.fluid.js'] });
    expect(fs.readdirSync(checkpointDir(id, t1)).sort()).toEqual(['1.json', '2.json']);
    expect(JSON.parse(fs.readFileSync(path.join(checkpointDir(id, t1), '1.json'), 'utf8')).content).toBe('v1');
    expect(JSON.parse(fs.readFileSync(path.join(checkpointDir(id, t1), '2.json'), 'utf8'))).toMatchObject({ existed: false });

    // Turn 2 changes both again.
    const t2 = (
      await json('POST', `${base}/sessions/${id}/messages`, {
        text: calls(write('new.fluid.js', 'n2'), write('plate.part.js', 'v4')),
        mode: 'auto-edits',
      })
    ).body.turnId;
    const s2 = await idle(id);
    expect(s2.turns[1]).toMatchObject({ revertible: true, files: ['new.fluid.js', 'plate.part.js'] });
    expect(readFile('plate.part.js')).toBe('v4');

    expect((await json('POST', `${base}/sessions/${id}/revert`, {})).status).toBe(400);
    expect((await json('POST', `${base}/sessions/${id}/revert`, { turnId: 'no-such-turn' })).status).toBe(404);

    const stream = readSse(`${base}/sessions/${id}/events?after=${s2.seq}`, (s) => s.events.filter((e) => e.event.type === 'reverted').length >= 2);
    await new Promise((r) => setTimeout(r, 50));
    const reverted = await json('POST', `${base}/sessions/${id}/revert`, { turnId: t1 });
    expect(reverted.status).toBe(200);
    expect([...reverted.body.restored].sort()).toEqual(['new.fluid.js', 'plate.part.js']);
    expect(reverted.body.failed).toBeUndefined();
    expect(readFile('plate.part.js')).toBe('v1');
    expect(fs.existsSync(inWorkspace('new.fluid.js'))).toBe(false);

    const sse = await stream;
    const revertEvents = sse.events.map((e) => e.event).filter((e) => e.type === 'reverted');
    expect(revertEvents.map((e: any) => e.turnId)).toEqual([t2, t1]);

    const after = await snapshot(id);
    for (const turn of after.turns) {
      expect(turn).toMatchObject({ revertible: false, revertedAt: expect.any(String) });
    }
    const notices = after.messages.filter((m) => m.role === 'assistant').map((m) => m.parts[m.parts.length - 1]);
    expect(notices).toEqual([
      { type: 'notice', id: expect.any(String), level: 'info', text: expect.stringMatching(/^Reverted the changes of this turn: /) },
      { type: 'notice', id: expect.any(String), level: 'info', text: expect.stringMatching(/^Reverted the changes of this turn: /) },
    ]);
    expect(fs.existsSync(checkpointDir(id, t1))).toBe(false);
    expect(fs.existsSync(checkpointDir(id, t2))).toBe(false);
    expect((await json('POST', `${base}/sessions/${id}/revert`, { turnId: t1 })).status).toBe(409);

    // The next message tells the CLI, whose history still has the edits; the one after does not.
    await json('POST', `${base}/sessions/${id}/messages`, { text: 'hello' });
    await idle(id);
    const told = backend.runs[0].sent[2];
    expect(told.startsWith('hello\n\n<reverted_changes>\n')).toBe(true);
    expect(told).toContain('- plate.part.js\n');
    expect(told).toContain('- new.fluid.js\n');
    expect(told).toContain('</reverted_changes>\n<workspace_state');
    await json('POST', `${base}/sessions/${id}/messages`, { text: 'again' });
    await idle(id);
    expect(backend.runs[0].sent[3]).not.toContain('reverted_changes');
    expect(runtime.store.read(id)?.revertedFiles).toBeUndefined();
  });

  it('refuses to revert while a turn runs', async () => {
    const id = (await json('POST', `${base}/sessions`, { agent: 'claude' })).body.id;
    const t1 = (await json('POST', `${base}/sessions/${id}/messages`, { text: calls(write('a.fluid.js', 'x')), mode: 'auto-edits' })).body.turnId;
    await idle(id);
    await json('POST', `${base}/sessions/${id}/messages`, { text: 'slow one' });
    await until(() => snapshot(id), (s) => s.status.state === 'running');
    const refused = await json('POST', `${base}/sessions/${id}/revert`, { turnId: t1 });
    expect(refused.status).toBe(409);
    expect(fs.existsSync(inWorkspace('a.fluid.js'))).toBe(true);
    await json('POST', `${base}/sessions/${id}/cancel`);
  });

  it('keeps a turn revertible when a file cannot be put back, and says which', async () => {
    fs.writeFileSync(inWorkspace('plate.part.js'), 'v1');
    const id = (await json('POST', `${base}/sessions`, { agent: 'claude' })).body.id;
    const t1 = (await json('POST', `${base}/sessions/${id}/messages`, { text: calls(write('plate.part.js', 'v2')), mode: 'auto-edits' })).body.turnId;
    await idle(id);
    dirtyFiles = [inWorkspace('plate.part.js')];
    const blocked = await json('POST', `${base}/sessions/${id}/revert`, { turnId: t1 });
    expect(blocked.body).toEqual({ restored: [], failed: [{ path: 'plate.part.js', error: expect.stringContaining('unsaved changes') }] });
    expect(readFile('plate.part.js')).toBe('v2');
    expect((await snapshot(id)).turns[0].revertible).toBe(true);

    dirtyFiles = [];
    expect((await json('POST', `${base}/sessions/${id}/revert`, { turnId: t1 })).body).toEqual({ restored: ['plate.part.js'] });
    expect(readFile('plate.part.js')).toBe('v1');
  });

  it('cancel denies a pending approval, and a call after the cancel does not run', async () => {
    const id = (await json('POST', `${base}/sessions`, { agent: 'claude' })).body.id;
    await json('POST', `${base}/sessions/${id}/messages`, { text: calls(write('a.fluid.js', 'x')) });
    const waiting = await awaitingApproval(id);
    const approvalId = toolParts(waiting)[0].approval!.id;

    expect((await json('POST', `${base}/sessions/${id}/cancel`)).status).toBe(204);
    const after = await idle(id);
    expect(after.status).toEqual({ state: 'idle' });
    expect(toolParts(after)[0]).toMatchObject({ state: 'denied', approval: { id: approvalId, decision: 'deny' }, error: 'Stopped before you answered.' });
    const run = backend.runs[0];
    await until(() => run.results.length, (n) => n === 1);
    expect(textOf(run.results[0])).toBe(STOPPED_MESSAGE);
    expect((await json('POST', `${base}/sessions/${id}/approvals/${approvalId}`, { decision: 'allow' })).status).toBe(409);

    // A call that arrives late (Codex keeps one pending through an interrupt) is refused.
    const late = await run.client!.callTool({ name: 'write_file', arguments: { path: 'a.fluid.js', content: 'late' } });
    expect(textOf(late)).toBe(NO_TURN_MESSAGE);
    expect(fs.existsSync(inWorkspace('a.fluid.js'))).toBe(false);
    expect((await snapshot(id)).turns[0].revertible).toBe(false);
  });

  it('settles a pending approval as denied, and saves it, when the engine exits; the restarted engine says the turn was cut off', async () => {
    const id = (await json('POST', `${base}/sessions`, { agent: 'claude' })).body.id;
    await json('POST', `${base}/sessions/${id}/messages`, { text: calls(write('a.fluid.js', 'x')) });
    await awaitingApproval(id);
    runtime.onEngineExit();
    const stored = runtime.store.read(id)!;
    const part = stored.messages[1].parts.find((p): p is ToolPart => p.type === 'tool')!;
    expect(part).toMatchObject({ state: 'denied', error: 'The app closed before you answered.', approval: { decision: 'deny' } });
    expect(fs.existsSync(inWorkspace('a.fluid.js'))).toBe(false);

    // A new engine process on the same workspace (read before this one's turn goes on to end).
    const restarted = new AgentRuntime(
      {
        workspacePath: workspace,
        port: 1,
        version: '0.0.0',
        startedAt: new Date(0).toISOString(),
        currentFile: () => null,
        renderState: () => ({ state: 'none' }),
        unit: () => 'mm',
        loadPreferences: async () => prefs,
      },
      { backends: { claude: new FakeBackend() } },
    );
    try {
      const snap = restarted.get(id)!.snapshot();
      expect(snap.status).toEqual({ state: 'interrupted', reason: RESTART_REASON });
      expect(toolParts(snap)[0]).toMatchObject({ state: 'denied' });
    } finally {
      await restarted.shutdown();
    }
    // The model was told the action did not run.
    await until(() => backend.runs[0].results.length, (n) => n === 1);
    expect(textOf(backend.runs[0].results[0])).toBe(STOPPED_MESSAGE);
  });

  it('shows a dirty-buffer refusal as a card naming the file, and the turn has nothing to revert', async () => {
    fs.writeFileSync(inWorkspace('bracket.fluid.js'), 'v1');
    dirtyFiles = [inWorkspace('bracket.fluid.js')];
    const id = (await json('POST', `${base}/sessions`, { agent: 'claude' })).body.id;
    await json('POST', `${base}/sessions/${id}/messages`, { text: calls(write('bracket.fluid.js', 'v2')), mode: 'auto-edits' });
    const done = await idle(id);
    expect(toolParts(done)[0]).toMatchObject({
      state: 'error',
      errorCode: 'dirty-buffer',
      error: 'Not written: bracket.fluid.js has unsaved changes in the editor. Save it, then ask again.',
    });
    // The model got the tool's own refusal.
    expect(JSON.parse(textOf(backend.runs[0].results[0])).code).toBe('dirty-buffer');
    expect(readFile('bracket.fluid.js')).toBe('v1');
    expect(done.turns[0].revertible).toBe(false);
    expect(done.turns[0].files).toBeUndefined();
  });
});
