// One chat session (docs/agent-chat-plan.md §6.3, §7, §12.3).
//
// The session owns at most one CLI run at a time and merges two sources into
// one ordered event log: the backend's events (text, reasoning, the CLI's own
// tools, usage, the end of a turn) and the gate's (FluidCAD tool cards).
// Every event is folded into the transcript as it is emitted, so a snapshot
// is always the transcript a client replaying the log would hold. A turn
// belongs to the session, not to a request: the page attaches to it with any
// number of event streams.

import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { AgentBackend, AgentInstall, AgentRun, BackendEvent, TurnError } from './backend.ts';
import { EventLog } from './event-log.ts';
import { buildCliText, CONTINUE_TEXT, type WorkspaceState } from './instructions.ts';
import { McpEndpoint, type McpEndpoints, type SharedMcpIndexes } from './mcp-endpoint.ts';
import { SessionStore, type Checkpoint, type SessionRecord } from './session-store.ts';
import { relativeTo, ToolGate, type ApprovalSweep, type ToolGateOptions } from './tool-gate.ts';
import { applyChatEvent, findMessage } from './transcript.ts';
import { writeFile, type RegistryEntry } from '../../mcp/dist/server.js';
import type {
  AgentKind,
  ApprovalDecision,
  ChatEvent,
  ChatPart,
  PermissionMode,
  SendMessage,
  SessionSnapshot,
  SessionStatus,
  SessionSummary,
  ToolPart,
  TurnRecord,
} from './types.ts';

/** How long a CLI may sit idle between turns before it is closed (§6.2); the next message resumes it. */
export const DEFAULT_IDLE_MS = 10 * 60 * 1000;
const MAX_TITLE_CHARS = 80;
export const RESTART_REASON = 'The app restarted while this turn was running.';
const RESTART_TOOL_ERROR = 'The app restarted while this was running; its effect is unknown.';

/** What a turn needs resolved before the CLI starts: the install, its environment and the defaults. */
export type TurnSetup = {
  install: AgentInstall;
  env: NodeJS.ProcessEnv;
  defaultModel?: string;
  defaultEffort?: string;
};

export type SessionDeps = {
  store: SessionStore;
  epoch: string;
  workspacePath: string;
  port: number;
  backend: AgentBackend;
  endpoints: McpEndpoints;
  indexes: SharedMcpIndexes;
  pinnedWorkspace(): RegistryEntry;
  prepareTurn(): Promise<TurnSetup>;
  workspaceState(): WorkspaceState;
  instructions(): string;
  idleMs?: number;
  /** Approval timeout and timers (tests). */
  gate?: ToolGateOptions;
};

/** Lint refusals a revert overrides: it puts back the user's own earlier text, whatever the rules say of it. */
const REVERT_FORCE_CODES = new Set(['missing-imports', 'unit-statement', 'part-rules', 'params-file']);

export class SessionBusyError extends Error {
  constructor(message = 'A turn is already running in this session.') {
    super(message);
  }
}

/** A revert the session cannot do: `not-found` (no such turn) or `not-revertible`. */
export class RevertError extends Error {
  readonly kind: 'not-found' | 'not-revertible';
  constructor(kind: 'not-found' | 'not-revertible', message: string) {
    super(message);
    this.kind = kind;
  }
}

export type RevertResult = {
  /** Workspace-relative paths put back (or deleted, for a file a turn created). */
  restored: string[];
  /** Files that could not be put back; the turn that holds them stays revertible. */
  failed?: { path: string; error: string }[];
};

type ActiveTurn = {
  turnId: string;
  mode: PermissionMode;
  assistantMessageId: string | null;
  /** Parts already started in the assistant message, by id. */
  parts: Set<string>;
  /** Cancel or the end of the turn has begun: no tool call may start any more. */
  stopping: boolean;
};

export class AgentSession {
  readonly record: SessionRecord;
  readonly log: EventLog;
  readonly gate: ToolGate;
  private readonly deps: SessionDeps;
  private statusValue: SessionStatus;
  private turn: ActiveTurn | null = null;
  private run: AgentRun | null = null;
  private runKey: { model: string | null; effort: string | null } | null = null;
  private consuming: Promise<void> | null = null;
  private endpoint: McpEndpoint | null = null;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;
  private reverting = false;

