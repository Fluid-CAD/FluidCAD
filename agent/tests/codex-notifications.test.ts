import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import type { BackendEvent } from '../src/backend.ts';
import { CodexEventMapper, mapCodexError, toolOfItem } from '../src/codex/notifications.ts';

// The mapper on lines recorded from codex-cli 0.162.1 (phase 0, scrubbed),
// replayed as the run feeds it: `turn/start` begins a turn, its answer names
// the turn, `turn/interrupt` marks it interrupting, notifications go in.

type Line = { t: number; dir: 'in' | 'out'; msg: any };

function lines(name: string): Line[] {
  return fs
    .readFileSync(path.join(import.meta.dirname, 'fixtures', name), 'utf8')
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l) => JSON.parse(l));
}

/** Replays a recording through one mapper; returns its events, split by turn. */
function replay(name: string): { threadId: string; turns: BackendEvent[][] } {
  const recorded = lines(name);
  let threadId: string | null = null;
  for (const { dir, msg } of recorded) {
    if (dir === 'out' && msg.method === 'turn/start') {
      threadId = msg.params.threadId;
      break;
    }
  }
  if (!threadId) {
    throw new Error(`no turn in ${name}`);
  }
  const mapper = new CodexEventMapper(threadId);
  const turns: BackendEvent[][] = [];
  const turnStartIds = new Set<number>();
  for (const { dir, msg } of recorded) {
    if (dir === 'out') {
      if (msg.method === 'turn/start') {
        mapper.beginTurn();
        turnStartIds.add(msg.id);
        turns.push([]);
      } else if (msg.method === 'turn/interrupt') {
        mapper.interrupting = true;
      }
      continue;
    }
    if (msg.id !== undefined && msg.method === undefined) {
      if (turnStartIds.has(msg.id) && msg.result?.turn?.id) {
        mapper.setTurnId(msg.result.turn.id);
      }
      continue;
    }
    if (msg.method === undefined || msg.id !== undefined) {
      continue;
    }
    const events = mapper.push({ method: msg.method, params: msg.params });
    if (turns.length > 0) {
      turns[turns.length - 1].push(...events);
    } else {
      expect(events, `${msg.method} before any turn`).toEqual([]);
    }
  }
  return { threadId, turns };
}

const texts = (events: BackendEvent[], type: 'text-delta' | 'reasoning-delta') => {
  const byId = new Map<string, string>();
  for (const e of events) {
    if (e.type === type) {
      byId.set(e.id, (byId.get(e.id) ?? '') + e.delta);
    }
  }
  return [...byId.values()];
};

const finalTexts = (name: string) =>
  lines(name)
    .filter((l) => l.dir === 'in' && l.msg.method === 'item/completed' && l.msg.params.item.type === 'agentMessage')
    .map((l) => l.msg.params.item.text);

