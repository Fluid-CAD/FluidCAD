import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { buildServer, TOOL_CLASSES, type RegistryEntry } from '../../mcp/dist/server.js';
import {
  CANCELLED_MESSAGE,
  DECLINED_MESSAGE,
  FORCE_REFUSED_MESSAGE,
  NO_TURN_MESSAGE,
  STOPPED_MESSAGE,
  TIMED_OUT_MESSAGE,
  ToolGate,
  canAllowForSession,
  needsApproval,
  toolClass,
  toolKind,
  toolTitle,
  type GateTimers,
  type ToolGateHost,
} from '../src/tool-gate.ts';
import type { Checkpoint } from '../src/session-store.ts';
import { applyChatEvent } from '../src/transcript.ts';
import { QUESTION_SKIPPED_NOTE, QUESTION_STOPPED_MESSAGE, QUESTION_TIMED_OUT_MESSAGE, readQuestionReply, readSvg } from '../src/questions.ts';
import { VARIANTS_ANSWERED_NOTE, VARIANTS_SKIPPED_NOTE, VARIANTS_STOPPED_MESSAGE, VARIANTS_TIMED_OUT_MESSAGE, readVariantsReply } from '../src/variants.ts';
import { findPart } from '../src/transcript.ts';
import type { ModelParam } from '../src/param-cards.ts';
import type { ChangePreview, ChatEvent, ChatMessage, ChatPart, ParamsPart, PermissionMode, QuestionItem, QuestionPart, ToolPart, VariantTile, VariantsPart } from '../src/types.ts';

// A stand-in for the engine the pinned server talks to: write_file and
// edit_range ask it for dirty buffers, a lint and a render. Only the dirty
// buffers matter here; every other route answers 404, which the tools treat
// as "older engine" and carry on.
let engine: http.Server;
let dirtyFiles: string[] = [];
/** What the engine's `POST /api/hub/install` does; null answers 404 like any other route. */
let hubInstall: ((body: any) => { status: number; json: unknown }) | null = null;
let hubInstalls: any[] = [];
/**
 * What the engine's `POST /api/scratch-build` answers for a candidate text
 * (propose_variants); null answers 404 like any other route. A promise holds
 * the build until the test lets it end.
 */
let scratchBuild: ((source: string) => unknown | Promise<unknown>) | null = null;
let scratchBuilds: { file: string; source: string; reuse?: boolean }[] = [];
/**
 * What the engine's `POST /api/scratch-build/cost` answers for a candidate
 * text (the preview of a change waiting for approval); null answers 404, an
 * engine without it.
 */
let scratchCost: ((source: string) => unknown | Promise<unknown>) | null = null;
let scratchCosts: string[] = [];
/** What the engine's lint says of a candidate text; null answers 404 (the tools then carry on). */
let lint: ((code: string) => unknown) | null = null;
let workspace: string;
let pinned: RegistryEntry;

beforeEach(async () => {
  workspace = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fluidcad-gate-')));
  dirtyFiles = [];
  hubInstall = null;
  hubInstalls = [];
  scratchBuild = null;
  scratchBuilds = [];
  scratchCost = null;
  scratchCosts = [];
  lint = null;
  engine = http.createServer((req, res) => {
    if ((req.url === '/api/scratch-build' && scratchBuild) || (req.url === '/api/scratch-build/cost' && scratchCost) || (req.url === '/api/lint-fluid-js' && lint)) {
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', async () => {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        let answer: unknown;
        if (req.url === '/api/scratch-build') {
          scratchBuilds.push({ file: body.file, source: body.source, ...(body.reuse !== undefined ? { reuse: body.reuse } : {}) });
          answer = await scratchBuild!(body.source);
        } else if (req.url === '/api/scratch-build/cost') {
          scratchCosts.push(body.source);
          answer = await scratchCost!(body.source);
        } else {
          answer = lint!(body.code);
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(answer));
      });
      return;
    }
    if (req.url === '/api/editor/dirty-files') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(dirtyFiles.map((p) => ({ path: p, lastModifiedMs: 0 }))));
      return;
    }
    if (req.url === '/api/hub/install' && hubInstall) {
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        hubInstalls.push(body);
        const answer = hubInstall!(body);
        res.writeHead(answer.status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(answer.json));
      });
      return;
    }
    req.resume();
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end('{"error":"not here"}');
  });
  await new Promise<void>((resolve) => engine.listen(0, '127.0.0.1', () => resolve()));
  pinned = {
    workspacePath: workspace,
    port: (engine.address() as AddressInfo).port,
    pid: process.pid,
    version: '0.0.0',
    startedAt: new Date(0).toISOString(),
  };
});

afterEach(async () => {
  for (const c of clients.splice(0)) {
    await c.close().catch(() => {});
  }
  engine.closeAllConnections();
  await new Promise<void>((resolve) => engine.close(() => resolve()));
  fs.rmSync(workspace, { recursive: true, force: true });
});

class FakeHost implements ToolGateHost {
  readonly events: ChatEvent[] = [];
  readonly messages: ChatMessage[] = [];
  readonly approvalChanges: string[][] = [];
  readonly questionChanges: string[][] = [];
  /** turnId → path → checkpoint, as the session keeps them on disk. */
  readonly checkpoints = new Map<string, Map<string, Checkpoint>>();
  turn: { turnId: string; mode: PermissionMode } | null = { turnId: 't1', mode: 'ask' };
  persisted = 0;
  /** The model on screen (workspace-relative; null: none) and what its last render declared. */
  modelFile: string | null = null;
  modelParams: ModelParam[] = [];
  private messageId: string | null = null;

  get workspacePath(): string {
    return workspace;
  }
  pinnedWorkspace(): RegistryEntry {
    return pinned;
  }
  activeTurn() {
    return this.turn;
  }
  assistantMessageId(): string {
    if (!this.messageId) {
      this.messageId = 'a1';
      this.emit({ type: 'message-start', message: { id: 'a1', role: 'assistant', turnId: 't1', createdAt: '' } });
    }
    return this.messageId;
  }
  emit(event: ChatEvent): void {
    this.events.push(event);
    applyChatEvent(this.messages, event);
  }
  part(messageId: string, partId: string): ChatPart | undefined {
    return findPart(this.messages, messageId, partId);
  }
  saveImage(): string {
    return 'img.png';
  }
  persist(): void {
    this.persisted += 1;
  }
  approvalsChanged(_turnId: string, ids: string[]): void {
    this.approvalChanges.push(ids);
  }
  questionsChanged(_turnId: string, ids: string[]): void {
    this.questionChanges.push(ids);
  }
  checkpoint(turnId: string, checkpoint: Checkpoint): boolean {
    const files = this.checkpoints.get(turnId) ?? new Map<string, Checkpoint>();
    this.checkpoints.set(turnId, files);
    if (files.has(checkpoint.path)) {
      return false;
    }
    files.set(checkpoint.path, checkpoint);
    return true;
  }
  dropCheckpoint(turnId: string, filePath: string): void {
    this.checkpoints.get(turnId)?.delete(filePath);
  }
  model() {
    return { file: this.modelFile === null ? null : path.join(workspace, this.modelFile), params: this.modelParams };
  }
  paramCards(): ParamsPart[] {
    return (this.messages[0]?.parts ?? []).filter((p): p is ParamsPart => p.type === 'params');
  }
  tools(): ToolPart[] {
    return (this.messages[0]?.parts ?? []).filter((p): p is ToolPart => p.type === 'tool');
  }
  questions(): QuestionPart[] {
    return (this.messages[0]?.parts ?? []).filter((p): p is QuestionPart => p.type === 'question');
  }
  variants(): VariantsPart[] {
    return (this.messages[0]?.parts ?? []).filter((p): p is VariantsPart => p.type === 'variants');
  }
  /** The variants card once it is in `state`. */
  async variantsIn(state: VariantsPart['state'], index = 0): Promise<VariantsPart> {
    for (let i = 0; i < 400; i++) {
      const part = this.variants()[index];
      if (part?.state === state) {
        return part;
      }
      await new Promise((r) => setTimeout(r, 5));
    }
    throw new Error(`no variants card is ${state}: ${JSON.stringify(this.variants())}`);
  }
  /** The id of the question waiting for the user, once it waits. */
  async asking(index = 0): Promise<string> {
    for (let i = 0; i < 400; i++) {
      const part = this.questions()[index];
      if (part?.state === 'awaiting-answer') {
        return part.id;
      }
      await new Promise((r) => setTimeout(r, 5));
    }
    throw new Error(`no question is waiting: ${JSON.stringify(this.questions())}`);
  }
  /** The approval id of the call waiting for the user, once it waits. */
  async waiting(index = 0): Promise<string> {
    for (let i = 0; i < 400; i++) {
      const part = this.tools()[index];
      if (part?.state === 'awaiting-approval' && part.approval) {
        return part.approval.id;
      }
      await new Promise((r) => setTimeout(r, 5));
    }
    throw new Error(`no approval is waiting: ${JSON.stringify(this.tools())}`);
  }
}

/** Timers the test fires by hand. */
class ManualTimers implements GateTimers {
  readonly scheduled = new Map<number, { fn: () => void; ms: number }>();
  private next = 1;
  setTimeout(fn: () => void, ms: number): unknown {
    const id = this.next++;
    this.scheduled.set(id, { fn, ms });
    return id;
  }
  clearTimeout(handle: unknown): void {
    this.scheduled.delete(handle as number);
  }
  fireAll(): void {
    for (const [id, { fn }] of [...this.scheduled]) {
      this.scheduled.delete(id);
      fn();
    }
  }
}

const clients: Client[] = [];

async function connect(gate: ToolGate, options: { ask?: boolean; variants?: boolean; params?: boolean } = {}): Promise<Client> {
  const server = buildServer({
    pinnedWorkspace: pinned,
    toolGate: gate,
    // As a chat session's endpoint builds it (mcp-endpoint.ts).
    ...(options.ask ? { askUser: (input, signal) => gate.ask(input, signal) } : {}),
    ...(options.variants ? { proposeVariants: (input, signal) => gate.propose(input, signal) } : {}),
    ...(options.params ? { offerParams: (input) => gate.offer(input) } : {}),
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'gate-test', version: '0.0.0' });
  await client.connect(clientTransport);
  clients.push(client);
  return client;
}

const textOf = (result: any) => (result.content as any[]).map((b) => b.text).join('');
const file = (name: string) => path.join(workspace, name);
const read = (name: string) => fs.readFileSync(file(name), 'utf8');

describe('ToolGate classification', () => {
  it('classifies every tool the pinned server offers, and nothing it does not', async () => {
    const client = await connect(new ToolGate(new FakeHost()));
    const { tools } = await client.listTools();
    const unclassified = tools.map((t) => t.name).filter((name) => toolClass(name) === undefined);
    // A new MCP tool must get a class in mcp/src/tool-classes.ts before it ships.
    expect(unclassified).toEqual([]);
    expect(tools.map((t) => t.name).sort()).toEqual(Object.keys(TOOL_CLASSES).sort());
  });

  it('maps classes to the kinds a tool card shows', () => {
    expect(toolKind('get_scene_summary')).toBe('read');
    expect(toolKind('read_file')).toBe('read');
    expect(toolKind('screenshot')).toBe('read');
    expect(toolKind('write_file')).toBe('edit');
    expect(toolKind('rollback_to')).toBe('edit');
    expect(toolKind('export')).toBe('outside');
    expect(toolKind('search_hub')).toBe('read');
    expect(toolKind('read_package_file')).toBe('read');
    expect(toolKind('install_package')).toBe('outside');
    expect(toolKind('not_a_tool')).toBe('other');
  });

  it('lets a scratch build through as a read, under a title naming the file', () => {
    expect(toolKind('try_build')).toBe('read');
    expect([needsApproval('try_build', 'ask'), needsApproval('try_build', 'auto-edits')]).toEqual([false, false]);
    expect(toolTitle('try_build', { path: '/ws/parts/plate.part.js', content: '…' }, '/ws')).toBe('Try a build of parts/plate.part.js');
    expect(toolTitle('try_build', {}, '/ws')).toBe('Try a build');
  });

  it('asks per class and permission mode (§12.1), for every tool', () => {
    const expected: Record<string, [ask: boolean, autoEdits: boolean, sessionOffered: boolean]> = {
      'read-docs': [false, false, false],
      'read-scene': [false, false, false],
      'read-view': [false, false, false],
      'read-source': [false, false, false],
      'read-hub': [false, false, false],
      'edit-files': [true, false, true],
      'edit-session': [true, false, true],
      'outside-workspace': [true, true, false],
    };
    for (const [name, cls] of Object.entries(TOOL_CLASSES)) {
      const [ask, autoEdits, sessionOffered] = expected[cls];
      expect([needsApproval(name, 'ask'), needsApproval(name, 'auto-edits'), canAllowForSession(name)], name).toEqual([
        ask,
        autoEdits,
        sessionOffered,
      ]);
    }
    // A tool the table does not know is asked about, always, and never allowed for the session.
    expect([needsApproval('mystery', 'ask'), needsApproval('mystery', 'auto-edits'), canAllowForSession('mystery')]).toEqual([true, true, false]);
  });
});

