// Drives the user's own Claude Code (docs/agent-chat-plan.md §5.1, §19).
//
// One `claude -p` child per chat session, stream-json both ways, kept open
// between turns. FluidCAD's MCP endpoint is the only MCP server it gets; its
// own tools are cut down to read-only file access inside the project.

import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AgentBackend, AgentInstall, AgentModel, AgentRun, BackendEvent, DetectOptions, OpenOptions } from '../backend.ts';
import { AsyncQueue } from '../async-queue.ts';
import { trackChild } from '../children.ts';
import { compareVersions, findOnPath, isExecutableFile, parseVersion, runBriefly } from '../locate.ts';
import { ClaudeStreamMapper, FLUIDCAD_MCP_SERVER } from './stream-json.ts';

export const CLAUDE_MIN_VERSION = '2.1.259';
/** Per-request and idle timeout Claude Code applies to our MCP server: an approval may take this long. */
export const CLAUDE_MCP_TIMEOUT_MS = 3_600_000;
const INTERRUPT_GRACE_MS = 5_000;
const CLOSE_GRACE_MS = 3_000;
const KILL_GRACE_MS = 2_000;
const STDERR_TAIL_CHARS = 4_000;

export const CLAUDE_MODELS: AgentModel[] = [
  { id: 'default', label: 'Default' },
  { id: 'opus', label: 'Opus' },
  { id: 'sonnet', label: 'Sonnet' },
  { id: 'haiku', label: 'Haiku' },
  { id: 'fable', label: 'Fable' },
];

/**
 * Variables a parent Claude Code session sets for the processes it starts.
 * An engine launched from a Claude Code terminal inherits them; passed on,
 * they would make our child think it is nested in that session. None of
 * them is an authentication method.
 */
const NESTED_SESSION_VARIABLES = [
  'CLAUDECODE',
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_CODE_SESSION_ID',
  'CLAUDE_CODE_CHILD_SESSION',
  'CLAUDE_CODE_SESSION_ATTENDED',
  'CLAUDE_CODE_EXECPATH',
  'CLAUDE_CODE_MESSAGING_SOCKET',
  'CLAUDE_CODE_MESSAGING_TOKEN',
  'CLAUDE_CODE_BRIDGE_SESSION_ID',
  'CLAUDE_PID',
];

/**
 * The environment Claude Code runs with: the engine's own, minus a parent
 * session's markers, and minus ANTHROPIC_API_KEY when the user chose their
 * subscription over an inherited key (`agent.claudeIgnoreApiKey`).
 */
export function claudeChildEnv(base: NodeJS.ProcessEnv, options: { ignoreApiKey?: boolean } = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base };
  for (const name of NESTED_SESSION_VARIABLES) {
    delete env[name];
  }
  if (options.ignoreApiKey) {
    delete env.ANTHROPIC_API_KEY;
  }
  return env;
}

export type ClaudeBackendOptions = {
  /** Home directory for the fixed install locations (tests point it at a temp dir). */
  homeDir?: string;
  platform?: NodeJS.Platform;
  /** Overrides the fixed install locations searched after PATH. */
  fixedPaths?: string[];
};

export class ClaudeBackend implements AgentBackend {
  readonly kind = 'claude' as const;
  private readonly homeDir: string;
  private readonly platform: NodeJS.Platform;
  private readonly fixedPathsOverride: string[] | undefined;

  constructor(options: ClaudeBackendOptions = {}) {
    this.homeDir = options.homeDir ?? os.homedir();
    this.platform = options.platform ?? process.platform;
    this.fixedPathsOverride = options.fixedPaths;
  }

