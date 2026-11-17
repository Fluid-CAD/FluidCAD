// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { reduceChat, reduceChatAll } from '../src/ui/chat/chat-reducer';
import type { ChatEvent, ChatEventEnvelope, ChatMessage, SessionSnapshot } from '../src/ui/chat/chat-types';
import turnWithTools from './fixtures/chat-events/turn-with-tools.json';
import stoppedTurn from './fixtures/chat-events/stopped-turn.json';
import rateLimitedTurn from './fixtures/chat-events/rate-limited-turn.json';

// The page's fold of the session's event stream (docs/agent-chat-plan.md
// §7.3) against sequences recorded from the engine's own runtime (agent/,
// a fake CLI that streams thinking, FluidCAD tool calls through the gate —
// one allowed, one denied — the agent's own Grep, and text; a turn stopped
// mid-answer; a turn the plan limit ended). Whatever the page folds must be
// the transcript the engine ends with, from the start or from any snapshot.

type Recording = { initial: SessionSnapshot; events: ChatEventEnvelope[]; final: SessionSnapshot };

const RECORDINGS: [string, Recording][] = [
  ['a turn with thinking, tools and text (two turns)', turnWithTools as unknown as Recording],
  ['a turn stopped mid-answer', stoppedTurn as unknown as Recording],
  ['a turn the plan limit ended', rateLimitedTurn as unknown as Recording],
];

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
