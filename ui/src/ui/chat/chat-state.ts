import type { ChatClient, ChatStream } from './chat-client';
import { reduceChat, reduceTurns } from './chat-reducer';
import {
  isBusy,
  type AgentInstall,
  type AgentKind,
  type AgentModel,
  type ApprovalDecision,
  type ChatEvent,
  type ChatEventEnvelope,
  type ChatMessage,
  type PermissionMode,
  type RevertResult,
  type SendMessage,
  type SessionSnapshot,
  type SessionStatus,
  type SessionSummary,
  type TurnRecord,
} from './chat-types';

/** The timer functions the state retries with (tests pass fake ones). */
export type ChatTimers = {
  set(callback: () => void, ms: number): unknown;
  clear(handle: unknown): void;
};

/** What changed, so a view can repaint only that. */
export type ChatChange =
  /** Detection or the model lists. */
  | { kind: 'agents' }
  /** The session list (the menu), or the title on screen after a rename. */
  | { kind: 'sessions' }
  /** The current session was replaced: another one, a fresh snapshot, or a new chat. Repaint everything. */
  | { kind: 'session' }
  /** One event was folded into the current session; `previous` is the transcript before it. */
  | { kind: 'event'; event: ChatEvent; previous: readonly ChatMessage[] }
  /** Sending, the last action's error, the connection. */
  | { kind: 'activity' }
  /** A revert started or finished (its outcome). */
  | { kind: 'revert' };

/** Where an agent stands for the panel's empty states (§9.1). */
export type AgentReadiness =
  | { state: 'loading' }
  /** The agent list could not be read. */
  | { state: 'unavailable'; error: string }
  | { state: 'not-found'; install: AgentInstall }
  | { state: 'too-old'; install: AgentInstall }
  | { state: 'signed-out'; install: AgentInstall }
  | { state: 'ready'; install: AgentInstall };

/**
 * Signing in from the app (Codex): `starting` until the engine answers
 * with the page, `waiting` while the user signs in in the browser, `failed`
 * with why. Gone once it succeeded (detection then says signed in).
 */
export type SignIn = { kind: AgentKind; state: 'starting' | 'waiting' | 'failed'; loginId?: string; url?: string; error?: string };

/** The last revert's outcome, shown under the turn it was asked on. */
export type RevertOutcome =
  | { turnId: string; result: RevertResult }
  | { turnId: string; error: string };

/** What reverting a turn takes back with it (§12.2): the turn and every later revertible one, and their files. */
export type RevertScope = { turns: TurnRecord[]; files: string[] };

/** What a send carries besides the text. */
export type SendOptions = Omit<SendMessage, 'text'>;

/** How long after a refused stream the session is read again. */
const RETRY_MS = 2000;
/** How often a sign-in in the browser is asked about. */
export const SIGN_IN_POLL_MS = 2000;

/**
 * The chat panel's store (docs/agent-chat-plan.md §10.3): what detection
 * found, the session list, and the session on screen with its live status.
 *
 * **Attach protocol (§7.3).** Opening a session fetches its snapshot, then
 * attaches to `events?after=<snapshot.seq>&epoch=<snapshot.epoch>`. Each
 * event is folded through {@link reduceChat}; an event already folded
 * (`seq` not above the snapshot's) is skipped. `resync`, or an envelope from
 * another engine process (its `epoch`), refetches the snapshot and attaches
 * again. A stream the server refuses outright (the session was deleted, the
 * engine went away) is retried after {@link RETRY_MS}; a dropped connection
 * is the browser's to resume, with `Last-Event-ID`.
 *
 * A new chat holds no session until its first message: Send creates one.
 */
export class ChatState {
  agents: AgentInstall[] | null = null;
  agentsError: string | null = null;
  readonly models = new Map<AgentKind, AgentModel[]>();
  sessions: SessionSummary[] = [];
  /** The session on screen; null for a new chat. */
  session: SessionSnapshot | null = null;
  /** The agent a new chat will start with. */
  draftAgent: AgentKind = 'claude';
  /** Between Send and the engine taking the message. */
  sending = false;
  /** The last action's failure, shown above the composer until the next action. */
  error: string | null = null;
  /** Whether the event stream is attached (false while reconnecting after a refusal). */
  connected = false;
  /** The turn a revert is running for. */
  reverting: string | null = null;
  /** The last revert's outcome, until the next send or another chat. */
  revertOutcome: RevertOutcome | null = null;
  /** A sign-in from the app in progress, or the last one that failed. */
  signIn: SignIn | null = null;
  private signInPoll: unknown = null;

