import { describe, it, expect } from 'vitest';
import { EventLog } from '../src/event-log.ts';
import type { ChatEventEnvelope } from '../src/types.ts';

const delta = (text: string) => ({ type: 'part-delta' as const, messageId: 'm', partId: 'p', text });

describe('EventLog', () => {
  it('numbers events from 1 and replays those after a seq', () => {
    const log = new EventLog('epoch-a');
    expect(log.lastSeq).toBe(0);
    for (const t of ['a', 'b', 'c']) {
      log.append(delta(t));
    }
    expect(log.lastSeq).toBe(3);
    const replay = log.replay(1);
    expect(replay.kind).toBe('events');
    if (replay.kind === 'events') {
      expect(replay.events.map((e) => [e.seq, (e.event as any).text, e.epoch])).toEqual([
        [2, 'b', 'epoch-a'],
        [3, 'c', 'epoch-a'],
      ]);
    }
    expect(log.replay(3)).toEqual({ kind: 'events', events: [] });
  });

  it('asks for a resync for another epoch, a seq from the future, or events it dropped', () => {
    const log = new EventLog('epoch-a');
    log.append(delta('a'));
    log.append(delta('b'));
    expect(log.replay(0, 'epoch-b')).toEqual({ kind: 'resync' });
    expect(log.replay(0, 'epoch-a').kind).toBe('events');
    // A client of an earlier engine process that had got further.
    expect(log.replay(57)).toEqual({ kind: 'resync' });
    expect(log.replay(-1)).toEqual({ kind: 'resync' });

    // A new turn: the previous turn's events are no longer replayed, and
    // seq keeps growing.
    log.startTurn();
    log.append(delta('c'));
    expect(log.lastSeq).toBe(3);
    expect(log.replay(0)).toEqual({ kind: 'resync' });
    expect(log.replay(1)).toEqual({ kind: 'resync' });
    const fromTurnStart = log.replay(2);
    expect(fromTurnStart.kind === 'events' && fromTurnStart.events.map((e) => e.seq)).toEqual([3]);
  });

  it('keeps at most `limit` events', () => {
    const log = new EventLog('e', { limit: 3 });
    for (let i = 0; i < 5; i++) {
      log.append(delta(String(i)));
    }
    expect(log.firstSeq).toBe(3);
    expect(log.replay(1)).toEqual({ kind: 'resync' });
    const ok = log.replay(2);
    expect(ok.kind === 'events' && ok.events.map((e) => e.seq)).toEqual([3, 4, 5]);
  });

  it('pushes new events to subscribers until they unsubscribe', () => {
    const log = new EventLog('e');
    const seen: ChatEventEnvelope[] = [];
    const unsubscribe = log.subscribe((e) => seen.push(e));
    log.append(delta('a'));
    unsubscribe();
    log.append(delta('b'));
    expect(seen.map((e) => e.seq)).toEqual([1]);
    expect(log.listenerCount).toBe(0);
  });
});
