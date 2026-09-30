import { Quaternion, Vector3 } from 'three';
import { TransformGizmo } from '../gizmo/transform-gizmo';
import type { GizmoDelta } from '../gizmo/gizmo-session';
import type { Viewer } from '../../viewer';

export type SectionArrowCallbacks = {
  /** Live: the offset moved by `delta` along the plane normal since the gesture started. */
  onDrag(delta: number): void;
  /** The gesture ended with movement: commit `delta` along the normal. */
  onCommit(delta: number): void;
  /** The gesture was cancelled after movement — back to the start offset. */
  onCancel(): void;
  /** The offset the click-to-type input opens on. */
  currentOffset(): number;
  /** A typed absolute offset. */
  onCommitAbsolute(offset: number): void;
};

const UNIT_X = new Vector3(1, 0, 0);

/**
 * The section view's drag arrow: one translate handle of the shared
 * {@link TransformGizmo}, its X axis turned onto the cut plane's normal, so
 * a drag slides the plane forward and back along it. Deltas arrive as world
 * vectors and are projected onto the normal; a click on the arrow opens the
 * absolute offset input. The service owns the section state — the arrow
 * never moves anything itself.
 */
export class SectionArrow {
  private readonly gizmo: TransformGizmo;
  private readonly normal = new Vector3(0, 0, 1);
  private shown = false;
  private readonly removeInterceptors: (() => void)[] = [];

  constructor(viewer: Viewer, container: HTMLElement, private readonly callbacks: SectionArrowCallbacks) {
    const ctx = viewer.sceneContext;
    this.gizmo = new TransformGizmo(
      {
        scene: ctx.scene,
        overlayContainer: container,
        interactionRoot: container,
        canvas: ctx.renderer.domElement,
        getCamera: () => ctx.camera,
        createPickingRaycaster: (ndcX, ndcY) => ctx.createPickingRaycaster(ndcX, ndcY),
        requestRender: () => ctx.requestRender(),
      },
      {
        onDragStart: () => {},
        onDragUpdate: (delta) => this.callbacks.onDrag(this.along(delta)),
        onCommit: (delta) => this.callbacks.onCommit(this.along(delta)),
        onCancel: () => this.callbacks.onCancel(),
        getAxisTypingContext: () => ({ value: this.callbacks.currentOffset() }),
        onCommitAxisExpression: (_handle, commit) => {
          if (commit.value !== null && Number.isFinite(commit.value)) {
            this.callbacks.onCommitAbsolute(commit.value);
          }
        },
      },
      {
        handles: { arrows: true, rings: false, planes: false, center: false },
        pixelSize: 110,
        labels: { tx: { delta: 'dOffset', absolute: 'Offset' } },
      },
    );
    this.gizmo.setEnabledHandles(new Set(['tx']));
    this.removeInterceptors.push(
      viewer.addClickInterceptor(() => this.gizmo.consumeRecentInteraction()),
      viewer.addHoverSuppressor(() => this.gizmo.isPointerOverHandle()),
    );
  }

  get isDragging(): boolean {
    return this.gizmo.isDragging();
  }

  get visible(): boolean {
    return this.shown;
  }

  /** Place the arrow at `point`, pointing along `normal` (the +offset direction). */
  show(point: Vector3, normal: Vector3): void {
    this.normal.copy(normal).normalize();
    const orientation = new Quaternion().setFromUnitVectors(UNIT_X, this.normal);
    if (this.shown && this.gizmo.hasActiveGesture) {
      // Mid-drag the arrow follows the plane: move it, never restart the gesture.
      this.gizmo.setPosition(point);
      return;
    }
    this.gizmo.show(point, orientation);
    this.gizmo.setEnabledHandles(new Set(['tx']));
    this.shown = true;
  }

  hide(): void {
    if (!this.shown) {
      return;
    }
    this.gizmo.hide();
    this.shown = false;
  }

  dispose(): void {
    this.hide();
    for (const remove of this.removeInterceptors) {
      remove();
    }
    this.gizmo.dispose();
  }

  private along(delta: GizmoDelta): number {
    return delta.kind === 'translate' ? delta.delta.dot(this.normal) : 0;
  }
}
