// The gate every FluidCAD tool call of a chat session passes through
// (docs/agent-chat-plan.md §12.1). It is the `toolGate` of the session's MCP
// server: it classifies the call, reports it as a tool part in the
// transcript, decides whether it runs (asking the user when the class and
// the permission mode say so), keeps a copy of a file before the turn first
// changes it (§12.2), and records what the call returned.
//
// Nothing runs outside a turn the user started and has not stopped: the
// turn is checked when a call arrives, and again after every wait (the
// preview, the approval), so a call that arrives late, or is approved just
// as the user cancels, is refused. Codex keeps an MCP call pending through
// `turn/interrupt` (§19): the session settles pending approvals on cancel.
//
// A change to a model file that waits for approval is also built, without
// being written, so its card shows what it does to the model (§25): the
// preview fills in beside the wait and never holds it.
//
// It also answers the two tools that do not pass through `before`. `ask_user`
// (§22): the question is a card of its own, and the call waits for the user
// the way an approval does. `propose_variants` (§24): the gate builds the
// variants, shows them as a card, waits for the pick and writes the picked
// one itself — the pick is the approval.

import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createTwoFilesPatch, FILE_HEADERS_ONLY } from 'diff';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import {
  TOOL_CLASSES,
  isReadOnlyClass,
  buildCandidate,
  previewSourceEdit,
  resolveCandidate,
  writeFile,
  type AskUserInput,
  type Candidate,
  type McpToolCall,
  type McpToolClass,
  type McpToolGate,
  type McpToolGateDecision,
  type ProposeVariantsInput,
  type RegistryEntry,
  type SourceEditPreview,
} from '../../mcp/dist/server.js';
import type { Checkpoint } from './session-store.ts';
import { AUTO_PREVIEW_MAX_BUILD_MS, ChangePreviewJob, isModelFile } from './change-preview.ts';
import { failure, questionPatch, questionResult, readQuestionReply, readQuestions, type QuestionOutcome } from './questions.ts';
import {
  builtTile,
  candidateRefusal,
  failedVariants,
  json,
  readVariants,
  readVariantsReply,
  toolError,
  variantsPatch,
  variantsResult,
  type VariantsOutcome,
} from './variants.ts';
import type {
  ApprovalDecision,
  ChangePreview,
  ChatEvent,
  ChatPart,
  PermissionMode,
  QuestionItem,
  QuestionPart,
  ToolPart,
  VariantTile,
  VariantsPart,
} from './types.ts';

/** Longest tool output text kept in the transcript. */
const MAX_OUTPUT_CHARS = 20_000;
/** Longest diff kept on a tool part. */
const MAX_DIFF_CHARS = 200_000;
/** How long a call waits for the user before it fails (§12.1; the CLIs' MCP timeouts are an hour too). */
export const APPROVAL_TIMEOUT_MS = 60 * 60 * 1000;
/**
 * How long the engine is left free between the builds of two variants
 * (§24). A build holds the engine's event loop; a page that has just heard
 * a tile is built needs one request served (the build's meshes) to draw its
 * picture, and without the pause that request could wait out the next build.
 */
export const BUILD_PAUSE_MS = 250;

export const NO_TURN_MESSAGE = 'No chat turn is running in FluidCAD, so this tool call was not run.';
export const DECLINED_MESSAGE = 'The user declined this action.';
export const STOPPED_MESSAGE = 'The user stopped the turn, so this action was not run.';
export const TIMED_OUT_MESSAGE =
  'Approval timed out: the user did not answer within an hour, so this action was not run. Do not retry it; ask the user.';
export const CANCELLED_MESSAGE = 'The call was cancelled.';
/**
 * What the model is told when it passes `force: true` to a write. `force`
 * overrides the dirty-buffer refusal, which protects the user's unsaved
 * editor changes: only the user may do that.
 */
export const FORCE_REFUSED_MESSAGE =
  'force is not available here; ask the user to save the file. Nothing was written. Call the tool again without `force` once they have.';

/** The tools whose effect is a change to one workspace file: previewed as a diff, checkpointed before they run. */
const FILE_EDIT_TOOLS = new Set(['write_file', 'edit_range']);
/**
 * The tools that may write the project's package pins (`fluidcad.json`
 * `dependencies`): the file is checkpointed before they run, so reverting
 * the turn puts the pins back. What they installed stays in the library.
 */
const PIN_TOOLS = new Set(['install_package']);
/** The project's configuration file, where the pins are. */
const PROJECT_CONFIG_FILE = 'fluidcad.json';

/** What the gate needs from its session. */
export type ToolGateHost = {
  readonly workspacePath: string;
  /** The engine the session's MCP server is pinned to. */
  pinnedWorkspace(): RegistryEntry;
  /** The running turn, or null when none is or it is being stopped (a call then is refused). */
  activeTurn(): { turnId: string; mode: PermissionMode } | null;
  /** The in-flight assistant message of the active turn, started if needed. */
  assistantMessageId(): string;
  emit(event: ChatEvent): void;
  /** A part of the transcript as it stands now (a variants card: its tiles, with the pictures the page drew). */
  part(messageId: string, partId: string): ChatPart | undefined;
  /** Stores an image under the session's `files/`; returns its name. */
  saveImage(data: Buffer, mimeType: string): string;
  /** Persists the session (a tool call started or ended, §7.5). */
  persist(): void;
  /** The approvals `turnId` waits on changed; empty when none is left. */
  approvalsChanged(turnId: string, approvalIds: string[]): void;
  /** The questions `turnId` waits on changed (variants cards waiting for a choice among them); empty when none is left. */
  questionsChanged(turnId: string, questionIds: string[]): void;
  /**
   * Keeps `checkpoint` for `turnId` unless the turn already has one for that
   * path (§12.2). Returns whether it was taken now. Synchronous.
   */
  checkpoint(turnId: string, checkpoint: Checkpoint): boolean;
  /** Drops the turn's checkpoint of `filePath`: the write it was taken for did not happen. */
  dropCheckpoint(turnId: string, filePath: string): void;
};