  private constructor(deps: SessionDeps, record: SessionRecord) {
    this.deps = deps;
    this.record = record;
    this.log = new EventLog(deps.epoch);
    this.statusValue = record.interrupted ? { state: 'interrupted', reason: record.interrupted.reason } : { state: 'idle' };
    this.gate = new ToolGate(
      {
        workspacePath: deps.workspacePath,
        pinnedWorkspace: () => deps.pinnedWorkspace(),
        activeTurn: () => (this.turn && !this.turn.stopping ? { turnId: this.turn.turnId, mode: this.turn.mode } : null),
        assistantMessageId: () => this.assistantMessageId(),
        emit: (event) => this.emit(event),
        saveImage: (data, mimeType) => this.saveImage(data, mimeType),
        persist: () => this.persist(),
        approvalsChanged: (turnId, ids) => this.approvalsChanged(turnId, ids),
        checkpoint: (turnId, checkpoint) => this.takeCheckpoint(turnId, checkpoint),
        dropCheckpoint: (turnId, filePath) => this.dropCheckpoint(turnId, filePath),
      },
      deps.gate,
    );
  }

  static create(deps: SessionDeps, kind: AgentKind): AgentSession {
    const now = new Date().toISOString();
    const record: SessionRecord = {
      schemaVersion: 1,
      id: randomUUID(),
      title: 'New chat',
      createdAt: now,
      updatedAt: now,
      agent: { kind, ref: null, model: null },
      messages: [],
      turns: [],
    };
    const session = new AgentSession(deps, record);
    session.persist();
    return session;
  }

  /**
   * A stored session, as the engine finds it on load. A last turn with no
   * end was cut off by an engine restart: its unfinished tool parts become
   * errors (their effect is unknown) and the session is `interrupted` until
   * the next turn (§12.3).
   */
  static load(deps: SessionDeps, record: SessionRecord): AgentSession {
    const last = record.turns[record.turns.length - 1];
    if (last && !last.endedAt) {
      for (const message of record.messages) {
        if (message.turnId !== last.id) {
          continue;
        }
        for (const part of message.parts) {
          if (part.type === 'tool' && (part.state === 'running' || part.state === 'awaiting-approval')) {
            part.state = 'error';
            part.error = RESTART_TOOL_ERROR;
          }
        }
      }
      last.endedAt = new Date().toISOString();
      last.endReason = 'interrupted';
      record.interrupted = { reason: RESTART_REASON };
      deps.store.write(record);
    }
    return new AgentSession(deps, record);
  }

  get id(): string {
    return this.record.id;
  }

  get status(): SessionStatus {
    return this.statusValue;
  }

  get hasRun(): boolean {
    return this.run !== null;
  }

  get mcpEndpoint(): McpEndpoint | null {
    return this.endpoint;
  }

  snapshot(): SessionSnapshot {
    return structuredClone({
      id: this.record.id,
      title: this.record.title,
      agent: this.record.agent.kind,
      createdAt: this.record.createdAt,
      updatedAt: this.record.updatedAt,
      epoch: this.log.epoch,
      seq: this.log.lastSeq,
      status: this.statusValue,
      messages: this.record.messages,
      turns: this.record.turns,
      model: this.record.agent.model,
    });
  }

  summary(): SessionSummary {
    return {
      id: this.record.id,
      title: this.record.title,
      agent: this.record.agent.kind,
      updatedAt: this.record.updatedAt,
      status: structuredClone(this.statusValue),
    };
  }

  rename(title: string): void {
    this.record.title = cutTitle(title);
    this.record.titleSetByUser = true;
    this.emit({ type: 'title', title: this.record.title });
    this.persist();
  }