describe('CodexEventMapper on recorded turns', () => {
  it('streams reasoning summaries and the answer, reports the turn\'s usage, and ends the turn', () => {
    const { turns } = replay('codex-tools.jsonl');
    expect(turns).toHaveLength(1);
    const events = turns[0];
    expect(texts(events, 'reasoning-delta')).toEqual([
      '**Listing available tool namespaces and functions**\n\n**Clarifying callable tool namespaces and functions**',
    ]);
    expect(texts(events, 'text-delta')).toEqual(finalTexts('codex-tools.jsonl'));
    expect(events.filter((e) => e.type === 'block-end')).toHaveLength(2);
    expect(events.filter((e) => e.type === 'usage')).toEqual([{ type: 'usage', inputTokens: 15503, outputTokens: 320 }]);
    expect(events[events.length - 1]).toEqual({ type: 'turn-end', reason: 'done' });
    // Nothing unknown leaks through (the config.toml warning included): only these event types.
    expect(new Set(events.map((e) => e.type))).toEqual(new Set(['reasoning-delta', 'text-delta', 'block-end', 'usage', 'turn-end']));
  });

  it('drops FluidCAD\'s own MCP calls (the gate reports them) and keeps commentary and the answer apart', () => {
    for (const name of ['codex-screenshot.jsonl', 'codex-slow.jsonl']) {
      const { turns } = replay(name);
      const events = turns.flat();
      expect(events.filter((e) => e.type === 'tool'), name).toEqual([]);
      expect(texts(events, 'text-delta'), name).toEqual(finalTexts(name));
      expect(events[events.length - 1], name).toEqual({ type: 'turn-end', reason: 'done' });
    }
    // Reasoning items without a summary open no part.
    const slow = replay('codex-slow.jsonl').turns[0];
    const reasoningIds = new Set(slow.filter((e) => e.type === 'reasoning-delta').map((e: any) => e.id));
    const withSummary = lines('codex-slow.jsonl').filter(
      (l) => l.msg.method === 'item/completed' && l.msg.params.item.type === 'reasoning' && l.msg.params.item.summary.length > 0,
    );
    expect(reasoningIds.size).toBe(withSummary.length);
  });

  it('ends an interrupted turn as interrupted although its MCP call never completes, and the next turn runs', () => {
    const { turns } = replay('codex-interrupt.jsonl');
    expect(turns).toHaveLength(2);
    expect(turns[0].filter((e) => e.type === 'tool')).toEqual([]);
    expect(turns[0][turns[0].length - 1]).toEqual({ type: 'turn-end', reason: 'interrupted' });
    expect(texts(turns[1], 'text-delta')).toEqual(['ok']);
    expect(turns[1][turns[1].length - 1]).toEqual({ type: 'turn-end', reason: 'done' });
  });

  it('counts a resumed thread\'s usage from where the thread stood before the turn', () => {
    const { turns } = replay('codex-resume.jsonl');
    expect(turns[0].filter((e) => e.type === 'usage')).toEqual([{ type: 'usage', inputTokens: 463722 - 435021, outputTokens: 2256 - 2250 }]);
    expect(texts(turns[0], 'text-delta')).toEqual(['Magenta']);
  });

  it('reports a missing login (retries, then HTTP 401) as an auth error, with one retry notice', () => {
    const { turns } = replay('codex-not-signed-in.jsonl');
    const events = turns[0];
    expect(events.filter((e) => e.type === 'notice')).toEqual([
      { type: 'notice', level: 'info', text: 'Codex is retrying a request to OpenAI (Reconnecting... 2/5).' },
    ]);
    expect(events[events.length - 1]).toEqual({
      type: 'turn-end',
      reason: 'error',
      error: { kind: 'auth', message: 'Codex is not signed in, or its login expired. Run `codex login` in a terminal, then try again.' },
    });
  });
});