/** Timers, injectable for tests. */
export type GateTimers = {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
};

export type ToolGateOptions = {
  /** Default one hour. */
  approvalTimeoutMs?: number;
  timers?: GateTimers;
  /** Default {@link BUILD_PAUSE_MS}. */
  buildPauseMs?: number;
  /** Default {@link AUTO_PREVIEW_MAX_BUILD_MS}: the longest last build of a file whose change is previewed unasked (§25). */
  autoPreviewMaxBuildMs?: number;
};

export type ToolKind = ToolPart['kind'];

/** How a wait for the user ended. */
type ApprovalOutcome = ApprovalDecision | 'stopped' | 'timeout' | 'aborted' | 'shutdown';

/** Why pending approvals are settled without the user's answer. */
export type ApprovalSweep = 'stopped' | 'shutdown';

type PendingApproval = {
  id: string;
  turnId: string;
  name: string;
  canAllowSession: boolean;
  /** The preview of the change the call would make, when it is one to a model file (§25). */
  preview?: ChangePreviewJob;
  settle(outcome: ApprovalOutcome): void;
};

type PendingQuestion = {
  id: string;
  turnId: string;
  questions: QuestionItem[];
  settle(outcome: QuestionOutcome): void;
};

type PendingVariants = {
  id: string;
  turnId: string;
  /** Whether the builds have ended and the card waits for the user; a reply before that is refused. */
  choosing: boolean;
  tiles(): VariantTile[];
  settle(outcome: VariantsOutcome): void;
};

type CallState = {
  messageId: string;
  partId: string;
  turnId: string;
  /** The file the call edits (absolute), when it is a file edit with a preview. */
  file: string | null;
  /** Whether this call took the turn's checkpoint of `file`. */
  checkpointed: boolean;
  /**
   * For a call that may or may not change `file` (an install and the pins):
   * the file as it was. A call that left it so has nothing to revert.
   */
  before?: Checkpoint;
};

/** The class of `name`; undefined for a tool missing from TOOL_CLASSES. */
export function toolClass(name: string): McpToolClass | undefined {
  return Object.hasOwn(TOOL_CLASSES, name) ? TOOL_CLASSES[name] : undefined;
}

export function toolKind(name: string): ToolKind {
  const cls = toolClass(name);
  if (!cls) {
    return 'other';
  }
  if (isReadOnlyClass(cls)) {
    return 'read';
  }
  return cls === 'outside-workspace' ? 'outside' : 'edit';
}

/**
 * Whether a call of `name` waits for the user in `mode` (§12.1): reads never
 * do; workspace edits (files, session and view state) do when the mode is
 * `ask`; anything that reaches outside the workspace, and any tool the table
 * does not know, always does.
 */
export function needsApproval(name: string, mode: PermissionMode): boolean {
  const cls = toolClass(name);
  if (!cls) {
    return true;
  }
  if (isReadOnlyClass(cls)) {
    return false;
  }
  if (cls === 'outside-workspace') {
    return true;
  }
  return mode === 'ask';
}

/** "Allow for this session" is offered for workspace edits only: never outside the workspace, never for an unknown tool. */
export function canAllowForSession(name: string): boolean {
  const cls = toolClass(name);
  return cls === 'edit-files' || cls === 'edit-session';
}

export class ToolGate implements McpToolGate {
  private readonly host: ToolGateHost;
  private readonly calls = new WeakMap<McpToolCall, CallState>();
  private readonly pending = new Map<string, PendingApproval>();
  private readonly pendingQuestions = new Map<string, PendingQuestion>();
  private readonly pendingVariants = new Map<string, PendingVariants>();
  /** Tools the user allowed for the rest of the session. */
  private readonly allowedForSession = new Set<string>();
  private readonly timeoutMs: number;
  private readonly timers: GateTimers;
  private readonly buildPauseMs: number;
  private readonly autoPreviewMaxBuildMs: number;

  constructor(host: ToolGateHost, options: ToolGateOptions = {}) {
    this.host = host;
    this.timeoutMs = options.approvalTimeoutMs ?? APPROVAL_TIMEOUT_MS;
    this.buildPauseMs = options.buildPauseMs ?? BUILD_PAUSE_MS;
    this.autoPreviewMaxBuildMs = options.autoPreviewMaxBuildMs ?? AUTO_PREVIEW_MAX_BUILD_MS;
    this.timers = options.timers ?? {
      setTimeout: (fn, ms) => {
        const handle = setTimeout(fn, ms);
        handle.unref?.();
        return handle;
      },
      clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
    };
  }

  /** Tools allowed for the rest of the session ("Allow for this session"). */
  get sessionAllowedTools(): string[] {
    return [...this.allowedForSession];
  }

  /** Ids of the approvals waiting for the user, oldest first. */
  pendingApprovalIds(turnId?: string): string[] {
    return [...this.pending.values()].filter((p) => turnId === undefined || p.turnId === turnId).map((p) => p.id);
  }

  /** Ids of the questions waiting for the user, oldest first, then of the variants cards waiting for a choice. */
  pendingQuestionIds(turnId?: string): string[] {
    return [
      ...[...this.pendingQuestions.values()].filter((p) => turnId === undefined || p.turnId === turnId).map((p) => p.id),
      ...[...this.pendingVariants.values()].filter((p) => p.choosing && (turnId === undefined || p.turnId === turnId)).map((p) => p.id),
    ];
  }

