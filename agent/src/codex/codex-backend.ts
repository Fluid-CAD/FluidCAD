// Drives the user's own Codex (docs/agent-chat-plan.md §5.2 as corrected in
// §19).
//
// One long-lived `codex app-server` per engine serves every chat session as
// its own thread (app-server.ts). A session's run is a thread: started, or
// resumed, with the hardened configuration of thread-config.ts and the
// session's own MCP endpoint, then driven turn by turn. When no session holds
// a thread any more, the server lingers a little (a model change closes and
// reopens a run at once) and is then closed.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AgentBackend, AgentInstall, AgentModel, AgentRun, BackendEvent, BackendLogin, DetectOptions, OpenOptions } from '../backend.ts';
import { AsyncQueue } from '../async-queue.ts';
import { compareVersions, findOnPath, isExecutableFile, parseVersion, runBriefly } from '../locate.ts';
import { CodexAppServer, type ThreadListener } from './app-server.ts';
import { JsonRpcError, type JsonRpcNotification } from './json-rpc.ts';
import { CodexEventMapper } from './notifications.ts';
import {
  buildThreadResumeParams,
  buildThreadStartParams,
  DEFAULT_MODEL_ID,
  FLUIDCAD_MCP_SERVER,
  modelParam,
  userServerNames,
  type ThreadParamsInput,
} from './thread-config.ts';

/** The oldest codex-cli this driver was checked against (§19: 0.162.1). */
export const CODEX_MIN_VERSION = '0.162.0';
/** How long a server with no thread stays up before it is closed. */
export const CODEX_LINGER_MS = 60_000;
const INTERRUPT_GRACE_MS = 5_000;
const REQUEST_TIMEOUT_MS = 60_000;
/** How long FluidCAD's MCP server may take to connect when a thread starts. */
const MCP_STARTUP_TIMEOUT_MS = 20_000;
/** How often the thread's MCP servers are listed while FluidCAD's has not reported its startup. */
const MCP_POLL_MS = 2_000;
const MCP_FAILED_STATES = new Set(['failed', 'cancelled', 'authenticationRequired', 'disabled']);
const MAX_MODEL_PAGES = 5;
/** How long a sign-in may wait for the user in the browser before it is stopped. */
export const CODEX_LOGIN_TIMEOUT_MS = 10 * 60 * 1000;

export type CodexBackendOptions = {
  /** FluidCAD's version, sent as `clientInfo.version`. */
  clientVersion?: string;
  /** Where the app server runs when no thread names a folder (`model/list`). */
  cwd?: string;
  /** Home directory for the fixed install locations (tests point it at a temp dir). */
  homeDir?: string;
  platform?: NodeJS.Platform;
  arch?: string;
  /** Overrides the fixed install locations searched after PATH. */
  fixedPaths?: string[];
  /** How long an unused server lingers (tests). */
  lingerMs?: number;
  /** How long a thread may wait for FluidCAD's MCP server to connect (tests). */
  mcpStartupTimeoutMs?: number;
  /** How long an interrupted turn may take to end before the run ends it itself (tests). */
  interruptGraceMs?: number;
  /** How long a sign-in waits for the user (tests). */
  loginTimeoutMs?: number;
};

type ServerSlot = {
  path: string;
  promise: Promise<CodexAppServer>;
  server: CodexAppServer | null;
  refs: number;
  linger: ReturnType<typeof setTimeout> | null;
};

export class CodexBackend implements AgentBackend {
  readonly kind = 'codex' as const;
  private readonly clientVersion: string;
  private readonly cwd: string;
  private readonly homeDir: string;
  private readonly platform: NodeJS.Platform;
  private readonly arch: string;
  private readonly fixedPathsOverride: string[] | undefined;
  private readonly lingerMs: number;
  private readonly mcpStartupTimeoutMs: number;
  private readonly interruptGraceMs: number;
  private readonly loginTimeoutMs: number;
  private slot: ServerSlot | null = null;
  /** How many app servers this backend started (tests). */
  serversStarted = 0;

