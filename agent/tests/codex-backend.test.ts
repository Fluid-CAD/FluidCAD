import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CodexBackend, CODEX_MIN_VERSION, codexTargetTriples, resolveCodexProgram, type CodexRun } from '../src/codex/codex-backend.ts';
import type { AgentInstall, BackendEvent } from '../src/backend.ts';
import { trackedChildCount } from '../src/children.ts';

// Fake `codex` programs only (fixtures/fake-codex.mjs): no test starts the real CLI.
const FAKE_CODEX = path.join(import.meta.dirname, 'fixtures', 'fake-codex.mjs');
const posix = process.platform !== 'win32';

let tmp: string;

beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fluidcad-agent-codex-')));
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

/** A shell wrapper that runs the fake with fixed settings. */
function wrapper(file: string, envLines: string[] = []): string {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `#!/bin/sh\n${envLines.map((l) => `export ${l}\n`).join('')}exec "${process.execPath}" "${FAKE_CODEX}" "$@"\n`);
  fs.chmodSync(file, 0o755);
  return file;
}

/** A `codex` on a temporary PATH. */
function fakeOnPath(name: string, envLines: string[] = []): string {
  const dir = path.join(tmp, name);
  wrapper(path.join(dir, 'codex'), envLines);
  return dir;
}

function envWith(pathDirs: string[], extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return { ...process.env, PATH: pathDirs.join(path.delimiter), ...extra };
}

const backend = () => new CodexBackend({ homeDir: tmp, fixedPaths: [], clientVersion: '9.9.9', cwd: tmp, lingerMs: 50, interruptGraceMs: 300, mcpStartupTimeoutMs: 1500 });

describe.runIf(posix)('CodexBackend.detect with fake binaries on PATH', () => {
  it('finds Codex on PATH, checks the version and reads only the exit code of `login status`', async () => {
    const dir = fakeOnPath('ok');
    const install = await backend().detect({ env: envWith([dir]) });
    expect(install).toEqual({
      kind: 'codex',
      path: path.join(dir, 'codex'),
      version: '0.162.1',
      minVersion: CODEX_MIN_VERSION,
      supported: true,
      loggedIn: true,
    });
  });

  it('says how to sign in when it is not signed in', async () => {
    const dir = fakeOnPath('signed-out', ['FAKE_CODEX_LOGGED_IN=0']);
    const install = await backend().detect({ env: envWith([dir]) });
    expect(install).toMatchObject({ supported: true, loggedIn: false });
    expect(install.problem).toContain('codex login');
  });

  it('refuses a version older than the minimum', async () => {
    const dir = fakeOnPath('old', ['FAKE_CODEX_VERSION=0.150.0']);
    const install = await backend().detect({ env: envWith([dir]) });
    expect(install).toMatchObject({ version: '0.150.0', supported: false, loggedIn: null });
    expect(install.problem).toContain(CODEX_MIN_VERSION);
  });

  it('skips a `codex` that is some other program', async () => {
    const dir = path.join(tmp, 'impostor');
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, 'codex'), '#!/bin/sh\necho "1.2.3 something else"\n');
    fs.chmodSync(path.join(dir, 'codex'), 0o755);
    const install = await backend().detect({ env: envWith([dir]) });
    expect(install.supported).toBe(false);
    expect(install.problem).toContain('is not Codex');
  });

  it('reports nothing found, falls back to the fixed locations, and honours an absolute override only', async () => {
    expect((await backend().detect({ env: envWith([]) })).problem).toContain('not found');
    const dir = fakeOnPath('fixed');
    const fixed = new CodexBackend({ homeDir: tmp, fixedPaths: [path.join(dir, 'codex')] });
    expect((await fixed.detect({ env: envWith([]) })).path).toBe(path.join(dir, 'codex'));
    expect((await backend().detect({ pathOverride: 'codex', env: envWith([]) })).problem).toContain('not an executable file');
    expect((await backend().detect({ pathOverride: path.join(dir, 'codex'), env: envWith([]) })).supported).toBe(true);
  });

  it('runs the native program of an npm install, so Node need not be on PATH', async () => {
    const pkg = path.join(tmp, 'lib', 'node_modules', '@openai', 'codex');
    fs.mkdirSync(path.join(pkg, 'bin'), { recursive: true });
    fs.writeFileSync(path.join(pkg, 'package.json'), JSON.stringify({ name: '@openai/codex', bin: { codex: 'bin/codex.js' } }));
    fs.writeFileSync(path.join(pkg, 'bin', 'codex.js'), '#!/usr/bin/env node\nthrow new Error("the launcher must not run");\n');
    fs.chmodSync(path.join(pkg, 'bin', 'codex.js'), 0o755);
    const binDir = path.join(tmp, 'npm-bin');
    fs.mkdirSync(binDir);
    fs.symlinkSync(path.join(pkg, 'bin', 'codex.js'), path.join(binDir, 'codex'));

    // No native program next to it: the user is told to install the standalone Codex.
    const missing = await backend().detect({ env: envWith([binDir]) });
    expect(missing.supported).toBe(false);
    expect(missing.problem).toContain('npm launcher');
    expect(missing.problem).toContain('standalone');

    const [triple] = codexTargetTriples(process.platform, process.arch);
    const native = path.join(pkg, 'node_modules', '@openai', `codex-${process.platform}-${process.arch}`, 'vendor', triple, 'bin', 'codex');
    wrapper(native);
    const install = await backend().detect({ env: envWith([binDir]) });
    expect(install).toMatchObject({ path: native, version: '0.162.1', supported: true, loggedIn: true });
    // The other known layout, and a hoisted platform package.
    expect(resolveCodexProgram(path.join(binDir, 'codex'), process.platform, process.arch)).toEqual({ kind: 'npm-native', path: native });
    expect(resolveCodexProgram(native, process.platform, process.arch)).toEqual({ kind: 'native', path: native });
  });

  it('knows the target triples of the native builds', () => {
    expect(codexTargetTriples('linux', 'x64')).toEqual(['x86_64-unknown-linux-musl', 'x86_64-unknown-linux-gnu']);
    expect(codexTargetTriples('darwin', 'arm64')).toEqual(['aarch64-apple-darwin']);
    expect(codexTargetTriples('win32', 'x64')).toEqual(['x86_64-pc-windows-msvc']);
    expect(codexTargetTriples('linux', 'ia32')).toEqual([]);
  });
});

