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
  type GateTimers,
  type ToolGateHost,
} from '../src/tool-gate.ts';
import type { Checkpoint } from '../src/session-store.ts';
import { applyChatEvent } from '../src/transcript.ts';
import { QUESTION_SKIPPED_NOTE, QUESTION_STOPPED_MESSAGE, QUESTION_TIMED_OUT_MESSAGE, readQuestionReply } from '../src/questions.ts';
import type { ChatEvent, ChatMessage, PermissionMode, QuestionItem, QuestionPart, ToolPart } from '../src/types.ts';

// A stand-in for the engine the pinned server talks to: write_file and
// edit_range ask it for dirty buffers, a lint and a render. Only the dirty
// buffers matter here; every other route answers 404, which the tools treat
// as "older engine" and carry on.
let engine: http.Server;
let dirtyFiles: string[] = [];
/** What the engine's `POST /api/hub/install` does; null answers 404 like any other route. */
let hubInstall: ((body: any) => { status: number; json: unknown }) | null = null;
let hubInstalls: any[] = [];
let workspace: string;
let pinned: RegistryEntry;

beforeEach(async () => {
  workspace = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fluidcad-gate-')));
  dirtyFiles = [];
  hubInstall = null;
  hubInstalls = [];
  engine = http.createServer((req, res) => {
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
  tools(): ToolPart[] {
    return (this.messages[0]?.parts ?? []).filter((p): p is ToolPart => p.type === 'tool');
  }
  questions(): QuestionPart[] {
    return (this.messages[0]?.parts ?? []).filter((p): p is QuestionPart => p.type === 'question');
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

async function connect(gate: ToolGate, options: { ask?: boolean } = {}): Promise<Client> {
  const server = buildServer({
    pinnedWorkspace: pinned,
    toolGate: gate,
    // As a chat session's endpoint builds it (mcp-endpoint.ts).
    ...(options.ask ? { askUser: (input, signal) => gate.ask(input, signal) } : {}),
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
