import { Vector3 } from 'three';
import type { Viewer } from '../../viewer';
import type { VariableInfo } from '../../ui/expression-core';
import { isEditableTarget } from '../../editable-target';
import { TransformGizmo } from '../gizmo/transform-gizmo';
import type { GizmoAxisTypingContext, GizmoTypableHandleId } from '../gizmo/transform-gizmo';
import type { GizmoExpressionCommit } from '../gizmo/gizmo-value-input';
import type { GizmoDelta } from '../gizmo/gizmo-session';
import type { TranslateAxis } from './translate-distances';

export type TranslateGizmoCallbacks = {
  /** A drag crossed the threshold: snapshot where it starts; false refuses it. */
  onDragStart(): boolean;
  /** Live: the solids moved by `delta` (world) since the gesture started. */
  onDrag(delta: Vector3): void;
  /** The gesture ended with movement, or a length was typed mid-drag: commit `delta`. */
  onCommit(delta: Vector3): void;
  /** The gesture was cancelled after movement — back to where it started. */
  onCancel(): void;
  /** What a clicked arrow's input opens on: its distance and source text; null declines. */
  typingContext(axis: TranslateAxis): GizmoAxisTypingContext | null;
  /** A distance typed for one axis — an expression, maybe declaring a variable. */
  onCommitDistance(axis: TranslateAxis, commit: GizmoExpressionCommit): void;
  /** Identifiers the value input may reference. */
  variables(): VariableInfo[];
};

/** The arrow handles a click opens a distance input on — rings are never built. */
const ARROW_AXES: Partial<Record<GizmoTypableHandleId, TranslateAxis>> = { tx: 0, ty: 1, tz: 2 };

/**
 * The translate dialog's handle on the viewport: the assembly's
 * {@link TransformGizmo} with its translate handles only — the arrows, the
 * plane squares and the center ball, world-aligned, since `translate()`
 * moves along the world axes. It stands where the moved solids will land and
 * reports gestures as world vectors; the service owns the distances, the
 * ghost and where the gizmo goes next. A click on an arrow opens the
 * distance input for that axis — full expression semantics, seeded with the
 * field's own text.
 */
export class TranslateGizmo {
  private readonly gizmo: TransformGizmo;
  /** Whether the gizmo is up — flagged ahead of the core's own state, see {@link hide}. */
  private shown = false;

  constructor(viewer: Viewer, container: HTMLElement, callbacks: TranslateGizmoCallbacks) {
    const ctx = viewer.sceneContext;
    const along = (delta: GizmoDelta): Vector3 => delta.kind === 'translate' ? delta.delta : new Vector3();
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
        onDragStart: () => {
          if (!callbacks.onDragStart()) {
            this.gizmo.cancelActiveDrag();
          }
        },
        onDragUpdate: (delta) => callbacks.onDrag(along(delta)),
        onCommit: (delta) => callbacks.onCommit(along(delta)),
        onCancel: () => callbacks.onCancel(),
        getAxisTypingContext: (handle) => {
          const axis = ARROW_AXES[handle];
          return axis === undefined ? null : callbacks.typingContext(axis);
        },
        onCommitAxisExpression: (handle, commit) => {
          const axis = ARROW_AXES[handle];
          if (axis !== undefined) {
            callbacks.onCommitDistance(axis, commit);
          }
        },
      },
      {
        handles: { rings: false },
        variables: () => callbacks.variables(),
      },
    );
    viewer.addClickInterceptor(() => this.gizmo.consumeRecentInteraction());
    viewer.addHoverSuppressor(() => this.gizmo.isPointerOverHandle());
    // A gesture's Escape belongs to the gizmo, which cancels it in its own
    // (window) handler — claimed in document capture, ahead of the open
    // dialogs' listener, so the first Escape reverts the drag and only the
    // next one closes the dialog. Escapes typed into an input stay theirs.
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && this.gizmo.hasActiveGesture && !isEditableTarget(e.target)) {
        e.preventDefault();
      }
    }, true);
  }

  /** Any gesture in flight — a pending click, a drag, or an open distance input. */
  get hasActiveGesture(): boolean {
    return this.gizmo.hasActiveGesture;
  }

  /** Stand the gizmo at `position` — re-anchored in place while it is already up. */
  place(position: Vector3): void {
    if (this.shown) {
      this.gizmo.setPosition(position);
      return;
    }
    this.shown = true;
    this.gizmo.show(position);
  }

  /** Take the gizmo down; a gesture in flight is cancelled. */
  hide(): void {
    if (!this.shown) {
      return;
    }
    // Flag first: hiding mid-drag cancels the gesture, whose callback
    // re-syncs the dialog, which hides the gizmo again.
    this.shown = false;
    this.gizmo.hide();
  }
}
