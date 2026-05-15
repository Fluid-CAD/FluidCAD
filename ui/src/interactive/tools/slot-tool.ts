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
  dist2D,
} from '../sketch-plane-utils';
import { ICON_SLOT } from '../../ui/icons';
import { ExpressionInput, VariableInfo, CommitResult } from '../../ui/expression-input';
import {
  START_POINT_COLOR,
  SNAP_VERTEX_COLOR,
  SNAP_GRID_COLOR,
  addDot,
  addDashedSlot,
  addDashedLine,
} from './tool-preview-utils';

type ExpressionPhase = 'endpoint' | 'distance' | 'radius';

export class SlotTool extends SketchTool {
  readonly id = 'slot' as const;
  readonly label = 'Slot';
  readonly icon = ICON_SLOT;

  private startPoint: [number, number] | null = null;
  private endPoint: [number, number] | null = null;
  private mousePoint: [number, number] | null = null;
  private lastSnapType: SnapType = 'none';
  private shiftHeld = false;
  private horizontalMode = false;
  private expressionInput: ExpressionInput;
  private fetchVariables: FetchVariablesFn;
  private cachedVariables: VariableInfo[] = [];
  private lastClientX = 0;
  private lastClientY = 0;

  private expressionPhase: ExpressionPhase = 'endpoint';
  private distanceExpression: CommitResult | null = null;
  private lockedDistance: number | null = null;

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

  override handleEscape(): boolean {
    if (!this.startPoint) {
      return false;
    }
    if (this.expressionPhase === 'radius') {
      this.expressionPhase = this.horizontalMode ? 'distance' : 'endpoint';
      this.endPoint = null;
      this.distanceExpression = null;
      this.lockedDistance = null;
      this.expressionInput.hide();
      this.rebuildPreview();
      return true;
    }
    if (this.expressionPhase === 'distance') {
      this.expressionPhase = 'endpoint';
      this.horizontalMode = false;
      this.expressionInput.hide();
      this.rebuildPreview();
      return true;
    }
    this.resetState();
    this.rebuildPreview();
    return true;
  }

  private resetState(): void {
    this.startPoint = null;
    this.endPoint = null;
    this.mousePoint = null;
    this.expressionPhase = 'endpoint';
    this.horizontalMode = false;
    this.distanceExpression = null;
    this.lockedDistance = null;
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
      if (this.shiftHeld) {
        this.horizontalMode = true;
        this.expressionPhase = 'distance';
      }
      this.rebuildPreview();
      return;
    }

    if (this.expressionInput.isVisible) {
      this.expressionInput.commitCurrentValue();
      return;
    }

    if (this.expressionPhase === 'endpoint') {
      const distance = dist2D(this.startPoint, point);
      if (distance <= 0) {
        return;
      }
      this.endPoint = point;
      this.expressionPhase = 'radius';
      this.expressionInput.hide();
      this.rebuildPreview();
      this.updateDimensionInput();
      return;
    }

    if (this.expressionPhase === 'distance') {
      const distance = Math.round((point[0] - this.startPoint[0]) * 100) / 100;
      if (distance === 0) {
        return;
      }
      this.onDistanceCommit({ expression: String(distance) });
      return;
    }

