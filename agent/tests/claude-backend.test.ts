import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ClaudeBackend, claudeChildEnv, CLAUDE_MCP_TIMEOUT_MS, effectiveIgnoreApiKey, type ClaudeRun } from '../src/claude/claude-backend.ts';
import type { AgentInstall, AgentRun, BackendEvent } from '../src/backend.ts';
import { AgentRuntime } from '../src/runtime.ts';
import { trackedChildCount } from '../src/children.ts';

// Fake `claude` programs only: no test starts the real CLI.
const FAKE_CLAUDE = path.join(import.meta.dirname, 'fixtures', 'fake-claude.mjs');
const posix = process.platform !== 'win32';

let tmp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fluidcad-agent-claude-'));
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

/** A `claude` on a temporary PATH that runs the fake with fixed settings. */
function fakeOnPath(name: string, envLines: string[] = []): string {
  const dir = path.join(tmp, name);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'claude');
  fs.writeFileSync(file, `#!/bin/sh\n${envLines.map((l) => `export ${l}\n`).join('')}exec "${process.execPath}" "${FAKE_CLAUDE}" "$@"\n`);
  fs.chmodSync(file, 0o755);
  return dir;
}

/** The test's environment with PATH replaced; nothing of the real install is reachable. */
function envWith(pathDirs: string[], extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, PATH: pathDirs.join(path.delimiter), ...extra };
  delete env.ANTHROPIC_API_KEY;
  return { ...env, ...extra };
}

const backend = () => new ClaudeBackend({ homeDir: tmp, fixedPaths: [] });