  constructor(options: CodexBackendOptions = {}) {
    this.clientVersion = options.clientVersion ?? '0.0.0';
    this.cwd = options.cwd ?? process.cwd();
    this.homeDir = options.homeDir ?? os.homedir();
    this.platform = options.platform ?? process.platform;
    this.arch = options.arch ?? process.arch;
    this.fixedPathsOverride = options.fixedPaths;
    this.lingerMs = options.lingerMs ?? CODEX_LINGER_MS;
    this.mcpStartupTimeoutMs = options.mcpStartupTimeoutMs ?? MCP_STARTUP_TIMEOUT_MS;
    this.interruptGraceMs = options.interruptGraceMs ?? INTERRUPT_GRACE_MS;
    this.loginTimeoutMs = options.loginTimeoutMs ?? CODEX_LOGIN_TIMEOUT_MS;
  }

  // -------------------------------------------------------------------------
  // Detection (§5.2, §9.1)
  // -------------------------------------------------------------------------

  /** Where an install is looked for after PATH: a Dock-launched app has no shell PATH. */
  fixedPaths(env: NodeJS.ProcessEnv): string[] {
    if (this.fixedPathsOverride) {
      return this.fixedPathsOverride;
    }
    if (this.platform === 'win32') {
      const profile = env.USERPROFILE ?? this.homeDir;
      const localAppData = env.LOCALAPPDATA ?? path.join(profile, 'AppData', 'Local');
      const appData = env.APPDATA ?? path.join(profile, 'AppData', 'Roaming');
      return [
        path.join(localAppData, 'Programs', 'OpenAI', 'Codex', 'bin', 'codex.exe'),
        path.join(profile, '.local', 'bin', 'codex.exe'),
        path.join(appData, 'npm', 'codex.cmd'),
      ];
    }
    return [
      path.join(this.homeDir, '.local', 'bin', 'codex'),
      '/opt/homebrew/bin/codex',
      '/usr/local/bin/codex',
      path.join(this.homeDir, '.npm-global', 'bin', 'codex'),
    ];
  }

  async detect(options: DetectOptions): Promise<AgentInstall> {
    const base: AgentInstall = {
      kind: 'codex',
      path: null,
      version: null,
      minVersion: CODEX_MIN_VERSION,
      supported: false,
      loggedIn: null,
    };
    const override = options.pathOverride?.trim();
    let candidates: string[];
    if (override) {
      if (!path.isAbsolute(override) || !isExecutableFile(override, this.platform)) {
        return { ...base, path: override, problem: `The Codex path in FluidCAD's preferences (agent.codexPath) is not an executable file: ${override}` };
      }
      candidates = [override];
    } else {
      const onPath = findOnPath('codex', options.env, this.platform);
      candidates = [...new Set([...(onPath ? [onPath] : []), ...this.fixedPaths(options.env).filter((p) => isExecutableFile(p, this.platform))])];
    }
    if (candidates.length === 0) {
      return { ...base, problem: 'Codex was not found on your PATH or in the usual install folders. Install it, then check again.' };
    }

    let lastProblem = '';
    for (const found of candidates) {
      // An npm install is a Node launcher; the engine runs the native program it wraps.
      const resolved = resolveCodexProgram(found, this.platform, this.arch);
      if (resolved.kind === 'npm-without-native') {
        lastProblem =
          `${found} is the npm launcher of Codex, and the program it starts was not found next to it. ` +
          'Install the standalone Codex (see the Codex install page).';
        continue;
      }
      const candidate = resolved.path;
      const result = await runBriefly(candidate, ['--version'], { env: options.env, timeoutMs: 15_000 });
      const output = `${result.stdout}\n${result.stderr}`;
      const version = parseVersion(result.stdout) ?? parseVersion(output);
      if (result.code !== 0 || !version || !/codex/i.test(output)) {
        lastProblem = `${candidate} is not Codex (its --version said: ${firstLine(output) || result.error || 'nothing'}).`;
        continue;
      }
      const install: AgentInstall = { ...base, path: candidate, version };
      if (compareVersions(version, CODEX_MIN_VERSION) < 0) {
        return {
          ...install,
          problem: `Codex ${version} is too old: FluidCAD needs ${CODEX_MIN_VERSION} or later. Update Codex, then check again.`,
        };
      }
      install.supported = true;
      // The exit code is all that is read: 0 signed in, 1 not (§5.2).
      const login = await runBriefly(candidate, ['login', 'status'], { env: options.env, timeoutMs: 15_000 });
      if (login.code === 0) {
        install.loggedIn = true;
      } else if (login.code === 1) {
        install.loggedIn = false;
        install.problem = 'Codex is not signed in. Run `codex login` in a terminal, then check again.';
      } else {
        install.loggedIn = null;
      }
      return install;
    }
    return { ...base, problem: lastProblem || 'Codex was not found.' };
  }

