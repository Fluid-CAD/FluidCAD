import { Camera, Vector3 } from 'three';
import {
  AnchorPurpose, ApplyFeatureEntity, ConnectorAnchorCandidate, ConnectorAnchorsResult, fetchConnectorAnchors,
} from '../../api';
import { SubSelection } from '../../types';
import { Viewer } from '../../viewer';
import { ConnectorGhostOverlay } from './connector-ghost';

/** Hovering across faces settles briefly before the anchors round-trip. */
const HOVER_FETCH_DEBOUNCE_MS = 100;

/** What the kernel answered for one face/edge. */
type AnchorCacheEntry = {
  entity: ApplyFeatureEntity;
  result: ConnectorAnchorsResult;
};

/** A suggestion the user clicked: the entity, its anchors and the one nearest the click. */
export type LockedAnchor = {
  entity: ApplyFeatureEntity;
  key: string;
  anchors: ConnectorAnchorCandidate[];
  anchorIndex: number;
  /**
   * Synthesized source selector (no anchor suffix), e.g. `e.endFaces(0)`.
   * Null unless the rail was built with `needsArgs` — the connector tool's
   * preview synthesizes the expression itself.
   */
  args: string | null;
  /** Whether committing the anchor creates a connector in its part. */
  inPart: boolean;
  /** A connector name unique within the enclosing part (`c1`, `c2`, …); null outside a part. */
  defaultName: string | null;
};

export function anchorEntityKey(entity: ApplyFeatureEntity): string {
  return `${entity.shapeId}:${entity.sub.type}:${entity.sub.index}`;
}

/** "Face center" / "Edge start" — a locked anchor's human label. */
export function anchorChipLabel(entity: ApplyFeatureEntity, anchor: ConnectorAnchorCandidate): string {
  const shape = entity.sub.type === 'face' ? 'Face' : 'Edge';
  const kind = anchor.anchor.kind === 'offset'
    ? `offset ${anchor.anchor.value}`
    : anchor.anchor.kind;
  return `${shape} ${kind}`;
}

/**
 * The anchor-suggestion rail the Connector tool and the Hole dialog share:
 * hovering a solid face/edge fetches its anchor frames (debounced) and
 * floats the one nearest the cursor as a translucent gizmo; a click locks
 * that suggestion and reports it through `onLock`. A click that outruns the
 * hover fetch (or a touch tap, which never hovers) fetches on the spot and
 * locks when the anchors land; a pick the kernel refused reports its reason
 * through `onRefuse`.
 *
 * Hover asks for frames only — milliseconds on any model. The source
 * expression is a selector search over the whole part, so it is fetched
 * once, on a click, and only for an owner that needs it at lock time
 * (`needsArgs`: the Hole dialog). Every answer is kept per entity until the
 * scene re-renders, so the click on the hovered entity locks at once and a
 * re-hover paints without a round-trip. At most one request is in flight:
 * an aborted fetch still costs the server its whole computation, so a sweep
 * across the part would otherwise queue one per entity crossed; the rail
 * asks for whatever is under the cursor when the previous answer lands.
 */
export class AnchorSuggestions {
  /** A suggestion was clicked. */
  onLock?: (locked: LockedAnchor) => void;
  /** The kernel refused the clicked entity; null when it gave no reason. */
  onRefuse?: (reason: string | null) => void;

  private enabled = false;
  /** The face/edge under the cursor, or null. */
  private hover: { key: string; entity: ApplyFeatureEntity } | null = null;
  private hoverTimer: number | null = null;
  private lastCursor: { x: number; y: number } | null = null;
  /** Answers per entity key, until {@link clear} (shape ids are per render). */
  private cache = new Map<string, AnchorCacheEntry>();
  /** The one request in flight; its answer is cached whatever the cursor did meanwhile. */
  private inFlight: { key: string; abort: AbortController } | null = null;
  /** A click waiting for its entity's answer. */
  private pendingLock: { key: string; entity: ApplyFeatureEntity } | null = null;
  /** The suggestion gizmo currently drawn, keyed by entity + anchor. */
  private suggestionShown: { key: string; index: number } | null = null;

  constructor(
    private readonly viewer: Viewer,
    private readonly ghost: ConnectorGhostOverlay,
    private readonly opts: {
      /**
       * An anchor already taken (the connector tool's locked pick, a hole
       * placement) — hovering it floats no faint twin underneath.
       */
      isTaken?: (key: string, anchorIndex: number) => boolean;
      /** What the anchor becomes; a hole placement may sit outside a part. Defaults to a connector. */
      purpose?: AnchorPurpose;
      /** Locks carry the synthesized source expression (`LockedAnchor.args`). */
      needsArgs?: boolean;
    } = {},
  ) {}

