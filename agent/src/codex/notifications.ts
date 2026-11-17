// Maps the notifications of one `codex app-server` thread to BackendEvents
// (docs/agent-chat-plan.md §5.2, §6.3, §19).
//
// The set of notifications and item types is open; anything not handled here
// is ignored. `mcpToolCall` items for FluidCAD's own server are dropped: the
// gate reports those calls. Codex's other items (commands, file changes, web
// searches, …) become the agent's own tool cards. An interrupted turn never
// completes the MCP call it was in (§19), so the cards still open when a turn
// ends are closed here.

import type { BackendEvent, TurnError } from '../backend.ts';
import type { JsonRpcNotification } from './json-rpc.ts';
import { FLUIDCAD_MCP_SERVER } from './thread-config.ts';

/** Longest tool output kept for a card. */
const MAX_TOOL_OUTPUT_CHARS = 20_000;

type ToolEvent = Extract<BackendEvent, { type: 'tool' }>;
type TurnEnd = Extract<BackendEvent, { type: 'turn-end' }>;

type RateWindow = { usedPercent?: number; resetsAt?: number | null };
type RateLimits = { primary?: RateWindow | null; secondary?: RateWindow | null };
type TokenTotals = { inputTokens: number; outputTokens: number };

export class CodexEventMapper {
  /** The thread this mapper follows; notifications for others are ignored. */
  readonly threadId: string;
  /** Set when the run asked for an interrupt: the turn then ends as interrupted. */
  interrupting = false;

  private active = false;
  private turnIdValue: string | null = null;
  /** The agent's own tool cards started and not yet finished, by item id. */
  private readonly openTools = new Map<string, { name: string; title: string; input: unknown }>();
  /** Items whose text arrived as deltas, by item id. */
  private readonly streamed = new Set<string>();
  /** Reasoning items with a summary, and the summary part each is on. */
  private readonly summaryParts = new Map<string, number>();
  private retryNoticed = false;
  private compactionNoticed = false;
  private lastError: TurnError | null = null;
  private rateLimits: RateLimits = {};
  /** Token totals of the thread before this turn, and the latest seen in it. */
  private totalsBefore: TokenTotals | null = null;
  private totalsNow: TokenTotals | null = null;
  private latestTotals: TokenTotals | null = null;

  constructor(threadId: string) {
    this.threadId = threadId;
  }

  get turnId(): string | null {
    return this.turnIdValue;
  }

  get isActive(): boolean {
    return this.active;
  }

  /** A turn was asked for (`turn/start` sent); its id comes with the answer or `turn/started`. */
  beginTurn(): void {
    this.active = true;
    this.turnIdValue = null;
    this.interrupting = false;
    this.openTools.clear();
    this.streamed.clear();
    this.summaryParts.clear();
    this.retryNoticed = false;
    this.compactionNoticed = false;
    this.lastError = null;
    this.totalsBefore = this.latestTotals;
    this.totalsNow = null;
  }

  /** The answer to `turn/start` names the turn. */
  setTurnId(turnId: string): void {
    if (this.active && !this.turnIdValue) {
      this.turnIdValue = turnId;
    }
  }

  /** An account-wide rate-limit update (sparse: merged into what is known). */
  onRateLimits(snapshot: any): void {
    if (!snapshot || typeof snapshot !== 'object') {
      return;
    }
    for (const key of ['primary', 'secondary'] as const) {
      if (snapshot[key] && typeof snapshot[key] === 'object') {
        this.rateLimits[key] = { ...(this.rateLimits[key] ?? {}), ...snapshot[key] };
      }
    }
  }

