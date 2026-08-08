import { Vector3 } from 'three';
import {
  ApplyFeatureEntity, applyConnector, ConnectorAnchorCandidate, ConnectorAnchorsResult,
  ConnectorApplyOptions, fetchConnectorAnchors,
} from '../../api';
import { SceneObjectRender, SubSelection } from '../../types';
import { Viewer } from '../../viewer';
import { Navbar } from '../../ui/navbar';
import { ConnectorPanel } from './connector-panel';
import { ConnectorGhostOverlay, adjustConnectorFrame } from './connector-ghost';
import { FeatureButton } from './feature-button';
import { ApplyRunner } from './apply-runner';
import { SketchUISuspender } from './sketch-suspender';
import { collectSolidTargets } from './solid-targets';
import { collectSketchProfiles } from './sketch-profiles';

/** Hovering across faces settles briefly before the anchors round-trip. */
const HOVER_FETCH_DEBOUNCE_MS = 100;

/** The anchors a hovered entity offered, cached until the hover moves on. */
type AnchorCache = {
  key: string;
  entity: ApplyFeatureEntity;
  result: ConnectorAnchorsResult;
};

/** The clicked suggestion the dialog is editing. */
type LockedAnchor = {
  entity: ApplyFeatureEntity;
  key: string;
  anchors: ConnectorAnchorCandidate[];
  anchorIndex: number;
  /** Synthesized source selector (no anchor suffix), e.g. `e.endFaces(0)`. */
  args: string;
};

function entityKey(entity: ApplyFeatureEntity): string {
  return `${entity.shapeId}:${entity.sub.type}:${entity.sub.index}`;
}

/**
 * The Connector tool on the part-design rails: hovering solid faces/edges
 * floats the nearest known connector anchor (face center; edge
 * center/start/end) as a translucent axis-triad gizmo, exact frames served
 * by the kernel's anchor-suggestion endpoint. A click locks the suggestion
 * into the dialog — name (prefilled with the part's free `c1`-style
 * default), frame-local offset, and the 90°-per-click rotation stepper —
 * with the gizmo tracking every edit live (pure client-side frame math; the
 * kernel already supplied exact axes). Apply writes
 * `connector('name', <source>.center())` — with `.rotate('z', …)` /
 * `.offset(…)` chained as dialled — into the enclosing part() body; the
 * re-render is the preview, editor undo the rollback.
 */
export class ConnectorFeatureService {
  private panel: ConnectorPanel;
  private button: FeatureButton;
  private armed = false;
  private available = false;
  private sceneSketchActive = false;
  private sketchUI: SketchUISuspender;
  private ghost: ConnectorGhostOverlay;
  private runner: ApplyRunner<ConnectorApplyOptions>;

  /** The entity under the cursor, or null. */
  private hoverKey: string | null = null;
  private hoverTimer: number | null = null;
  private hoverAbort: AbortController | null = null;
  private hoverSeq = 0;
  private lastCursor: { x: number; y: number } | null = null;
  private cache: AnchorCache | null = null;
  /** The suggestion gizmo currently drawn, keyed by entity + anchor. */
  private suggestionShown: { key: string; index: number } | null = null;

  private locked: LockedAnchor | null = null;