    if (this.expressionPhase === 'radius') {
      const radius = this.computeRadiusFromMouse(point);
      if (radius <= 0) {
        return;
      }
      this.onRadiusCommit({ expression: String(radius) });
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
      if (this.handleEscape()) {
        e.stopPropagation();
      }
      return;
    }
    if (e.key === 'Shift') {
      this.shiftHeld = true;
      if (this.startPoint && this.expressionPhase === 'endpoint' && !this.horizontalMode) {
        this.horizontalMode = true;
        this.expressionPhase = 'distance';
        this.expressionInput.hide();
      }
      this.rebuildPreview();
      this.updateDimensionInput();
    }
  }

  private handleKeyUp(e: KeyboardEvent): void {
    if (e.key === 'Shift') {
      this.shiftHeld = false;
      if (this.expressionPhase === 'distance' && !this.distanceExpression) {
        this.horizontalMode = false;
        this.expressionPhase = 'endpoint';
        this.expressionInput.hide();
      }
      this.rebuildPreview();
      this.updateDimensionInput();
    }
  }

  private syncModifiers(e: MouseEvent): void {
    this.shiftHeld = e.shiftKey;
  }

  private getSlotAxis(): { dir: [number, number]; leftCenter: [number, number]; rightCenter: [number, number] } | null {
    if (!this.startPoint) {
      return null;
    }

    if (this.horizontalMode) {
      const d = this.lockedDistance ?? (this.mousePoint ? (this.mousePoint[0] - this.startPoint[0]) : 0);
      return {
        dir: d >= 0 ? [1, 0] : [-1, 0],
        leftCenter: this.startPoint,
        rightCenter: [this.startPoint[0] + d, this.startPoint[1]],
      };
    }

    if (this.endPoint) {
      const dx = this.endPoint[0] - this.startPoint[0];
      const dy = this.endPoint[1] - this.startPoint[1];
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (dist < 1e-10) {
        return null;
      }
      return {
        dir: [dx / dist, dy / dist],
        leftCenter: this.startPoint,
        rightCenter: this.endPoint,
      };
    }

    if (this.mousePoint) {
      const dx = this.mousePoint[0] - this.startPoint[0];
      const dy = this.mousePoint[1] - this.startPoint[1];
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (dist < 1e-10) {
        return null;
      }
      return {
        dir: [dx / dist, dy / dist],
        leftCenter: this.startPoint,
        rightCenter: this.mousePoint,
      };
    }

    return null;
  }

  private computeRadiusFromMouse(point: [number, number]): number {
    const axis = this.getSlotAxis();
    if (!axis) {
      return 0;
    }
    const dx = point[0] - axis.leftCenter[0];
    const dy = point[1] - axis.leftCenter[1];
    const perpDist = Math.abs(-axis.dir[1] * dx + axis.dir[0] * dy);
    return Math.round(perpDist * 100) / 100;
  }

  private updateDimensionInput(): void {
    if (!this.startPoint || !this.mousePoint) {
      return;
    }

    if (this.expressionPhase === 'distance') {
      const distance = Math.round((this.mousePoint[0] - this.startPoint[0]) * 100) / 100;
      if (distance === 0) {
        return;
      }
      if (!this.expressionInput.isVisible) {
        this.expressionInput.show({
          label: 'D',
          value: String(distance),
          clientX: this.lastClientX,
          clientY: this.lastClientY,
          variables: this.cachedVariables,
          onCommit: (result) => this.onDistanceCommit(result),
        });
      } else {
        this.expressionInput.updateValue(distance);
        this.expressionInput.updatePosition(this.lastClientX, this.lastClientY);
      }
      return;
    }

    if (this.expressionPhase === 'radius') {
      const radius = this.computeRadiusFromMouse(this.mousePoint);
      if (radius <= 0) {
        return;
      }
      if (!this.expressionInput.isVisible) {
        this.expressionInput.show({
          label: 'R',
          value: String(radius),
          clientX: this.lastClientX,
          clientY: this.lastClientY,
          variables: this.cachedVariables,
          onCommit: (result) => this.onRadiusCommit(result),
        });
      } else {
        this.expressionInput.updateValue(radius);
        this.expressionInput.updatePosition(this.lastClientX, this.lastClientY);
      }
    }
  }

  private onDistanceCommit(result: CommitResult): void {
    const num = parseFloat(result.expression);
    const isNumeric = !isNaN(num) && String(num) === result.expression;

    this.distanceExpression = result;
    this.lockedDistance = isNumeric ? num : null;
    this.expressionPhase = 'radius';

    queueMicrotask(() => {
      if (this.mousePoint) {
        const radius = this.computeRadiusFromMouse(this.mousePoint);
        this.expressionInput.show({
          label: 'R',
          value: String(radius),
          clientX: this.lastClientX,
          clientY: this.lastClientY,
          variables: this.cachedVariables,
          onCommit: (r) => this.onRadiusCommit(r),
        });
      }
      this.rebuildPreview();
    });
  }

  private onRadiusCommit(result: CommitResult): void {
    if (!this.startPoint) {
      return;
    }

    if (this.horizontalMode && this.distanceExpression) {
      this.commitHorizontalSlot(this.startPoint, this.distanceExpression, result);
    } else if (this.endPoint) {
      this.commitTwoPointSlot(this.startPoint, this.endPoint, result);
    }

    this.resetState();
    this.rebuildPreview();
  }

  private commitTwoPointSlot(
    start: [number, number],
    end: [number, number],
    radiusResult: CommitResult,
  ): void {
    const statement = `slot(${this.formatPoint(start)}, ${this.formatPoint(end)}, ${radiusResult.expression})`;
    this.insertGeometry(statement, radiusResult.newVariable);
  }

  private commitHorizontalSlot(
    start: [number, number],
    distanceResult: CommitResult,
    radiusResult: CommitResult,
  ): void {
    const atCurrent = this.isAtCurrentPosition(start);
    const statement = atCurrent
      ? `slot(${distanceResult.expression}, ${radiusResult.expression})`
      : `slot(${this.formatPoint(start)}, ${distanceResult.expression}, ${radiusResult.expression})`;

    const newVariable = distanceResult.newVariable ?? radiusResult.newVariable;
    this.insertGeometry(statement, newVariable);
  }

  private rebuildPreview(): void {
    this.disposePreview();

    const camera = this.ctx.camera;
    const planeNormal = new Vector3(this.plane.normal.x, this.plane.normal.y, this.plane.normal.z);

    if (this.startPoint) {
      addDot(this.previewGroup, this.startPoint, START_POINT_COLOR, camera, planeNormal, this.plane);

      const axis = this.getSlotAxis();
      if (axis) {
        const distance = dist2D(axis.leftCenter, axis.rightCenter);
        if (distance > 0) {
          if (this.expressionPhase === 'radius' && this.mousePoint) {
            const radius = this.computeRadiusFromMouse(this.mousePoint);
            if (radius > 0) {
              addDashedSlot(this.previewGroup, axis.leftCenter, axis.rightCenter, radius, this.plane);
            } else {
              addDashedLine(this.previewGroup, axis.leftCenter, axis.rightCenter, this.plane);
            }
            addDot(this.previewGroup, axis.rightCenter, START_POINT_COLOR, camera, planeNormal, this.plane);
          } else {
            addDashedSlot(this.previewGroup, axis.leftCenter, axis.rightCenter, distance / 6, this.plane);
            addDot(this.previewGroup, axis.rightCenter, SNAP_VERTEX_COLOR, camera, planeNormal, this.plane);
          }
        }
      }
    } else if (this.mousePoint && this.lastSnapType !== 'none') {
      const snapColor = this.lastSnapType === 'vertex' ? SNAP_VERTEX_COLOR : SNAP_GRID_COLOR;
      addDot(this.previewGroup, this.mousePoint, snapColor, camera, planeNormal, this.plane, 0.6);
    }

    this.requestRender();
  }
}
