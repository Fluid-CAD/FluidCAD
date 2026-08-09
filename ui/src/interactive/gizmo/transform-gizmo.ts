import { Camera, Mesh, Quaternion, Raycaster, Scene, Vector3 } from 'three';
import type { VariableInfo } from '../../ui/expression-core';
import { GizmoDragSession, GizmoDelta, GizmoHandleId } from './gizmo-session';
import { GIZMO_UNITS, GizmoHandleFactory, GizmoHandleOptions, GizmoHandleRecord, GizmoHandleSet } from './gizmo-geometry';
import { GizmoValueInput } from './gizmo-value-input';
import { applyConstantPixelSize } from '../../meshes/screen-scale';

/**
 * The slice of the viewport a gizmo needs — satisfied by SceneContext-backed
 * hosts in any scene (assembly today; part-scene translate()/curve tooling
 * later). Camera and raycaster are accessor-shaped because `switchCamera`
 * rebuilds them: never cache either.
 */
export type GizmoHost = {
  scene: Scene;
  /** Floating value input parent (#fluidcad-viewer). */
  overlayContainer: HTMLElement;
  /**
   * Capture-phase pointer listeners land here. An ancestor of the canvas —
   * its capture listeners run before every canvas-level listener (assembly
   * drag, camera-controls), which is what lets a handle hit claim the
   * gesture with stopImmediatePropagation before anyone else moves.
   */
  interactionRoot: HTMLElement;
  canvas: HTMLElement;
  getCamera(): Camera;
  createPickingRaycaster(ndcX: number, ndcY: number): Raycaster;
  requestRender(): void;
};

export type GizmoCallbacks = {
  /** The pointer crossed the drag threshold on a handle. */
  onDragStart(handle: GizmoHandleId): void;
  /** Live update — every pointermove past the threshold, or a typed preview. */
  onDragUpdate(delta: GizmoDelta): void;
  /** The gesture committed: pointer release, or Enter on the value input. */
  onCommit(delta: GizmoDelta, source: 'drag' | 'typed'): void;
  /** The gesture was cancelled after movement — revert to the start pose. */
  onCancel(): void;
};

export type GizmoOptions = {
  handles?: GizmoHandleOptions;
  /** On-screen size of the whole triad (default 96 px). */
  pixelSize?: number;
  /** Identifiers the value input may reference; default none. */
  variables?: () => VariableInfo[];
};

const INPUT_LABELS: Record<GizmoHandleId, string> = {
  tx: 'dX', ty: 'dY', tz: 'dZ',
  pxy: 'dXY', pyz: 'dYZ', pxz: 'dXZ',
  rx: 'Rx', ry: 'Ry', rz: 'Rz',
  center: 'dView',
};

/** Ring hits win over arrow hits within this many gizmo units of depth. */
const RING_TIE_BREAK_UNITS = 0.5;

/**
 * A host-agnostic OnShape-style transform triad. The core owns rendering,
 * hover, the pointer claim protocol, drag math and the floating value input;
 * it reports pose *deltas* relative to gesture start and never moves
 * anything itself — the host applies deltas, decides persistence, and calls
 * `setPosition` with wherever its target actually ended up.
 */
export class TransformGizmo {
  private readonly host: GizmoHost;
  private readonly callbacks: GizmoCallbacks;
  private readonly handleOptions: GizmoHandleOptions;
  private readonly pixelSize: number;
  private readonly variables: () => VariableInfo[];
  private readonly valueInput: GizmoValueInput;

  private built: GizmoHandleSet | null = null;
  private readonly orientation = new Quaternion();

  private session: GizmoDragSession | null = null;
  private sessionPointerId: number | null = null;
  private lastMoveX = Number.NaN;
  private lastMoveY = Number.NaN;

  private hovered: GizmoHandleRecord | null = null;
  private recentInteraction = false;
  private suppressNextPointerUp = false;

  constructor(host: GizmoHost, callbacks: GizmoCallbacks, options: GizmoOptions = {}) {
    this.host = host;
    this.callbacks = callbacks;
    this.handleOptions = options.handles ?? {};
    this.pixelSize = options.pixelSize ?? 96;
    this.variables = options.variables ?? (() => []);
    this.valueInput = new GizmoValueInput(host.overlayContainer);
    this.attachListeners();
  }

  // -------------------------------------------------------------------------
  // Public surface
  // -------------------------------------------------------------------------

