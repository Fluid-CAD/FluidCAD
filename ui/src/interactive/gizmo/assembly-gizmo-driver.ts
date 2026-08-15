import { Euler, MathUtils, Quaternion, Vector3 } from 'three';
import type { Viewer } from '../../viewer';
import type { SerializedAssemblyInstance } from '../../types';
import type { AssemblyController } from '../../scene/assembly-controller';
import { resolveExpressionValue, type VariableInfo } from '../../ui/expression-core';
import { isEditableTarget } from '../../keyboard-bridge';
import { TransformGizmo } from './transform-gizmo';
import type { GizmoRingHandleId, GizmoTypableHandleId, GizmoAxisTypingContext } from './transform-gizmo';
import type { GizmoExpressionCommit } from './gizmo-value-input';
import type { GizmoDelta, GizmoHandleId } from './gizmo-session';

/** Per-axis transform-call argument source text; null falls back to numeric. */
type AxisExprs = [string | null, string | null, string | null];

type PoseExpressions = {
  translate: { x: string | null; y: string | null; z: string | null } | null;
  rotate: { x: string | null; y: string | null; z: string | null } | null;
};

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
    options?: {
      translateExprs?: AxisExprs;
      rotateExprs?: AxisExprs;
      newVariables?: { name: string; initializer: string }[];
    },
  ): Promise<{ success: boolean; reason?: string }>;
  /** The instance's exact `.translate()` arg and `.rotate()` angle texts;
   *  null blocks when not readable. */
  getPoseExpressions(
    sourceLocation: { filePath: string; line: number },
  ): Promise<PoseExpressions | null>;
  /** Variables in scope at the insert chain's line, for the value input. */
  fetchScopeVariables(sourceLine: number): Promise<VariableInfo[]>;
  flashError(message: string): void;
};

type Pose = { position: Vector3; quaternion: Quaternion };

const AXIS_INDEX: Record<GizmoTypableHandleId, 0 | 1 | 2> = {
  tx: 0, ty: 1, tz: 2,
  rx: 0, ry: 1, rz: 2,
};

function isRingHandle(handle: GizmoTypableHandleId): handle is GizmoRingHandleId {
  return handle === 'rx' || handle === 'ry' || handle === 'rz';
}

/**
 * Which position components a handle's gesture can change. Untouched axes
 * echo their existing source text through a commit, so `.translate(w, h, 5)`
 * keeps `w` and `h` across a Z-arrow drag. Ring rotations spin about the
 * body origin and never move it, so every axis survives them.
 */
const TOUCHED_AXES: Record<GizmoHandleId, [boolean, boolean, boolean]> = {
  tx: [true, false, false], ty: [false, true, false], tz: [false, false, true],
  pxy: [true, true, false], pyz: [false, true, true], pxz: [true, false, true],
  center: [true, true, true],
  rx: [false, false, false], ry: [false, false, false], rz: [false, false, false],
};

/**
 * Which ZYX euler components a ring DRAG can change: pre-multiplying a world
 * Z rotation onto Q = Rz·Ry·Rx only advances the z component, so a z-ring
 * drag preserves the x/y angle texts; world X/Y rotations don't commute past
 * Rz·Ry, so those drags generally change all three components and preserve
 * nothing. (A typed ring commit is different — it sets exactly its own
 * component and echoes the other two.)
 */
