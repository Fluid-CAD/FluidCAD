// The agent runtime of one engine: detection, the chat sessions of its
// workspace, and their MCP endpoints.

import { randomUUID } from 'node:crypto';
import type { AgentHostDeps } from '../../server/dist/agent-host.js';
import type { Preferences } from '../../server/dist/preferences.js';
import type { AgentBackend, AgentInstall, AgentModel, BackendLogin } from './backend.ts';
import { ClaudeBackend, claudeChildEnv } from './claude/claude-backend.ts';
import { CodexBackend } from './codex/codex-backend.ts';
import { composeInstructions } from './instructions.ts';
import { McpEndpoints, SharedMcpIndexes } from './mcp-endpoint.ts';
import { AgentSession, type SessionDeps, type TurnSetup } from './session.ts';
import { SessionStore } from './session-store.ts';
import type { ToolGateOptions } from './tool-gate.ts';
import { isEffortFor, type AgentKind, type SessionSummary } from './types.ts';

export const AGENT_KINDS: AgentKind[] = ['claude', 'codex'];

/** How the panel and the messages name each agent. */
export const AGENT_NAMES: Record<AgentKind, string> = { claude: 'Claude Code', codex: 'Codex' };

export type AgentRuntimeOptions = {
  backends?: Partial<Record<AgentKind, AgentBackend>>;
  store?: SessionStore;
  /** The environment children inherit (tests pass their own). */
  env?: NodeJS.ProcessEnv;
  idleMs?: number;
  /** Approval timeout and timers for every session's gate (tests). */
  gate?: ToolGateOptions;
};

/** Runtimes of this process, told when it exits (§12.1: approvals still waiting end as denied). */
const liveRuntimes = new Set<AgentRuntime>();
let exitHooked = false;

function onProcessExit(): void {
  for (const runtime of liveRuntimes) {
    runtime.onEngineExit();
  }
}

type Detection = { key: string; promise: Promise<AgentInstall> };

/** A sign-in from the app, as the page polls it. Nothing about the account is kept. */
export type LoginStatus = { state: 'pending' | 'done' | 'failed'; error?: string };

type LoginRecord = { kind: AgentKind; login: BackendLogin; status: LoginStatus };

/** Finished sign-ins kept for a late poll. */
const MAX_FINISHED_LOGINS = 8;

/** Why a sign-in cannot start: `unsupported` (the agent signs in in a terminal only), `not-installed`, `signed-in`. */
export class LoginError extends Error {
  readonly kind: 'unsupported' | 'not-installed' | 'signed-in';
  constructor(kind: 'unsupported' | 'not-installed' | 'signed-in', message: string) {
    super(message);
    this.kind = kind;
  }
}

export class AgentRuntime {
  readonly epoch = randomUUID();
  readonly endpoints = new McpEndpoints();
  readonly store: SessionStore;
  private readonly deps: AgentHostDeps;
  private readonly backends: Partial<Record<AgentKind, AgentBackend>>;
  private readonly baseEnv: NodeJS.ProcessEnv;
  private readonly indexes = new SharedMcpIndexes();
  private readonly idleMs: number | undefined;
  private readonly gateOptions: ToolGateOptions | undefined;
  private readonly sessions = new Map<string, AgentSession>();
  private readonly detections = new Map<AgentKind, Detection>();
  private loaded = false;
  private readonly instructionsText = new Map<AgentKind, string>();
  private readonly logins = new Map<string, LoginRecord>();

  constructor(deps: AgentHostDeps, options: AgentRuntimeOptions = {}) {
    this.deps = deps;
    this.backends = options.backends ?? {
      claude: new ClaudeBackend(),
      codex: new CodexBackend({ clientVersion: deps.version, cwd: deps.workspacePath }),
    };
    this.store = options.store ?? SessionStore.forWorkspace(deps.workspacePath);
    this.baseEnv = options.env ?? process.env;
    this.idleMs = options.idleMs;
    this.gateOptions = options.gate;
    liveRuntimes.add(this);
    if (!exitHooked) {
      exitHooked = true;
      // `exit` handlers run synchronously; settling and saving are too.
      process.on('exit', onProcessExit);
    }
  }