describe('ToolGate: reads', () => {
  it('runs a read tool without asking and records its result on a tool part', async () => {
    const host = new FakeHost();
    const client = await connect(new ToolGate(host));
    const result = await client.callTool({ name: 'read_skill', arguments: { name: 'fluidcad' } });
    expect(result.isError).not.toBe(true);

    const [part] = host.tools();
    expect(part).toMatchObject({ source: 'fluidcad', name: 'read_skill', title: 'Read the fluidcad skill', kind: 'read', state: 'done' });
    expect(part.approval).toBeUndefined();
    expect(part.output?.text).toContain('fluidcad');
    expect(host.persisted).toBe(2);
    expect(host.events.map((e) => e.type)).toEqual(['message-start', 'part-start', 'part-update']);
    expect(host.approvalChanges).toEqual([]);
  });

  it('runs nothing outside a turn', async () => {
    const host = new FakeHost();
    host.turn = null;
    const client = await connect(new ToolGate(host));
    const result = await client.callTool({ name: 'read_skill', arguments: { name: 'fluidcad' } });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toBe(NO_TURN_MESSAGE);
    expect(host.events).toEqual([]);
  });
});

describe('ToolGate: approval', () => {
  it('holds an edit for the user in ask mode, shows the diff, and runs it on allow', async () => {
    fs.writeFileSync(file('plate.part.js'), 'a\nb\nc\n');
    const host = new FakeHost();
    const gate = new ToolGate(host);
    const client = await connect(gate);
    const call = client.callTool({
      name: 'edit_range',
      arguments: { path: 'plate.part.js', start: { line: 1, column: 0 }, end: { line: 1, column: 1 }, newText: 'B' },
    });
    const id = await host.waiting();
    const [waiting] = host.tools();
    expect(waiting).toMatchObject({
      name: 'edit_range',
      title: 'Edit plate.part.js, line 2',
      kind: 'edit',
      state: 'awaiting-approval',
      approval: { id, canAllowSession: true },
      diff: '--- a/plate.part.js\n+++ b/plate.part.js\n@@ -1,3 +1,3 @@\n a\n-b\n+B\n c\n',
    });
    expect(gate.pendingApprovalIds()).toEqual([id]);
    expect(host.approvalChanges).toEqual([[id]]);
    // Nothing ran yet, and the waiting card was saved.
    expect(read('plate.part.js')).toBe('a\nb\nc\n');
    expect(host.checkpoints.size).toBe(0);
    const persistedWhileWaiting = host.persisted;
    expect(persistedWhileWaiting).toBeGreaterThanOrEqual(1);

    expect(gate.decide(id, 'allow')).toBe('ok');
    const result = await call;
    expect(result.isError).not.toBe(true);
    expect(read('plate.part.js')).toBe('a\nB\nc\n');
    expect(host.tools()[0]).toMatchObject({ state: 'done', approval: { id, canAllowSession: true, decision: 'allow' } });
    expect(host.approvalChanges).toEqual([[id], []]);
    // The checkpoint holds the file as it was before the call ran.
    expect([...host.checkpoints.get('t1')!.values()]).toEqual([{ path: file('plate.part.js'), existed: true, content: 'a\nb\nc\n' }]);
    // A second answer finds nothing waiting.
    expect(gate.decide(id, 'deny')).toBe('not-found');
  });

  it('shows a new file as created, against /dev/null', async () => {
    const host = new FakeHost();
    const gate = new ToolGate(host);
    const client = await connect(gate);
    const call = client.callTool({ name: 'write_file', arguments: { path: 'sub/new.fluid.js', content: 'x\ny\n' } });
    const id = await host.waiting();
    expect(host.tools()[0]).toMatchObject({
      title: 'Create sub/new.fluid.js',
      diff: '--- /dev/null\n+++ b/sub/new.fluid.js\n@@ -0,0 +1,2 @@\n+x\n+y\n',
    });
    gate.decide(id, 'allow');
    await call;
    expect(read('sub/new.fluid.js')).toBe('x\ny\n');
    expect([...host.checkpoints.get('t1')!.values()]).toEqual([{ path: file('sub/new.fluid.js'), existed: false, content: '' }]);
  });

  it('writes a diff of the whole file for write_file', async () => {
    fs.writeFileSync(file('a.fluid.js'), 'one\ntwo\n');
    const host = new FakeHost();
    host.turn = { turnId: 't1', mode: 'auto-edits' };
    const client = await connect(new ToolGate(host));
    await client.callTool({ name: 'write_file', arguments: { path: file('a.fluid.js'), content: 'one\n2\nthree\n' } });
    expect(host.tools()[0]).toMatchObject({
      title: 'Write a.fluid.js',
      state: 'done',
      diff: '--- a/a.fluid.js\n+++ b/a.fluid.js\n@@ -1,2 +1,3 @@\n one\n-two\n+2\n+three\n',
    });
    expect(host.tools()[0].approval).toBeUndefined();
  });

  it('runs workspace edits without asking in auto-edits, and still asks outside the workspace', async () => {
    const host = new FakeHost();
    host.turn = { turnId: 't1', mode: 'auto-edits' };
    const gate = new ToolGate(host);
    const client = await connect(gate);
    await client.callTool({ name: 'write_file', arguments: { path: 'a.fluid.js', content: 'x' } });
    expect(read('a.fluid.js')).toBe('x');
    expect(host.approvalChanges).toEqual([]);

    const exported = client.callTool({ name: 'export', arguments: { shapeIds: ['s'], format: 'step' } });
    const id = await host.waiting(1);
    expect(host.tools()[1]).toMatchObject({ name: 'export', kind: 'outside', approval: { id, canAllowSession: false } });
    // "Allow for this session" is not offered outside the workspace.
    expect(gate.decide(id, 'allow-session')).toBe('not-offered');
    expect(gate.decide(id, 'deny')).toBe('ok');
    const result = await exported;
    expect(textOf(result)).toBe(DECLINED_MESSAGE);
  });

  it('asks about a tool it does not know, even in auto-edits', async () => {
    const host = new FakeHost();
    host.turn = { turnId: 't1', mode: 'auto-edits' };
    const gate = new ToolGate(host);
    const decision = gate.before({ name: 'mystery', input: {} }, new AbortController().signal);
    const id = await host.waiting();
    expect(host.tools()[0]).toMatchObject({ kind: 'other', approval: { id, canAllowSession: false } });
    gate.decide(id, 'allow');
    expect(await decision).toEqual({ allow: true });
  });

  it('runs later calls of a tool allowed for the session without asking', async () => {
    fs.writeFileSync(file('a.fluid.js'), 'a\n');
    const host = new FakeHost();
    const gate = new ToolGate(host);
    const client = await connect(gate);
    const first = client.callTool({ name: 'write_file', arguments: { path: 'a.fluid.js', content: 'b\n' } });
    gate.decide(await host.waiting(), 'allow-session');
    await first;
    expect(host.tools()[0].approval?.decision).toBe('allow-session');
    expect(gate.sessionAllowedTools).toEqual(['write_file']);

    // The second write runs at once, in a later turn too.
    host.turn = { turnId: 't2', mode: 'ask' };
    const second = await client.callTool({ name: 'write_file', arguments: { path: 'a.fluid.js', content: 'c\n' } });
    expect(second.isError).not.toBe(true);
    expect(read('a.fluid.js')).toBe('c\n');
    expect(host.tools()[1]).toMatchObject({ state: 'done' });
    expect(host.tools()[1].approval).toBeUndefined();

    // Another edit tool still asks.
    const third = client.callTool({
      name: 'edit_range',
      arguments: { path: 'a.fluid.js', start: { line: 0, column: 0 }, end: { line: 0, column: 1 }, newText: 'd' },
    });
    gate.decide(await host.waiting(2), 'deny');
    await third;
  });

  it('denies: the model is told the user declined, and nothing runs', async () => {
    fs.writeFileSync(file('a.fluid.js'), 'a\n');
    const host = new FakeHost();
    const gate = new ToolGate(host);
    const client = await connect(gate);
    const call = client.callTool({ name: 'write_file', arguments: { path: 'a.fluid.js', content: 'b\n' } });
    const id = await host.waiting();
    gate.decide(id, 'deny');
    const result = await call;
    expect(result.isError).toBe(true);
    expect(textOf(result)).toBe('The user declined this action.');
    expect(read('a.fluid.js')).toBe('a\n');
    expect(host.tools()[0]).toMatchObject({ state: 'denied', approval: { id, decision: 'deny' } });
    expect(host.checkpoints.size).toBe(0);
  });

  it('denies every pending approval when the turn is stopped', async () => {
    const host = new FakeHost();
    const gate = new ToolGate(host);
    const client = await connect(gate);
    const call = client.callTool({ name: 'write_file', arguments: { path: 'a.fluid.js', content: 'b\n' } });
    const id = await host.waiting();
    // As AgentSession.cancel does: the turn stops taking calls, then pending ones are settled.
    host.turn = null;
    gate.settleAll('stopped');
    const result = await call;
    expect(textOf(result)).toBe(STOPPED_MESSAGE);
    expect(host.tools()[0]).toMatchObject({ state: 'denied', approval: { id, decision: 'deny' }, error: 'Stopped before you answered.' });
    expect(fs.existsSync(file('a.fluid.js'))).toBe(false);
    expect(gate.pendingApprovalIds()).toEqual([]);
  });

  it('does not run a call approved just as the turn was stopped', async () => {
    const host = new FakeHost();
    const gate = new ToolGate(host);
    const client = await connect(gate);
    const call = client.callTool({ name: 'write_file', arguments: { path: 'a.fluid.js', content: 'b\n' } });
    const id = await host.waiting();
    // The approval and the cancel land in the same tick, approval first.
    gate.decide(id, 'allow');
    host.turn = null;
    const result = await call;
    expect(textOf(result)).toBe(STOPPED_MESSAGE);
    expect(fs.existsSync(file('a.fluid.js'))).toBe(false);
    expect(host.tools()[0]).toMatchObject({ state: 'error', error: 'Stopped.' });
    expect(host.checkpoints.size).toBe(0);
  });

  it('refuses a call that arrives after the turn was stopped', async () => {
    const host = new FakeHost();
    const client = await connect(new ToolGate(host));
    host.turn = null;
    const result = await client.callTool({ name: 'write_file', arguments: { path: 'a.fluid.js', content: 'late' } });
    expect(textOf(result)).toBe(NO_TURN_MESSAGE);
    expect(fs.existsSync(file('a.fluid.js'))).toBe(false);
    expect(host.events).toEqual([]);
  });

  it('gives up when the client cancels the request', async () => {
    const host = new FakeHost();
    const gate = new ToolGate(host);
    const controller = new AbortController();
    const decision = gate.before({ name: 'recompute', input: {} }, controller.signal);
    await host.waiting();
    controller.abort();
    expect(await decision).toEqual({ allow: false, message: CANCELLED_MESSAGE });
    expect(host.tools()[0]).toMatchObject({ state: 'error', error: 'Cancelled.' });
    expect(gate.pendingApprovalIds()).toEqual([]);
  });

  it('fails a call nobody answered within the hour', async () => {
    const host = new FakeHost();
    const timers = new ManualTimers();
    const gate = new ToolGate(host, { timers });
    const decision = gate.before({ name: 'rollback_to', input: {} }, new AbortController().signal);
    await host.waiting();
    expect([...timers.scheduled.values()].map((t) => t.ms)).toEqual([60 * 60 * 1000]);
    timers.fireAll();
    expect(await decision).toEqual({ allow: false, message: TIMED_OUT_MESSAGE });
    expect(TIMED_OUT_MESSAGE).toContain('Approval timed out');
    expect(host.tools()[0]).toMatchObject({ state: 'error', error: 'Approval timed out.' });
    expect(gate.pendingApprovalIds()).toEqual([]);
  });

  it('clears the timer when the user answers', async () => {
    const host = new FakeHost();
    const timers = new ManualTimers();
    const gate = new ToolGate(host, { timers });
    const decision = gate.before({ name: 'recompute', input: {} }, new AbortController().signal);
    gate.decide(await host.waiting(), 'allow');
    expect(await decision).toEqual({ allow: true });
    expect(timers.scheduled.size).toBe(0);
  });

  it('settles pending approvals as denied when the engine shuts down', async () => {
    const host = new FakeHost();
    const gate = new ToolGate(host);
    const decision = gate.before({ name: 'recompute', input: {} }, new AbortController().signal);
    await host.waiting();
    host.turn = null;
    gate.settleAll('shutdown');
    expect(await decision).toEqual({ allow: false, message: STOPPED_MESSAGE });
    expect(host.tools()[0]).toMatchObject({ state: 'denied', error: 'The app closed before you answered.' });
  });
});

