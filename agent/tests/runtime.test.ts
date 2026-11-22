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
import type { AgentBackend, AgentInstall, AgentRun, BackendEvent, OpenOptions, TurnImage } from '../src/backend.ts';
import { AgentRuntime } from '../src/runtime.ts';
import { createRuntimeRouter, MAX_ATTACHMENT_BYTES, MAX_ATTACHMENTS, parseSendMessage, sniffImageType } from '../src/router.ts';
import { McpEndpoints } from '../src/mcp-endpoint.ts';
import { RESTART_REASON } from '../src/session.ts';
import { SessionStore, type SessionRecord } from '../src/session-store.ts';
import { NO_TURN_MESSAGE, STOPPED_MESSAGE } from '../src/tool-gate.ts';
import type { ChatEventEnvelope, QuestionPart, SessionSnapshot, ToolPart, VariantsPart } from '../src/types.ts';

// The runtime end to end, with a fake backend in place of a CLI: the fake run
// connects to the session's MCP endpoint over HTTP the way Claude Code does,
// calls tools, and streams a reply.

const INSTALL: AgentInstall = { kind: 'claude', path: '/fake/claude', version: '2.1.326', minVersion: '2.1.259', supported: true, loggedIn: true, authMethod: 'claude.ai' };

class FakeRun implements AgentRun {
  readonly ref: string;
  readonly queue = new AsyncQueue<BackendEvent>();
  readonly sent: string[] = [];
  /** The images each message came with. */
  readonly images: TurnImage[][] = [];
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

