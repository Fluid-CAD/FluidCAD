import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import express from 'express';
import type { AgentInstall } from '../src/backend.ts';
import { CodexBackend } from '../src/codex/codex-backend.ts';
import { AgentRuntime } from '../src/runtime.ts';
import { createRuntimeRouter } from '../src/router.ts';
import { NO_TURN_MESSAGE, STOPPED_MESSAGE } from '../src/tool-gate.ts';
import type { SessionSnapshot, ToolPart } from '../src/types.ts';

// The runtime with the real Codex driver and a fake `codex app-server`
// (fixtures/fake-codex.mjs) that connects to the session's MCP endpoint and
// calls FluidCAD's tools the way Codex 0.162.1 does, including what it does
// on an interrupt: the turn ends, the MCP call in flight is left pending, and
// a call can still arrive afterwards (§19).

const FAKE_CODEX = path.join(import.meta.dirname, 'fixtures', 'fake-codex.mjs');
const posix = process.platform !== 'win32';

let workspace: string;
let tmp: string;
let log: string;
let server: http.Server;
let base: string;
let runtime: AgentRuntime;

beforeEach(async () => {
  workspace = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fluidcad-agent-codex-rt-')));
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fluidcad-agent-codex-bin-')));
  log = path.join(tmp, 'codex.log');
  const bin = path.join(tmp, 'bin');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'codex'), `#!/bin/sh\nexec "${process.execPath}" "${FAKE_CODEX}" "$@"\n`);
  fs.chmodSync(path.join(bin, 'codex'), 0o755);

  const app = express();
  app.use(express.json({ limit: '50mb' }));
  app.get('/api/editor/dirty-files', (_req, res) => {
    res.json([]);
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
      loadPreferences: async () => ({ agent: { defaultAgent: 'codex', permissionMode: 'ask' } }) as any,
    },
    {
      backends: {
        codex: new CodexBackend({ clientVersion: '0.0.0', cwd: workspace, fixedPaths: [], lingerMs: 50, interruptGraceMs: 2000 }),
      },
      env: { ...process.env, PATH: bin, FAKE_CODEX_LOG: log, FAKE_CODEX_MCP: 'connect' },
    },
  );
  app.use('/api/agent', createRuntimeRouter(runtime, { heartbeatMs: 50 }));
});