describe('ToolGate: installing a package from the hub', () => {
  const KIT = '@acme/kit';
  const PINNED = '{\n  "dependencies": {\n    "@acme/kit": { "version": "0.2.0", "integrity": "sha256-x" }\n  }\n}\n';
  /** The engine's install: answers the outcome, writing the pin into fluidcad.json when it pins. */
  const installing = (pin: 'pinned' | 'unchanged' | null) => (body: any) => {
    if (pin === 'pinned') {
      fs.writeFileSync(file('fluidcad.json'), PINNED);
    }
    return {
      status: 200,
      json: { name: body.name, version: '0.2.0', source: 'hub', status: 'installed', target: 'library', pin, upgradedFrom: null, notes: [], manifest: { features: [], parts: [], files: [] } },
    };
  };

  it('always asks, in auto-edits too, never offers the session, and a declined install never reaches the engine', async () => {
    hubInstall = installing('pinned');
    const host = new FakeHost();
    host.turn = { turnId: 't1', mode: 'auto-edits' };
    const gate = new ToolGate(host);
    const client = await connect(gate);
    const call = client.callTool({ name: 'install_package', arguments: { name: KIT } });
    const id = await host.waiting();
    expect(host.tools()[0]).toMatchObject({
      name: 'install_package',
      title: 'Install @acme/kit from the hub',
      kind: 'outside',
      input: { name: KIT },
      approval: { id, canAllowSession: false },
    });
    expect(gate.decide(id, 'allow-session')).toBe('not-offered');
    expect(gate.decide(id, 'deny')).toBe('ok');
    expect(textOf(await call)).toBe(DECLINED_MESSAGE);
    expect(hubInstalls).toEqual([]);
    expect(host.checkpoints.get('t1')?.size ?? 0).toBe(0);

    // Allowed once is once: the next install asks again.
    const again = client.callTool({ name: 'install_package', arguments: { name: KIT, version: '0.2.0', target: 'project' } });
    const second = await host.waiting(1);
    expect(host.tools()[1].title).toBe('Install @acme/kit@0.2.0 from the hub into this project');
    gate.decide(second, 'allow');
    expect((await again).isError).not.toBe(true);
    expect(hubInstalls).toEqual([{ name: KIT, version: '0.2.0', target: 'project' }]);
    const third = client.callTool({ name: 'install_package', arguments: { name: '@acme/other', upgrade: true } });
    const last = await host.waiting(2);
    expect(host.tools()[2].title).toBe('Upgrade to @acme/other from the hub');
    gate.decide(last, 'deny');
    await third;
  });

  it('searches and reads the hub without asking', async () => {
    const host = new FakeHost();
    const client = await connect(new ToolGate(host));
    await client.callTool({ name: 'search_hub', arguments: { query: 'standoff' } });
    await client.callTool({ name: 'get_hub_package', arguments: { name: KIT } });
    await client.callTool({ name: 'list_packages', arguments: {} });
    await client.callTool({ name: 'read_package_file', arguments: { name: KIT, version: '0.2.0', path: 'docs/standoff.md' } });
    expect(host.approvalChanges).toEqual([]);
    expect(host.tools().map((part) => [part.title, part.kind])).toEqual([
      ['Search the hub: standoff', 'read'],
      ['Read @acme/kit on the hub', 'read'],
      ['List the packages', 'read'],
      ['Read docs/standoff.md of @acme/kit', 'read'],
    ]);
  });

  it("keeps fluidcad.json as it was before an install that pins, so reverting the turn puts the pins back", async () => {
    fs.writeFileSync(file('fluidcad.json'), '{}\n');
    hubInstall = installing('pinned');
    const host = new FakeHost();
    const gate = new ToolGate(host);
    const client = await connect(gate);
    const call = client.callTool({ name: 'install_package', arguments: { name: KIT } });
    gate.decide(await host.waiting(), 'allow');
    expect((await call).isError).not.toBe(true);
    expect(read('fluidcad.json')).toBe(PINNED);
    expect([...host.checkpoints.get('t1')!.values()]).toEqual([{ path: file('fluidcad.json'), existed: true, content: '{}\n' }]);
    expect(host.tools()[0]).toMatchObject({ state: 'done' });
  });

  it('records that the install created fluidcad.json when the project had none', async () => {
    hubInstall = installing('pinned');
    const host = new FakeHost();
    const gate = new ToolGate(host);
    const client = await connect(gate);
    const call = client.callTool({ name: 'install_package', arguments: { name: KIT } });
    gate.decide(await host.waiting(), 'allow');
    await call;
    expect([...host.checkpoints.get('t1')!.values()]).toEqual([{ path: file('fluidcad.json'), existed: false, content: '' }]);
  });

  it('keeps no copy for an install that left fluidcad.json alone, or that the engine refused', async () => {
    fs.writeFileSync(file('fluidcad.json'), PINNED);
    hubInstall = installing('unchanged');
    const host = new FakeHost();
    const gate = new ToolGate(host);
    const client = await connect(gate);
    const used = client.callTool({ name: 'install_package', arguments: { name: KIT } });
    gate.decide(await host.waiting(), 'allow');
    await used;
    expect(host.checkpoints.get('t1')?.size ?? 0).toBe(0);

    hubInstall = () => ({ status: 409, json: { error: 'This project pins @acme/kit 0.2.0; pinning 0.3.0 instead would change its geometry.', code: 'version-change' } });
    const refused = client.callTool({ name: 'install_package', arguments: { name: KIT, version: '0.3.0' } });
    gate.decide(await host.waiting(1), 'allow');
    const result = await refused;
    expect(result.isError).toBe(true);
    expect(JSON.parse(textOf(result))).toMatchObject({ code: 'install-refused', details: { code: 'version-change' } });
    expect(host.tools()[1].state).toBe('error');
    expect(host.checkpoints.get('t1')?.size ?? 0).toBe(0);
  });

  it("leaves the turn's own earlier copy of fluidcad.json in place", async () => {
    fs.writeFileSync(file('fluidcad.json'), '{}\n');
    hubInstall = installing('unchanged');
    const host = new FakeHost();
    host.turn = { turnId: 't1', mode: 'auto-edits' };
    const gate = new ToolGate(host);
    const client = await connect(gate);
    await client.callTool({ name: 'write_file', arguments: { path: 'fluidcad.json', content: '{ "unit": "mm" }\n' } });
    const call = client.callTool({ name: 'install_package', arguments: { name: KIT } });
    gate.decide(await host.waiting(1), 'allow');
    await call;
    // The write's copy is the turn's: the install neither replaces nor drops it.
    expect([...host.checkpoints.get('t1')!.values()]).toEqual([{ path: file('fluidcad.json'), existed: true, content: '{}\n' }]);
  });
});

describe('ToolGate: checkpoints and refusals', () => {
  it('asks the host for a checkpoint on every file edit; the host keeps the first per file', async () => {
    fs.writeFileSync(file('a.fluid.js'), 'v1');
    const host = new FakeHost();
    host.turn = { turnId: 't1', mode: 'auto-edits' };
    const client = await connect(new ToolGate(host));
    await client.callTool({ name: 'write_file', arguments: { path: 'a.fluid.js', content: 'v2' } });
    await client.callTool({ name: 'write_file', arguments: { path: 'a.fluid.js', content: 'v3' } });
    expect([...host.checkpoints.get('t1')!.values()]).toEqual([{ path: file('a.fluid.js'), existed: true, content: 'v1' }]);
    // Reads and session edits take none.
    await client.callTool({ name: 'read_file', arguments: { path: 'a.fluid.js' } });
    expect(host.checkpoints.get('t1')!.size).toBe(1);
  });

  it('shows a dirty-buffer refusal as a card naming the file, keeps the model\'s result, and drops the checkpoint', async () => {
    fs.writeFileSync(file('bracket.fluid.js'), 'v1');
    dirtyFiles = [file('bracket.fluid.js')];
    const host = new FakeHost();
    host.turn = { turnId: 't1', mode: 'auto-edits' };
    const client = await connect(new ToolGate(host));
    const result = await client.callTool({ name: 'write_file', arguments: { path: 'bracket.fluid.js', content: 'v2' } });
    expect(result.isError).toBe(true);
    const raw = JSON.parse(textOf(result));
    expect(raw.code).toBe('dirty-buffer');
    expect(raw.message).toContain('unsaved changes');
    expect(read('bracket.fluid.js')).toBe('v1');
    const [part] = host.tools();
    expect(part).toMatchObject({
      state: 'error',
      errorCode: 'dirty-buffer',
      error: 'Not written: bracket.fluid.js has unsaved changes in the editor. Save it, then ask again.',
    });
    expect(part.output?.text).toBe(textOf(result));
    // The file was not changed: nothing to revert.
    expect(host.checkpoints.get('t1')?.size ?? 0).toBe(0);
  });

  it('refuses `force` on write_file and edit_range from the agent, even in auto-edits, and writes nothing', async () => {
    fs.writeFileSync(file('bracket.fluid.js'), 'v1\n');
    dirtyFiles = [file('bracket.fluid.js')];
    const host = new FakeHost();
    host.turn = { turnId: 't1', mode: 'auto-edits' };
    const client = await connect(new ToolGate(host));

    const forcedWrite = await client.callTool({ name: 'write_file', arguments: { path: 'bracket.fluid.js', content: 'v2\n', force: true } });
    expect(forcedWrite.isError).toBe(true);
    expect(textOf(forcedWrite)).toBe(FORCE_REFUSED_MESSAGE);
    expect(textOf(forcedWrite)).toContain('ask the user to save the file');

    const forcedEdit = await client.callTool({
      name: 'edit_range',
      arguments: { path: 'bracket.fluid.js', start: { line: 0, column: 0 }, end: { line: 0, column: 2 }, newText: 'v3', force: true },
    });
    expect(textOf(forcedEdit)).toBe(FORCE_REFUSED_MESSAGE);

    // Saved or not, the user's file is untouched and nothing was checkpointed.
    dirtyFiles = [];
    const savedButForced = await client.callTool({ name: 'write_file', arguments: { path: 'bracket.fluid.js', content: 'v4\n', force: true } });
    expect(textOf(savedButForced)).toBe(FORCE_REFUSED_MESSAGE);
    expect(read('bracket.fluid.js')).toBe('v1\n');
    expect(host.checkpoints.get('t1')?.size ?? 0).toBe(0);

    // Each attempt is a card the user sees.
    expect(host.tools().map((p) => [p.name, p.state])).toEqual([
      ['write_file', 'denied'],
      ['edit_range', 'denied'],
      ['write_file', 'denied'],
    ]);
    expect(host.tools()[0].error).toContain('force');

    // `force: false` is an ordinary write.
    const plain = await client.callTool({ name: 'write_file', arguments: { path: 'bracket.fluid.js', content: 'v5\n', force: false } });
    expect(plain.isError).not.toBe(true);
    expect(read('bracket.fluid.js')).toBe('v5\n');
  });
});

