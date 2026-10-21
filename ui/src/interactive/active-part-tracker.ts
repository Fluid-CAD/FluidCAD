import type { SceneObjectRender, SourceLocation } from '../types';

/** One of the scene's top-level parts, as a chooser lists it. */
export type PartChoice = { name: string; sourceLocation: SourceLocation };

/**
 * The timeline's selected part, and whether it is the ACTIVE part: the
 * `part()` statement whose callback body receives newly created statements.
 * Invariant: whenever the scene contains parts, exactly one is selected — the
 * last part by default (fresh loads, and the fallback when the selected part
 * leaves the scene), the part a timeline click chose, or the part the Part
 * tool just created. The selected part is the active one unless the user
 * stepped out of it (clicked its row while it was active): then no part is
 * active and creates land at the file's top level, while the part stays
 * selected — the part the Parameters panel stays on. Its timeline row reads
 * like every other inactive part. Only a scene without parts (or an assembly
 * scene) has neither.
 *
 * A create follows the active part whenever no input pins the statement
 * elsewhere: the pick-less sketch, a standard-only plane or helix, and any
 * feature built from sketches, planes and axes declared at the file's top
 * level (an extrude of a sketch drawn before the part). Picked geometry and
 * solid targets pin the statement to their own scope, which is the part body
 * exactly when those inputs live there — with or without a part active.
 *
 * Every render re-resolves the selected part by source line, falling back to
 * display name — an edit elsewhere in the file can shift one but not both.
 */
export class ActivePartTracker {
  private selected: PartChoice | null = null;
  /** The user stepped out of the selected part: nothing is active, creates land at the top level. */
  private steppedOut = false;
  private pendingActivateLast = false;
  /** Every top-level part the last render carried, in timeline order. */
  private known: PartChoice[] = [];

  /**
   * The active part's statement location — what apply-feature payloads
   * carry. Null at the file's top level: no parts, or stepped out.
   */
  get location(): SourceLocation | null {
    return this.steppedOut ? null : this.selectedLocation;
  }

  /** The selected part's statement location, active or stepped out of. */
  get selectedLocation(): SourceLocation | null {
    return this.selected?.sourceLocation ?? null;
  }

  /**
   * The scene's parts as the last render listed them — what a chooser that
   * lets the user pick a part other than the selected one (the
   * Add-parameter dialog's Part dropdown) offers. Empty when the scene has
   * no parts.
   */
  get parts(): PartChoice[] {
    return this.known.slice();
  }

  /** Whether this part row is the active part (the timeline's one highlighted part row). */
  isActive(obj: SceneObjectRender): boolean {
    return !this.steppedOut && this.isSelected(obj);
  }

  /** Whether this part row is the selected part, active or not (the Parameters panel's part). */
  isSelected(obj: SceneObjectRender): boolean {
    if (!this.selected || obj.type !== 'part' || !obj.sourceLocation) {
      return false;
    }
    return ActivePartTracker.sameStatement(obj.sourceLocation, this.selected.sourceLocation);
  }

  /**
   * Make a part row the selected, active part — a click on an inactive part
   * row, including the one the user stepped out of, or a pause inside the
   * part. Returns false when it already was the active part.
   */
  activate(obj: SceneObjectRender): boolean {
    if (obj.type !== 'part' || !obj.sourceLocation || this.isActive(obj)) {
      return false;
    }
    this.selected = ActivePartTracker.choiceOf(obj);
    this.steppedOut = false;
    return true;
  }

  /**
   * Step out of the active part to the file's top level: no part is active,
   * so creates land at the top level, and the part stays selected. Returns
   * false when no part was active.
   */
  deactivate(): boolean {
    if (this.selected === null || this.steppedOut) {
      return false;
    }
    this.steppedOut = true;
    return true;
  }

  /** Assembly scenes have no active part. */
  clear(): void {
    this.selected = null;
    this.steppedOut = false;
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
   * parts in the scene one is always selected — the tracked one when it
   * still resolves, stepped out of or not, else the last part, active as on
   * a fresh load.
   */
  sync(objects: SceneObjectRender[]): void {
    const parts = objects.filter(o => o.type === 'part' && !o.parentId && o.sourceLocation != null);
    if (parts.length === 0) {
      this.clear();
      return;
    }
    this.known = parts.map(ActivePartTracker.choiceOf);
    const match = this.pendingActivateLast || this.selected === null ? undefined : this.resolve(parts);
    this.pendingActivateLast = false;
    // Adopt the row's current name and location — inserts above the statement
    // shift its line; a rename keeps the line but changes the name. Without a
    // match (the part left the scene, or the Part tool just wrote a new one)
    // the last part takes over, active.
    this.selected = ActivePartTracker.choiceOf(match ?? parts[parts.length - 1]);
    if (!match) {
      this.steppedOut = false;
    }
  }

  /** The render's row for the selected part: same line, else same file and name. */
  private resolve(parts: SceneObjectRender[]): SceneObjectRender | undefined {
    const wanted = this.selected!;
    return parts.find(o => ActivePartTracker.sameStatement(o.sourceLocation!, wanted.sourceLocation))
      ?? parts.find(o => o.sourceLocation!.filePath === wanted.sourceLocation.filePath && o.name === wanted.name);
  }

  private static choiceOf(obj: SceneObjectRender): PartChoice {
    return { name: obj.name ?? '', sourceLocation: obj.sourceLocation! };
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