describe('CodexEventMapper on synthetic items', () => {
  const T = 'thread-1';
  const started = (item: object, turnId = 'turn-1') => ({ method: 'item/started', params: { threadId: T, turnId, item } });
  const completed = (item: object, turnId = 'turn-1') => ({ method: 'item/completed', params: { threadId: T, turnId, item } });
  const turnCompleted = (status: string, error: object | null = null, turnId = 'turn-1') => ({
    method: 'turn/completed',
    params: { threadId: T, turn: { id: turnId, status, error, items: [] } },
  });
  const mapper = () => {
    const m = new CodexEventMapper(T);
    m.beginTurn();
    m.setTurnId('turn-1');
    return m;
  };

  it('shows Codex\'s own tools as cards: commands, file changes, web searches, other MCP servers', () => {
    const m = mapper();
    const command = { type: 'commandExecution', id: 'c1', command: 'ls -la', cwd: '/p', status: 'inProgress', aggregatedOutput: null, exitCode: null };
    expect(m.push(started(command))).toEqual([
      { type: 'tool', id: 'c1', name: 'command', title: 'Run ls -la', state: 'running', input: { command: 'ls -la', cwd: '/p' } },
    ]);
    expect(m.push(completed({ ...command, status: 'completed', aggregatedOutput: 'a.js\n', exitCode: 0 }))).toEqual([
      { type: 'tool', id: 'c1', name: 'command', title: 'Run ls -la', state: 'done', input: { command: 'ls -la', cwd: '/p' }, output: 'a.js\n' },
    ]);
    const patch = { type: 'fileChange', id: 'f1', changes: [{ path: '/p/a.js', kind: 'update', diff: '…' }], status: 'inProgress' };
    m.push(started(patch));
    expect(m.push(completed({ ...patch, status: 'failed' }))[0]).toMatchObject({ name: 'apply_patch', title: 'Change /p/a.js', state: 'error', error: 'Not applied.' });
    expect(m.push(completed({ type: 'webSearch', id: 'w1', query: 'fillet radius', action: null }))[0]).toMatchObject({
      name: 'web_search',
      title: 'Search the web: fillet radius',
      state: 'done',
    });
    const figma = { type: 'mcpToolCall', id: 'm1', server: 'figma', tool: 'get_file', status: 'inProgress', arguments: { id: 1 }, result: null, error: null };
    expect(m.push(started(figma))[0]).toMatchObject({ name: 'figma.get_file', title: 'figma: get file', state: 'running', input: { id: 1 } });
    expect(
      m.push(completed({ ...figma, status: 'completed', result: { content: [{ type: 'text', text: 'ok' }, { type: 'image', data: 'x', mimeType: 'image/png' }] } }))[0],
    ).toMatchObject({ state: 'done', output: 'ok\n[image]' });
    // FluidCAD's own calls never become cards here.
    expect(m.push(started({ ...figma, id: 'm2', server: 'fluidcad_app', tool: 'write_file' }))).toEqual([]);
    expect(m.push(completed({ ...figma, id: 'm2', server: 'fluidcad_app', tool: 'write_file', status: 'completed' }))).toEqual([]);
    // Items that are not tools say nothing.
    expect(m.push(started({ type: 'userMessage', id: 'u1', content: [] }))).toEqual([]);
    expect(m.push(completed({ type: 'plan', id: 'p1', text: 'step' }))).toEqual([]);
    expect(toolOfItem({ type: 'hookPrompt', id: 'h' }, 'completed')).toBeNull();
  });

  it('closes the cards still open when the turn ends, interrupted or not', () => {
    const m = mapper();
    m.push(started({ type: 'commandExecution', id: 'c1', command: 'sleep 100', status: 'inProgress' }));
    m.push(started({ type: 'mcpToolCall', id: 'm1', server: 'figma', tool: 'slow', status: 'inProgress', arguments: {} }));
    // FluidCAD's call in flight is the gate's to close.
    m.push(started({ type: 'mcpToolCall', id: 'm2', server: 'fluidcad_app', tool: 'write_file', status: 'inProgress', arguments: {} }));
    m.interrupting = true;
    const events = m.push(turnCompleted('interrupted'));
    expect(events).toEqual([
      { type: 'tool', id: 'c1', name: 'command', title: 'Run sleep 100', state: 'error', error: 'Stopped.' },
      { type: 'tool', id: 'm1', name: 'figma.slow', title: 'figma: slow', state: 'error', error: 'Stopped.' },
      { type: 'turn-end', reason: 'interrupted' },
    ]);
    expect(m.isActive).toBe(false);
    // A turn that completes with a card open (Codex never completed it) closes it too.
    const n = mapper();
    n.push(started({ type: 'webSearch', id: 'w1', query: 'q' }));
    expect(n.push(turnCompleted('completed'))).toEqual([
      { type: 'tool', id: 'w1', name: 'web_search', title: 'Search the web: q', state: 'error', error: 'The turn ended before this finished.' },
      { type: 'turn-end', reason: 'done' },
    ]);
    // A turn the run ends itself (Codex did not answer the interrupt).
    const o = mapper();
    o.push(started({ type: 'commandExecution', id: 'c9', command: 'x', status: 'inProgress' }));
    expect(o.endLocally('interrupted')).toEqual([
      { type: 'tool', id: 'c9', name: 'command', title: 'Run x', state: 'error', error: 'Stopped.' },
      { type: 'turn-end', reason: 'interrupted' },
    ]);
    expect(o.push(turnCompleted('interrupted'))).toEqual([]);
  });

  it('ignores other threads, other turns, unknown notifications and global warnings', () => {
    const m = mapper();
    expect(m.push({ method: 'item/agentMessage/delta', params: { threadId: 'other', turnId: 'turn-1', itemId: 'x', delta: 'no' } })).toEqual([]);
    expect(m.push({ method: 'item/agentMessage/delta', params: { threadId: T, turnId: 'turn-0', itemId: 'x', delta: 'stale' } })).toEqual([]);
    expect(m.push({ method: 'brand/new/thing', params: { threadId: T, turnId: 'turn-1', whatever: 1 } })).toEqual([]);
    expect(m.push({ method: 'warning', params: { threadId: null, message: 'config.toml has an unknown key' } })).toEqual([]);
    expect(m.push({ method: 'warning', params: { threadId: T, message: 'Falling back to HTTPS.' } })).toEqual([]);
    expect(m.push({ method: 'item/agentMessage/delta', params: { threadId: T, turnId: 'turn-1', itemId: 'x', delta: 'yes', extra: true } })).toEqual([
      { type: 'text-delta', id: 'x', delta: 'yes' },
    ]);
    // Compaction says so once.
    expect(m.push(completed({ type: 'contextCompaction', id: 'cc' }))).toHaveLength(1);
    expect(m.push({ method: 'thread/compacted', params: { threadId: T, turnId: 'turn-1' } })).toEqual([]);
    // Nothing is reported outside a turn.
    m.push(turnCompleted('completed'));
    expect(m.push({ method: 'item/agentMessage/delta', params: { threadId: T, turnId: 'turn-1', itemId: 'x', delta: 'late' } })).toEqual([]);
  });

  it('gives the whole message when Codex sent it without deltas', () => {
    const m = mapper();
    expect(m.push(completed({ type: 'agentMessage', id: 'a1', text: 'All at once.', phase: 'final_answer' }))).toEqual([
      { type: 'text-delta', id: 'a1', delta: 'All at once.' },
      { type: 'block-end', id: 'a1' },
    ]);
  });

  it('ends a failed turn with the plan limit and when it resets', () => {
    const m = mapper();
    m.push({ method: 'account/rateLimits/updated', params: { rateLimits: { primary: { usedPercent: 100, windowDurationMins: 300, resetsAt: 1795000000 }, secondary: null } } });
    const events = m.push(turnCompleted('failed', { message: "You've hit your usage limit.", codexErrorInfo: 'usageLimitExceeded' }));
    const resetsAt = new Date(1795000000 * 1000).toISOString();
    expect(events).toEqual([
      { type: 'turn-end', reason: 'error', error: { kind: 'rate-limit', message: `You've hit your usage limit. It resets at ${resetsAt}.`, resetsAt } },
    ]);
  });
});