describe('ToolGate: questions (ask_user, §22)', () => {
  const THREAD = {
    question: 'Which thread should the holes take?',
    options: [{ label: 'M4', description: 'Fits the standoffs.' }, { label: 'M5' }],
  };
  const FACES = { question: 'Which faces get a chamfer?', options: [{ label: 'Top' }, { label: 'Bottom' }, { label: 'Sides' }], multiSelect: true };
  const WALL = { question: 'How thick should the wall be?' };

  it('is offered by a chat session\'s server only, as a read-only tool outside the class table', async () => {
    const plain = await connect(new ToolGate(new FakeHost()));
    expect((await plain.listTools()).tools.map((t) => t.name)).not.toContain('ask_user');
    const asking = await connect(new ToolGate(new FakeHost()), { ask: true });
    const tool = (await asking.listTools()).tools.find((t) => t.name === 'ask_user')!;
    expect(tool.annotations).toEqual({ readOnlyHint: true });
    expect(toolClass('ask_user')).toBeUndefined();
    expect(Object.keys((tool.inputSchema as any).properties)).toEqual(['questions']);
  });

  it('shows the questions as one card, waits, and returns what the user answered', async () => {
    const host = new FakeHost();
    const gate = new ToolGate(host);
    const client = await connect(gate, { ask: true });
    const call = client.callTool({ name: 'ask_user', arguments: { questions: [THREAD, FACES, WALL] } });
    const id = await host.asking();
    expect(host.questions()[0]).toEqual({
      type: 'question',
      id,
      state: 'awaiting-answer',
      questions: [THREAD, FACES, WALL],
    });
    // A card of its own, not a tool card; nothing to approve.
    expect(host.tools()).toEqual([]);
    expect(host.approvalChanges).toEqual([]);
    expect(host.questionChanges).toEqual([[id]]);
    expect(gate.pendingQuestionIds('t1')).toEqual([id]);
    const saved = host.persisted;
    expect(saved).toBeGreaterThan(0);

    expect(gate.answer(id, { answers: [{ selected: ['M4'] }, { selected: ['Sides', 'Top'], text: ' outer edges only ' }, { selected: [] }] })).toEqual({ result: 'ok' });
    const result = await call;
    expect(result.isError).not.toBe(true);
    expect(JSON.parse(textOf(result))).toEqual({
      answers: [
        { question: THREAD.question, selected: ['M4'] },
        { question: FACES.question, selected: ['Sides', 'Top'], text: 'outer edges only' },
        { question: WALL.question, skipped: true },
      ],
    });
    expect(host.questions()[0]).toMatchObject({
      state: 'answered',
      answers: [{ selected: ['M4'] }, { selected: ['Sides', 'Top'], text: 'outer edges only' }, { selected: [] }],
    });
    expect(host.questionChanges).toEqual([[id], []]);
    expect(gate.pendingQuestionIds()).toEqual([]);
    expect(host.persisted).toBeGreaterThan(saved);
    // The first answer won: a second (another tab) finds nothing waiting.
    expect(gate.answer(id, { skip: true })).toEqual({ result: 'not-found' });
  });

  it('a skip tells the model to decide for itself', async () => {
    const host = new FakeHost();
    const gate = new ToolGate(host);
    const client = await connect(gate, { ask: true });
    const call = client.callTool({ name: 'ask_user', arguments: { questions: [THREAD] } });
    expect(gate.answer(await host.asking(), { skip: true })).toEqual({ result: 'ok' });
    const result = await call;
    expect(result.isError).not.toBe(true);
    expect(JSON.parse(textOf(result))).toEqual({ skipped: true, note: QUESTION_SKIPPED_NOTE });
    expect(host.questions()[0].state).toBe('skipped');
  });

  it('refuses a reply that does not fit the questions, and keeps waiting', async () => {
    const host = new FakeHost();
    const gate = new ToolGate(host);
    const pending = gate.ask({ questions: [THREAD, WALL] }, new AbortController().signal);
    const id = await host.asking();
    const refused = [
      {},
      { answers: [{ selected: ['M4'] }] },
      { answers: [{ selected: ['M6'] }, { selected: [] }] },
      { answers: [{ selected: ['M4', 'M5'] }, { selected: [] }] },
      { answers: [{ selected: [] }, { selected: ['M4'] }] },
      { answers: [{ selected: 'M4' }, { selected: [] }] },
      { answers: [{ selected: [], text: 7 }, { selected: [] }] },
      { answers: [{ selected: [], text: 'x'.repeat(2001) }, { selected: [] }] },
      { answers: [{ selected: [] }, { selected: [], text: '   ' }] },
    ];
    for (const body of refused) {
      expect(gate.answer(id, body).result, JSON.stringify(body).slice(0, 80)).toBe('invalid');
    }
    expect(host.questions()[0].state).toBe('awaiting-answer');
    expect(gate.answer(id, { answers: [{}, { text: '2 mm' }] })).toEqual({ result: 'ok' });
    expect(JSON.parse(textOf(await pending))).toEqual({
      answers: [{ question: THREAD.question, skipped: true }, { question: WALL.question, text: '2 mm' }],
    });
  });

  it('reads a reply: picks deduplicated, text trimmed, one option unless the question takes several', () => {
    const questions: QuestionItem[] = [THREAD, FACES];
    expect(readQuestionReply(questions, { answers: [{ selected: ['M5', 'M5'] }, { selected: ['Top', 'Bottom'], text: '' }] })).toEqual({
      ok: true,
      reply: { answers: [{ selected: ['M5'] }, { selected: ['Top', 'Bottom'] }] },
    });
    expect(readQuestionReply(questions, { skip: true, answers: 'ignored' })).toEqual({ ok: true, reply: { skip: true } });
    expect(readQuestionReply(questions, null).ok).toBe(false);
  });

  it('refuses options one answer could not tell apart, and questions the schema does not allow', async () => {
    const host = new FakeHost();
    const client = await connect(new ToolGate(host), { ask: true });
    const twins = await client.callTool({
      name: 'ask_user',
      arguments: { questions: [{ question: 'Which?', options: [{ label: 'Top' }, { label: ' Top ' }] }] },
    });
    expect(twins.isError).toBe(true);
    expect(textOf(twins)).toContain('share the label "Top"');
    for (const questions of [[], [THREAD, THREAD, THREAD, THREAD, THREAD], [{ question: 'One?', options: [{ label: 'only' }] }], [{ question: '  ' }]]) {
      const result = await client.callTool({ name: 'ask_user', arguments: { questions } });
      expect(result.isError, JSON.stringify(questions).slice(0, 60)).toBe(true);
    }
    expect(host.events).toEqual([]);
  });

  it('carries the drawings of a question and its options to the card, namespaced', async () => {
    const host = new FakeHost();
    const gate = new ToolGate(host);
    const client = await connect(gate, { ask: true });
    const round = '<svg viewBox="0 0 120 90"><path d="M20 70 V40 A20 20 0 0 1 40 20 H100" fill="none" stroke="#222" stroke-width="2"/></svg>';
    const square = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 90"><path d="M20 70 V20 H100" fill="none" stroke="#222" stroke-width="2"/></svg>';
    const call = client.callTool({
      name: 'ask_user',
      arguments: {
        questions: [{ question: 'Which corner?', svg: `  ${square}\n`, options: [{ label: 'Round', svg: round }, { label: 'Square', svg: square }, { label: 'Either' }] }],
      },
    });
    const id = await host.asking();
    expect(host.questions()[0].questions).toEqual([
      {
        question: 'Which corner?',
        svg: square,
        options: [
          { label: 'Round', svg: round.replace('<svg ', '<svg xmlns="http://www.w3.org/2000/svg" ') },
          { label: 'Square', svg: square },
          { label: 'Either' },
        ],
      },
    ]);
    expect(gate.answer(id, { answers: [{ selected: ['Round'] }] })).toEqual({ result: 'ok' });
    // The drawings are for the user: the answer names the label only.
    expect(JSON.parse(textOf(await call))).toEqual({ answers: [{ question: 'Which corner?', selected: ['Round'] }] });
  });

  it('reads a drawing: one svg element with a viewBox, given its namespace when it has none', () => {
    const ns = 'xmlns="http://www.w3.org/2000/svg"';
    expect(readSvg('<svg viewBox="0 0 10 10"/>').ok).toBe(false);
    expect(readSvg('<svg viewBox="0 0 10 10"></svg>')).toEqual({ ok: true, svg: `<svg ${ns} viewBox="0 0 10 10"></svg>` });
    expect(readSvg('<?xml version="1.0"?>\n<svg viewBox="0 0 10 10"></svg>')).toEqual({ ok: true, svg: `<svg ${ns} viewBox="0 0 10 10"></svg>` });
    // A namespace of its own stays; `xmlns:xlink` alone is not one.
    expect(readSvg(`<svg ${ns} viewBox="0 0 10 10"></svg>`)).toEqual({ ok: true, svg: `<svg ${ns} viewBox="0 0 10 10"></svg>` });
    expect(readSvg('<svg xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 10 10"></svg>')).toMatchObject({
      svg: `<svg ${ns} xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 10 10"></svg>`,
    });
    // The viewBox is the root's own: a `>` in an attribute does not end the tag, a nested svg's does not count.
    expect(readSvg('<svg aria-label="a > b" viewBox="0 0 10 10"></svg>').ok).toBe(true);
    expect(readSvg('<svg width="10" height="10"><svg viewBox="0 0 10 10"/></svg>')).toMatchObject({ ok: false, error: expect.stringContaining('viewBox') });
    for (const bad of ['a circle', '```svg\n<svg viewBox="0 0 1 1"></svg>\n```', '<svg viewBox="0 0 1 1"></svg> or so', '<svgx viewBox="0 0 1 1"></svg>', '<div><svg viewBox="0 0 1 1"></svg></div>', '<svg viewBox="0 0 1 1"']) {
      expect(readSvg(bad), bad).toMatchObject({ ok: false, error: expect.stringContaining('one `<svg …>…</svg>` element') });
    }
  });

  it('refuses a drawing the card could not show, and says whose it is', async () => {
    const host = new FakeHost();
    const client = await connect(new ToolGate(host), { ask: true });
    const ofOption = await client.callTool({
      name: 'ask_user',
      arguments: { questions: [{ question: 'Which corner?', options: [{ label: 'Round', svg: '<svg width="40" height="40"></svg>' }, { label: 'Square' }] }] },
    });
    expect(ofOption.isError).toBe(true);
    expect(textOf(ofOption)).toBe('The `svg` of the option "Round" needs a `viewBox` (for example `viewBox="0 0 120 90"`), or it cannot be scaled to the card.');
    const ofQuestion = await client.callTool({ name: 'ask_user', arguments: { questions: [{ question: 'How long?', svg: 'a bar with its length marked L' }] } });
    expect(ofQuestion.isError).toBe(true);
    expect(textOf(ofQuestion)).toContain('The `svg` of "How long?" must be one `<svg …>…</svg>` element');
    expect(host.events).toEqual([]);
  });

  it('asks nothing outside a turn', async () => {
    const host = new FakeHost();
    host.turn = null;
    const client = await connect(new ToolGate(host), { ask: true });
    const result = await client.callTool({ name: 'ask_user', arguments: { questions: [WALL] } });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toBe(NO_TURN_MESSAGE);
    expect(host.events).toEqual([]);
  });

  it('ends unanswered when the turn is stopped or the engine shuts down', async () => {
    for (const [reason, words] of [['stopped', 'Stopped before you answered.'], ['shutdown', 'The app closed before you answered.']] as const) {
      const host = new FakeHost();
      const gate = new ToolGate(host);
      const pending = gate.ask({ questions: [WALL] }, new AbortController().signal);
      const id = await host.asking();
      host.turn = null;
      gate.settleAll(reason);
      const result = await pending;
      expect(result.isError).toBe(true);
      expect(textOf(result)).toBe(QUESTION_STOPPED_MESSAGE);
      expect(host.questions()[0]).toMatchObject({ id, state: 'unanswered', reason: words });
      expect(gate.pendingQuestionIds()).toEqual([]);
    }
  });

  it('gives up when the client cancels the request, and after an hour with no answer', async () => {
    const host = new FakeHost();
    const gate = new ToolGate(host);
    const controller = new AbortController();
    const cancelled = gate.ask({ questions: [WALL] }, controller.signal);
    await host.asking();
    controller.abort();
    expect(textOf(await cancelled)).toBe(CANCELLED_MESSAGE);
    expect(host.questions()[0]).toMatchObject({ state: 'unanswered', reason: 'Cancelled.' });

    const late = new FakeHost();
    const timers = new ManualTimers();
    const slow = new ToolGate(late, { timers });
    const timedOut = slow.ask({ questions: [WALL] }, new AbortController().signal);
    await late.asking();
    expect([...timers.scheduled.values()].map((t) => t.ms)).toEqual([60 * 60 * 1000]);
    timers.fireAll();
    const result = await timedOut;
    expect(result.isError).toBe(true);
    expect(textOf(result)).toBe(QUESTION_TIMED_OUT_MESSAGE);
    expect(late.questions()[0]).toMatchObject({ state: 'unanswered', reason: 'Not answered within an hour.' });
    expect(slow.pendingQuestionIds()).toEqual([]);
  });

  it('clears the timer when the user answers', async () => {
    const host = new FakeHost();
    const timers = new ManualTimers();
    const gate = new ToolGate(host, { timers });
    const pending = gate.ask({ questions: [WALL] }, new AbortController().signal);
    gate.answer(await host.asking(), { answers: [{ text: '3' }] });
    await pending;
    expect(timers.scheduled.size).toBe(0);
  });
});

