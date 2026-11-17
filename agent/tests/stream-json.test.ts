import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { ClaudeStreamMapper } from '../src/claude/stream-json.ts';
import type { BackendEvent } from '../src/backend.ts';

// Recorded in phase 0 from Claude Code 2.1.326 (docs/agent-chat-plan.md §19),
// home paths scrubbed. Re-record when a CLI version breaks the mapping.
const FIXTURES = path.join(import.meta.dirname, 'fixtures');

function lines(name: string): string[] {
  return fs.readFileSync(path.join(FIXTURES, name), 'utf8').split('\n').filter((l) => l.trim() !== '');
}

function mapAll(name: string, mapper = new ClaudeStreamMapper()): BackendEvent[] {
  return lines(name).flatMap((line) => mapper.pushLine(line));
}

function ofType<T extends BackendEvent['type']>(events: BackendEvent[], type: T): Extract<BackendEvent, { type: T }>[] {
  return events.filter((e): e is Extract<BackendEvent, { type: T }> => e.type === type);
}

describe('ClaudeStreamMapper on recorded stream-json', () => {
  it('maps summarized thinking, the answer, usage and the end of the turn', () => {
    const mapper = new ClaudeStreamMapper();
    const events = mapAll('claude-thinking-summarized.jsonl', mapper);

    expect(mapper.init).toMatchObject({ version: '2.1.326', mcpStatus: 'connected' });
    const reasoning = ofType(events, 'reasoning-delta');
    expect(reasoning.length).toBeGreaterThan(1);
    expect(reasoning.map((e) => e.delta).join('').length).toBeGreaterThan(20);
    // All of it is one block, and the answer is another.
    expect(new Set(reasoning.map((e) => e.id)).size).toBe(1);
    const text = ofType(events, 'text-delta');
    expect(text.map((e) => e.delta).join('')).toBe('28995');
    expect(text[0].id).not.toBe(reasoning[0].id);
    expect(ofType(events, 'block-end').map((e) => e.id)).toEqual([reasoning[0].id, text[0].id]);

    const usage = ofType(events, 'usage');
    expect(usage).toHaveLength(1);
    expect(usage[0].outputTokens).toBeGreaterThan(0);
    expect(usage[0].costUsd).toBeGreaterThan(0);
    expect(events[events.length - 1]).toEqual({ type: 'turn-end', reason: 'done' });
  });

  it('opens a reasoning part even when the thinking text is empty', () => {
    const events = mapAll('claude-thinking-default-display.jsonl');
    const reasoning = ofType(events, 'reasoning-delta');
    expect(reasoning.length).toBeGreaterThan(0);
    expect(reasoning.every((e) => e.delta === '')).toBe(true);
    expect(ofType(events, 'text-delta').map((e) => e.delta).join('')).toBe('28995');
  });

  it('drops every FluidCAD tool call and its result, and ends each turn', () => {
    const events = mapAll('claude-main-canary-image-screenshot-slowtool-sigint.jsonl');
    expect(ofType(events, 'tool')).toEqual([]);
    const text = ofType(events, 'text-delta').map((e) => e.delta).join('');
    expect(text).toContain('ZEBRA');
    expect(text).toContain('four holes');
    expect(text).not.toContain('Request interrupted');
    const ends = ofType(events, 'turn-end');
    expect(ends.map((e) => e.reason)).toEqual(['done', 'done', 'done', 'done', 'error']);
    // Five turns: one usage report each.
    expect(ofType(events, 'usage')).toHaveLength(5);
    // The weekly-window warning shows once per process, not once per turn.
    expect(ofType(events, 'notice').filter((n) => n.level === 'warning')).toHaveLength(1);
  });

  it('ends an interrupted turn as interrupted', () => {
    const mapper = new ClaudeStreamMapper();
    mapper.interrupting = true;
    const events = mapAll('claude-interrupt-stateful-mcp.jsonl', mapper);
    expect(ofType(events, 'tool')).toEqual([]);
    expect(ofType(events, 'turn-end')).toEqual([{ type: 'turn-end', reason: 'interrupted' }]);
    expect(mapper.interrupting).toBe(false);
  });

  it('keeps one process usable across turns after an interrupt', () => {
    const mapper = new ClaudeStreamMapper();
    const all = lines('claude-resume-and-interrupt-control-request.jsonl');
    const events: BackendEvent[] = [];
    for (const line of all) {
      const msg = JSON.parse(line);
      if (msg.type === 'control_response') {
        // The run sets this when it writes the control request.
        mapper.interrupting = true;
      }
      events.push(...mapper.pushLine(line));
    }
    expect(ofType(events, 'turn-end').map((e) => e.reason)).toEqual(['done', 'interrupted', 'done']);
    expect(ofType(events, 'text-delta').map((e) => e.delta).join('|')).toBe('ZEBRA|alive again');
  });

  it('reports a run that is not signed in as an auth error', () => {
    const events = mapAll('claude-not-signed-in.jsonl');
    const end = ofType(events, 'turn-end');
    expect(end).toHaveLength(1);
    expect(end[0].reason).toBe('error');
    expect(end[0].error?.kind).toBe('auth');
    expect(end[0].error?.message).toContain('claude auth login');
  });

  it('ignores lines it does not know and lines that are not JSON', () => {
    const mapper = new ClaudeStreamMapper();
    expect(mapper.pushLine('not json')).toEqual([]);
    expect(mapper.pushLine('{"type":"keep_alive"}')).toEqual([]);
    expect(mapper.pushLine('{"type":"something_new","x":1}')).toEqual([]);
    expect(mapper.pushLine('')).toEqual([]);
  });
});