  get isEnabled(): boolean {
    return this.enabled;
  }

  /** Arm or disarm the rail; disarming drops any pending fetch and the gizmo. */
  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    if (!enabled) {
      this.clear();
    }
  }

  /**
   * Viewer hover: float the nearest anchor of the hovered face/edge. A locked
   * pick doesn't stop the hunt — other faces/edges keep floating suggestions
   * so the next click can lock there.
   */
  handleHover(shapeId: string | null, sub: SubSelection, clientX: number, clientY: number): void {
    if (!this.enabled) {
      return;
    }
    if (!shapeId || !sub || (sub.type !== 'face' && sub.type !== 'edge')) {
      // The cursor left the solid — or a mousedown cleared the hover ahead
      // of its click. Either way the answers stay cached for that click.
      this.cancelHoverTimer();
      this.hover = null;
      this.clearSuggestionGhost();
      return;
    }
    this.lastCursor = { x: clientX, y: clientY };
    const key = `${shapeId}:${sub.type}:${sub.index}`;
    const cached = this.cache.get(key);
    if (cached) {
      this.cancelHoverTimer();
      this.hover = { key, entity: cached.entity };
      this.paint(key, cached.result);
      return;
    }
    if (this.hover?.key === key) {
      return; // fetch already scheduled or in flight
    }
    this.hover = { key, entity: { shapeId, sub: { type: sub.type, index: sub.index } } };
    this.cancelHoverTimer();
    this.hoverTimer = window.setTimeout(() => {
      this.hoverTimer = null;
      this.pump();
    }, HOVER_FETCH_DEBOUNCE_MS);
  }

  /**
   * Viewport click: lock the floated suggestion. Returns whether the click
   * was a face/edge pick this rail handles (the owner then leaves it alone).
   */
  handleClick(shapeId: string | null, sub: SubSelection): boolean {
    if (!this.enabled || !shapeId || !sub || (sub.type !== 'face' && sub.type !== 'edge')) {
      return false;
    }
    const key = `${shapeId}:${sub.type}:${sub.index}`;
    const cached = this.cache.get(key);
    if (cached && this.canLock(cached)) {
      this.pendingLock = null;
      this.settle(cached.entity, cached.result);
      return true;
    }
    // Not answered yet (click before the hover settled), or answered without
    // the expression a lock needs — fetch and lock when it lands.
    this.pendingLock = { key, entity: { shapeId, sub: { type: sub.type, index: sub.index } } };
    this.pump();
    return true;
  }

  /** Drop everything: the scene re-rendered (shape ids are per render) or the rail disarmed. */
  clear(): void {
    this.cancelHoverTimer();
    this.inFlight?.abort.abort();
    this.inFlight = null;
    this.pendingLock = null;
    this.hover = null;
    this.cache.clear();
    this.clearSuggestionGhost();
  }

  /** Repaint the faint gizmo — a taken anchor may have just been released. */
  refresh(): void {
    const cached = this.hover ? this.cache.get(this.hover.key) : undefined;
    if (cached?.result.ok) {
      this.showNearestSuggestion(this.hover!.key, cached.result.anchors, true);
    }
  }

  dispose(): void {
    this.clear();
  }

  /**
   * Start the next request when none is in flight: a waiting click first,
   * else the hovered entity once its debounce has run out.
   */
  private pump(): void {
    if (this.inFlight || !this.enabled) {
      return;
    }
    if (this.pendingLock) {
      const cached = this.cache.get(this.pendingLock.key);
      if (cached && this.canLock(cached)) {
        this.pendingLock = null;
        this.settle(cached.entity, cached.result);
      } else {
        void this.fetch(this.pendingLock.key, this.pendingLock.entity, this.opts.needsArgs === true);
        return;
      }
    }
    if (this.hover && this.hoverTimer === null && !this.cache.has(this.hover.key)) {
      void this.fetch(this.hover.key, this.hover.entity, false);
    }
  }

  private async fetch(key: string, entity: ApplyFeatureEntity, withArgs: boolean): Promise<void> {
    const abort = new AbortController();
    const request = { key, abort };
    this.inFlight = request;
    let result: ConnectorAnchorsResult;
    try {
      result = await fetchConnectorAnchors(entity, abort.signal, this.opts.purpose, !withArgs);
    } catch {
      // Aborted by clear(), which already reset the rail — or the request
      // failed: free the slot; the next hover or click asks again.
      if (this.inFlight === request) {
        this.inFlight = null;
      }
      return;
    }
    if (this.inFlight !== request) {
      return;
    }
    this.inFlight = null;
    // A frames-only answer never replaces one that carries the expression.
    const previous = this.cache.get(key);
    if (!(previous && this.canLock(previous) && !this.canLock({ entity, result }))) {
      this.cache.set(key, { entity, result });
    }
    if (this.hover?.key === key) {
      this.paint(key, this.cache.get(key)!.result, true);
    }
    this.pump();
  }

  /** The answer has what a lock needs: a refusal to report, or the anchors (plus the expression, when asked). */
  private canLock(entry: AnchorCacheEntry): boolean {
    return !entry.result.ok || !this.opts.needsArgs || entry.result.args !== null;
  }

  /** Paint the hovered entity's answer: its nearest anchor, or nothing for a refusal. */
  private paint(key: string, result: ConnectorAnchorsResult, force = false): void {
    if (result.ok) {
      this.showNearestSuggestion(key, result.anchors, force);
    } else {
      this.clearSuggestionGhost();
    }
  }

  private cancelHoverTimer(): void {
    if (this.hoverTimer !== null) {
      window.clearTimeout(this.hoverTimer);
      this.hoverTimer = null;
    }
  }

  /** A click's outcome: the nearest anchor locked, or the kernel's refusal. */
  private settle(entity: ApplyFeatureEntity, result: ConnectorAnchorsResult): void {
    // strictNullChecks is off — `'reason' in` narrows where `.ok` can't.
    if ('reason' in result) {
      this.onRefuse?.(result.reason ?? null);
      return;
    }
    if (result.anchors.length === 0) {
      return;
    }
    const anchorIndex = this.lastCursor ? this.nearestIndex(result.anchors, this.lastCursor) : 0;
    // The faint suggestion graduates to whatever the owner draws for a lock.
    this.clearSuggestionGhost();
    this.onLock?.({
      entity,
      key: anchorEntityKey(entity),
      anchors: result.anchors,
      anchorIndex,
      args: result.args,
      inPart: result.inPart,
      defaultName: result.defaultName,
    });
  }

  /** Repaint the suggestion at the cursor-nearest anchor. */
  private showNearestSuggestion(key: string, anchors: ConnectorAnchorCandidate[], force = false): void {
    if (anchors.length === 0) {
      this.clearSuggestionGhost();
      return;
    }
    const nearest = this.lastCursor ? this.nearestIndex(anchors, this.lastCursor) : 0;
    // Hovering a taken anchor: the owner's strong preview already marks it —
    // a faint twin underneath would just be noise.
    if (this.opts.isTaken?.(key, nearest)) {
      this.clearSuggestionGhost();
      return;
    }
    if (!force && this.suggestionShown?.key === key && this.suggestionShown.index === nearest) {
      return;
    }
    this.suggestionShown = { key, index: nearest };
    this.ghost.showSuggestion(anchors[nearest].frame);
  }

  private clearSuggestionGhost(): void {
    this.suggestionShown = null;
    this.ghost.clearSuggestion();
  }

  private nearestIndex(anchors: ConnectorAnchorCandidate[], cursor: { x: number; y: number }): number {
    const rect = this.viewer.sceneContext.renderer.domElement.getBoundingClientRect();
    return nearestAnchorIndex(anchors, cursor, this.viewer.sceneContext.camera, rect);
  }
}

/**
 * The anchor whose hover point projects closest to the pointer — an arc's
 * center() is measured at the arc's midpoint, not the off-arc circle center.
 */
export function nearestAnchorIndex(
  anchors: ConnectorAnchorCandidate[],
  cursor: { x: number; y: number },
  camera: Camera,
  rect: { left: number; top: number; width: number; height: number },
): number {
  let best = 0;
  let bestDist = Number.POSITIVE_INFINITY;
  const projected = new Vector3();
  anchors.forEach((anchor, index) => {
    const point = anchor.hoverPoint ?? anchor.frame.origin;
    projected.set(point.x, point.y, point.z).project(camera);
    const x = rect.left + ((projected.x + 1) / 2) * rect.width;
    const y = rect.top + ((1 - projected.y) / 2) * rect.height;
    const dist = (x - cursor.x) ** 2 + (y - cursor.y) ** 2;
    if (dist < bestDist) {
      bestDist = dist;
      best = index;
    }
  });
  return best;
}
