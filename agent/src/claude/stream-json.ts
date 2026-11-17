// Maps Claude Code's stream-json output (`claude -p --output-format
// stream-json --verbose --include-partial-messages`) to BackendEvents.
//
// One JSON object per line; the set of types is open and anything not
// handled here is ignored (docs/agent-chat-plan.md §5.1, §19). Tool calls to
// FluidCAD's own MCP server (`mcp__fluidcad_app__*`) are dropped, both the
// `tool_use` block and its `tool_result`: the gate reports those.

import type { BackendEvent, TurnError } from '../backend.ts';

export const FLUIDCAD_MCP_SERVER = 'fluidcad_app';
const FLUIDCAD_TOOL_PREFIX = `mcp__${FLUIDCAD_MCP_SERVER}__`;
/** Longest tool output kept for a card. */
const MAX_TOOL_OUTPUT_CHARS = 20_000;

type Block = { kind: 'text' | 'thinking' | 'tool'; id: string; dropped?: boolean; name?: string; json?: string };

export type ClaudeInit = {
  sessionId: string | null;
  version: string | null;
  model: string | null;
  /** Status of FluidCAD's MCP server in the init message; null when it is not listed. */
  mcpStatus: string | null;
};

export class ClaudeStreamMapper {
  /** Set by the run when it asked for an interrupt: the turn's `result` then ends it as interrupted. */
  interrupting = false;
  /** The latest `init` (one per turn). */
  init: ClaudeInit | null = null;

  private messageId = 'm0';
  private messageCount = 0;
  private readonly blocks = new Map<number, Block>();
  /** Tool calls the stream dropped (FluidCAD's), by tool_use id. */
  private readonly droppedTools = new Set<string>();
  /** The CLI's own tool calls, by tool_use id → name. */
  private readonly agentTools = new Map<string, string>();
  /** The error the assistant message carried in this turn. */
  private assistantError: TurnError | null = null;
  /** A rejected rate limit seen in this turn. */
  private rateLimit: TurnError | null = null;
  /** Rate-limit warnings already shown, by window, so each shows once per process. */
  private readonly warned = new Set<string>();

  /** Parses one stdout line; non-JSON lines are ignored. */
  pushLine(line: string): BackendEvent[] {
    const trimmed = line.trim();
    if (trimmed === '') {
      return [];
    }
    let msg: unknown;
    try {
      msg = JSON.parse(trimmed);
    } catch {
      return [];
    }
    return this.push(msg);
  }

  push(msg: any): BackendEvent[] {
    if (!msg || typeof msg !== 'object') {
      return [];
    }
    switch (msg.type) {
      case 'system':
        return this.onSystem(msg);
      case 'stream_event':
        return this.onStreamEvent(msg);
      case 'assistant':
        return this.onAssistant(msg);
      case 'user':
        return this.onUser(msg);
      case 'rate_limit_event':
        return this.onRateLimit(msg);
      case 'result':
        return this.onResult(msg);
      default:
        // keep_alive, tool_progress, control_response, …
        return [];
    }
  }

  private onSystem(msg: any): BackendEvent[] {
    switch (msg.subtype) {
      case 'init': {
        const servers: any[] = Array.isArray(msg.mcp_servers) ? msg.mcp_servers : [];
        const ours = servers.find((s) => s?.name === FLUIDCAD_MCP_SERVER);
        this.init = {
          sessionId: typeof msg.session_id === 'string' ? msg.session_id : null,
          version: typeof msg.claude_code_version === 'string' ? msg.claude_code_version : null,
          model: typeof msg.model === 'string' ? msg.model : null,
          mcpStatus: ours ? String(ours.status) : null,
        };
        return [];
      }
      case 'compact_boundary':
        return [{ type: 'notice', level: 'info', text: 'Claude Code compacted the conversation to fit its context window.' }];
      case 'api_retry': {
        const attempt = typeof msg.attempt === 'number' ? ` (attempt ${msg.attempt})` : '';
        return [{ type: 'notice', level: 'warning', text: `Claude Code is retrying a request to the API${attempt}.` }];
      }
      default:
        return [];
    }
  }