  /** The engine is exiting: approvals still waiting end as denied, and are saved so. Synchronous. */
  onEngineExit(): void {
    for (const session of this.sessions.values()) {
      try {
        session.onEngineExit();
      } catch (e) {
        console.error('[agent] settling approvals on exit failed:', e);
      }
    }
  }

  // -------------------------------------------------------------------------
  // Agents
  // -------------------------------------------------------------------------

  /** Every agent's install, from the cache unless `fresh` (§9.1). */
  async agents(fresh = false): Promise<AgentInstall[]> {
    const prefs = await this.deps.loadPreferences();
    return Promise.all(AGENT_KINDS.map((kind) => this.install(kind, prefs, fresh)));
  }

  async models(kind: AgentKind): Promise<AgentModel[]> {
    const backend = this.backends[kind];
    if (!backend) {
      return [];
    }
    const prefs = await this.deps.loadPreferences();
    const install = await this.install(kind, prefs, false);
    return backend.models(install, this.childEnv(kind, prefs, install));
  }

  /**
   * The install of `kind`, detected once per path override and API-key
   * choice (on, off or automatic): changing either in Settings detects again
   * on the next ask. Detection also settles the automatic API-key choice,
   * so "Check again" looks at the subscription login afresh.
   */
  install(kind: AgentKind, prefs: Preferences, fresh: boolean): Promise<AgentInstall> {
    const backend = this.backends[kind];
    if (!backend) {
      return Promise.resolve({
        kind,
        path: null,
        version: null,
        minVersion: '',
        supported: false,
        loggedIn: null,
        authMethod: null,
        problem: `${AGENT_NAMES[kind] ?? kind} is not available in this version of FluidCAD.`,
      });
    }
    const pathOverride = kind === 'claude' ? prefs.agent?.claudePath : prefs.agent?.codexPath;
    const choice = this.apiKeyChoice(kind, prefs);
    const key = JSON.stringify({ pathOverride: pathOverride ?? null, ignoreApiKey: choice ?? 'auto' });
    const cached = this.detections.get(kind);
    if (!fresh && cached && cached.key === key) {
      return cached.promise;
    }
    const promise = backend
      .detect({
        ...(pathOverride ? { pathOverride } : {}),
        // The key stays in: detection resolves whether it is used.
        env: kind === 'claude' ? claudeChildEnv(this.baseEnv) : { ...this.baseEnv },
        ...(choice !== undefined ? { ignoreApiKey: choice } : {}),
      })
      .catch((e): AgentInstall => ({
        kind,
        path: null,
        version: null,
        minVersion: '',
        supported: false,
        loggedIn: null,
        authMethod: null,
        problem: `Detection failed: ${e instanceof Error ? e.message : String(e)}`,
      }));
    this.detections.set(kind, { key, promise });
    return promise;
  }

  // -------------------------------------------------------------------------
  // Signing in from the app (§5.2: Codex's `account/login/start`)
  // -------------------------------------------------------------------------

