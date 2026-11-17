// A session's seq-numbered event log (docs/agent-chat-plan.md §7.3).
//
// `seq` grows by one per event for the life of the engine process; `epoch`
// is random per process, so a client that reconnects to a restarted engine
// can tell. The log keeps the events of the current turn (`startTurn()`
// drops the older ones) and at most `limit` events: a client asking for
// events the log no longer holds is told to resync.

import type { ChatEvent, ChatEventEnvelope } from './types.ts';

export type EventLogListener = (envelope: ChatEventEnvelope) => void;

/** `events` to send, or `resync` when the log cannot continue from `after`. */
export type ReplayResult = { kind: 'events'; events: ChatEventEnvelope[] } | { kind: 'resync' };

export class EventLog {
  readonly epoch: string;
  private readonly limit: number;
  private events: ChatEventEnvelope[] = [];
  private seq = 0;
  private readonly listeners = new Set<EventLogListener>();

  constructor(epoch: string, options: { limit?: number } = {}) {
    this.epoch = epoch;
    this.limit = options.limit ?? 50_000;
  }

  /** The last sequence number handed out; 0 before the first event. */
  get lastSeq(): number {
    return this.seq;
  }

  /** The oldest seq still held; `lastSeq + 1` when none is. */
  get firstSeq(): number {
    return this.events.length > 0 ? this.events[0].seq : this.seq + 1;
  }

  append(event: ChatEvent): ChatEventEnvelope {
    this.seq += 1;
    const envelope: ChatEventEnvelope = { epoch: this.epoch, seq: this.seq, event };
    this.events.push(envelope);
    if (this.events.length > this.limit) {
      this.events.splice(0, this.events.length - this.limit);
    }
    for (const listener of [...this.listeners]) {
      try {
        listener(envelope);
      } catch (e) {
        console.error('[agent] event listener failed:', e);
      }
    }
    return envelope;
  }

  /** A new turn begins: earlier events are no longer replayed. */
  startTurn(): void {
    this.events = [];
  }

  /**
   * The events after `after`. Resync when `after` is ahead of the log (a
   * client of an earlier engine process) or older than what the log holds
   * (`epoch`, when the client sends it, must match too).
   */
  replay(after: number, epoch?: string): ReplayResult {
    if (epoch !== undefined && epoch !== this.epoch) {
      return { kind: 'resync' };
    }
    if (!Number.isInteger(after) || after < 0 || after > this.seq) {
      return { kind: 'resync' };
    }
    if (after < this.firstSeq - 1) {
      return { kind: 'resync' };
    }
    return { kind: 'events', events: this.events.filter((e) => e.seq > after) };
  }

  subscribe(listener: EventLogListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  get listenerCount(): number {
    return this.listeners.size;
  }
}