  private onStreamEvent(msg: any): BackendEvent[] {
    const event = msg.event;
    if (!event || typeof event !== 'object') {
      return [];
    }
    switch (event.type) {
      case 'message_start': {
        this.messageCount += 1;
        const apiId = typeof event.message?.id === 'string' ? event.message.id : null;
        this.messageId = apiId ?? `m${this.messageCount}`;
        this.blocks.clear();
        return [];
      }
      case 'content_block_start': {
        const block = event.content_block;
        const index = Number(event.index);
        const id = `${this.messageId}:${index}`;
        if (!block || typeof block !== 'object') {
          return [];
        }
        if (block.type === 'text') {
          this.blocks.set(index, { kind: 'text', id });
          return [];
        }
        if (block.type === 'thinking' || block.type === 'redacted_thinking') {
          this.blocks.set(index, { kind: 'thinking', id });
          // Thinking may carry no text at all: an empty delta opens the
          // part so the page can show that the model is thinking.
          return [{ type: 'reasoning-delta', id, delta: '' }];
        }
        if (block.type === 'tool_use' || block.type === 'server_tool_use') {
          const name = String(block.name ?? '');
          const toolId = String(block.id ?? id);
          if (name.startsWith(FLUIDCAD_TOOL_PREFIX)) {
            this.droppedTools.add(toolId);
            this.blocks.set(index, { kind: 'tool', id: toolId, dropped: true, name });
            return [];
          }
          this.agentTools.set(toolId, name);
          this.blocks.set(index, { kind: 'tool', id: toolId, name, json: '' });
          return [{ type: 'tool', id: toolId, name, title: agentToolTitle(name, undefined), state: 'running' }];
        }
        return [];
      }
      case 'content_block_delta': {
        const block = this.blocks.get(Number(event.index));
        const delta = event.delta;
        if (!block || !delta) {
          return [];
        }
        if (delta.type === 'text_delta' && block.kind === 'text' && typeof delta.text === 'string' && delta.text !== '') {
          return [{ type: 'text-delta', id: block.id, delta: delta.text }];
        }
        if (delta.type === 'thinking_delta' && block.kind === 'thinking' && typeof delta.thinking === 'string' && delta.thinking !== '') {
          return [{ type: 'reasoning-delta', id: block.id, delta: delta.thinking }];
        }
        if (delta.type === 'input_json_delta' && block.kind === 'tool' && !block.dropped && typeof delta.partial_json === 'string') {
          block.json = (block.json ?? '') + delta.partial_json;
        }
        return [];
      }
      case 'content_block_stop': {
        const index = Number(event.index);
        const block = this.blocks.get(index);
        if (!block) {
          return [];
        }
        if (block.kind === 'tool') {
          if (block.dropped) {
            return [];
          }
          const input = parseJson(block.json);
          return [{ type: 'tool', id: block.id, name: block.name, title: agentToolTitle(block.name, input), state: 'running', input }];
        }
        return [{ type: 'block-end', id: block.id }];
      }
      default:
        return [];
    }
  }

  private onAssistant(msg: any): BackendEvent[] {
    if (typeof msg.error === 'string' && msg.error !== '') {
      this.assistantError = assistantError(msg.error, messageText(msg.message));
    }
    return [];
  }

  private onUser(msg: any): BackendEvent[] {
    const content = msg.message?.content;
    if (!Array.isArray(content)) {
      return [];
    }
    const out: BackendEvent[] = [];
    for (const block of content) {
      if (block?.type !== 'tool_result') {
        continue;
      }
      const toolId = String(block.tool_use_id ?? '');
      if (this.droppedTools.has(toolId)) {
        continue;
      }
      const name = this.agentTools.get(toolId);
      if (name === undefined) {
        continue;
      }
      const text = truncate(toolResultText(block.content));
      if (block.is_error === true) {
        out.push({ type: 'tool', id: toolId, name, title: agentToolTitle(name, undefined), state: 'error', error: text });
      } else {
        out.push({ type: 'tool', id: toolId, name, title: agentToolTitle(name, undefined), state: 'done', output: text });
      }
    }
    return out;
  }

  private onRateLimit(msg: any): BackendEvent[] {
    const info = msg.rate_limit_info;
    if (!info || typeof info !== 'object') {
      return [];
    }
    const resetsAt = epochToIso(info.resetsAt);
    const window = typeof info.rateLimitType === 'string' ? info.rateLimitType : 'usage';
    if (info.errorCode === 'credits_required') {
      this.rateLimit = {
        kind: 'rate-limit',
        message: 'Claude Code reports that credits are required to continue.',
        ...(resetsAt ? { resetsAt } : {}),
      };
      return [];
    }
    if (info.status === 'rejected') {
      this.rateLimit = {
        kind: 'rate-limit',
        message: `Claude Code reached your plan's ${windowLabel(window)} usage limit.`,
        ...(resetsAt ? { resetsAt } : {}),
      };
      return [];
    }
    if (info.status === 'allowed_warning' && !this.warned.has(window)) {
      this.warned.add(window);
      const used = typeof info.utilization === 'number' ? `, ${Math.round(info.utilization * 100)}% used` : '';
      return [
        {
          type: 'notice',
          level: 'warning',
          text: `Claude Code warns about your plan's ${windowLabel(window)} usage limit${used}.`,
          ...(resetsAt ? { resetsAt } : {}),
        },
      ];
    }
    return [];
  }