  show(position: Vector3, orientation?: Quaternion): void {
    const set = this.ensureBuilt();
    this.endSession({ notifyCancel: this.isDragging() });
    this.orientation.copy(orientation ?? new Quaternion());
    set.root.quaternion.copy(this.orientation);
    set.root.position.copy(position);
    set.root.visible = true;
    this.host.requestRender();
  }

  hide(): void {
    if (!this.built || !this.built.root.visible) {
      this.endSession({ notifyCancel: this.isDragging() });
      return;
    }
    this.endSession({ notifyCancel: this.isDragging() });
    this.setHovered(null);
    this.built.root.visible = false;
    this.host.requestRender();
  }

  /** Re-anchor as the host's target moves (solver clamps, re-renders). */
  setPosition(position: Vector3): void {
    if (!this.built) {
      return;
    }
    this.built.root.position.copy(position);
    this.host.requestRender();
  }

  get isVisible(): boolean {
    return this.built?.root.visible === true;
  }

  /** True from threshold crossing until release/commit/cancel. */
  isDragging(): boolean {
    return this.session !== null && this.session.state === 'dragging';
  }

  /** Any gesture in flight — pending click, active drag, or typing mode. */
  get hasActiveGesture(): boolean {
    return this.session !== null;
  }

  /** Hover-suppression hook for the viewer (any handle under the pointer). */
  isPointerOverHandle(): boolean {
    return this.hovered !== null || this.session !== null;
  }

  /**
   * Self-clearing flag: the last gesture was a claimed gizmo interaction, so
   * the compat click that follows must not run selection. The viewer's
   * click-interceptor hook consumes this.
   */
  consumeRecentInteraction(): boolean {
    const was = this.recentInteraction;
    this.recentInteraction = false;
    return was;
  }

  cancelActiveDrag(): void {
    if (!this.session) {
      return;
    }
    this.endSession({ notifyCancel: this.isDragging() });
  }

  dispose(): void {
    this.detachListeners();
    this.endSession({ notifyCancel: false });
    this.valueInput.hide();
    if (this.built) {
      this.host.scene.remove(this.built.root);
      this.built.root.traverse((child) => {
        const mesh = child as Mesh;
        mesh.geometry?.dispose?.();
        const material = mesh.material as { dispose?: () => void } | undefined;
        material?.dispose?.();
      });
      this.built = null;
    }
  }

  // -------------------------------------------------------------------------
  // Construction
  // -------------------------------------------------------------------------

  private ensureBuilt(): GizmoHandleSet {
    if (this.built) {
      return this.built;
    }
    const set = GizmoHandleFactory.build(this.handleOptions);
    // The root's own position vector is handed to the screen-scale hook and
    // must stay identity-mapped for the closure to track it — setPosition
    // mutates it with copy(), never reassigns.
    applyConstantPixelSize(set.scaleHost, set.root, set.root.position, this.pixelSize, GIZMO_UNITS);
    set.root.visible = false;
    this.host.scene.add(set.root);
    this.built = set;
    return set;
  }

  // -------------------------------------------------------------------------
  // Pointer claim protocol
  // -------------------------------------------------------------------------

  private attachListeners(): void {
    const root = this.host.interactionRoot;
    root.addEventListener('pointerdown', this.handlePointerDown, true);
    root.addEventListener('pointermove', this.handlePointerMove, true);
    root.addEventListener('pointerup', this.handlePointerUp, true);
    root.addEventListener('pointercancel', this.handlePointerCancel, true);
    window.addEventListener('keydown', this.handleKeyDown);
  }

  private detachListeners(): void {
    const root = this.host.interactionRoot;
    root.removeEventListener('pointerdown', this.handlePointerDown, true);
    root.removeEventListener('pointermove', this.handlePointerMove, true);
    root.removeEventListener('pointerup', this.handlePointerUp, true);
    root.removeEventListener('pointercancel', this.handlePointerCancel, true);
    window.removeEventListener('keydown', this.handleKeyDown);
  }