  /** Ids of the variants cards not settled yet: still building, or waiting for a choice. */
  pendingVariantIds(turnId?: string): string[] {
    return [...this.pendingVariants.values()].filter((p) => turnId === undefined || p.turnId === turnId).map((p) => p.id);
  }

  async before(call: McpToolCall, signal: AbortSignal): Promise<McpToolGateDecision> {
    const turn = this.host.activeTurn();
    if (!turn) {
      // A call after a cancel, or from a CLI the session no longer drives:
      // nothing runs outside a turn the user started.
      return { allow: false, message: NO_TURN_MESSAGE };
    }
    if (FILE_EDIT_TOOLS.has(call.name) && isForced(call.input)) {
      // The instructions forbid it; this enforces it. The card shows the attempt.
      const messageId = this.host.assistantMessageId();
      this.host.emit({
        type: 'part-start',
        messageId,
        part: {
          type: 'tool',
          id: `tool-${randomUUID()}`,
          source: 'fluidcad',
          name: call.name,
          title: toolTitle(call.name, call.input, this.host.workspacePath),
          kind: toolKind(call.name),
          state: 'denied',
          input: call.input ?? {},
          error: 'Refused: the agent may not overwrite unsaved editor changes (`force`).',
        },
      });
      this.host.persist();
      return { allow: false, message: FORCE_REFUSED_MESSAGE };
    }
    let preview: SourceEditPreview | null = null;
    if (FILE_EDIT_TOOLS.has(call.name)) {
      preview = await this.preview(call);
      if (!this.isActive(turn.turnId)) {
        return { allow: false, message: STOPPED_MESSAGE };
      }
    }
    const messageId = this.host.assistantMessageId();
    const rel = preview ? this.relative(preview.absPath) : null;
    const part: ToolPart = {
      type: 'tool',
      id: `tool-${randomUUID()}`,
      source: 'fluidcad',
      name: call.name,
      title: preview && rel && !preview.existed ? `Create ${rel}` : toolTitle(call.name, call.input, this.host.workspacePath),
      kind: toolKind(call.name),
      state: 'running',
      input: call.input ?? {},
      ...(preview && rel ? { diff: unifiedDiff(rel, preview) } : {}),
    };
    this.host.emit({ type: 'part-start', messageId, part });
    const update = (patch: Partial<ToolPart>) => this.host.emit({ type: 'part-update', messageId, partId: part.id, patch });

    if (needsApproval(call.name, turn.mode) && !this.allowedForSession.has(call.name)) {
      // A change to a model file: what it does to the model fills in on the card while it waits (§25).
      const changePreview = preview && isModelFile(preview.absPath)
        ? new ChangePreviewJob(
            {
              pinnedWorkspace: () => this.host.pinnedWorkspace(),
              read: () => {
                const current = this.host.part(messageId, part.id);
                return current?.type === 'tool' ? current.preview : undefined;
              },
              write: (shown: ChangePreview) => update({ preview: shown }),
              persist: () => this.host.persist(),
            },
            preview,
            this.autoPreviewMaxBuildMs,
          )
        : undefined;
      const outcome = await this.waitForApproval(turn.turnId, call.name, update, signal, changePreview);
      if (outcome !== 'allow' && outcome !== 'allow-session') {
        this.host.persist();
        return { allow: false, message: outcomeMessage(outcome) };
      }
    }
    // The turn may have been stopped, or the client may have given up, while
    // the call waited: an approval that lands just as the user cancels must
    // not let the call through.
    if (!this.isActive(turn.turnId)) {
      update({ state: 'error', error: 'Stopped.' });
      this.host.persist();
      return { allow: false, message: STOPPED_MESSAGE };
    }
    if (signal.aborted) {
      update({ state: 'error', error: 'Cancelled.' });
      this.host.persist();
      return { allow: false, message: CANCELLED_MESSAGE };
    }
    // Synchronous from here to the return: nothing can stop the turn in between.
    let checkpointed = false;
    let file: string | null = preview?.absPath ?? null;
    let before: Checkpoint | undefined;
    if (preview || PIN_TOOLS.has(call.name)) {
      try {
        const copy = readCheckpoint(preview ? preview.absPath : projectConfigPath(this.host.workspacePath));
        checkpointed = this.host.checkpoint(turn.turnId, copy);
        if (!preview) {
          file = copy.path;
          before = copy;
        }
      } catch (e) {
        // Without a copy the change could not be reverted: it is not made.
        const message = `FluidCAD could not keep a copy of the file before changing it: ${e instanceof Error ? e.message : String(e)}`;
        update({ state: 'error', error: message });
        this.host.persist();
        return { allow: false, message };
      }
    }
    this.calls.set(call, { messageId, partId: part.id, turnId: turn.turnId, file, checkpointed, ...(before ? { before } : {}) });
    this.host.persist();
    return { allow: true };
  }

