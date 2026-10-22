/**
 * The server's render lifecycle, as the page sees it: every render pass
 * announces its `render-version` on start and again when it settles — `end`
 * on a scene, `error` on a compile failure — and the counter only grows.
 * Whoever needs to act once a particular pass has settled waits here, by
 * version, instead of guessing from timing. The edit session uses it to
 * sequence its rollback after the render the edit-feature pause triggers.
 */
export class RenderVersions {
  private settledVersion = 0;
  private waiters: { after: number; resolve: () => void }[] = [];

  /** The newest version that has settled (ended or failed), 0 before any. */
  get settled(): number {
    return this.settledVersion;
  }

  /** A `render-version` message landed. */
  note(msg: { version: number; state: 'start' | 'end' | 'error' }): void {
    if (msg.state === 'start' || !(msg.version > this.settledVersion)) {
      return;
    }
    this.settledVersion = msg.version;
    const due = this.waiters.filter(w => this.settledVersion > w.after);
    this.waiters = this.waiters.filter(w => !due.includes(w));
    due.forEach(w => w.resolve());
  }

  /**
   * Resolves once a render newer than `version` has settled — at once when
   * one already has. A request answered against render N waits here for
   * N+1 (or any later pass: a superseded render never settles on its own,
   * its successor does).
   */
  after(version: number): Promise<void> {
    if (this.settledVersion > version) {
      return Promise.resolve();
    }
    return new Promise(resolve => {
      this.waiters.push({ after: version, resolve });
    });
  }
}

/** The page's one tracker; main.ts feeds it every `render-version` message. */
export const renderVersions = new RenderVersions();
