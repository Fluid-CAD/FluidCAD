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
  sketchToClient,
} from '../sketch-plane-utils';
import { ICON_ELLIPSE } from '../../ui/icons';
import { ExpressionInput, CommitResult } from '../../ui/expression-input';
import {
  START_POINT_COLOR,
  SNAP_VERTEX_COLOR,
  SNAP_GRID_COLOR,
  addDot,
  addDashedEllipse,
} from './tool-preview-utils';
import {
  coincident, dimMagnitude, ellipseText, inferred, newTarget, refTarget, type SolvedConstraintParam,
} from './solved-emission';
import type { SolvedVertexRef } from '../../snapping/types';

type ExpressionPhase = 'rx' | 'ry';

/**
 * Ellipse — `ellipse(center, rx, ry)`, axes aligned to the sketch plane.
 *
 * The gesture mirrors the centered rectangle: the first click (or the X/Y
 * pill) lands the centre; the cursor then stretches the semi-radii along
 * the plane's X and Y axes, one pill each (RX, then RY), a click or Enter
 * committing the pill in hand. A snapped centre becomes a coincident on the
 * ellipse's centre point — the only solver entity an ellipse registers; the
 * radii are literals (or typed expressions) the solver never resizes, so no
 * dimension constraint is emitted for them.
 */
export class EllipseTool extends SketchTool {
  readonly id = 'ellipse' as const;
  readonly label = 'Ellipse';
  readonly icon = ICON_ELLIPSE;

  private centerPoint: [number, number] | null = null;
  /** The centre as picked: same position, plus any typed axis expressions. */
  private centerPick: PickedPoint | null = null;
  /** Solved sketches: the centre click's snap provenance. */
  private centerSnapRef: SolvedVertexRef | null = null;
  private mousePoint: [number, number] | null = null;
  private lastSnapType: SnapType = 'none';
  private expressionInput: ExpressionInput;
  private lastClientX = 0;
  private lastClientY = 0;

