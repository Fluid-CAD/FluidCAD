import type { SceneObjectRender, SourceLocation } from '../types';

/** One of the scene's top-level parts, as a chooser lists it. */
export type PartChoice = { name: string; sourceLocation: SourceLocation };

/**
 * The timeline's active part: the `part()` statement whose callback body
 * receives newly created statements. Invariant: whenever the scene contains
 * parts, exactly one is active — the last part by default (fresh loads, and
 * the fallback when the active part leaves the scene), the part a timeline
 * click chose, or the part the Part tool just created. Clicking the active
 * part keeps it active; only a scene without parts (or an assembly scene)
 * has none. Only the creates that would otherwise append at top level
 * follow it (pick-less sketch, standard-only plane, standard-axis helix);
 * a picked-input feature inserts in its inputs' scope regardless, which is
 * the part body exactly when those inputs live there.
 *
 * Every render re-resolves the tracked part by source line, falling back to
 * display name — an edit elsewhere in the file can shift one but not both.
 */
export class ActivePartTracker {
  private active: { name: string; sourceLocation: SourceLocation } | null = null;
  private pendingActivateLast = false;
  /** Every top-level part the last render carried, in timeline order. */
  private known: PartChoice[] = [];

  /** The active part's statement location — what apply-feature payloads carry. */
  get location(): SourceLocation | null {
    return this.active?.sourceLocation ?? null;
  }

  /**
   * The scene's parts as the last render listed them — what a chooser that
   * lets the user pick a part other than the active one (the Add-parameter
   * dialog's Part dropdown) offers. Empty when there is no active part.
   */
  get parts(): PartChoice[] {
    return this.known.slice();
  }

  /** Whether this part row is the active part (drives its timeline highlight). */
  isActive(obj: SceneObjectRender): boolean {
    if (!this.active || obj.type !== 'part' || !obj.sourceLocation) {
      return false;
    }
    return this.sameLine(obj.sourceLocation);
  }

  /** A part row click: make it the active part (re-clicking it is a no-op). */
  activate(obj: SceneObjectRender): void {
    if (obj.type !== 'part' || !obj.sourceLocation) {
      return;
    }
    this.active = { name: obj.name ?? '', sourceLocation: obj.sourceLocation };
  }

  /** Assembly scenes have no active part. */
  clear(): void {
    this.active = null;
    this.known = [];
    this.pendingActivateLast = false;
  }

  /** The Part tool wrote a statement — adopt the newest part on the next render. */
  activateLastOnNextRender(): void {
    this.pendingActivateLast = true;
  }

  /**
   * Re-resolve against a fresh render. Runs before the timeline redraws so
   * the row highlight reads the updated state. Keeps the invariant: with
   * parts in the scene one is always active — the tracked one when it still
   * resolves, else the last part.
   */
  sync(objects: SceneObjectRender[]): void {
    const parts = objects.filter(o => o.type === 'part' && !o.parentId && o.sourceLocation != null);
    if (parts.length === 0) {
      this.clear();
      return;
    }
    this.known = parts.map(o => ({ name: o.name ?? '', sourceLocation: o.sourceLocation! }));
    const last = parts[parts.length - 1];
    if (this.pendingActivateLast) {
      this.pendingActivateLast = false;
      this.activate(last);
      return;
    }
    const match = this.active === null
      ? undefined
      : parts.find(o => this.sameLine(o.sourceLocation!))
        ?? parts.find(o => o.sourceLocation!.filePath === this.active!.sourceLocation.filePath
          && o.name === this.active!.name);
    // Adopt the row's current name and location — inserts above the statement
    // shift its line; a rename keeps the line but changes the name.
    this.activate(match ?? last);
  }

  private sameLine(loc: SourceLocation): boolean {
    return ActivePartTracker.sameStatement(loc, this.active!.sourceLocation);
  }

  /** Whether two locations address the same statement — file and line, as `sync` resolves parts. */
  static sameStatement(a: SourceLocation, b: SourceLocation): boolean {
    return a.filePath === b.filePath && a.line === b.line;
  }

  /**
   * One display label per part for a chooser, in the same order. A name two
   * parts share, or an empty one, is told apart by the statement's line.
   */
  static choiceLabels(parts: PartChoice[]): string[] {
    const nameCount = new Map<string, number>();
    for (const part of parts) {
      nameCount.set(part.name, (nameCount.get(part.name) ?? 0) + 1);
    }
    return parts.map((part) => {
      const ambiguous = part.name === '' || (nameCount.get(part.name) ?? 0) > 1;
      return ambiguous ? `${part.name || 'part'} (line ${part.sourceLocation.line})` : part.name;
    });
  }
}