  push(message: JsonRpcNotification): BackendEvent[] {
    const p = message.params;
    if (!p || typeof p !== 'object') {
      return [];
    }
    if (message.method === 'account/rateLimits/updated') {
      this.onRateLimits(p.rateLimits);
      return [];
    }
    if (typeof p.threadId === 'string' && p.threadId !== this.threadId) {
      return [];
    }
    if (message.method === 'thread/tokenUsage/updated') {
      this.onTokenUsage(p);
      return [];
    }
    if (!this.active) {
      return [];
    }
    const turnId: string | null = typeof p.turnId === 'string' ? p.turnId : typeof p.turn?.id === 'string' ? p.turn.id : null;
    if (message.method === 'turn/started') {
      if (!this.turnIdValue && turnId) {
        this.turnIdValue = turnId;
      }
      return [];
    }
    if (turnId && this.turnIdValue && turnId !== this.turnIdValue) {
      // A turn this run no longer follows (one it ended locally, say).
      return [];
    }
    switch (message.method) {
      case 'item/agentMessage/delta':
        return this.onTextDelta(p);
      case 'item/reasoning/summaryPartAdded':
        return this.onSummaryPart(p);
      case 'item/reasoning/summaryTextDelta':
        return this.onReasoningDelta(p, true);
      case 'item/reasoning/textDelta':
        return this.onReasoningDelta(p, false);
      case 'item/started':
        return this.onItem(p.item, 'started');
      case 'item/completed':
        return this.onItem(p.item, 'completed');
      case 'error':
        return this.onError(p);
      // `warning` is not shown: what 0.162.1 sends there is about the user's
      // config.toml or transport fallbacks it recovers from on its own.
      case 'thread/compacted':
        return this.compactionNotice();
      case 'model/rerouted':
        return typeof p.toModel === 'string'
          ? [{ type: 'notice', level: 'info', text: `Codex answered with ${p.toModel} instead of ${p.fromModel ?? 'the chosen model'}.` }]
          : [];
      case 'turn/completed':
        return this.onTurnCompleted(p.turn);
      default:
        return [];
    }
  }

  /**
   * Ends the turn without Codex (it did not answer the interrupt, or it
   * exited): open cards close, and the turn ends as `reason`.
   */
  endLocally(reason: TurnEnd['reason'], error?: TurnError): BackendEvent[] {
    if (!this.active) {
      return [];
    }
    const out = this.closeOpenTools(reason === 'interrupted' ? 'Stopped.' : 'The turn ended before this finished.');
    out.push(error ? { type: 'turn-end', reason, error } : { type: 'turn-end', reason });
    this.active = false;
    return out;
  }

  // -------------------------------------------------------------------------

  private onTextDelta(p: any): BackendEvent[] {
    if (typeof p.itemId !== 'string' || typeof p.delta !== 'string' || p.delta === '') {
      return [];
    }
    this.streamed.add(p.itemId);
    return [{ type: 'text-delta', id: p.itemId, delta: p.delta }];
  }

  private onSummaryPart(p: any): BackendEvent[] {
    if (typeof p.itemId !== 'string') {
      return [];
    }
    const index = typeof p.summaryIndex === 'number' ? p.summaryIndex : 0;
    const previous = this.summaryParts.get(p.itemId);
    this.summaryParts.set(p.itemId, index);
    // A later summary part is a new paragraph of the same reasoning.
    return previous !== undefined && index !== previous ? [{ type: 'reasoning-delta', id: p.itemId, delta: '\n\n' }] : [];
  }

  private onReasoningDelta(p: any, summary: boolean): BackendEvent[] {
    if (typeof p.itemId !== 'string' || typeof p.delta !== 'string' || p.delta === '') {
      return [];
    }
    if (summary) {
      if (!this.summaryParts.has(p.itemId)) {
        this.summaryParts.set(p.itemId, typeof p.summaryIndex === 'number' ? p.summaryIndex : 0);
      }
    } else if (this.summaryParts.has(p.itemId)) {
      // Raw reasoning is shown only when no summary comes for the item.
      return [];
    }
    this.streamed.add(p.itemId);
    return [{ type: 'reasoning-delta', id: p.itemId, delta: p.delta }];
  }

