import { Quaternion, Ray, Vector3 } from 'three';
import { sceneUnit } from '../../units/scene-unit';
import type { GizmoValueUnit } from './gizmo-value-input';
import { GizmoMath } from './gizmo-math';

export type GizmoHandleId =
  | 'tx' | 'ty' | 'tz'
  | 'pxy' | 'pyz' | 'pxz'
  | 'rx' | 'ry' | 'rz'
  | 'center';

/**
 * A gizmo gesture's output, always relative to the gesture-start pose: a
 * world-space translation vector, or a world axis + signed accumulated
 * degrees about the gizmo origin. The host applies it — the gizmo never
 * moves anything itself.
 */
export type GizmoDelta =
  | { kind: 'translate'; handle: GizmoHandleId; delta: Vector3 }
  | { kind: 'rotate'; handle: GizmoHandleId; axis: Vector3; degrees: number };

export type GizmoSessionState = 'pending' | 'dragging' | 'typing';

export type GizmoSessionRelease =
  | { kind: 'commit'; delta: GizmoDelta }
  | { kind: 'typing' }
  | { kind: 'cancel' };

/** Same movement threshold the assembly free-drag uses. */
const DRAG_THRESHOLD_PX = 4;

const AXIS_HANDLES: Record<string, 0 | 1 | 2> = { tx: 0, ty: 1, tz: 2 };
const RING_HANDLES: Record<string, 0 | 1 | 2> = { rx: 0, ry: 1, rz: 2 };
/** Plane handle → its normal's frame-axis index. */
const PLANE_HANDLES: Record<string, 0 | 1 | 2> = { pxy: 2, pyz: 0, pxz: 1 };

export type GizmoSessionOptions = {
  handle: GizmoHandleId;
  /** Gesture-start gizmo origin (world). Cloned; the live origin may move. */
  origin: Vector3;
  /** Gizmo frame orientation; identity = world-aligned axes. */
  orientation: Quaternion;
  /** The pointerdown pick ray — every delta is measured against it. */
  startRay: Ray;
  /** Camera world direction at gesture start (the 'center' drag plane). */
  viewDir: Vector3;
  downX: number;
  downY: number;
};

/**
 * One gizmo gesture: pending until the pointer crosses the drag threshold,
 * then dragging; a release without movement arms typing mode on handles
 * with a single-value axis. Pure over pre-built rays — no DOM, no camera —
 * so the whole state machine is unit-testable in node.
 *
 * All reference geometry (origin, axes, start ray) is captured at
 * construction: deltas never re-derive from the live gizmo origin, which
 * moves with the part and would compound drift frame-over-frame.
 */
export class GizmoDragSession {
  private readonly handleId: GizmoHandleId;
  private readonly origin: Vector3;
  private readonly downX: number;
  private readonly downY: number;

  /** Frame axes (world when the orientation is identity). */
  private readonly axes: [Vector3, Vector3, Vector3];

  private stateValue: GizmoSessionState = 'pending';
  private lastDeltaValue: GizmoDelta | null = null;

  /** Axis drag reference param; null when the start ray was degenerate. */
  private axisT0: number | null = null;
  private axisDir: Vector3 | null = null;

  /** Plane drag reference point; null when the start ray was degenerate. */
  private planePoint0: Vector3 | null = null;
  private planeNormal: Vector3 | null = null;
  private planeU: Vector3 | null = null;
  private planeV: Vector3 | null = null;

  /** Ring drag angle state (raw seam-unwrap accumulation). */
  private ringAxis: Vector3 | null = null;
  private ringU: Vector3 | null = null;
  private ringV: Vector3 | null = null;
  private ringRaw: number | null = null;
  private ringAccum = 0;

  constructor(opts: GizmoSessionOptions) {
    this.handleId = opts.handle;
    this.origin = opts.origin.clone();
    this.downX = opts.downX;
    this.downY = opts.downY;
    this.axes = [
      new Vector3(1, 0, 0).applyQuaternion(opts.orientation),
      new Vector3(0, 1, 0).applyQuaternion(opts.orientation),
      new Vector3(0, 0, 1).applyQuaternion(opts.orientation),
    ];
    this.captureReferences(opts.startRay, opts.viewDir);
  }

  private captureReferences(startRay: Ray, viewDir: Vector3): void {
    const handle = this.handleId;
    if (handle in AXIS_HANDLES) {
      this.axisDir = this.axes[AXIS_HANDLES[handle]];
      this.axisT0 = GizmoMath.closestAxisParam(startRay, this.origin, this.axisDir);
      return;
    }
    if (handle in PLANE_HANDLES) {
      const normalIndex = PLANE_HANDLES[handle];
      this.planeNormal = this.axes[normalIndex];
      this.planeU = this.axes[(normalIndex + 1) % 3];
      this.planeV = this.axes[(normalIndex + 2) % 3];
      this.planePoint0 = GizmoMath.intersectPlane(startRay, this.origin, this.planeNormal);
      return;
    }
    if (handle === 'center') {
      this.planeNormal = viewDir.clone().normalize();
      this.planePoint0 = GizmoMath.intersectPlane(startRay, this.origin, this.planeNormal);
      return;
    }
    if (handle in RING_HANDLES) {
      const axisIndex = RING_HANDLES[handle];
      this.ringAxis = this.axes[axisIndex];
      // Right-handed (u, v, axis) so positive degrees follow the right-hand
      // rule about the axis: rx→(y,z), ry→(z,x), rz→(x,y).
      this.ringU = this.axes[(axisIndex + 1) % 3];
      this.ringV = this.axes[(axisIndex + 2) % 3];
      this.ringRaw = GizmoMath.rotationAngleDeg(
        startRay, this.origin, this.ringAxis, this.ringU, this.ringV,
      );
    }
  }

