/**
 * Pending acknowledgments for apply-feature-edit dispatches. The apply routes
 * hand the edit spec to the editor host over IPC and the host round-trips it
 * through /code/apply-feature to run the actual source transform — this
 * registry correlates the two so the original HTTP request can answer with
 * the transform's true outcome instead of a fire-and-forget success. An ack
 * that never arrives resolves to null after the timeout.
 */
export type EditAck = { error?: string };

export class EditAckRegistry {
  private pending = new Map<string, { resolve: (ack: EditAck | null) => void; timer: NodeJS.Timeout }>();
  private counter = 0;

  constructor(private timeoutMs: number) {}

  /** Allocate an edit id and the promise its round-trip will settle. */
  register(): { editId: string; result: Promise<EditAck | null> } {
    const editId = `edit-${process.pid}-${++this.counter}`;
    const result = new Promise<EditAck | null>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(editId);
        resolve(null);
      }, this.timeoutMs);
      timer.unref?.();
      this.pending.set(editId, { resolve, timer });
    });
    return { editId, result };
  }

  /** The host round-tripped the spec — settle the waiting request. */
  resolve(editId: string, error: string | undefined): void {
    const entry = this.pending.get(editId);
    if (!entry) {
      return;
    }
    this.pending.delete(editId);
    clearTimeout(entry.timer);
    entry.resolve(error === undefined ? {} : { error });
  }

  /** The dispatch never left the process — drop the wait without settling a verdict. */
  cancel(editId: string): void {
    const entry = this.pending.get(editId);
    if (!entry) {
      return;
    }
    this.pending.delete(editId);
    clearTimeout(entry.timer);
    entry.resolve(null);
  }
}