  // -------------------------------------------------------------------------
  // Models (§9.2)
  // -------------------------------------------------------------------------

  async models(install: AgentInstall, env: NodeJS.ProcessEnv = process.env): Promise<AgentModel[]> {
    if (!install.path || !install.supported) {
      return [];
    }
    let server: CodexAppServer;
    try {
      server = await this.acquire(install.path, env);
    } catch (e) {
      console.error('[agent] Codex could not list its models:', e);
      return [];
    }
    try {
      const models: AgentModel[] = [];
      let cursor: string | null = null;
      for (let page = 0; page < MAX_MODEL_PAGES; page++) {
        const result: any = await server.rpc.request('model/list', { includeHidden: false, ...(cursor ? { cursor } : {}) }, REQUEST_TIMEOUT_MS);
        for (const m of Array.isArray(result?.data) ? result.data : []) {
          const model = toAgentModel(m);
          if (model) {
            models.push(model);
          }
        }
        cursor = typeof result?.nextCursor === 'string' && result.nextCursor !== '' ? result.nextCursor : null;
        if (!cursor) {
          break;
        }
      }
      return models.length > 0 ? [{ id: DEFAULT_MODEL_ID, label: 'Default' }, ...models] : [];
    } catch (e) {
      console.error('[agent] Codex could not list its models:', e);
      return [];
    } finally {
      this.release(server);
    }
  }

  // -------------------------------------------------------------------------
  // Runs
  // -------------------------------------------------------------------------

  async open(options: OpenOptions): Promise<AgentRun> {
    if (!options.install.path) {
      throw new Error('Codex was not found.');
    }
    const server = await this.acquire(options.install.path, options.env);
    let run: CodexRun | null = null;
    try {
      const configRead = await server.rpc.request('config/read', { includeLayers: false, cwd: options.cwd }, REQUEST_TIMEOUT_MS).catch((e) => {
        // Without the list the user's own servers could not be turned off: no thread.
        throw new Error(`Codex could not read its configuration: ${e instanceof Error ? e.message : String(e)}`);
      });
      const params: ThreadParamsInput = {
        cwd: options.cwd,
        instructions: options.instructions,
        model: options.model ?? null,
        mcpUrl: options.mcpUrl,
        userServers: userServerNames(configRead),
      };
      const notices: string[] = [];
      let thread: any;
      if (options.resume) {
        try {
          thread = await server.rpc.request('thread/resume', buildThreadResumeParams(options.resume, params), REQUEST_TIMEOUT_MS);
        } catch (e) {
          if (!(e instanceof JsonRpcError)) {
            throw e;
          }
          notices.push(`Codex could not continue the earlier conversation (${e.message}), so this one starts afresh.`);
          thread = null;
        }
      }
      thread ??= await server.rpc.request('thread/start', buildThreadStartParams(params), REQUEST_TIMEOUT_MS);
      const threadId = thread?.thread?.id;
      if (typeof threadId !== 'string' || threadId === '') {
        throw new Error('Codex started a thread without an id.');
      }
      run = new CodexRun(server, threadId, {
        model: options.model ?? null,
        effort: options.effort ?? null,
        interruptGraceMs: this.interruptGraceMs,
        release: () => this.release(server),
      });
      for (const notice of notices) {
        run.queueNotice('info', notice);
      }
      await run.checkMcp(this.mcpStartupTimeoutMs);
      return run;
    } catch (e) {
      if (run) {
        await run.close();
      } else {
        this.release(server);
      }
      throw e;
    }
  }