  /** Where an install is looked for after PATH (§5.1): a Dock-launched app has no shell PATH. */
  fixedPaths(env: NodeJS.ProcessEnv): string[] {
    if (this.fixedPathsOverride) {
      return this.fixedPathsOverride;
    }
    if (this.platform === 'win32') {
      const profile = env.USERPROFILE ?? this.homeDir;
      const appData = env.APPDATA ?? path.join(profile, 'AppData', 'Roaming');
      return [path.join(profile, '.local', 'bin', 'claude.exe'), path.join(appData, 'npm', 'claude.cmd')];
    }
    return [
      path.join(this.homeDir, '.local', 'bin', 'claude'),
      '/opt/homebrew/bin/claude',
      '/usr/local/bin/claude',
      path.join(this.homeDir, '.npm-global', 'bin', 'claude'),
    ];
  }

  async detect(options: DetectOptions): Promise<AgentInstall> {
    const base: AgentInstall = {
      kind: 'claude',
      path: null,
      version: null,
      minVersion: CLAUDE_MIN_VERSION,
      supported: false,
      loggedIn: null,
      authMethod: null,
    };
    const override = options.pathOverride?.trim();
    let candidates: string[];
    if (override) {
      if (!path.isAbsolute(override) || !isExecutableFile(override, this.platform)) {
        return { ...base, path: override, problem: `The Claude Code path set in Settings is not an executable file: ${override}` };
      }
      candidates = [override];
    } else {
      const onPath = findOnPath('claude', options.env, this.platform);
      candidates = [
        ...(onPath ? [onPath] : []),
        ...this.fixedPaths(options.env).filter((p) => isExecutableFile(p, this.platform)),
      ];
    }
    if (candidates.length === 0) {
      return { ...base, problem: 'Claude Code was not found. Install it, or set its path in Settings.' };
    }

    let lastProblem = '';
    for (const candidate of candidates) {
      const result = await runBriefly(candidate, ['--version'], { env: options.env, timeoutMs: 15_000 });
      const output = `${result.stdout}\n${result.stderr}`;
      const version = parseVersion(result.stdout) ?? parseVersion(output);
      if (result.code !== 0 || !version || !/claude code/i.test(output)) {
        lastProblem = `${candidate} is not Claude Code (its --version said: ${firstLine(output) || result.error || 'nothing'}).`;
        continue;
      }
      const install: AgentInstall = { ...base, path: candidate, version };
      if (compareVersions(version, CLAUDE_MIN_VERSION) < 0) {
        return {
          ...install,
          problem: `Claude Code ${version} is too old: FluidCAD needs ${CLAUDE_MIN_VERSION} or later. Run \`claude update\`.`,
        };
      }
      install.supported = true;
      const auth = await runBriefly(candidate, ['auth', 'status'], { env: options.env, timeoutMs: 15_000 });
      // Only these two facts are kept; the status also carries account
      // fields (email, organization), which are never read.
      install.authMethod = readAuthMethod(auth.stdout);
      if (auth.code === 0) {
        install.loggedIn = true;
      } else if (auth.code === 1) {
        install.loggedIn = false;
        install.problem = 'Claude Code is not signed in. Run `claude auth login` in a terminal, then check again.';
      } else {
        install.loggedIn = null;
      }
      return install;
    }
    return { ...base, problem: lastProblem || 'Claude Code was not found.' };
  }

  async models(_install: AgentInstall): Promise<AgentModel[]> {
    return CLAUDE_MODELS.map((m) => ({ ...m }));
  }

  /** The command line for one run (§5.1 as corrected in §19). */
  static args(options: { resume: string | null; sessionId: string; mcpUrl: string; instructions: string; model?: string; effort?: string }): string[] {
    const mcpConfig = JSON.stringify({
      mcpServers: { [FLUIDCAD_MCP_SERVER]: { type: 'http', url: options.mcpUrl, timeout: CLAUDE_MCP_TIMEOUT_MS } },
    });
    const args = [
      '-p',
      '--input-format', 'stream-json',
      '--output-format', 'stream-json',
      '--verbose',
      '--include-partial-messages',
      '--restricted',
      '--tools', 'Read,Glob,Grep',
      '--permission-prompts', 'none',
      '--strict-mcp-config',
      '--mcp-config', mcpConfig,
      '--allowedTools', `mcp__${FLUIDCAD_MCP_SERVER}__*`, 'Read', 'Glob', 'Grep',
      '--append-system-prompt', options.instructions,
      '--thinking-display', 'summarized',
    ];
    if (options.resume) {
      args.push('--resume', options.resume);
    } else {
      args.push('--session-id', options.sessionId);
    }
    if (options.model && options.model !== 'default') {
      args.push('--model', options.model);
    }
    if (options.effort) {
      args.push('--effort', options.effort);
    }
    return args;
  }

