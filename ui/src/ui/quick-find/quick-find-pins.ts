import type { QuickFindTool, ToolIndex } from './tool-index';

/**
 * The tools the Quick Find popover shows before a word is typed: the user's
 * pins, by tool id, a preference that follows them into every project
 * (`quickFindPins`, like the toolbar's pinned packages). Until the user pins
 * or unpins anything the list is {@link QuickFindPins.DEFAULTS}, six tools
 * for each bench; the stored list is null then, so a new default can reach
 * a user who never touched the pins.
 *
 * Pins are one list across the benches: a pinned tool shows whenever its
 * bench does (the part tools in a part, the sketch tools in a sketch), and
 * the popover shows at most {@link LIMIT} at a time — a seventh pin in a
 * context that already shows six takes the sixth one's slot, and that tool
 * is unpinned (the pin control says which beforehand).
 */
export class QuickFindPins {
  /** Most pins shown at once. */
  static readonly LIMIT = 6;

  /** What a user who never pinned anything sees: six tools per bench. */
  static readonly DEFAULTS: readonly string[] = Object.freeze([
    'part:sketch', 'part:extrude', 'part:revolve', 'part:hole', 'part:fillet', 'part:shell',
    'sketch:line', 'sketch:rect', 'sketch:circle', 'constraint:dimension', 'sketch:trim', 'sketch:fillet',
    'assembly:insert', 'assembly:fastened', 'assembly:revolute', 'assembly:slider', 'assembly:replicate', 'assembly:connector',
  ]);

  /** The user pinned or unpinned a tool: the list to store, null once it is the defaults again. */
  onChange?: (pins: string[] | null) => void;

  private pins: string[] | null = null;

  constructor(private readonly index: ToolIndex) {}

  /** The pins as stored (the preferences loaded, or reset): no {@link onChange}. */
  set(pins: readonly string[] | null): void {
    this.pins = pins === null ? null : [...pins];
  }

  /** The pinned ids, in pin order: the user's, or the defaults. */
  get list(): readonly string[] {
    return this.pins ?? QuickFindPins.DEFAULTS;
  }

  isPinned(id: string): boolean {
    return this.list.includes(id);
  }

  /** The pinned tools on the bar right now, in pin order, at most {@link LIMIT}. */
  shown(): QuickFindTool[] {
    const shown: QuickFindTool[] = [];
    for (const id of this.list) {
      const tool = this.index.get(id);
      if (tool && tool.isAvailable()) {
        shown.push(tool);
        if (shown.length === QuickFindPins.LIMIT) {
          break;
        }
      }
    }
    return shown;
  }

  /** No room for another pin in the current context. */
  get full(): boolean {
    return this.shown().length >= QuickFindPins.LIMIT;
  }

  /** The pin a new one would take the slot of: the last shown, while the context is {@link full}; else null. */
  get evictee(): QuickFindTool | null {
    const shown = this.shown();
    return shown.length >= QuickFindPins.LIMIT ? shown[shown.length - 1] : null;
  }

  /**
   * Pin `id`. While the context already shows {@link LIMIT} pins it takes
   * the last one's slot in the stored list (so the other benches' pins keep
   * theirs) and that tool is unpinned. Returns the id it replaced, else null.
   */
  pin(id: string): string | null {
    if (this.isPinned(id)) {
      return null;
    }
    const evictee = this.evictee;
    if (evictee) {
      this.pins = this.list.map(pinned => (pinned === evictee.id ? id : pinned));
    } else {
      this.pins = [...this.list, id];
    }
    this.changed();
    return evictee?.id ?? null;
  }

  /**
   * The shown pins in a new order (a tile dragged to another slot): they
   * take, in that order, the slots they held in the stored list, so pins of
   * the other benches keep theirs. Ids that aren't shown pins are ignored;
   * shown pins left out keep their place.
   */
  reorder(ids: readonly string[]): void {
    const shown = this.shown().map(tool => tool.id);
    const moving = ids.filter(id => shown.includes(id));
    if (moving.length < 2) {
      return;
    }
    const list = [...this.list];
    const slots = list.map((id, i) => (moving.includes(id) ? i : -1)).filter(i => i >= 0);
    if (slots.every((slot, k) => list[slot] === moving[k])) {
      return;
    }
    slots.forEach((slot, k) => {
      list[slot] = moving[k];
    });
    this.pins = list;
    this.changed();
  }

  unpin(id: string): void {
    if (!this.isPinned(id)) {
      return;
    }
    this.pins = this.list.filter(pinned => pinned !== id);
    this.changed();
  }

  private changed(): void {
    const pins = this.pins!;
    const defaults = QuickFindPins.DEFAULTS;
    if (pins.length === defaults.length && pins.every((id, i) => id === defaults[i])) {
      this.pins = null;
    }
    this.onChange?.(this.pins === null ? null : [...this.pins]);
  }
}