  // -------------------------------------------------------------------------
  // Sign-in (§5.2: `account/login/start`)
  // -------------------------------------------------------------------------

  /**
   * Starts the ChatGPT sign-in of the app server: Codex answers with the page
   * to open in the user's browser, listens on its own loopback callback, and
   * reports `account/login/completed`. The server stays up until then (or
   * {@link loginTimeoutMs}). Nothing about the account is read: the caller
   * detects again once it succeeded.
   */
  async login(install: AgentInstall, env: NodeJS.ProcessEnv = process.env): Promise<BackendLogin> {
    if (!install.path || !install.supported) {
      throw new Error('Codex was not found.');
    }
    const server = await this.acquire(install.path, env);
    let released = false;
    const release = () => {
      if (!released) {
        released = true;
        this.release(server);
      }
    };
    let settle!: (outcome: { success: boolean; error?: string }) => void;
    const done = new Promise<{ success: boolean; error?: string }>((resolve) => {
      settle = resolve;
    });
    let loginId: string | null = null;
    // Listening before the request: the completion may come right after its answer.
    const early: { loginId: string | null; success: boolean; error?: string }[] = [];
    const unsubscribe = server.onAccountNotification((message) => {
      if (message.method !== 'account/login/completed') {
        return;
      }
      const p = message.params ?? {};
      const outcome = {
        loginId: typeof p.loginId === 'string' ? p.loginId : null,
        success: p.success === true,
        ...(typeof p.error === 'string' && p.error !== '' ? { error: p.error } : {}),
      };
      if (loginId === null) {
        early.push(outcome);
      } else if (outcome.loginId === null || outcome.loginId === loginId) {
        finish(outcome);
      }
    });
    let timer: ReturnType<typeof setTimeout> | null = null;
    const finish = (outcome: { success: boolean; error?: string }) => {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      unsubscribe();
      release();
      settle(outcome.success ? { success: true } : { success: false, ...(outcome.error ? { error: outcome.error } : {}) });
    };

    let result: any;
    try {
      result = await server.rpc.request('account/login/start', { type: 'chatgpt' }, REQUEST_TIMEOUT_MS);
    } catch (e) {
      unsubscribe();
      release();
      throw new Error(`Codex could not start signing in: ${e instanceof Error ? e.message : String(e)}`);
    }
    const url = typeof result?.authUrl === 'string' ? result.authUrl : '';
    if (result?.type !== 'chatgpt' || typeof result.loginId !== 'string' || !isHttpsUrl(url)) {
      unsubscribe();
      release();
      throw new Error('Codex did not answer with a page to sign in on.');
    }
    loginId = result.loginId as string;
    const id = loginId;
    const cancel = async () => {
      if (released) {
        return;
      }
      await server.rpc.request('account/login/cancel', { loginId: id }, REQUEST_TIMEOUT_MS).catch(() => {});
      // Codex reports the cancelled login as not completed; end it here if it does not.
      finish({ success: false, error: 'Signing in was cancelled.' });
    };
    timer = setTimeout(() => {
      timer = null;
      void server.rpc.request('account/login/cancel', { loginId: id }, REQUEST_TIMEOUT_MS).catch(() => {});
      finish({ success: false, error: 'Signing in took too long and was stopped.' });
    }, this.loginTimeoutMs);
    timer.unref?.();
    const first = early.find((o) => o.loginId === null || o.loginId === id);
    if (first) {
      finish(first);
    }
    return { id, url, done, cancel };
  }

  async dispose(): Promise<void> {
    const slot = this.slot;
    this.slot = null;
    if (!slot) {
      return;
    }
    if (slot.linger) {
      clearTimeout(slot.linger);
    }
    const server = slot.server ?? (await slot.promise.catch((): null => null));
    await server?.close();
  }