  private expressionPhase: ExpressionPhase = 'rx';
  private rxExpression: CommitResult | null = null;
  /** The committed RX as a magnitude for the preview while RY is set. */
  private lockedRx: number | null = null;

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
    this.resetState();
    this.removePreviewFromScene();
  }

  onSceneUpdate(sceneObjects: SceneObjectRender[], sketchId: string): void {
    const snapManager = SnapManager.fromSceneObjects(sceneObjects, sketchId, this.plane, this.ctx);
    this.updateSnapManager(snapManager);
    this.refreshVariables();
  }

  /** The centre is the point that lands in the source; the radii come from
   * the RX/RY pills, which take the keystrokes after it. */
  protected override awaitingPoint(): boolean {
    return this.centerPoint === null;
  }

  protected override onTypedPoint(point: PickedPoint): void {
    this.consumeCenter(point);
  }

  /** Single writer for both halves of the anchor, so the position the
   * preview draws and the expressions the statement emits cannot drift.
   * Clears the snap ref — the mouse pick path re-captures it right after
   * (typed picks never carry one). */
  private consumeCenter(center: PickedPoint | null): void {
    this.centerPick = center;
    this.centerPoint = center ? center.value : null;
    this.centerSnapRef = null;
    this.syncPointInput();
    this.rebuildPreview();
  }

  private resetState(): void {
    this.centerPoint = null;
    this.centerPick = null;
    this.centerSnapRef = null;
    this.mousePoint = null;
    this.expressionPhase = 'rx';
    this.rxExpression = null;
    this.lockedRx = null;
    this.expressionInput.hide();
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
      // The pill contributes any axis the user typed; free axes come from
      // the cursor, so a plain click behaves exactly as it always did.
      const picked = this.applyPointInput(result.point2d);
      this.consumeCenter(picked);
      this.centerSnapRef = !picked.typed && !(e.ctrlKey || e.metaKey) ? result.ref ?? null : null;
      return;
    }

    if (this.expressionInput.isVisible) {
      this.expressionInput.commitCurrentValue();
    } else {
      this.commitFromGeometry(roundPoint(result.point2d));
    }
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
      // Typed coordinates clear first; only a clean pill lets Escape fall
      // through to cancelling the in-progress ellipse.
      if (this.handlePointInputEscape()) {
        return;
      }
      if (this.centerPoint) {
        this.resetState();
        this.rebuildPreview();
      }
    }
  }

  /** The cursor's semi-radii: its axis offsets from the centre, 2dp. */
  private computeRadii(point: [number, number]): { rx: number; ry: number } {
    const center = this.centerPoint!;
    return {
      rx: Math.round(Math.abs(point[0] - center[0]) * 100) / 100,
      ry: Math.round(Math.abs(point[1] - center[1]) * 100) / 100,
    };
  }

  /** What the preview draws: the locked RX once committed, the cursor
   * otherwise. */
  private previewRadii(point: [number, number]): { rx: number; ry: number } {
    const { rx, ry } = this.computeRadii(point);
    return { rx: this.lockedRx ?? rx, ry };
  }

  /** The pill sits on the semi-axis it sets: the X extreme for RX, the Y
   * extreme for RY — the axis end the cursor is on. */
  private dimensionInputAnchor(): { clientX: number; clientY: number } {
    if (!this.centerPoint || !this.mousePoint) {
      return { clientX: this.lastClientX, clientY: this.lastClientY };
    }
    const center = this.centerPoint;
    const { rx, ry } = this.previewRadii(this.mousePoint);
    const xSign = this.mousePoint[0] >= center[0] ? 1 : -1;
    const ySign = this.mousePoint[1] >= center[1] ? 1 : -1;
    const at: [number, number] = this.expressionPhase === 'rx'
      ? [center[0] + xSign * rx, center[1]]
      : [center[0], center[1] + ySign * ry];
    return sketchToClient(this.ctx, this.plane, at);
  }

  /** A typed literal must be a positive radius; expressions are checked
   * by the kernel at build time. */
  private static radiusRefusal(expression: string): string | null {
    const num = parseFloat(expression);
    if (!isNaN(num) && String(num) === expression && num <= 0) {
      return 'A radius must be positive';
    }
    return null;
  }

  private showPill(phase: ExpressionPhase, value: number): void {
    const anchor = this.dimensionInputAnchor();
    this.expressionInput.show({
      label: phase === 'rx' ? 'RX' : 'RY',
      value: String(value),
      clientX: anchor.clientX,
      clientY: anchor.clientY,
      variables: this.cachedVariables,
      validate: EllipseTool.radiusRefusal,
      onCommit: (result) => {
        if (phase === 'rx') {
          this.onRxCommit(result);
        } else {
          this.onRyCommit(result);
        }
      },
    });
  }

  private updateDimensionInput(): void {
    if (!this.centerPoint || !this.mousePoint) {
      return;
    }

    const { rx, ry } = this.computeRadii(this.mousePoint);
    const value = this.expressionPhase === 'rx' ? rx : ry;
    if (value <= 0) {
      return;
    }

    if (!this.expressionInput.isVisible) {
      this.showPill(this.expressionPhase, value);
    } else {
      const anchor = this.dimensionInputAnchor();
      this.expressionInput.updateValue(value);
      this.expressionInput.updatePosition(anchor.clientX, anchor.clientY);
    }
  }

  private onRxCommit(result: CommitResult): void {
    this.rxExpression = result;
    this.lockedRx = this.previewMagnitude(result);
    this.expressionPhase = 'ry';

    // The pill hides itself after the commit callback; re-open it for RY
    // once that has run.
    queueMicrotask(() => {
      if (this.mousePoint && this.centerPoint) {
        const { ry } = this.computeRadii(this.mousePoint);
        this.showPill('ry', ry);
      }
      this.rebuildPreview();
    });
  }

  private onRyCommit(result: CommitResult): void {
    if (!this.centerPick || !this.rxExpression) {
      return;
    }
    this.commitEllipse(this.centerPick, this.rxExpression, result);
    this.finishGesture();
  }

  /** A click with no pill in hand: both semi-radii off the cursor. */
  private commitFromGeometry(point: [number, number]): void {
    if (!this.centerPick) {
      return;
    }
    const { rx, ry } = this.computeRadii(point);
    const rxResult = this.rxExpression ?? { expression: String(rx) };
    if (this.rxExpression === null && rx <= 0) {
      return;
    }
    if (ry <= 0) {
      return;
    }
    this.commitEllipse(this.centerPick, rxResult, { expression: String(ry) });
    this.finishGesture();
  }

  private finishGesture(): void {
    this.expressionInput.hide();
    this.centerPoint = null;
    this.centerPick = null;
    this.centerSnapRef = null;
    this.expressionPhase = 'rx';
    this.rxExpression = null;
    this.lockedRx = null;
    this.syncPointInput();
    this.rebuildPreview();
  }

  /** Preview magnitude for an RX committed as a variable/expression: the
   * variable's own value when statically resolvable, else the cursor's RX
   * at commit time. The statement still carries the expression. */
  private previewMagnitude(result: CommitResult): number | null {
    const fromVariable = SketchTool.resolveCommittedMagnitude(result, this.cachedVariables);
    if (fromVariable !== null) {
      return fromVariable;
    }
    if (this.mousePoint && this.centerPoint) {
      return this.computeRadii(this.mousePoint).rx;
    }
    return null;
  }

  protected commitEllipse(center: PickedPoint, rxResult: CommitResult, ryResult: CommitResult): void {
    const newVariables = [rxResult.newVariable, ryResult.newVariable]
      .filter((v): v is NonNullable<typeof v> => v !== undefined);

    if (this.solvedCtx) {
      const constraints: SolvedConstraintParam[] = [];
      // Snap provenance → a coincident on the centre point (the Auto-
      // constraints toggle gates the inference). The radii are literals
      // the solver never resizes, so a typed RX/RY is the statement's own
      // argument, never a dimension row.
      if (this.centerSnapRef && this.autoConstraintsEnabled()) {
        constraints.push(inferred(coincident(newTarget(0, 'center'), refTarget(this.centerSnapRef))));
      }
      const variables = [...center.newVariables, ...newVariables];
      void this.solvedCtx.emit({
        geometry: [{
          kind: 'ellipse',
          text: ellipseText(center, dimMagnitude(rxResult.expression), dimMagnitude(ryResult.expression)),
        }],
        constraints,
        ...(variables.length > 0 ? { newVariables: variables } : {}),
      });
      this.centerSnapRef = null;
    }
  }

  protected rebuildPreview(): void {
    this.disposePreview();

    const camera = this.ctx.camera;
    const planeNormal = new Vector3(this.plane.normal.x, this.plane.normal.y, this.plane.normal.z);

    if (this.centerPoint) {
      addDot(this.previewGroup, this.centerPoint, START_POINT_COLOR, camera, planeNormal, this.plane);

      if (this.mousePoint) {
        const { rx, ry } = this.previewRadii(this.mousePoint);
        if (rx > 0 && ry > 0) {
          addDashedEllipse(this.previewGroup, this.centerPoint, rx, ry, this.plane);
        }
      }
    } else if (this.mousePoint && this.lastSnapType !== 'none') {
      const snapColor = this.lastSnapType === 'vertex' ? SNAP_VERTEX_COLOR : SNAP_GRID_COLOR;
      addDot(this.previewGroup, this.mousePoint, snapColor, camera, planeNormal, this.plane, 0.6);
    }

    this.requestRender();
  }
}
