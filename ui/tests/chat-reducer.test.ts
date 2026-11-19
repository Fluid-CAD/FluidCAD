// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { reduceChat, reduceChatAll, reduceTurns } from '../src/ui/chat/chat-reducer';
import type { ChatEvent, ChatEventEnvelope, ChatMessage, SessionSnapshot, ToolPart, TurnRecord } from '../src/ui/chat/chat-types';
import turnWithTools from './fixtures/chat-events/turn-with-tools.json';
import stoppedTurn from './fixtures/chat-events/stopped-turn.json';
import rateLimitedTurn from './fixtures/chat-events/rate-limited-turn.json';
import approveDenyRevert from './fixtures/chat-events/approve-deny-revert.json';
import stoppedApprovalDirtyBuffer from './fixtures/chat-events/stopped-approval-dirty-buffer.json';

// The page's fold of the session's event stream (docs/agent-chat-plan.md
// §7.3) against sequences recorded from the engine's own runtime (agent/,
// a fake CLI that streams thinking, FluidCAD tool calls through the gate —
// one allowed, one denied — the agent's own Grep, and text; a turn stopped
// mid-answer; a turn the plan limit ended; phase 4's approvals — an edit
// allowed, a new file declined, two writes allowed for the session, then a
// revert of the first turn that takes the third back too; an approval stopped
// before the user answered, a write refused for unsaved changes, an edit in
// auto-edits mode). Whatever the page folds must be the transcript the engine
// ends with, from the start or from any snapshot — and the turns' revert
// state too.

type Recording = { initial: SessionSnapshot; events: ChatEventEnvelope[]; final: SessionSnapshot };

const RECORDINGS: [string, Recording][] = [
  ['a turn with thinking, tools and text (two turns)', turnWithTools as unknown as Recording],
  ['a turn stopped mid-answer', stoppedTurn as unknown as Recording],
  ['a turn the plan limit ended', rateLimitedTurn as unknown as Recording],
  ['approve, deny, allow for the session, revert', approveDenyRevert as unknown as Recording],
  ['an approval stopped, a dirty buffer, auto-edits', stoppedApprovalDirtyBuffer as unknown as Recording],
];

/** What the stream says of a turn: no event carries `endedAt` / `endReason`, and `revertedAt` is the page's clock. */
function streamed(turns: readonly TurnRecord[]): object[] {
  return turns.map(({ endedAt: _e, endReason: _r, revertedAt, ...rest }) => ({ ...rest, ...(revertedAt ? { reverted: true } : {}) }));
}

function foldTurns(turns: readonly TurnRecord[], events: ChatEvent[]): TurnRecord[] {
  let out = turns as TurnRecord[];
  for (const event of events) {
    out = reduceTurns(out, event);
  }
  return out;
}

