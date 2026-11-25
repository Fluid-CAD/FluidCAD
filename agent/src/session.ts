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
import { TurnFailure, type AgentBackend, type AgentInstall, type AgentRun, type BackendEvent, type TurnError, type TurnImage } from './backend.ts';
import { EventLog } from './event-log.ts';
import { buildCliText, CONTINUE_TEXT, interruptedTurnNote, type InterruptedToolCall, type WorkspaceState } from './instructions.ts';
import { addParamChanges, mergeKept, readKept, withoutTold, type ParamCardModel } from './param-cards.ts';
import { McpEndpoint, type McpEndpoints, type SharedMcpIndexes } from './mcp-endpoint.ts';
import { SessionStore, type Checkpoint, type SessionRecord } from './session-store.ts';
import { relativeTo, ToolGate, type ApprovalSweep, type ToolGateOptions } from './tool-gate.ts';
import { applyChatEvent, findMessage, findPart } from './transcript.ts';
import { cancelUnbuilt, VARIANTS_RESTART_BUILDING_REASON, VARIANTS_RESTART_REASON } from './variants.ts';
import { cancelUnfinishedPreview } from './change-preview.ts';
import { ASK_USER_TOOL, OFFER_PARAMS_TOOL, PROPOSE_VARIANTS_TOOL, SHOW_USER_TOOL, writeFile, type RegistryEntry } from '../../mcp/dist/server.js';
import type {
  AgentKind,
  ApprovalDecision,
  ChatEvent,
  ChatPart,
  ParamChange,
  ParamsPart,
  PermissionMode,
  QuestionPart,
  SendMessage,
  SessionSnapshot,
  SessionStatus,
  SessionSummary,
  ToolPart,
  TurnRecord,
  TurnUsage,
  VariantsPart,
} from './types.ts';

/** How long a CLI may sit idle between turns before it is closed (§6.2); the next message resumes it. */
export const DEFAULT_IDLE_MS = 10 * 60 * 1000;
const MAX_TITLE_CHARS = 80;
export const RESTART_REASON = 'The app restarted while this turn was running.';
const RESTART_TOOL_ERROR = 'The app restarted while this was running; its effect is unknown.';
const RESTART_QUESTION_REASON = 'The app restarted before you answered.';

