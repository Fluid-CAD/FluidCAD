/**
 * Ends a transfer that stops moving: GH #80's stall watchdog.
 *
 * - **Up** ({@link meter}): each chunk the request takes from the body
 *   re-arms it; once the last byte is taken, it waits {@link answerMs} for
 *   the hub's answer, which comes after the hub has checked the whole
 *   archive.
 * - **Down** ({@link receive}, then {@link touch} for each chunk read): it
 *   is armed from the moment the request leaves, so a hub that never
 *   answers stalls too, and every chunk read re-arms it.
 *
 * It is not a total limit: a slow upload that keeps moving goes on, bounded
 * only by the request's own total limit. Undici takes the next chunk only
 * when the socket can take it, so a link that stalls stops the pulls, and
 * the watchdog fires.
 */

export type StallPhase = 'sending' | 'answering' | 'receiving';

export class StallWatchdog {
  readonly stallMs: number;
  readonly answerMs: number;
  private readonly controller = new AbortController();
  private timer: NodeJS.Timeout | null = null;
  private firedIn: StallPhase | null = null;
  private current: StallPhase = 'sending';

  constructor(stallMs: number, answerMs: number = stallMs) {
    this.stallMs = stallMs;
    this.answerMs = answerMs;
  }

  /** Aborted when the watchdog fires. */
  get signal(): AbortSignal {
    return this.controller.signal;
  }

  /** Where it fired: while sending (a stall), or waiting for the answer; null while it hasn't. */
  get fired(): StallPhase | null {
    return this.firedIn;
  }

  /**
   * `body`, metered: every chunk the request takes re-arms the watchdog and
   * reports the bytes taken so far to `onProgress`. The end of the body
   * switches it to waiting for the answer.
   */
  meter(body: ReadableStream<Uint8Array>, onProgress?: (sent: number) => void): ReadableStream<Uint8Array> {
    const reader = body.getReader();
    let sent = 0;
    return new ReadableStream<Uint8Array>({
      start: () => {
        this.arm();
      },
      pull: async (controller) => {
        const { done, value } = await reader.read();
        if (done) {
          controller.close();
          this.current = 'answering';
          this.arm();
          return;
        }
        sent += value.byteLength;
        controller.enqueue(value);
        this.arm();
        onProgress?.(sent);
      },
      cancel: async (reason) => {
        await reader.cancel(reason);
      },
    });
  }

  /** Starts watching a download: from now on, {@link stallMs} without a {@link touch} fires it. */
  receive(): void {
    this.current = 'receiving';
    this.arm();
  }

  /** Something moved (a chunk of a download was read): the clock starts again. */
  touch(): void {
    this.arm();
  }

  /** Stops watching: the answer came, or the request failed on its own. */
  stop(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private arm(): void {
    this.stop();
    if (this.firedIn) {
      return;
    }
    const phase = this.current;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.firedIn = phase;
      this.controller.abort();
    }, phase === 'answering' ? this.answerMs : this.stallMs);
  }
}