  /** The shared server for `programPath`, started if needed. */
  private async acquire(programPath: string, env: NodeJS.ProcessEnv): Promise<CodexAppServer> {
    let slot = this.slot;
    if (slot && (slot.path !== programPath || slot.server?.exited)) {
      // Another install was chosen (Settings), or the server died: its threads end with it.
      this.retire(slot);
      slot = null;
    }
    if (!slot) {
      this.serversStarted += 1;
      const created: ServerSlot = {
        path: programPath,
        promise: CodexAppServer.start({ path: programPath, env, cwd: this.cwd, clientVersion: this.clientVersion }),
        server: null,
        refs: 0,
        linger: null,
      };
      this.slot = created;
      slot = created;
      created.promise.then(
        (server) => {
          created.server = server;
          server.onExitOnce(() => {
            if (this.slot === created) {
              this.slot = null;
            }
          });
        },
        () => {
          if (this.slot === created) {
            this.slot = null;
          }
        },
      );
    }
    slot.refs += 1;
    if (slot.linger) {
      clearTimeout(slot.linger);
      slot.linger = null;
    }
    try {
      return await slot.promise;
    } catch (e) {
      slot.refs -= 1;
      throw e;
    }
  }

  private release(server: CodexAppServer): void {
    const slot = this.slot;
    if (!slot || slot.server !== server) {
      // A retired server: close it once its last thread is gone.
      if (server.threadCount === 0) {
        void server.close();
      }
      return;
    }
    slot.refs = Math.max(0, slot.refs - 1);
    if (slot.refs > 0 || slot.linger) {
      return;
    }
    slot.linger = setTimeout(() => {
      slot.linger = null;
      if (this.slot === slot && slot.refs === 0) {
        this.slot = null;
        void server.close();
      }
    }, this.lingerMs);
    slot.linger.unref?.();
  }

  private retire(slot: ServerSlot): void {
    if (slot.linger) {
      clearTimeout(slot.linger);
    }
    if (this.slot === slot) {
      this.slot = null;
    }
    if (slot.refs === 0) {
      void slot.promise.then((s) => s.close()).catch(() => {});
    }
  }
}

/** One chat session's Codex thread. */
export class CodexRun implements AgentRun, ThreadListener {
  readonly ref: string;
  private readonly server: CodexAppServer;
  private readonly mapper: CodexEventMapper;
  private readonly queue = new AsyncQueue<BackendEvent>();
  private readonly model: string | null;
  private readonly effort: string | null;
  private readonly releaseServer: () => void;
  private readonly interruptGraceMs: number;
  private readonly pendingNotices: { level: 'info' | 'warning'; text: string }[] = [];
  private turnWaiters: (() => void)[] = [];
  private turnIdWaiters: (() => void)[] = [];
  private closed = false;
  private released = false;
  /** FluidCAD's MCP server as Codex reported its startup: null until it says. */
  private mcpStatus: { status: string; error: string | null } | null = null;
  private mcpStatusWaiters: (() => void)[] = [];

  constructor(
    server: CodexAppServer,
    threadId: string,
    options: { model: string | null; effort: string | null; release: () => void; interruptGraceMs?: number },
  ) {
    this.server = server;
    this.ref = threadId;
    this.mapper = new CodexEventMapper(threadId);
    this.model = modelParam(options.model);
    this.effort = options.effort;
    this.releaseServer = options.release;
    this.interruptGraceMs = options.interruptGraceMs ?? INTERRUPT_GRACE_MS;
    server.attach(threadId, this);
  }

  get events(): AsyncIterable<BackendEvent> {
    return this.queue;
  }

  get isRunningTurn(): boolean {
    return this.mapper.isActive;
  }

  /** A notice shown at the start of the next turn (the run has none yet). */
  queueNotice(level: 'info' | 'warning', text: string): void {
    this.pendingNotices.push({ level, text });
  }