  private onResult(msg: any): BackendEvent[] {
    const out: BackendEvent[] = [];
    const usage = msg.usage;
    if (usage && typeof usage === 'object') {
      const input = sumNumbers(usage.input_tokens, usage.cache_creation_input_tokens, usage.cache_read_input_tokens);
      out.push({
        type: 'usage',
        ...(input !== undefined ? { inputTokens: input } : {}),
        ...(typeof usage.output_tokens === 'number' ? { outputTokens: usage.output_tokens } : {}),
        ...(typeof msg.total_cost_usd === 'number' ? { costUsd: msg.total_cost_usd } : {}),
      });
    }
    const failed = msg.is_error === true || (typeof msg.subtype === 'string' && msg.subtype !== 'success');
    if (this.interrupting) {
      out.push({ type: 'turn-end', reason: 'interrupted' });
    } else if (failed) {
      const error =
        this.assistantError ??
        this.rateLimit ??
        { kind: 'other' as const, message: resultMessage(msg) };
      // A rate limit is the better explanation of an assistant `rate_limit` error: it has the reset time.
      const best = error.kind === 'rate-limit' && this.rateLimit ? this.rateLimit : error;
      out.push({ type: 'turn-end', reason: 'error', error: best });
    } else {
      out.push({ type: 'turn-end', reason: 'done' });
    }
    this.interrupting = false;
    this.assistantError = null;
    this.rateLimit = null;
    return out;
  }
}

/** A short title for one of the CLI's own tools. */
export function agentToolTitle(name: string, input: unknown): string {
  const i = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === 'string' && v !== '' ? v : null);
  switch (name) {
    case 'Read':
      return str(i.file_path) ? `Read ${str(i.file_path)}` : 'Read a file';
    case 'Glob':
      return str(i.pattern) ? `Find files: ${str(i.pattern)}` : 'Find files';
    case 'Grep':
      return str(i.pattern) ? `Search: ${str(i.pattern)}` : 'Search files';
    default:
      return name;
  }
}

function assistantError(code: string, text: string): TurnError {
  switch (code) {
    case 'authentication_failed':
      return {
        kind: 'auth',
        message: `Claude Code is not signed in${text ? ` (${text})` : ''}. Run \`claude auth login\` in a terminal, then try again.`,
      };
    case 'rate_limit':
      return { kind: 'rate-limit', message: text || 'Claude Code reached a usage limit.' };
    case 'billing_error':
      return { kind: 'rate-limit', message: text || 'Claude Code reports a billing problem with the account.' };
    default:
      return { kind: 'other', message: text ? `${text} (${code})` : `Claude Code reported an error: ${code}.` };
  }
}

function resultMessage(msg: any): string {
  if (typeof msg.result === 'string' && msg.result !== '') {
    return msg.result;
  }
  if (Array.isArray(msg.errors) && msg.errors.length > 0) {
    return msg.errors.map(String).join('; ');
  }
  return `Claude Code ended the turn with ${msg.subtype ?? 'an error'}.`;
}

function messageText(message: any): string {
  const content = message?.content;
  if (!Array.isArray(content)) {
    return '';
  }
  return content
    .filter((b: any) => b?.type === 'text' && typeof b.text === 'string')
    .map((b: any) => b.text)
    .join('\n')
    .trim();
}

function toolResultText(content: unknown): string {
  if (typeof content === 'string') {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .map((b: any) => (b?.type === 'text' && typeof b.text === 'string' ? b.text : b?.type === 'image' ? '[image]' : ''))
      .filter((s) => s !== '')
      .join('\n');
  }
  return '';
}

function truncate(text: string): string {
  return text.length > MAX_TOOL_OUTPUT_CHARS ? `${text.slice(0, MAX_TOOL_OUTPUT_CHARS)}\n…` : text;
}

function parseJson(text: string | undefined): unknown {
  if (!text) {
    return {};
  }
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

function epochToIso(value: unknown): string | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return undefined;
  }
  // Seconds in the recordings; tolerate milliseconds.
  const ms = value > 1e12 ? value : value * 1000;
  return new Date(ms).toISOString();
}

function windowLabel(window: string): string {
  switch (window) {
    case 'five_hour':
      return 'five-hour';
    case 'seven_day':
      return 'weekly';
    case 'seven_day_opus':
      return 'weekly Opus';
    default:
      return window.replace(/_/g, ' ');
  }
}

function sumNumbers(...values: unknown[]): number | undefined {
  const numbers = values.filter((v): v is number => typeof v === 'number' && Number.isFinite(v));
  return numbers.length > 0 ? numbers.reduce((a, b) => a + b, 0) : undefined;
}
