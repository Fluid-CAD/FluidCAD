import { Euler, MathUtils, Quaternion, Vector3 } from 'three';
import type { Viewer } from '../../viewer';
import type { SerializedAssemblyInstance } from '../../types';
import type { AssemblyController } from '../../scene/assembly-controller';
import { isEditableTarget } from '../../keyboard-bridge';
import { TransformGizmo } from './transform-gizmo';
import type { GizmoDelta, GizmoHandleId } from './gizmo-session';

export type AssemblyGizmoBindings = {
  viewer: Viewer;
  /** The full-size overlay container (#fluidcad-viewer). */
  container: HTMLElement;
  findInstance(instanceId: string): SerializedAssemblyInstance | undefined;
  instanceHasMate(instanceId: string): boolean;
  applyInstancePose(
    sourceLocation: { filePath: string; line: number },
    position: [number, number, number],
    rotateXYZ: [number, number, number] | null,
  ): Promise<{ success: boolean; reason?: string }>;
  flashError(message: string): void;
};

type Pose = { position: Vector3; quaternion: Quaternion };

/**
 * The assembly host for {@link TransformGizmo}: a single click on a
 * non-locked inserted part attaches the triad at the part's origin
 * (world-aligned axes); drags route through the assembly controller's
 * external-drag API so the solver stays in the loop exactly as it is for
 * free drags; commits rewrite the `insert()` chain via `applyInstancePose`.
 *
 * Persistence mirrors the free-drag rule: mate-constrained ungrounded
 * instances move live but never write back; locked instances (grounded or
 * fastened-chain to ground) never show the gizmo at all. Free drag itself
 * is untouched — the gizmo is an additive precision layer.
 */
export class AssemblyGizmoDriver {
  private readonly bindings: AssemblyGizmoBindings;
  private readonly gizmo: TransformGizmo;

  private attachedId: string | null = null;
  /** Pose at gesture start — the revert target while a gesture or its
   *  commit round-trip is in flight. */
  private gestureStart: Pose | null = null;
  /**
   * A commit awaiting the server's verdict. The controller's external-drag
   * claim is held until it settles, so the update()-skip guard keeps the
   * committed pose steady and a refusal can still revert cleanly.
   */
  private pendingCommit: { instanceId: string; start: Pose } | null = null;

  constructor(bindings: AssemblyGizmoBindings) {
    this.bindings = bindings;

    // Dismiss-on-Escape must observe the gizmo's session *before* the
    // gizmo's own Escape handler clears it (first Escape cancels the drag,
    // the second dismisses the triad) — so this listener registers first.
    window.addEventListener('keydown', this.handleKeyDown);

    const ctx = bindings.viewer.sceneContext;
    this.gizmo = new TransformGizmo(
      {
        scene: ctx.scene,
        overlayContainer: bindings.container,
        interactionRoot: bindings.container,
        canvas: ctx.renderer.domElement,
        getCamera: () => ctx.camera,
        createPickingRaycaster: (ndcX, ndcY) => ctx.createPickingRaycaster(ndcX, ndcY),
        requestRender: () => ctx.requestRender(),
      },
      {
        onDragStart: (handle) => this.handleDragStart(handle),
        onDragUpdate: (delta) => this.handleDragUpdate(delta),
        onCommit: (delta) => this.handleCommit(delta),
        onCancel: () => this.handleCancel(),
      },
    );

    bindings.viewer.setClickInterceptor(() => this.gizmo.consumeRecentInteraction());
    bindings.viewer.setHoverSuppressor(() => this.gizmo.isPointerOverHandle());
  }

  get isAttached(): boolean {
    return this.attachedId !== null;
  }

  // -------------------------------------------------------------------------
  // Attach lifecycle (main.ts wiring)
  // -------------------------------------------------------------------------

  /** Viewport selection landed on an instance (or empty space = null). */
  handleSelection(instanceId: string | null): void {
    if (instanceId === null) {
      this.detach();
      return;
    }
    if (this.gizmo.hasActiveGesture) {
      return;
    }
    const controller = this.controller();
    if (!controller || controller.isInstanceLocked(instanceId)) {
      this.detach();
      return;
    }
    const pose = controller.getInstancePose(instanceId);
    if (!pose) {
      this.detach();
      return;
    }
    this.attachedId = instanceId;
    this.gizmo.show(pose.position);
  }

  /** Groups are rebuilt nearly every render — re-anchor or dismiss. */
  handleSceneRendered(): void {
    if (!this.attachedId) {
      return;
    }
    const controller = this.controller();
    const pose = controller?.getInstancePose(this.attachedId);
    if (!controller || !pose || controller.isInstanceLocked(this.attachedId)) {
      this.detach();
      return;
    }
    this.gizmo.setPosition(pose.position);
  }

  /** The scene flipped to part mode. */
  handleModeExit(): void {
    this.detach();
  }

  private detach(): void {
    this.gizmo.cancelActiveDrag();
    this.gizmo.hide();
    this.attachedId = null;
  }

  private controller(): AssemblyController | null {
    return this.bindings.viewer.getAssemblyController();
  }

  // -------------------------------------------------------------------------
  // Gesture routing
  // -------------------------------------------------------------------------

