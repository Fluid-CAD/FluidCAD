/**
 * The Parameters panel's source writes, one at a time.
 *
 * On a host that edits source a committed value is an edit of the file: it
 * rides the acked apply-feature round trip and lands as one undo step. Two
 * of those must not race — the second would be computed against a buffer
 * the first is still rewriting — so the panel hands every write here, and
 * the queue runs them in order, each once the one before it settled.
 *
 * A write that is still waiting is replaced by a newer one for the same
 * parameter (its row key): only the last value of a quick run of edits is
 * written, in the place the first one took in the queue. A write already
 * running is never cancelled.
 */
export class ParamWriteQueue {
  /** Writes not started yet, by row key, in the order each key was first queued. */
  private readonly waiting = new Map<string, () => Promise<void>>();
  /** The running drain, or null while the queue is idle. */
  private draining: Promise<void> | null = null;

  /** Queue `write` for the parameter `key`, replacing a write of it that has not started. */
  enqueue(key: string, write: () => Promise<void>): void {
    this.waiting.set(key, write);
    if (this.draining === null) {
      this.draining = this.drain();
    }
  }

  /** Whether nothing is queued or running. */
  get idle(): boolean {
    return this.draining === null;
  }

  /** Resolves once every write queued so far has settled. */
  whenIdle(): Promise<void> {
    return this.draining ?? Promise.resolve();
  }

  private async drain(): Promise<void> {
    try {
      for (let next = this.takeNext(); next !== null; next = this.takeNext()) {
        try {
          await next();
        } catch (err) {
          // One failed write must not stall the ones behind it; the write
          // reports its own refusals, so this is only an unexpected throw.
          console.error('Parameter write failed:', err);
        }
      }
    } finally {
      this.draining = null;
    }
  }

  private takeNext(): (() => Promise<void>) | null {
    const first = this.waiting.entries().next();
    if (first.done) {
      return null;
    }
    const [key, write] = first.value;
    this.waiting.delete(key);
    return write;
  }
}