describe('ToolGate: variants (propose_variants, §24)', () => {
  const BASE = 'base();\n';
  const RIB = 'base();\nrib();\n';
  const GUSSET = 'base();\ngusset();\n';
  /** The gusset as an edit of the file on disk: a line appended. */
  const GUSSET_EDIT = [{ start: { line: 1, column: 0 }, end: { line: 1, column: 0 }, newText: 'gusset();\n' }];
  const VARIANTS = [
    { label: 'Rib', description: 'One rib under the arm.', content: RIB },
    { label: 'Gusset', edits: GUSSET_EDIT },
  ];
  const call = (variants: object[] = VARIANTS, extra: object = {}) => ({
    name: 'propose_variants',
    arguments: { path: 'bracket.fluid.js', question: 'Which stiffener?', variants, ...extra },
  });

  /** A scratch build that rendered, as the engine answers one. */
  const rendered = (id: string, size: [number, number, number], volume: number) => ({
    state: 'rendered',
    id,
    file: 'bracket.fluid.js',
    sceneKind: 'part',
    unit: 'mm',
    durationMs: 12,
    builtFrom: 'source',
    configuration: 'Default',
    sessionOverrides: 0,
    unusedParams: [],
    solidCount: 1,
    bounds: { min: [0, 0, 0], max: size },
    volume,
    validation: { ok: true, checked: 1, findings: [], skipped: 0 },
  });
  const RIB_BUILD = rendered('11111111-1111-4111-8111-111111111111', [80, 40, 30.5], 41200);
  const GUSSET_BUILD = rendered('22222222-2222-4222-8222-222222222222', [80, 40, 30], 44000);
  const COMPILE_ERROR = {
    state: 'compile-error',
    file: 'x',
    durationMs: 2,
    compileError: { message: 'gusset is not defined\n    at eval', sourceLocation: { filePath: 'x', line: 2, column: 1 } },
  };
  const builds = (source: string) => (source === RIB ? RIB_BUILD : source === GUSSET ? GUSSET_BUILD : COMPILE_ERROR);

  beforeEach(() => {
    fs.writeFileSync(file('bracket.fluid.js'), BASE);
    scratchBuild = builds;
  });

  it('is offered by a chat session\'s server only, annotated as the write it ends in, outside the class table', async () => {
    const plain = await connect(new ToolGate(new FakeHost()), { ask: true });
    expect((await plain.listTools()).tools.map((t) => t.name)).not.toContain('propose_variants');
    const proposing = await connect(new ToolGate(new FakeHost()), { variants: true });
    const tool = (await proposing.listTools()).tools.find((t) => t.name === 'propose_variants')!;
    expect(tool.annotations).toEqual({ readOnlyHint: false, destructiveHint: true });
    expect(toolClass('propose_variants')).toBeUndefined();
    expect(Object.keys((tool.inputSchema as any).properties)).toEqual(['path', 'question', 'variants']);
  });

  it('shows the card at once, builds the variants one after the other, waits, and writes the one the user picks', async () => {
    const host = new FakeHost();
    const gate = new ToolGate(host);
    const client = await connect(gate, { variants: true });
    // The first build is held, so the card is seen before any tile fills in.
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => { release = resolve; });
    scratchBuild = async (source) => {
      if (source === RIB) {
        await held;
      }
      return builds(source);
    };
    const pending = client.callTool(call());
    await expect.poll(() => host.variants()[0]?.variants[0].state).toBe('building');
    const card = host.variants()[0];
    expect(card).toEqual({
      type: 'variants',
      id: card.id,
      state: 'building',
      file: 'bracket.fluid.js',
      question: 'Which stiffener?',
      variants: [
        { label: 'Rib', description: 'One rib under the arm.', state: 'building' },
        { label: 'Gusset', state: 'queued' },
      ],
    });
    // One build at a time; a reply before they are done is refused; nothing waits for the user yet.
    expect(scratchBuilds).toHaveLength(1);
    expect(gate.choose(card.id, { pick: 'Rib' })).toEqual({ result: 'building' });
    expect(gate.pendingQuestionIds()).toEqual([]);
    expect(gate.pendingVariantIds('t1')).toEqual([card.id]);
    expect(host.questionChanges).toEqual([]);
    expect(host.persisted).toBeGreaterThan(0);

    release();
    const waiting = await host.variantsIn('awaiting-choice');
    // Each candidate was built as the file would be with it: the whole text, and the edits applied to the disk's.
    expect(scratchBuilds).toEqual([
      { file: file('bracket.fluid.js'), source: RIB },
      { file: file('bracket.fluid.js'), source: GUSSET },
    ]);
    expect(waiting.variants).toEqual([
      {
        label: 'Rib',
        description: 'One rib under the arm.',
        state: 'ready',
        buildId: RIB_BUILD.id,
        sceneKind: 'part',
        facts: { solidCount: 1, size: [80, 40, 30.5], volume: 41200, unit: 'mm', sound: true },
      },
      {
        label: 'Gusset',
        state: 'ready',
        buildId: GUSSET_BUILD.id,
        sceneKind: 'part',
        facts: { solidCount: 1, size: [80, 40, 30], volume: 44000, unit: 'mm', sound: true },
      },
    ]);
    // It waits as a question does; nothing is written, copied or asked for approval (the mode is `ask`).
    expect(host.questionChanges).toEqual([[card.id]]);
    expect(gate.pendingQuestionIds('t1')).toEqual([card.id]);
    expect(host.tools()).toEqual([]);
    expect(host.approvalChanges).toEqual([]);
    expect(read('bracket.fluid.js')).toBe(BASE);
    expect(host.checkpoints.get('t1')?.size ?? 0).toBe(0);

    expect(gate.choose(card.id, { pick: 'Gusset' })).toEqual({ result: 'ok' });
    const result = await pending;
    expect(result.isError).not.toBe(true);
    // The stand-in engine has no render route: the write reports that, as write_file would.
    expect(JSON.parse(textOf(result))).toEqual({ picked: 'Gusset', render: { state: 'render-failed', error: expect.any(String) } });
    expect(read('bracket.fluid.js')).toBe(GUSSET);
    // Checkpointed as a write_file of the turn is: reverting the turn puts the file back.
    expect([...host.checkpoints.get('t1')!.values()]).toEqual([{ path: file('bracket.fluid.js'), existed: true, content: BASE }]);
    expect(host.variants()[0]).toMatchObject({ state: 'picked', picked: 'Gusset' });
    // The write is a card of its own after the variants card, with its diff and its result.
    const [write] = host.tools();
    expect(write).toMatchObject({
      name: 'write_file',
      title: 'Apply "Gusset" to bracket.fluid.js',
      kind: 'edit',
      state: 'done',
      input: { path: 'bracket.fluid.js', variant: 'Gusset' },
    });
    expect(write.approval).toBeUndefined();
    expect(write.diff).toContain('+gusset();');
    expect(JSON.parse(write.output!.text!).render.state).toBe('render-failed');
    expect(host.messages[0].parts.map((p) => p.type)).toEqual(['variants', 'tool']);
    expect(host.questionChanges).toEqual([[card.id], []]);
    expect(gate.pendingVariantIds()).toEqual([]);
    // The first reply won: a second (another tab) finds nothing waiting.
    expect(gate.choose(card.id, { skip: true })).toEqual({ result: 'not-found' });
  });

  it('shows a variant that does not build as failed with its reason, and it cannot be picked', async () => {
    const host = new FakeHost();
    const gate = new ToolGate(host);
    const client = await connect(gate, { variants: true });
    const featureFails = {
      ...GUSSET_BUILD,
      state: 'build-error',
      objectErrors: [
        { index: 3, id: 'x', name: 'Fillet 1', uniqueKind: 'fillet', message: 'the radius may be too large', sourceLocation: { filePath: 'x', line: 7, column: 1 } },
        { index: 4, id: 'y', name: 'Shell 1', uniqueKind: 'shell', message: 'no' },
      ],
    };
    scratchBuild = (source) => (source === RIB ? RIB_BUILD : featureFails);
    const pending = client.callTool(call());
    const card = await host.variantsIn('awaiting-choice');
    // A build with a failed feature still has a scene: its tile keeps the build to draw, and says what failed.
    expect(card.variants[1]).toMatchObject({
      label: 'Gusset',
      state: 'failed',
      buildId: GUSSET_BUILD.id,
      error: 'Fillet 1 does not build (line 7): the radius may be too large, and 1 more',
    });
    expect(gate.choose(card.id, { pick: 'Gusset' })).toEqual({ result: 'invalid', error: '"Gusset" did not build, so it cannot be picked.' });
    expect(gate.choose(card.id, { pick: 'Web' })).toMatchObject({ result: 'invalid' });
    expect(gate.choose(card.id, {})).toMatchObject({ result: 'invalid' });
    expect(gate.choose(card.id, { pick: 'Rib' })).toEqual({ result: 'ok' });
    const result = JSON.parse(textOf(await pending));
    expect(result.picked).toBe('Rib');
    expect(result.failed).toEqual([{ label: 'Gusset', reason: 'Fillet 1 does not build (line 7): the radius may be too large, and 1 more' }]);
    expect(read('bracket.fluid.js')).toBe(RIB);
  });

  it('returns an error without asking when neither variant builds', async () => {
    const host = new FakeHost();
    const gate = new ToolGate(host);
    const client = await connect(gate, { variants: true });
    scratchBuild = () => COMPILE_ERROR;
    const result = await client.callTool(call());
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('Neither variant built, so the user was not asked');
    expect(textOf(result)).toContain('- "Rib": It does not compile: gusset is not defined (line 2)');
    expect(host.variants()[0]).toMatchObject({
      state: 'failed',
      reason: 'Neither variant built.',
      variants: [{ state: 'failed', error: 'It does not compile: gusset is not defined (line 2)' }, { state: 'failed' }],
    });
    expect(host.variants()[0].variants[0].buildId).toBeUndefined();
    expect(host.questionChanges).toEqual([]);
    expect(read('bracket.fluid.js')).toBe(BASE);
  });

  it('refuses a call a write would refuse, naming the variant, before anything is built or shown', async () => {
    const host = new FakeHost();
    const gate = new ToolGate(host);
    const client = await connect(gate, { variants: true });
    const refused = async (variants: object[], extra: object = {}) => {
      const result = await client.callTool(call(variants, extra));
      expect(result.isError, JSON.stringify(variants).slice(0, 80)).toBe(true);
      return textOf(result);
    };
    expect(await refused([VARIANTS[0], { label: ' Rib ', content: GUSSET }])).toBe('Both variants are labelled "Rib". Give each its own label.');
    expect(await refused([VARIANTS[0], { label: 'Gusset', content: GUSSET, edits: GUSSET_EDIT }])).toContain('Variant "Gusset": give the candidate as `content` (the whole file) or as `edits`, not both.');
    expect(await refused([VARIANTS[0], { label: 'Gusset' }])).toContain('Variant "Gusset"');
    expect(await refused([VARIANTS[0], { label: 'Same', content: RIB }])).toBe('"Rib" and "Same" are the same text. Offer two variants that differ, or make the change directly.');
    expect(JSON.parse(await refused(VARIANTS, { path: 'notes.txt' }))).toMatchObject({ code: 'invalid-input', details: { variant: 'Rib' } });
    expect(JSON.parse(await refused(VARIANTS, { path: '../outside.fluid.js' }))).toMatchObject({ code: 'invalid-input' });

    // write_file's lint: the second candidate uses a symbol without its import.
    lint = (code) => (code === GUSSET
      ? { missing: [{ symbol: 'gusset', module: 'fluidcad/core', line: 1, column: 0 }], suggestion: 'import { gusset } from "fluidcad/core";' }
      : { missing: [], suggestion: '' });
    const missing = JSON.parse(await refused(VARIANTS));
    expect(missing).toMatchObject({ code: 'missing-imports', details: { variant: 'Gusset', suggestion: 'import { gusset } from "fluidcad/core";' } });
    expect(missing.message).toMatch(/^Variant "Gusset": Not built: write_file would refuse this candidate/);
    lint = null;

    // Unsaved changes in the editor: a pick could not be written, so nothing is built for it.
    dirtyFiles = [file('bracket.fluid.js')];
    const dirty = JSON.parse(await refused(VARIANTS));
    expect(dirty.code).toBe('dirty-buffer');
    expect(dirty.message).toContain('"bracket.fluid.js" has unsaved changes in the editor');
    expect(dirty.message).not.toContain('force');

    expect(scratchBuilds).toEqual([]);
    expect(host.events).toEqual([]);
  });

  it('a skip or an answer in the user\'s own words writes nothing and tells the model so', async () => {
    const host = new FakeHost();
    const gate = new ToolGate(host);
    const client = await connect(gate, { variants: true });
    const skipped = client.callTool(call());
    expect(gate.choose((await host.variantsIn('awaiting-choice')).id, { skip: true })).toEqual({ result: 'ok' });
    expect(JSON.parse(textOf(await skipped))).toEqual({ skipped: true, note: VARIANTS_SKIPPED_NOTE });
    expect(host.variants()[0]).toMatchObject({ state: 'skipped' });

    const answered = client.callTool(call());
    const second = await host.variantsIn('awaiting-choice', 1);
    expect(gate.choose(second.id, { text: '   ' })).toMatchObject({ result: 'invalid' });
    expect(gate.choose(second.id, { text: ' neither — make the base thicker ' })).toEqual({ result: 'ok' });
    expect(JSON.parse(textOf(await answered))).toEqual({ answer: 'neither — make the base thicker', note: VARIANTS_ANSWERED_NOTE });
    expect(host.variants()[1]).toMatchObject({ state: 'answered', text: 'neither — make the base thicker' });

    expect(read('bracket.fluid.js')).toBe(BASE);
    expect(host.tools()).toEqual([]);
    expect(host.checkpoints.get('t1')?.size ?? 0).toBe(0);
  });

  it('reads a reply: a pick of a built tile, bounded words, or a skip', () => {
    const tiles: VariantTile[] = [{ label: 'Rib', state: 'ready' }, { label: 'Gusset', state: 'failed' }];
    expect(readVariantsReply(tiles, { pick: 'Rib' })).toEqual({ ok: true, reply: { pick: 'Rib' } });
    expect(readVariantsReply(tiles, { skip: true, pick: 'Gusset' })).toEqual({ ok: true, reply: { skip: true } });
    expect(readVariantsReply(tiles, { text: ' thicker ' })).toEqual({ ok: true, reply: { text: 'thicker' } });
    expect(readVariantsReply(tiles, { text: 'x'.repeat(2001) })).toMatchObject({ ok: false });
    expect(readVariantsReply(tiles, { pick: 3 })).toMatchObject({ ok: false });
    expect(readVariantsReply(tiles, null)).toMatchObject({ ok: false });
  });

  it('a stop cancels the build that has not started, and ends the card unanswered', async () => {
    const host = new FakeHost();
    const gate = new ToolGate(host);
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => { release = resolve; });
    scratchBuild = async (source) => {
      await held;
      return builds(source);
    };
    const pending = gate.propose({ path: 'bracket.fluid.js', variants: VARIANTS }, new AbortController().signal);
    await expect.poll(() => scratchBuilds.length).toBe(1);
    host.turn = null;
    gate.settleAll('stopped');
    // The card says so at once; the build in progress cannot be cancelled and its tile stays cancelled when it ends.
    expect(host.variants()[0]).toMatchObject({ state: 'unanswered', reason: 'Stopped before you chose.', variants: [{ state: 'cancelled' }, { state: 'cancelled' }] });
    release();
    const result = await pending;
    expect(result.isError).toBe(true);
    expect(textOf(result)).toBe(VARIANTS_STOPPED_MESSAGE);
    expect(scratchBuilds).toHaveLength(1);
    expect(host.variants()[0].variants.map((t) => t.state)).toEqual(['cancelled', 'cancelled']);
    expect(gate.pendingVariantIds()).toEqual([]);
    expect(read('bracket.fluid.js')).toBe(BASE);
  });

  it('ends unanswered when the engine shuts down, the client cancels, or an hour passes', async () => {
    const host = new FakeHost();
    const timers = new ManualTimers();
    const gate = new ToolGate(host, { timers });
    const signal = () => new AbortController().signal;

    const closing = gate.propose({ path: 'bracket.fluid.js', variants: VARIANTS }, signal());
    await host.variantsIn('awaiting-choice', 0);
    // The hour starts when the card starts waiting, not while it builds.
    expect([...timers.scheduled.values()].map((t) => t.ms)).toEqual([60 * 60 * 1000]);
    gate.settleAll('shutdown');
    expect(textOf(await closing)).toBe(VARIANTS_STOPPED_MESSAGE);
    expect(host.variants()[0]).toMatchObject({ state: 'unanswered', reason: 'The app closed before you chose.', variants: [{ state: 'ready' }, { state: 'ready' }] });
    expect(timers.scheduled.size).toBe(0);

    const controller = new AbortController();
    const cancelled = gate.propose({ path: 'bracket.fluid.js', variants: VARIANTS }, controller.signal);
    await host.variantsIn('awaiting-choice', 1);
    controller.abort();
    expect(textOf(await cancelled)).toBe(CANCELLED_MESSAGE);
    expect(host.variants()[1]).toMatchObject({ state: 'unanswered', reason: 'Cancelled.' });

    const late = gate.propose({ path: 'bracket.fluid.js', variants: VARIANTS }, signal());
    await host.variantsIn('awaiting-choice', 2);
    timers.fireAll();
    const result = await late;
    expect(result.isError).toBe(true);
    expect(textOf(result)).toBe(VARIANTS_TIMED_OUT_MESSAGE);
    expect(host.variants()[2]).toMatchObject({ state: 'unanswered', reason: 'Not chosen within an hour.' });
    expect(host.questionChanges.at(-1)).toEqual([]);
    expect(read('bracket.fluid.js')).toBe(BASE);
  });

  it('shows nothing outside a turn', async () => {
    const host = new FakeHost();
    host.turn = null;
    const result = await new ToolGate(host).propose({ path: 'bracket.fluid.js', variants: VARIANTS }, new AbortController().signal);
    expect(result.isError).toBe(true);
    expect(textOf(result)).toBe(NO_TURN_MESSAGE);
    expect(host.events).toEqual([]);
    expect(scratchBuilds).toEqual([]);
  });

  it('does not write a pick over a file that changed while the user was choosing', async () => {
    const host = new FakeHost();
    const gate = new ToolGate(host);
    const pending = gate.propose({ path: 'bracket.fluid.js', variants: VARIANTS }, new AbortController().signal);
    const card = await host.variantsIn('awaiting-choice');
    // The user saved an edit of their own meanwhile: the tiles show builds of the old text.
    fs.writeFileSync(file('bracket.fluid.js'), 'base();\nhole();\n');
    expect(gate.choose(card.id, { pick: 'Rib' })).toEqual({ result: 'ok' });
    const result = await pending;
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('The user picked "Rib", but bracket.fluid.js changed on disk while they were choosing, so it was not written.');
    expect(read('bracket.fluid.js')).toBe('base();\nhole();\n');
    expect(host.variants()[0]).toMatchObject({ state: 'failed', reason: 'bracket.fluid.js changed after these were built, so "Rib" was not written.' });
    expect(host.variants()[0].picked).toBeUndefined();
    expect(host.tools()).toEqual([]);
    expect(host.checkpoints.get('t1')?.size ?? 0).toBe(0);
  });

  it('refuses the write of a pick over unsaved editor changes as a write_file is refused, and keeps no copy', async () => {
    const host = new FakeHost();
    const gate = new ToolGate(host);
    const pending = gate.propose({ path: 'bracket.fluid.js', variants: VARIANTS }, new AbortController().signal);
    const card = await host.variantsIn('awaiting-choice');
    // The user started typing in the editor after the card came up.
    dirtyFiles = [file('bracket.fluid.js')];
    gate.choose(card.id, { pick: 'Rib' });
    const result = await pending;
    expect(result.isError).toBe(true);
    const error = JSON.parse(textOf(result));
    expect(error.code).toBe('dirty-buffer');
    expect(error.message).toMatch(/^The user picked "Rib", but it was not written: /);
    expect(read('bracket.fluid.js')).toBe(BASE);
    expect(host.variants()[0]).toMatchObject({ state: 'picked', picked: 'Rib' });
    expect(host.tools()[0]).toMatchObject({
      name: 'write_file',
      state: 'error',
      errorCode: 'dirty-buffer',
      error: 'Not written: bracket.fluid.js has unsaved changes in the editor. Save it, then ask again.',
    });
    expect(host.checkpoints.get('t1')?.size ?? 0).toBe(0);
  });

  it('leaves the engine free for a moment between two builds, so a page can fetch the first to draw it', async () => {
    const host = new FakeHost();
    const gate = new ToolGate(host, { buildPauseMs: 120 });
    const at: number[] = [];
    scratchBuild = (source) => {
      at.push(Date.now());
      return builds(source);
    };
    const pending = gate.propose({ path: 'bracket.fluid.js', variants: VARIANTS }, new AbortController().signal);
    const card = await host.variantsIn('awaiting-choice');
    expect(at[1] - at[0]).toBeGreaterThanOrEqual(110);
    gate.choose(card.id, { skip: true });
    await pending;
  });

  it('keeps a picture the page added to a tile while the other variant built', async () => {
    const host = new FakeHost();
    const gate = new ToolGate(host);
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => { release = resolve; });
    scratchBuild = async (source) => {
      if (source === GUSSET) {
        await held;
      }
      return builds(source);
    };
    const pending = gate.propose({ path: 'bracket.fluid.js', variants: VARIANTS }, new AbortController().signal);
    await expect.poll(() => host.variants()[0]?.variants[1].state).toBe('building');
    // As the session's picture route does: the tile gains its `image` in the transcript.
    const card = host.variants()[0];
    host.emit({ type: 'part-update', messageId: 'a1', partId: card.id, patch: { variants: card.variants.map((t, i) => (i === 0 ? { ...t, image: 'rib.png' } : t)) } });
    release();
    const waiting = await host.variantsIn('awaiting-choice');
    expect(waiting.variants.map((t) => [t.state, t.image])).toEqual([['ready', 'rib.png'], ['ready', undefined]]);
    gate.choose(card.id, { skip: true });
    await pending;
    expect(host.variants()[0].variants[0].image).toBe('rib.png');
  });
});

