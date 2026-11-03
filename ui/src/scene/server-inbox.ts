/** What becomes of one message once it is ready: handled, or skipped (a scene that cannot be drawn). */
export type InboxOutcome = 'handle' | 'skip';

export type ServerInboxSteps<M> = {
  /**
   * Make `msg` ready: an outcome now, or a promise of one when the message
   * waits for something first (a scene's missing meshes).
   */
  prepare(msg: M): InboxOutcome | Promise<InboxOutcome>;
  handle(msg: M): void;
  skip(msg: M): void;
};

/**
 * One connection's server messages, handled strictly in the order they
 * came (S6b). A message that must wait — a scene whose meshes are being
 * fetched — holds every message after it until it is handled or skipped:
 * nothing (a later scene, the render-version ping that settles it, a
 * preview ending) overtakes it. Nearly every message is ready at once and
 * is handled synchronously, as before. Closed with its connection: what
 * is queued or waiting then is dropped — the next connection's replay
 * supersedes it.
 */
export class ServerInbox<M> {
  private readonly queue: M[] = [];
  private waiting = false;
  private closed = false;

  constructor(private readonly steps: ServerInboxSteps<M>) {}

  push(msg: M): void {
    if (this.closed) {
      return;
    }
    this.queue.push(msg);
    if (!this.waiting) {
      this.drain();
    }
  }

  /** The connection is gone: drop what is queued, and whatever is waiting when it is ready. */
  close(): void {
    this.closed = true;
    this.queue.length = 0;
  }

  /** Messages received and not yet handled or skipped (one waiting included). */
  get pending(): number {
    return this.queue.length + (this.waiting ? 1 : 0);
  }

  private drain(): void {
    while (this.queue.length > 0 && !this.closed) {
      const msg = this.queue.shift()!;
      const outcome = this.steps.prepare(msg);
      if (typeof outcome === 'string') {
        this.finish(msg, outcome);
        continue;
      }
      this.waiting = true;
      outcome
        .catch((err) => {
          console.error('Preparing a server message failed:', err);
          return 'skip' as const;
        })
        .then((settled) => {
          this.waiting = false;
          if (this.closed) {
            return;
          }
          this.finish(msg, settled);
          this.drain();
        });
      return;
    }
  }

  /** Handle or skip one message; a handler that throws is reported, and the messages after it still run. */
  private finish(msg: M, outcome: InboxOutcome): void {
    try {
      if (outcome === 'handle') {
        this.steps.handle(msg);
      } else {
        this.steps.skip(msg);
      }
    } catch (err) {
      console.error('Handling a server message failed:', err);
    }
  }
}