  after(call: McpToolCall, result: CallToolResult): void {
    const state = this.calls.get(call);
    if (!state) {
      return;
    }
    this.calls.delete(call);
    const texts: string[] = [];
    const images: string[] = [];
    for (const block of result.content ?? []) {
      if (block.type === 'text') {
        texts.push(block.text);
      } else if (block.type === 'image') {
        try {
          images.push(this.host.saveImage(Buffer.from(block.data, 'base64'), block.mimeType));
        } catch (e) {
          texts.push(`[image not saved: ${e instanceof Error ? e.message : String(e)}]`);
        }
      }
    }
    const text = truncate(texts.join('\n'));
    let patch: Partial<ToolPart>;
    if (result.isError) {
      // A refused or failed write left the file as it was: the copy taken
      // for it is not a change to revert.
      if (state.file && state.checkpointed) {
        try {
          this.host.dropCheckpoint(state.turnId, state.file);
        } catch (e) {
          console.error('[agent] could not drop a checkpoint:', e);
        }
      }
      const failure = parseToolError(text);
      if (failure?.code === 'dirty-buffer') {
        // The model gets the tool's own result unchanged; the card says which file.
        const file = state.file ? this.relative(state.file) : dirtyFileOf(state, failure) ?? 'The file';
        patch = {
          state: 'error',
          errorCode: 'dirty-buffer',
          error: `Not written: ${file} has unsaved changes in the editor. Save it, then ask again.`,
          output: { text },
        };
      } else {
        patch = { state: 'error', error: text || 'The tool failed.', ...(images.length > 0 ? { output: { images } } : {}) };
      }
    } else {
      // An install that left the pins as they were (the package was already
      // used, or no project pins anything) changed no file of the project.
      if (state.file && state.checkpointed && state.before && sameFile(state.before)) {
        try {
          this.host.dropCheckpoint(state.turnId, state.file);
        } catch (e) {
          console.error('[agent] could not drop a checkpoint:', e);
        }
      }
      patch = { state: 'done', output: { ...(text ? { text } : {}), ...(images.length > 0 ? { images } : {}) } };
    }
    this.host.emit({ type: 'part-update', messageId: state.messageId, partId: state.partId, patch });
    this.host.persist();
  }

  /**
   * The user's answer to an approval. `not-found`: no call waits on that id
   * (unknown, or already settled); `not-offered`: "Allow for this session"
   * was asked of a call that does not offer it.
   */
  decide(approvalId: string, decision: ApprovalDecision): 'ok' | 'not-found' | 'not-offered' {
    const pending = this.pending.get(approvalId);
    if (!pending) {
      return 'not-found';
    }
    if (decision === 'allow-session' && !pending.canAllowSession) {
      return 'not-offered';
    }
    if (decision === 'allow-session') {
      this.allowedForSession.add(pending.name);
    }
    pending.settle(decision);
    return 'ok';
  }

  /**
   * The user asked for the preview an approval card offers (§25): the two
   * builds start, and the card fills in. `not-found`: no call waits on that
   * id; `not-offered`: its card offers no preview to build (it has none, or
   * it is building or built already).
   */
  requestPreview(approvalId: string): 'ok' | 'not-found' | 'not-offered' {
    const pending = this.pending.get(approvalId);
    if (!pending) {
      return 'not-found';
    }
    return pending.preview?.request() ? 'ok' : 'not-offered';
  }

  /** Settles every pending approval, question and variants card without the user: the turn was stopped or ended, or the engine is going away. */
  settleAll(reason: ApprovalSweep): void {
    for (const pending of [...this.pending.values()]) {
      pending.settle(reason);
    }
    for (const pending of [...this.pendingQuestions.values()]) {
      pending.settle({ kind: reason });
    }
    for (const pending of [...this.pendingVariants.values()]) {
      pending.settle({ kind: reason });
    }
  }

  /**
   * `ask_user` (§22): shows the questions as a card and waits for the user.
   * Resolves with what the model is told: the answers, that the user
   * skipped, or an error when nobody answered. Nothing is asked outside a
   * running turn.
   */
  async ask(input: AskUserInput, signal: AbortSignal): Promise<CallToolResult> {
    const turn = this.host.activeTurn();
    if (!turn) {
      return failure(NO_TURN_MESSAGE);
    }
    const read = readQuestions(input);
    if (read.ok === false) {
      return failure(read.error);
    }
    const messageId = this.host.assistantMessageId();
    const part: QuestionPart = { type: 'question', id: `question-${randomUUID()}`, state: 'awaiting-answer', questions: read.questions };
    this.host.emit({ type: 'part-start', messageId, part });
    const outcome = await new Promise<QuestionOutcome>((resolve) => {
      let settled = false;
      const onAbort = () => settle({ kind: 'aborted' });
      const timer = this.timers.setTimeout(() => settle({ kind: 'timeout' }), this.timeoutMs);
      const settle = (result: QuestionOutcome) => {
        if (settled) {
          return;
        }
        settled = true;
        this.pendingQuestions.delete(part.id);
        this.timers.clearTimeout(timer);
        signal.removeEventListener('abort', onAbort);
        this.host.emit({ type: 'part-update', messageId, partId: part.id, patch: questionPatch(result) });
        this.host.questionsChanged(turn.turnId, this.pendingQuestionIds(turn.turnId));
        resolve(result);
      };
      this.pendingQuestions.set(part.id, { id: part.id, turnId: turn.turnId, questions: read.questions, settle });
      signal.addEventListener('abort', onAbort, { once: true });
      this.host.questionsChanged(turn.turnId, this.pendingQuestionIds(turn.turnId));
      // Saved while waiting: an engine restart now finds the card and says so.
      this.host.persist();
      if (signal.aborted) {
        settle({ kind: 'aborted' });
      }
    });
    this.host.persist();
    return questionResult(read.questions, outcome, CANCELLED_MESSAGE);
  }

