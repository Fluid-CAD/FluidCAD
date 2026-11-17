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

import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createTwoFilesPatch, FILE_HEADERS_ONLY } from 'diff';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import {
  TOOL_CLASSES,
  isReadOnlyClass,
  previewSourceEdit,
  type McpToolCall,
  type McpToolClass,
  type McpToolGate,
  type McpToolGateDecision,
  type RegistryEntry,
  type SourceEditPreview,
} from '../../mcp/dist/server.js';
import type { Checkpoint } from './session-store.ts';
import type { ApprovalDecision, ChatEvent, PermissionMode, ToolPart } from './types.ts';

/** Longest tool output text kept in the transcript. */
const MAX_OUTPUT_CHARS = 20_000;
/** Longest diff kept on a tool part. */
const MAX_DIFF_CHARS = 200_000;
/** How long a call waits for the user before it fails (§12.1; the CLIs' MCP timeouts are an hour too). */
export const APPROVAL_TIMEOUT_MS = 60 * 60 * 1000;

export const NO_TURN_MESSAGE = 'No chat turn is running in FluidCAD, so this tool call was not run.';
export const DECLINED_MESSAGE = 'The user declined this action.';
export const STOPPED_MESSAGE = 'The user stopped the turn, so this action was not run.';
export const TIMED_OUT_MESSAGE =
  'Approval timed out: the user did not answer within an hour, so this action was not run. Do not retry it; ask the user.';
export const CANCELLED_MESSAGE = 'The call was cancelled.';

/** The tools whose effect is a change to one workspace file: previewed as a diff, checkpointed before they run. */
const FILE_EDIT_TOOLS = new Set(['write_file', 'edit_range']);

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
  /** Stores an image under the session's `files/`; returns its name. */
  saveImage(data: Buffer, mimeType: string): string;
  /** Persists the session (a tool call started or ended, §7.5). */
  persist(): void;
  /** The approvals `turnId` waits on changed; empty when none is left. */
  approvalsChanged(turnId: string, approvalIds: string[]): void;
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
  settle(outcome: ApprovalOutcome): void;
};

type CallState = {
  messageId: string;
  partId: string;
  turnId: string;
  /** The file the call edits (absolute), when it is a file edit with a preview. */
  file: string | null;
  /** Whether this call took the turn's checkpoint of `file`. */
  checkpointed: boolean;
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
  /** Tools the user allowed for the rest of the session. */
  private readonly allowedForSession = new Set<string>();
  private readonly timeoutMs: number;
  private readonly timers: GateTimers;

  constructor(host: ToolGateHost, options: ToolGateOptions = {}) {
    this.host = host;
    this.timeoutMs = options.approvalTimeoutMs ?? APPROVAL_TIMEOUT_MS;
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

  async before(call: McpToolCall, signal: AbortSignal): Promise<McpToolGateDecision> {
    const turn = this.host.activeTurn();
    if (!turn) {
      // A call after a cancel, or from a CLI the session no longer drives:
      // nothing runs outside a turn the user started.
      return { allow: false, message: NO_TURN_MESSAGE };
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
      const outcome = await this.waitForApproval(turn.turnId, call.name, update, signal);
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
    if (preview) {
      try {
        checkpointed = this.host.checkpoint(turn.turnId, readCheckpoint(preview.absPath));
      } catch (e) {
        // Without a copy the change could not be reverted: it is not made.
        const message = `FluidCAD could not keep a copy of the file before changing it: ${e instanceof Error ? e.message : String(e)}`;
        update({ state: 'error', error: message });
        this.host.persist();
        return { allow: false, message };
      }
    }
    this.calls.set(call, { messageId, partId: part.id, turnId: turn.turnId, file: preview?.absPath ?? null, checkpointed });
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

  /** Settles every pending approval without the user: the turn was stopped or ended, or the engine is going away. */
  settleAll(reason: ApprovalSweep): void {
    for (const pending of [...this.pending.values()]) {
      pending.settle(reason);
    }
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
        update(outcomePatch(outcome, { id, canAllowSession }));
        this.host.approvalsChanged(turnId, this.pendingApprovalIds(turnId));
        resolve(outcome);
      };
      this.pending.set(id, { id, turnId, name, canAllowSession, settle });
      signal.addEventListener('abort', onAbort, { once: true });
      this.host.approvalsChanged(turnId, this.pendingApprovalIds(turnId));
      // Saved while waiting: an engine restart now finds the card and says so.
      this.host.persist();
      if (signal.aborted) {
        settle('aborted');
      }
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
    default:
      return name.replace(/_/g, ' ');
  }
}

function truncate(text: string): string {
  return text.length > MAX_OUTPUT_CHARS ? `${text.slice(0, MAX_OUTPUT_CHARS)}\n…` : text;
}