  async open(options: OpenOptions): Promise<AgentRun> {
    if (!options.install.path) {
      throw new Error('Claude Code was not found.');
    }
    const sessionId = options.resume ?? randomUUID();
    const args = ClaudeBackend.args({ ...options, sessionId });
    const child = spawn(options.install.path, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: false,
      windowsHide: true,
    });
    await new Promise<void>((resolve, reject) => {
      child.once('spawn', () => resolve());
      child.once('error', (e) => reject(new Error(`Claude Code could not be started: ${e.message}`)));
    });
    trackChild(child);
    return new ClaudeRun(child, sessionId);
  }
}

/** One live `claude -p` process. */
export class ClaudeRun implements AgentRun {
  readonly ref: string;
  private readonly child: ChildProcess;
  private readonly mapper = new ClaudeStreamMapper();
  private readonly queue = new AsyncQueue<BackendEvent>();
  private turnActive = false;
  private turnWaiters: (() => void)[] = [];
  private stderrTail = '';
  private stdoutRest = '';
  private initChecked = false;
  private exited = false;
  private readonly exitPromise: Promise<void>;
  private requestCounter = 0;

  constructor(child: ChildProcess, ref: string) {
    this.child = child;
    this.ref = ref;
    child.stdin?.on('error', () => {
      // EPIPE when the process is gone; the exit handler reports it.
    });
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => this.onStdout(chunk));
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string) => {
      this.stderrTail = (this.stderrTail + chunk).slice(-STDERR_TAIL_CHARS);
    });
    this.exitPromise = new Promise((resolve) => {
      child.once('close', (code, signal) => {
        this.onExit(code, signal);
        resolve();
      });
      child.once('error', (e) => {
        this.stderrTail = (this.stderrTail + `\n${e.message}`).slice(-STDERR_TAIL_CHARS);
      });
    });
  }

  get events(): AsyncIterable<BackendEvent> {
    return this.queue;
  }

  get isRunningTurn(): boolean {
    return this.turnActive;
  }

  send(input: { text: string; imagePath?: string }): void {
    if (this.exited) {
      throw new Error('Claude Code is not running.');
    }
    const content: unknown[] = [];
    if (input.imagePath) {
      const data = fs.readFileSync(input.imagePath).toString('base64');
      content.push({ type: 'image', source: { type: 'base64', media_type: 'image/png', data } });
    }
    content.push({ type: 'text', text: input.text });
    this.turnActive = true;
    this.write({ type: 'user', message: { role: 'user', content }, parent_tool_use_id: null, session_id: this.ref });
  }

  async interrupt(): Promise<void> {
    if (!this.turnActive || this.exited) {
      return;
    }
    this.mapper.interrupting = true;
    this.requestCounter += 1;
    this.write({ type: 'control_request', request_id: `fluidcad-interrupt-${this.requestCounter}`, request: { subtype: 'interrupt' } });
    const ended = await this.waitForTurnEnd(INTERRUPT_GRACE_MS);
    if (!ended) {
      // The CLI did not end the turn: the next message respawns with --resume.
      await this.kill();
    }
  }

  async close(): Promise<void> {
    if (this.exited) {
      return;
    }
    // Closing stdin ends a `-p` run once it is idle.
    this.child.stdin?.end();
    if (await this.waitForExit(CLOSE_GRACE_MS)) {
      return;
    }
    await this.kill();
  }

  private async kill(): Promise<void> {
    if (this.exited) {
      return;
    }
    this.child.kill('SIGTERM');
    if (await this.waitForExit(KILL_GRACE_MS)) {
      return;
    }
    this.child.kill('SIGKILL');
    await this.waitForExit(KILL_GRACE_MS);
  }

  private write(message: unknown): void {
    this.child.stdin?.write(`${JSON.stringify(message)}\n`);
  }

  private onStdout(chunk: string): void {
    const text = this.stdoutRest + chunk;
    const lines = text.split('\n');
    this.stdoutRest = lines.pop() ?? '';
    for (const line of lines) {
      this.onLine(line);
    }
  }

  private onLine(line: string): void {
    const initBefore = this.mapper.init;
    const events = this.mapper.pushLine(line);
    if (!this.initChecked && this.mapper.init && this.mapper.init !== initBefore) {
      this.initChecked = true;
      const status = this.mapper.init.mcpStatus;
      if (status !== 'connected' && status !== 'pending') {
        // A session without FluidCAD's tools is a start failure, not a quiet chat (§9.4).
        this.emit({ type: 'notice', level: 'error', text: `FluidCAD's tools did not connect to Claude Code (status: ${status ?? 'missing'}).` });
        this.endTurn({ type: 'turn-end', reason: 'error', error: { kind: 'other', message: "FluidCAD's MCP server did not connect to Claude Code." } });
        void this.kill();
        return;
      }
    }
    for (const event of events) {
      if (event.type === 'turn-end') {
        this.endTurn(event);
      } else if (this.turnActive) {
        this.emit(event);
      }
    }
  }

  private emit(event: BackendEvent): void {
    this.queue.push(event);
  }

  private endTurn(event: Extract<BackendEvent, { type: 'turn-end' }>): void {
    if (!this.turnActive) {
      return;
    }
    this.turnActive = false;
    this.queue.push(event);
    const waiters = this.turnWaiters;
    this.turnWaiters = [];
    for (const resolve of waiters) {
      resolve();
    }
  }

  private onExit(code: number | null, signal: NodeJS.Signals | null): void {
    if (this.stdoutRest.trim() !== '') {
      this.onLine(this.stdoutRest);
      this.stdoutRest = '';
    }
    this.exited = true;
    if (this.turnActive) {
      if (this.mapper.interrupting) {
        this.endTurn({ type: 'turn-end', reason: 'interrupted' });
      } else {
        const tail = this.stderrTail.trim();
        if (code === 1 && tail === '') {
          // §19: a run that is not signed in exits with 1 by itself.
          this.endTurn({
            type: 'turn-end',
            reason: 'error',
            error: { kind: 'auth', message: 'Claude Code exited; it may not be signed in. Run `claude auth login` in a terminal, then try again.' },
          });
        } else {
          const how = signal ? `was stopped (${signal})` : `exited with code ${code}`;
          this.endTurn({
            type: 'turn-end',
            reason: 'error',
            error: { kind: 'other', message: `Claude Code ${how}.${tail ? `\n${lastLines(tail, 12)}` : ''}` },
          });
        }
      }
    }
    this.queue.end();
  }

  private waitForTurnEnd(ms: number): Promise<boolean> {
    if (!this.turnActive) {
      return Promise.resolve(true);
    }
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(!this.turnActive), ms);
      this.turnWaiters.push(() => {
        clearTimeout(timer);
        resolve(true);
      });
    });
  }

  private waitForExit(ms: number): Promise<boolean> {
    if (this.exited) {
      return Promise.resolve(true);
    }
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(this.exited), ms);
      void this.exitPromise.then(() => {
        clearTimeout(timer);
        resolve(true);
      });
    });
  }
}

function readAuthMethod(stdout: string): string | null {
  try {
    const parsed = JSON.parse(stdout);
    return typeof parsed?.authMethod === 'string' ? parsed.authMethod : null;
  } catch {
    return null;
  }
}

function firstLine(text: string): string {
  return text.trim().split('\n')[0]?.slice(0, 200) ?? '';
}

function lastLines(text: string, count: number): string {
  return text.split('\n').slice(-count).join('\n');
}