  /**
   * Accepts a user message and starts its turn; the turn runs on after this
   * returns. Throws SessionBusyError while a turn is running.
   */
  send(input: SendMessage): { turnId: string } {
    if (this.disposed) {
      throw new Error('The session was deleted.');
    }
    if (this.turn) {
      throw new SessionBusyError();
    }
    if (this.reverting) {
      throw new SessionBusyError('A revert is running in this session.');
    }
    this.clearIdleTimer();
    const turnId = randomUUID();
    const userMessageId = randomUUID();
    const createdAt = new Date().toISOString();
    this.log.startTurn();
    delete this.record.interrupted;
    this.turn = { turnId, mode: input.mode ?? 'ask', assistantMessageId: null, parts: new Set(), stopping: false };

    this.emit({ type: 'message-start', message: { id: userMessageId, role: 'user', turnId, createdAt } });
    // The words, the reference chips, then the capture they are drawn in.
    const parts: ChatPart[] = [{ type: 'text', id: randomUUID(), text: input.text }];
    if (input.references && input.references.length > 0) {
      parts.push({ type: 'references', id: randomUUID(), references: input.references });
    }
    let imagePath: string | undefined;
    if (input.image) {
      const file = `${randomUUID()}.png`;
      imagePath = this.deps.store.writeFile(this.record.id, file, Buffer.from(input.image.base64, 'base64'));
      parts.push({ type: 'image', id: randomUUID(), file });
    }
    for (const part of parts) {
      this.emit({ type: 'part-start', messageId: userMessageId, part });
    }
    this.emit({ type: 'message-end', messageId: userMessageId });
    this.record.turns.push({ id: turnId, userMessageId, revertible: false });

    if (!this.record.titleSetByUser && this.record.turns.length === 1) {
      const firstLine = input.text.trim().split('\n')[0] ?? '';
      if (firstLine !== '') {
        this.record.title = cutTitle(firstLine);
        this.emit({ type: 'title', title: this.record.title });
      }
    }
    this.setStatus({ state: 'starting', turnId });
    this.persist();

    const revertedFiles = this.record.revertedFiles ?? [];
    const cliText = buildCliText({
      text: input.text,
      references: input.references,
      imageAttached: imagePath !== undefined,
      workspace: this.deps.workspaceState(),
      revertedFiles,
    });
    void this.startTurn(turnId, { cliText, imagePath, model: input.model, effort: input.effort, revertedFiles });
    return { turnId };
  }

  /** Resume after an engine restart cut a turn off (§12.3). */
  continueAfterRestart(mode: PermissionMode = 'ask'): { turnId: string } {
    return this.send({ text: CONTINUE_TEXT, mode });
  }

  /**
   * The user's answer to a tool call waiting for approval (§12.1).
   * `already-decided`: the call is in the transcript but no longer waits.
   */
  decideApproval(approvalId: string, decision: ApprovalDecision): 'ok' | 'not-found' | 'already-decided' | 'not-offered' {
    const result = this.gate.decide(approvalId, decision);
    if (result !== 'not-found') {
      return result;
    }
    for (const message of this.record.messages) {
      for (const part of message.parts) {
        if (part.type === 'tool' && part.approval?.id === approvalId) {
          return 'already-decided';
        }
      }
    }
    return 'not-found';
  }

  /** Approvals still waiting for the user end as denied: the engine is exiting. Synchronous. */
  onEngineExit(): void {
    if (this.turn) {
      this.turn.stopping = true;
    }
    if (this.gate.pendingApprovalIds().length > 0) {
      this.settleApprovals('shutdown');
      // Saved now: the gate's own save comes after an await the exit never reaches.
      this.persist();
    }
  }

  /**
   * Stops the running turn: the CLI is interrupted (and killed if it does
   * not stop), the partial answer is kept, and the session goes back to idle.
   */
  async cancel(): Promise<void> {
    const turn = this.turn;
    if (!turn) {
      return;
    }
    // First, before anything can wait: no tool call starts from now on, and
    // the calls waiting for the user are denied. A call the CLI still sends
    // (Codex keeps an MCP call pending through an interrupt, §19) is refused.
    turn.stopping = true;
    this.settleApprovals('stopped');
    if (this.statusValue.state === 'awaiting-approval') {
      this.setStatus({ state: 'running', turnId: turn.turnId });
    }
    const run = this.run;
    if (run) {
      try {
        await run.interrupt();
      } catch (e) {
        console.error('[agent] interrupt failed:', e);
      }
    }
    if (this.turn === turn) {
      this.finishTurn('interrupted');
    }
  }

  /** Ends everything the session holds: the turn, the CLI, the MCP endpoint. */
  async dispose(): Promise<void> {
    if (this.disposed) {
      return;
    }
    await this.cancel();
    this.disposed = true;
    this.clearIdleTimer();
    await this.closeRun();
    if (this.endpoint) {
      this.deps.endpoints.remove(this.endpoint);
      await this.endpoint.closeSessions();
      this.endpoint = null;
    }
    // Attached streams refetch the snapshot, and learn the session is gone.
    this.log.append({ type: 'resync' });
  }

  // -------------------------------------------------------------------------
  // The turn
  // -------------------------------------------------------------------------