/** What a turn needs resolved before the CLI starts: the install, its environment and the defaults. */
export type TurnSetup = {
  install: AgentInstall;
  env: NodeJS.ProcessEnv;
  defaultModel?: string;
  defaultEffort?: string;
  /**
   * A message that names no model keeps the session's own (the API agent:
   * a chat stays on its provider) before falling back to `defaultModel`.
   */
  stickyModel?: boolean;
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
  /** The model on screen and the parameters its last render declared, for `offer_params` (§26). */
  model(): ParamCardModel;
  instructions(): string;
  /** Whether the user chose "Always" for tool `name` (an install). Absent: never. */
  alwaysAllowed?(name: string): Promise<boolean>;
  /** Remembers "Always" for tool `name` in the preferences. Absent: no card offers it. */
  allowAlways?(name: string): Promise<void>;
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
        part: (messageId, partId) => findPart(this.record.messages, messageId, partId),
        saveImage: (data, mimeType) => this.saveImage(data, mimeType),
        persist: () => this.persist(),
        approvalsChanged: (turnId) => this.waitsChanged(turnId),
        questionsChanged: (turnId) => this.waitsChanged(turnId),
        checkpoint: (turnId, checkpoint) => this.takeCheckpoint(turnId, checkpoint),
        dropCheckpoint: (turnId, filePath) => this.dropCheckpoint(turnId, filePath),
        model: () => deps.model(),
        ...(deps.alwaysAllowed ? { alwaysAllowed: (name: string) => deps.alwaysAllowed!(name) } : {}),
        ...(deps.allowAlways ? { allowAlways: (name: string) => deps.allowAlways!(name) } : {}),
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
            // A preview the restart cut off was not built: the card shows none (§25).
            if (part.preview) {
              part.preview = cancelUnfinishedPreview(part.preview);
            }
          } else if (part.type === 'question' && part.state === 'awaiting-answer') {
            part.state = 'unanswered';
            part.reason = RESTART_QUESTION_REASON;
          } else if (part.type === 'variants' && (part.state === 'building' || part.state === 'awaiting-choice')) {
            part.reason = part.state === 'building' ? VARIANTS_RESTART_BUILDING_REASON : VARIANTS_RESTART_REASON;
            part.state = 'unanswered';
            part.variants = cancelUnbuilt(part.variants);
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
      effort: this.record.agent.effort ?? null,
    });
  }

  summary(): SessionSummary {
    return {
      id: this.record.id,
      title: this.record.title,
      agent: this.record.agent.kind,
      updatedAt: this.record.updatedAt,
      status: structuredClone(this.statusValue),
      model: this.record.agent.model,
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
  send(input: SendMessage, extra: { interruptedTurn?: string } = {}): { turnId: string } {
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
    // The words, the images the user attached, the reference chips, then the
    // capture they are drawn in. The model gets the images in that order.
    const parts: ChatPart[] = input.text.trim() === '' ? [] : [{ type: 'text', id: randomUUID(), text: input.text }];
    const images: TurnImage[] = [];
    const attachedImages: string[] = [];
    for (const attachment of input.attachments ?? []) {
      const file = `${randomUUID()}.${IMAGE_EXTENSIONS[attachment.mediaType]}`;
      const name = attachment.name ?? 'image';
      images.push({ path: this.deps.store.writeFile(this.record.id, file, Buffer.from(attachment.base64, 'base64')), mediaType: attachment.mediaType });
      parts.push({ type: 'image', id: randomUUID(), file, name });
      attachedImages.push(name);
    }
    if (input.references && input.references.length > 0) {
      parts.push({ type: 'references', id: randomUUID(), references: input.references });
    }
    let captureAttached = false;
    if (input.image) {
      const file = `${randomUUID()}.png`;
      images.push({ path: this.deps.store.writeFile(this.record.id, file, Buffer.from(input.image.base64, 'base64')), mediaType: 'image/png' });
      parts.push({ type: 'image', id: randomUUID(), file });
      captureAttached = true;
    }
    for (const part of parts) {
      this.emit({ type: 'part-start', messageId: userMessageId, part });
    }
    this.emit({ type: 'message-end', messageId: userMessageId });
    this.record.turns.push({ id: turnId, userMessageId, revertible: false });

    if (!this.record.titleSetByUser && this.record.turns.length === 1) {
      // A message of images only is titled by its first image.
      const firstLine = (input.text.trim().split('\n')[0] ?? '') || (attachedImages[0] ?? '');
      if (firstLine !== '') {
        this.record.title = cutTitle(firstLine);
        this.emit({ type: 'title', title: this.record.title });
      }
    }
    this.setStatus({ state: 'starting', turnId });
    this.persist();

    const revertedFiles = this.record.revertedFiles ?? [];
    const paramChanges = this.record.paramChanges ?? [];
    const cliText = buildCliText({
      text: input.text,
      references: input.references,
      attachedImages,
      imageAttached: captureAttached,
      workspace: this.deps.workspaceState(),
      revertedFiles,
      paramChanges,
      ...(extra.interruptedTurn ? { interruptedTurn: extra.interruptedTurn } : {}),
    });
    void this.startTurn(turnId, { cliText, images, model: input.model, effort: input.effort, revertedFiles, paramChanges });
    return { turnId };
  }

  /**
   * Resume after an engine restart cut a turn off (§12.3). The transcript
   * shows {@link CONTINUE_TEXT}; the CLI also gets what the cut-off turn was
   * doing ({@link interruptedTurnNote}): the request and how each tool call
   * ended.
   */
  continueAfterRestart(mode: PermissionMode = 'ask'): { turnId: string } {
    const note = this.interruptedTurnSummary();
    return this.send({ text: CONTINUE_TEXT, mode }, note ? { interruptedTurn: note } : {});
  }

  /** The continue note for the last turn, when an engine restart cut it off. */
  private interruptedTurnSummary(): string | null {
    const turns = this.record.turns;
    const last = turns[turns.length - 1];
    if (!last || last.endReason !== 'interrupted') {
      return null;
    }
    // A turn that was itself a Continue: quote the request it was carrying on.
    let request: string | null = null;
    for (let i = turns.length - 1; i >= 0 && request === null; i--) {
      const text = this.userText(turns[i].userMessageId);
      if (text !== null && text !== CONTINUE_TEXT) {
        request = text;
      }
    }
    const calls: InterruptedToolCall[] = [];
    for (const message of this.record.messages) {
      if (message.turnId !== last.id || message.role !== 'assistant') {
        continue;
      }
      for (const part of message.parts) {
        if (part.type === 'tool') {
          calls.push({ name: part.name, ...this.toolTarget(part), outcome: toolOutcome(part) });
        } else if (part.type === 'question') {
          calls.push({ name: ASK_USER_TOOL, outcome: questionOutcome(part) });
        } else if (part.type === 'variants') {
          calls.push({ name: PROPOSE_VARIANTS_TOOL, target: part.file, outcome: variantsOutcome(part) });
        } else if (part.type === 'params') {
          calls.push({ name: OFFER_PARAMS_TOOL, target: part.file, outcome: 'done: the card is in the chat' });
        } else if (part.type === 'show') {
          calls.push({ name: SHOW_USER_TOOL, target: part.file, outcome: 'done: the items are on a card in the chat' });
        }
      }
    }
    return interruptedTurnNote({ request, calls });
  }

  private userText(messageId: string): string | null {
    const message = findMessage(this.record.messages, messageId);
    const text = message?.parts.find((p) => p.type === 'text');
    return text && text.type === 'text' ? text.text : null;
  }

  /** What a tool call worked on, workspace-relative: its `path` (or `file_path`), when it has one. */
  private toolTarget(part: ToolPart): { target?: string } {
    const input = (part.input && typeof part.input === 'object' ? part.input : {}) as Record<string, unknown>;
    const raw = typeof input.path === 'string' ? input.path : typeof input.file_path === 'string' ? input.file_path : null;
    if (!raw) {
      return {};
    }
    return { target: path.isAbsolute(raw) ? relativeTo(this.deps.workspacePath, raw) : raw };
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
    return this.findApproval(approvalId) ? 'already-decided' : 'not-found';
  }

  /**
   * The user asked for the preview an approval card offers (§25).
   * `already-decided`: the call no longer waits; `not-offered`: its card has
   * no preview to build.
   */
  requestPreview(approvalId: string): 'ok' | 'not-found' | 'already-decided' | 'not-offered' {
    const result = this.gate.requestPreview(approvalId);
    if (result !== 'not-found') {
      return result;
    }
    return this.findApproval(approvalId) ? 'already-decided' : 'not-found';
  }

  /**
   * Keeps the pictures a page drew of the two sides of a change (PNGs, from
   * one camera) with the session, and names them on the card's preview:
   * every tab shows them from then on, and they outlive the engine's own
   * copy of the builds (§25). The first picture of a side is kept; a later
   * one is dropped. Taken after the approval was settled too, while the
   * engine still has the builds. `not-found`: no such approval;
   * `not-built`: no side given has a build to be a picture of.
   */
  savePreviewPictures(approvalId: string, pictures: { before?: Buffer; after?: Buffer }): { result: 'ok'; kept: number } | { result: 'not-found' | 'not-built' } {
    const found = this.findApproval(approvalId);
    if (!found) {
      return { result: 'not-found' };
    }
    const preview = found.part.preview;
    const sides = (['before', 'after'] as const).filter((side) => pictures[side] && preview?.[side]?.buildId);
    if (!preview || sides.length === 0) {
      return { result: 'not-built' };
    }
    const next = { ...preview };
    let kept = 0;
    for (const side of sides) {
      if (!next[side]!.image) {
        next[side] = { ...next[side]!, image: this.saveImage(pictures[side]!, 'image/png') };
        kept += 1;
      }
    }
    if (kept > 0) {
      this.emit({ type: 'part-update', messageId: found.messageId, partId: found.part.id, patch: { preview: next } });
      this.persist();
    }
    return { result: 'ok', kept };
  }

  private findApproval(approvalId: string): { messageId: string; part: ToolPart } | null {
    for (const message of this.record.messages) {
      for (const part of message.parts) {
        if (part.type === 'tool' && part.approval?.id === approvalId) {
          return { messageId: message.id, part };
        }
      }
    }
    return null;
  }

  /**
   * The user's reply to a question the agent asked (§22): the answers, or a
   * skip. `already-answered`: the question is in the transcript but no
   * longer waits.
   */
  answerQuestion(questionId: string, body: unknown): { result: 'ok' | 'not-found' | 'already-answered' } | { result: 'invalid'; error: string } {
    const answer = this.gate.answer(questionId, body);
    if (answer.result !== 'not-found') {
      return answer;
    }
    for (const message of this.record.messages) {
      for (const part of message.parts) {
        if (part.type === 'question' && part.id === questionId) {
          return { result: 'already-answered' };
        }
      }
    }
    return { result: 'not-found' };
  }

  /**
   * The user's reply to a variants card (§24): a pick, their own words, or a
   * skip. `already-settled`: the card is in the transcript but no longer
   * waits; `building`: its variants are not built yet.
   */
  chooseVariant(variantsId: string, body: unknown): { result: 'ok' | 'not-found' | 'already-settled' | 'building' } | { result: 'invalid'; error: string } {
    const choice = this.gate.choose(variantsId, body);
    if (choice.result !== 'not-found') {
      return choice;
    }
    return this.findVariants(variantsId) ? { result: 'already-settled' } : { result: 'not-found' };
  }

  /**
   * Keeps the picture a page drew of a variant's build (a PNG) with the
   * session, and names it on the tile: every tab shows it from then on, and
   * it outlives the engine's own copy of the build (§24). The first picture
   * of a tile is kept; a later one is dropped (`kept: false`). `not-found`:
   * no such card or tile; `not-built`: the tile has no build to be a
   * picture of.
   */
  saveVariantPicture(variantsId: string, label: string, png: Buffer): { result: 'ok'; kept: boolean } | { result: 'not-found' | 'not-built' } {
    const found = this.findVariants(variantsId);
    const index = found ? found.part.variants.findIndex((tile) => tile.label === label) : -1;
    if (!found || index < 0) {
      return { result: 'not-found' };
    }
    const tile = found.part.variants[index];
    if (!tile.buildId) {
      return { result: 'not-built' };
    }
    if (tile.image) {
      return { result: 'ok', kept: false };
    }
    const image = this.saveImage(png, 'image/png');
    this.emit({
      type: 'part-update',
      messageId: found.messageId,
      partId: found.part.id,
      patch: { variants: found.part.variants.map((t, i) => (i === index ? { ...t, image } : t)) },
    });
    this.persist();
    return { result: 'ok', kept: true };
  }

  private findVariants(variantsId: string): { messageId: string; part: VariantsPart } | null {
    for (const message of this.record.messages) {
      for (const part of message.parts) {
        if (part.type === 'variants' && part.id === variantsId) {
          return { messageId: message.id, part };
        }
      }
    }
    return null;
  }

  /**
   * What a page wrote into the source when the user pressed Keep on a
   * parameter card (§26): the card says so from then on, in every tab, and
   * the next message tells the agent, whose history still has the old
   * defaults. Taken whether or not a turn runs: Keep is the user's own
   * action, not a change of a turn, so it is neither approved nor
   * checkpointed. `not-found`: no such card.
   */
  paramsKept(paramsId: string, body: unknown): { result: 'ok' | 'not-found' } | { result: 'invalid'; error: string } {
    const found = this.findParams(paramsId);
    if (!found) {
      return { result: 'not-found' };
    }
    const read = readKept(found.part, body);
    if (read.ok === false) {
      return { result: 'invalid', error: read.error };
    }
    this.record.paramChanges = addParamChanges(this.record.paramChanges, found.part, read.kept, this.deps.model(), (absPath) =>
      relativeTo(this.deps.workspacePath, absPath),
    );
    this.emit({ type: 'part-update', messageId: found.messageId, partId: found.part.id, patch: { kept: mergeKept(found.part.kept, read.kept) } });
    this.persist();
    return { result: 'ok' };
  }

  private findParams(paramsId: string): { messageId: string; part: ParamsPart } | null {
    for (const message of this.record.messages) {
      for (const part of message.parts) {
        if (part.type === 'params' && part.id === paramsId) {
          return { messageId: message.id, part };
        }
      }
    }
    return null;
  }

  /** Approvals, questions and variants cards still waiting for the user end unanswered: the engine is exiting. Synchronous. */
  onEngineExit(): void {
    if (this.turn) {
      this.turn.stopping = true;
    }
    if (this.gate.pendingApprovalIds().length > 0 || this.gate.pendingQuestionIds().length > 0 || this.gate.pendingVariantIds().length > 0) {
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
    if (this.statusValue.state === 'awaiting-approval' || this.statusValue.state === 'awaiting-answer') {
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
    input: { cliText: string; images: TurnImage[]; model?: string; effort?: string; revertedFiles: string[]; paramChanges: ParamChange[] },
  ): Promise<void> {
    try {
      const setup = await this.deps.prepareTurn();
      if (this.turn?.turnId !== turnId) {
        return;
      }
      const install = setup.install;
      // The API agent runs no program: it has no path.
      if ((!install.path && install.kind !== 'api') || !install.supported) {
        this.finishTurn('error', { kind: 'not-installed', message: install.problem ?? `${agentName(install.kind)} was not found.` });
        return;
      }
      if (install.loggedIn === false) {
        this.finishTurn('error', { kind: 'auth', message: install.problem ?? `${agentName(install.kind)} is not signed in.` });
        return;
      }
      const model = input.model ?? (setup.stickyModel ? this.record.agent.model : null) ?? setup.defaultModel ?? null;
      const effort = input.effort ?? setup.defaultEffort ?? null;
      await this.ensureRun(setup, model, effort);
      if (this.turn?.turnId !== turnId || !this.run) {
        return;
      }
      this.setStatus({ state: 'running', turnId });
      this.run.send({ text: input.cliText, ...(input.images.length > 0 ? { images: input.images } : {}) });
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
      if (input.paramChanges.length > 0) {
        // The CLI has been told; a value kept since stays for the next message.
        const left = withoutTold(this.record.paramChanges, input.paramChanges);
        if (left.length > 0) {
          this.record.paramChanges = left;
        } else {
          delete this.record.paramChanges;
        }
        this.persist();
      }
    } catch (e) {
      if (this.turn?.turnId === turnId) {
        this.finishTurn('error', e instanceof TurnFailure ? e.error : { kind: 'other', message: e instanceof Error ? e.message : String(e) });
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
      sessionDir: this.deps.store.sessionDir(this.record.id),
    });
    this.run = run;
    this.runKey = { model, effort };
    this.record.agent.model = model;
    if (effort) {
      this.record.agent.effort = effort;
    } else {
      delete this.record.agent.effort;
    }
    this.consuming = this.consume(run);
  }

  private ensureEndpoint(): McpEndpoint {
    if (!this.endpoint) {
      this.endpoint = new McpEndpoint({
        pinnedWorkspace: this.deps.pinnedWorkspace(),
        toolGate: this.gate,
        askUser: (input, signal) => this.gate.ask(input, signal),
        proposeVariants: (input, signal) => this.gate.propose(input, signal),
        offerParams: (input) => this.gate.offer(input),
        showUser: (input) => this.gate.show(input),
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
            kind: ['Read', 'Glob', 'Grep', 'WebSearch', 'web_search'].includes(event.name) ? 'read' : 'other',
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
      case 'usage': {
        const usage: TurnUsage = {
          ...(event.inputTokens !== undefined ? { inputTokens: event.inputTokens } : {}),
          ...(event.outputTokens !== undefined ? { outputTokens: event.outputTokens } : {}),
          ...(event.costUsd !== undefined ? { costUsd: event.costUsd } : {}),
        };
        // The turn's record keeps it, so a reload still shows what the turn used.
        const record = this.record.turns.find((t) => t.id === turn.turnId);
        if (record) {
          record.usage = usage;
        }
        this.emit({ type: 'usage', turnId: turn.turnId, ...usage });
        return;
      }
      case 'notice':
        this.addNotice(event.level, event.text, event.resetsAt);
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
      this.addNotice(error.kind === 'rate-limit' ? 'warning' : 'error', error.message, error.resetsAt);
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
            patch: {
              state: 'error',
              error: reason === 'interrupted' ? 'Stopped.' : 'The turn ended before this finished.',
              ...(part.preview ? { preview: cancelUnfinishedPreview(part.preview) } : {}),
            },
          });
        } else if (part.type === 'question' && part.state === 'awaiting-answer') {
          this.emit({
            type: 'part-update',
            messageId: turn.assistantMessageId,
            partId: part.id,
            patch: { state: 'unanswered', reason: reason === 'interrupted' ? 'Stopped before you answered.' : 'The turn ended before you answered.' },
          });
        } else if (part.type === 'variants' && (part.state === 'building' || part.state === 'awaiting-choice')) {
          this.emit({
            type: 'part-update',
            messageId: turn.assistantMessageId,
            partId: part.id,
            patch: {
              state: 'unanswered',
              reason: reason === 'interrupted' ? 'Stopped before you chose.' : 'The turn ended before you chose.',
              variants: cancelUnbuilt(part.variants),
            },
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

  private addNotice(level: 'info' | 'warning' | 'error', text: string, resetsAt?: string): void {
    if (!this.turn) {
      return;
    }
    const messageId = this.assistantMessageId();
    this.emit({ type: 'part-start', messageId, part: { type: 'notice', id: randomUUID(), level, text, ...(resetsAt ? { resetsAt } : {}) } });
  }

  // -------------------------------------------------------------------------
  // Approvals and checkpoints (§12.1, §12.2)
  // -------------------------------------------------------------------------

  private settleApprovals(reason: ApprovalSweep): void {
    this.gate.settleAll(reason);
  }

  /**
   * What the turn waits on from the user changed (an approval or a question
   * came or was settled). An approval wins the status while both wait: it
   * holds a change back, a question only an answer.
   */
  private waitsChanged(turnId: string): void {
    const turn = this.turn;
    if (!turn || turn.turnId !== turnId || turn.stopping) {
      return;
    }
    const approvalIds = this.gate.pendingApprovalIds(turnId);
    const questionIds = this.gate.pendingQuestionIds(turnId);
    const current = this.statusValue;
    let next: SessionStatus;
    if (approvalIds.length > 0) {
      next = { state: 'awaiting-approval', turnId, approvalIds };
    } else if (questionIds.length > 0) {
      next = { state: 'awaiting-answer', turnId, questionIds };
    } else if (current.state === 'awaiting-approval' || current.state === 'awaiting-answer') {
      next = { state: 'running', turnId };
    } else {
      return;
    }
    // A question settled behind a waiting approval (or the reverse) changes nothing to say.
    if (JSON.stringify(next) !== JSON.stringify(current)) {
      this.setStatus(next);
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
  return kind === 'codex' ? 'Codex' : kind === 'api' ? 'The API agent' : 'Claude Code';
}

/** How a tool call of a cut-off turn ended, for the continue note. */
function toolOutcome(part: ToolPart): string {
  switch (part.state) {
    case 'done':
      return 'done';
    case 'denied':
      return 'declined by the user';
    case 'running':
    case 'awaiting-approval':
      return 'result unknown (the app restarted while it ran)';
    case 'error':
      if (part.approval && !part.approval.decision) {
        return 'not run: it was waiting for the user\'s approval when the app restarted';
      }
      if (part.error === RESTART_TOOL_ERROR) {
        return 'result unknown (the app restarted while it ran)';
      }
      return `failed: ${(part.error ?? 'no reason given').split('\n')[0].slice(0, 160)}`;
  }
}

/** How a question of a cut-off turn ended, for the continue note. */
function questionOutcome(part: QuestionPart): string {
  switch (part.state) {
    case 'answered':
      return 'answered by the user';
    case 'skipped':
      return 'skipped by the user';
    case 'awaiting-answer':
    case 'unanswered':
      return part.reason === RESTART_QUESTION_REASON || part.state === 'awaiting-answer'
        ? 'not answered: it was waiting for the user when the app restarted'
        : 'not answered';
  }
}

/** How a variants card of a cut-off turn ended, for the continue note. */
function variantsOutcome(part: VariantsPart): string {
  switch (part.state) {
    case 'picked':
      return `the user picked "${part.picked ?? ''}"; its write is the write_file call that follows`;
    case 'answered':
      return `the user answered in their own words instead: ${(part.text ?? '').split('\n')[0].slice(0, 160)}`;
    case 'skipped':
      return 'skipped by the user';
    case 'failed':
      return `nothing was written: ${part.reason ?? 'the variants did not build'}`;
    case 'building':
    case 'awaiting-choice':
    case 'unanswered':
      return part.reason === VARIANTS_RESTART_BUILDING_REASON || part.state === 'building'
        ? 'not shown: the app restarted while the variants were building'
        : part.reason === VARIANTS_RESTART_REASON || part.state === 'awaiting-choice'
          ? 'not chosen: it was waiting for the user when the app restarted'
          : 'not chosen';
  }
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