afterEach(async () => {
  await runtime.shutdown();
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  fs.rmSync(workspace, { recursive: true, force: true });
  fs.rmSync(tmp, { recursive: true, force: true });
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
const idle = (id: string) => until(() => snapshot(id), (s) => s.status.state !== 'running' && s.status.state !== 'starting');
const toolParts = (snap: SessionSnapshot) => snap.messages.flatMap((m) => m.parts).filter((p): p is ToolPart => p.type === 'tool');
const logged = (): { dir: string; msg: any }[] =>
  fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
const toolResults = () => logged().filter((l) => l.dir === 'tool-result').map((l) => l.msg);
const textOf = (result: any) => (result.content as any[]).map((b) => b.text).join('');

describe.runIf(posix)('a Codex session', () => {
  it('is offered, runs a turn whose FluidCAD tool calls come from the gate only, and is bound to Codex', async () => {
    const agents = (await json('GET', `${base}/agents`)).body.agents as AgentInstall[];
    expect(agents.map((a) => [a.kind, a.supported])).toEqual([
      ['claude', false],
      ['codex', true],
    ]);
    const models = (await json('GET', `${base}/agents/codex/models`)).body.models;
    expect(models.map((m: any) => m.id)).toEqual(['default', 'gpt-test-luna', 'gpt-test-astra']);

    const id = (await json('POST', `${base}/sessions`, { agent: 'codex' })).body.id;
    await json('POST', `${base}/sessions/${id}/messages`, { text: 'tool read_skill {"name":"fluidcad"}', model: 'gpt-test-luna', effort: 'low' });
    const done = await idle(id);
    expect(done.agent).toBe('codex');
    expect(done.status).toEqual({ state: 'idle' });
    // One card for the call, from the gate; Codex's own mcpToolCall item for it is dropped.
    expect(toolParts(done)).toEqual([expect.objectContaining({ source: 'fluidcad', name: 'read_skill', state: 'done' })]);
    expect(done.messages[1].parts.find((p) => p.type === 'text')).toMatchObject({ text: 'Done.' });
    expect(done.model).toBe('gpt-test-luna');

    // The thread got Codex's instructions, and is resumed by the next run.
    const start = logged().find((l) => l.dir === 'in' && l.msg.method === 'thread/start')!.msg;
    expect(start.params.developerInstructions).toContain("read files with `fluidcad_app`'s");
    expect(start.params.developerInstructions).not.toContain('Read, Glob and Grep');
    expect(runtime.store.read(id)?.agent).toEqual({ kind: 'codex', ref: expect.stringMatching(/^thread-/), model: 'gpt-test-luna', effort: 'low' });
    await json('POST', `${base}/sessions/${id}/messages`, { text: 'hello again', model: 'gpt-test-astra' });
    await idle(id);
    const resume = logged().find((l) => l.dir === 'in' && l.msg.method === 'thread/resume')!.msg;
    expect(resume.params).toMatchObject({ threadId: runtime.store.read(id)?.agent.ref, model: 'gpt-test-astra' });
  });

  it('runs nothing that Codex sends after a cancel: the pending call is refused, and so is a late one', async () => {
    const id = (await json('POST', `${base}/sessions`, { agent: 'codex' })).body.id;
    await json('POST', `${base}/sessions/${id}/messages`, { text: 'hang-on write_file {"path":"a.fluid.js","content":"x"}' });
    const waiting = await until(() => snapshot(id), (s) => s.status.state === 'awaiting-approval');
    const approvalId = toolParts(waiting)[0].approval!.id;

    expect((await json('POST', `${base}/sessions/${id}/cancel`)).status).toBe(204);
    const after = await idle(id);
    expect(after.status).toEqual({ state: 'idle' });
    expect(after.turns[0].endReason).toBe('interrupted');
    // Codex was asked to stop the turn.
    expect(logged().some((l) => l.dir === 'in' && l.msg.method === 'turn/interrupt')).toBe(true);

    // The call Codex left pending got "stopped"; the one it sent after the interrupt got "no turn".
    const results = await until(toolResults, (r) => r.length === 2);
    expect(results.map((r) => [r.itemId.split('-')[0], textOf(r.result)])).toEqual([
      ['exec', STOPPED_MESSAGE],
      ['late', NO_TURN_MESSAGE],
    ]);
    expect(fs.existsSync(path.join(workspace, 'a.fluid.js'))).toBe(false);
    const final = await snapshot(id);
    expect(toolParts(final)).toEqual([expect.objectContaining({ name: 'write_file', state: 'denied', approval: expect.objectContaining({ id: approvalId, decision: 'deny' }) })]);
    expect(final.turns[0].revertible).toBe(false);
    expect((await json('POST', `${base}/sessions/${id}/approvals/${approvalId}`, { decision: 'allow' })).status).toBe(409);
  });

  it('refuses a late call in auto-edits too, where nothing waits for the user', async () => {
    const id = (await json('POST', `${base}/sessions`, { agent: 'codex' })).body.id;
    // In auto-edits the first write runs at once; the late one must not.
    fs.writeFileSync(path.join(workspace, 'a.fluid.js'), 'v1');
    await json('POST', `${base}/sessions/${id}/messages`, { text: 'hang-on write_file {"path":"a.fluid.js","content":"v2"}', mode: 'auto-edits' });
    await until(toolResults, (r) => r.length === 1);
    await json('POST', `${base}/sessions/${id}/cancel`);
    await idle(id);
    const results = await until(toolResults, (r) => r.length === 2);
    expect(textOf(results[1].result)).toBe(NO_TURN_MESSAGE);
    // The first write ran (it was allowed, in a running turn); the late one did not overwrite it.
    expect(fs.readFileSync(path.join(workspace, 'a.fluid.js'), 'utf8')).toBe('v2');
  });
});