  /**
   * The user's reply to a question (the body of the answer route).
   * `not-found`: no question waits on that id (unknown, or already
   * settled); `invalid`: the reply does not fit the questions.
   */
  answer(questionId: string, body: unknown): { result: 'ok' | 'not-found' } | { result: 'invalid'; error: string } {
    const pending = this.pendingQuestions.get(questionId);
    if (!pending) {
      return { result: 'not-found' };
    }
    const read = readQuestionReply(pending.questions, body);
    if (read.ok === false) {
      return { result: 'invalid', error: read.error };
    }
    pending.settle('skip' in read.reply ? { kind: 'skipped' } : { kind: 'answered', answers: read.reply.answers });
    return { result: 'ok' };
  }

  /**
   * `propose_variants` (§24): checks the two candidates as a write of each
   * would be, shows them as a card, builds them one after the other (each
   * tile fills in as its build ends), waits for the user, and writes the
   * variant they pick. Resolves with what the model is told.
   *
   * The pick is the approval: the write is the gate's own, made the moment
   * the user picks, with the turn's copy of the file taken first — so it is
   * reverted with the turn as any `write_file` of it is — and no approval is
   * asked in any mode. It is refused, as a write is, when the file has
   * unsaved changes in the editor, and when the file is no longer the text
   * the variants were made from. Nothing is shown outside a running turn.
   */
  async propose(input: ProposeVariantsInput, signal: AbortSignal): Promise<CallToolResult> {
    const turn = this.host.activeTurn();
    if (!turn) {
      return failure(NO_TURN_MESSAGE);
    }
    const read = readVariants(input);
    if (read.ok === false) {
      return failure(read.error);
    }
    const pinnedWorkspace = this.host.pinnedWorkspace();
    const candidates: Candidate[] = [];
    for (const [index, variant] of read.variants.entries()) {
      let candidate;
      try {
        // The first check also asks the editor for unsaved changes: a pick could not be written over them.
        candidate = await resolveCandidate({ pinnedWorkspace, path: input.path, ...variant.candidate, refuseDirty: index === 0 }, 'propose_variants');
      } catch (e) {
        return failure(`Variant "${variant.label}": ${e instanceof Error ? e.message : String(e)}`);
      }
      if (candidate.ok === false) {
        return candidateRefusal(variant.label, path.isAbsolute(input.path) ? this.relative(input.path) : input.path, candidate);
      }
      candidates.push(candidate.data);
    }
    if (!this.isActive(turn.turnId)) {
      return failure(STOPPED_MESSAGE);
    }
    const [first, second] = candidates;
    if (first.before !== second.before || first.existed !== second.existed) {
      return failure(`${input.path} changed while the variants were being read. Read it again and call propose_variants again.`);
    }
    if (first.text === second.text) {
      return failure(`"${read.variants[0].label}" and "${read.variants[1].label}" are the same text. Offer two variants that differ, or make the change directly.`);
    }
    const rel = this.relative(first.absPath);
    const question = input.question?.trim();
    const messageId = this.host.assistantMessageId();
    const part: VariantsPart = {
      type: 'variants',
      id: `variants-${randomUUID()}`,
      state: 'building',
      file: rel,
      ...(question ? { question } : {}),
      variants: read.variants.map((variant) => ({
        label: variant.label,
        ...(variant.description ? { description: variant.description } : {}),
        state: 'queued' as const,
      })),
    };
    this.host.emit({ type: 'part-start', messageId, part });
    // The tiles as the transcript holds them: a page may have added a picture since the gate last wrote them.
    const tiles = (): VariantTile[] => {
      const current = this.host.part(messageId, part.id);
      return current?.type === 'variants' ? current.variants : part.variants;
    };
    const update = (patch: Partial<VariantsPart>) => this.host.emit({ type: 'part-update', messageId, partId: part.id, patch });
    const setTile = (index: number, change: (tile: VariantTile) => VariantTile) =>
      update({ variants: tiles().map((tile, i) => (i === index ? change(tile) : tile)) });

    type PickedWrite = { call: McpToolCall; candidate: Candidate; label: string };
    /** Set when the user picked and the write is the gate's to make. */
    const picked: { write: PickedWrite | null } = { write: null };
    let settled: VariantsOutcome | null = null;
    let timer: unknown = null;
    let resolveOutcome: (outcome: VariantsOutcome) => void = () => {};
    const done = new Promise<VariantsOutcome>((resolve) => {
      resolveOutcome = resolve;
    });
    const onAbort = () => settle({ kind: 'aborted' });
    // Synchronous from the reply to the last event: a stop or the end of the
    // turn that settles the card also sweeps the transcript right after.
    const settle = (asked: VariantsOutcome) => {
      if (settled) {
        return;
      }
      let outcome = asked;
      if (outcome.kind === 'picked') {
        const label = outcome.label;
        const candidate = candidates[read.variants.findIndex((variant) => variant.label === label)];
        const start = this.startPickedWrite(turn.turnId, messageId, rel, label, candidate);
        outcome = start.outcome;
        picked.write = start.call ? { call: start.call, candidate, label } : null;
      }
      settled = outcome;
      const pending = this.pendingVariants.get(part.id);
      this.pendingVariants.delete(part.id);
      if (timer !== null) {
        this.timers.clearTimeout(timer);
      }
      signal.removeEventListener('abort', onAbort);
      update(variantsPatch(outcome, tiles(), rel));
      if (picked.write) {
        // The card first, then the write it led to.
        this.startWritePart(picked.write, messageId, rel);
      }
      if (pending?.choosing) {
        this.host.questionsChanged(turn.turnId, this.pendingQuestionIds(turn.turnId));
      }
      resolveOutcome(outcome);
    };
    const pending: PendingVariants = { id: part.id, turnId: turn.turnId, choosing: false, tiles, settle };
    this.pendingVariants.set(part.id, pending);
    signal.addEventListener('abort', onAbort, { once: true });
    // Saved before the first build: an engine a build takes down finds the card and says so.
    this.host.persist();
    if (signal.aborted) {
      settle({ kind: 'aborted' });
    }

    // The builds, one after the other: each is a full build that holds the engine.
    for (let index = 0; index < candidates.length && !settled; index++) {
      setTile(index, (tile) => ({ ...tile, state: 'building' }));
      let built;
      try {
        built = await buildCandidate({ pinnedWorkspace, absPath: candidates[index].absPath, text: candidates[index].text });
      } catch (e) {
        built = { ok: false as const, code: 'internal' as const, message: e instanceof Error ? e.message : String(e) };
      }
      if (settled) {
        // Stopped while it built: the card already says so, and the tile stays as it was left.
        break;
      }
      setTile(index, (tile) => builtTile(tile, built));
      this.host.persist();
      if (index < candidates.length - 1 && this.buildPauseMs > 0) {
        // The engine is free for a moment: a page fetches the build it just heard of, to draw its tile.
        await new Promise<void>((resolve) => {
          setTimeout(resolve, this.buildPauseMs).unref?.();
        });
      }
    }
    if (!settled) {
      if (!tiles().some((tile) => tile.state === 'ready')) {
        settle({ kind: 'none-built' });
      } else {
        pending.choosing = true;
        timer = this.timers.setTimeout(() => settle({ kind: 'timeout' }), this.timeoutMs);
        update({ state: 'awaiting-choice' });
        this.host.questionsChanged(turn.turnId, this.pendingQuestionIds(turn.turnId));
        // Saved while waiting: an engine restart now finds the card and says so.
        this.host.persist();
      }
    }

    const outcome = await done;
    this.host.persist();
    if (outcome.kind !== 'picked') {
      return variantsResult(outcome, tiles(), rel, CANCELLED_MESSAGE);
    }
    if (!picked.write) {
      return failure(`The user picked "${outcome.label}", but it was not written.`);
    }
    const { call, candidate, label } = picked.write;
    let written;
    try {
      written = await writeFile({ pinnedWorkspace, path: candidate.absPath, content: candidate.text });
    } catch (e) {
      written = { ok: false as const, code: 'internal' as const, message: e instanceof Error ? e.message : String(e) };
    }
    // The write's own card ends as a write_file's does: the render, or the refusal (and the turn's copy is dropped).
    this.after(call, written.ok === false ? toolError({ code: written.code, message: written.message, details: written.details }) : json(written.data));
    if (written.ok === false) {
      return toolError({
        code: written.code,
        message: `The user picked "${label}", but it was not written: ${written.message}`,
        ...(written.details !== undefined ? { details: written.details } : {}),
      });
    }
    return json({ picked: label, render: written.data.render, ...failedVariants(tiles()) });
  }

