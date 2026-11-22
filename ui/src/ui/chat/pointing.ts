// What the agent points at, in the viewport (docs/agent-chat-plan.md §27).
//
// A `show_user` card names its items by what to resolve — a selector, or a
// face or edge of the render it was shown in — never by the shape ids they
// resolved to, which are one render's. This is the page's side: it resolves
// the items of the one card that is shown against the model on screen
// (`POST api/resolve-selection`, as the composer's references do for picks),
// draws them in the live viewport, each in the colour of its chip, and does
// it again after every render. An item that no longer resolves is *stale*:
// it is not drawn, and its chip says so, instead of pointing at whatever
// took its place.
//
// One card is shown at a time: showing another replaces it. What is shown is
// page state, like the composer's picks: it is neither sent nor stored, so a
// reloaded page shows the cards with nothing highlighted until one is shown
// again.

import type { ShowPart, ShowTarget } from './chat-types';
import { referenceColor } from './reference-colors';

/** One face or edge to draw: a match of this render. */
export type PointRef = { shapeId: string; kind: 'face' | 'edge'; index: number; instanceId?: string };

/** A highlight entry of the live viewport: a face or edge in its item's colour, faint when another item is emphasised. */
export type PointHighlight = PointRef & { color: string; dim?: boolean };

export type TargetOutcome = { ok: true; refs: PointRef[] } | { ok: false; reason: string };

/** Resolves an item's target to the faces and edges it is in the current render: `POST api/resolve-selection`, or a fake in tests. */
export type TargetResolver = (target: ShowTarget) => Promise<TargetOutcome>;

/** What the page lends the panel to point in the viewport (main.ts builds it). */
export type ChatPointHost = {
  /** The model file on screen, absolute; null when none is. Already the new render's when a render listener is told. */
  file(): string | null;
  /**
   * Draws these faces and edges in the live viewport until the next call,
   * each in its colour, through whatever occludes it (as the references
   * capture draws them, §11.2). Empty: nothing is drawn.
   */
  draw(highlight: PointHighlight[]): void;
  /** Called on every render, once the viewport holds the new meshes; returns the unsubscribe. */
  addRenderListener(fn: () => void): () => void;
  /** Defaults to {@link httpTargetResolver}. */
  resolve?: TargetResolver;
};

/** `POST api/resolve-selection` with the item's selector or pick (a relative URL: the page is served at `/` and `/p/<id>/`). */
export const httpTargetResolver: TargetResolver = async (target) => {
  try {
    const res = await fetch('api/resolve-selection', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify('pick' in target ? { picks: [target.pick] } : { expression: target.expression, ...(target.scope ? { scope: target.scope } : {}) }),
    });
    const body = await res.json().catch(() => null);
    if (!res.ok || !body || body.ok !== true || !Array.isArray(body.matches)) {
      return { ok: false, reason: typeof body?.error === 'string' ? body.error : `It could not be resolved (HTTP ${res.status}).` };
    }
    return { ok: true, refs: readRefs(body.matches) };
  } catch (err) {
    return { ok: false, reason: `It could not be resolved: ${err instanceof Error ? err.message : String(err)}` };
  }
};

/** The faces and edges among an answer's matches, with nothing else a match carries. */
export function readRefs(matches: unknown[]): PointRef[] {
  const refs: PointRef[] = [];
  for (const raw of matches) {
    const match = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
    if (typeof match.shapeId !== 'string' || (match.kind !== 'face' && match.kind !== 'edge') || !Number.isInteger(match.index)) {
      continue;
    }
    refs.push({
      shapeId: match.shapeId,
      kind: match.kind,
      index: match.index as number,
      ...(typeof match.instanceId === 'string' ? { instanceId: match.instanceId } : {}),
    });
  }
  return refs;
}

/**
 * How an item of the shown card stands:
 * - `resolving`: asked, not answered yet (the first time only; a re-render keeps what it showed until the answer);
 * - `shown`: drawn in the viewport;
 * - `stale`: it no longer resolves in the model on screen; `reason` says why.
 */
export type PointedItem = { n: number; state: 'resolving' | 'shown' | 'stale'; reason?: string };

/** How the shown card stands. `offScreen`: its file is not the model on screen, so nothing of it is drawn. */
export type PointedCard = { items: PointedItem[]; offScreen: boolean; emphasised: number | null };

export const STALE_NOTHING = 'It matches nothing in the model as it is now.';

/** What a `show_user` card needs to draw itself in the viewport (the panel's {@link Pointing}). */
export type Pointer = {
  /** How card `partId` stands when it is the one shown; null when it is not. */
  shown(partId: string): PointedCard | null;
  /** Show this card's items in the viewport, in place of whichever card was shown. */
  show(part: ShowPart): void;
  /** Stop showing card `partId` (nothing happens when another card is the one shown). */
  clear(partId: string): void;
  /** Draw item `n` of the shown card `partId` alone at full strength, the others faint; null: all alike again. */
  emphasise(partId: string, n: number | null): void;
  /** True the first time it is asked about a card: a card that has just arrived shows itself once, a repainted one does not. */
  firstSight(partId: string): boolean;
  /** `listener` is told whenever which card is shown, or how its items stand, changes; returns what stops it. */
  subscribe(listener: () => void): () => void;
};