  private onItem(item: any, phase: 'started' | 'completed'): BackendEvent[] {
    if (!item || typeof item !== 'object' || typeof item.id !== 'string') {
      return [];
    }
    switch (item.type) {
      case 'agentMessage': {
        if (phase === 'started') {
          return [];
        }
        const out: BackendEvent[] = [];
        if (!this.streamed.has(item.id) && typeof item.text === 'string' && item.text !== '') {
          // No deltas came for it: the whole text at once.
          out.push({ type: 'text-delta', id: item.id, delta: item.text });
        }
        if (this.streamed.has(item.id) || out.length > 0) {
          out.push({ type: 'block-end', id: item.id });
        }
        return out;
      }
      case 'reasoning': {
        // Codex starts many reasoning items with no summary at all: a part
        // opens with the first delta only.
        if (phase === 'started') {
          return [];
        }
        const out: BackendEvent[] = [];
        if (!this.streamed.has(item.id)) {
          const summary = Array.isArray(item.summary) ? item.summary.filter((s: unknown) => typeof s === 'string' && s !== '') : [];
          if (summary.length > 0) {
            out.push({ type: 'reasoning-delta', id: item.id, delta: summary.join('\n\n') });
          }
        }
        if (this.streamed.has(item.id) || out.length > 0) {
          out.push({ type: 'block-end', id: item.id });
        }
        return out;
      }
      case 'contextCompaction':
        return phase === 'completed' ? this.compactionNotice() : [];
      default: {
        if (item.type === 'mcpToolCall' && item.server === FLUIDCAD_MCP_SERVER) {
          return [];
        }
        const tool = toolOfItem(item, phase);
        if (!tool) {
          return [];
        }
        if (tool.state === 'running') {
          this.openTools.set(tool.id, { name: tool.name, title: tool.title, input: tool.input });
        } else {
          this.openTools.delete(tool.id);
        }
        return [tool];
      }
    }
  }

  private onError(p: any): BackendEvent[] {
    const error = p.error;
    if (!error || typeof error !== 'object') {
      return [];
    }
    if (p.willRetry === true) {
      // Codex retries on its own (five times over a few seconds); once per turn is enough to say so.
      if (this.retryNoticed) {
        return [];
      }
      this.retryNoticed = true;
      const detail = typeof error.message === 'string' && error.message !== '' ? ` (${error.message})` : '';
      return [{ type: 'notice', level: 'info', text: `Codex is retrying a request to OpenAI${detail}.` }];
    }
    this.lastError = mapCodexError(error, this.rateLimits);
    return [];
  }

  private onTokenUsage(p: any): void {
    const total = p.tokenUsage?.total;
    if (!total || typeof total.inputTokens !== 'number' || typeof total.outputTokens !== 'number') {
      return;
    }
    const totals = { inputTokens: total.inputTokens, outputTokens: total.outputTokens };
    this.latestTotals = totals;
    if (this.active && typeof p.turnId === 'string' && this.turnIdValue && p.turnId === this.turnIdValue) {
      this.totalsNow = totals;
    } else if (this.active && !this.totalsNow) {
      // The thread's totals as a resumed thread reports them, before this turn's first request.
      this.totalsBefore = totals;
    }
  }

  private onTurnCompleted(turn: any): BackendEvent[] {
    const status = turn?.status;
    if (status !== 'completed' && status !== 'interrupted' && status !== 'failed') {
      return [];
    }
    let end: TurnEnd;
    if (this.interrupting || status === 'interrupted') {
      end = { type: 'turn-end', reason: 'interrupted' };
    } else if (status === 'failed') {
      const error = turn.error && typeof turn.error === 'object' ? mapCodexError(turn.error, this.rateLimits) : this.lastError;
      end = { type: 'turn-end', reason: 'error', error: error ?? { kind: 'other', message: 'Codex ended the turn with an error.' } };
    } else {
      end = { type: 'turn-end', reason: 'done' };
    }
    const out = this.closeOpenTools(end.reason === 'interrupted' ? 'Stopped.' : 'The turn ended before this finished.');
    const usage = this.turnUsage();
    if (usage) {
      out.push(usage);
    }
    out.push(end);
    this.active = false;
    this.interrupting = false;
    return out;
  }

