/**
 * A debounced async task with the abort + staleness idiom the previews use:
 * `schedule()` (re)starts the delay; when it fires, any in-flight run is
 * aborted and the task runs with a fresh signal plus an `isCurrent` check —
 * a run that awaited past a newer schedule drops its result. `cancel()`
 * stops the pending timer, aborts the in-flight run, and marks it stale.
 */
export class DebouncedTask {
  private timer: number | null = null;
  private abort: AbortController | null = null;
  private seq = 0;

  constructor(
    private readonly delayMs: number,
    private readonly task: (signal: AbortSignal, isCurrent: () => boolean) => Promise<void>,
  ) {}

  schedule(): void {
    if (this.timer !== null) {
      window.clearTimeout(this.timer);
    }
    this.timer = window.setTimeout(() => {
      this.timer = null;
      void this.run();
    }, this.delayMs);
  }

  cancel(): void {
    if (this.timer !== null) {
      window.clearTimeout(this.timer);
      this.timer = null;
    }
    this.abort?.abort();
    this.abort = null;
    this.seq++;
  }

  private async run(): Promise<void> {
    const seq = ++this.seq;
    this.abort?.abort();
    const abort = new AbortController();
    this.abort = abort;
    await this.task(abort.signal, () => seq === this.seq);
  }
}