  /**
   * The user's reply to a variants card (the body of its route).
   * `not-found`: no card waits on that id (unknown, or already settled);
   * `building`: its variants are not built yet; `invalid`: the reply does
   * not fit the card.
   */
  choose(variantsId: string, body: unknown): { result: 'ok' | 'not-found' | 'building' } | { result: 'invalid'; error: string } {
    const pending = this.pendingVariants.get(variantsId);
    if (!pending) {
      return { result: 'not-found' };
    }
    if (!pending.choosing) {
      return { result: 'building' };
    }
    const read = readVariantsReply(pending.tiles(), body);
    if (read.ok === false) {
      return { result: 'invalid', error: read.error };
    }
    const reply = read.reply;
    pending.settle('skip' in reply ? { kind: 'skipped' } : 'pick' in reply ? { kind: 'picked', label: reply.pick } : { kind: 'answered', text: reply.text });
    return { result: 'ok' };
  }

  // -------------------------------------------------------------------------

  private isActive(turnId: string): boolean {
    return this.host.activeTurn()?.turnId === turnId;
  }

  private async preview(call: McpToolCall): Promise<SourceEditPreview | null> {
    try {
      const input = (call.input && typeof call.input === 'object' ? call.input : {}) as Record<string, unknown>;
      const result = await previewSourceEdit(call.name as 'write_file' | 'edit_range', {
        ...(input as any),
        pinnedWorkspace: this.host.pinnedWorkspace(),
      });
      // An input the tool will refuse has no preview: the call still asks, runs and fails there.
      return result.ok ? result.data : null;
    } catch (e) {
      console.error('[agent] previewing an edit failed:', e);
      return null;
    }
  }

  private waitForApproval(
    turnId: string,
    name: string,
    update: (patch: Partial<ToolPart>) => void,
    signal: AbortSignal,
    preview?: ChangePreviewJob,
  ): Promise<ApprovalOutcome> {
    const id = randomUUID();
    const canAllowSession = canAllowForSession(name);
    update({ state: 'awaiting-approval', approval: { id, canAllowSession } });
    return new Promise<ApprovalOutcome>((resolve) => {
      let settled = false;
      const onAbort = () => settle('aborted');
      const timer = this.timers.setTimeout(() => settle('timeout'), this.timeoutMs);
      const settle = (outcome: ApprovalOutcome) => {
        if (settled) {
          return;
        }
        settled = true;
        this.pending.delete(id);
        this.timers.clearTimeout(timer);
        signal.removeEventListener('abort', onAbort);
        // The preview ends with the wait, whatever ended it: a build that has not started is not started.
        const unfinished = preview?.cancel();
        update({ ...outcomePatch(outcome, { id, canAllowSession }), ...(unfinished ? { preview: unfinished } : {}) });
        this.host.approvalsChanged(turnId, this.pendingApprovalIds(turnId));
        resolve(outcome);
      };
      this.pending.set(id, { id, turnId, name, canAllowSession, ...(preview ? { preview } : {}), settle });
      signal.addEventListener('abort', onAbort, { once: true });
      this.host.approvalsChanged(turnId, this.pendingApprovalIds(turnId));
      // Saved while waiting: an engine restart now finds the card and says so.
      this.host.persist();
      if (signal.aborted) {
        settle('aborted');
        return;
      }
      // After the card is out and saved: the preview is never in the way of either.
      preview?.start();
    });
  }

