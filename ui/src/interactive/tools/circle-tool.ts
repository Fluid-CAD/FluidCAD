import { Vector3 } from 'three';
import { SketchTool, InsertGeometryFn, FetchVariablesFn, PickedPoint } from '../sketch-tool';
import { SceneContext } from '../../scene/scene-context';
import { PlaneData, SceneObjectRender } from '../../types';
import { SnapController } from '../../snapping/snap-controller';
import { SnapManager } from '../../snapping/snap-manager';
import { SnapType } from '../../snapping/types';
import {
  projectToSketch,
  roundPoint,
  dist2D,
} from '../sketch-plane-utils';
import { ICON_CIRCLE } from '../../ui/icons';
import { ExpressionInput, CommitResult } from '../../ui/expression-input';
import {
  START_POINT_COLOR,
  SNAP_VERTEX_COLOR,
  SNAP_GRID_COLOR,
  addDot,
  addDashedCircle,
} from './tool-preview-utils';
import { coincident, newTarget, refTarget, type SolvedConstraintParam } from './solved-emission';
import type { SolvedVertexRef } from '../../snapping/types';

export class CircleTool extends SketchTool {
  readonly id = 'circle' as const;
  readonly label = 'Circle';
  readonly icon = ICON_CIRCLE;

  private centerPoint: [number, number] | null = null;
  /** The centre as picked: same position, plus any typed axis expressions. */
  private centerPick: PickedPoint | null = null;
  /** Solved sketches: the centre click's snap provenance (concentric-style
   * coincident on the centre point). */
  private centerSnapRef: SolvedVertexRef | null = null;
  private mousePoint: [number, number] | null = null;
  private lastSnapType: SnapType = 'none';
  private expressionInput: ExpressionInput;
  private lastClientX = 0;
  private lastClientY = 0;

  private boundMouseDown: (e: MouseEvent) => void;
  private boundMouseUp: (e: MouseEvent) => void;
  private boundMouseMove: (e: MouseEvent) => void;
  private boundKeyDown: (e: KeyboardEvent) => void;
  private downX = 0;
  private downY = 0;

  constructor(
    ctx: SceneContext,
    plane: PlaneData,
    snapController: SnapController,
    insertGeometry: InsertGeometryFn,
    container: HTMLElement,
    fetchVariables: FetchVariablesFn,
  ) {
    super(ctx, plane, snapController, insertGeometry, container, fetchVariables);
    this.expressionInput = new ExpressionInput(container);
    this.boundMouseDown = this.handleMouseDown.bind(this);
    this.boundMouseUp = this.handleMouseUp.bind(this);
    this.boundMouseMove = this.handleMouseMove.bind(this);
    this.boundKeyDown = this.handleKeyDown.bind(this);
  }

  protected onActivate(): void {
    this.addPreviewToScene();
    this.canvas.addEventListener('mousedown', this.boundMouseDown);
    this.canvas.addEventListener('mouseup', this.boundMouseUp);
    this.canvas.addEventListener('mousemove', this.boundMouseMove);
    window.addEventListener('keydown', this.boundKeyDown);
  }

  protected onDeactivate(): void {
    this.canvas.removeEventListener('mousedown', this.boundMouseDown);
    this.canvas.removeEventListener('mouseup', this.boundMouseUp);
    this.canvas.removeEventListener('mousemove', this.boundMouseMove);
    window.removeEventListener('keydown', this.boundKeyDown);
    this.centerPoint = null;
    this.centerPick = null;
    this.mousePoint = null;
    this.expressionInput.hide();
    this.removePreviewFromScene();
  }

  /** The centre is the point that lands in the source; the rim click is a
   * diameter, which the expression input already covers. */
  protected override awaitingPoint(): boolean {
    return this.centerPoint === null;
  }

  protected override onTypedPoint(point: PickedPoint): void {
    this.consumeCenter(point);
  }

  onSceneUpdate(sceneObjects: SceneObjectRender[], sketchId: string): void {
    const snapManager = SnapManager.fromSceneObjects(sceneObjects, sketchId, this.plane, this.ctx);
    this.updateSnapManager(snapManager);
    this.refreshVariables();
  }

  private handleMouseDown(e: MouseEvent): void {
    this.downX = e.clientX;
    this.downY = e.clientY;
  }

  private handleMouseUp(e: MouseEvent): void {
    const dx = e.clientX - this.downX;
    const dy = e.clientY - this.downY;
    if (dx * dx + dy * dy > 64) {
      return;
    }

    const raw = projectToSketch(this.ctx, this.plane, e.clientX, e.clientY);
    if (!raw) {
      return;
    }

    const result = this.snapController.snap(raw);

    if (!this.centerPoint) {
      // The pill contributes any axis the user typed; free axes come from the
      // cursor, so a plain click behaves exactly as it always did.
      const picked = this.applyPointInput(result.point2d);
      this.consumeCenter(picked);
      this.centerSnapRef = !picked.typed && !(e.ctrlKey || e.metaKey) ? result.ref ?? null : null;
      return;
    }

    const point = roundPoint(result.point2d);
    if (this.expressionInput.isVisible) {
      this.expressionInput.commitCurrentValue();
    } else {
      const diameter = Math.round(dist2D(this.centerPoint, point) * 2 * 100) / 100;
      if (diameter <= 0) {
        return;
      }
      this.commitCircle(this.centerPick!, { expression: String(diameter) }, false);
    }
    this.expressionInput.hide();
    this.consumeCenter(null);
  }