  private async startTurn(
    turnId: string,
    input: { cliText: string; imagePath?: string; model?: string; effort?: string; revertedFiles: string[] },
  ): Promise<void> {
    try {
      const setup = await this.deps.prepareTurn();
      if (this.turn?.turnId !== turnId) {
        return;
      }
      const install = setup.install;
      if (!install.path || !install.supported) {
        this.finishTurn('error', { kind: 'not-installed', message: install.problem ?? `${agentName(install.kind)} was not found.` });
        return;
      }
      if (install.loggedIn === false) {
        this.finishTurn('error', { kind: 'auth', message: install.problem ?? `${agentName(install.kind)} is not signed in.` });
        return;
      }
      const model = input.model ?? setup.defaultModel ?? null;
      const effort = input.effort ?? setup.defaultEffort ?? null;
      await this.ensureRun(setup, model, effort);
      if (this.turn?.turnId !== turnId || !this.run) {
        return;
      }
      this.setStatus({ state: 'running', turnId });
      this.run.send({ text: input.cliText, imagePath: input.imagePath });
      if (input.revertedFiles.length > 0) {
        // The CLI has been told; a revert made since keeps its own files.
        const told = new Set(input.revertedFiles);
        const left = (this.record.revertedFiles ?? []).filter((f) => !told.has(f));
        if (left.length > 0) {
          this.record.revertedFiles = left;
        } else {
          delete this.record.revertedFiles;
        }
        this.persist();
      }
    } catch (e) {
      if (this.turn?.turnId === turnId) {
        this.finishTurn('error', { kind: 'other', message: e instanceof Error ? e.message : String(e) });
      }
    }
  }

  private async ensureRun(setup: TurnSetup, model: string | null, effort: string | null): Promise<void> {
    if (this.run && this.runKey && this.runKey.model === model && this.runKey.effort === effort) {
      return;
    }
    // A different model or effort: the CLI is respawned and resumes the conversation.
    await this.closeRun();
    const endpoint = this.ensureEndpoint();
    const run = await this.deps.backend.open({
      install: setup.install,
      resume: this.record.agent.ref,
      cwd: this.deps.workspacePath,
      mcpUrl: endpoint.url,
      instructions: this.deps.instructions(),
      ...(model ? { model } : {}),
      ...(effort ? { effort } : {}),
      env: setup.env,
    });
    this.run = run;
    this.runKey = { model, effort };
    this.record.agent.model = model;
    this.consuming = this.consume(run);
  }

  private ensureEndpoint(): McpEndpoint {
    if (!this.endpoint) {
      this.endpoint = new McpEndpoint({
        pinnedWorkspace: this.deps.pinnedWorkspace(),
        toolGate: this.gate,
        indexes: this.deps.indexes,
        port: this.deps.port,
      });
      this.deps.endpoints.add(this.endpoint);
    }
    return this.endpoint;
  }

  private async consume(run: AgentRun): Promise<void> {
    try {
      for await (const event of run.events) {
        if (this.run === run) {
          this.onBackendEvent(run, event);
        }
      }
    } catch (e) {
      console.error('[agent] reading the CLI failed:', e);
    }
    // The child is gone. Claude Code does not close its MCP session, so the
    // engine does (§19); a respawned CLI opens a new one on the same URL.
    if (this.run === run) {
      this.run = null;
      this.runKey = null;
      if (this.turn) {
        this.finishTurn('error', { kind: 'other', message: 'The agent stopped before the turn ended.' });
      }
    }
    await this.endpoint?.closeSessions();
  }

  private async closeRun(): Promise<void> {
    const run = this.run;
    const consuming = this.consuming;
    this.run = null;
    this.runKey = null;
    this.consuming = null;
    if (run) {
      await run.close().catch((e) => console.error('[agent] closing the CLI failed:', e));
    }
    if (consuming) {
      await consuming;
    }
  }