  /**
   * Fails unless FluidCAD's MCP server connected to the thread (§9.4: a start
   * failure, not a quiet session without tools), and warns when one of the
   * user's own servers runs anyway.
   */
  async checkMcp(timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    let listed: any[] | null;
    for (;;) {
      // A thread Codex still had loaded reports no startup again: the list says how it is.
      await this.waitForMcpStatus(Math.min(MCP_POLL_MS, Math.max(0, deadline - Date.now())));
      if (this.server.exited) {
        throw new Error('Codex exited while the conversation was starting.');
      }
      listed = await this.listMcpServers();
      const ours = listed?.find((s) => s?.name === FLUIDCAD_MCP_SERVER);
      if (this.mcpStatus?.status === 'ready' || ours?.runtimeStatus === 'connected') {
        break;
      }
      const failed = (this.mcpStatus !== null && this.mcpStatus.status !== 'ready') || MCP_FAILED_STATES.has(ours?.runtimeStatus);
      if (failed || Date.now() >= deadline) {
        const status = this.mcpStatus?.status ?? ours?.runtimeStatus ?? 'missing';
        const error = this.mcpStatus?.error ? `: ${this.mcpStatus.error}` : '';
        throw new Error(`FluidCAD's MCP server did not connect to Codex (status: ${status}${error}).`);
      }
    }
    const others = (listed ?? [])
      .filter((s) => s?.name !== FLUIDCAD_MCP_SERVER && (s?.runtimeStatus === 'connected' || s?.runtimeStatus === 'starting'))
      .map((s) => String(s.name));
    if (others.length > 0) {
      this.queueNotice('warning', `Codex also started MCP servers FluidCAD could not turn off: ${others.join(', ')}.`);
    }
  }

  /** The thread's MCP servers as Codex lists them; null when it cannot. */
  private async listMcpServers(): Promise<any[] | null> {
    try {
      const result: any = await this.server.rpc.request(
        'mcpServerStatus/list',
        { threadId: this.ref, detail: 'toolsAndAuthOnly' },
        REQUEST_TIMEOUT_MS,
      );
      return Array.isArray(result?.data) ? result.data : [];
    } catch (e) {
      if (e instanceof JsonRpcError) {
        return null;
      }
      throw e;
    }
  }

  send(input: { text: string; imagePath?: string }): void {
    if (this.closed || this.server.exited) {
      throw new Error('Codex is not running.');
    }
    if (this.mapper.isActive) {
      throw new Error('A Codex turn is already running.');
    }
    this.mapper.beginTurn();
    for (const notice of this.pendingNotices.splice(0)) {
      this.emit({ type: 'notice', level: notice.level, text: notice.text });
    }
    const content: unknown[] = [];
    if (input.imagePath) {
      content.push({ type: 'localImage', path: input.imagePath });
    }
    content.push({ type: 'text', text: input.text, text_elements: [] });
    const params = {
      threadId: this.ref,
      input: content,
      ...(this.model ? { model: this.model } : {}),
      ...(this.effort ? { effort: this.effort } : {}),
      summary: 'concise',
    };
    this.server.rpc.request('turn/start', params, REQUEST_TIMEOUT_MS).then(
      (result: any) => {
        if (typeof result?.turn?.id === 'string') {
          this.mapper.setTurnId(result.turn.id);
          this.wakeTurnIdWaiters();
        }
      },
      (e) => {
        this.emitAll(this.mapper.endLocally('error', { kind: 'other', message: `Codex did not start the turn: ${e instanceof Error ? e.message : String(e)}` }));
      },
    );
  }

  async interrupt(): Promise<void> {
    if (!this.mapper.isActive) {
      return;
    }
    this.mapper.interrupting = true;
    const turnId = await this.waitForTurnId(this.interruptGraceMs);
    if (turnId && this.mapper.isActive && !this.server.exited) {
      // Codex answers at once and ends the turn as interrupted. It does not
      // cancel an MCP call in flight (§19): the gate refuses whatever that
      // call, or a later one, tries once the session stopped the turn.
      await this.server.rpc.request('turn/interrupt', { threadId: this.ref, turnId }, this.interruptGraceMs).catch(() => {});
    }
    if (!(await this.waitForTurnEnd(this.interruptGraceMs))) {
      // Codex did not end the turn: the session moves on; late events of that turn are ignored.
      this.emitAll(this.mapper.endLocally('interrupted'));
    }
  }