describe('reduceChat on recorded sequences', () => {
  it.each(RECORDINGS)('%s: folding every event gives the engine’s transcript', (_name, recording) => {
    const events = recording.events.map((e) => e.event);
    expect(reduceChatAll(recording.initial.messages, events)).toEqual(recording.final.messages);
  });

  it.each(RECORDINGS)('%s: a client that attached mid-stream ends the same', (_name, recording) => {
    const events = recording.events.map((e) => e.event);
    for (let cut = 0; cut <= events.length; cut++) {
      // What a snapshot taken after `cut` events holds, then the rest of the stream.
      const snapshot = structuredClone(reduceChatAll(recording.initial.messages, events.slice(0, cut)));
      expect(reduceChatAll(snapshot, events.slice(cut))).toEqual(recording.final.messages);
    }
  });

  it.each(RECORDINGS)('%s: an event delivered twice at a start changes nothing (replay overlap)', (_name, recording) => {
    const doubled: ChatEvent[] = [];
    for (const { event } of recording.events) {
      doubled.push(event);
      if (event.type === 'message-start' || event.type === 'part-start') {
        doubled.push(structuredClone(event));
      }
    }
    expect(reduceChatAll(recording.initial.messages, doubled)).toEqual(recording.final.messages);
  });

  it.each(RECORDINGS)('%s: the turns follow the stream (revertible, files, reverted), from the start or any snapshot', (_name, recording) => {
    const events = recording.events.map((e) => e.event);
    expect(streamed(foldTurns(recording.initial.turns, events))).toEqual(streamed(recording.final.turns));
    for (let cut = 0; cut <= events.length; cut++) {
      const snapshot = structuredClone(foldTurns(recording.initial.turns, events.slice(0, cut)));
      expect(streamed(foldTurns(snapshot, events.slice(cut)))).toEqual(streamed(recording.final.turns));
    }
  });

  it('records the approval sequences: allowed, declined, allowed for the session; checkpoints; a revert of two turns', () => {
    const final = approveDenyRevert.final as unknown as SessionSnapshot;
    const tools = final.messages.flatMap((m) => m.parts).filter((p): p is ToolPart => p.type === 'tool');
    expect(tools.map((t) => [t.state, t.approval?.decision ?? null])).toEqual([
      ['done', 'allow'],
      ['denied', 'deny'],
      ['done', 'allow-session'],
      ['done', null],
    ]);
    expect(tools[0].diff).toContain('-b\n+B');
    expect(tools[1].error).toBe('Declined.');
    const events = approveDenyRevert.events.map((e) => e.event as ChatEvent);
    const statuses = events.filter((e) => e.type === 'status').map((e: any) => e.status.state);
    expect(statuses).toContain('awaiting-approval');
    // Turn 3 went first, then turn 1; each gained a notice.
    const reverted = events.filter((e): e is Extract<ChatEvent, { type: 'reverted' }> => e.type === 'reverted');
    expect(reverted.map((e) => e.turnId)).toEqual([final.turns[2].id, final.turns[0].id]);
    expect(final.turns.map((t) => [t.revertible, !!t.revertedAt])).toEqual([[false, true], [false, false], [false, true]]);

    const other = stoppedApprovalDirtyBuffer.final as unknown as SessionSnapshot;
    const parts = other.messages.flatMap((m) => m.parts).filter((p): p is ToolPart => p.type === 'tool');
    expect(parts[0]).toMatchObject({ state: 'denied', error: 'Stopped before you answered.' });
    expect(parts[1]).toMatchObject({ state: 'error', errorCode: 'dirty-buffer' });
    // The refused write's checkpoint came and went: the turn has nothing to revert.
    expect(other.turns.map((t) => t.revertible)).toEqual([false, false, true]);
  });

  it('records what the reducer must handle: thinking, allowed, denied and agent tools, text, notices', () => {
    const assistant = turnWithTools.final.messages.find((m) => m.role === 'assistant')!;
    expect(assistant.parts.map((p) => p.type)).toEqual(['reasoning', 'tool', 'tool', 'tool', 'text']);
    expect(assistant.parts.filter((p) => p.type === 'tool').map((p: any) => p.state)).toEqual(['done', 'denied', 'done']);
    const stopped = stoppedTurn.final.messages[1];
    expect(stopped.parts.map((p) => p.type)).toEqual(['text', 'notice']);
    expect(rateLimitedTurn.final.status).toMatchObject({ state: 'error', kind: 'rate-limit' });
  });
});

describe('reduceChat', () => {
  const base = (): ChatMessage[] => [
    { id: 'u1', role: 'user', turnId: 't1', createdAt: '2026-11-17T10:00:00Z', parts: [{ type: 'text', id: 'p0', text: 'hi' }] },
    { id: 'a1', role: 'assistant', turnId: 't1', createdAt: '2026-11-17T10:00:01Z', parts: [{ type: 'text', id: 'p1', text: 'Hel' }] },
  ];

  it('is pure: the input is untouched, and what the event did not touch keeps its identity', () => {
    const messages = base();
    const frozen = structuredClone(messages);
    const next = reduceChat(messages, { type: 'part-delta', messageId: 'a1', partId: 'p1', text: 'lo' });
    expect(messages).toEqual(frozen);
    expect(next).not.toBe(messages);
    expect(next[0]).toBe(messages[0]);
    expect(next[1]).not.toBe(messages[1]);
    expect(next[1].parts[0]).toEqual({ type: 'text', id: 'p1', text: 'Hello' });
  });

  it('returns the same array for events that do not touch messages, or name nothing it holds', () => {
    const messages = base();
    const ignored: ChatEvent[] = [
      { type: 'status', status: { state: 'idle' } },
      { type: 'usage', inputTokens: 1 },
      { type: 'title', title: 'x' },
      { type: 'resync' },
      { type: 'checkpoint', turnId: 't1', files: [] },
      { type: 'reverted', turnId: 't1', files: ['a.fluid.js'] },
      { type: 'message-end', messageId: 'a1' },
      { type: 'part-delta', messageId: 'nope', partId: 'p1', text: 'x' },
      { type: 'part-delta', messageId: 'a1', partId: 'nope', text: 'x' },
      { type: 'part-update', messageId: 'a1', partId: 'nope', patch: { text: 'x' } },
      { type: 'part-start', messageId: 'nope', part: { type: 'text', id: 'p9', text: '' } },
    ];
    for (const event of ignored) {
      expect(reduceChat(messages, event)).toBe(messages);
    }
  });

  it('appends deltas only to text and thinking; a patch merges into any part', () => {
    let messages: ChatMessage[] = [
      { id: 'a1', role: 'assistant', turnId: 't1', createdAt: '', parts: [
        { type: 'tool', id: 'tool', source: 'fluidcad', name: 'measure', title: 'Measure', kind: 'read', state: 'running', input: {} },
        { type: 'reasoning', id: 'r', text: '' },
      ] },
    ];
    const before = messages;
    messages = reduceChat(messages, { type: 'part-delta', messageId: 'a1', partId: 'tool', text: 'x' });
    expect(messages).toBe(before);
    messages = reduceChat(messages, { type: 'part-delta', messageId: 'a1', partId: 'r', text: 'Hmm' });
    messages = reduceChat(messages, { type: 'part-update', messageId: 'a1', partId: 'tool', patch: { state: 'done', output: { text: '12 mm' } } });
    expect(messages[0].parts).toEqual([
      { type: 'tool', id: 'tool', source: 'fluidcad', name: 'measure', title: 'Measure', kind: 'read', state: 'done', input: {}, output: { text: '12 mm' } },
      { type: 'reasoning', id: 'r', text: 'Hmm' },
    ]);
  });

  it('copies what it stores, so a later change to the event cannot reach the transcript', () => {
    const part = { type: 'tool' as const, id: 't', source: 'agent' as const, name: 'Grep', title: 'Search', kind: 'read' as const, state: 'running' as const, input: { pattern: 'a' } };
    const messages = reduceChatAll([], [
      { type: 'message-start', message: { id: 'a1', role: 'assistant', turnId: 't1', createdAt: '' } },
      { type: 'part-start', messageId: 'a1', part },
    ]);
    (part.input as any).pattern = 'changed';
    expect((messages[0].parts[0] as any).input.pattern).toBe('a');
  });
});