  private consumeCenter(center: PickedPoint | null): void {
    // Single writer for both halves of the anchor, so the position the
    // preview draws and the expressions the statement emits cannot drift.
    this.centerPick = center;
    this.centerPoint = center ? center.value : null;
    if (!center) {
      this.centerSnapRef = null;
    }
    this.syncPointInput();
    this.rebuildPreview();
  }

  private handleMouseMove(e: MouseEvent): void {
    this.lastClientX = e.clientX;
    this.lastClientY = e.clientY;

    const raw = projectToSketch(this.ctx, this.plane, e.clientX, e.clientY);
    if (!raw) {
      this.mousePoint = null;
      this.lastSnapType = 'none';
      this.rebuildPreview();
      return;
    }

    const result = this.snapController.snap(raw);
    this.mousePoint = result.point2d;
    this.lastSnapType = result.snapType;
    this.rebuildPreview();
    this.updateDimensionInput();
  }

  private handleKeyDown(e: KeyboardEvent): void {
    if (e.key === 'Escape') {
      // A pill holding typed coordinates clears first; only a clean pill lets
      // Escape fall through to cancelling the in-progress circle.
      if (this.handlePointInputEscape()) {
        return;
      }
      if (this.centerPoint) {
        this.expressionInput.hide();
        this.consumeCenter(null);
      }
    }
  }

  private updateDimensionInput(): void {
    if (!this.centerPoint || !this.mousePoint) {
      return;
    }

    const diameter = Math.round(dist2D(this.centerPoint, this.mousePoint) * 2 * 100) / 100;
    if (diameter <= 0) {
      return;
    }

    if (!this.expressionInput.isVisible) {
      this.expressionInput.show({
        label: '⌀',
        value: String(diameter),
        clientX: this.lastClientX,
        clientY: this.lastClientY,
        variables: this.cachedVariables,
        onCommit: (result) => {
          if (this.centerPoint) {
            // Only a TYPED ⌀ becomes a dimension; a click merely commits the
            // pill's mouse-tracked value.
            this.commitCircle(this.centerPick!, result, this.expressionInput.isTyping);
            this.expressionInput.hide();
            this.consumeCenter(null);
          }
        },
      });
    } else {
      this.expressionInput.updateValue(diameter);
      this.expressionInput.updatePosition(this.lastClientX, this.lastClientY);
    }
  }

  private commitCircle(center: PickedPoint, result: CommitResult, typed: boolean): void {
    const { expression, newVariable } = result;

    if (this.solvedCtx) {
      const constraints: SolvedConstraintParam[] = [];
      if (this.centerSnapRef) {
        constraints.push(coincident(newTarget(0, 'center'), refTarget(this.centerSnapRef)));
      }
      if (typed) {
        constraints.push({ kind: 'diameter', targets: [{ newIndex: 0 }], valueExpr: expression });
      }
      const centerText = this.formatPoint(center.relative ? roundPoint(center.value) : center);
      const variables = [...center.newVariables, ...(newVariable ? [newVariable] : [])];
      void this.solvedCtx.emit({
        geometry: [{ kind: 'circle', text: `circle(${centerText}, ${expression})` }],
        constraints,
        ...(variables.length > 0 ? { newVariables: variables } : {}),
      });
      this.centerSnapRef = null;
      return;
    }

    this.insertAtPoint(
      center,
      (point) => `circle(${point}, ${expression})`,
      () => `circle(${expression})`,
      newVariable ? [newVariable] : [],
    );
  }

  private rebuildPreview(): void {
    this.disposePreview();

    const camera = this.ctx.camera;
    const planeNormal = new Vector3(this.plane.normal.x, this.plane.normal.y, this.plane.normal.z);

    if (this.centerPoint) {
      addDot(this.previewGroup, this.centerPoint, START_POINT_COLOR, camera, planeNormal, this.plane);

      if (this.mousePoint) {
        const radius = dist2D(this.centerPoint, this.mousePoint);
        if (radius > 0) {
          addDashedCircle(this.previewGroup, this.centerPoint, radius, this.plane);
        }
      }
    } else if (this.mousePoint && this.lastSnapType !== 'none') {
      const snapColor = this.lastSnapType === 'vertex' ? SNAP_VERTEX_COLOR : SNAP_GRID_COLOR;
      addDot(this.previewGroup, this.mousePoint, snapColor, camera, planeNormal, this.plane, 0.6);
    }

    this.requestRender();
  }
}
