// The gate every FluidCAD tool call of a chat session passes through
// (docs/agent-chat-plan.md §12.1). It is the `toolGate` of the session's MCP
// server: it classifies the call, reports it as a tool part in the
// transcript, decides whether it runs, and records what it returned.
//
// Phase 2 runs the read classes and denies everything else. Approval
// (phase 4) plugs in at `decide()`: hold the call there with an approval id,
// set the part and the session status to `awaiting-approval`, and resolve
// on the user's answer, a cancel or `signal`.

import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { TOOL_CLASSES, isReadOnlyClass, type McpToolCall, type McpToolClass, type McpToolGate, type McpToolGateDecision } from '../../mcp/dist/server.js';
import type { ChatEvent, PermissionMode, ToolPart } from './types.ts';

/** Longest tool output text kept in the transcript. */
const MAX_OUTPUT_CHARS = 20_000;

/** What the gate needs from its session. */
export type ToolGateHost = {
  readonly workspacePath: string;
  /** The running turn, or null when none is (a call then is refused). */
  activeTurn(): { turnId: string; mode: PermissionMode } | null;
  /** The in-flight assistant message of the active turn, started if needed. */
  assistantMessageId(): string;
  emit(event: ChatEvent): void;
  /** Stores an image under the session's `files/`; returns its name. */
  saveImage(data: Buffer, mimeType: string): string;
  /** Persists the session (a tool call started or ended, §7.5). */
  persist(): void;
};

export type ToolKind = ToolPart['kind'];

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

/** The message a denied edit answers the model with while edits are off (phase 2). */
export function editsUnavailableMessage(name: string): string {
  return (
    `FluidCAD did not run ${name}: changing the project from the chat is not available in this version; ` +
    'only reading is. Do not retry it. Tell the user the change you would make (the file and the code), ' +
    'so they can apply it themselves.'
  );
}

export const NO_TURN_MESSAGE = 'No chat turn is running in FluidCAD, so this tool call was not run.';

type CallState = { messageId: string; partId: string };

export class ToolGate implements McpToolGate {
  private readonly host: ToolGateHost;
  private readonly calls = new WeakMap<McpToolCall, CallState>();

  constructor(host: ToolGateHost) {
    this.host = host;
  }

  async before(call: McpToolCall, signal: AbortSignal): Promise<McpToolGateDecision> {
    const turn = this.host.activeTurn();
    if (!turn) {
      // A call after a cancel, or from a CLI the session no longer drives:
      // nothing runs outside a turn the user started.
      return { allow: false, message: NO_TURN_MESSAGE };
    }
    const messageId = this.host.assistantMessageId();
    const part: ToolPart = {
      type: 'tool',
      id: `tool-${randomUUID()}`,
      source: 'fluidcad',
      name: call.name,
      title: toolTitle(call.name, call.input, this.host.workspacePath),
      kind: toolKind(call.name),
      state: 'running',
      input: call.input ?? {},
    };
    this.host.emit({ type: 'part-start', messageId, part });

    const decision = this.decide(call, turn.mode);
    if (decision.allow === false) {
      this.host.emit({ type: 'part-update', messageId, partId: part.id, patch: { state: 'denied', error: decision.message } });
      this.host.persist();
      return decision;
    }
    if (signal.aborted) {
      this.host.emit({ type: 'part-update', messageId, partId: part.id, patch: { state: 'error', error: 'Cancelled.' } });
      this.host.persist();
      return { allow: false, message: 'The call was cancelled.' };
    }
    this.calls.set(call, { messageId, partId: part.id });
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
    const patch: Partial<ToolPart> = result.isError
      ? { state: 'error', error: text || 'The tool failed.', ...(images.length > 0 ? { output: { images } } : {}) }
      : { state: 'done', output: { ...(text ? { text } : {}), ...(images.length > 0 ? { images } : {}) } };
    this.host.emit({ type: 'part-update', messageId: state.messageId, partId: state.partId, patch });
    this.host.persist();
  }

  /**
   * Whether a call runs. Phase 2: the read classes do; everything else,
   * unknown tools included, is denied. Phase 4 replaces the denial with the
   * approval flow of §12.1 (ask / auto-edits per `mode`).
   */
  private decide(call: McpToolCall, _mode: PermissionMode): McpToolGateDecision {
    const cls = toolClass(call.name);
    if (cls && isReadOnlyClass(cls)) {
      return { allow: true };
    }
    return { allow: false, message: editsUnavailableMessage(call.name) };
  }
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