describe.runIf(posix)('ClaudeBackend.detect with fake binaries on PATH', () => {
  it('finds Claude Code on PATH, checks the version and reads only the auth method', async () => {
    const dir = fakeOnPath('ok');
    const install = await backend().detect({ env: envWith([dir]) });
    expect(install).toEqual({
      kind: 'claude',
      path: path.join(dir, 'claude'),
      version: '2.1.326',
      minVersion: '2.1.259',
      supported: true,
      loggedIn: true,
      authMethod: 'claude.ai',
      apiKeyPresent: false,
      subscriptionAvailable: true,
      apiKeyIgnored: false,
    });
    // The status also carries account fields; none is kept.
    expect(JSON.stringify(install)).not.toMatch(/example\.com|org-1|email|orgName/);
  });

  describe('an inherited ANTHROPIC_API_KEY', () => {
    /** The `auth status` lines the fake logged: whether each saw the key. */
    function statusLog(file: string): string[] {
      return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').filter((l) => l.startsWith('auth-status')) : [];
    }

    it('changes nothing without a key: one status, the environment as it is', async () => {
      const log = path.join(tmp, 'no-key.log');
      const dir = fakeOnPath('no-key', [`FAKE_CLAUDE_LOG=${log}`]);
      const install = await backend().detect({ env: envWith([dir]) });
      expect(install).toMatchObject({ apiKeyPresent: false, apiKeyIgnored: false, authMethod: 'claude.ai', loggedIn: true });
      expect(statusLog(log)).toEqual(['auth-status key=no']);
      // An explicit choice does nothing either: there is no key to leave out.
      expect(await backend().detect({ env: envWith([dir]), ignoreApiKey: false })).toMatchObject({ apiKeyIgnored: false, authMethod: 'claude.ai' });
    });

    it('is left out by default when a Claude subscription is signed in', async () => {
      const log = path.join(tmp, 'sub.log');
      const dir = fakeOnPath('sub', [`FAKE_CLAUDE_LOG=${log}`]);
      const install = await backend().detect({ env: envWith([dir], { ANTHROPIC_API_KEY: 'sk-test' }) });
      expect(install).toMatchObject({
        apiKeyPresent: true,
        subscriptionAvailable: true,
        apiKeyIgnored: true,
        loggedIn: true,
        authMethod: 'claude.ai',
      });
      // The login was asked about without the key, and that answer stands.
      expect(statusLog(log)).toEqual(['auth-status key=no']);
      expect(JSON.stringify(install)).not.toMatch(/example\.com|org-1|email|orgName/);
    });

    it('is kept by default when no subscription is signed in (it is the only way in)', async () => {
      const log = path.join(tmp, 'no-sub.log');
      const dir = fakeOnPath('no-sub', [`FAKE_CLAUDE_LOG=${log}`, 'FAKE_CLAUDE_SUBSCRIPTION=0']);
      const install = await backend().detect({ env: envWith([dir], { ANTHROPIC_API_KEY: 'sk-test' }) });
      expect(install).toMatchObject({
        apiKeyPresent: true,
        subscriptionAvailable: false,
        apiKeyIgnored: false,
        loggedIn: true,
        authMethod: 'api_key',
      });
      expect(statusLog(log)).toEqual(['auth-status key=no', 'auth-status key=yes']);
      expect(install.problem).toBeUndefined();
    });

    it('is kept when the user turned the setting off, subscription or not', async () => {
      const dir = fakeOnPath('off');
      const install = await backend().detect({ env: envWith([dir], { ANTHROPIC_API_KEY: 'sk-test' }), ignoreApiKey: false });
      expect(install).toMatchObject({ apiKeyPresent: true, subscriptionAvailable: true, apiKeyIgnored: false, authMethod: 'api_key' });
    });

    it('is left out when the user turned the setting on, even with no subscription', async () => {
      const dir = fakeOnPath('on', ['FAKE_CLAUDE_SUBSCRIPTION=0']);
      const install = await backend().detect({ env: envWith([dir], { ANTHROPIC_API_KEY: 'sk-test' }), ignoreApiKey: true });
      expect(install).toMatchObject({ apiKeyPresent: true, subscriptionAvailable: false, apiKeyIgnored: true, loggedIn: false, authMethod: 'none' });
      expect(install.problem).toContain('claude auth login');
    });
  });

  it('says how to sign in when it is not signed in', async () => {
    const dir = fakeOnPath('signed-out', ['FAKE_CLAUDE_LOGGED_IN=0']);
    const install = await backend().detect({ env: envWith([dir]) });
    expect(install).toMatchObject({ supported: true, loggedIn: false, authMethod: 'none' });
    expect(install.problem).toContain('claude auth login');
  });

  it('refuses a version older than the minimum', async () => {
    const dir = fakeOnPath('old', ['FAKE_CLAUDE_VERSION=2.1.100']);
    const install = await backend().detect({ env: envWith([dir]) });
    expect(install).toMatchObject({ version: '2.1.100', supported: false, loggedIn: null });
    expect(install.problem).toContain('2.1.259');
  });

  it('skips a `claude` that is some other program', async () => {
    const dir = path.join(tmp, 'impostor');
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, 'claude'), '#!/bin/sh\necho "claude 9.9.9 (not that one)"\n');
    fs.chmodSync(path.join(dir, 'claude'), 0o755);
    const install = await backend().detect({ env: envWith([dir]) });
    expect(install.supported).toBe(false);
    expect(install.problem).toContain('is not Claude Code');
  });

  it('reports nothing found, and falls back to the fixed install locations', async () => {
    expect((await backend().detect({ env: envWith([]) })).problem).toContain('not found');
    const dir = fakeOnPath('fixed');
    const fixed = new ClaudeBackend({ homeDir: tmp, fixedPaths: [path.join(dir, 'claude')] });
    expect((await fixed.detect({ env: envWith([]) })).path).toBe(path.join(dir, 'claude'));
  });

  it('uses an override path only when it is an absolute path to a program', async () => {
    const dir = fakeOnPath('override');
    expect((await backend().detect({ pathOverride: 'claude', env: envWith([]) })).problem).toContain('not an executable file');
    expect((await backend().detect({ pathOverride: path.join(tmp, 'missing'), env: envWith([]) })).problem).toContain('not an executable file');
    const install = await backend().detect({ pathOverride: path.join(dir, 'claude'), env: envWith([]) });
    expect(install).toMatchObject({ supported: true, loggedIn: true });
  });
});

describe('effectiveIgnoreApiKey', () => {
  it('honours an explicit choice and otherwise follows the subscription', () => {
    expect(effectiveIgnoreApiKey(undefined, true)).toBe(true);
    expect(effectiveIgnoreApiKey(undefined, false)).toBe(false);
    expect(effectiveIgnoreApiKey(undefined, null)).toBe(false);
    expect(effectiveIgnoreApiKey(false, true)).toBe(false);
    expect(effectiveIgnoreApiKey(true, false)).toBe(true);
  });
});

