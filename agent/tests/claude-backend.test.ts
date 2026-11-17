import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ClaudeBackend, claudeChildEnv, CLAUDE_MCP_TIMEOUT_MS, type ClaudeRun } from '../src/claude/claude-backend.ts';
import type { AgentInstall, AgentRun, BackendEvent } from '../src/backend.ts';
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
    });
    // The status also carries account fields; none is kept.
    expect(JSON.stringify(install)).not.toMatch(/example\.com|org-1|email|orgName/);
  });

  it('reports the API key that an inherited ANTHROPIC_API_KEY makes it use, and the subscription without it', async () => {
    const dir = fakeOnPath('key');
    const inherited = envWith([dir], { ANTHROPIC_API_KEY: 'sk-test' });
    expect((await backend().detect({ env: inherited })).authMethod).toBe('api_key');
    const ignored = claudeChildEnv(inherited, { ignoreApiKey: true });
    expect(ignored.ANTHROPIC_API_KEY).toBeUndefined();
    expect((await backend().detect({ env: ignored })).authMethod).toBe('claude.ai');
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