describe('ToolGate: parameter cards (offer_params, §26)', () => {
  const WIDTH: ModelParam = { label: 'Width', kind: 'part', body: 'Plate', defaultValue: 40, currentValue: 40, controlType: 'slider', min: 20, max: 80, step: 1 };
  // Declared with no control (`param('Depth', 5)`), and showing a session value.
  const DEPTH: ModelParam = { label: 'Depth', kind: 'part', body: 'Plate', defaultValue: 5, currentValue: 6, controlType: 'auto' };
  const STYLE: ModelParam = {
    label: 'Style',
    kind: 'part',
    body: 'Plate',
    defaultValue: 'round',
    currentValue: 'round',
    controlType: 'select',
    options: [{ label: 'Round', value: 'round' }, { label: 'Square', value: 'square' }],
  };
  const RIBBED: ModelParam = { label: 'Ribbed', kind: 'part', body: 'Plate', defaultValue: true, currentValue: true, controlType: 'auto' };
  const LID_WIDTH: ModelParam = { label: 'Width', kind: 'part', body: 'Lid', defaultValue: 30, currentValue: 30, controlType: 'number', min: 10 };
  const WALL: ModelParam = { label: 'Wall', kind: 'global', defaultValue: 2, currentValue: 2, controlType: 'number' };

  function hostWith(...params: ModelParam[]): FakeHost {
    const host = new FakeHost();
    host.modelFile = 'parts/plate.part.js';
    host.modelParams = params;
    return host;
  }
  const offer = (client: Client, args: object = {}) => client.callTool({ name: 'offer_params', arguments: args as Record<string, unknown> });

  it('is offered by a chat session\'s server only, as a read-only tool outside the class table', async () => {
    const plain = await connect(new ToolGate(new FakeHost()), { ask: true, variants: true });
    expect((await plain.listTools()).tools.map((t) => t.name)).not.toContain('offer_params');
    const offering = await connect(new ToolGate(new FakeHost()), { params: true });
    const tool = (await offering.listTools()).tools.find((t) => t.name === 'offer_params')!;
    expect(tool.annotations).toEqual({ readOnlyHint: true });
    expect(toolClass('offer_params')).toBeUndefined();
    expect(Object.keys((tool.inputSchema as any).properties)).toEqual(['params', 'note']);
  });

  it('puts the named parameters on a card and returns at once with what it shows', async () => {
    const host = hostWith(WIDTH, DEPTH, STYLE, RIBBED, LID_WIDTH);
    const gate = new ToolGate(host);
    const client = await connect(gate, { params: true });
    const result = await offer(client, {
      params: [{ label: 'Style' }, { label: 'Width', part: 'Plate' }, { label: 'Depth' }, { label: 'Ribbed' }, { label: 'Style' }],
      note: '  Wider plates\n need the ribs.  ',
    });
    expect(result.isError).not.toBe(true);
    // What the model is told: each parameter with its control and range; a value that is not the declared default says so.
    expect(JSON.parse(textOf(result))).toEqual({
      file: 'parts/plate.part.js',
      params: [
        { label: 'Style', part: 'Plate', type: 'select', value: 'round', options: ['round', 'square'] },
        { label: 'Width', part: 'Plate', type: 'slider', value: 40, min: 20, max: 80, step: 1 },
        { label: 'Depth', part: 'Plate', type: 'number', value: 6, default: 5 },
        { label: 'Ribbed', part: 'Plate', type: 'checkbox', value: true },
      ],
    });
    // The card: in the order asked, a parameter named twice once, the note on one line.
    expect(host.paramCards()).toEqual([
      {
        type: 'params',
        id: expect.stringMatching(/^params-/),
        file: 'parts/plate.part.js',
        absPath: path.join(workspace, 'parts/plate.part.js'),
        note: 'Wider plates need the ribs.',
        // Which parameters, and no more: their controls and values are the model's, read by the page.
        params: [
          { label: 'Style', part: 'Plate' },
          { label: 'Width', part: 'Plate' },
          { label: 'Depth', part: 'Plate' },
          { label: 'Ribbed', part: 'Plate' },
        ],
      },
    ]);
    // A card of its own: no tool card, nothing to approve or to answer, and it is saved.
    expect(host.tools()).toEqual([]);
    expect(host.approvalChanges).toEqual([]);
    expect(host.questionChanges).toEqual([]);
    expect(gate.pendingApprovalIds()).toEqual([]);
    expect(gate.pendingQuestionIds()).toEqual([]);
    expect(host.persisted).toBeGreaterThan(0);
    // Stopping the turn settles nothing of it: the card stays as it is.
    gate.settleAll('stopped');
    expect(host.paramCards()).toHaveLength(1);
    expect(host.events.filter((e) => e.type === 'part-update')).toEqual([]);
  });

  it('offers every parameter of the model when none is named, never a project parameter, and refuses more than a card shows', async () => {
    const host = hostWith(WIDTH, WALL, DEPTH);
    const client = await connect(new ToolGate(host), { params: true });
    const result = await offer(client);
    expect(result.isError).not.toBe(true);
    expect(JSON.parse(textOf(result)).params.map((p: any) => p.label)).toEqual(['Width', 'Depth']);
    expect(host.paramCards()[0].params.map((p) => p.label)).toEqual(['Width', 'Depth']);
    expect(host.paramCards()[0].note).toBeUndefined();

    const many = hostWith(...Array.from({ length: 13 }, (_, i): ModelParam => ({ label: `P${i}`, kind: 'part', body: 'Plate', defaultValue: i, currentValue: i, controlType: 'number' })));
    const crowded = await offer(await connect(new ToolGate(many), { params: true }));
    expect(crowded.isError).toBe(true);
    expect(textOf(crowded)).toContain('declares 13 parameters, more than a card shows (12)');
    expect(textOf(crowded)).toContain('"P12" (part "Plate")');
    expect(many.paramCards()).toEqual([]);
  });

  it('refuses a label the model does not declare, naming the ones it does, and shows nothing', async () => {
    const host = hostWith(WIDTH, DEPTH, LID_WIDTH, WALL);
    const client = await connect(new ToolGate(host), { params: true });
    const declares = 'The model on screen (parts/plate.part.js) declares: "Width" (part "Plate"), "Depth" (part "Plate"), "Width" (part "Lid").';

    const unknown = await offer(client, { params: [{ label: 'Depth' }, { label: 'Widht' }, { label: 'Depth', part: 'Lid' }] });
    expect(unknown.isError).toBe(true);
    expect(textOf(unknown)).toBe(`No parameter labelled "Widht". No parameter labelled "Depth" in "Lid". ${declares}`);

    // A label two parts declare needs its part; with it, each is its own parameter.
    const ambiguous = await offer(client, { params: [{ label: 'Width' }] });
    expect(ambiguous.isError).toBe(true);
    expect(textOf(ambiguous)).toBe(`"Width" is declared by "Plate" and "Lid": name the one you mean with \`part\`. ${declares}`);

    // A project parameter has no session value: it is not a card's to offer.
    const project = await offer(client, { params: [{ label: 'Wall' }] });
    expect(project.isError).toBe(true);
    expect(textOf(project)).toContain('"Wall" is a project parameter (a *.params.js file)');

    expect(host.paramCards()).toEqual([]);
    expect(host.events.filter((e) => e.type === 'part-start')).toEqual([]);

    const both = await offer(client, { params: [{ label: 'Width', part: 'Lid' }, { label: 'Width', part: 'Plate' }] });
    expect(both.isError).not.toBe(true);
    expect(host.paramCards()[0].params).toEqual([
      { label: 'Width', part: 'Lid' },
      { label: 'Width', part: 'Plate' },
    ]);
  });

  it('has nothing to offer without a model, without parameters, or outside a turn', async () => {
    const none = new FakeHost();
    const noModel = await offer(await connect(new ToolGate(none), { params: true }));
    expect(noModel.isError).toBe(true);
    expect(textOf(noModel)).toBe('No model is on screen, so there are no parameters to offer.');

    const bare = hostWith(WALL);
    const noParams = await offer(await connect(new ToolGate(bare), { params: true }));
    expect(noParams.isError).toBe(true);
    expect(textOf(noParams)).toBe(
      'The model on screen (parts/plate.part.js) declares no parameters in a part() or assembly() body, so there is nothing to offer. ' +
        'Its project parameters (*.params.js) are edited in the Parameters column, not on a card.',
    );

    const idle = hostWith(WIDTH);
    idle.turn = null;
    const late = await offer(await connect(new ToolGate(idle), { params: true }), { params: [{ label: 'Width' }] });
    expect(late.isError).toBe(true);
    expect(textOf(late)).toBe(NO_TURN_MESSAGE);
    for (const host of [none, bare, idle]) {
      expect(host.events).toEqual([]);
    }
  });
});