  private handlePointerDown = (e: PointerEvent) => {
    this.recentInteraction = false;
    this.suppressNextPointerUp = false;
    if (e.button !== 0 || !this.isVisible) {
      return;
    }
    if (this.session) {
      // A canvas click while the typed-value field is armed abandons typing
      // (clicks inside the input never reach here — it stops their
      // propagation) and falls through so the same click can grab another
      // handle or proceed to selection.
      if (this.session.state === 'typing' && e.target === this.host.canvas) {
        this.endSession({ notifyCancel: false });
      } else {
        return;
      }
    }
    if (e.target !== this.host.canvas) {
      return;
    }
    const raycaster = this.raycasterFor(e);
    const record = this.pickHandle(raycaster);
    if (!record) {
      return;
    }

    const camera = this.host.getCamera();
    const viewDir = new Vector3();
    camera.getWorldDirection(viewDir);

    this.session = new GizmoDragSession({
      handle: record.id,
      origin: this.built!.root.position,
      orientation: this.orientation,
      startRay: raycaster.ray,
      viewDir,
      downX: e.clientX,
      downY: e.clientY,
    });
    this.sessionPointerId = e.pointerId;
    this.lastMoveX = Number.NaN;
    this.lastMoveY = Number.NaN;
    this.setHovered(record);
    this.host.canvas.setPointerCapture(e.pointerId);
    // Claim the gesture before the assembly drag and camera-controls see it.
    // No preventDefault — the compat mouse chain must survive for the
    // viewer's hover/click bookkeeping (same contract as the assembly drag).
    e.stopImmediatePropagation();
  };

  private handlePointerMove = (e: PointerEvent) => {
    if (!this.session) {
      this.updateHover(e);
      return;
    }
    if (this.session.state === 'typing') {
      return;
    }
    if (e.clientX === this.lastMoveX && e.clientY === this.lastMoveY) {
      e.stopImmediatePropagation();
      return;
    }
    this.lastMoveX = e.clientX;
    this.lastMoveY = e.clientY;

    const wasDragging = this.session.state === 'dragging';
    const delta = this.session.update(this.raycasterFor(e).ray, e.clientX, e.clientY, e.shiftKey);
    if (!wasDragging && this.session.state === 'dragging') {
      this.beginDragVisuals();
    }
    if (delta) {
      this.callbacks.onDragUpdate(delta);
      this.valueInput.updateLiveValue(this.session.readoutValue);
    }
    e.stopImmediatePropagation();
  };

  private handlePointerUp = (e: PointerEvent) => {
    if (!this.session) {
      if (this.suppressNextPointerUp) {
        this.suppressNextPointerUp = false;
        this.recentInteraction = true;
        e.stopImmediatePropagation();
      }
      return;
    }
    this.releaseCapture();
    const session = this.session;
    const outcome = session.release();
    this.recentInteraction = true;

    if (outcome.kind === 'commit') {
      this.callbacks.onCommit(outcome.delta, 'drag');
      this.endSession({ notifyCancel: false });
    } else if (outcome.kind === 'typing') {
      this.showValueInput(session, 0);
    } else {
      this.endSession({ notifyCancel: session.state === 'dragging' });
    }
    e.stopImmediatePropagation();
  };

  private handlePointerCancel = (e: PointerEvent) => {
    if (!this.session) {
      return;
    }
    this.releaseCapture();
    this.endSession({ notifyCancel: this.isDragging() });
    this.recentInteraction = true;
    e.stopImmediatePropagation();
  };

  private handleKeyDown = (e: KeyboardEvent) => {
    if (e.key !== 'Escape' || !this.session) {
      return;
    }
    // The value input's own Escape handler already hid it and let the event
    // propagate here; a drag past the threshold reverts, a typing-armed
    // click just ends.
    this.releaseCapture();
    this.endSession({ notifyCancel: this.isDragging() });
    this.recentInteraction = true;
  };

  // -------------------------------------------------------------------------
  // Session plumbing
  // -------------------------------------------------------------------------

  private beginDragVisuals(): void {
    const session = this.session!;
    this.applyDragDim(session.handle);
    this.host.canvas.style.cursor = 'grabbing';
    this.callbacks.onDragStart(session.handle);
    this.showValueInput(session, session.readoutValue);
  }

  private showValueInput(session: GizmoDragSession, initial: number): void {
    const projected = this.projectOriginToClient();
    this.valueInput.show({
      label: INPUT_LABELS[session.handle],
      unit: session.inputKind,
      clientX: projected.clientX,
      clientY: projected.clientY,
      variables: this.variables(),
      initial,
      onValue: (value) => this.commitTypedValue(value),
    });
  }

  private commitTypedValue(value: number): void {
    const session = this.session;
    if (!session) {
      return;
    }
    const delta = session.typedDelta(value);
    if (!delta) {
      return;
    }
    // A typed commit can land mid-drag (Enter while the button is still
    // down); the trailing pointerup then belongs to this gesture and must
    // not read as a fresh click.
    if (session.state === 'dragging') {
      this.suppressNextPointerUp = true;
      this.releaseCapture();
    }
    this.callbacks.onCommit(delta, 'typed');
    this.endSession({ notifyCancel: false });
  }