  async close(): Promise<void> {
    if (this.closed) {
      return;
    }
    if (this.mapper.isActive) {
      await this.interrupt();
    }
    this.closed = true;
    this.server.detach(this.ref, this);
    if (!this.server.exited) {
      // The thread is unloaded; a later run resumes it with the config again.
      await this.server.rpc.request('thread/unsubscribe', { threadId: this.ref }, this.interruptGraceMs).catch(() => {});
    }
    this.queue.end();
    this.release();
  }

  // --- ThreadListener --------------------------------------------------------

  onNotification(message: JsonRpcNotification): void {
    if (message.method === 'mcpServer/startupStatus/updated' && message.params?.name === FLUIDCAD_MCP_SERVER) {
      const status = String(message.params.status ?? '');
      if (status !== 'starting') {
        this.mcpStatus = { status, error: typeof message.params.error === 'string' ? message.params.error : null };
        for (const wake of this.mcpStatusWaiters.splice(0)) {
          wake();
        }
      }
      return;
    }
    const before = this.mapper.turnId;
    this.emitAll(this.mapper.push(message));
    if (!before && this.mapper.turnId) {
      this.wakeTurnIdWaiters();
    }
  }

  onDeclinedRequest(notice: string): void {
    if (this.mapper.isActive) {
      this.emit({ type: 'notice', level: 'warning', text: notice });
    }
  }

  onServerExit(message: string): void {
    if (this.mapper.isActive) {
      this.emitAll(
        this.mapper.interrupting ? this.mapper.endLocally('interrupted') : this.mapper.endLocally('error', { kind: 'other', message }),
      );
    }
    for (const wake of this.mcpStatusWaiters.splice(0)) {
      wake();
    }
    this.closed = true;
    this.queue.end();
    this.release();
  }

  // ---------------------------------------------------------------------------

  private release(): void {
    if (!this.released) {
      this.released = true;
      this.releaseServer();
    }
  }

  private emit(event: BackendEvent): void {
    this.queue.push(event);
  }

  private emitAll(events: BackendEvent[]): void {
    for (const event of events) {
      this.emit(event);
      if (event.type === 'turn-end') {
        for (const wake of this.turnWaiters.splice(0)) {
          wake();
        }
      }
    }
  }

  private wakeTurnIdWaiters(): void {
    for (const wake of this.turnIdWaiters.splice(0)) {
      wake();
    }
  }

  private waitForMcpStatus(ms: number): Promise<void> {
    if (this.mcpStatus || this.server.exited) {
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, ms);
      timer.unref?.();
      this.mcpStatusWaiters.push(() => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  private waitForTurnId(ms: number): Promise<string | null> {
    if (this.mapper.turnId || !this.mapper.isActive) {
      return Promise.resolve(this.mapper.turnId);
    }
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(this.mapper.turnId), ms);
      this.turnIdWaiters.push(() => {
        clearTimeout(timer);
        resolve(this.mapper.turnId);
      });
    });
  }

  private waitForTurnEnd(ms: number): Promise<boolean> {
    if (!this.mapper.isActive) {
      return Promise.resolve(true);
    }
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(!this.mapper.isActive), ms);
      this.turnWaiters.push(() => {
        clearTimeout(timer);
        resolve(true);
      });
    });
  }
}

/** A `model/list` entry as the picker offers it. */
function toAgentModel(m: any): AgentModel | null {
  const id = typeof m?.model === 'string' && m.model !== '' ? m.model : typeof m?.id === 'string' ? m.id : null;
  if (!id || m?.hidden === true) {
    return null;
  }
  const efforts = Array.isArray(m.supportedReasoningEfforts)
    ? m.supportedReasoningEfforts.map((e: any) => (typeof e === 'string' ? e : e?.reasoningEffort)).filter((e: unknown): e is string => typeof e === 'string')
    : [];
  return {
    id,
    label: typeof m.displayName === 'string' && m.displayName !== '' ? m.displayName : id,
    ...(typeof m.description === 'string' && m.description !== '' ? { description: m.description } : {}),
    ...(m.isDefault === true ? { isDefault: true } : {}),
    ...(efforts.length > 0 ? { efforts } : {}),
    ...(typeof m.defaultReasoningEffort === 'string' ? { defaultEffort: m.defaultReasoningEffort } : {}),
    ...(Array.isArray(m.inputModalities) ? { acceptsImages: m.inputModalities.includes('image') } : {}),
  };
}

