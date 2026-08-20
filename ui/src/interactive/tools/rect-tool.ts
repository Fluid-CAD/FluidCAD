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
import { ICON_RECT } from '../../ui/icons';
import { ExpressionInput, VariableInfo, CommitResult } from '../../ui/expression-input';
import {
  START_POINT_COLOR,
  SNAP_VERTEX_COLOR,
  SNAP_GRID_COLOR,
  addDot,
  addDashedRect,
} from './tool-preview-utils';
import { dimMagnitude, rectEmission } from './solved-emission';

type ExpressionPhase = 'width' | 'height';

export class RectTool extends SketchTool {
  readonly id = 'rect' as const;
  readonly label = 'Rectangle';
  readonly icon = ICON_RECT;

  private startPoint: [number, number] | null = null;
  /** The start corner as picked: same position, plus any typed axis expressions. */
  private startPick: PickedPoint | null = null;
  private mousePoint: [number, number] | null = null;
  private lastSnapType: SnapType = 'none';
  private readonly centered: boolean;
  private expressionInput: ExpressionInput;
  private lastClientX = 0;
  private lastClientY = 0;

  private expressionPhase: ExpressionPhase = 'width';
  private widthExpression: CommitResult | null = null;
  private lockedWidth: number | null = null;
  private widthIsNumeric = false;
  /** Whether each pill value was actually TYPED (not click-committed) —
   * typed sizes become explicit dimensions in a solved sketch. */
  private widthTyped = false;
  private heightTyped = false;

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
    centered: boolean,
  ) {
    super(ctx, plane, snapController, insertGeometry, container, fetchVariables);
    this.expressionInput = new ExpressionInput(container);
    this.centered = centered;
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

  /** The start corner is the point that lands in the source; the second click
   * sizes the rectangle, which the expression input already covers. */
  protected override awaitingPoint(): boolean {
    return this.startPoint === null;
  }

  protected override onTypedPoint(point: PickedPoint): void {
    this.consumeStart(point);
  }

  /** Single writer for both halves of the anchor, so the position the preview
   * draws and the expressions the statement emits cannot drift. */
  private consumeStart(start: PickedPoint): void {
    this.startPick = start;
    this.startPoint = start.value;
    this.syncPointInput();
    this.rebuildPreview();
  }

  private resetState(): void {
    this.startPoint = null;
    this.startPick = null;
    this.mousePoint = null;
    this.expressionPhase = 'width';
    this.widthExpression = null;
    this.lockedWidth = null;
    this.widthIsNumeric = false;
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
    const point = roundPoint(result.point2d);

    if (!this.startPoint) {
      this.consumeStart(this.applyPointInput(result.point2d));
      return;
    }

    if (this.expressionInput.isVisible) {
      this.expressionInput.commitCurrentValue();
    } else {
      this.commitFromGeometry(point);
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
      // Typed coordinates clear first; only a clean pill lets Escape
      // fall through to cancelling the in-progress shape.
      if (this.handlePointInputEscape()) {
        return;
      }
      if (this.startPoint) {
        this.resetState();
        this.rebuildPreview();
      }
    }
  }

  private computeDimensions(endPoint: [number, number]): { width: number; height: number } {
    const start = this.startPoint!;
    if (this.centered) {
      const dx = endPoint[0] - start[0];
      const dy = endPoint[1] - start[1];
      return { width: Math.round(dx * 2 * 100) / 100, height: Math.round(dy * 2 * 100) / 100 };
    }
    return {
      width: Math.round((endPoint[0] - start[0]) * 100) / 100,
      height: Math.round((endPoint[1] - start[1]) * 100) / 100,
    };
  }

  private computePreviewCorners(endPoint: [number, number]): { c1: [number, number]; c2: [number, number] } {
    const start = this.startPoint!;
    if (this.lockedWidth !== null) {
      if (this.centered) {
        const hw = this.lockedWidth / 2;
        const dy = endPoint[1] - start[1];
        return {
          c1: [start[0] - hw, start[1] - dy],
          c2: [start[0] + hw, start[1] + dy],
        };
      }
      const xSign = (endPoint[0] >= start[0]) ? 1 : -1;
      return { c1: start, c2: [start[0] + xSign * this.lockedWidth, endPoint[1]] };
    }
    if (this.centered) {
      const dx = endPoint[0] - start[0];
      const dy = endPoint[1] - start[1];
      return {
        c1: [start[0] - dx, start[1] - dy],
        c2: [start[0] + dx, start[1] + dy],
      };
    }
    return { c1: start, c2: endPoint };
  }

  // Anchor the dimension input at the midpoint of the edge being set: the
  // horizontal centre of the width edge while setting width, the vertical
  // centre of the height edge while setting height. Falls back to the cursor
  // if the rectangle isn't established yet.
  private dimensionInputAnchor(): { clientX: number; clientY: number } {
    if (!this.startPoint || !this.mousePoint) {
      return { clientX: this.lastClientX, clientY: this.lastClientY };
    }
    const { c1, c2 } = this.computePreviewCorners(this.mousePoint);
    const mid: [number, number] = this.expressionPhase === 'width'
      ? [(c1[0] + c2[0]) / 2, c1[1]]
      : [c2[0], (c1[1] + c2[1]) / 2];
    return sketchToClient(this.ctx, this.plane, mid);
  }

  private updateDimensionInput(): void {
    if (!this.startPoint || !this.mousePoint) {
      return;
    }

    const { width, height } = this.computeDimensions(this.mousePoint);
    const anchor = this.dimensionInputAnchor();

    if (this.expressionPhase === 'width') {
      const absW = Math.round(Math.abs(width) * 100) / 100;
      if (absW <= 0) {
        return;
      }

      if (!this.expressionInput.isVisible) {
        this.expressionInput.show({
          label: 'W',
          value: String(absW),
          clientX: anchor.clientX,
          clientY: anchor.clientY,
          variables: this.cachedVariables,
          onCommit: (result) => this.onWidthCommit(result),
        });
      } else {
        this.expressionInput.updateValue(absW);
        this.expressionInput.updatePosition(anchor.clientX, anchor.clientY);
      }
    } else if (this.expressionPhase === 'height') {
      const absH = Math.round(Math.abs(height) * 100) / 100;

      if (!this.expressionInput.isVisible) {
        this.expressionInput.show({
          label: 'H',
          value: String(absH),
          clientX: anchor.clientX,
          clientY: anchor.clientY,
          variables: this.cachedVariables,
          onCommit: (result) => this.onHeightCommit(result),
        });
      } else {
        this.expressionInput.updateValue(absH);
        this.expressionInput.updatePosition(anchor.clientX, anchor.clientY);
      }
    }
  }

  private onWidthCommit(result: CommitResult): void {
    const num = parseFloat(result.expression);
    const isNumeric = !isNaN(num) && String(num) === result.expression;

    this.widthTyped = this.expressionInput.isTyping;
    this.widthIsNumeric = isNumeric;
    this.widthExpression = result;
    this.lockedWidth = isNumeric ? num : this.previewMagnitude(result);

    this.expressionPhase = 'height';

    queueMicrotask(() => {
      if (this.mousePoint && this.startPoint) {
        const { height } = this.computeDimensions(this.mousePoint);
        const absH = Math.round(Math.abs(height) * 100) / 100;
        const anchor = this.dimensionInputAnchor();

        this.expressionInput.show({
          label: 'H',
          value: String(absH),
          clientX: anchor.clientX,
          clientY: anchor.clientY,
          variables: this.cachedVariables,
          onCommit: (r) => this.onHeightCommit(r),
        });
      }
      this.rebuildPreview();
    });
  }

  private onHeightCommit(result: CommitResult): void {
    if (!this.startPoint || !this.widthExpression) {
      return;
    }

    this.heightTyped = this.expressionInput.isTyping;
    const num = parseFloat(result.expression);
    const isNumeric = !isNaN(num) && String(num) === result.expression;

    const widthResult = this.resolveSignedDim(this.widthExpression, this.widthIsNumeric, this.lockedWidth, 0);

    const heightResult = this.resolveSignedDim(result, isNumeric, isNumeric ? num : null, 1);

    this.commitRect(this.startPick!, widthResult, heightResult);
    this.expressionInput.hide();
    this.startPoint = null;
    this.startPick = null;
    this.expressionPhase = 'width';
    this.widthExpression = null;
    this.lockedWidth = null;
    this.widthIsNumeric = false;
    this.rebuildPreview();
  }

  private commitFromGeometry(endPoint: [number, number]): void {
    if (!this.startPoint) {
      return;
    }

    const { width, height } = this.computeDimensions(endPoint);
    if (width === 0 || height === 0) {
      return;
    }

    this.commitRect(
      this.startPick!,
      { expression: String(width) },
      { expression: String(height) },
    );
    this.expressionInput.hide();
    this.startPoint = null;
    this.startPick = null;
    this.expressionPhase = 'width';
    this.widthExpression = null;
    this.lockedWidth = null;
    this.widthIsNumeric = false;
    this.rebuildPreview();
  }

  // Preview magnitude for a width committed as a variable/expression: the
  // variable's own value when statically resolvable, else the mouse-derived
  // width at commit time. The final statement still uses the expression.
  private previewMagnitude(result: CommitResult): number | null {
    const fromVariable = SketchTool.resolveCommittedMagnitude(result, this.cachedVariables);
    if (fromVariable !== null) {
      return fromVariable;
    }
    if (this.mousePoint && this.startPoint) {
      const { width } = this.computeDimensions(this.mousePoint);
      return Math.abs(width);
    }
    return null;
  }

  private resolveSignedDim(expr: CommitResult, isNumeric: boolean, absValue: number | null, axis: 0 | 1): CommitResult {
    if (!this.mousePoint || !this.startPoint || this.centered) {
      return expr;
    }
    const sign = axis === 0
      ? ((this.mousePoint[0] >= this.startPoint[0]) ? 1 : -1)
      : ((this.mousePoint[1] >= this.startPoint[1]) ? 1 : -1);
    if (isNumeric && absValue !== null) {
      return { expression: String(Math.round(sign * absValue * 100) / 100), newVariable: expr.newVariable };
    }
    if (sign < 0) {
      return { expression: SketchTool.negateExpression(expr.expression), newVariable: expr.newVariable };
    }
    return expr;
  }

  protected commitRect(
    start: PickedPoint,
    widthResult: CommitResult,
    heightResult: CommitResult,
  ): void {
    const newVariables = [widthResult.newVariable, heightResult.newVariable]
      .filter((v): v is NonNullable<typeof v> => v !== undefined);

    if (this.solvedCtx) {
      const w = this.resolveSolvedDim(widthResult);
      const h = this.resolveSolvedDim(heightResult);
      if (w === null || h === null || w === 0 || h === 0) {
        return;
      }
      // Centered gestures anchor at the rect's centre — the emitted corner
      // is centre − half-extent; the primitives are the same 4 lines.
      const corner: [number, number] = this.centered
        ? [start.value[0] - w / 2, start.value[1] - h / 2]
        : [start.value[0], start.value[1]];
      const emission = rectEmission({
        corner,
        w,
        h,
        ...(this.widthTyped ? { widthDim: dimMagnitude(widthResult.expression) } : {}),
        ...(this.heightTyped ? { heightDim: dimMagnitude(heightResult.expression) } : {}),
      });
      const variables = [...start.newVariables, ...newVariables];
      void this.solvedCtx.emit({
        ...emission,
        ...(variables.length > 0 ? { newVariables: variables } : {}),
      });
      this.widthTyped = false;
      this.heightTyped = false;
      return;
    }

    const suffix = this.centered ? '.centered()' : '';
    this.insertAtPoint(
      start,
      (point) => `rect(${point}, ${widthResult.expression}, ${heightResult.expression})${suffix}`,
      () => `rect(${widthResult.expression}, ${heightResult.expression})${suffix}`,
      newVariables,
    );
  }

  /** A committed dim's signed numeric value for corner math: the literal, a
   * statically-resolved expression, or the mouse-derived size as a last
   * resort. */
  protected resolveSolvedDim(result: CommitResult): number | null {
    const num = parseFloat(result.expression);
    if (!isNaN(num) && String(num) === result.expression) {
      return num;
    }
    return SketchTool.resolveCommittedValue(result, this.cachedVariables);
  }

  protected rebuildPreview(): void {
    this.disposePreview();

    const camera = this.ctx.camera;
    const planeNormal = new Vector3(this.plane.normal.x, this.plane.normal.y, this.plane.normal.z);

    if (this.startPoint) {
      addDot(this.previewGroup, this.startPoint, START_POINT_COLOR, camera, planeNormal, this.plane);

      if (this.mousePoint) {
        const { c1, c2 } = this.computePreviewCorners(this.mousePoint);
        addDashedRect(this.previewGroup, c1, c2, this.plane);
      }
    } else if (this.mousePoint && this.lastSnapType !== 'none') {
      const snapColor = this.lastSnapType === 'vertex' ? SNAP_VERTEX_COLOR : SNAP_GRID_COLOR;
      addDot(this.previewGroup, this.mousePoint, snapColor, camera, planeNormal, this.plane, 0.6);
    }

    this.requestRender();
  }
}
