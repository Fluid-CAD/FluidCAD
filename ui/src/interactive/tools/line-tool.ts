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
import { ICON_LINE } from '../../ui/icons';
import { ExpressionInput, VariableInfo, CommitResult } from '../../ui/expression-input';
import {
  START_POINT_COLOR,
  SNAP_VERTEX_COLOR,
  SNAP_GRID_COLOR,
  addDot,
  addDashedLine,
} from './tool-preview-utils';

export class LineTool extends SketchTool {
  readonly id = 'line' as const;
  readonly label = 'Line';
  readonly icon = ICON_LINE;

  private startPoint: [number, number] | null = null;
  private mousePoint: [number, number] | null = null;
  private lastSnapType: SnapType = 'none';
  private shiftHeld = false;
  private expressionInput: ExpressionInput;
  private fetchVariables: FetchVariablesFn;
  private cachedVariables: VariableInfo[] = [];
  private lastClientX = 0;
  private lastClientY = 0;

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
    this.startPoint = null;
    this.mousePoint = null;
    this.shiftHeld = false;
    this.expressionInput.hide();
    this.removePreviewFromScene();
  }

  onSceneUpdate(sceneObjects: SceneObjectRender[], sketchId: string): void {
    const snapManager = SnapManager.fromSceneObjects(sceneObjects, sketchId, this.plane);
    this.updateSnapManager(snapManager);
    this.fetchVariables().then(vars => { this.cachedVariables = vars; });
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
      this.rebuildPreview();
      return;
    }

    if (this.shiftHeld && this.expressionInput.isVisible) {
      this.expressionInput.commitCurrentValue();
    } else {
      this.commitLine(this.startPoint, point);
    }
    this.expressionInput.hide();
    this.startPoint = null;
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
    if (e.key === 'Shift') {
      this.shiftHeld = true;
      this.rebuildPreview();
      this.updateDimensionInput();
    }
    if (e.key === 'Escape') {
      if (this.startPoint) {
        this.startPoint = null;
        this.expressionInput.hide();
        this.rebuildPreview();
      }
    }
  }

  private handleKeyUp(e: KeyboardEvent): void {
    if (e.key === 'Shift') {
      this.shiftHeld = false;
      this.expressionInput.hide();
      this.rebuildPreview();
    }
  }

  private getEffectiveEndPoint(): [number, number] | null {
    if (!this.startPoint || !this.mousePoint) {
      return null;
    }

    if (this.shiftHeld) {
      const dx = this.mousePoint[0] - this.startPoint[0];
      const dy = this.mousePoint[1] - this.startPoint[1];
      if (Math.abs(dx) >= Math.abs(dy)) {
        return [this.mousePoint[0], this.startPoint[1]];
      } else {
        return [this.startPoint[0], this.mousePoint[1]];
      }
    }

    return this.mousePoint;
  }

  private updateDimensionInput(): void {
    if (!this.startPoint || !this.mousePoint || !this.shiftHeld) {
      this.expressionInput.hide();
      return;
    }

    const dx = this.mousePoint[0] - this.startPoint[0];
    const dy = this.mousePoint[1] - this.startPoint[1];
    const isHorizontal = Math.abs(dx) >= Math.abs(dy);
    const distance = Math.abs(isHorizontal ? dx : dy);

    if (!this.expressionInput.isVisible) {
      this.expressionInput.show({
        label: isHorizontal ? 'H:' : 'V:',
        value: String(Math.round(distance * 100) / 100),
        clientX: this.lastClientX,
        clientY: this.lastClientY,
        variables: this.cachedVariables,
        onCommit: (result) => this.commitWithDimension(result),
      });
    } else {
      this.expressionInput.updateValue(distance);
      this.expressionInput.updatePosition(this.lastClientX, this.lastClientY);
    }
  }

  private commitWithDimension(result: CommitResult): void {
    if (!this.startPoint || !this.mousePoint) {
      return;
    }
    const { expression, newVariable } = result;
    const roundedStart = roundPoint(this.startPoint);
    const atCurrent = this.isAtCurrentPosition(roundedStart);
    const dx = this.mousePoint[0] - this.startPoint[0];
    const dy = this.mousePoint[1] - this.startPoint[1];
    const isHorizontal = Math.abs(dx) >= Math.abs(dy);
    const sign = isHorizontal ? Math.sign(dx) : Math.sign(dy);

    const num = parseFloat(expression);
    const dimExpr = !isNaN(num) && String(num) === expression
      ? String(Math.round(sign * num * 100) / 100)
      : expression;

    const fn = isHorizontal ? 'hLine' : 'vLine';
    const statement = atCurrent
      ? `${fn}(${dimExpr})`
      : `${fn}(${this.formatPoint(roundedStart)}, ${dimExpr})`;
    this.insertGeometry(statement, newVariable);

    this.expressionInput.hide();
    this.startPoint = null;
    this.rebuildPreview();
  }

  private commitLine(start: [number, number], end: [number, number]): void {
    const roundedStart = roundPoint(start);
    const roundedEnd = roundPoint(end);
    const atCurrent = this.isAtCurrentPosition(roundedStart);

    if (this.shiftHeld) {
      const dx = roundedEnd[0] - roundedStart[0];
      const dy = roundedEnd[1] - roundedStart[1];
      const isHorizontal = Math.abs(dx) >= Math.abs(dy);
      const distance = isHorizontal ? roundPoint([dx, 0])[0] : roundPoint([0, dy])[1];

      if (isHorizontal) {
        if (atCurrent) {
          this.insertGeometry(`hLine(${distance})`);
        } else {
          this.insertGeometry(`hLine(${this.formatPoint(roundedStart)}, ${distance})`);
        }
      } else {
        if (atCurrent) {
          this.insertGeometry(`vLine(${distance})`);
        } else {
          this.insertGeometry(`vLine(${this.formatPoint(roundedStart)}, ${distance})`);
        }
      }
      return;
    }

    if (atCurrent) {
      this.insertGeometry(`line(${this.formatPoint(roundedEnd)})`);
    } else {
      this.insertGeometry(`line(${this.formatPoint(roundedStart)}, ${this.formatPoint(roundedEnd)})`);
    }
  }

  private rebuildPreview(): void {
    this.disposePreview();

    const camera = this.ctx.camera;
    const planeNormal = new Vector3(this.plane.normal.x, this.plane.normal.y, this.plane.normal.z);

    if (this.startPoint) {
      addDot(this.previewGroup, this.startPoint, START_POINT_COLOR, camera, planeNormal, this.plane);

      const endPoint = this.getEffectiveEndPoint();
      if (endPoint) {
        addDashedLine(this.previewGroup, this.startPoint, endPoint, this.plane);

        if (this.lastSnapType !== 'none') {
          const snapColor = this.lastSnapType === 'vertex' ? SNAP_VERTEX_COLOR : SNAP_GRID_COLOR;
          addDot(this.previewGroup, endPoint, snapColor, camera, planeNormal, this.plane, 0.6);
        }
      }
    } else if (this.mousePoint && this.lastSnapType !== 'none') {
      const snapColor = this.lastSnapType === 'vertex' ? SNAP_VERTEX_COLOR : SNAP_GRID_COLOR;
      addDot(this.previewGroup, this.mousePoint, snapColor, camera, planeNormal, this.plane, 0.6);
    }

    this.requestRender();
  }
}
