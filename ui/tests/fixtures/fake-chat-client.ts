import { vi } from 'vitest';
import type { ChatAnswer, ChatClient, ChatStream, ChatStreamHandlers } from '../../src/ui/chat/chat-client';
import { reduceChat, reduceTurns } from '../../src/ui/chat/chat-reducer';
import type {
  AgentInstall,
  AgentKind,
  AgentModel,
  ApprovalDecision,
  ChatEvent,
  ChatPart,
  PermissionMode,
  RevertResult,
  SendMessage,
  SessionSnapshot,
  SessionStatus,
  SessionSummary,
} from '../../src/ui/chat/chat-types';

type Subscription = {
  id: string;
  from: { after: number; epoch: string };
  handlers: ChatStreamHandlers;
  closed: boolean;
};

/**
 * A {@link ChatClient} for the Agent panel's tests: an engine in memory.
 * Sessions are snapshots it folds its own events into (through the page's
 * reducer, as the engine folds through its twin), so a snapshot fetched at
 * any moment is what the stream has said so far. {@link emit} plays the
 * engine's side of a turn; `send` and `cancel` answer the way the runtime
 * does (the user message and `starting`/`running`; a notice, the end of the
 * message and `idle`). Each route is a `vi.fn` the tests assert on.
 */
export class FakeChatClient implements ChatClient {
  agentsValue: AgentInstall[] = [FakeChatClient.install()];
  /** What the next `agents(true)` (Check again) answers; null: the same as before. */
  recheckValue: AgentInstall[] | null = null;
  modelsValue: AgentModel[] = [
    { id: 'default', label: 'Default' },
    { id: 'opus', label: 'Opus' },
    { id: 'sonnet', label: 'Sonnet' },
    { id: 'haiku', label: 'Haiku' },
    { id: 'fable', label: 'Fable' },
  ];
  epoch = 'epoch-1';
  readonly snapshots = new Map<string, SessionSnapshot>();
  readonly subscriptions: Subscription[] = [];
  readonly sent: { id: string; message: SendMessage }[] = [];
  /**
   * What the next `revert` answers; null: every revertible turn from the one
   * asked on is put back (`reverted` events newest first, as the runtime).
   */
  revertAnswer: ChatAnswer<RevertResult> | null = null;
  /** What `decideApproval` answers (before the engine settles the card); null: 204 and the card settles. */
  decideAnswer: ChatAnswer<null> | null = null;
  private nextId = 1;

  static install(overrides: Partial<AgentInstall> = {}): AgentInstall {
    return {
      kind: 'claude',
      path: '/home/u/.local/bin/claude',
      version: '2.1.326',
      minVersion: '2.1.259',
      supported: true,
      loggedIn: true,
      authMethod: 'claude.ai',
      ...overrides,
    };
  }

  /** Codex as this version of the engine reports it: no driver. */
  static codexUnsupported(): AgentInstall {
    return {
      kind: 'codex',
      path: null,
      version: null,
      minVersion: '',
      supported: false,
      loggedIn: null,
      authMethod: null,
      problem: 'Codex is not supported by this version of FluidCAD yet.',
    };
  }

  /** A stored session (as if from an earlier visit). */
  addSession(overrides: Partial<SessionSnapshot> = {}): SessionSnapshot {
    const id = overrides.id ?? `session-${this.nextId++}`;
    const snapshot: SessionSnapshot = {
      id,
      title: 'New chat',
      agent: 'claude',
      createdAt: '2026-11-17T10:00:00.000Z',
      updatedAt: '2026-11-17T10:00:00.000Z',
      epoch: this.epoch,
      seq: 0,
      status: { state: 'idle' },
      messages: [],
      turns: [],
      model: null,
      ...overrides,
    };
    this.snapshots.set(id, snapshot);
    return snapshot;
  }

  /** The engine emits `event` in session `id`: folded into its snapshot, sent to every open stream. */
  emit(id: string, event: ChatEvent, options: { epoch?: string } = {}): void {
    const snapshot = this.snapshots.get(id)!;
    snapshot.seq += 1;
    snapshot.messages = reduceChat(snapshot.messages, event);
    snapshot.turns = reduceTurns(snapshot.turns, event, () => '2026-11-17T10:10:00.000Z');
    if (event.type === 'status') {
      snapshot.status = event.status;
    } else if (event.type === 'title') {
      snapshot.title = event.title;
    }
    const envelope = { epoch: options.epoch ?? snapshot.epoch, seq: snapshot.seq, event };
    for (const sub of this.subscriptions) {
      if (!sub.closed && sub.id === id) {
        sub.handlers.onEnvelope(structuredClone(envelope));
      }
    }
  }