  send(input: { text: string; images?: TurnImage[] }): void {
    this.sent.push(input.text);
    this.images.push(input.images ?? []);
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
/** What this test engine's scratch build answers for a candidate text (propose_variants); null: 404, an engine without them. */
let scratchBuild: ((source: string) => unknown) | null = null;

async function start(options: { idleMs?: number } = {}): Promise<void> {
  backend = new FakeBackend();
  const app = express();
  app.use(express.json({ limit: '50mb' }));
  // The engine routes the MCP write tools use: dirty buffers only; the lint
  // and the render answer 404 (an older engine), and the tools carry on.
  app.get('/api/editor/dirty-files', (_req, res) => {
    res.json(dirtyFiles.map((p) => ({ path: p, lastModifiedMs: 0 })));
  });
  app.post('/api/scratch-build', (req, res) => {
    if (!scratchBuild) {
      res.status(404).json({ error: 'not here' });
      return;
    }
    res.json(scratchBuild(req.body.source));
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
  scratchBuild = null;
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
    // Claude Code runs on the subscription only: the engine's key never reaches it.
    expect(opened.env.ANTHROPIC_API_KEY).toBeUndefined();

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
    expect(list.body.sessions).toEqual([{ id, title: done.title, agent: 'claude', updatedAt: done.updatedAt, status: { state: 'idle' }, model: 'haiku' }]);
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

  it('runs Claude Code with the model and effort preferences', async () => {
    prefs = { agent: { defaultAgent: null, permissionMode: 'ask', claudeModel: 'opus', effort: 'low' } };
    const id = (await json('POST', `${base}/sessions`, { agent: 'claude' })).body.id;
    await json('POST', `${base}/sessions/${id}/messages`, { text: 'hi' });
    await idle(id);
    expect(backend.opened[0].env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(backend.opened[0]).toMatchObject({ model: 'opus', effort: 'low' });
    // The session remembers the effort it ran with.
    expect((await snapshot(id)).effort).toBe('low');
  });

  it('detects and runs Claude Code without ANTHROPIC_API_KEY', async () => {
    const detected: any[] = [];
    const detect = backend.detect.bind(backend);
    backend.detect = async (options?: any) => {
      detected.push(options);
      return detect();
    };
    const id = (await json('POST', `${base}/sessions`, { agent: 'claude' })).body.id;
    await json('POST', `${base}/sessions/${id}/messages`, { text: 'hi' });
    await idle(id);
    expect(detected[0].env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(backend.opened[0].env.ANTHROPIC_API_KEY).toBeUndefined();
  });

  it("passes the effort a message names, any of Claude Code's levels, and the agent's own preference otherwise", async () => {
    prefs = { agent: { defaultAgent: null, permissionMode: 'ask', claudeEffort: 'xhigh', effort: 'low' } };
    const id = (await json('POST', `${base}/sessions`, { agent: 'claude' })).body.id;
    await json('POST', `${base}/sessions/${id}/messages`, { text: 'one' });
    await idle(id);
    expect(backend.opened[0]).toMatchObject({ effort: 'xhigh' });
    expect((await json('POST', `${base}/sessions/${id}/messages`, { text: 'two', effort: 'max' })).status).toBe(202);
    await idle(id);
    expect(backend.opened[1]).toMatchObject({ effort: 'max' });
    expect((await snapshot(id)).effort).toBe('max');
    expect((await json('POST', `${base}/sessions/${id}/messages`, { text: 'three', effort: 'ultra' })).status).toBe(400);
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
      // This runtime has no API backend.
      ['api', false],
    ]);
    expect((await json('POST', `${base}/agents/recheck`)).body.agents).toHaveLength(3);
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
        { id: 'u', role: 'user', turnId: 't', createdAt: '', parts: [{ type: 'text', id: 'p', text: 'Add 2 mm fillets to the top edges of the plate' }] },
        {
          id: 'a',
          role: 'assistant',
          turnId: 't',
          createdAt: '',
          parts: [
            { type: 'tool', id: 'x', source: 'fluidcad', name: 'get_scene_summary', title: 't', kind: 'read', state: 'done', input: {} },
            { type: 'tool', id: 'w', source: 'fluidcad', name: 'write_file', title: 't', kind: 'edit', state: 'done', input: { path: path.join(workspace, 'notes.part.js') } },
            { type: 'tool', id: 'v', source: 'fluidcad', name: 'measure', title: 't', kind: 'read', state: 'error', input: {}, error: 'No such shape.\nmore detail' },
            { type: 'tool', id: 'y', source: 'fluidcad', name: 'write_file', title: 't', kind: 'edit', state: 'running', input: { path: path.join(workspace, 'plate.part.js') } },
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
    expect(parts.map((p) => p.state)).toEqual(['done', 'done', 'error', 'error', 'error']);
    expect(parts[3].error).toBe('The app restarted while this was running; its effect is unknown.');
    expect(parts[4].error).toBe('The app restarted while this was running; its effect is unknown.');
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
    const sent = backend.runs[0].sent[0];
    expect(sent).toContain('The app restarted while you were working.');
    // What the cut-off turn was doing: the request, and each call with how it ended.
    expect(sent).toContain(
      [
        '<interrupted_turn>',
        'The user had asked:',
        '> Add 2 mm fillets to the top edges of the plate',
        'Your tool calls in that turn, in order, and how each ended:',
        '- get_scene_summary — done',
        '- write_file notes.part.js — done',
        '- measure — failed: No such shape.',
        '- write_file plate.part.js — result unknown (the app restarted while it ran)',
        "- edit_range — not run: it was waiting for the user's approval when the app restarted",
      ].join('\n'),
    );
    expect(sent.indexOf('<interrupted_turn>')).toBeLessThan(sent.indexOf('<workspace_state'));
    // The transcript shows the short message only.
    const user = done.messages.filter((m) => m.role === 'user').at(-1)!;
    expect(user.parts).toEqual([{ type: 'text', id: expect.any(String), text: expect.stringMatching(/^The app restarted while you were working\./) }]);
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

// The smallest bytes each type is known by.
const PNG_BYTES = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('png-body')]);
const JPEG_BYTES = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from('jpeg-body')]);
const WEBP_BYTES = Buffer.concat([Buffer.from('RIFF'), Buffer.from([4, 0, 0, 0]), Buffer.from('WEBPVP8 ')]);
const GIF_BYTES = Buffer.from('GIF89a-body');
const attachment = (mediaType: string, bytes: Buffer, name?: string) => ({ mediaType, base64: bytes.toString('base64'), ...(name ? { name } : {}) });

describe('questions (ask_user, §22)', () => {
  const ask = (...questions: object[]) => ({ name: 'ask_user', arguments: { questions } });
  const THREAD = { question: 'Which thread should the holes take?', options: [{ label: 'M4' }, { label: 'M5' }] };
  const WALL = { question: 'How thick should the wall be?' };
  const questionParts = (snap: SessionSnapshot) => snap.messages.flatMap((m) => m.parts).filter((p): p is QuestionPart => p.type === 'question');
  const awaitingAnswer = (id: string) => until(() => snapshot(id), (s) => s.status.state === 'awaiting-answer');

  it('waits for the user, takes the first valid answer, and hands it to the model', async () => {
    const id = (await json('POST', `${base}/sessions`, { agent: 'claude' })).body.id;
    const turnId = (await json('POST', `${base}/sessions/${id}/messages`, { text: calls(ask(THREAD, WALL)) })).body.turnId;
    const waiting = await awaitingAnswer(id);
    const [part] = questionParts(waiting);
    expect(part).toEqual({ type: 'question', id: expect.any(String), state: 'awaiting-answer', questions: [THREAD, WALL] });
    expect(waiting.status).toEqual({ state: 'awaiting-answer', turnId, questionIds: [part.id] });
    // The card is the question's own: no tool card beside it.
    expect(toolParts(waiting)).toEqual([]);
    // Saved while it waits.
    const store = new SessionStore(path.join(workspace, '.fluidcad', 'agent', 'sessions'));
    expect(store.read(id)!.messages.flatMap((m) => m.parts).some((p) => p.type === 'question' && p.state === 'awaiting-answer')).toBe(true);

    const url = `${base}/sessions/${id}/questions/${part.id}`;
    expect((await json('POST', `${base}/sessions/${id}/questions/nope`, { skip: true })).status).toBe(404);
    const refused = await json('POST', url, { answers: [{ selected: ['M6'] }, { selected: [] }] });
    expect(refused.status).toBe(400);
    expect(refused.body.error).toContain('does not offer');
    expect((await json('POST', url, { answers: [{ selected: [] }, { selected: [] }] })).status).toBe(400);
    expect((await snapshot(id)).status.state).toBe('awaiting-answer');

    expect((await json('POST', url, { answers: [{ selected: ['M5'] }, { selected: [], text: '2.5 mm' }] })).status).toBe(204);
    const done = await idle(id);
    expect((await json('POST', url, { skip: true })).status).toBe(409);
    expect(questionParts(done)[0]).toMatchObject({ state: 'answered', answers: [{ selected: ['M5'] }, { selected: [], text: '2.5 mm' }] });
    const result = backend.runs[0].results[0];
    expect(result.isError).not.toBe(true);
    expect(JSON.parse(textOf(result))).toEqual({
      answers: [
        { question: THREAD.question, selected: ['M5'] },
        { question: WALL.question, text: '2.5 mm' },
      ],
    });
  });

  it('a skip lets the turn go on; a stop while it waits ends the question unanswered', async () => {
    const id = (await json('POST', `${base}/sessions`, { agent: 'claude' })).body.id;
    await json('POST', `${base}/sessions/${id}/messages`, { text: calls(ask(WALL)) });
    const [first] = questionParts(await awaitingAnswer(id));
    expect((await json('POST', `${base}/sessions/${id}/questions/${first.id}`, { skip: true })).status).toBe(204);
    const skipped = await idle(id);
    expect(questionParts(skipped)[0].state).toBe('skipped');
    expect(JSON.parse(textOf(backend.runs[0].results[0])).skipped).toBe(true);

    await json('POST', `${base}/sessions/${id}/messages`, { text: calls(ask(THREAD)) });
    const [, second] = questionParts(await awaitingAnswer(id));
    expect((await json('POST', `${base}/sessions/${id}/cancel`)).status).toBeLessThan(300);
    const stopped = await idle(id);
    expect(questionParts(stopped)[1]).toMatchObject({ id: second.id, state: 'unanswered', reason: 'Stopped before you answered.' });
    expect((await json('POST', `${base}/sessions/${id}/questions/${second.id}`, { skip: true })).status).toBe(409);
  });

  it('a question nobody answered before a restart is settled, and the continue note says so', async () => {
    const store = new SessionStore(path.join(workspace, '.fluidcad', 'agent', 'sessions'));
    const id = '7a1d2c3e-0000-4000-8000-000000000002';
    store.write({
      schemaVersion: 1,
      id,
      title: 'Cut off',
      createdAt: '2026-11-21T10:00:00.000Z',
      updatedAt: '2026-11-21T10:00:00.000Z',
      agent: { kind: 'claude', ref: 'cli-ref', model: null },
      messages: [
        { id: 'u', role: 'user', turnId: 't', createdAt: '', parts: [{ type: 'text', id: 'p', text: 'Add mounting holes' }] },
        {
          id: 'a',
          role: 'assistant',
          turnId: 't',
          createdAt: '',
          parts: [
            { type: 'question', id: 'q-old', state: 'answered', questions: [WALL], answers: [{ selected: [], text: '3' }] },
            { type: 'question', id: 'q-open', state: 'awaiting-answer', questions: [THREAD] },
          ],
        },
      ],
      turns: [{ id: 't', userMessageId: 'u', revertible: false }],
    });
    const snap = await snapshot(id);
    expect(snap.status).toEqual({ state: 'interrupted', reason: RESTART_REASON });
    expect(questionParts(snap).map((p) => [p.state, p.reason])).toEqual([
      ['answered', undefined],
      ['unanswered', 'The app restarted before you answered.'],
    ]);
    expect((await json('POST', `${base}/sessions/${id}/questions/q-open`, { skip: true })).status).toBe(409);

    expect((await json('POST', `${base}/sessions/${id}/continue`)).status).toBe(202);
    await idle(id);
    const sent = backend.runs[0].sent[0];
    expect(sent).toContain('- ask_user — answered by the user\n- ask_user — not answered: it was waiting for the user when the app restarted');
  });
});

describe('variants (propose_variants, §24)', () => {
  const BASE = 'base();\n';
  const RIB = 'base();\nrib();\n';
  const GUSSET = 'base();\ngusset();\n';
  const propose = () => ({
    name: 'propose_variants',
    arguments: {
      path: 'plate.part.js',
      question: 'Which stiffener?',
      variants: [{ label: 'Rib', description: 'One rib.', content: RIB }, { label: 'Gusset', content: GUSSET }],
    },
  });
  const built = (id: string, volume: number) => ({
    state: 'rendered',
    id,
    file: 'plate.part.js',
    sceneKind: 'part',
    unit: 'mm',
    durationMs: 9,
    builtFrom: 'source',
    configuration: 'Default',
    sessionOverrides: 0,
    unusedParams: [],
    solidCount: 1,
    bounds: { min: [0, 0, 0], max: [80, 40, 30] },
    volume,
    validation: { ok: true, checked: 1, findings: [], skipped: 0 },
  });
  const RIB_ID = '11111111-1111-4111-8111-111111111111';
  const GUSSET_ID = '22222222-2222-4222-8222-222222222222';
  const variantsParts = (snap: SessionSnapshot) => snap.messages.flatMap((m) => m.parts).filter((p): p is VariantsPart => p.type === 'variants');
  const awaitingChoice = (id: string) => until(() => snapshot(id), (s) => s.status.state === 'awaiting-answer');

  beforeEach(() => {
    fs.writeFileSync(path.join(workspace, 'plate.part.js'), BASE);
    scratchBuild = (source) => (source === RIB ? built(RIB_ID, 41200) : built(GUSSET_ID, 44000));
  });

  it('builds, waits for the pick, keeps the tiles\' pictures, writes the pick as a change of the turn, and a revert puts the file back', async () => {
    const id = (await json('POST', `${base}/sessions`, { agent: 'claude' })).body.id;
    const turnId = (await json('POST', `${base}/sessions/${id}/messages`, { text: calls(propose()), mode: 'ask' })).body.turnId;
    const waiting = await awaitingChoice(id);
    const [part] = variantsParts(waiting);
    expect(part).toMatchObject({
      type: 'variants',
      state: 'awaiting-choice',
      file: 'plate.part.js',
      question: 'Which stiffener?',
      variants: [
        { label: 'Rib', description: 'One rib.', state: 'ready', buildId: RIB_ID, facts: { solidCount: 1, size: [80, 40, 30], volume: 41200, unit: 'mm' } },
        { label: 'Gusset', state: 'ready', buildId: GUSSET_ID },
      ],
    });
    // It waits as a question does, under the card's id; no approval is asked in `ask` mode.
    expect(waiting.status).toEqual({ state: 'awaiting-answer', turnId, questionIds: [part.id] });
    expect(toolParts(waiting)).toEqual([]);
    // Saved while it waits.
    const store = new SessionStore(path.join(workspace, '.fluidcad', 'agent', 'sessions'));
    expect(store.read(id)!.messages.flatMap((m) => m.parts).some((p) => p.type === 'variants' && p.state === 'awaiting-choice')).toBe(true);

    // The page draws each tile and hands the picture over: it is kept with the session and named on the tile.
    const pictures = `${base}/sessions/${id}/variants/${part.id}/pictures`;
    const png = { mediaType: 'image/png', base64: PNG_BYTES.toString('base64') };
    expect((await json('POST', pictures, { label: 'Rib', image: png })).status).toBe(204);
    const [drawn] = variantsParts(await snapshot(id));
    expect(drawn.variants[0].image).toMatch(/^[0-9a-f-]+\.png$/);
    expect(drawn.variants[1].image).toBeUndefined();
    const served = await fetch(`${base}/sessions/${id}/files/${drawn.variants[0].image}`);
    expect(served.headers.get('content-type')).toBe('image/png');
    expect(Buffer.from(await served.arrayBuffer()).equals(PNG_BYTES)).toBe(true);
    // The first picture of a tile is the one kept (a second tab drew it too).
    expect((await json('POST', pictures, { label: 'Rib', image: png })).status).toBe(204);
    expect(variantsParts(await snapshot(id))[0].variants[0].image).toBe(drawn.variants[0].image);
    expect((await json('POST', pictures, { label: 'Web', image: png })).status).toBe(404);
    expect((await json('POST', pictures, { label: 'Gusset', image: { mediaType: 'image/png', base64: JPEG_BYTES.toString('base64') } })).status).toBe(400);
    expect((await json('POST', `${base}/sessions/${id}/variants/nope/pictures`, { label: 'Rib', image: png })).status).toBe(404);

    const url = `${base}/sessions/${id}/variants/${part.id}`;
    expect((await json('POST', `${base}/sessions/${id}/variants/nope`, { skip: true })).status).toBe(404);
    expect((await json('POST', url, { pick: 'Web' })).status).toBe(400);
    expect((await snapshot(id)).status.state).toBe('awaiting-answer');
    expect((await json('POST', url, { pick: 'Gusset' })).status).toBe(204);
    const done = await idle(id);
    expect((await json('POST', url, { skip: true })).status).toBe(409);

    expect(fs.readFileSync(path.join(workspace, 'plate.part.js'), 'utf8')).toBe(GUSSET);
    expect(variantsParts(done)[0]).toMatchObject({ state: 'picked', picked: 'Gusset' });
    expect(variantsParts(done)[0].variants[0].image).toBe(drawn.variants[0].image);
    const [write] = toolParts(done);
    expect(write).toMatchObject({ name: 'write_file', title: 'Apply "Gusset" to plate.part.js', state: 'done' });
    expect(write.approval).toBeUndefined();
    const result = backend.runs[0].results[0];
    expect(result.isError).not.toBe(true);
    expect(JSON.parse(textOf(result))).toMatchObject({ picked: 'Gusset', render: { state: 'render-failed' } });
    // A change of the turn like any write_file of it: revertible, and reverted with it.
    expect(done.turns[0]).toMatchObject({ id: turnId, revertible: true, files: ['plate.part.js'] });
    const reverted = await json('POST', `${base}/sessions/${id}/revert`, { turnId });
    expect(reverted.body.restored).toEqual(['plate.part.js']);
    expect(fs.readFileSync(path.join(workspace, 'plate.part.js'), 'utf8')).toBe(BASE);
    // A picture can still come after the card settled (a tab that opened late, while the engine has the build).
    expect((await json('POST', pictures, { label: 'Gusset', image: png })).status).toBe(204);
    expect(variantsParts(await snapshot(id))[0].variants[1].image).toMatch(/\.png$/);
  });

  it('a skip lets the turn go on with nothing written; a stop while it waits ends the card unanswered', async () => {
    const id = (await json('POST', `${base}/sessions`, { agent: 'claude' })).body.id;
    await json('POST', `${base}/sessions/${id}/messages`, { text: calls(propose()) });
    const [first] = variantsParts(await awaitingChoice(id));
    expect((await json('POST', `${base}/sessions/${id}/variants/${first.id}`, { skip: true })).status).toBe(204);
    const skipped = await idle(id);
    expect(variantsParts(skipped)[0].state).toBe('skipped');
    expect(JSON.parse(textOf(backend.runs[0].results[0])).skipped).toBe(true);
    expect(skipped.turns[0].revertible).toBe(false);

    await json('POST', `${base}/sessions/${id}/messages`, { text: calls(propose()) });
    const [, second] = variantsParts(await awaitingChoice(id));
    expect((await json('POST', `${base}/sessions/${id}/cancel`)).status).toBeLessThan(300);
    const stopped = await idle(id);
    expect(variantsParts(stopped)[1]).toMatchObject({ id: second.id, state: 'unanswered', reason: 'Stopped before you chose.' });
    expect((await json('POST', `${base}/sessions/${id}/variants/${second.id}`, { pick: 'Rib' })).status).toBe(409);
    expect(fs.readFileSync(path.join(workspace, 'plate.part.js'), 'utf8')).toBe(BASE);
  });

  it('cards cut off by a restart are settled with the pictures they had, and the continue note says how each ended', async () => {
    const store = new SessionStore(path.join(workspace, '.fluidcad', 'agent', 'sessions'));
    const id = '7a1d2c3e-0000-4000-8000-000000000003';
    const ready = { state: 'ready' as const, buildId: RIB_ID, sceneKind: 'part' as const, facts: { solidCount: 1, size: [80, 40, 30] as [number, number, number], volume: 41200, unit: 'mm' } };
    store.write({
      schemaVersion: 1,
      id,
      title: 'Cut off',
      createdAt: '2026-11-22T10:00:00.000Z',
      updatedAt: '2026-11-22T10:00:00.000Z',
      agent: { kind: 'claude', ref: 'cli-ref', model: null },
      messages: [
        { id: 'u', role: 'user', turnId: 't', createdAt: '', parts: [{ type: 'text', id: 'p', text: 'Stiffen the arm' }] },
        {
          id: 'a',
          role: 'assistant',
          turnId: 't',
          createdAt: '',
          parts: [
            { type: 'variants', id: 'v-skipped', state: 'skipped', file: 'plate.part.js', variants: [{ label: 'A', ...ready }, { label: 'B', ...ready }] },
            {
              type: 'variants',
              id: 'v-waiting',
              state: 'awaiting-choice',
              file: 'plate.part.js',
              variants: [{ label: 'Rib', ...ready, image: 'rib.png' }, { label: 'Gusset', ...ready }],
            },
            // The engine went down inside the second build.
            { type: 'variants', id: 'v-building', state: 'building', file: 'arm.part.js', variants: [{ label: 'Thin', ...ready }, { label: 'Thick', state: 'building' }] },
          ],
        },
      ],
      turns: [{ id: 't', userMessageId: 'u', revertible: false }],
    });
    const snap = await snapshot(id);
    expect(snap.status).toEqual({ state: 'interrupted', reason: RESTART_REASON });
    expect(variantsParts(snap).map((p) => [p.state, p.reason, p.variants.map((t) => t.state)])).toEqual([
      ['skipped', undefined, ['ready', 'ready']],
      ['unanswered', 'The app restarted before you chose.', ['ready', 'ready']],
      ['unanswered', 'The app restarted while these were building.', ['ready', 'cancelled']],
    ]);
    // The picture drawn before the restart is still the tile's.
    expect(variantsParts(snap)[1].variants[0].image).toBe('rib.png');
    expect((await json('POST', `${base}/sessions/${id}/variants/v-waiting`, { pick: 'Rib' })).status).toBe(409);

    expect((await json('POST', `${base}/sessions/${id}/continue`)).status).toBe(202);
    await idle(id);
    const sent = backend.runs[0].sent[0];
    expect(sent).toContain(
      '- propose_variants plate.part.js — skipped by the user\n'
        + '- propose_variants plate.part.js — not chosen: it was waiting for the user when the app restarted\n'
        + '- propose_variants arm.part.js — not shown: the app restarted while the variants were building',
    );
  });
});

describe('images attached to a message', () => {
  it('tells the four image types apart by their bytes', () => {
    expect(sniffImageType(PNG_BYTES)).toBe('image/png');
    expect(sniffImageType(JPEG_BYTES)).toBe('image/jpeg');
    expect(sniffImageType(WEBP_BYTES)).toBe('image/webp');
    expect(sniffImageType(GIF_BYTES)).toBe('image/gif');
    expect(sniffImageType(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'))).toBeNull();
    expect(sniffImageType(Buffer.alloc(0))).toBeNull();
  });

  it('takes images with or without words, and refuses what is not one', () => {
    const png = attachment('image/png', PNG_BYTES, 'bracket.png');
    expect(parseSendMessage({ text: 'model this', attachments: [png] })).toEqual({ message: { text: 'model this', attachments: [png] } });
    // An image can go without words; nothing else can.
    expect(parseSendMessage({ text: '', attachments: [png] })).toEqual({ message: { text: '', attachments: [png] } });
    expect(parseSendMessage({ attachments: [png] })).toEqual({ message: { text: '', attachments: [png] } });
    expect(parseSendMessage({ text: '  ', attachments: [] })).toEqual({ error: '`text` must be a non-empty string.' });
    expect(parseSendMessage({ text: 'hi', attachments: [] })).toEqual({ message: { text: 'hi' } });

    // The bytes decide: a type they do not match, another format, nothing, too much, too many.
    const refused = (attachments: unknown) => 'error' in parseSendMessage({ text: 'hi', attachments });
    expect(refused([attachment('image/jpeg', PNG_BYTES)])).toBe(true);
    expect(refused([attachment('image/svg+xml', Buffer.from('<svg/>'))])).toBe(true);
    expect(refused([attachment('image/png', Buffer.from('not an image'))])).toBe(true);
    expect(refused([{ mediaType: 'image/png', base64: '' }])).toBe(true);
    expect(refused([attachment('image/png', Buffer.concat([PNG_BYTES, Buffer.alloc(MAX_ATTACHMENT_BYTES)]))])).toBe(true);
    expect(refused(Array.from({ length: MAX_ATTACHMENTS + 1 }, () => png))).toBe(true);
    expect(refused('bracket.png')).toBe(true);
    expect(refused(Array.from({ length: MAX_ATTACHMENTS }, () => png))).toBe(false);

    // A name is one short line; anything else about it is dropped.
    const named = parseSendMessage({ text: 'hi', attachments: [{ ...png, name: ` a\nb\u0000${'x'.repeat(300)}` }] });
    expect('message' in named && named.message.attachments![0].name).toBe(`a b ${'x'.repeat(116)}`);
    expect(parseSendMessage({ text: 'hi', attachments: [{ ...png, name: 7 }] })).toEqual({ message: { text: 'hi', attachments: [attachment('image/png', PNG_BYTES)] } });
  });

  it('stores them, shows them in the message and hands them to the agent before the capture', async () => {
    const id = (await json('POST', `${base}/sessions`, { agent: 'claude' })).body.id;
    const sent = await json('POST', `${base}/sessions/${id}/messages`, {
      text: 'model this',
      attachments: [attachment('image/jpeg', JPEG_BYTES, 'front view.jpg'), attachment('image/webp', WEBP_BYTES)],
      image: { mediaType: 'image/png', base64: PNG_BYTES.toString('base64') },
    });
    expect(sent.status).toBe(202);
    const snap = await idle(id);

    const parts = snap.messages[0].parts;
    expect(parts.map((p) => p.type)).toEqual(['text', 'image', 'image', 'image']);
    const [front, second, capture] = parts.slice(1) as { type: 'image'; file: string; name?: string }[];
    expect(front).toMatchObject({ name: 'front view.jpg', file: expect.stringMatching(/\.jpg$/) });
    expect(second).toMatchObject({ name: 'image', file: expect.stringMatching(/\.webp$/) });
    // The capture is the one image without a name.
    expect(capture.file).toMatch(/\.png$/);
    expect(capture.name).toBeUndefined();

    // The page reads each back under its own type.
    const served = await fetch(`${base}/sessions/${id}/files/${front.file}`);
    expect(served.headers.get('content-type')).toBe('image/jpeg');
    expect(Buffer.from(await served.arrayBuffer()).equals(JPEG_BYTES)).toBe(true);

    const run = backend.runs[0];
    expect(run.images[0].map((image) => image.mediaType)).toEqual(['image/jpeg', 'image/webp', 'image/png']);
    expect(run.images[0].map((image) => path.basename(image.path))).toEqual([front.file, second.file, capture.file]);
    expect(fs.readFileSync(run.images[0][1].path).equals(WEBP_BYTES)).toBe(true);
    expect(run.sent[0]).toContain('model this\n\n<attached_images count="2">\n  1: front view.jpg\n  2: image\n</attached_images>\n<workspace_state ');
  });

  it('runs a message of images only, titled by the first of them', async () => {
    const id = (await json('POST', `${base}/sessions`, { agent: 'claude' })).body.id;
    expect((await json('POST', `${base}/sessions/${id}/messages`, { text: '', attachments: [attachment('image/gif', GIF_BYTES, 'hinge.gif')] })).status).toBe(202);
    const snap = await idle(id);
    expect(snap.title).toBe('hinge.gif');
    expect(snap.messages[0].parts.map((p) => p.type)).toEqual(['image']);
    expect(backend.runs[0].sent[0].startsWith('<attached_images count="1">\n  1: hinge.gif\n</attached_images>\n<workspace_state ')).toBe(true);
    expect(backend.runs[0].images[0]).toHaveLength(1);

    // A message without images goes as before: no image, no block.
    await json('POST', `${base}/sessions/${id}/messages`, { text: 'thanks' });
    await idle(id);
    expect(backend.runs[0].images[1]).toEqual([]);
    expect(backend.runs[0].sent[1]).not.toContain('attached_images');
  });
});
