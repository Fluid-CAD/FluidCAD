import { createHash } from 'crypto';
import { normalizePath } from '../normalize-path.ts';

/**
 * A short memory of what the in-page editor host wrote to disk.
 *
 * `fluidcad serve` runs a disk watcher (`bin/watcher.js`) so a model saved
 * from any external editor re-renders — and it cannot tell those saves from
 * the page's own. The page's saves come back through it as `live-update`
 * messages for whichever file was written, which is wrong twice over: the
 * host already rendered that edit (with `keepCurrent` when the file is not
 * the model on screen), and a plain live-update for another file switches
 * the viewport to it. So the server remembers each page write briefly and
 * recognises the echo by content, the same way the page recognises its own
 * writes coming back through the workspace watcher by mtime.
 *
 * Content, not time, decides: an echo carries exactly the bytes that were
 * written. The TTL only bounds how long an identical external save (a
 * no-op re-save from another editor) is treated as the echo, and is generous
 * because a watcher may report one write as two events.
 */
export class PageWriteLedger {
  private readonly entries = new Map<string, { digest: string; at: number }>();

  constructor(private readonly ttlMs = 10_000, private readonly now: () => number = Date.now) {}

  record(absPath: string, content: string): void {
    this.entries.set(normalizePath(absPath), { digest: PageWriteLedger.digest(content), at: this.now() });
    // Bound the ledger: only recent writes matter, and workspaces are finite,
    // but a long session should not accumulate one entry per file ever saved.
    for (const [key, entry] of this.entries) {
      if (this.now() - entry.at > this.ttlMs) {
        this.entries.delete(key);
      }
    }
  }

  /** True when `content` at `absPath` is what the page itself wrote just now. */
  isEcho(absPath: string, content: unknown): boolean {
    if (typeof content !== 'string') {
      return false;
    }
    const entry = this.entries.get(normalizePath(absPath));
    if (!entry) {
      return false;
    }
    if (this.now() - entry.at > this.ttlMs) {
      this.entries.delete(normalizePath(absPath));
      return false;
    }
    return entry.digest === PageWriteLedger.digest(content);
  }

  private static digest(content: string): string {
    return createHash('sha1').update(content).digest('hex');
  }
}