  constructor(
    container: HTMLElement,
    private viewer: Viewer,
    private navbar: Navbar,
    private hooks: {
      onEnter?: () => void;
      /** Armed or disarmed — lets the Sketch button owner re-check `isActive`. */
      onActiveChange?: () => void;
      onSuspendSketchUI?: () => void;
      onResumeSketchUI?: () => void;
    } = {},
  ) {
    // The connector gets its own group after the transform tools: it is the
    // first assembly-prep tool in part mode, neither reshaping bodies
    // (modify) nor repositioning them (transform).
    const group = navbar.getGroup('connector') ?? navbar.addGroup('connector', { visible: false });
    this.button = new FeatureButton(group, {
      icon: '/icons/connect.png',
      label: 'Connector',
      tip: 'Add a mate connector',
      ariaLabel: 'Add a named mate connector to the part',
      hidden: true,
    });
    this.button.onClick = () => {
      if (this.armed) {
        this.exit();
      } else {
        this.enter();
      }
    };
    this.sketchUI = new SketchUISuspender(viewer, hooks);
    this.ghost = new ConnectorGhostOverlay(viewer);

    this.panel = new ConnectorPanel(container);
    this.panel.onApply = () => void this.runner.apply();
    this.panel.onExit = () => this.exit();
    this.panel.onChange = () => {
      this.panel.setMessage(null);
      this.updatePreviewGhost();
      this.runner.schedulePreview();
    };
    this.panel.onRemoveSource = () => {
      this.locked = null;
      this.panel.setSourceChip(null);
      this.panel.setMessage(null);
      this.panel.setPreview(null);
      this.runner.cancelPreview();
      this.ghost.clearPreview();
    };

    this.runner = new ApplyRunner({
      panel: this.panel,
      isArmed: () => this.armed,
      build: () => this.buildRequest(),
      send: (request, extras) => applyConnector({ ...request, ...extras }),
      onApplied: () => this.exit({ resume: 'lazy' }),
      failMessage: () => 'Could not add the connector.',
    });
  }

  get isActive(): boolean {
    return this.armed;
  }

  /** The armed dialog owns viewport face/edge clicks. */
  get isPicking(): boolean {
    return this.armed;
  }

  /** True while armed picking has suspended sketch editing. */
  get sketchUISuspended(): boolean {
    return this.sketchUI.suspended;
  }

  handleSceneRendered(sceneObjects: SceneObjectRender[], _stop: number, isRollback: boolean): void {
    this.update(isRollback ? [] : sceneObjects);
  }

  update(sceneObjects: SceneObjectRender[]): void {
    this.sceneSketchActive = collectSketchProfiles(sceneObjects)[0]?.kind === 'active';
    this.available = collectSolidTargets(sceneObjects).length > 0;
    this.navbar.setGroupVisible('connector', this.available, 'connector');
    this.button.setVisible(this.available);
    this.syncButton();
    if (!this.armed) {
      return;
    }
    if (!this.available) {
      this.exit({ resume: 'lazy' });
      return;
    }
    // A render can put a sketch back in front (live editing) — the armed
    // dialog keeps the free 3D view.
    if (this.sceneSketchActive) {
      this.sketchUI.suspend();
    }
    // Shape ids are per-render — the hover cache and any locked pick died
    // with the old scene. The dialog's typed values survive.
    this.clearSuggestion();
    if (this.locked) {
      this.locked = null;
      this.panel.setSourceChip(null);
      this.panel.setPreview(null);
      this.runner.cancelPreview();
      this.ghost.clear();
      this.panel.setMessage('The code changed — pick the connector location again.');
    }
  }

  enter(): void {
    if (this.armed) {
      return;
    }
    this.hooks.onEnter?.();
    this.armed = true;
    this.locked = null;
    this.clearSuggestion();
    // Placing a connector means looking at the whole solid, not down the
    // active sketch plane — leave sketch editing right away.
    if (this.sceneSketchActive) {
      this.sketchUI.suspend();
    }
    this.syncButton();
    this.panel.show();
    this.syncViewport();
  }

  /**
   * `resume: 'lazy'` re-enables sketch editing without forcing the mode
   * transition — for apply-success and scene-driven exits; user cancels
   * default to `'immediate'`.
   */
  exit(opts: { resume?: 'immediate' | 'lazy' } = {}): void {
    if (!this.armed) {
      return;
    }
    this.armed = false;
    this.locked = null;
    this.clearSuggestion();
    this.runner.cancelPreview();
    this.ghost.clear();
    this.viewer.clearHighlight();
    this.viewer.pickFilter = 'all';
    this.syncButton();
    this.panel.hide();
    this.sketchUI.resume((opts.resume ?? 'immediate') === 'immediate');
  }