const DRAG_TOUCHED_ROTATE_AXES: Partial<Record<GizmoHandleId, [boolean, boolean, boolean]>> = {
  rx: [true, true, true], ry: [true, true, true], rz: [false, false, true],
};

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

  /** In-scope variables for the value input, refreshed per attach/commit. */
  private cachedVariables: VariableInfo[] = [];
  /** Latest transform arg-text read, tagged with its instance. */
  private poseExprs: PoseExpressions | null = null;
  private exprsInstanceId: string | null = null;

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
        getAxisTypingContext: (handle) => this.handleAxisTypingContext(handle),
        onCommitAxisExpression: (handle, commit) => this.handleAxisExpressionCommit(handle, commit),
      },
      { variables: () => this.cachedVariables },
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
    this.refreshVariables();
    void this.refreshPoseExprs();
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
    this.poseExprs = null;
    this.exprsInstanceId = null;
  }

  private controller(): AssemblyController | null {
    return this.bindings.viewer.getAssemblyController();
  }

  /** The instance when a commit would write source; undefined for live-only
   *  moves (no source location, mate-constrained ungrounded, or owned by a
   *  sub-assembly occurrence). */
  private persistableInstance(instanceId: string): SerializedAssemblyInstance | undefined {
    const inst = this.bindings.findInstance(instanceId);
    if (!inst?.sourceLocation) {
      return undefined;
    }
    // Occurrence-owned: the sourceLocation points into the SUB-ASSEMBLY's
    // file, and the pose there is local to the occurrence frame — writing
    // this view's world pose would corrupt every occurrence of it.
    if (inst.owner) {
      return undefined;
    }
    if (!inst.grounded && this.bindings.instanceHasMate(instanceId)) {
      return undefined;
    }
    return inst;
  }

  // -------------------------------------------------------------------------
  // Value-input source data (variables + translate arg texts)
  // -------------------------------------------------------------------------

  private refreshVariables(): void {
    const instanceId = this.attachedId;
    const inst = instanceId !== null ? this.bindings.findInstance(instanceId) : undefined;
    if (instanceId === null || !inst?.sourceLocation) {
      return;
    }
    void this.bindings.fetchScopeVariables(inst.sourceLocation.line).then((variables) => {
      if (this.attachedId === instanceId) {
        this.cachedVariables = variables;
      }
    });
  }

  /** Re-read the attached instance's transform arg texts into the echo
   *  cache; resolves with them (null when unreadable or detached since). */
  private refreshPoseExprs(): Promise<PoseExpressions | null> {
    const instanceId = this.attachedId;
    const inst = instanceId !== null ? this.bindings.findInstance(instanceId) : undefined;
    if (instanceId === null || !inst?.sourceLocation) {
      return Promise.resolve(null);
    }
    return this.bindings.getPoseExpressions(inst.sourceLocation).then((result) => {
      if (this.attachedId !== instanceId) {
        return null;
      }
      this.poseExprs = result;
      this.exprsInstanceId = instanceId;
      return this.poseExprs;
    });
  }

  /** The echo cache, when it belongs to the attached instance. */
  private cachedExprs(): PoseExpressions | null {
    return this.attachedId !== null && this.attachedId === this.exprsInstanceId
      ? this.poseExprs
      : null;
  }

  /** Cached per-axis texts with the touched components nulled; undefined
   *  when nothing survives — the wire then matches the text-less shape. */
  private static maskTouched(
    cached: { x: string | null; y: string | null; z: string | null } | null | undefined,
    touched: [boolean, boolean, boolean] | undefined,
  ): AxisExprs | undefined {
    if (!cached || !touched) {
      return undefined;
    }
    const exprs: AxisExprs = [
      touched[0] ? null : cached.x,
      touched[1] ? null : cached.y,
      touched[2] ? null : cached.z,
    ];
    return exprs.some(e => e !== null) ? exprs : undefined;
  }

  /** A commit's `.translate()` echoes: source text for every position axis
   *  the handle's gesture can't have changed. */
  private echoTranslateExprs(handle: GizmoHandleId): AxisExprs | undefined {
    return AssemblyGizmoDriver.maskTouched(this.cachedExprs()?.translate, TOUCHED_AXES[handle]);
  }

  /** A ring drag's `.rotate()` angle echoes (see DRAG_TOUCHED_ROTATE_AXES). */
  private echoRotateExprsForDrag(handle: GizmoHandleId): AxisExprs | undefined {
    return AssemblyGizmoDriver.maskTouched(this.cachedExprs()?.rotate, DRAG_TOUCHED_ROTATE_AXES[handle]);
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
    // Freshen the echo cache while the drag runs, so the commit preserves
    // the untouched axes' source text as it is right now.
    void this.refreshPoseExprs();
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
    const inst = this.persistableInstance(instanceId);

    if (finalPose === null || inst === undefined) {
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
        {
          translateExprs: this.echoTranslateExprs(delta.handle),
          rotateExprs: rotateXYZ !== null ? this.echoRotateExprsForDrag(delta.handle) : undefined,
        },
      )
      .then((result) => this.settleCommit(result));
  }

  /**
   * A clicked translate arrow's or rotate ring's input opens on the axis'
   * current absolute value — a position coordinate, or a ZYX euler angle in
   * degrees — seeded with its exact source expression when the commit could
   * write it back (source text on a live-only instance would promise an
   * edit that never happens).
   */
  private handleAxisTypingContext(handle: GizmoTypableHandleId): GizmoAxisTypingContext | null {
    const controller = this.controller();
    const instanceId = this.attachedId;
    if (!controller || !instanceId) {
      return null;
    }
    const pose = controller.getInstancePose(instanceId);
    if (!pose) {
      return null;
    }
    this.refreshVariables();
    const ring = isRingHandle(handle);
    const axis = AXIS_INDEX[handle];
    const persistable = this.persistableInstance(instanceId) !== undefined;
    return {
      value: ring
        ? AssemblyGizmoDriver.eulerZYXDegrees(pose.quaternion)[axis]
        : pose.position.getComponent(axis),
      sourceExpression: persistable
        ? this.refreshPoseExprs().then((exprs) => {
            const block = ring ? exprs?.rotate : exprs?.translate;
            return block ? [block.x, block.y, block.z][axis] : null;
          })
        : undefined,
    };
  }

  /**
   * An absolute typed commit: move the axis to the expression's value
   * through the external-drag API (skipped when only a build can evaluate
   * it — the committed source then moves the part on the next render), and
   * persist the expression text into exactly that transform slot, declaring
   * any new variable the input introduced.
   */
  private handleAxisExpressionCommit(handle: GizmoTypableHandleId, commit: GizmoExpressionCommit): void {
    const controller = this.controller();
    const instanceId = this.attachedId;
    if (!controller || !instanceId || !controller.beginExternalDrag(instanceId)) {
      return;
    }
    const start = controller.getInstancePose(instanceId);
    if (!start) {
      controller.endExternalDrag();
      return;
    }
    if (isRingHandle(handle)) {
      this.commitRingExpression(controller, instanceId, start, handle, commit);
    } else {
      this.commitArrowExpression(controller, instanceId, start, AXIS_INDEX[handle], commit);
    }
  }

  private commitArrowExpression(
    controller: AssemblyController,
    instanceId: string,
    start: Pose,
    axis: 0 | 1 | 2,
    commit: GizmoExpressionCommit,
  ): void {
    let finalPose = start;
    if (commit.value !== null) {
      const target = start.position.clone();
      target.setComponent(axis, commit.value);
      if (controller.updateExternalDragTranslate(target) === null) {
        // The instance vanished (render diff pruned it).
        controller.cancelExternalDrag(start);
        return;
      }
      const moved = controller.getInstancePose(instanceId);
      if (moved) {
        finalPose = moved;
        this.gizmo.setPosition(moved.position);
      }
    }

    const inst = this.persistableInstance(instanceId);
    if (inst === undefined) {
      // Live-only move — the free-drag rule again.
      controller.endExternalDrag();
      this.reanchor();
      return;
    }

    // Echo the untouched axes (the handle's own slot masked), then land the
    // typed expression in exactly that slot.
    const exprs: AxisExprs = AssemblyGizmoDriver.maskTouched(
      this.cachedExprs()?.translate, [axis === 0, axis === 1, axis === 2],
    ) ?? [null, null, null];
    exprs[axis] = commit.expression;
    this.pendingCommit = { instanceId, start };
    void this.bindings
      .applyInstancePose(
        inst.sourceLocation!,
        [finalPose.position.x, finalPose.position.y, finalPose.position.z],
        null,
        {
          translateExprs: exprs,
          newVariables: commit.newVariable ? [commit.newVariable] : undefined,
        },
      )
      .then((result) => this.settleCommit(result));
  }

  /**
   * A typed ring commit sets one ZYX euler component absolutely and leaves
   * the other two untouched by construction, so their angle texts echo
   * through the rewrite. The commit's numeric triple is built in the
   * CHAIN's representation — cached angle texts resolved through the
   * in-scope variables, falling back to the decomposition of the current
   * orientation — never by re-decomposing the composed result, whose
   * equivalent-but-different euler representation (e.g. y past 90°) would
   * disagree with the echoed texts.
   */
  private commitRingExpression(
    controller: AssemblyController,
    instanceId: string,
    start: Pose,
    handle: GizmoRingHandleId,
    commit: GizmoExpressionCommit,
  ): void {
    const axis = AXIS_INDEX[handle];
    const eulerNow = AssemblyGizmoDriver.eulerZYXDegrees(start.quaternion);
    const cachedRotate = this.cachedExprs()?.rotate ?? null;
    const cachedTexts = cachedRotate
      ? [cachedRotate.x, cachedRotate.y, cachedRotate.z]
      : [null, null, null];

    const triple = eulerNow.map((decomposed, i) => {
      if (i === axis) {
        // Placeholder when unresolvable — the expression text wins the write.
        return commit.value ?? decomposed;
      }
      const text = cachedTexts[i];
      const resolved = text !== null
        ? resolveExpressionValue(text, this.cachedVariables)
        : null;
      return resolved ?? decomposed;
    }) as [number, number, number];

    let finalPose = start;
    if (commit.value !== null) {
      const target = AssemblyGizmoDriver.quaternionFromZYXDegrees(triple);
      if (controller.updateExternalDragRotate(target) === null) {
        controller.cancelExternalDrag(start);
        return;
      }
      const moved = controller.getInstancePose(instanceId);
      if (moved) {
        finalPose = moved;
        this.gizmo.setPosition(moved.position);
      }
    }

    const inst = this.persistableInstance(instanceId);
    if (inst === undefined) {
      controller.endExternalDrag();
      this.reanchor();
      return;
    }

    const rotateExprs: AxisExprs = [cachedTexts[0], cachedTexts[1], cachedTexts[2]];
    rotateExprs[axis] = commit.expression;
    this.pendingCommit = { instanceId, start };
    void this.bindings
      .applyInstancePose(
        inst.sourceLocation!,
        [finalPose.position.x, finalPose.position.y, finalPose.position.z],
        triple,
        {
          translateExprs: this.echoTranslateExprs(handle),
          rotateExprs,
          newVariables: commit.newVariable ? [commit.newVariable] : undefined,
        },
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
      // The write changed the chain's arg texts (and possibly declared a
      // variable) — refresh what the next input open shows.
      this.refreshVariables();
      void this.refreshPoseExprs();
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

  /** Inverse of {@link eulerZYXDegrees}: Q = Rz·Ry·Rx from chain degrees. */
  private static quaternionFromZYXDegrees(deg: [number, number, number]): Quaternion {
    return new Quaternion().setFromEuler(new Euler(
      MathUtils.degToRad(deg[0]), MathUtils.degToRad(deg[1]), MathUtils.degToRad(deg[2]), 'ZYX',
    ));
  }
}