describe('mapCodexError', () => {
  it('maps the error kinds the session shows (§9.4, §19)', () => {
    expect(mapCodexError({ message: 'slow down', codexErrorInfo: 'rateLimitExceeded' })).toEqual({ kind: 'rate-limit', message: 'slow down' });
    expect(mapCodexError({ message: 'Usage limit reached', codexErrorInfo: 'usageLimitExceeded' })).toEqual({ kind: 'rate-limit', message: 'Usage limit reached' });
    expect(mapCodexError({ message: 'x', codexErrorInfo: 'unauthorized' }).kind).toBe('auth');
    expect(mapCodexError({ message: 'x', codexErrorInfo: { httpConnectionFailed: { httpStatusCode: 401 } } }).kind).toBe('auth');
    expect(mapCodexError({ message: 'x', codexErrorInfo: { responseStreamDisconnected: { httpStatusCode: 401 } } }).kind).toBe('auth');
    expect(mapCodexError({ message: 'bad gateway', codexErrorInfo: { httpConnectionFailed: { httpStatusCode: 502 } } })).toEqual({ kind: 'other', message: 'bad gateway' });
    expect(mapCodexError({ message: 'too long', codexErrorInfo: 'contextWindowExceeded' })).toEqual({ kind: 'other', message: 'too long' });
    expect(mapCodexError({ codexErrorInfo: null })).toEqual({ kind: 'other', message: 'Codex ended the turn with an error.' });
    // Only a used-up window gives a reset time.
    expect(mapCodexError({ message: 'm', codexErrorInfo: 'usageLimitExceeded' }, { primary: { usedPercent: 40, resetsAt: 1 } }).resetsAt).toBeUndefined();
  });
});