  /**
   * The user picked `label`: decides, synchronously, whether its write goes
   * ahead. The file must still be the text the variants were made from (a
   * tile shows a build of that text with the variant's change; written over
   * anything else it would undo what changed since), and the turn's copy of
   * it is taken before it changes (§12.2). `call` is what the write's tool
   * part and its end are recorded under.
   */
  private startPickedWrite(
    turnId: string,
    messageId: string,
    rel: string,
    label: string,
    candidate: Candidate,
  ): { outcome: VariantsOutcome; call?: McpToolCall } {
    let now: Checkpoint;
    try {
      now = readCheckpoint(candidate.absPath);
    } catch (e) {
      return { outcome: { kind: 'no-copy', label, message: `FluidCAD could not read ${rel} before changing it: ${e instanceof Error ? e.message : String(e)}` } };
    }
    if (now.existed !== candidate.existed || now.content !== candidate.before) {
      return { outcome: { kind: 'stale', label } };
    }
    let checkpointed: boolean;
    try {
      checkpointed = this.host.checkpoint(turnId, now);
    } catch (e) {
      // Without a copy the change could not be reverted: it is not made.
      return { outcome: { kind: 'no-copy', label, message: `FluidCAD could not keep a copy of ${rel} before changing it: ${e instanceof Error ? e.message : String(e)}` } };
    }
    const call: McpToolCall = { name: 'write_file', input: { path: rel, variant: label } };
    this.calls.set(call, { messageId, partId: `tool-${randomUUID()}`, turnId, file: candidate.absPath, checkpointed });
    return { outcome: { kind: 'picked', label }, call };
  }

  /** The tool part of a picked variant's write: a `write_file` card with its diff, running. */
  private startWritePart(write: { call: McpToolCall; candidate: Candidate; label: string }, messageId: string, rel: string): void {
    const state = this.calls.get(write.call);
    if (!state) {
      return;
    }
    this.host.emit({
      type: 'part-start',
      messageId,
      part: {
        type: 'tool',
        id: state.partId,
        source: 'fluidcad',
        name: 'write_file',
        title: `Apply "${write.label}" to ${rel}`,
        kind: 'edit',
        state: 'running',
        input: write.call.input,
        diff: unifiedDiff(rel, { existed: write.candidate.existed, before: write.candidate.before, after: write.candidate.text }),
      },
    });
  }

  private relative(absPath: string): string {
    return relativeTo(this.host.workspacePath, absPath);
  }
}

/** `absPath` relative to the workspace, with `/` separators; as given when it lies outside. */
export function relativeTo(workspacePath: string, absPath: string): string {
  let root = workspacePath;
  try {
    root = fs.realpathSync(root);
  } catch {
    // Keep it as given.
  }
  const rel = path.relative(root, absPath);
  return rel === '' || rel.startsWith('..') || path.isAbsolute(rel) ? absPath : rel.split(path.sep).join('/');
}

function outcomePatch(outcome: ApprovalOutcome, approval: { id: string; canAllowSession: boolean }): Partial<ToolPart> {
  switch (outcome) {
    case 'allow':
    case 'allow-session':
      return { state: 'running', approval: { ...approval, decision: outcome } };
    case 'deny':
      return { state: 'denied', approval: { ...approval, decision: 'deny' }, error: 'Declined.' };
    case 'stopped':
      return { state: 'denied', approval: { ...approval, decision: 'deny' }, error: 'Stopped before you answered.' };
    case 'shutdown':
      return { state: 'denied', approval: { ...approval, decision: 'deny' }, error: 'The app closed before you answered.' };
    case 'timeout':
      return { state: 'error', error: 'Approval timed out.' };
    case 'aborted':
      return { state: 'error', error: 'Cancelled.' };
  }
}

function outcomeMessage(outcome: Exclude<ApprovalOutcome, 'allow' | 'allow-session'>): string {
  switch (outcome) {
    case 'deny':
      return DECLINED_MESSAGE;
    case 'stopped':
    case 'shutdown':
      return STOPPED_MESSAGE;
    case 'timeout':
      return TIMED_OUT_MESSAGE;
    case 'aborted':
      return CANCELLED_MESSAGE;
  }
}

/** Whether a write's input asks to override the dirty-buffer refusal (any truthy `force`). */
function isForced(input: unknown): boolean {
  return !!input && typeof input === 'object' && !!(input as Record<string, unknown>).force;
}

/** The file as it is now: what a revert puts back (§12.2). */
function readCheckpoint(absPath: string): Checkpoint {
  try {
    return { path: absPath, existed: true, content: fs.readFileSync(absPath, 'utf8') };
  } catch (e: any) {
    if (e?.code === 'ENOENT') {
      return { path: absPath, existed: false, content: '' };
    }
    throw e;
  }
}

/** `<workspace>/fluidcad.json`, canonical, as the file tools resolve a workspace path. */
function projectConfigPath(workspacePath: string): string {
  let root = workspacePath;
  try {
    root = fs.realpathSync(root);
  } catch {
    // Keep it as given.
  }
  return path.join(root, PROJECT_CONFIG_FILE);
}