describe.runIf(posix)('CodexRun against a fake app server', () => {
  let log: string;
  let codexPath: string;
  let install: AgentInstall;
  let b: CodexBackend;
  const runs: CodexRun[] = [];

  beforeEach(() => {
    log = path.join(tmp, 'codex.log');
    codexPath = wrapper(path.join(tmp, 'bin', 'codex'));
    install = { kind: 'codex', path: codexPath, version: '0.162.1', minVersion: CODEX_MIN_VERSION, supported: true, loggedIn: true };
    b = backend();
  });

  afterEach(async () => {
    for (const run of runs.splice(0)) {
      await run.close();
    }
    await b.dispose();
  });

  const logged = (): { dir: string; pid: number; msg: any }[] =>
    fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
  const sent = (method: string) => logged().filter((l) => l.dir === 'in' && l.msg.method === method).map((l) => l.msg);

  async function open(extraEnv: NodeJS.ProcessEnv = {}, options: { resume?: string | null; model?: string; effort?: string } = {}) {
    const run = (await b.open({
      install,
      resume: options.resume ?? null,
      cwd: tmp,
      mcpUrl: 'http://127.0.0.1:1/api/agent/mcp/x',
      instructions: 'test instructions',
      ...(options.model ? { model: options.model } : {}),
      ...(options.effort ? { effort: options.effort } : {}),
      env: { ...process.env, FAKE_CODEX_LOG: log, ...extraEnv },
    })) as CodexRun;
    runs.push(run);
    const events: BackendEvent[] = [];
    const ended = (async () => {
      for await (const e of run.events) {
        events.push(e);
      }
    })();
    return { run, events, ended };
  }

  async function until(check: () => boolean, ms = 5000): Promise<void> {
    const start = Date.now();
    while (!check()) {
      if (Date.now() - start > ms) {
        throw new Error('timed out');
      }
      await new Promise((r) => setTimeout(r, 10));
    }
  }
  const turnEnds = (events: BackendEvent[]) => events.filter((e) => e.type === 'turn-end');

  it('shakes hands, starts a hardened thread, and runs turns with text elements and the image', async () => {
    const { run, events } = await open({}, { model: 'gpt-test-luna', effort: 'low' });
    expect(run.ref).toMatch(/^thread-/);
    const [initialize] = sent('initialize');
    expect(initialize.params).toEqual({ clientInfo: { name: 'fluidcad', title: 'FluidCAD', version: '9.9.9' }, capabilities: null });
    expect(sent('initialized')).toHaveLength(1);
    expect(sent('config/read')[0].params).toEqual({ includeLayers: false, cwd: tmp });
    const [start] = sent('thread/start');
    expect(start.params).toMatchObject({ cwd: tmp, sandbox: 'read-only', approvalPolicy: 'never', developerInstructions: 'test instructions', model: 'gpt-test-luna' });
    expect(start.params.config).toMatchObject({
      'mcp_servers.fluidcad_app.url': 'http://127.0.0.1:1/api/agent/mcp/x',
      'mcp_servers.FluidCAD.enabled': false,
      'mcp_servers.figma.enabled': false,
      'features.plugins': false,
      'features.apps': false,
    });
    expect(sent('mcpServerStatus/list')[0].params).toMatchObject({ threadId: run.ref });

    const image = path.join(tmp, 'capture.png');
    fs.writeFileSync(image, 'png');
    run.send({ text: 'image please', imagePath: image });
    await until(() => turnEnds(events).length === 1);
    run.send({ text: 'hello there' });
    await until(() => turnEnds(events).length === 2);

    const turnStarts = sent('turn/start');
    expect(turnStarts[0].params).toEqual({
      threadId: run.ref,
      input: [
        { type: 'localImage', path: image },
        { type: 'text', text: 'image please', text_elements: [] },
      ],
      model: 'gpt-test-luna',
      effort: 'low',
      summary: 'concise',
    });
    expect(turnStarts[1].params.input).toEqual([{ type: 'text', text: 'hello there', text_elements: [] }]);
    const text = events.filter((e) => e.type === 'text-delta').map((e: any) => e.delta).join('');
    expect(text).toBe(`image: ${image}echo: hello there`);
    expect(events.filter((e) => e.type === 'reasoning-delta')).toEqual([{ type: 'reasoning-delta', id: 'rs-turn-2', delta: '**Looking**' }]);
    // The image turn reported no usage; the second reports the thread's totals since none came before.
    expect(events.filter((e) => e.type === 'usage')).toEqual([{ type: 'usage', inputTokens: 3000, outputTokens: 10 }]);
    expect(turnEnds(events)).toEqual([
      { type: 'turn-end', reason: 'done' },
      { type: 'turn-end', reason: 'done' },
    ]);
  });

  it('serves every session from one app server, each as its own thread', async () => {
    const a = await open();
    const c = await open();
    expect(a.run.ref).not.toBe(c.run.ref);
    expect(b.serversStarted).toBe(1);
    expect(logged().filter((l) => l.dir === 'start')).toHaveLength(1);
    a.run.send({ text: 'from a' });
    c.run.send({ text: 'from c' });
    await until(() => turnEnds(a.events).length === 1 && turnEnds(c.events).length === 1);
    expect(a.events.filter((e) => e.type === 'text-delta').map((e: any) => e.delta).join('')).toBe('echo: from a');
    expect(c.events.filter((e) => e.type === 'text-delta').map((e: any) => e.delta).join('')).toBe('echo: from c');

    // Closing a run unloads its thread; the server goes once the last one is gone and it lingered.
    await a.run.close();
    expect(sent('thread/unsubscribe').map((m) => m.params.threadId)).toEqual([a.run.ref]);
    const children = trackedChildCount();
    await c.run.close();
    await until(() => trackedChildCount() === children - 1, 3000);
    await open();
    expect(b.serversStarted).toBe(2);
  });

  it('resumes a thread with the whole configuration and the model again', async () => {
    const first = await open();
    const ref = first.run.ref;
    await first.run.close();
    const { run } = await open({}, { resume: ref, model: 'gpt-test-astra' });
    expect(run.ref).toBe(ref);
    const [resume] = sent('thread/resume');
    expect(resume.params).toMatchObject({ threadId: ref, sandbox: 'read-only', approvalPolicy: 'never', model: 'gpt-test-astra' });
    expect(resume.params.config).toEqual(sent('thread/start')[0].params.config);
  });

  it('starts afresh, and says so, when the thread cannot be resumed', async () => {
    const { run, events } = await open({ FAKE_CODEX_RESUME_FAIL: '1' }, { resume: 'gone-thread' });
    expect(run.ref).not.toBe('gone-thread');
    run.send({ text: 'hi' });
    await until(() => turnEnds(events).length === 1);
    expect(events[0]).toMatchObject({ type: 'notice', level: 'info', text: expect.stringContaining('starts afresh') });
  });

  it('declines every request Codex sends, and tells the user', async () => {
    const { run, events } = await open();
    run.send({ text: 'ask' });
    await until(() => turnEnds(events).length === 1);
    const answers = logged().find((l) => l.dir === 'answers')!.msg;
    expect(answers).toEqual({
      command: { decision: 'decline' },
      fileChange: { decision: 'decline' },
      permissions: { permissions: {}, scope: 'turn' },
      elicitation: { action: 'cancel', content: null, _meta: null },
      refresh: { error: { code: -32601, message: 'FluidCAD does not support account/chatgptAuthTokens/refresh.' } },
    });
    const notices = events.filter((e) => e.type === 'notice').map((e: any) => e.text);
    expect(notices).toHaveLength(4);
    expect(notices[0]).toContain('rm -rf build');
    expect(events.filter((e) => e.type === 'tool').map((e: any) => e.state)).toEqual(['running', 'error']);
  });

  it('maps a missing login and a used-up plan to the session\'s error kinds', async () => {
    const { run, events } = await open();
    run.send({ text: 'fail-401' });
    await until(() => turnEnds(events).length === 1);
    expect(turnEnds(events)[0]).toMatchObject({ reason: 'error', error: { kind: 'auth', message: expect.stringContaining('codex login') } });
    expect(events.filter((e) => e.type === 'notice')).toHaveLength(1);
    run.send({ text: 'usage-limit' });
    await until(() => turnEnds(events).length === 2);
    expect(turnEnds(events)[1]).toMatchObject({
      reason: 'error',
      error: { kind: 'rate-limit', resetsAt: new Date(1795000000 * 1000).toISOString() },
    });
  });

  it('interrupts with turn/interrupt and closes the cards Codex left open', async () => {
    const { run, events } = await open();
    run.send({ text: 'slow' });
    await until(() => events.some((e) => e.type === 'tool'));
    await run.interrupt();
    expect(sent('turn/interrupt')[0].params).toEqual({ threadId: run.ref, turnId: 'turn-1' });
    expect(events.filter((e) => e.type === 'tool')).toEqual([
      { type: 'tool', id: 'cmd-turn-1', name: 'command', title: 'Run sleep 100', state: 'running', input: { command: 'sleep 100', cwd: '/' } },
      { type: 'tool', id: 'cmd-turn-1', name: 'command', title: 'Run sleep 100', state: 'error', error: 'Stopped.' },
    ]);
    expect(turnEnds(events)).toEqual([{ type: 'turn-end', reason: 'interrupted' }]);
    // The thread goes on.
    run.send({ text: 'after' });
    await until(() => turnEnds(events).length === 2);
    expect(turnEnds(events)[1]).toEqual({ type: 'turn-end', reason: 'done' });
  });

  it('ends the turn itself when Codex does not end it after an interrupt', async () => {
    const { run, events } = await open();
    run.send({ text: 'deaf' });
    await until(() => sent('turn/start').length === 1);
    await new Promise((r) => setTimeout(r, 50));
    await run.interrupt();
    expect(turnEnds(events)).toEqual([{ type: 'turn-end', reason: 'interrupted' }]);
    run.send({ text: 'after' });
    await until(() => turnEnds(events).length === 2);
  });

  it('fails the start when FluidCAD\'s MCP server does not connect', async () => {
    // The server keeps the environment it started with: a new one per case.
    await expect(open({ FAKE_CODEX_MCP: 'failed' })).rejects.toThrow("FluidCAD's MCP server did not connect to Codex (status: failed: connection refused).");
    await b.dispose();
    await expect(open({ FAKE_CODEX_MCP: 'silent' })).rejects.toThrow('did not connect');
    await b.dispose();
    // A thread that says nothing but is listed as connected is fine.
    await expect(open({ FAKE_CODEX_MCP: 'silent', FAKE_CODEX_LISTED: 'connected' })).resolves.toBeTruthy();
    // A failed start leaves no thread loaded.
    expect(sent('thread/unsubscribe')).toHaveLength(2);
  });

  it('warns when one of the user\'s servers runs anyway', async () => {
    const { run, events } = await open({ FAKE_CODEX_LEAK: 'figma' });
    run.send({ text: 'hi' });
    await until(() => turnEnds(events).length === 1);
    expect(events[0]).toEqual({ type: 'notice', level: 'warning', text: 'Codex also started MCP servers FluidCAD could not turn off: figma.' });
  });

  it('ends the turn with the tail of stderr when the app server dies', async () => {
    const { run, events, ended } = await open();
    run.send({ text: 'crash' });
    await ended;
    expect(turnEnds(events)).toEqual([
      { type: 'turn-end', reason: 'error', error: { kind: 'other', message: expect.stringContaining('exited with code 3') } },
    ]);
    expect((turnEnds(events)[0] as any).error.message).toContain('boom: the fake crashed');
    // The next run starts a new server.
    await open();
    expect(b.serversStarted).toBe(2);
  });

  it('lists the models of model/list, after a Default entry', async () => {
    const models = await b.models(install, { ...process.env, FAKE_CODEX_LOG: log });
    expect(models).toEqual([
      { id: 'default', label: 'Default' },
      {
        id: 'gpt-test-luna',
        label: 'GPT-Test-Luna',
        description: 'Fast and affordable.',
        efforts: ['low', 'medium'],
        defaultEffort: 'medium',
        acceptsImages: true,
      },
      { id: 'gpt-test-astra', label: 'GPT-Test-Astra', description: 'Deep.', isDefault: true, efforts: ['high'], defaultEffort: 'high', acceptsImages: false },
    ]);
    expect(sent('model/list')[0].params).toEqual({ includeHidden: false });
    expect(await b.models({ ...install, supported: false })).toEqual([]);
  });
});