describe.runIf(posix)('AgentRuntime with Claude Code and an inherited ANTHROPIC_API_KEY', () => {
  let runtime: AgentRuntime | null = null;
  afterEach(async () => {
    await runtime?.shutdown();
    runtime = null;
  });

  /** A runtime on the real Claude Code driver, with a fake `claude` and the key in its environment. */
  function start(fakeEnv: string[], prefs: { agent: Record<string, unknown> }): { log: string; prefs: typeof prefs } {
    const log = path.join(tmp, 'runtime.log');
    const dir = fakeOnPath('rt', [`FAKE_CLAUDE_LOG=${log}`, ...fakeEnv]);
    const workspace = path.join(tmp, 'ws');
    fs.mkdirSync(workspace, { recursive: true });
    runtime = new AgentRuntime(
      { workspacePath: workspace, port: 1, version: '0.0.0', startedAt: '', loadPreferences: async () => prefs } as any,
      { backends: { claude: backend() }, env: envWith([dir], { ANTHROPIC_API_KEY: 'sk-test' }) },
    );
    return { log, prefs };
  }

  async function claudeInstall(fresh = false): Promise<AgentInstall> {
    return (await runtime!.agents(fresh)).find((i) => i.kind === 'claude')!;
  }

  /** Starts the CLI as a turn would (the env the runtime prepares), and reads back whether it saw the key. */
  async function spawnSawKey(log: string): Promise<boolean> {
    const setup = await (runtime as any).prepareTurn('claude');
    const run = await backend().open({ install: setup.install, resume: null, cwd: tmp, mcpUrl: 'http://127.0.0.1:1/x', instructions: 't', env: setup.env });
    for (let i = 0; i < 200 && !fs.readFileSync(log, 'utf8').includes('run '); i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    await run.close();
    const line = fs.readFileSync(log, 'utf8').split('\n').find((l) => l.startsWith('run '))!;
    fs.writeFileSync(log, '');
    return line.endsWith('key=yes');
  }

  it('leaves the key out of the run by default when a subscription is signed in', async () => {
    const { log } = start([], { agent: { defaultAgent: null, permissionMode: 'ask' } });
    expect(await claudeInstall()).toMatchObject({ apiKeyIgnored: true, authMethod: 'claude.ai' });
    expect(await spawnSawKey(log)).toBe(false);
  });

  it('keeps the key for the run by default when no subscription is signed in', async () => {
    const { log } = start(['FAKE_CLAUDE_SUBSCRIPTION=0'], { agent: { defaultAgent: null, permissionMode: 'ask' } });
    expect(await claudeInstall()).toMatchObject({ apiKeyIgnored: false, authMethod: 'api_key' });
    expect(await spawnSawKey(log)).toBe(true);
  });

  it('detects again when the choice changes, and honours an explicit one', async () => {
    const { log, prefs } = start([], { agent: { defaultAgent: null, permissionMode: 'ask' } });
    expect(await claudeInstall()).toMatchObject({ apiKeyIgnored: true });
    const statuses = () => fs.readFileSync(log, 'utf8').split('\n').filter((l) => l.startsWith('auth-status')).length;
    const before = statuses();
    // Cached while nothing changes.
    await claudeInstall();
    expect(statuses()).toBe(before);

    prefs.agent.claudeIgnoreApiKey = false;
    expect(await claudeInstall()).toMatchObject({ apiKeyIgnored: false, authMethod: 'api_key' });
    expect(statuses()).toBeGreaterThan(before);
    expect(await spawnSawKey(log)).toBe(true);

    prefs.agent.claudeIgnoreApiKey = true;
    expect(await claudeInstall()).toMatchObject({ apiKeyIgnored: true, authMethod: 'claude.ai' });
    expect(await spawnSawKey(log)).toBe(false);

    // Back to automatic: detected again, the subscription decides.
    delete prefs.agent.claudeIgnoreApiKey;
    const atAuto = statuses();
    expect(await claudeInstall()).toMatchObject({ apiKeyIgnored: true });
    expect(statuses()).toBeGreaterThan(atAuto);
  });

  it('looks at the subscription login again on "Check again"', async () => {
    start([], { agent: { defaultAgent: null, permissionMode: 'ask' } });
    expect(await claudeInstall()).toMatchObject({ subscriptionAvailable: true, apiKeyIgnored: true });
    // The user signs out of the subscription: the cache still says signed in, a fresh check does not.
    const fake = path.join(tmp, 'rt', 'claude');
    fs.writeFileSync(fake, fs.readFileSync(fake, 'utf8').replace('exec ', 'export FAKE_CLAUDE_SUBSCRIPTION=0\nexec '));
    expect(await claudeInstall()).toMatchObject({ apiKeyIgnored: true });
    expect(await claudeInstall(true)).toMatchObject({ subscriptionAvailable: false, apiKeyIgnored: false, authMethod: 'api_key' });
  });
});

describe('claudeChildEnv', () => {
  it('drops a parent Claude Code session\'s markers but no auth variable unless asked', () => {
    const env = claudeChildEnv({
      PATH: '/bin',
      CLAUDECODE: '1',
      CLAUDE_CODE_SESSION_ID: 'x',
      CLAUDE_CODE_ENTRYPOINT: 'cli',
      ANTHROPIC_API_KEY: 'sk',
      CLAUDE_CODE_OAUTH_TOKEN: 'tok',
      CLAUDE_CODE_USE_BEDROCK: '1',
    });
    expect(env).toEqual({ PATH: '/bin', ANTHROPIC_API_KEY: 'sk', CLAUDE_CODE_OAUTH_TOKEN: 'tok', CLAUDE_CODE_USE_BEDROCK: '1' });
    expect(claudeChildEnv({ ANTHROPIC_API_KEY: 'sk' }, { ignoreApiKey: true })).toEqual({});
  });
});

describe('ClaudeBackend.args', () => {
  it('builds the command line of §5.1 / §19', () => {
    const args = ClaudeBackend.args({
      resume: null,
      sessionId: 'sid',
      mcpUrl: 'http://127.0.0.1:3100/api/agent/mcp/secret',
      instructions: 'be brief',
      model: 'haiku',
      effort: 'low',
    });
    const after = (flag: string) => args[args.indexOf(flag) + 1];
    expect(args[0]).toBe('-p');
    for (const flag of ['--verbose', '--include-partial-messages', '--restricted', '--strict-mcp-config']) {
      expect(args).toContain(flag);
    }
    expect(after('--input-format')).toBe('stream-json');
    expect(after('--output-format')).toBe('stream-json');
    expect(after('--tools')).toBe('Read,Glob,Grep');
    expect(after('--permission-prompts')).toBe('none');
    expect(after('--thinking-display')).toBe('summarized');
    expect(after('--append-system-prompt')).toBe('be brief');
    expect(args.slice(args.indexOf('--allowedTools') + 1, args.indexOf('--allowedTools') + 5)).toEqual([
      'mcp__fluidcad_app__*',
      'Read',
      'Glob',
      'Grep',
    ]);
    expect(JSON.parse(after('--mcp-config'))).toEqual({
      mcpServers: { fluidcad_app: { type: 'http', url: 'http://127.0.0.1:3100/api/agent/mcp/secret', timeout: CLAUDE_MCP_TIMEOUT_MS } },
    });
    expect(CLAUDE_MCP_TIMEOUT_MS).toBe(3_600_000);
    expect(after('--session-id')).toBe('sid');
    expect(args).not.toContain('--resume');
    expect(after('--model')).toBe('haiku');
    expect(after('--effort')).toBe('low');
    expect(args).not.toContain('--bare');
  });

  it('resumes after the first run and leaves the model to the CLI by default', () => {
    const args = ClaudeBackend.args({ resume: 'old', sessionId: 'old', mcpUrl: 'u', instructions: 'i', model: 'default' });
    expect(args[args.indexOf('--resume') + 1]).toBe('old');
    expect(args).not.toContain('--session-id');
    expect(args).not.toContain('--model');
    expect(args).not.toContain('--effort');
  });
});

describe.runIf(posix)('ClaudeRun against a fake CLI', () => {
  const install: AgentInstall = {
    kind: 'claude',
    path: FAKE_CLAUDE,
    version: '2.1.326',
    minVersion: '2.1.259',
    supported: true,
    loggedIn: true,
  };
  const runs: AgentRun[] = [];
  afterEach(async () => {
    for (const run of runs.splice(0)) {
      await run.close();
    }
  });

  async function open(mode = 'ok', resume: string | null = null): Promise<{ run: ClaudeRun; events: BackendEvent[]; ended: Promise<void> }> {
    const run = (await new ClaudeBackend().open({
      install,
      resume,
      cwd: tmp,
      mcpUrl: 'http://127.0.0.1:1/api/agent/mcp/x',
      instructions: 'test',
      env: { ...process.env, FAKE_CLAUDE_MODE: mode },
    })) as ClaudeRun;
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

  it('runs turns on one process and closes cleanly', async () => {
    const { run, events, ended } = await open();
    expect(run.ref).toMatch(/^[0-9a-f-]{36}$/);
    run.send({ text: 'hello\n\n<workspace_state render="none" unit="mm"/>' });
    await until(() => events.some((e) => e.type === 'turn-end'));
    run.send({ text: 'again' });
    await until(() => events.filter((e) => e.type === 'turn-end').length === 2);
    expect(events.filter((e) => e.type === 'text-delta').map((e: any) => e.delta)).toEqual(['echo: hello', 'echo: again']);
    expect(events.filter((e) => e.type === 'turn-end')).toEqual([
      { type: 'turn-end', reason: 'done' },
      { type: 'turn-end', reason: 'done' },
    ]);
    const children = trackedChildCount();
    await run.close();
    await ended;
    expect(trackedChildCount()).toBe(children - 1);
  });

  it('sends a message\'s images before its text, each under its own type', async () => {
    const { run, events, ended } = await open();
    const drawing = path.join(tmp, 'drawing.jpg');
    const capture = path.join(tmp, 'capture.png');
    fs.writeFileSync(drawing, 'a drawing');
    fs.writeFileSync(capture, 'the capture');
    run.send({ text: 'images?', images: [{ path: drawing, mediaType: 'image/jpeg' }, { path: capture, mediaType: 'image/png' }] });
    await until(() => events.some((e) => e.type === 'turn-end'));
    expect(events.filter((e) => e.type === 'text-delta').map((e: any) => e.delta)).toEqual(['images: image/jpeg=a drawing, image/png=the capture']);
    await run.close();
    await ended;
  });

  it('interrupts a turn with a control request and stays usable', async () => {
    const { run, events } = await open();
    run.send({ text: 'something slow' });
    await until(() => events.some((e) => e.type === 'tool'));
    await run.interrupt();
    expect(events.filter((e) => e.type === 'turn-end')).toEqual([{ type: 'turn-end', reason: 'interrupted' }]);
    expect(events.filter((e) => e.type === 'tool')[1]).toMatchObject({ name: 'Read', input: { file_path: '/p/a.js' } });
    run.send({ text: 'after' });
    await until(() => events.filter((e) => e.type === 'turn-end').length === 2);
    expect(events[events.length - 1]).toEqual({ type: 'turn-end', reason: 'done' });
  });

  it('treats a silent exit with code 1 as not signed in', async () => {
    const { run, events, ended } = await open('exit1');
    run.send({ text: 'hi' });
    await ended;
    expect(events).toEqual([{ type: 'turn-end', reason: 'error', error: { kind: 'auth', message: expect.stringContaining('claude auth login') } }]);
  });

  it('ends the turn with the tail of stderr when the CLI dies', async () => {
    const { run, events, ended } = await open('stderr-crash');
    run.send({ text: 'hi' });
    await ended;
    expect(events).toEqual([
      { type: 'turn-end', reason: 'error', error: { kind: 'other', message: expect.stringContaining('something broke') } },
    ]);
    expect((events[0] as any).error.message).toContain('exited with code 3');
  });

  it('fails the start when FluidCAD\'s MCP server did not connect', async () => {
    const { run, events, ended } = await open('mcp-failed');
    run.send({ text: 'hi' });
    await ended;
    expect(events[0]).toMatchObject({ type: 'notice', level: 'error' });
    expect(events[1]).toMatchObject({ type: 'turn-end', reason: 'error', error: { message: expect.stringContaining('did not connect') } });
    expect(events.filter((e) => e.type === 'text-delta')).toEqual([]);
  });

  it('passes --resume to a respawned run', async () => {
    const { run, events } = await open('ok', 'b9b2a1f0-0000-4000-8000-000000000001');
    expect(run.ref).toBe('b9b2a1f0-0000-4000-8000-000000000001');
    run.send({ text: 'hi' });
    await until(() => events.some((e) => e.type === 'turn-end'));
  });
});