// ---------------------------------------------------------------------------
// The npm launcher (§5.2)
// ---------------------------------------------------------------------------

/** Rust target triples of Codex's native builds for a platform and CPU, most likely first. */
export function codexTargetTriples(platform: NodeJS.Platform | string, arch: string): string[] {
  const cpu = arch === 'x64' ? 'x86_64' : arch === 'arm64' ? 'aarch64' : null;
  if (!cpu) {
    return [];
  }
  switch (platform) {
    case 'linux':
      return [`${cpu}-unknown-linux-musl`, `${cpu}-unknown-linux-gnu`];
    case 'darwin':
      return [`${cpu}-apple-darwin`];
    case 'win32':
      return [`${cpu}-pc-windows-msvc`];
    default:
      return [];
  }
}

export type ResolvedCodexProgram = { kind: 'native' | 'npm-native'; path: string } | { kind: 'npm-without-native' };

/**
 * The program to run for a `codex` found on disk. A standalone install is
 * the program itself. An npm install is a Node launcher (`bin/codex.js`, or
 * npm's `codex.cmd` shim on Windows) that starts a native build shipped in a
 * platform package, `@openai/codex-<platform>-<arch>/vendor/<triple>/…`:
 * that build is run directly, so Node need not be on the user's PATH.
 */
export function resolveCodexProgram(found: string, platform: NodeJS.Platform | string, arch: string): ResolvedCodexProgram {
  const packageRoot = npmPackageRoot(found, platform);
  if (!packageRoot) {
    return { kind: 'native', path: found };
  }
  const exe = platform === 'win32' ? 'codex.exe' : 'codex';
  const platformPackage = `codex-${platform}-${arch}`;
  const vendorRoots = [
    path.join(packageRoot, 'vendor'),
    path.join(packageRoot, 'node_modules', '@openai', platformPackage, 'vendor'),
    // Hoisted beside the launcher's package.
    path.join(path.dirname(packageRoot), platformPackage, 'vendor'),
  ];
  for (const root of vendorRoots) {
    for (const triple of codexTargetTriples(platform, arch)) {
      for (const sub of ['bin', 'codex']) {
        const candidate = path.join(root, triple, sub, exe);
        if (isExecutableFile(candidate, platform as NodeJS.Platform)) {
          return { kind: 'npm-native', path: candidate };
        }
      }
    }
  }
  return { kind: 'npm-without-native' };
}

/** The `@openai/codex` package folder when `found` is its npm launcher; null for anything else. */
function npmPackageRoot(found: string, platform: NodeJS.Platform | string): string | null {
  if (platform === 'win32' && /\.(cmd|ps1|bat)$/i.test(found)) {
    const root = path.join(path.dirname(found), 'node_modules', '@openai', 'codex');
    return fs.existsSync(root) ? root : null;
  }
  let real: string;
  try {
    real = fs.realpathSync(found);
  } catch {
    return null;
  }
  if (!/\.(c|m)?js$/i.test(real) && !hasNodeShebang(real)) {
    return null;
  }
  let dir = path.dirname(real);
  for (let i = 0; i < 4; i++) {
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
      if (pkg?.name === '@openai/codex') {
        return dir;
      }
    } catch {
      // Not here.
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      break;
    }
    dir = parent;
  }
  // A Node script that is not Codex's launcher: run it as found.
  return null;
}

function hasNodeShebang(file: string): boolean {
  try {
    const fd = fs.openSync(file, 'r');
    try {
      const buffer = Buffer.alloc(128);
      const n = fs.readSync(fd, buffer, 0, buffer.length, 0);
      const first = buffer.subarray(0, n).toString('utf8').split('\n')[0] ?? '';
      return first.startsWith('#!') && /\bnode\b/.test(first);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return false;
  }
}

function isHttpsUrl(text: string): boolean {
  try {
    return new URL(text).protocol === 'https:';
  } catch {
    return false;
  }
}

function firstLine(text: string): string {
  return text.trim().split('\n')[0]?.slice(0, 200) ?? '';
}