  /**
   * Viewer hover while the tool is armed: fetch the hovered entity's anchor
   * candidates (debounced, cached per entity) and float the one nearest the
   * cursor as the translucent suggestion gizmo. Screen-space nearest — the
   * anchor whose origin sits closest to the pointer wins. A locked pick
   * doesn't stop the hunt: its strong preview stays put while other
   * faces/edges keep floating suggestions, and the next click re-locks.
   */
  handleHover(shapeId: string | null, sub: SubSelection, clientX: number, clientY: number): void {
    if (!this.armed) {
      return;
    }
    if (!shapeId || (sub.type !== 'face' && sub.type !== 'edge')) {
      this.clearSuggestion();
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
      void this.fetchAnchors(key, entity);
    }, HOVER_FETCH_DEBOUNCE_MS);
  }

  private async fetchAnchors(key: string, entity: ApplyFeatureEntity): Promise<void> {
    const seq = ++this.hoverSeq;
    this.hoverAbort?.abort();
    const abort = new AbortController();
    this.hoverAbort = abort;

    let result: ConnectorAnchorsResult;
    try {
      result = await fetchConnectorAnchors(entity, abort.signal);
    } catch {
      return; // aborted
    }
    if (seq !== this.hoverSeq || !this.armed || this.hoverKey !== key) {
      return;
    }
    this.cache = { key, entity, result };
    if (result.ok) {
      this.showNearestSuggestion(key, result.anchors, true);
    } else {
      this.clearSuggestionGhost();
    }
  }

  /** Repaint the suggestion at the cursor-nearest anchor. */
  private showNearestSuggestion(key: string, anchors: ConnectorAnchorCandidate[], force = false): void {
    if (anchors.length === 0) {
      this.clearSuggestionGhost();
      return;
    }
    const nearest = this.lastCursor ? this.nearestAnchorIndex(anchors, this.lastCursor) : 0;
    // Hovering the locked anchor itself: the strong preview already marks
    // it — a faint twin underneath would just be noise.
    if (this.locked && this.locked.key === key && this.locked.anchorIndex === nearest) {
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

  /** The anchor whose origin projects closest to the pointer. */
  private nearestAnchorIndex(anchors: ConnectorAnchorCandidate[], cursor: { x: number; y: number }): number {
    const camera = this.viewer.sceneContext.camera;
    const rect = this.viewer.sceneContext.renderer.domElement.getBoundingClientRect();
    let best = 0;
    let bestDist = Number.POSITIVE_INFINITY;
    const projected = new Vector3();
    anchors.forEach((anchor, index) => {
      projected.set(anchor.frame.origin.x, anchor.frame.origin.y, anchor.frame.origin.z).project(camera);
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

  /**
   * Viewport click while armed: lock the floated suggestion into the source
   * slot. A click that outruns the hover fetch (or a touch tap, which never
   * hovers) fetches on the spot and locks when the anchors land; a pick the
   * kernel refused surfaces its reason. Clicking with a lock already set
   * re-picks — the slot stays live like every armed pick slot.
   */
  handleClick(shapeId: string | null, sub: SubSelection): void {
    if (!this.armed || !shapeId || (sub.type !== 'face' && sub.type !== 'edge')) {
      return;
    }
    const key = `${shapeId}:${sub.type}:${sub.index}`;
    if (this.cache?.key === key) {
      const result = this.cache.result;
      // strictNullChecks is off — `'reason' in` narrows where `.ok` can't.
      if ('reason' in result) {
        this.panel.setMessage(result.reason ?? 'A connector cannot attach to that shape.');
      } else {
        this.lockSuggestion(this.cache.entity, result, this.lastCursor);
      }
      return;
    }
    // No cached anchors (click before hover settled) — fetch and lock.
    const entity: ApplyFeatureEntity = { shapeId, sub: { type: sub.type, index: sub.index } };
    this.hoverKey = key;
    void (async () => {
      const seq = ++this.hoverSeq;
      this.hoverAbort?.abort();
      const abort = new AbortController();
      this.hoverAbort = abort;
      let result: ConnectorAnchorsResult;
      try {
        result = await fetchConnectorAnchors(entity, abort.signal);
      } catch {
        return; // aborted
      }
      if (seq !== this.hoverSeq || !this.armed) {
        return;
      }
      this.cache = { key, entity, result };
      if ('reason' in result) {
        this.panel.setMessage(result.reason ?? 'A connector cannot attach to that shape.');
      } else {
        this.lockSuggestion(entity, result, this.lastCursor);
      }
    })();
  }

  private lockSuggestion(
    entity: ApplyFeatureEntity,
    result: Extract<ConnectorAnchorsResult, { ok: true }>,
    cursor: { x: number; y: number } | null,
  ): void {
    if (result.anchors.length === 0) {
      return;
    }
    const anchorIndex = cursor ? this.nearestAnchorIndex(result.anchors, cursor) : 0;
    this.locked = { entity, key: entityKey(entity), anchors: result.anchors, anchorIndex, args: result.args };
    const anchor = result.anchors[anchorIndex];
    // The faint suggestion graduates to the strong preview.
    this.clearSuggestionGhost();
    this.panel.setSourceChip(this.anchorChipLabel(entity, anchor));
    this.panel.suggestName(result.defaultName);
    this.panel.setMessage(null);
    this.updatePreviewGhost();
    this.runner.schedulePreview();
  }

  /** "Face center" / "Edge start" — the locked chip's human label. */
  private anchorChipLabel(entity: ApplyFeatureEntity, anchor: ConnectorAnchorCandidate): string {
    const shape = entity.sub.type === 'face' ? 'Face' : 'Edge';
    const kind = anchor.anchor.kind === 'offset'
      ? `offset ${anchor.anchor.value}`
      : anchor.anchor.kind;
    return `${shape} ${kind}`;
  }

  /** The locked gizmo under the dialog's current rotate/offset — no server. */
  private updatePreviewGhost(): void {
    if (!this.locked) {
      return;
    }
    const values = this.panel.values();
    const rotate = 'error' in values ? { axis: 'z' as const, angle: 0 } : values.rotate;
    const offset = 'error' in values ? [0, 0, 0] as [number, number, number] : values.offset;
    const frame = this.locked.anchors[this.locked.anchorIndex].frame;
    this.ghost.showPreview(adjustConnectorFrame(frame, rotate, offset));
  }

  private buildRequest(): ConnectorApplyOptions | { error: string } {
    if (!this.locked) {
      return { error: 'Click a suggested connector location in the viewport first.' };
    }
    const values = this.panel.values();
    if ('error' in values) {
      return values;
    }
    const anchor = this.locked.anchors[this.locked.anchorIndex].anchor;
    return {
      name: values.name,
      entities: [this.locked.entity],
      anchor,
      rotate: values.rotate.angle % 360 !== 0 ? values.rotate : undefined,
      offset: values.offset.some(v => v !== 0) ? values.offset : undefined,
    };
  }

  /** Drop the hover suggestion (fetches, cache, gizmo). */
  private clearSuggestion(): void {
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

  /** Faces and edges only — no axis/plane/sketch-wire channels. */
  private syncViewport(): void {
    if (!this.armed) {
      return;
    }
    this.viewer.pickSketchWires = false;
    this.viewer.pickAxes = false;
    this.viewer.pickPlanes = false;
    this.viewer.pickFilter = 'all';
  }

  private syncButton(): void {
    this.button.setActive(this.armed);
    this.hooks.onActiveChange?.();
  }
}