  private onBackendEvent(run: AgentRun, event: BackendEvent): void {
    if (event.type === 'turn-end') {
      if (event.reason === 'error' && event.error && /no conversation found/i.test(event.error.message)) {
        // The CLI no longer has the conversation (its own retention): start fresh next time.
        this.record.agent.ref = null;
      } else if (event.reason === 'done' || (event.reason === 'interrupted' && this.turn?.assistantMessageId)) {
        // The CLI holds the conversation now: later runs resume it.
        this.record.agent.ref = run.ref;
      }
      this.finishTurn(event.reason, event.error);
      return;
    }
    const turn = this.turn;
    if (!turn) {
      return;
    }
    switch (event.type) {
      case 'text-delta':
      case 'reasoning-delta': {
        const kind = event.type === 'text-delta' ? 'text' : 'reasoning';
        const partId = `${kind}-${event.id}`;
        const messageId = this.assistantMessageId();
        if (!turn.parts.has(partId)) {
          turn.parts.add(partId);
          this.emit({ type: 'part-start', messageId, part: { type: kind, id: partId, text: '' } });
        }
        if (event.delta !== '') {
          this.emit({ type: 'part-delta', messageId, partId, text: event.delta });
        }
        return;
      }
      case 'block-end':
        return;
      case 'tool': {
        const partId = `agent-tool-${event.id}`;
        const messageId = this.assistantMessageId();
        if (!turn.parts.has(partId)) {
          turn.parts.add(partId);
          const part: ToolPart = {
            type: 'tool',
            id: partId,
            source: 'agent',
            name: event.name,
            title: event.title,
            kind: ['Read', 'Glob', 'Grep'].includes(event.name) ? 'read' : 'other',
            state: event.state,
            input: event.input ?? {},
            ...(event.output !== undefined ? { output: { text: event.output } } : {}),
            ...(event.error !== undefined ? { error: event.error } : {}),
          };
          this.emit({ type: 'part-start', messageId, part });
        } else {
          const patch: Partial<ToolPart> = {
            state: event.state,
            title: event.title,
            ...(event.input !== undefined ? { input: event.input } : {}),
            ...(event.output !== undefined ? { output: { text: event.output } } : {}),
            ...(event.error !== undefined ? { error: event.error } : {}),
          };
          this.emit({ type: 'part-update', messageId, partId, patch });
        }
        if (event.state !== 'running' || !turn.parts.has(`${partId}:persisted`)) {
          turn.parts.add(`${partId}:persisted`);
          this.persist();
        }
        return;
      }
      case 'usage':
        this.emit({
          type: 'usage',
          ...(event.inputTokens !== undefined ? { inputTokens: event.inputTokens } : {}),
          ...(event.outputTokens !== undefined ? { outputTokens: event.outputTokens } : {}),
          ...(event.costUsd !== undefined ? { costUsd: event.costUsd } : {}),
        });
        return;
      case 'notice':
        this.addNotice(event.level, event.text);
        return;
    }
  }

  private finishTurn(
    reason: 'done' | 'interrupted' | 'error',
    error?: TurnError | { kind: 'not-installed'; message: string; resetsAt?: string },
  ): void {
    const turn = this.turn;
    if (!turn) {
      return;
    }
    // Calls still waiting for the user end with the turn.
    turn.stopping = true;
    this.settleApprovals('stopped');
    if (error) {
      this.addNotice('error', error.message);
    } else if (reason === 'interrupted') {
      this.addNotice('info', 'Stopped.');
    }
    // Tool cards still open when the turn ends did not finish.
    if (turn.assistantMessageId) {
      const message = findMessage(this.record.messages, turn.assistantMessageId);
      for (const part of message?.parts ?? []) {
        if (part.type === 'tool' && (part.state === 'running' || part.state === 'awaiting-approval')) {
          this.emit({
            type: 'part-update',
            messageId: turn.assistantMessageId,
            partId: part.id,
            patch: { state: 'error', error: reason === 'interrupted' ? 'Stopped.' : 'The turn ended before this finished.' },
          });
        }
      }
      this.emit({ type: 'message-end', messageId: turn.assistantMessageId });
    }
    this.turn = null;
    const record = this.record.turns.find((t: TurnRecord) => t.id === turn.turnId);
    if (record) {
      record.endedAt = new Date().toISOString();
      record.endReason = reason;
    }
    if (reason === 'error' && error) {
      this.setStatus({
        state: 'error',
        kind: error.kind,
        message: error.message,
        ...(error.resetsAt ? { resetsAt: error.resetsAt } : {}),
      });
    } else {
      this.setStatus({ state: 'idle' });
    }
    this.persist();
    this.startIdleTimer();
  }