describe('ToolGate: what a change does to the model (§25)', () => {
  const BEFORE = 'base();\n';
  const AFTER = 'base();\nrib();\n';
  /** The change as the model makes it: a line appended. */
  const edit = (name = 'bracket.fluid.js', newText = 'rib();\n') => ({
    name: 'edit_range',
    arguments: { path: name, start: { line: 1, column: 0 }, end: { line: 1, column: 0 }, newText },
  });

  /** A scratch build that rendered, as the engine answers one. */
  const rendered = (id: string, size: [number, number, number], volume: number, geometry: string) => ({
    state: 'rendered',
    id,
    file: 'bracket.fluid.js',
    sceneKind: 'part',
    unit: 'mm',
    durationMs: 12,
    builtFrom: 'source',
    configuration: 'Default',
    sessionOverrides: 0,
    unusedParams: [],
    solidCount: 1,
    bounds: { min: [0, 0, 0], max: size },
    volume,
    validation: { ok: true, checked: 1, findings: [], skipped: 0 },
    geometry,
  });
  const BEFORE_BUILD = rendered('11111111-1111-4111-8111-111111111111', [80, 40, 30], 96000, 'digest-before');
  const AFTER_BUILD = rendered('22222222-2222-4222-8222-222222222222', [80, 40, 36], 97500, 'digest-after');
  const COMPILE_ERROR = {
    state: 'compile-error',
    file: 'x',
    durationMs: 2,
    compileError: { message: 'rib is not defined\n    at eval', sourceLocation: { filePath: 'x', line: 2, column: 1 } },
  };
  const builds = (source: string) => (source === BEFORE ? BEFORE_BUILD : source === AFTER ? AFTER_BUILD : COMPILE_ERROR);
  /** Nothing kept, and the file's last build took `lastBuildMs`. */
  const costs = (lastBuildMs: number | null, kept: string[] = []) => (source: string) =>
    ({ reusable: kept.includes(source) ? { ...builds(source), reused: true } : null, lastBuildMs });
  const previewIn = async (host: FakeHost, state: ChangePreview['state'], index = 0): Promise<ChangePreview> => {
    for (let i = 0; i < 400; i++) {
      const preview = host.tools()[index]?.preview;
      if (preview?.state === state) {
        return preview;
      }
      await new Promise((r) => setTimeout(r, 5));
    }
    throw new Error(`no preview is ${state}: ${JSON.stringify(host.tools()[index])}`);
  };
  /** Lets every request already on its way to the stand-in engine be answered. */
  const settled = () => new Promise((r) => setTimeout(r, 60));

  beforeEach(() => {
    fs.writeFileSync(file('bracket.fluid.js'), BEFORE);
    scratchBuild = builds;
    scratchCost = costs(140);
  });

  it('shows the card at once, then builds the file as it is and with the change, and says what differs', async () => {
    const host = new FakeHost();
    const gate = new ToolGate(host);
    const client = await connect(gate);
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => { release = resolve; });
    scratchCost = async (source) => {
      await held;
      return costs(140)(source);
    };
    const call = client.callTool(edit());
    const id = await host.waiting();
    // The approval waits with its diff before anything is known of the preview, and is saved.
    expect(host.tools()[0]).toMatchObject({ state: 'awaiting-approval', approval: { id }, diff: expect.stringContaining('+rib();') });
    expect(host.tools()[0].preview).toBeUndefined();
    expect(host.persisted).toBeGreaterThanOrEqual(1);
    expect(scratchBuilds).toEqual([]);
    release();

    const preview = await previewIn(host, 'ready');
    expect(preview).toEqual({
      state: 'ready',
      same: false,
      before: {
        state: 'built',
        buildId: BEFORE_BUILD.id,
        sceneKind: 'part',
        facts: { solidCount: 1, size: [80, 40, 30], volume: 96000, unit: 'mm', sound: true },
        bounds: { min: [0, 0, 0], max: [80, 40, 30] },
      },
      after: {
        state: 'built',
        buildId: AFTER_BUILD.id,
        sceneKind: 'part',
        facts: { solidCount: 1, size: [80, 40, 36], volume: 97500, unit: 'mm', sound: true },
        bounds: { min: [0, 0, 0], max: [80, 40, 36] },
      },
    });
    // Asked what each side costs, then each built once, the file as it is first, a kept build welcome.
    expect(scratchCosts).toEqual([BEFORE, AFTER]);
    expect(scratchBuilds).toEqual([
      { file: file('bracket.fluid.js'), source: BEFORE, reuse: true },
      { file: file('bracket.fluid.js'), source: AFTER, reuse: true },
    ]);
    // The card said it was building in between.
    const previews = host.events.flatMap((e) => (e.type === 'part-update' && (e.patch as Partial<ToolPart>).preview ? [(e.patch as Partial<ToolPart>).preview!] : []));
    expect(previews.map((p) => [p.state, p.before?.state, p.after?.state])).toEqual([
      ['building', undefined, undefined],
      ['building', 'built', undefined],
      ['building', 'built', 'built'],
      ['ready', 'built', 'built'],
    ]);
    // Nothing was written, and the approval is still the user's.
    expect(read('bracket.fluid.js')).toBe(BEFORE);
    expect(host.tools()[0].state).toBe('awaiting-approval');
    expect(gate.decide(id, 'allow')).toBe('ok');
    await call;
    expect(read('bracket.fluid.js')).toBe(AFTER);
    // Settled, the card keeps what it showed.
    expect(host.tools()[0]).toMatchObject({ approval: { decision: 'allow' }, preview: { state: 'ready', before: { buildId: BEFORE_BUILD.id }, after: { buildId: AFTER_BUILD.id } } });
  });

  it('builds only the file with the change when the change creates it', async () => {
    const host = new FakeHost();
    const gate = new ToolGate(host);
    const client = await connect(gate);
    const call = client.callTool({ name: 'write_file', arguments: { path: 'new.part.js', content: AFTER } });
    const id = await host.waiting();
    const preview = await previewIn(host, 'ready');
    expect(preview.before).toBeNull();
    expect(preview.same).toBeUndefined();
    expect(preview.after).toMatchObject({ state: 'built', buildId: AFTER_BUILD.id });
    expect(scratchCosts).toEqual([AFTER]);
    expect(scratchBuilds).toEqual([{ file: file('new.part.js'), source: AFTER, reuse: true }]);
    gate.decide(id, 'deny');
    await call;
    expect(host.tools()[0]).toMatchObject({ state: 'denied', preview: { state: 'ready', before: null } });
  });

  it('says a change does not build, with the reasons, and still lets the user answer', async () => {
    const host = new FakeHost();
    const gate = new ToolGate(host);
    const client = await connect(gate);
    const call = client.callTool(edit('bracket.fluid.js', 'rib(;\n'));
    const id = await host.waiting();
    const preview = await previewIn(host, 'ready');
    expect(preview.before).toMatchObject({ state: 'built' });
    // No build, so no picture and no facts: the reason, and its line.
    expect(preview.after).toEqual({ state: 'failed', problems: [{ title: 'Compile error', message: 'rib is not defined', line: 2 }] });
    expect(preview.same).toBe(false);
    expect(host.tools()[0].state).toBe('awaiting-approval');
    expect(gate.decide(id, 'allow')).toBe('ok');
    await call;

    // Features that fail: what did build is kept and drawn, the first few failures are listed and the rest counted.
    const failures = Array.from({ length: 7 }, (_, i) => ({
      index: i, id: `f${i}`, name: `Fillet ${i + 1}`, uniqueKind: 'fillet', message: `radius ${i} is too large\nBRep_API: command not done`,
      sourceLocation: { filePath: 'x', line: 10 + i, column: 3 },
    }));
    scratchBuild = (source) => (source === BEFORE ? BEFORE_BUILD : { ...AFTER_BUILD, state: 'build-error', geometry: 'digest-before', objectErrors: failures });
    fs.writeFileSync(file('bracket.fluid.js'), BEFORE);
    const second = client.callTool(edit());
    const secondId = await host.waiting(1);
    const failed = await previewIn(host, 'ready', 1);
    expect(failed.after).toMatchObject({
      state: 'failed',
      buildId: AFTER_BUILD.id,
      facts: { volume: 97500 },
      problems: [
        { title: 'Fillet 1 failed', message: 'radius 0 is too large', line: 10 },
        { title: 'Fillet 2 failed', message: 'radius 1 is too large', line: 11 },
        { title: 'Fillet 3 failed', message: 'radius 2 is too large', line: 12 },
        { title: 'Fillet 4 failed', message: 'radius 3 is too large', line: 13 },
        { title: 'Fillet 5 failed', message: 'radius 4 is too large', line: 14 },
      ],
      moreProblems: 2,
    });
    // The failed features were skipped: what builds is what was there.
    expect(failed.same).toBe(true);
    gate.decide(secondId, 'deny');
    await second;

    // A build the engine refuses is a reason too.
    scratchBuild = null;
    const third = client.callTool(edit());
    const thirdId = await host.waiting(2);
    const refused = await previewIn(host, 'ready', 2);
    expect(refused.after).toEqual({ state: 'failed', problems: [{ title: 'Not built', message: expect.stringContaining('no scratch builds') }] });
    gate.decide(thirdId, 'deny');
    await third;
  });

  it('says so when the change moves no geometry', async () => {
    const host = new FakeHost();
    const gate = new ToolGate(host);
    const client = await connect(gate);
    scratchBuild = (source) => (source === BEFORE ? BEFORE_BUILD : { ...AFTER_BUILD, bounds: BEFORE_BUILD.bounds, volume: 96000, geometry: 'digest-before' });
    const call = client.callTool(edit('bracket.fluid.js', '// a rib goes here\n'));
    const id = await host.waiting();
    expect(await previewIn(host, 'ready')).toMatchObject({ same: true, before: { state: 'built' }, after: { state: 'built' } });
    gate.decide(id, 'deny');
    await call;

    // An engine that does not digest its builds never says two are the same.
    const { geometry: _geometry, ...plain } = BEFORE_BUILD;
    scratchBuild = () => plain;
    const second = client.callTool(edit('bracket.fluid.js', '// a rib goes here\n'));
    const secondId = await host.waiting(1);
    expect((await previewIn(host, 'ready', 1)).same).toBe(false);
    gate.decide(secondId, 'deny');
    await second;

    // A change that leaves the text as it is: one build is both sides.
    scratchBuilds = [];
    scratchBuild = builds;
    const third = client.callTool({ name: 'write_file', arguments: { path: 'bracket.fluid.js', content: BEFORE } });
    const thirdId = await host.waiting(2);
    expect((await previewIn(host, 'ready', 2)).same).toBe(true);
    expect(scratchBuilds).toHaveLength(1);
    gate.decide(thirdId, 'deny');
    await third;
  });

  it('previews only a model file, and only a change that waits', async () => {
    const host = new FakeHost();
    const gate = new ToolGate(host);
    const client = await connect(gate);
    // A file that is no model: the approval as it always was.
    fs.writeFileSync(file('helper.js'), BEFORE);
    fs.writeFileSync(file('dims.params.js'), BEFORE);
    for (const [index, name] of ['helper.js', 'dims.params.js'].entries()) {
      const call = client.callTool(edit(name));
      const id = await host.waiting(index);
      await settled();
      expect(host.tools()[index].preview).toBeUndefined();
      gate.decide(id, 'deny');
      await call;
    }
    // Allowed for the session: the write no longer waits, and the viewport shows the result.
    const first = client.callTool(edit());
    const firstId = await host.waiting(2);
    await previewIn(host, 'ready', 2);
    gate.decide(firstId, 'allow-session');
    await first;
    scratchCosts = [];
    scratchBuilds = [];
    await client.callTool(edit());
    await settled();
    expect(host.tools()[3].preview).toBeUndefined();

    // Auto-apply edits: nothing waits, nothing is previewed.
    const auto = new FakeHost();
    auto.turn = { turnId: 't1', mode: 'auto-edits' };
    const autoClient = await connect(new ToolGate(auto));
    await autoClient.callTool(edit());
    await settled();
    expect(auto.tools()[0].preview).toBeUndefined();
    expect(scratchCosts).toEqual([]);
    expect(scratchBuilds).toEqual([]);
  });

  it('offers the preview instead of building it when the file is slow to build, and builds it when asked', async () => {
    const host = new FakeHost();
    const gate = new ToolGate(host);
    const client = await connect(gate);
    scratchCost = costs(6200);
    const call = client.callTool(edit());
    const id = await host.waiting();
    expect(await previewIn(host, 'offered')).toEqual({ state: 'offered', estimateMs: 6200 });
    await settled();
    expect(scratchBuilds).toEqual([]);
    expect(gate.requestPreview('nope')).toBe('not-found');

    expect(gate.requestPreview(id)).toBe('ok');
    // Asked once: a second click finds it building.
    expect(gate.requestPreview(id)).toBe('not-offered');
    expect(await previewIn(host, 'ready')).toMatchObject({ before: { state: 'built' }, after: { state: 'built' } });
    expect(scratchBuilds).toHaveLength(2);
    expect(gate.requestPreview(id)).toBe('not-offered');
    gate.decide(id, 'deny');
    await call;
    expect(gate.requestPreview(id)).toBe('not-found');

    // The threshold is the gate's: at it the preview is built, past it offered.
    scratchBuilds = [];
    const atLimit = new FakeHost();
    const atLimitGate = new ToolGate(atLimit, { autoPreviewMaxBuildMs: 6200 });
    const atLimitCall = (await connect(atLimitGate)).callTool(edit());
    const atLimitId = await atLimit.waiting();
    await previewIn(atLimit, 'ready');
    atLimitGate.decide(atLimitId, 'deny');
    await atLimitCall;
  });

  it('builds unasked however slow the file is when the engine already keeps both builds, or has never built the file', async () => {
    const host = new FakeHost();
    const gate = new ToolGate(host);
    const client = await connect(gate);
    // Both kept (the before from the last change, the after from a try_build): nothing to wait for.
    scratchCost = costs(9000, [BEFORE, AFTER]);
    const call = client.callTool(edit());
    const id = await host.waiting();
    await previewIn(host, 'ready');
    gate.decide(id, 'deny');
    await call;

    // Only the before is kept: the after is one slow build, so it is offered.
    scratchCost = costs(9000, [BEFORE]);
    const second = client.callTool(edit());
    const secondId = await host.waiting(1);
    expect(await previewIn(host, 'offered', 1)).toEqual({ state: 'offered', estimateMs: 9000 });
    gate.decide(secondId, 'deny');
    await second;
    // An offered preview nobody asked for ends with the approval, and the card shows none.
    expect(host.tools()[1].preview).toEqual({ state: 'cancelled', estimateMs: 9000 });

    // A file this engine has not built yet: nothing says it is slow.
    scratchCost = costs(null);
    const third = client.callTool(edit());
    const thirdId = await host.waiting(2);
    await previewIn(host, 'ready', 2);
    gate.decide(thirdId, 'deny');
    await third;
  });

  it('does not start a build once the approval is settled: a decision, a stop, the client giving up', async () => {
    for (const end of ['allow', 'deny', 'stop', 'abort'] as const) {
      fs.writeFileSync(file('bracket.fluid.js'), BEFORE);
      scratchBuilds = [];
      const host = new FakeHost();
      const gate = new ToolGate(host);
      const client = await connect(gate);
      let release: () => void = () => {};
      const held = new Promise<void>((resolve) => { release = resolve; });
      scratchBuild = async (source) => {
        await held;
        return builds(source);
      };
      const controller = new AbortController();
      const call = client.callTool(edit(), undefined, { signal: controller.signal }).catch(() => null);
      const id = await host.waiting();
      // The file as it is is building.
      await expect.poll(() => scratchBuilds.length).toBe(1);
      expect(host.tools()[0].preview).toEqual({ state: 'building' });
      if (end === 'stop') {
        host.turn = null;
        gate.settleAll('stopped');
      } else if (end === 'abort') {
        controller.abort();
        await expect.poll(() => host.tools()[0].state).toBe('error');
      } else {
        gate.decide(id, end);
      }
      // The card says so at once, in the same change as the approval's own outcome.
      expect(host.tools()[0].preview, end).toEqual({ state: 'cancelled' });
      release();
      await call;
      await settled();
      // The build in progress ran to its end and is dropped; the file with the change was never built.
      expect(scratchBuilds, end).toEqual([{ file: file('bracket.fluid.js'), source: BEFORE, reuse: true }]);
      expect(host.tools()[0].preview, end).toEqual({ state: 'cancelled' });
      expect(read('bracket.fluid.js'), end).toBe(end === 'allow' ? AFTER : BEFORE);
    }
  });

  it('shows no preview when the approval is settled before the engine said what one costs, or cannot say', async () => {
    const host = new FakeHost();
    const gate = new ToolGate(host);
    const client = await connect(gate);
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => { release = resolve; });
    scratchCost = async (source) => {
      await held;
      return costs(140)(source);
    };
    const call = client.callTool(edit());
    const id = await host.waiting();
    await expect.poll(() => scratchCosts.length).toBe(1);
    gate.decide(id, 'deny');
    release();
    await call;
    await settled();
    expect(host.tools()[0].preview).toBeUndefined();
    expect(scratchBuilds).toEqual([]);

    // An engine without scratch builds: the card is the approval card it always was.
    scratchCost = null;
    const second = client.callTool(edit());
    const secondId = await host.waiting(1);
    await settled();
    expect(host.tools()[1].preview).toBeUndefined();
    expect(scratchBuilds).toEqual([]);
    gate.decide(secondId, 'allow');
    await second;
    expect(read('bracket.fluid.js')).toBe(AFTER);
  });

  it('keeps a picture the page added to one side while the other built', async () => {
    const host = new FakeHost();
    const gate = new ToolGate(host);
    const client = await connect(gate);
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => { release = resolve; });
    scratchBuild = async (source) => {
      if (source === AFTER) {
        await held;
      }
      return builds(source);
    };
    const call = client.callTool(edit());
    const id = await host.waiting();
    await expect.poll(() => host.tools()[0].preview?.before?.state).toBe('built');
    // As the session's picture route does: the side gains its `image` in the transcript.
    const card = host.tools()[0];
    host.emit({ type: 'part-update', messageId: 'a1', partId: card.id, patch: { preview: { ...card.preview!, before: { ...card.preview!.before!, image: 'before.png' } } } });
    release();
    const preview = await previewIn(host, 'ready');
    expect([preview.before?.image, preview.after?.image]).toEqual(['before.png', undefined]);
    gate.decide(id, 'deny');
    await call;
  });
});
