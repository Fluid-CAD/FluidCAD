import type { ChatClient, ChatStream } from './chat-client';
import { reduceChat } from './chat-reducer';
import {
  isBusy,
  type AgentInstall,
  type AgentKind,
  type AgentModel,
  type ChatEvent,
  type ChatEventEnvelope,
  type ChatMessage,
  type SendMessage,
  type SessionSnapshot,
  type SessionStatus,
  type SessionSummary,
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
  /** The session list (the menu). */
  | { kind: 'sessions' }
  /** The current session was replaced: another one, a fresh snapshot, or a new chat. Repaint everything. */
  | { kind: 'session' }
  /** One event was folded into the current session; `previous` is the transcript before it. */
  | { kind: 'event'; event: ChatEvent; previous: readonly ChatMessage[] }
  /** Sending, the last action's error, the connection. */
  | { kind: 'activity' };

/** Where an agent stands for the panel's empty states (§9.1). */
export type AgentReadiness =
  | { state: 'loading' }
  /** The agent list could not be read. */
  | { state: 'unavailable'; error: string }
  | { state: 'not-found'; install: AgentInstall }
  | { state: 'too-old'; install: AgentInstall }
  | { state: 'signed-out'; install: AgentInstall }
  | { state: 'ready'; install: AgentInstall };

/** What a send carries besides the text. */
export type SendOptions = Omit<SendMessage, 'text'>;

/** How long after a refused stream the session is read again. */
const RETRY_MS = 2000;

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
    return this.attach(id);
  }

  /** An empty chat; the session is created by the first Send. */
  newChat(): void {
    this.detach();
    this.session = null;
    this.error = null;
    this.emit({ kind: 'session' });
  }

  /**
   * Send `text` in the session on screen (creating it for a new chat).
   * Resolves true once the engine took it; its turn then arrives as events.
   */
  async send(text: string, options: SendOptions = {}): Promise<boolean> {
    if (this.busy || text.trim() === '') {
      return false;
    }
    this.sending = true;
    this.error = null;
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

  /** Resume after an engine restart cut the last turn off (`interrupted`). */
  async continueTurn(): Promise<void> {
    const id = this.session?.id;
    if (!id || this.status.state !== 'interrupted') {
      return;
    }
    this.error = null;
    const answer = await this.client.continueTurn(id);
    if (answer.ok === false) {
      this.error = answer.error;
      this.emit({ kind: 'activity' });
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