  /** Send `resync` on the open streams of `id` (no seq: not folded). */
  resync(id: string): void {
    const snapshot = this.snapshots.get(id);
    for (const sub of this.subscriptions) {
      if (!sub.closed && sub.id === id) {
        sub.handlers.onEnvelope({ epoch: snapshot?.epoch ?? this.epoch, seq: snapshot?.seq ?? 0, event: { type: 'resync' } });
      }
    }
  }

  /** The server refused `id`'s open streams (the session was deleted, the engine went away). */
  refuseStreams(id: string): void {
    for (const sub of this.subscriptions) {
      if (!sub.closed && sub.id === id) {
        sub.closed = true;
        sub.handlers.onClosed();
      }
    }
  }

  openStreams(id?: string): Subscription[] {
    return this.subscriptions.filter((s) => !s.closed && (id === undefined || s.id === id));
  }

  /** Start an assistant message in the turn that is running; returns its id. */
  startAssistant(id: string, messageId = 'assistant-1'): string {
    const snapshot = this.snapshots.get(id)!;
    const status = snapshot.status as SessionStatus & { turnId?: string };
    this.emit(id, { type: 'message-start', message: { id: messageId, role: 'assistant', turnId: status.turnId ?? 'turn', createdAt: '2026-11-17T10:00:05.000Z' } });
    return messageId;
  }

  part(id: string, messageId: string, part: ChatPart): void {
    this.emit(id, { type: 'part-start', messageId, part });
  }

  delta(id: string, messageId: string, partId: string, text: string): void {
    this.emit(id, { type: 'part-delta', messageId, partId, text });
  }

  /** End the turn: the message ends, the session goes idle. */
  finish(id: string, messageId: string): void {
    this.emit(id, { type: 'message-end', messageId });
    this.emit(id, { type: 'status', status: { state: 'idle' } });
  }

  // --- ChatClient ------------------------------------------------------------

  agents = vi.fn(async (fresh = false): Promise<ChatAnswer<AgentInstall[]>> => {
    if (fresh && this.recheckValue) {
      this.agentsValue = this.recheckValue;
      this.recheckValue = null;
    }
    return { ok: true, value: structuredClone(this.agentsValue) };
  });

  models = vi.fn(async (_kind: AgentKind): Promise<ChatAnswer<AgentModel[]>> => ({ ok: true, value: structuredClone(this.modelsValue) }));

  sessions = vi.fn(async (): Promise<ChatAnswer<SessionSummary[]>> => {
    const rows = [...this.snapshots.values()]
      .map((s) => ({ id: s.id, title: s.title, agent: s.agent, updatedAt: s.updatedAt, status: s.status }))
      .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
    return { ok: true, value: structuredClone(rows) };
  });

  createSession = vi.fn(async (agent: AgentKind): Promise<ChatAnswer<{ id: string }>> => {
    const snapshot = this.addSession({ agent, updatedAt: new Date().toISOString() });
    return { ok: true, value: { id: snapshot.id } };
  });

  snapshot = vi.fn(async (id: string): Promise<ChatAnswer<SessionSnapshot>> => {
    const snapshot = this.snapshots.get(id);
    if (!snapshot) {
      return { ok: false, status: 404, error: 'No such session.' };
    }
    return { ok: true, value: structuredClone(snapshot) };
  });

  send = vi.fn(async (id: string, message: SendMessage): Promise<ChatAnswer<{ turnId: string }>> => {
    const snapshot = this.snapshots.get(id);
    if (!snapshot) {
      return { ok: false, status: 404, error: 'No such session.' };
    }
    if (snapshot.status.state === 'running' || snapshot.status.state === 'starting') {
      return { ok: false, status: 409, error: 'A turn is already running in this session.' };
    }
    this.sent.push({ id, message: structuredClone(message) });
    const turnId = `turn-${this.sent.length}`;
    const userId = `user-${this.sent.length}`;
    this.emit(id, { type: 'message-start', message: { id: userId, role: 'user', turnId, createdAt: '2026-11-17T10:00:04.000Z' } });
    this.emit(id, { type: 'part-start', messageId: userId, part: { type: 'text', id: `${userId}-text`, text: message.text } });
    this.emit(id, { type: 'message-end', messageId: userId });
    if (snapshot.title === 'New chat') {
      this.emit(id, { type: 'title', title: message.text.split('\n')[0] });
    }
    this.emit(id, { type: 'status', status: { state: 'starting', turnId } });
    this.emit(id, { type: 'status', status: { state: 'running', turnId } });
    return { ok: true, value: { turnId } };
  });