  get state(): GizmoSessionState {
    return this.stateValue;
  }

  get handle(): GizmoHandleId {
    return this.handleId;
  }

  get lastDelta(): GizmoDelta | null {
    return this.lastDeltaValue;
  }

  /** The floating input's unit for this handle: degrees on a ring, the
   *  document unit on an arrow (the typed value is written back verbatim). */
  get inputKind(): GizmoValueUnit {
    return this.handleId in RING_HANDLES ? 'deg' : sceneUnit.current;
  }

  /**
   * Whether a click (release without movement) arms typing mode: only
   * handles with an unambiguous direction — arrows and rings. A typed value
   * on a plane handle scales the current drag direction, so it needs an
   * active drag to mean anything.
   */
  get canArmTypingOnClick(): boolean {
    return this.handleId in AXIS_HANDLES || this.handleId in RING_HANDLES;
  }

  /** The signed value the floating input mirrors while dragging. */
  get readoutValue(): number {
    const delta = this.lastDeltaValue;
    if (!delta) {
      return 0;
    }
    if (delta.kind === 'rotate') {
      return delta.degrees;
    }
    if (this.axisDir) {
      return delta.delta.dot(this.axisDir);
    }
    return delta.delta.length();
  }

  /**
   * Advance the gesture with a fresh pick ray. Returns the current delta —
   * null while pending (below the drag threshold) — holding the last delta
   * on degenerate rays so the part never jumps.
   */
  update(ray: Ray, clientX: number, clientY: number, snap: boolean): GizmoDelta | null {
    if (this.stateValue === 'pending') {
      const dx = clientX - this.downX;
      const dy = clientY - this.downY;
      if (Math.hypot(dx, dy) < DRAG_THRESHOLD_PX) {
        return null;
      }
      this.stateValue = 'dragging';
    }
    if (this.stateValue !== 'dragging') {
      return null;
    }

    if (this.axisDir) {
      if (this.axisT0 === null) {
        // Degenerate start (camera looked down the axis): try to establish
        // the reference from the first resolvable ray so the drag can begin.
        this.axisT0 = GizmoMath.closestAxisParam(ray, this.origin, this.axisDir);
        return this.lastDeltaValue;
      }
      const t = GizmoMath.closestAxisParam(ray, this.origin, this.axisDir);
      if (t === null) {
        return this.lastDeltaValue;
      }
      const mm = GizmoMath.snapTranslate(t - this.axisT0, snap);
      this.lastDeltaValue = {
        kind: 'translate',
        handle: this.handleId,
        delta: this.axisDir.clone().multiplyScalar(mm),
      };
      return this.lastDeltaValue;
    }

    if (this.planeNormal) {
      if (this.planePoint0 === null) {
        this.planePoint0 = GizmoMath.intersectPlane(ray, this.origin, this.planeNormal);
        return this.lastDeltaValue;
      }
      const point = GizmoMath.intersectPlane(ray, this.origin, this.planeNormal);
      if (!point) {
        return this.lastDeltaValue;
      }
      const delta = point.sub(this.planePoint0);
      if (snap && this.planeU && this.planeV) {
        const du = GizmoMath.snapTranslate(delta.dot(this.planeU), true);
        const dv = GizmoMath.snapTranslate(delta.dot(this.planeV), true);
        delta.copy(this.planeU.clone().multiplyScalar(du).addScaledVector(this.planeV, dv));
      }
      this.lastDeltaValue = { kind: 'translate', handle: this.handleId, delta };
      return this.lastDeltaValue;
    }

    if (this.ringAxis && this.ringU && this.ringV) {
      const raw = GizmoMath.rotationAngleDeg(ray, this.origin, this.ringAxis, this.ringU, this.ringV);
      if (raw === null) {
        return this.lastDeltaValue;
      }
      if (this.ringRaw === null) {
        this.ringRaw = raw;
        return this.lastDeltaValue;
      }
      const unwrapped = GizmoMath.unwrapDeg(this.ringRaw, raw, this.ringAccum);
      this.ringRaw = unwrapped.raw;
      this.ringAccum = unwrapped.accum;
      this.lastDeltaValue = {
        kind: 'rotate',
        handle: this.handleId,
        axis: this.ringAxis.clone(),
        degrees: GizmoMath.snapRotate(this.ringAccum, snap),
      };
      return this.lastDeltaValue;
    }

    return null;
  }

  /** Pointer released: commit a drag, arm typing on a plain click, or cancel. */
  release(): GizmoSessionRelease {
    if (this.stateValue === 'dragging') {
      if (this.lastDeltaValue) {
        return { kind: 'commit', delta: this.lastDeltaValue };
      }
      return { kind: 'cancel' };
    }
    if (this.stateValue === 'pending' && this.canArmTypingOnClick) {
      this.stateValue = 'typing';
      return { kind: 'typing' };
    }
    return { kind: 'cancel' };
  }

  /**
   * A typed exact value: mm along the arrow axis, degrees about the ring
   * axis, or — mid-drag on a plane/center handle — the current drag
   * direction rescaled to that length.
   */
  typedDelta(value: number): GizmoDelta | null {
    if (this.axisDir) {
      return {
        kind: 'translate',
        handle: this.handleId,
        delta: this.axisDir.clone().multiplyScalar(value),
      };
    }
    if (this.ringAxis) {
      return { kind: 'rotate', handle: this.handleId, axis: this.ringAxis.clone(), degrees: value };
    }
    const last = this.lastDeltaValue;
    if (last && last.kind === 'translate' && last.delta.lengthSq() > 1e-12) {
      return {
        kind: 'translate',
        handle: this.handleId,
        delta: last.delta.clone().normalize().multiplyScalar(value),
      };
    }
    return null;
  }
}
