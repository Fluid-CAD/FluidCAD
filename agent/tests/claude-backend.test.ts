import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ClaudeBackend, claudeChildEnv, CLAUDE_MCP_TIMEOUT_MS, type ClaudeRun } from '../src/claude/claude-backend.ts';
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
  it('finds Claude Code on PATH, checks the version and reads the auth method and the account\'s email', async () => {
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
      account: 'someone@example.com',
    });
    // Only the email is kept of the account fields.
    expect(JSON.stringify(install)).not.toMatch(/org-1|orgName|"Org"/);
  });

  describe('subscription only', () => {
    /** The `auth status` lines the fake logged: whether each saw the key. */
    function statusLog(file: string): string[] {
      return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').filter((l) => l.startsWith('auth-status')) : [];
    }

    it('asks about the login without an inherited ANTHROPIC_API_KEY', async () => {
      const log = path.join(tmp, 'sub.log');
      const dir = fakeOnPath('sub', [`FAKE_CLAUDE_LOG=${log}`]);
      const install = await backend().detect({ env: envWith([dir], { ANTHROPIC_API_KEY: 'sk-test' }) });
      expect(install).toMatchObject({ loggedIn: true, authMethod: 'claude.ai', account: 'someone@example.com' });
      expect(statusLog(log)).toEqual(['auth-status key=no']);
    });

    it('is not signed in when no subscription is, even with a key in the environment', async () => {
      const dir = fakeOnPath('no-sub', ['FAKE_CLAUDE_SUBSCRIPTION=0']);
      const install = await backend().detect({ env: envWith([dir], { ANTHROPIC_API_KEY: 'sk-test' }) });
      expect(install).toMatchObject({ supported: true, loggedIn: false, authMethod: 'none' });
      expect(install.account).toBeUndefined();
      expect(install.problem).toContain('claude auth login');
    });

    it('is not signed in when Claude Code is signed in some other way than a subscription', async () => {
      const dir = fakeOnPath('other', ['FAKE_CLAUDE_AUTH_METHOD=api_key']);
      const install = await backend().detect({ env: envWith([dir]) });
      expect(install).toMatchObject({ supported: true, loggedIn: false, authMethod: 'api_key' });
      expect(install.account).toBeUndefined();
      expect(install.problem).toContain('subscription only');
      expect(install.problem).toContain('Anthropic API');
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

describe.runIf(posix)('AgentRuntime runs Claude Code without an inherited ANTHROPIC_API_KEY', () => {
  let runtime: AgentRuntime | null = null;
  afterEach(async () => {
    await runtime?.shutdown();
    runtime = null;
  });

  it('leaves the key out of the run', async () => {
    const log = path.join(tmp, 'runtime.log');
    const dir = fakeOnPath('rt', [`FAKE_CLAUDE_LOG=${log}`]);
    const workspace = path.join(tmp, 'ws');
    fs.mkdirSync(workspace, { recursive: true });
    const prefs = { agent: { defaultAgent: null, permissionMode: 'ask' } };
    runtime = new AgentRuntime(
      { workspacePath: workspace, port: 1, version: '0.0.0', startedAt: '', loadPreferences: async () => prefs } as any,
      { backends: { claude: backend() }, env: envWith([dir], { ANTHROPIC_API_KEY: 'sk-test' }) },
    );
    const install = (await runtime.agents(false)).find((i) => i.kind === 'claude')!;
    expect(install).toMatchObject({ loggedIn: true, authMethod: 'claude.ai' });
    const setup = await (runtime as any).prepareTurn('claude');
    const run = await backend().open({ install: setup.install, resume: null, cwd: tmp, mcpUrl: 'http://127.0.0.1:1/x', instructions: 't', env: setup.env });
    for (let i = 0; i < 200 && !fs.readFileSync(log, 'utf8').includes('run '); i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    await run.close();
    const line = fs.readFileSync(log, 'utf8').split('\n').find((l) => l.startsWith('run '))!;
    expect(line.endsWith('key=no')).toBe(true);
  });
});

describe('claudeChildEnv', () => {
  it('drops a parent Claude Code session\'s markers and ANTHROPIC_API_KEY, no other auth variable', () => {
    const env = claudeChildEnv({
      PATH: '/bin',
      CLAUDECODE: '1',
      CLAUDE_CODE_SESSION_ID: 'x',
      CLAUDE_CODE_ENTRYPOINT: 'cli',
      ANTHROPIC_API_KEY: 'sk',
      CLAUDE_CODE_OAUTH_TOKEN: 'tok',
      CLAUDE_CODE_USE_BEDROCK: '1',
    });
    expect(env).toEqual({ PATH: '/bin', CLAUDE_CODE_OAUTH_TOKEN: 'tok', CLAUDE_CODE_USE_BEDROCK: '1' });
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
    expect(after('--tools')).toBe('Read,Glob,Grep,WebSearch');
    expect(after('--permission-prompts')).toBe('none');
    expect(after('--thinking-display')).toBe('summarized');
    expect(after('--append-system-prompt')).toBe('be brief');
    expect(args.slice(args.indexOf('--allowedTools') + 1, args.indexOf('--allowedTools') + 6)).toEqual([
      'mcp__fluidcad_app__*',
      'Read',
      'Glob',
      'Grep',
      'WebSearch',
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