  private turnUsage(): BackendEvent | null {
    const now = this.totalsNow;
    if (!now) {
      return null;
    }
    const before = this.totalsBefore ?? { inputTokens: 0, outputTokens: 0 };
    return {
      type: 'usage',
      inputTokens: Math.max(0, now.inputTokens - before.inputTokens),
      outputTokens: Math.max(0, now.outputTokens - before.outputTokens),
    };
  }

  private closeOpenTools(error: string): BackendEvent[] {
    const out: BackendEvent[] = [];
    for (const [id, tool] of this.openTools) {
      out.push({ type: 'tool', id, name: tool.name, title: tool.title, state: 'error', error });
    }
    this.openTools.clear();
    return out;
  }

  private compactionNotice(): BackendEvent[] {
    if (this.compactionNoticed) {
      return [];
    }
    this.compactionNoticed = true;
    return [{ type: 'notice', level: 'info', text: 'Codex compacted the conversation to fit its context window.' }];
  }
}

/**
 * A Codex turn error in the session's terms (§9.4, §19): a used-up plan and
 * rate limiting are `rate-limit`; a missing or expired login is `auth`, which
 * Codex reports as `unauthorized` or as an HTTP 401 from the API.
 */
export function mapCodexError(error: any, rateLimits: RateLimits = {}): TurnError {
  const vendor = typeof error?.message === 'string' && error.message.trim() !== '' ? error.message.trim() : '';
  const info = error?.codexErrorInfo;
  if (info === 'usageLimitExceeded') {
    const resetsAt = exhaustedResetsAt(rateLimits);
    const when = resetsAt ? ` It resets at ${resetsAt}.` : '';
    return {
      kind: 'rate-limit',
      message: `${vendor || "Codex reached your ChatGPT plan's usage limit."}${when}`,
      ...(resetsAt ? { resetsAt } : {}),
    };
  }
  if (info === 'rateLimitExceeded') {
    return { kind: 'rate-limit', message: vendor || 'Codex is being rate limited. Try again in a moment.' };
  }
  if (info === 'unauthorized' || httpStatusOf(info) === 401) {
    return {
      kind: 'auth',
      message: 'Codex is not signed in, or its login expired. Run `codex login` in a terminal, then try again.',
    };
  }
  return { kind: 'other', message: vendor || 'Codex ended the turn with an error.' };
}

/** The HTTP status a `codexErrorInfo` variant carries (`{ httpConnectionFailed: { httpStatusCode } }`, …). */
function httpStatusOf(info: unknown): number | null {
  if (!info || typeof info !== 'object') {
    return null;
  }
  for (const value of Object.values(info as Record<string, unknown>)) {
    const code = (value as any)?.httpStatusCode;
    if (typeof code === 'number') {
      return code;
    }
  }
  return null;
}

/** When the used-up window resets, from the latest rate-limit update; undefined when none is used up. */
function exhaustedResetsAt(limits: RateLimits): string | undefined {
  const resets = [limits.primary, limits.secondary]
    .filter((w): w is RateWindow => !!w && typeof w.usedPercent === 'number' && w.usedPercent >= 100 && typeof w.resetsAt === 'number')
    .map((w) => w.resetsAt as number);
  if (resets.length === 0) {
    return undefined;
  }
  const seconds = Math.max(...resets);
  return new Date((seconds > 1e12 ? seconds : seconds * 1000)).toISOString();
}

