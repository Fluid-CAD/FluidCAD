/** What one session's next render owes: feature modules saved since its scene was built, and feature ids. */
export type OwedRebuilds = {
  /** Feature modules (`*.feature.js`, absolute) whose code — or a module they import — changed. */
  modules: Set<string>;
  /** Feature ids whose code changed, named directly (see {@link FeatureRebuilds.noteId}). */
  ids: Set<string>;
};

/**
 * The custom features each session's cached scene was built with older code
 * of. The render cache matches a statement by its type and its values, and a
 * code-only edit of a feature module changes neither: without this, the
 * statement would keep its old geometry until a value changed or the engine
 * restarted.
 *
 * A save notes the module for every session whose last render read it; that
 * session's next render takes what it owes, asks the compare to rebuild the
 * features the module defines (see `FluidCadServer.processFileInternal`),
 * and from then on caches as before. Nothing is noted while no feature code
 * changes, so a render costs nothing more otherwise.
 */
export class FeatureRebuilds {
  private readonly owed = new Map<string, OwedRebuilds>();

  /** A feature module the session's cached scene was built from changed. */
  noteModule(sessionId: string, modulePath: string): void {
    this.entry(sessionId).modules.add(modulePath);
  }

  /**
   * A feature's code changed under its id — the hook for an installed
   * package's upgrade, whose modules move to a new directory while its ids
   * stay.
   */
  noteId(sessionId: string, id: string): void {
    this.entry(sessionId).ids.add(id);
  }

  /** Whether the session's next render owes a rebuild — its cached renders are stale. */
  owes(sessionId: string): boolean {
    return this.owed.has(sessionId);
  }

  /**
   * What the session's next render owes, forgotten here: a change noted from
   * now on is the render after's. Null when it owes nothing.
   */
  take(sessionId: string): OwedRebuilds | null {
    const owed = this.owed.get(sessionId) ?? null;
    this.owed.delete(sessionId);
    return owed;
  }

  /** The render that took `owed` failed before its compare: the next one owes it again. */
  restore(sessionId: string, owed: OwedRebuilds): void {
    const entry = this.entry(sessionId);
    for (const modulePath of owed.modules) {
      entry.modules.add(modulePath);
    }
    for (const id of owed.ids) {
      entry.ids.add(id);
    }
  }

  forget(sessionId: string): void {
    this.owed.delete(sessionId);
  }

  private entry(sessionId: string): OwedRebuilds {
    let entry = this.owed.get(sessionId);
    if (!entry) {
      entry = { modules: new Set(), ids: new Set() };
      this.owed.set(sessionId, entry);
    }
    return entry;
  }
}