/** Whether the file is still what `before` recorded: there or not, with the same text. */
function sameFile(before: Checkpoint): boolean {
  try {
    const now = readCheckpoint(before.path);
    return now.existed === before.existed && now.content === before.content;
  } catch {
    // Unreadable now: keep the copy.
    return false;
  }
}

/** A unified diff of the file now against what the call would write. */
export function unifiedDiff(rel: string, preview: Pick<SourceEditPreview, 'existed' | 'before' | 'after'>): string {
  const diff = createTwoFilesPatch(
    preview.existed ? `a/${rel}` : '/dev/null',
    `b/${rel}`,
    preview.before,
    preview.after,
    undefined,
    undefined,
    { context: 3, headerOptions: FILE_HEADERS_ONLY },
  );
  return diff.length > MAX_DIFF_CHARS ? `${diff.slice(0, MAX_DIFF_CHARS)}\n…` : diff;
}

/** The `{ code, message, details }` a FluidCAD tool error carries, when it is one. */
function parseToolError(text: string): { code: string; message?: string; details?: any } | null {
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed.code === 'string' ? parsed : null;
  } catch {
    return null;
  }
}

function dirtyFileOf(_state: CallState, failure: { details?: any }): string | null {
  const files = failure.details?.dirtyFiles;
  return Array.isArray(files) && typeof files[0] === 'string' ? files[0] : null;
}

/** A short title for a FluidCAD tool call, in the user's terms. */
export function toolTitle(name: string, input: unknown, workspacePath: string): string {
  const i = (input && typeof input === 'object' ? input : {}) as Record<string, any>;
  const rel = (p: unknown): string | null => {
    if (typeof p !== 'string' || p === '') {
      return null;
    }
    const relative = path.isAbsolute(p) ? path.relative(workspacePath, p) : p;
    return relative.startsWith('..') ? p : relative.split(path.sep).join('/');
  };
  switch (name) {
    case 'get_scene_summary':
      return 'Read the scene summary';
    case 'list_shapes':
      return 'List shapes';
    case 'get_compile_error':
      return 'Check for a compile error';
    case 'list_global_params':
      return 'List project parameters';
    case 'get_shape_properties':
    case 'get_face_properties':
    case 'get_edge_properties':
      return 'Read geometry properties';
    case 'resolve_selection':
      return 'Resolve a selection';
    case 'validate':
      return 'Validate the model';
    case 'try_build':
      return rel(i.path) ? `Try a build of ${rel(i.path)}` : 'Try a build';
    case 'interfere':
      return 'Check for interference';
    case 'measure':
      return 'Measure';
    case 'hit_test':
      return 'Hit-test the view';
    case 'screenshot':
    case 'screenshot_multi':
    case 'screenshot_shape':
      return 'Take a screenshot';
    case 'get_camera_state':
      return 'Read the camera';
    case 'wait_for_idle':
      return 'Wait for the render';
    case 'list_fluid_files':
      return 'List model files';
    case 'read_file':
      return rel(i.path) ? `Read ${rel(i.path)}` : 'Read a file';
    case 'write_file':
      return rel(i.path) ? `Write ${rel(i.path)}` : 'Write a file';
    case 'edit_range': {
      const file = rel(i.path) ?? 'a file';
      // Positions are 0-based; the title counts lines from 1, as editors do.
      const start = typeof i.start?.line === 'number' ? i.start.line + 1 : null;
      const end = typeof i.end?.line === 'number' ? i.end.line + 1 : null;
      if (start === null) {
        return `Edit ${file}`;
      }
      return end !== null && end !== start ? `Edit ${file}, lines ${start}–${end}` : `Edit ${file}, line ${start}`;
    }
    case 'list_docs':
    case 'read_doc':
    case 'search_docs':
    case 'get_api_signature':
    case 'get_type_definition':
      return i.name || i.id || i.query ? `Read the docs: ${i.name ?? i.id ?? i.query}` : 'Read the docs';
    case 'list_skills':
    case 'read_skill':
      return i.name ? `Read the ${i.name} skill` : 'Read the skills';
    case 'list_workspaces':
      return 'Check the workspace';
    case 'recompute':
      return 'Re-render the model';
    case 'select_configuration':
      return i.name ? `Switch to the ${i.name} configuration` : 'Switch configuration';
    case 'rollback_to':
      return 'Roll the timeline back';
    case 'add_breakpoint':
      return 'Add a breakpoint';
    case 'clear_breakpoints':
      return 'Clear breakpoints';
    case 'import_step':
      return 'Import a STEP file';
    case 'export':
      return 'Export shapes';
    case 'pack':
      return 'Pack the package';
    case 'search_hub':
      return typeof i.query === 'string' && i.query.trim() !== '' ? `Search the hub: ${i.query.trim()}` : 'Browse the hub';
    case 'get_hub_package':
      return i.name ? `Read ${i.name}${i.version ? ` ${i.version}` : ''} on the hub` : 'Read a hub package';
    case 'list_packages':
      return i.name ? `Read the installed ${i.name}` : 'List the packages';
    case 'read_package_file':
      return i.name && i.path ? `Read ${i.path} of ${i.name}` : 'Read a package file';
    case 'install_package': {
      const what = i.name ? `${i.name}${i.version ? `@${i.version}` : ''}` : 'a package';
      const where = i.target === 'project' ? ' into this project' : '';
      return i.upgrade === true ? `Upgrade to ${what} from the hub${where}` : `Install ${what} from the hub${where}`;
    }
    default:
      return name.replace(/_/g, ' ');
  }
}

function truncate(text: string): string {
  return text.length > MAX_OUTPUT_CHARS ? `${text.slice(0, MAX_OUTPUT_CHARS)}\n…` : text;
}