/** One of Codex's own items as a tool card, or null for items that are not tools. */
export function toolOfItem(item: any, phase: 'started' | 'completed'): ToolEvent | null {
  const id = String(item.id);
  const str = (v: unknown) => (typeof v === 'string' && v !== '' ? v : null);
  switch (item.type) {
    case 'commandExecution': {
      const command = str(item.command) ?? 'a command';
      const base = { type: 'tool' as const, id, name: 'command', title: `Run ${clip(command)}`, input: { command: item.command, cwd: item.cwd } };
      if (phase === 'started' || item.status === 'inProgress') {
        return { ...base, state: 'running' };
      }
      const output = truncate(str(item.aggregatedOutput) ?? '');
      if (item.status === 'completed' && (item.exitCode === 0 || item.exitCode === null || item.exitCode === undefined)) {
        return { ...base, state: 'done', output };
      }
      const why = item.status === 'declined' ? 'Declined.' : `Failed${typeof item.exitCode === 'number' ? ` (exit code ${item.exitCode})` : ''}.`;
      return { ...base, state: 'error', error: output ? `${why}\n${output}` : why };
    }
    case 'fileChange': {
      const paths = Array.isArray(item.changes) ? item.changes.map((c: any) => str(c?.path)).filter(Boolean) : [];
      const base = {
        type: 'tool' as const,
        id,
        name: 'apply_patch',
        title: paths.length > 0 ? `Change ${paths.join(', ')}` : 'Change files',
        input: { changes: Array.isArray(item.changes) ? item.changes.map((c: any) => ({ path: c?.path, kind: c?.kind })) : [] },
      };
      if (phase === 'started' || item.status === 'inProgress') {
        return { ...base, state: 'running' };
      }
      if (item.status === 'completed') {
        return { ...base, state: 'done' };
      }
      return { ...base, state: 'error', error: item.status === 'declined' ? 'Declined.' : 'Not applied.' };
    }
    case 'mcpToolCall': {
      const server = str(item.server) ?? 'mcp';
      const tool = str(item.tool) ?? 'tool';
      const base = { type: 'tool' as const, id, name: `${server}.${tool}`, title: `${server}: ${tool.replace(/_/g, ' ')}`, input: item.arguments ?? {} };
      if (phase === 'started' || item.status === 'inProgress') {
        return { ...base, state: 'running' };
      }
      const text = truncate(mcpResultText(item.result));
      if (item.status === 'completed') {
        return { ...base, state: 'done', output: text };
      }
      return { ...base, state: 'error', error: str(item.error?.message) ?? (text || 'The tool failed.') };
    }
    case 'dynamicToolCall': {
      const tool = str(item.tool) ?? 'tool';
      const base = { type: 'tool' as const, id, name: tool, title: tool.replace(/_/g, ' '), input: item.arguments ?? {} };
      if (phase === 'started' || item.status === 'inProgress') {
        return { ...base, state: 'running' };
      }
      return item.status === 'completed' && item.success !== false ? { ...base, state: 'done' } : { ...base, state: 'error', error: 'The tool failed.' };
    }
    case 'webSearch': {
      const query = str(item.query) ?? str(item.action?.query);
      const base = { type: 'tool' as const, id, name: 'web_search', title: query ? `Search the web: ${clip(query)}` : 'Search the web', input: { query } };
      return phase === 'started' ? { ...base, state: 'running' } : { ...base, state: 'done' };
    }
    case 'imageView': {
      const base = { type: 'tool' as const, id, name: 'view_image', title: str(item.path) ? `View ${item.path}` : 'View an image', input: { path: item.path } };
      return phase === 'started' ? { ...base, state: 'running' } : { ...base, state: 'done' };
    }
    default:
      return null;
  }
}

function mcpResultText(result: any): string {
  const content = result?.content;
  if (!Array.isArray(content)) {
    return '';
  }
  return content
    .map((b: any) => (b?.type === 'text' && typeof b.text === 'string' ? b.text : b?.type === 'image' ? '[image]' : ''))
    .filter((s: string) => s !== '')
    .join('\n');
}

function clip(text: string): string {
  const line = text.replace(/\s+/g, ' ').trim();
  return line.length > 80 ? `${line.slice(0, 79)}…` : line;
}

function truncate(text: string): string {
  return text.length > MAX_TOOL_OUTPUT_CHARS ? `${text.slice(0, MAX_TOOL_OUTPUT_CHARS)}\n…` : text;
}