  private stream: ChatStream | null = null;
  /** Bumped on every attach, so a late snapshot or a stale stream's events are dropped. */
  private attachToken = 0;
  private retry: unknown = null;
  private disposed = false;
  private readonly listeners = new Set<(change: ChatChange) => void>();

  constructor(
    private readonly client: ChatClient,
    private readonly timers: ChatTimers = {
      set: (callback, ms) => setTimeout(callback, ms),
      clear: (handle) => clearTimeout(handle as number),
    },
  ) {}

  subscribe(listener: (change: ChatChange) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** The status of the session on screen; a new chat is idle. */
  get status(): SessionStatus {
    return this.session?.status ?? { state: 'idle' };
  }

  get busy(): boolean {
    return this.sending || isBusy(this.status);
  }

  /** The agent of the session on screen, or the one a new chat starts with. */
  get agent(): AgentKind {
    return this.session?.agent ?? this.draftAgent;
  }

  /** The agents FluidCAD can drive (detected or not): those with a driver. */
  get offeredAgents(): AgentInstall[] {
    return (this.agents ?? []).filter((a) => a.minVersion !== '');
  }

  install(kind: AgentKind = this.agent): AgentInstall | null {
    return this.agents?.find((a) => a.kind === kind) ?? null;
  }

  readiness(kind: AgentKind = this.agent): AgentReadiness {
    if (this.agentsError && !this.agents) {
      return { state: 'unavailable', error: this.agentsError };
    }
    const install = this.install(kind);
    if (!this.agents) {
      return { state: 'loading' };
    }
    if (!install) {
      return { state: 'unavailable', error: `FluidCAD does not know the agent "${kind}".` };
    }
    return ChatState.readinessOf(install);
  }

  static readinessOf(install: AgentInstall): AgentReadiness {
    if (install.supported) {
      return install.loggedIn === false ? { state: 'signed-out', install } : { state: 'ready', install };
    }
    if (install.version) {
      return { state: 'too-old', install };
    }
    return { state: 'not-found', install };
  }

  // ---------------------------------------------------------------------------
  // Agents
  // ---------------------------------------------------------------------------

  /** Read detection (`fresh`: run it again, "Check again"). */
  async loadAgents(fresh = false): Promise<void> {
    const answer = await this.client.agents(fresh);
    if (this.disposed) {
      return;
    }
    if (answer.ok === false) {
      this.agentsError = answer.error;
    } else {
      this.agents = answer.value;
      this.agentsError = null;
    }
    this.emit({ kind: 'agents' });
  }

  /** The models to offer for `kind`, read once. */
  async loadModels(kind: AgentKind): Promise<AgentModel[]> {
    const known = this.models.get(kind);
    if (known) {
      return known;
    }
    const answer = await this.client.models(kind);
    if (answer.ok === false) {
      return [];
    }
    this.models.set(kind, answer.value);
    this.emit({ kind: 'agents' });
    return answer.value;
  }

  /**
   * Start signing in to `kind` in the browser (§5.2). Resolves to the page
   * to open, or null (the reason is in {@link signIn}); then asks how it
   * goes every {@link SIGN_IN_POLL_MS} until it ends, and detects again
   * once it succeeded.
   */
  async startSignIn(kind: AgentKind): Promise<string | null> {
    if (this.signIn && this.signIn.kind === kind && this.signIn.state !== 'failed') {
      return this.signIn.url ?? null;
    }
    this.stopSignInPoll();
    this.signIn = { kind, state: 'starting' };
    this.emit({ kind: 'agents' });
    const answer = await this.client.startLogin(kind);
    if (this.disposed || this.signIn?.kind !== kind) {
      return null;
    }
    if (answer.ok === false) {
      if (answer.status === 409) {
        // Signed in meanwhile (or uninstalled): detection says which.
        this.signIn = null;
        await this.loadAgents(true);
        return null;
      }
      this.signIn = { kind, state: 'failed', error: answer.error };
      this.emit({ kind: 'agents' });
      return null;
    }
    this.signIn = { kind, state: 'waiting', loginId: answer.value.loginId, url: answer.value.url };
    this.emit({ kind: 'agents' });
    this.scheduleSignInPoll();
    return answer.value.url;
  }

  /** Stop waiting for the sign-in in the browser. */
  async cancelSignIn(): Promise<void> {
    const signIn = this.signIn;
    this.stopSignInPoll();
    this.signIn = null;
    this.emit({ kind: 'agents' });
    if (signIn?.loginId && signIn.state === 'waiting') {
      await this.client.cancelLogin(signIn.kind, signIn.loginId);
    }
  }

  private scheduleSignInPoll(): void {
    this.signInPoll = this.timers.set(() => {
      this.signInPoll = null;
      void this.pollSignIn();
    }, SIGN_IN_POLL_MS);
  }

  private stopSignInPoll(): void {
    if (this.signInPoll !== null) {
      this.timers.clear(this.signInPoll);
      this.signInPoll = null;
    }
  }

  private async pollSignIn(): Promise<void> {
    const signIn = this.signIn;
    if (this.disposed || !signIn || signIn.state !== 'waiting' || !signIn.loginId) {
      return;
    }
    const answer = await this.client.loginStatus(signIn.kind, signIn.loginId);
    if (this.disposed || this.signIn !== signIn) {
      return;
    }
    if (answer.ok === false) {
      if (answer.status === 404) {
        this.signIn = { ...signIn, state: 'failed', error: 'FluidCAD lost track of the sign-in (it restarted). Sign in again.' };
        this.emit({ kind: 'agents' });
      } else {
        // The engine did not answer this time: ask again.
        this.scheduleSignInPoll();
      }
      return;
    }
    switch (answer.value.state) {
      case 'pending':
        this.scheduleSignInPoll();
        return;
      case 'done':
        this.signIn = null;
        await this.loadAgents(true);
        return;
      case 'failed':
        this.signIn = { ...signIn, state: 'failed', error: answer.value.error ?? 'Signing in did not finish.' };
        this.emit({ kind: 'agents' });
        return;
    }
  }

  setDraftAgent(kind: AgentKind): void {
    if (this.draftAgent !== kind) {
      this.draftAgent = kind;
      if (!this.session) {
        this.emit({ kind: 'session' });
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Sessions
  // ---------------------------------------------------------------------------

  async loadSessions(): Promise<void> {
    const answer = await this.client.sessions();
    if (this.disposed || answer.ok === false) {
      return;
    }
    this.sessions = answer.value;
    this.emit({ kind: 'sessions' });
  }

  /** Show a session: its snapshot, then its live events. */
  async openSession(id: string): Promise<boolean> {
    this.error = null;
    if (this.session?.id !== id) {
      this.revertOutcome = null;
    }
    return this.attach(id);
  }

  /** An empty chat; the session is created by the first Send. */
  newChat(): void {
    this.detach();
    this.session = null;
    this.error = null;
    this.revertOutcome = null;
    this.emit({ kind: 'session' });
  }

  /**
   * Send `text` in the session on screen (creating it for a new chat).
   * Resolves true once the engine took it; its turn then arrives as events.
   */
  async send(text: string, options: SendOptions = {}): Promise<boolean> {
    if (this.busy || this.reverting || text.trim() === '') {
      return false;
    }
    this.sending = true;
    this.error = null;
    if (this.revertOutcome) {
      this.revertOutcome = null;
      this.emit({ kind: 'revert' });
    }
    this.emit({ kind: 'activity' });
    try {
      let id = this.session?.id;
      if (!id) {
        const created = await this.client.createSession(this.draftAgent);
        if (created.ok === false) {
          this.error = created.error;
          return false;
        }
        id = created.value.id;
        if (!(await this.attach(id))) {
          this.error = this.error ?? 'The new chat could not be opened.';
          return false;
        }
        void this.loadSessions();
      }
      const answer = await this.client.send(id, { text, ...options });
      if (answer.ok === false) {
        this.error = answer.error;
        return false;
      }
      return true;
    } finally {
      this.sending = false;
      this.emit({ kind: 'activity' });
    }
  }

  /**
   * Rename chat `id` (`PATCH …/sessions/:id`). Resolves to an error to show,
   * or null once renamed; the menu's row and the title on screen follow at
   * once (the `title` event the engine sends confirms it).
   */
  async renameSession(id: string, title: string): Promise<string | null> {
    const trimmed = title.trim();
    if (trimmed === '') {
      return 'A chat needs a title.';
    }
    const answer = await this.client.rename(id, trimmed);
    if (this.disposed) {
      return null;
    }
    if (answer.ok === false) {
      return answer.error;
    }
    const row = this.sessions.find((s) => s.id === id);
    if (row) {
      row.title = trimmed;
    }
    if (this.session?.id === id) {
      this.session.title = trimmed;
    }
    this.emit({ kind: 'sessions' });
    // The engine shortens long titles: read back what it kept.
    void this.loadSessions();
    return null;
  }

  /**
   * Delete chat `id` (`DELETE …/sessions/:id`): its conversation and files
   * go; a turn it was running stops. Deleting the chat on screen opens a new
   * chat. Resolves to an error to show, or null.
   */
  async deleteSession(id: string): Promise<string | null> {
    const answer = await this.client.remove(id);
    if (this.disposed) {
      return null;
    }
    if (answer.ok === false && answer.status !== 404) {
      this.error = answer.error;
      this.emit({ kind: 'activity' });
      return answer.error;
    }
    this.sessions = this.sessions.filter((s) => s.id !== id);
    if (this.session?.id === id) {
      this.newChat();
    }
    this.emit({ kind: 'sessions' });
    return null;
  }

  /** Stop the running turn; the partial answer stays. */
  async stop(): Promise<void> {
    const id = this.session?.id;
    if (!id || !isBusy(this.status)) {
      return;
    }
    const answer = await this.client.cancel(id);
    if (answer.ok === false) {
      this.error = answer.error;
      this.emit({ kind: 'activity' });
    }
  }

  /** Resume after an engine restart cut the last turn off (`interrupted`), in permission `mode`. */
  async continueTurn(mode?: PermissionMode): Promise<void> {
    const id = this.session?.id;
    if (!id || this.status.state !== 'interrupted') {
      return;
    }
    this.error = null;
    const answer = await this.client.continueTurn(id, mode);
    if (answer.ok === false) {
      this.error = answer.error;
      this.emit({ kind: 'activity' });
    }
  }

  /**
   * Answer a tool call waiting for approval. Resolves true once the engine
   * took it; the card then changes through the event that follows. A call
   * already settled elsewhere (another tab, a stop) is not an error: its
   * event says how it ended.
   */
  async decideApproval(approvalId: string, decision: ApprovalDecision): Promise<boolean> {
    const id = this.session?.id;
    if (!id) {
      return false;
    }
    const answer = await this.client.decideApproval(id, approvalId, decision);
    if (answer.ok === false) {
      if (answer.status !== 409) {
        this.error = answer.error;
        this.emit({ kind: 'activity' });
      }
      return false;
    }
    return true;
  }

  /** The turn record of `turnId` in the session on screen. */
  turn(turnId: string): TurnRecord | undefined {
    return this.session?.turns.find((t) => t.id === turnId);
  }

  /** Whether "Revert this turn" can run now: the turn has changes, and nothing runs. */
  canRevert(turnId: string): boolean {
    return !!this.turn(turnId)?.revertible && !this.busy && this.reverting === null;
  }

  /** What reverting `turnId` puts back: it and every later revertible turn, and their files in order. */
  revertScope(turnId: string): RevertScope {
    const turns = this.session?.turns ?? [];
    const index = turns.findIndex((t) => t.id === turnId);
    if (index < 0) {
      return { turns: [], files: [] };
    }
    const scope = turns.slice(index).filter((t) => t.revertible);
    const files: string[] = [];
    for (const turn of scope) {
      for (const file of turn.files ?? []) {
        if (!files.includes(file)) {
          files.push(file);
        }
      }
    }
    return { turns: scope, files };
  }

  /**
   * Revert `turnId` and every later turn that changed files (§12.2). The
   * turns' records follow from the `reverted` events; the answer (what was
   * put back, what could not be and why) is kept as {@link revertOutcome}.
   */
  async revert(turnId: string): Promise<RevertOutcome | null> {
    const id = this.session?.id;
    if (!id || !this.canRevert(turnId)) {
      return null;
    }
    this.reverting = turnId;
    this.revertOutcome = null;
    this.error = null;
    this.emit({ kind: 'revert' });
    let outcome: RevertOutcome;
    try {
      const answer = await this.client.revert(id, turnId);
      outcome = answer.ok === false ? { turnId, error: answer.error } : { turnId, result: answer.value };
    } finally {
      this.reverting = null;
    }
    if (this.session?.id === id) {
      this.revertOutcome = outcome;
    }
    this.emit({ kind: 'revert' });
    return outcome;
  }

  /** Drop the last revert's outcome (the user dismissed it). */
  clearRevertOutcome(): void {
    if (this.revertOutcome) {
      this.revertOutcome = null;
      this.emit({ kind: 'revert' });
    }
  }

  /** Drop the last action's error (the user dismissed it). */
  clearError(): void {
    if (this.error) {
      this.error = null;
      this.emit({ kind: 'activity' });
    }
  }

  dispose(): void {
    this.disposed = true;
    this.stopSignInPoll();
    this.detach();
    this.listeners.clear();
  }

  // ---------------------------------------------------------------------------
  // The attach protocol
  // ---------------------------------------------------------------------------

  private async attach(id: string): Promise<boolean> {
    this.detach();
    const token = ++this.attachToken;
    const answer = await this.client.snapshot(id);
    if (this.disposed || token !== this.attachToken) {
      return false;
    }
    if (answer.ok === false) {
      if (answer.status === 404) {
        // Deleted (here or in another tab): back to a new chat.
        if (this.session?.id === id) {
          this.session = null;
          this.emit({ kind: 'session' });
        }
        this.sessions = this.sessions.filter((s) => s.id !== id);
        this.emit({ kind: 'sessions' });
      } else {
        this.error = answer.error;
        this.scheduleRetry(id, token);
        this.emit({ kind: 'activity' });
      }
      return false;
    }
    const snapshot = answer.value;
    this.session = snapshot;
    this.emit({ kind: 'session' });
    this.stream = this.client.subscribe(id, { after: snapshot.seq, epoch: snapshot.epoch }, {
      onEnvelope: (envelope) => this.receive(token, envelope),
      onClosed: () => {
        if (token === this.attachToken) {
          this.setConnected(false);
          this.scheduleRetry(id, token);
        }
      },
    });
    this.setConnected(true);
    return true;
  }

  private detach(): void {
    this.attachToken++;
    this.stream?.close();
    this.stream = null;
    if (this.retry !== null) {
      this.timers.clear(this.retry);
      this.retry = null;
    }
    this.connected = false;
  }

  private scheduleRetry(id: string, token: number): void {
    if (this.retry !== null) {
      this.timers.clear(this.retry);
    }
    this.retry = this.timers.set(() => {
      this.retry = null;
      if (!this.disposed && token === this.attachToken) {
        void this.attach(id);
      }
    }, RETRY_MS);
  }

  private receive(token: number, envelope: ChatEventEnvelope): void {
    const session = this.session;
    if (token !== this.attachToken || !session) {
      return;
    }
    if (envelope.event.type === 'resync' || envelope.epoch !== session.epoch) {
      void this.attach(session.id);
      return;
    }
    if (envelope.seq <= session.seq) {
      return;
    }
    if (!this.connected) {
      this.setConnected(true);
    }
    const event = envelope.event;
    const previous = session.messages;
    session.seq = envelope.seq;
    session.messages = reduceChat(previous, event);
    session.turns = reduceTurns(session.turns, event);
    if (event.type === 'status') {
      session.status = event.status;
      if (this.error && isBusy(event.status)) {
        this.error = null;
      }
    } else if (event.type === 'title') {
      session.title = event.title;
    }
    if (event.type === 'status' || event.type === 'title') {
      this.patchSummary(session);
    }
    this.emit({ kind: 'event', event, previous });
  }

  /** The menu's row for the session on screen follows its title and status. */
  private patchSummary(session: SessionSnapshot): void {
    const row = this.sessions.find((s) => s.id === session.id);
    if (row) {
      row.title = session.title;
      row.status = session.status;
      row.updatedAt = new Date().toISOString();
      this.emit({ kind: 'sessions' });
    }
  }

  private setConnected(connected: boolean): void {
    if (this.connected !== connected) {
      this.connected = connected;
      this.emit({ kind: 'activity' });
    }
  }

  private emit(change: ChatChange): void {
    for (const listener of [...this.listeners]) {
      listener(change);
    }
  }
}
