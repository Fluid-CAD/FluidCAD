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
import { ICON_THREE_POINT_ARC } from '../../ui/icons';
import { ExpressionInput, VariableInfo, CommitResult } from '../../ui/expression-input';
import {
  START_POINT_COLOR,
  SNAP_VERTEX_COLOR,
  SNAP_GRID_COLOR,
  addDot,
  addDashedLine,
  addDashedArc,
  circumcenter,
  angleFromCenter,
  centerFromChordAndRadius,
} from './tool-preview-utils';

const enum State {
  IDLE,
  START_PLACED,
  END_PLACED,
}

export class ThreePointArcTool extends SketchTool {
  readonly id = 'arc3' as const;
  readonly label = '3-Point Arc';
  readonly icon = ICON_THREE_POINT_ARC;

  private state: State = State.IDLE;
  private startPoint: [number, number] | null = null;
  private endPoint: [number, number] | null = null;
  private mousePoint: [number, number] | null = null;
  private lastSnapType: SnapType = 'none';
  private expressionInput: ExpressionInput;
  private fetchVariables: FetchVariablesFn;
  private cachedVariables: VariableInfo[] = [];
  private lastClientX = 0;
  private lastClientY = 0;
  private lastCCW = true;
  private lastCenterOnLeft = true;

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
    super(ctx, plane, snapController, insertGeometry);
    this.expressionInput = new ExpressionInput(container);
    this.fetchVariables = fetchVariables;
    this.boundMouseDown = this.handleMouseDown.bind(this);
    this.boundMouseUp = this.handleMouseUp.bind(this);
    this.boundMouseMove = this.handleMouseMove.bind(this);
    this.boundKeyDown = this.handleKeyDown.bind(this);
  }

  activate(): void {
    this.addPreviewToScene();
    this.canvas.addEventListener('mousedown', this.boundMouseDown);
    this.canvas.addEventListener('mouseup', this.boundMouseUp);
    this.canvas.addEventListener('mousemove', this.boundMouseMove);
    window.addEventListener('keydown', this.boundKeyDown);
    this.fetchVariables().then(vars => { this.cachedVariables = vars; });
  }

  deactivate(): void {
    this.canvas.removeEventListener('mousedown', this.boundMouseDown);
    this.canvas.removeEventListener('mouseup', this.boundMouseUp);
    this.canvas.removeEventListener('mousemove', this.boundMouseMove);
    window.removeEventListener('keydown', this.boundKeyDown);
    this.resetState();
    this.expressionInput.hide();
    this.removePreviewFromScene();
  }

  onSceneUpdate(sceneObjects: SceneObjectRender[], sketchId: string): void {
    const snapManager = SnapManager.fromSceneObjects(sceneObjects, sketchId, this.plane);
    this.updateSnapManager(snapManager);
    this.fetchVariables().then(vars => { this.cachedVariables = vars; });
  }

  private resetState(): void {
    this.state = State.IDLE;
    this.startPoint = null;
    this.endPoint = null;
    this.mousePoint = null;
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

    if (this.state === State.IDLE) {
      this.startPoint = point;
      this.state = State.START_PLACED;
      this.rebuildPreview();
      return;
    }

    if (this.state === State.START_PLACED) {
      if (dist2D(this.startPoint!, point) <= 0) {
        return;
      }
      this.endPoint = point;
      this.state = State.END_PLACED;
      this.rebuildPreview();
      return;
    }

    if (this.state === State.END_PLACED) {
      if (this.expressionInput.isVisible) {
        this.expressionInput.commitCurrentValue();
      } else {
        this.commitFromMouse();
      }
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
    if (this.state === State.END_PLACED) {
      this.updateDimensionInput();
    }
  }

  private handleKeyDown(e: KeyboardEvent): void {
    if (e.key === 'Escape') {
      if (this.state === State.END_PLACED) {
        this.endPoint = null;
        this.state = State.START_PLACED;
        this.expressionInput.hide();
      } else if (this.state === State.START_PLACED) {
        this.startPoint = null;
        this.state = State.IDLE;
      }
      this.rebuildPreview();
    }
  }

  private computeCenter(): [number, number] | null {
    if (!this.startPoint || !this.endPoint || !this.mousePoint) {
      return null;
    }
    return circumcenter(this.startPoint, this.endPoint, this.mousePoint);
  }

  private isMouseCCW(): boolean {
    if (!this.startPoint || !this.endPoint || !this.mousePoint) {
      return true;
    }
    const center = this.computeCenter();
    if (!center) {
      return true;
    }
    const startAngle = angleFromCenter(center, this.startPoint);
    const endAngle = angleFromCenter(center, this.endPoint);
    const mouseAngle = angleFromCenter(center, this.mousePoint);
    let startToMouse = mouseAngle - startAngle;
    if (startToMouse < 0) {
      startToMouse += Math.PI * 2;
    }
    let startToEnd = endAngle - startAngle;
    if (startToEnd < 0) {
      startToEnd += Math.PI * 2;
    }
    return startToMouse < startToEnd;
  }

  private updateDimensionInput(): void {
    const center = this.computeCenter();
    if (!center || !this.startPoint) {
      return;
    }

    const radius = Math.round(dist2D(center, this.startPoint) * 100) / 100;
    if (radius <= 0) {
      return;
    }

    this.lastCCW = this.isMouseCCW();
    const dx = this.endPoint![0] - this.startPoint![0];
    const dy = this.endPoint![1] - this.startPoint![1];
    const cx = center[0] - this.startPoint![0];
    const cy = center[1] - this.startPoint![1];
    this.lastCenterOnLeft = (dx * cy - dy * cx) > 0;

    if (!this.expressionInput.isVisible) {
      this.expressionInput.show({
        label: 'R',
        value: String(radius),
        clientX: this.lastClientX,
        clientY: this.lastClientY,
        variables: this.cachedVariables,
        numericOnly: true,
        onCommit: (result) => this.commitFromExpression(result),
      });
    } else {
      this.expressionInput.updateValue(radius);
      this.expressionInput.updatePosition(this.lastClientX, this.lastClientY);
    }
  }

  private commitFromMouse(): void {
    if (!this.startPoint || !this.endPoint) {
      return;
    }
    const center = this.computeCenter();
    if (!center) {
      return;
    }
    this.emitArc(this.startPoint, this.endPoint, center, this.isMouseCCW());
  }

  private commitFromExpression(result: CommitResult): void {
    if (!this.startPoint || !this.endPoint) {
      return;
    }
    const { expression, newVariable } = result;
    const num = parseFloat(expression);
    if (isNaN(num) || num <= 0) {
      return;
    }
    const center = centerFromChordAndRadius(this.startPoint, this.endPoint, num, this.lastCenterOnLeft);
    if (!center) {
      return;
    }
    this.emitArc(this.startPoint, this.endPoint, center, this.lastCCW, newVariable);
  }

  private emitArc(
    start: [number, number],
    end: [number, number],
    center: [number, number],
    ccw: boolean,
    newVariable?: { name: string; initializer: string },
  ): void {
    const [first, second] = ccw ? [start, end] : [end, start];
    const rs = roundPoint(first);
    const re = roundPoint(second);
    const rc = roundPoint(center);
    const statement = this.isAtCurrentPosition(rs)
      ? `arc(${this.formatPoint(re)}).center(${this.formatPoint(rc)})`
      : `arc(${this.formatPoint(rs)}, ${this.formatPoint(re)}).center(${this.formatPoint(rc)})`;
    this.insertGeometry(statement, newVariable);
    this.expressionInput.hide();
    this.resetState();
    this.rebuildPreview();
  }

  private rebuildPreview(): void {
    this.disposePreview();

    const camera = this.ctx.camera;
    const planeNormal = new Vector3(this.plane.normal.x, this.plane.normal.y, this.plane.normal.z);

    if (this.state === State.IDLE) {
      if (this.mousePoint && this.lastSnapType !== 'none') {
        const color = this.lastSnapType === 'vertex' ? SNAP_VERTEX_COLOR : SNAP_GRID_COLOR;
        addDot(this.previewGroup, this.mousePoint, color, camera, planeNormal, this.plane, 0.6);
      }
    } else if (this.state === State.START_PLACED) {
      addDot(this.previewGroup, this.startPoint!, START_POINT_COLOR, camera, planeNormal, this.plane);
      if (this.mousePoint && this.lastSnapType !== 'none') {
        const color = this.lastSnapType === 'vertex' ? SNAP_VERTEX_COLOR : SNAP_GRID_COLOR;
        addDot(this.previewGroup, this.mousePoint, color, camera, planeNormal, this.plane, 0.6);
      }
    } else if (this.state === State.END_PLACED && this.startPoint && this.endPoint) {
      addDot(this.previewGroup, this.startPoint, START_POINT_COLOR, camera, planeNormal, this.plane);
      addDot(this.previewGroup, this.endPoint, START_POINT_COLOR, camera, planeNormal, this.plane);

      addDashedLine(this.previewGroup, this.startPoint, this.endPoint, this.plane);

      if (this.mousePoint) {
        const center = this.computeCenter();
        if (center) {
          const radius = dist2D(center, this.startPoint);
          const startAngle = angleFromCenter(center, this.startPoint);
          const endAngle = angleFromCenter(center, this.endPoint);
          const ccw = this.isMouseCCW();
          addDashedArc(this.previewGroup, center, radius, startAngle, endAngle, ccw, this.plane);
        }

        if (this.lastSnapType !== 'none') {
          const color = this.lastSnapType === 'vertex' ? SNAP_VERTEX_COLOR : SNAP_GRID_COLOR;
          addDot(this.previewGroup, this.mousePoint, color, camera, planeNormal, this.plane, 0.6);
        }
      }
    }

    this.requestRender();
  }
}