describe('ClaudeStreamMapper on synthetic lines', () => {
  const start = (index: number, block: object) => ({ type: 'stream_event', event: { type: 'content_block_start', index, content_block: block } });

  it('reports the CLI\'s own tools with their input and result', () => {
    const mapper = new ClaudeStreamMapper();
    const events = [
      { type: 'stream_event', event: { type: 'message_start', message: { id: 'msg_a' } } },
      start(0, { type: 'tool_use', id: 'toolu_1', name: 'Read', input: {} }),
      { type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"file_path":' } } },
      { type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '"/p/a.fluid.js"}' } } },
      { type: 'stream_event', event: { type: 'content_block_stop', index: 0 } },
      { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: [{ type: 'text', text: 'line 1' }] }] } },
    ].flatMap((m) => mapper.push(m));
    expect(events).toEqual([
      { type: 'tool', id: 'toolu_1', name: 'Read', title: 'Read a file', state: 'running' },
      { type: 'tool', id: 'toolu_1', name: 'Read', title: 'Read /p/a.fluid.js', state: 'running', input: { file_path: '/p/a.fluid.js' } },
      { type: 'tool', id: 'toolu_1', name: 'Read', title: 'Read a file', state: 'done', output: 'line 1' },
    ]);
  });

  it('turns a rejected rate limit into a rate-limit error with the reset time', () => {
    const mapper = new ClaudeStreamMapper();
    mapper.push({ type: 'rate_limit_event', rate_limit_info: { status: 'rejected', resetsAt: 1795453200, rateLimitType: 'five_hour' } });
    mapper.push({ type: 'assistant', error: 'rate_limit', message: { content: [{ type: 'text', text: 'Limit reached' }] } });
    const events = mapper.push({ type: 'result', subtype: 'success', is_error: true, result: 'Limit reached' });
    const end = events.find((e) => e.type === 'turn-end') as Extract<BackendEvent, { type: 'turn-end' }>;
    expect(end.error).toEqual({
      kind: 'rate-limit',
      message: "Claude Code reached your plan's five-hour usage limit.",
      resetsAt: new Date(1795453200 * 1000).toISOString(),
    });
  });

  it('warns once per window as a plan limit nears, the reset time apart from the words', () => {
    const mapper = new ClaudeStreamMapper();
    const info = { status: 'allowed_warning', resetsAt: 1795453200, rateLimitType: 'seven_day', utilization: 0.85 };
    expect(mapper.push({ type: 'rate_limit_event', rate_limit_info: info })).toEqual([
      {
        type: 'notice',
        level: 'warning',
        text: "Claude Code warns about your plan's weekly usage limit, 85% used.",
        resetsAt: new Date(1795453200 * 1000).toISOString(),
      },
    ]);
    expect(mapper.push({ type: 'rate_limit_event', rate_limit_info: info })).toEqual([]);
  });

  it('turns credits_required into a rate-limit error', () => {
    const mapper = new ClaudeStreamMapper();
    mapper.push({ type: 'rate_limit_event', rate_limit_info: { status: 'rejected', errorCode: 'credits_required' } });
    const events = mapper.push({ type: 'result', subtype: 'success', is_error: true, result: 'Credits required' });
    expect(events.find((e) => e.type === 'turn-end')).toMatchObject({ reason: 'error', error: { kind: 'rate-limit', message: expect.stringContaining('credits') } });
  });

  it('notes a compaction', () => {
    const mapper = new ClaudeStreamMapper();
    expect(mapper.push({ type: 'system', subtype: 'compact_boundary' })).toEqual([
      { type: 'notice', level: 'info', text: expect.stringContaining('compacted') },
    ]);
  });
});
