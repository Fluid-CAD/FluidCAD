// SessionWrites: what a render writes to its session's state, now or once its code becomes the session's.

/**
 * The writes one render makes to the state its session keeps beside the
 * scene — the params panel's definitions and the overrides' settling, the
 * configuration it settled on, the breakpoints, the files a share link
 * carries, the package problems, the engine-owned rows, the compile error.
 * Everything that describes **the session's code** (the editor's buffer),
 * which the routes that write edits address by line.
 *
 * A render of the session's code makes them at once ({@link immediate}).
 * An assembly preview renders other code — the session's with an edit
 * applied in memory — so its writes are {@link deferred}: held until that
 * code becomes the session's (the editor's buffer equals it: the dialog's
 * Apply, served as a dedup hit — `FluidCadServer.updateLiveCode`), and
 * dropped with the preview otherwise. The scene itself and what describes
 * it (the compare baseline, the fingerprint, the stop) are the preview's at
 * once: the preview is the session's scene while it shows.
 */
export class SessionWrites {
  private constructor(private pending: (() => void)[] | null) {}

  /** Writes made as they come: a render of the session's own code. */
  static immediate(): SessionWrites {
    return new SessionWrites(null);
  }

  /** Writes held until {@link flush}: an assembly preview's. */
  static deferred(): SessionWrites {
    return new SessionWrites([]);
  }

  /** Whether writes wait for {@link flush}. */
  get isDeferred(): boolean {
    return this.pending !== null;
  }

  /** Make `write` now, or hold it until {@link flush}. */
  run(write: () => void): void {
    if (this.pending) {
      this.pending.push(write);
      return;
    }
    write();
  }

  /** Make every held write, in the order the render made them; later writes go straight through. */
  flush(): void {
    const pending = this.pending ?? [];
    this.pending = null;
    for (const write of pending) {
      write();
    }
  }
}