  /**
   * Starts signing in to `kind` in the user's browser: the page to open, and
   * an id to ask about. Refused when the agent signs in in a terminal only,
   * is not installed, or is already signed in (a sign-in would replace the
   * account). A sign-in already waiting is answered again, so a second tab
   * does not start another. Once it succeeds, detection runs afresh on the
   * next ask.
   */
  async startLogin(kind: AgentKind): Promise<{ id: string; url: string }> {
    const backend = this.backends[kind];
    if (!backend?.login) {
      throw new LoginError('unsupported', `${AGENT_NAMES[kind] ?? kind} is signed in from a terminal.`);
    }
    for (const [id, record] of this.logins) {
      if (record.kind === kind && record.status.state === 'pending') {
        return { id, url: record.login.url };
      }
    }
    const prefs = await this.deps.loadPreferences();
    const install = await this.install(kind, prefs, true);
    if (!install.path || !install.supported) {
      throw new LoginError('not-installed', install.problem ?? `${AGENT_NAMES[kind]} was not found.`);
    }
    if (install.loggedIn === true) {
      throw new LoginError('signed-in', `${AGENT_NAMES[kind]} is already signed in.`);
    }
    const login = await backend.login(install, this.childEnv(kind, prefs, install));
    const record: LoginRecord = { kind, login, status: { state: 'pending' } };
    this.logins.set(login.id, record);
    this.pruneLogins();
    void login.done.then((outcome) => {
      record.status = outcome.success ? { state: 'done' } : { state: 'failed', ...(outcome.error ? { error: outcome.error } : {}) };
      if (outcome.success) {
        // Signed in now: the next ask detects again.
        this.detections.delete(kind);
      }
    });
    return { id: login.id, url: login.url };
  }

  /** How sign-in `id` of `kind` stands; null for one this engine does not know. */
  loginStatus(kind: AgentKind, id: string): LoginStatus | null {
    const record = this.logins.get(id);
    return record && record.kind === kind ? { ...record.status } : null;
  }

  /** Stops sign-in `id` (the user gave up); false when there is no such sign-in. */
  async cancelLogin(kind: AgentKind, id: string): Promise<boolean> {
    const record = this.logins.get(id);
    if (!record || record.kind !== kind) {
      return false;
    }
    if (record.status.state === 'pending') {
      await record.login.cancel();
    }
    return true;
  }

  private pruneLogins(): void {
    const finished = [...this.logins].filter(([, r]) => r.status.state !== 'pending');
    for (const [id] of finished.slice(0, Math.max(0, finished.length - MAX_FINISHED_LOGINS))) {
      this.logins.delete(id);
    }
  }

  /**
   * The environment the CLI of `kind` runs with (§19, owner decision on
   * ANTHROPIC_API_KEY): for Claude Code, without the key when the user
   * chose so, or, with no choice made, when detection found a subscription
   * signed in (`install.apiKeyIgnored`).
   */
  childEnv(kind: AgentKind, prefs: Preferences, install: AgentInstall): NodeJS.ProcessEnv {
    if (kind === 'claude') {
      const ignoreApiKey = this.apiKeyChoice(kind, prefs) ?? install.apiKeyIgnored === true;
      return claudeChildEnv(this.baseEnv, { ignoreApiKey });
    }
    return { ...this.baseEnv };
  }

  /** The user's explicit API-key choice for `kind`; undefined: automatic. */
  private apiKeyChoice(kind: AgentKind, prefs: Preferences): boolean | undefined {
    const value = prefs.agent?.claudeIgnoreApiKey;
    return kind === 'claude' && typeof value === 'boolean' ? value : undefined;
  }

  // -------------------------------------------------------------------------
  // Sessions
  // -------------------------------------------------------------------------

  /** Loads the workspace's stored sessions once, recovering any a restart cut off. */
  private ensureLoaded(): void {
    if (this.loaded) {
      return;
    }
    this.loaded = true;
    for (const id of this.store.listIds()) {
      const record = this.store.read(id);
      if (!record) {
        continue;
      }
      try {
        this.sessions.set(id, AgentSession.load(this.sessionDeps(record.agent.kind), record));
      } catch (e) {
        console.error(`[agent] could not load session ${id}:`, e);
      }
    }
  }