  /** The assistant message of the running turn, started on first use. */
  private assistantMessageId(): string {
    const turn = this.turn;
    if (!turn) {
      throw new Error('No turn is running.');
    }
    if (!turn.assistantMessageId) {
      turn.assistantMessageId = randomUUID();
      this.emit({
        type: 'message-start',
        message: { id: turn.assistantMessageId, role: 'assistant', turnId: turn.turnId, createdAt: new Date().toISOString() },
      });
    }
    return turn.assistantMessageId;
  }

  private addNotice(level: 'info' | 'warning' | 'error', text: string): void {
    if (!this.turn) {
      return;
    }
    const messageId = this.assistantMessageId();
    this.emit({ type: 'part-start', messageId, part: { type: 'notice', id: randomUUID(), level, text } });
  }

  // -------------------------------------------------------------------------
  // Approvals and checkpoints (§12.1, §12.2)
  // -------------------------------------------------------------------------

  private settleApprovals(reason: ApprovalSweep): void {
    this.gate.settleAll(reason);
  }

  private approvalsChanged(turnId: string, approvalIds: string[]): void {
    const turn = this.turn;
    if (!turn || turn.turnId !== turnId || turn.stopping) {
      return;
    }
    if (approvalIds.length > 0) {
      this.setStatus({ state: 'awaiting-approval', turnId, approvalIds });
    } else if (this.statusValue.state === 'awaiting-approval') {
      this.setStatus({ state: 'running', turnId });
    }
  }

  /** Keeps the file as it is before the turn's first change to it. */
  private takeCheckpoint(turnId: string, checkpoint: Checkpoint): boolean {
    const existing = this.deps.store.readCheckpoints(this.record.id, turnId);
    if (existing.some((c) => samePath(c.path, checkpoint.path))) {
      return false;
    }
    const n = existing.reduce((max, c) => Math.max(max, c.n), 0) + 1;
    this.deps.store.writeCheckpoint(this.record.id, turnId, n, checkpoint);
    this.checkpointsChanged(turnId);
    return true;
  }

  private dropCheckpoint(turnId: string, filePath: string): void {
    for (const c of this.deps.store.readCheckpoints(this.record.id, turnId)) {
      if (samePath(c.path, filePath)) {
        this.deps.store.deleteCheckpoint(this.record.id, turnId, c.n);
      }
    }
    this.checkpointsChanged(turnId);
  }

  /** The turn's record and the `checkpoint` event follow the checkpoints on disk. */
  private checkpointsChanged(turnId: string): void {
    const files = this.deps.store
      .readCheckpoints(this.record.id, turnId)
      .map((c) => relativeTo(this.deps.workspacePath, c.path));
    const record = this.record.turns.find((t) => t.id === turnId);
    if (record) {
      record.revertible = files.length > 0;
      if (files.length > 0) {
        record.files = files;
      } else {
        delete record.files;
      }
    }
    this.emit({ type: 'checkpoint', turnId, files });
    this.persist();
  }

  /**
   * Reverts `turnId` and every later turn that changed files, newest first,
   * so the files are as they were before `turnId` (§12.2). Each file is put
   * back through the `write_file` tool function, so the editor adopts it and
   * the model re-renders; a file a turn created is deleted. The transcript
   * keeps its history and gains a notice per turn, and the next message
   * tells the CLI, whose own history still has the edits.
   *
   * Throws SessionBusyError while a turn or another revert runs, RevertError
   * for an unknown or non-revertible turn. A turn whose files could not all
   * be put back stays revertible, and the revert stops there.
   */
  async revert(turnId: string): Promise<RevertResult> {
    if (this.turn) {
      throw new SessionBusyError('Stop the running turn before reverting.');
    }
    if (this.reverting) {
      throw new SessionBusyError('A revert is already running in this session.');
    }
    const index = this.record.turns.findIndex((t) => t.id === turnId);
    if (index < 0) {
      throw new RevertError('not-found', 'No such turn.');
    }
    if (!this.record.turns[index].revertible) {
      throw new RevertError('not-revertible', 'This turn has no changes to revert.');
    }
    this.reverting = true;
    const restored: string[] = [];
    const failed: { path: string; error: string }[] = [];
    try {
      const turns = this.record.turns.slice(index).filter((t) => t.revertible).reverse();
      for (const turn of turns) {
        const done: string[] = [];
        for (const checkpoint of this.deps.store.readCheckpoints(this.record.id, turn.id).reverse()) {
          const rel = relativeTo(this.deps.workspacePath, checkpoint.path);
          const error = await this.restore(checkpoint);
          if (error) {
            failed.push({ path: rel, error });
          } else {
            done.push(rel);
            if (!restored.includes(rel)) {
              restored.push(rel);
            }
          }
        }
        if (done.length > 0) {
          this.record.revertedFiles = [...new Set([...(this.record.revertedFiles ?? []), ...done])];
        }
        if (failed.length > 0) {
          this.persist();
          break;
        }
        turn.revertible = false;
        turn.revertedAt = new Date().toISOString();
        this.deps.store.deleteCheckpoints(this.record.id, turn.id);
        this.emit({ type: 'reverted', turnId: turn.id, files: done });
        this.addTurnNotice(turn.id, `Reverted the changes of this turn: ${done.join(', ')}.`);
        this.persist();
      }
    } finally {
      this.reverting = false;
    }
    return { restored, ...(failed.length > 0 ? { failed } : {}) };
  }

