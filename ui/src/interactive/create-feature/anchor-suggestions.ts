import { Camera, Vector3 } from 'three';
import {
  AnchorPurpose, ApplyFeatureEntity, ConnectorAnchorCandidate, ConnectorAnchorsResult, fetchConnectorAnchors,
} from '../../api';
import { SubSelection } from '../../types';
import { Viewer } from '../../viewer';
import { ConnectorGhostOverlay } from './connector-ghost';

/** Hovering across faces settles briefly before the anchors round-trip. */
const HOVER_FETCH_DEBOUNCE_MS = 100;

/** The anchors a hovered entity offered, cached until the hover moves on. */
type AnchorCache = {
  key: string;
  entity: ApplyFeatureEntity;
  result: ConnectorAnchorsResult;
};

/** A suggestion the user clicked: the entity, its anchors and the one nearest the click. */
export type LockedAnchor = {
  entity: ApplyFeatureEntity;
  key: string;
  anchors: ConnectorAnchorCandidate[];
  anchorIndex: number;
  /** Synthesized source selector (no anchor suffix), e.g. `e.endFaces(0)`. */
  args: string;
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
 * hovering a solid face/edge fetches its anchor candidates (debounced,
 * cached per entity) and floats the one nearest the cursor as a translucent
 * gizmo; a click locks that suggestion and reports it through `onLock`. A
 * click that outruns the hover fetch (or a touch tap, which never hovers)
 * fetches on the spot and locks when the anchors land; a pick the kernel
 * refused reports its reason through `onRefuse`.
 */
export class AnchorSuggestions {
  /** A suggestion was clicked. */
  onLock?: (locked: LockedAnchor) => void;
  /** The kernel refused the clicked entity; null when it gave no reason. */
  onRefuse?: (reason: string | null) => void;

  private enabled = false;
  /** The entity under the cursor, or null. */
  private hoverKey: string | null = null;
  private hoverTimer: number | null = null;
  private hoverAbort: AbortController | null = null;
  private hoverSeq = 0;
  private lastCursor: { x: number; y: number } | null = null;
  private cache: AnchorCache | null = null;
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
      this.clear();
      return;
    }
    this.lastCursor = { x: clientX, y: clientY };
    const key = `${shapeId}:${sub.type}:${sub.index}`;
    if (this.cache?.key === key) {
      if (this.cache.result.ok) {
        this.showNearestSuggestion(key, this.cache.result.anchors);
      }
      return;
    }
    if (this.hoverKey === key) {
      return; // fetch already pending
    }
    this.hoverKey = key;
    const entity: ApplyFeatureEntity = { shapeId, sub: { type: sub.type, index: sub.index } };
    if (this.hoverTimer !== null) {
      window.clearTimeout(this.hoverTimer);
    }
    this.hoverTimer = window.setTimeout(() => {
      this.hoverTimer = null;
      void this.fetchAnchors(key, entity, false);
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
    if (this.cache?.key === key) {
      this.settle(this.cache.entity, this.cache.result);
      return true;
    }
    // No cached anchors (click before hover settled) — fetch and lock.
    const entity: ApplyFeatureEntity = { shapeId, sub: { type: sub.type, index: sub.index } };
    this.hoverKey = key;
    if (this.hoverTimer !== null) {
      window.clearTimeout(this.hoverTimer);
      this.hoverTimer = null;
    }
    void this.fetchAnchors(key, entity, true);
    return true;
  }

  /** Drop the hover suggestion (fetches, cache, gizmo). */
  clear(): void {
    if (this.hoverTimer !== null) {
      window.clearTimeout(this.hoverTimer);
      this.hoverTimer = null;
    }
    this.hoverAbort?.abort();
    this.hoverAbort = null;
    this.hoverSeq++;
    this.hoverKey = null;
    this.cache = null;
    this.clearSuggestionGhost();
  }

  /** Repaint the faint gizmo — a taken anchor may have just been released. */
  refresh(): void {
    if (this.cache?.result.ok && this.hoverKey === this.cache.key) {
      this.showNearestSuggestion(this.cache.key, this.cache.result.anchors, true);
    }
  }

  dispose(): void {
    this.clear();
  }

  private async fetchAnchors(key: string, entity: ApplyFeatureEntity, lock: boolean): Promise<void> {
    const seq = ++this.hoverSeq;
    this.hoverAbort?.abort();
    const abort = new AbortController();
    this.hoverAbort = abort;

    let result: ConnectorAnchorsResult;
    try {
      result = await fetchConnectorAnchors(entity, abort.signal, this.opts.purpose);
    } catch {
      return; // aborted
    }
    if (seq !== this.hoverSeq || !this.enabled || (!lock && this.hoverKey !== key)) {
      return;
    }
    this.cache = { key, entity, result };
    if (lock) {
      this.settle(entity, result);
      return;
    }
    if (result.ok) {
      this.showNearestSuggestion(key, result.anchors, true);
    } else {
      this.clearSuggestionGhost();
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