  private endSession(opts: { notifyCancel: boolean }): void {
    if (opts.notifyCancel) {
      this.callbacks.onCancel();
    }
    this.session = null;
    this.sessionPointerId = null;
    this.valueInput.hide();
    this.clearDragDim();
    this.host.canvas.style.cursor = '';
    this.setHovered(null);
    this.host.requestRender();
  }

  private releaseCapture(): void {
    if (this.sessionPointerId === null) {
      return;
    }
    try {
      this.host.canvas.releasePointerCapture(this.sessionPointerId);
    } catch {
      // capture may already be gone
    }
    this.sessionPointerId = null;
  }

  // -------------------------------------------------------------------------
  // Picking + hover
  // -------------------------------------------------------------------------

  private raycasterFor(e: PointerEvent): Raycaster {
    const rect = this.host.canvas.getBoundingClientRect();
    const ndcX = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    const ndcY = -(((e.clientY - rect.top) / rect.height) * 2 - 1);
    return this.host.createPickingRaycaster(ndcX, ndcY);
  }

  private pickHandle(raycaster: Raycaster): GizmoHandleRecord | null {
    const set = this.built;
    if (!set || !set.root.visible) {
      return null;
    }
    const hits = raycaster.intersectObjects(set.hitMeshes, false);
    if (hits.length === 0) {
      return null;
    }
    // Rings are thin targets that share space with arrow tips: within a
    // small depth window of the nearest hit, prefer the ring.
    const window = set.root.scale.x * RING_TIE_BREAK_UNITS;
    let chosen = hits[0];
    for (const hit of hits) {
      if (hit.distance > hits[0].distance + window) {
        break;
      }
      const id = hit.object.userData.gizmoHandle as GizmoHandleId;
      if (id === 'rx' || id === 'ry' || id === 'rz') {
        chosen = hit;
        break;
      }
    }
    const handleId = chosen.object.userData.gizmoHandle as GizmoHandleId;
    return set.handles.find((h) => h.id === handleId) ?? null;
  }

  private updateHover(e: PointerEvent): void {
    if (!this.isVisible) {
      return;
    }
    // Only hover with no buttons down — a foreign drag (part free-drag,
    // camera orbit) sweeping under the gizmo must not grab the cursor.
    if (e.buttons !== 0 || e.target !== this.host.canvas) {
      this.setHovered(null);
      return;
    }
    this.setHovered(this.pickHandle(this.raycasterFor(e)));
  }

  private setHovered(record: GizmoHandleRecord | null): void {
    if (this.hovered === record) {
      return;
    }
    if (this.hovered && !this.session) {
      this.restoreHandle(this.hovered);
    }
    this.hovered = record;
    if (record && !this.session) {
      for (const material of record.materials) {
        material.color.set(0xffffff);
      }
      this.host.canvas.style.cursor = 'grab';
      this.host.requestRender();
    } else if (!record && !this.session) {
      this.host.canvas.style.cursor = '';
      this.host.requestRender();
    }
  }

  private applyDragDim(active: GizmoHandleId): void {
    if (!this.built) {
      return;
    }
    for (const handle of this.built.handles) {
      if (handle.id === active) {
        for (const material of handle.materials) {
          material.color.set(0xffffff);
          material.opacity = handle.baseOpacity;
        }
      } else {
        for (const material of handle.materials) {
          material.color.set(handle.baseColor);
          material.opacity = 0.25;
        }
      }
    }
    this.host.requestRender();
  }

  private clearDragDim(): void {
    if (!this.built) {
      return;
    }
    for (const handle of this.built.handles) {
      this.restoreHandle(handle);
    }
  }

  private restoreHandle(record: GizmoHandleRecord): void {
    for (const material of record.materials) {
      material.color.set(record.baseColor);
      material.opacity = record.baseOpacity;
    }
    this.host.requestRender();
  }

  private projectOriginToClient(): { clientX: number; clientY: number } {
    const position = this.built ? this.built.root.position : new Vector3();
    const projected = position.clone().project(this.host.getCamera());
    const rect = this.host.canvas.getBoundingClientRect();
    return {
      clientX: ((projected.x + 1) / 2) * rect.width + rect.left,
      clientY: ((1 - projected.y) / 2) * rect.height + rect.top,
    };
  }
}