describe('reduceTurns', () => {
  const now = () => '2026-11-17T12:00:00.000Z';

  it('opens a turn with its user message, once; an assistant message opens none', () => {
    let turns: TurnRecord[] = [];
    turns = reduceTurns(turns, { type: 'message-start', message: { id: 'u1', role: 'user', turnId: 't1', createdAt: '' } }, now);
    expect(turns).toEqual([{ id: 't1', userMessageId: 'u1', revertible: false }]);
    const same = turns;
    expect(reduceTurns(turns, { type: 'message-start', message: { id: 'u1', role: 'user', turnId: 't1', createdAt: '' } }, now)).toBe(same);
    expect(reduceTurns(turns, { type: 'message-start', message: { id: 'a1', role: 'assistant', turnId: 't1', createdAt: '' } }, now)).toBe(same);
  });

  it('a checkpoint sets the files and revertibility; an empty list ends it; reverted keeps the files and stamps the time', () => {
    const start: TurnRecord[] = [{ id: 't1', userMessageId: 'u1', revertible: false }];
    let turns = reduceTurns(start, { type: 'checkpoint', turnId: 't1', files: ['a.fluid.js'] }, now);
    expect(start[0]).toEqual({ id: 't1', userMessageId: 'u1', revertible: false });
    expect(turns[0]).toEqual({ id: 't1', userMessageId: 'u1', revertible: true, files: ['a.fluid.js'] });
    turns = reduceTurns(turns, { type: 'checkpoint', turnId: 't1', files: [] }, now);
    expect(turns[0]).toEqual({ id: 't1', userMessageId: 'u1', revertible: false });
    turns = reduceTurns(turns, { type: 'checkpoint', turnId: 't1', files: ['a.fluid.js', 'b.fluid.js'] }, now);
    turns = reduceTurns(turns, { type: 'reverted', turnId: 't1', files: ['a.fluid.js', 'b.fluid.js'] }, now);
    expect(turns[0]).toEqual({ id: 't1', userMessageId: 'u1', revertible: false, files: ['a.fluid.js', 'b.fluid.js'], revertedAt: now() });
    // A turn it does not hold: nothing changes.
    expect(reduceTurns(turns, { type: 'reverted', turnId: 'nope', files: [] }, now)).toBe(turns);
  });

  it('usage is recorded on its turn; a usage event without a turn changes nothing', () => {
    const start: TurnRecord[] = [{ id: 't1', userMessageId: 'u1', revertible: false }];
    const turns = reduceTurns(start, { type: 'usage', turnId: 't1', inputTokens: 1200, outputTokens: 80, costUsd: 0.02 }, now);
    expect(turns[0]).toEqual({ id: 't1', userMessageId: 'u1', revertible: false, usage: { inputTokens: 1200, outputTokens: 80, costUsd: 0.02 } });
    expect(start[0].usage).toBeUndefined();
    expect(reduceTurns(turns, { type: 'usage', inputTokens: 1 }, now)).toBe(turns);
  });
});
