import { Vector3 } from 'three';
import { SketchTool, InsertGeometryFn, FetchVariablesFn } from '../sketch-tool';
import { SceneContext } from '../../scene/scene-context';
import { PlaneData, SceneObjectRender } from '../../types';
import { SnapController } from '../../snapping/snap-controller';
import { SnapManager } from '../../snapping/snap-manager';
import { SnapType } from '../../snapping/types';
import {
  projectToSketch,
  roundPoint,
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

type ExpressionPhase = 'width' | 'height';

export class RectTool extends SketchTool {
  readonly id = 'rect' as const;
  readonly label = 'Rectangle';
  readonly icon = ICON_RECT;

  private startPoint: [number, number] | null = null;
  private mousePoint: [number, number] | null = null;
  private lastSnapType: SnapType = 'none';
  private shiftHeld = false;
  private expressionInput: ExpressionInput;
  private fetchVariables: FetchVariablesFn;
  private cachedVariables: VariableInfo[] = [];
  private lastClientX = 0;
  private lastClientY = 0;

  private expressionPhase: ExpressionPhase = 'width';
  private widthExpression: CommitResult | null = null;
  private lockedWidth: number | null = null;
  private widthIsNumeric = false;

  private boundMouseDown: (e: MouseEvent) => void;
  private boundMouseUp: (e: MouseEvent) => void;
  private boundMouseMove: (e: MouseEvent) => void;
  private boundKeyDown: (e: KeyboardEvent) => void;
  private boundKeyUp: (e: KeyboardEvent) => void;
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
    super(ctx, plane, snapController, insertGeometry);
    this.expressionInput = new ExpressionInput(container);
    this.fetchVariables = fetchVariables;
    this.boundMouseDown = this.handleMouseDown.bind(this);
    this.boundMouseUp = this.handleMouseUp.bind(this);
    this.boundMouseMove = this.handleMouseMove.bind(this);
    this.boundKeyDown = this.handleKeyDown.bind(this);
    this.boundKeyUp = this.handleKeyUp.bind(this);
  }

  activate(): void {
    this.addPreviewToScene();
    this.canvas.addEventListener('mousedown', this.boundMouseDown);
    this.canvas.addEventListener('mouseup', this.boundMouseUp);
    this.canvas.addEventListener('mousemove', this.boundMouseMove);
    window.addEventListener('keydown', this.boundKeyDown);
    window.addEventListener('keyup', this.boundKeyUp);
    this.fetchVariables().then(vars => { this.cachedVariables = vars; });
  }

  deactivate(): void {
    this.canvas.removeEventListener('mousedown', this.boundMouseDown);
    this.canvas.removeEventListener('mouseup', this.boundMouseUp);
    this.canvas.removeEventListener('mousemove', this.boundMouseMove);
    window.removeEventListener('keydown', this.boundKeyDown);
    window.removeEventListener('keyup', this.boundKeyUp);
    this.resetState();
    this.removePreviewFromScene();
  }

  onSceneUpdate(sceneObjects: SceneObjectRender[], sketchId: string): void {
    const snapManager = SnapManager.fromSceneObjects(sceneObjects, sketchId, this.plane);
    this.updateSnapManager(snapManager);
    this.fetchVariables().then(vars => { this.cachedVariables = vars; });
  }

  private resetState(): void {
    this.startPoint = null;
    this.mousePoint = null;
    this.expressionPhase = 'width';
    this.widthExpression = null;
    this.lockedWidth = null;
    this.widthIsNumeric = false;
    this.shiftHeld = false;
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
      this.startPoint = point;
      this.syncModifiers(e);
      this.rebuildPreview();
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
    this.syncModifiers(e);

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
      if (this.startPoint) {
        this.resetState();
        this.rebuildPreview();
      }
      return;
    }
    if (e.key === 'Shift') {
      this.shiftHeld = true;
      this.rebuildPreview();
    }
  }

  private handleKeyUp(e: KeyboardEvent): void {
    if (e.key === 'Shift') {
      this.shiftHeld = false;
      this.rebuildPreview();
    }
  }

  private syncModifiers(e: MouseEvent): void {
    this.shiftHeld = e.shiftKey;
  }

  private computeDimensions(endPoint: [number, number]): { width: number; height: number } {
    const start = this.startPoint!;
    if (this.shiftHeld) {
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
      if (this.shiftHeld) {
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
    if (this.shiftHeld) {
      const dx = endPoint[0] - start[0];
      const dy = endPoint[1] - start[1];
      return {
        c1: [start[0] - dx, start[1] - dy],
        c2: [start[0] + dx, start[1] + dy],
      };
    }
    return { c1: start, c2: endPoint };
  }

  private updateDimensionInput(): void {
    if (!this.startPoint || !this.mousePoint) {
      return;
    }

    const { width, height } = this.computeDimensions(this.mousePoint);

    if (this.expressionPhase === 'width') {
      const absW = Math.round(Math.abs(width) * 100) / 100;
      if (absW <= 0) {
        return;
      }

      if (!this.expressionInput.isVisible) {
        this.expressionInput.show({
          label: 'W',
          value: String(absW),
          clientX: this.lastClientX,
          clientY: this.lastClientY,
          variables: this.cachedVariables,
          onCommit: (result) => this.onWidthCommit(result),
        });
      } else {
        this.expressionInput.updateValue(absW);
        this.expressionInput.updatePosition(this.lastClientX, this.lastClientY);
      }
    } else if (this.expressionPhase === 'height') {
      const absH = Math.round(Math.abs(height) * 100) / 100;

      if (!this.expressionInput.isVisible) {
        this.expressionInput.show({
          label: 'H',
          value: String(absH),
          clientX: this.lastClientX,
          clientY: this.lastClientY,
          variables: this.cachedVariables,
          onCommit: (result) => this.onHeightCommit(result),
        });
      } else {
        this.expressionInput.updateValue(absH);
        this.expressionInput.updatePosition(this.lastClientX, this.lastClientY);
      }
    }
  }

  private onWidthCommit(result: CommitResult): void {
    const num = parseFloat(result.expression);
    const isNumeric = !isNaN(num) && String(num) === result.expression;

    this.widthIsNumeric = isNumeric;
    if (isNumeric) {
      this.widthExpression = result;
      this.lockedWidth = num;
    } else {
      this.widthExpression = result;
      this.lockedWidth = null;
    }

    this.expressionPhase = 'height';

    queueMicrotask(() => {
      if (this.mousePoint && this.startPoint) {
        const { height } = this.computeDimensions(this.mousePoint);
        const absH = Math.round(Math.abs(height) * 100) / 100;

        this.expressionInput.show({
          label: 'H',
          value: String(absH),
          clientX: this.lastClientX,
          clientY: this.lastClientY,
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

    const num = parseFloat(result.expression);
    const isNumeric = !isNaN(num) && String(num) === result.expression;

    const widthResult = this.resolveSignedDim(this.widthExpression, this.widthIsNumeric, this.lockedWidth, 0);

    let heightResult: CommitResult;
    if (isNumeric && this.mousePoint && !this.shiftHeld) {
      const ySign = (this.mousePoint[1] >= this.startPoint[1]) ? 1 : -1;
      heightResult = { expression: String(Math.round(ySign * num * 100) / 100), newVariable: result.newVariable };
    } else {
      heightResult = result;
    }

    this.commitRect(this.startPoint, widthResult, heightResult);
    this.expressionInput.hide();
    this.startPoint = null;
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
      this.startPoint,
      { expression: String(width) },
      { expression: String(height) },
    );
    this.expressionInput.hide();
    this.startPoint = null;
    this.expressionPhase = 'width';
    this.widthExpression = null;
    this.lockedWidth = null;
    this.widthIsNumeric = false;
    this.rebuildPreview();
  }

  private resolveSignedDim(expr: CommitResult, isNumeric: boolean, absValue: number | null, axis: 0 | 1): CommitResult {
    if (!isNumeric || absValue === null || !this.mousePoint || !this.startPoint || this.shiftHeld) {
      return expr;
    }
    const sign = axis === 0
      ? ((this.mousePoint[0] >= this.startPoint[0]) ? 1 : -1)
      : ((this.mousePoint[1] >= this.startPoint[1]) ? 1 : -1);
    return { expression: String(Math.round(sign * absValue * 100) / 100), newVariable: expr.newVariable };
  }

  protected commitRect(
    start: [number, number],
    widthResult: CommitResult,
    heightResult: CommitResult,
  ): void {
    const atCurrent = this.isAtCurrentPosition(start);
    let statement: string;
    if (atCurrent) {
      statement = `rect(${widthResult.expression}, ${heightResult.expression})`;
    } else {
      statement = `rect(${this.formatPoint(start)}, ${widthResult.expression}, ${heightResult.expression})`;
    }
    if (this.shiftHeld) {
      statement += '.centered()';
    }

    const newVariable = widthResult.newVariable ?? heightResult.newVariable;
    this.insertGeometry(statement, newVariable);
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