type Shown = {
  part: ShowPart;
  /** By item, in the part's order. */
  items: (PointedItem & { refs: PointRef[] })[];
  offScreen: boolean;
  emphasised: number | null;
  /** Bumped by every round of resolving: an answer of an older round is dropped. */
  round: number;
};

/**
 * The panel's pointing: which `show_user` card is shown in the viewport, how
 * each of its items stands against the model on screen, and the drawing.
 */
export class Pointing implements Pointer {
  private current: Shown | null = null;
  private readonly seen = new Set<string>();
  private readonly listeners = new Set<() => void>();
  private readonly resolve: TargetResolver;
  private readonly unsubscribe: () => void;

  constructor(private readonly host: ChatPointHost) {
    this.resolve = host.resolve ?? httpTargetResolver;
    this.unsubscribe = host.addRenderListener(() => this.onRender());
  }

  shown(partId: string): PointedCard | null {
    const current = this.current;
    if (!current || current.part.id !== partId) {
      return null;
    }
    return {
      items: current.items.map(({ n, state, reason }) => ({ n, state, ...(reason ? { reason } : {}) })),
      offScreen: current.offScreen,
      emphasised: current.emphasised,
    };
  }

  show(part: ShowPart): void {
    this.seen.add(part.id);
    this.current = {
      part,
      items: part.items.map((item) => ({ n: item.n, state: 'resolving', refs: [] })),
      offScreen: false,
      emphasised: null,
      round: 0,
    };
    this.host.draw([]);
    this.refresh();
    this.notify();
  }

  clear(partId: string): void {
    if (this.current?.part.id === partId) {
      this.clearAll();
    }
  }

  /** Nothing is shown any more (the panel closed, another chat came on screen). */
  clearAll(): void {
    if (!this.current) {
      return;
    }
    this.current = null;
    this.host.draw([]);
    this.notify();
  }

  emphasise(partId: string, n: number | null): void {
    const current = this.current;
    if (!current || current.part.id !== partId || current.emphasised === n) {
      return;
    }
    current.emphasised = n;
    this.draw();
    this.notify();
  }

  firstSight(partId: string): boolean {
    if (this.seen.has(partId)) {
      return false;
    }
    this.seen.add(partId);
    return true;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  destroy(): void {
    this.unsubscribe();
    if (this.current) {
      this.current = null;
      this.host.draw([]);
    }
    this.listeners.clear();
  }

  // ---------------------------------------------------------------------------

  /** The model re-rendered: what was drawn went with the old meshes, and every item is resolved again. */
  private onRender(): void {
    if (!this.current) {
      return;
    }
    // The ids drawn were the last render's.
    for (const item of this.current.items) {
      item.refs = [];
    }
    this.host.draw([]);
    this.refresh();
  }

  /** Resolve every item of the shown card against the model on screen, then draw what resolved. */
  private refresh(): void {
    const current = this.current;
    if (!current) {
      return;
    }
    const round = ++current.round;
    const file = this.host.file();
    const offScreen = file === null || !samePath(file, current.part.absPath);
    if (offScreen) {
      // Another model is on screen: a selector would be resolved in a file it was not written for.
      const changed = !current.offScreen;
      current.offScreen = true;
      if (changed) {
        this.notify();
      }
      return;
    }
    current.offScreen = false;
    void Promise.all(current.part.items.map((item) => this.resolveSafely(item.target))).then((outcomes) => {
      if (this.current !== current || current.round !== round) {
        return;
      }
      outcomes.forEach((outcome, index) => {
        const item = current.items[index];
        if (outcome.ok === true && outcome.refs.length > 0) {
          item.state = 'shown';
          item.refs = outcome.refs;
          delete item.reason;
        } else {
          item.state = 'stale';
          item.refs = [];
          item.reason = outcome.ok === true ? STALE_NOTHING : outcome.reason;
        }
      });
      this.draw();
      this.notify();
    });
  }

  private async resolveSafely(target: ShowTarget): Promise<TargetOutcome> {
    try {
      return await this.resolve(target);
    } catch (err) {
      return { ok: false, reason: `It could not be resolved: ${err instanceof Error ? err.message : String(err)}` };
    }
  }

  private draw(): void {
    const current = this.current;
    if (!current || current.offScreen) {
      this.host.draw([]);
      return;
    }
    const highlight: PointHighlight[] = [];
    for (const item of current.items) {
      if (item.state !== 'shown') {
        continue;
      }
      const color = referenceColor(item.n).hex;
      const dim = current.emphasised !== null && current.emphasised !== item.n;
      for (const ref of item.refs) {
        highlight.push({ ...ref, color, ...(dim ? { dim: true } : {}) });
      }
    }
    this.host.draw(highlight);
  }

  private notify(): void {
    for (const listener of [...this.listeners]) {
      listener();
    }
  }
}

/** A file as a render names it, compared whatever its separators and the live-render prefix. */
function samePath(a: string, b: string): boolean {
  const norm = (p: string) => p.replace(/^virtual:live-render:/, '').replace(/\\/g, '/');
  return norm(a) === norm(b);
}