  cancel = vi.fn(async (id: string): Promise<ChatAnswer<null>> => {
    const snapshot = this.snapshots.get(id)!;
    const last = snapshot.messages[snapshot.messages.length - 1];
    if (last?.role === 'assistant') {
      this.emit(id, { type: 'part-start', messageId: last.id, part: { type: 'notice', id: `notice-${snapshot.seq}`, level: 'info', text: 'Stopped.' } });
      this.emit(id, { type: 'message-end', messageId: last.id });
    }
    this.emit(id, { type: 'status', status: { state: 'idle' } });
    return { ok: true, value: null };
  });

  continueTurn = vi.fn(async (id: string, mode?: PermissionMode): Promise<ChatAnswer<{ turnId: string }>> =>
    this.send(id, { text: 'Continue.', ...(mode ? { mode } : {}) }));

  /**
   * Answers like the runtime: the waiting card settles (`running` with the
   * decision, or `denied`), the status goes back to `running`.
   */
  decideApproval = vi.fn(async (id: string, approvalId: string, decision: ApprovalDecision): Promise<ChatAnswer<null>> => {
    if (this.decideAnswer) {
      return this.decideAnswer;
    }
    const snapshot = this.snapshots.get(id)!;
    for (const message of snapshot.messages) {
      for (const part of message.parts) {
        if (part.type === 'tool' && part.approval?.id === approvalId) {
          if (part.state !== 'awaiting-approval') {
            return { ok: false, status: 409, error: 'This approval was already settled.' };
          }
          const approval = { ...part.approval, decision };
          this.emit(id, {
            type: 'part-update',
            messageId: message.id,
            partId: part.id,
            patch: decision === 'deny' ? { state: 'denied', approval, error: 'Declined.' } : { state: 'running', approval },
          });
          const status = snapshot.status as SessionStatus & { turnId?: string };
          this.emit(id, { type: 'status', status: { state: 'running', turnId: status.turnId ?? 'turn' } });
          return { ok: true, value: null };
        }
      }
    }
    return { ok: false, status: 404, error: 'No such approval.' };
  });

  revert = vi.fn(async (id: string, turnId: string): Promise<ChatAnswer<RevertResult>> => {
    if (this.revertAnswer) {
      return this.revertAnswer;
    }
    const snapshot = this.snapshots.get(id)!;
    const index = snapshot.turns.findIndex((t) => t.id === turnId);
    if (index < 0) {
      return { ok: false, status: 404, error: 'No such turn.' };
    }
    const restored: string[] = [];
    for (const turn of snapshot.turns.slice(index).filter((t) => t.revertible).reverse()) {
      const files = turn.files ?? [];
      this.emit(id, { type: 'reverted', turnId: turn.id, files });
      for (const file of files) {
        if (!restored.includes(file)) {
          restored.push(file);
        }
      }
    }
    return { ok: true, value: { restored } };
  });

  rename = vi.fn(async (id: string, title: string): Promise<ChatAnswer<null>> => {
    this.emit(id, { type: 'title', title });
    return { ok: true, value: null };
  });

  remove = vi.fn(async (id: string): Promise<ChatAnswer<null>> => {
    this.snapshots.delete(id);
    return { ok: true, value: null };
  });

  fileUrl(id: string, name: string): string {
    return `api/agent/sessions/${id}/files/${name}`;
  }

  subscribe = vi.fn((id: string, from: { after: number; epoch: string }, handlers: ChatStreamHandlers): ChatStream => {
    const sub: Subscription = { id, from, handlers, closed: false };
    this.subscriptions.push(sub);
    // What the engine replays after `after` is not modelled: tests emit after attaching.
    return {
      close: () => {
        sub.closed = true;
      },
    };
  });
}