  /** Puts one file back; returns an error message, or null. */
  private async restore(checkpoint: Checkpoint): Promise<string | null> {
    if (!isInside(this.deps.workspacePath, checkpoint.path)) {
      return 'The file is outside the workspace.';
    }
    if (!checkpoint.existed) {
      try {
        fs.rmSync(checkpoint.path, { force: true });
        return null;
      } catch (e) {
        return e instanceof Error ? e.message : String(e);
      }
    }
    const write = (force: boolean) =>
      writeFile({
        pinnedWorkspace: this.deps.pinnedWorkspace(),
        path: checkpoint.path,
        content: checkpoint.content,
        force,
        includeChanges: false,
      });
    try {
      let result = await write(false);
      if (result.ok === false && REVERT_FORCE_CODES.has(result.code)) {
        result = await write(true);
      }
      if (result.ok === false) {
        return result.code === 'dirty-buffer'
          ? 'The file has unsaved changes in the editor. Save or discard them, then revert again.'
          : result.message;
      }
      return null;
    } catch (e) {
      return e instanceof Error ? e.message : String(e);
    }
  }

  /** A notice at the end of the turn's last message (the turn has ended). */
  private addTurnNotice(turnId: string, text: string): void {
    for (let i = this.record.messages.length - 1; i >= 0; i--) {
      const message = this.record.messages[i];
      if (message.turnId === turnId) {
        this.emit({ type: 'part-start', messageId: message.id, part: { type: 'notice', id: randomUUID(), level: 'info', text } });
        return;
      }
    }
  }

  // -------------------------------------------------------------------------
  // Plumbing
  // -------------------------------------------------------------------------

  private emit(event: ChatEvent): void {
    applyChatEvent(this.record.messages, event);
    this.log.append(event);
  }

  private setStatus(status: SessionStatus): void {
    this.statusValue = status;
    this.emit({ type: 'status', status });
  }

  private persist(): void {
    if (this.disposed) {
      return;
    }
    this.record.updatedAt = new Date().toISOString();
    try {
      this.deps.store.write(this.record);
    } catch (e) {
      console.error(`[agent] could not save session ${this.record.id}:`, e);
    }
  }

  private saveImage(data: Buffer, mimeType: string): string {
    const ext = IMAGE_EXTENSIONS[mimeType] ?? 'bin';
    const name = `${randomUUID()}.${ext}`;
    this.deps.store.writeFile(this.record.id, name, data);
    return name;
  }

  private startIdleTimer(): void {
    this.clearIdleTimer();
    if (!this.run || this.disposed) {
      return;
    }
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      if (!this.turn) {
        void this.closeRun();
      }
    }, this.deps.idleMs ?? DEFAULT_IDLE_MS);
    this.idleTimer.unref?.();
  }

  private clearIdleTimer(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
  }
}

const IMAGE_EXTENSIONS: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
};

function agentName(kind: AgentKind): string {
  return kind === 'codex' ? 'Codex' : 'Claude Code';
}

function samePath(a: string, b: string): boolean {
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function isInside(root: string, file: string): boolean {
  let base = root;
  try {
    base = fs.realpathSync(root);
  } catch {
    // Keep it as given.
  }
  const rel = path.relative(base, file);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

function cutTitle(text: string): string {
  const line = text.trim().split('\n')[0]?.trim() ?? '';
  if (line.length <= MAX_TITLE_CHARS) {
    return line || 'New chat';
  }
  return `${line.slice(0, MAX_TITLE_CHARS - 1).trimEnd()}…`;
}