  list(): SessionSummary[] {
    this.ensureLoaded();
    return [...this.sessions.values()]
      .map((s) => s.summary())
      .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0));
  }

  get(id: string): AgentSession | null {
    this.ensureLoaded();
    return this.sessions.get(id) ?? null;
  }

  create(kind: AgentKind): AgentSession {
    this.ensureLoaded();
    if (!this.backends[kind]) {
      throw new UnsupportedAgentError(kind);
    }
    const session = AgentSession.create(this.sessionDeps(kind), kind);
    this.sessions.set(session.id, session);
    return session;
  }

  async delete(id: string): Promise<boolean> {
    this.ensureLoaded();
    const session = this.sessions.get(id);
    if (!session) {
      return false;
    }
    this.sessions.delete(id);
    await session.dispose();
    this.store.delete(id);
    return true;
  }

  /** Ends every session's CLI (engine shutdown, tests). */
  async shutdown(): Promise<void> {
    liveRuntimes.delete(this);
    await Promise.all(
      [...this.logins.values()].filter((r) => r.status.state === 'pending').map((r) => r.login.cancel().catch(() => {})),
    );
    await Promise.all([...this.sessions.values()].map((s) => s.dispose()));
    this.sessions.clear();
    await Promise.all(Object.values(this.backends).map((b) => b?.dispose?.().catch((e) => console.error('[agent] closing a backend failed:', e))));
  }

  private sessionDeps(kind: AgentKind): SessionDeps {
    const backend = this.backends[kind];
    if (!backend) {
      throw new UnsupportedAgentError(kind);
    }
    return {
      store: this.store,
      epoch: this.epoch,
      workspacePath: this.deps.workspacePath,
      port: this.deps.port,
      backend,
      endpoints: this.endpoints,
      indexes: this.indexes,
      ...(this.idleMs !== undefined ? { idleMs: this.idleMs } : {}),
      ...(this.gateOptions ? { gate: this.gateOptions } : {}),
      pinnedWorkspace: () => ({
        workspacePath: this.deps.workspacePath,
        port: this.deps.port,
        pid: process.pid,
        version: this.deps.version,
        startedAt: this.deps.startedAt,
      }),
      prepareTurn: () => this.prepareTurn(kind),
      workspaceState: () => ({
        file: this.deps.currentFile(),
        render: this.deps.renderState().state,
        unit: this.deps.unit(),
      }),
      instructions: () => {
        let text = this.instructionsText.get(kind);
        if (text === undefined) {
          text = composeInstructions(kind);
          this.instructionsText.set(kind, text);
        }
        return text;
      },
    };
  }

  private async prepareTurn(kind: AgentKind): Promise<TurnSetup> {
    const prefs = await this.deps.loadPreferences();
    let install = await this.install(kind, prefs, false);
    if (!install.supported || install.loggedIn === false) {
      // The user may have installed or signed in since: look again before refusing.
      install = await this.install(kind, prefs, true);
    }
    const model = kind === 'claude' ? prefs.agent?.claudeModel : prefs.agent?.codexModel;
    const effort = defaultEffort(kind, prefs);
    return {
      install,
      env: this.childEnv(kind, prefs, install),
      ...(model ? { defaultModel: model } : {}),
      ...(effort ? { defaultEffort: effort } : {}),
    };
  }
}

/**
 * The effort a turn of `kind` runs with when the message names none: the
 * agent's own preference, else the older shared `effort` (low, medium or
 * high, which both agents take).
 */
export function defaultEffort(kind: AgentKind, prefs: Preferences): string | undefined {
  const own = kind === 'claude' ? prefs.agent?.claudeEffort : prefs.agent?.codexEffort;
  if (isEffortFor(kind, own)) {
    return own;
  }
  return isEffortFor(kind, prefs.agent?.effort) ? prefs.agent!.effort : undefined;
}

export class UnsupportedAgentError extends Error {
  constructor(kind: string) {
    super(kind in AGENT_NAMES ? `${AGENT_NAMES[kind as AgentKind]} is not available in this version of FluidCAD.` : `Unknown agent: ${kind}`);
  }
}