  private handleDragStart(_handle: GizmoHandleId): void {
    const controller = this.controller();
    if (!this.attachedId || !controller || !controller.beginExternalDrag(this.attachedId)) {
      this.gizmo.cancelActiveDrag();
      return;
    }
    const pose = controller.getInstancePose(this.attachedId);
    if (!pose) {
      controller.endExternalDrag();
      this.gizmo.cancelActiveDrag();
      return;
    }
    this.gestureStart = pose;
    // The face highlight from the attaching click would visually stick to
    // the moving part.
    this.bindings.viewer.clearHighlight();
    this.bindings.viewer.clearHover();
  }

  /** Absolute target pose for a delta, measured from the gesture start. */
  private applyDelta(controller: AssemblyController, delta: GizmoDelta): boolean {
    const start = this.gestureStart;
    if (!start) {
      return false;
    }
    if (delta.kind === 'translate') {
      const target = start.position.clone().add(delta.delta);
      return controller.updateExternalDragTranslate(target) !== null;
    }
    const rotation = new Quaternion().setFromAxisAngle(
      delta.axis, MathUtils.degToRad(delta.degrees),
    );
    // Pre-multiply: a world-axis rotation about the gizmo origin (= the body
    // origin) leaves position untouched and spins the part in place.
    return controller.updateExternalDragRotate(rotation.multiply(start.quaternion.clone())) !== null;
  }

  private handleDragUpdate(delta: GizmoDelta): void {
    const controller = this.controller();
    if (!controller || !this.attachedId) {
      return;
    }
    if (!this.applyDelta(controller, delta)) {
      // The instance vanished mid-drag (render diff pruned it).
      this.gizmo.cancelActiveDrag();
      return;
    }
    const pose = controller.getInstancePose(this.attachedId);
    if (pose) {
      this.gizmo.setPosition(pose.position);
    }
  }

  private handleCommit(delta: GizmoDelta): void {
    const controller = this.controller();
    const instanceId = this.attachedId;
    if (!controller || !instanceId) {
      this.gestureStart = null;
      return;
    }
    // A typing-mode commit arrives without a preceding drag — claim now.
    if (!this.gestureStart) {
      if (!controller.beginExternalDrag(instanceId)) {
        return;
      }
      const pose = controller.getInstancePose(instanceId);
      if (!pose) {
        controller.endExternalDrag();
        return;
      }
      this.gestureStart = pose;
    }
    if (!this.applyDelta(controller, delta)) {
      controller.cancelExternalDrag(this.gestureStart);
      this.gestureStart = null;
      return;
    }

    const start = this.gestureStart;
    this.gestureStart = null;
    const finalPose = controller.getInstancePose(instanceId);
    const inst = this.bindings.findInstance(instanceId);
    const persistable = finalPose !== null
      && inst?.sourceLocation !== undefined
      && (inst.grounded || !this.bindings.instanceHasMate(instanceId));

    if (!persistable) {
      // Live-only move (mated ungrounded, or no source location) — exactly
      // the free-drag rule; the solver warm-start re-derives it next render.
      controller.endExternalDrag();
      this.reanchor();
      return;
    }

    // Hold the external-drag claim until the server settles: the
    // update()-skip guard keeps the committed pose steady across the
    // resulting render, and a refusal can still revert through the claim.
    this.pendingCommit = { instanceId, start };
    const rotateXYZ = delta.kind === 'rotate'
      ? AssemblyGizmoDriver.eulerZYXDegrees(finalPose.quaternion)
      : null;
    void this.bindings
      .applyInstancePose(
        inst.sourceLocation!,
        [finalPose.position.x, finalPose.position.y, finalPose.position.z],
        rotateXYZ,
      )
      .then((result) => this.settleCommit(result));
  }

  private settleCommit(result: { success: boolean; reason?: string }): void {
    const pending = this.pendingCommit;
    this.pendingCommit = null;
    if (!pending) {
      return;
    }
    const controller = this.controller();
    if (result.success) {
      controller?.endExternalDrag();
    } else {
      controller?.cancelExternalDrag(pending.start);
      this.bindings.flashError(result.reason ?? "couldn't write the new pose");
    }
    this.reanchor();
  }

  private handleCancel(): void {
    const controller = this.controller();
    if (controller && this.gestureStart) {
      controller.cancelExternalDrag(this.gestureStart);
    }
    this.gestureStart = null;
    this.reanchor();
  }

  private reanchor(): void {
    if (!this.attachedId) {
      return;
    }
    const pose = this.controller()?.getInstancePose(this.attachedId);
    if (pose) {
      this.gizmo.setPosition(pose.position);
    }
  }

  private handleKeyDown = (e: KeyboardEvent) => {
    if (e.key !== 'Escape' || !this.gizmo.isVisible) {
      return;
    }
    // An active gesture's Escape belongs to the gizmo (cancel the drag);
    // this listener registered first, so the session is still observable
    // here. Escapes typed into foreign inputs stay theirs.
    if (this.gizmo.hasActiveGesture || isEditableTarget(e.target)) {
      return;
    }
    this.detach();
  };

  /** Chain form `.rotate('x',x).rotate('y',y).rotate('z',z)` ⇔ three 'ZYX'. */
  private static eulerZYXDegrees(q: Quaternion): [number, number, number] {
    const e = new Euler().setFromQuaternion(q, 'ZYX');
    return [MathUtils.radToDeg(e.x), MathUtils.radToDeg(e.y), MathUtils.radToDeg(e.z)];
  }
}
