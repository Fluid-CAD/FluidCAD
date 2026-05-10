import {
  BufferAttribute,
  BufferGeometry,
  Camera,
  CircleGeometry,
  DoubleSide,
  Group,
  Line,
  LineDashedMaterial,
  Mesh,
  MeshBasicMaterial,
  OrthographicCamera,
  PerspectiveCamera,
  Vector3,
} from 'three';
import { SketchTool, InsertGeometryFn, FetchVariablesFn } from '../sketch-tool';
import { SceneContext } from '../../scene/scene-context';
import { PlaneData, SceneObjectRender } from '../../types';
import { SnapController } from '../../snapping/snap-controller';
import { SnapManager } from '../../snapping/snap-manager';
import { SnapType } from '../../snapping/types';
import {
  projectToSketch,
  localToWorld,
  roundPoint,
} from '../sketch-plane-utils';
import { ICON_LINE } from '../../ui/icons';
import { ExpressionInput, VariableInfo } from '../../ui/expression-input';

const START_POINT_COLOR = 0x22cc66;
const GUIDE_COLOR = 0xb0b0b0;
const SNAP_VERTEX_COLOR = 0xffc578;
const SNAP_GRID_COLOR = 0x888888;
const DOT_RADIUS = 2.5;
const DOT_SEGMENTS = 16;
const SCALE_FACTOR = 0.003;
const MAX_SCALE = 1.5;

function computeViewScale(camera: Camera, position: Vector3, factor: number): number {
  if (camera instanceof OrthographicCamera) {
    const viewHeight = (camera.top - camera.bottom) / camera.zoom;
    return viewHeight * factor;
  } else if (camera instanceof PerspectiveCamera) {
    const dist = camera.position.distanceTo(position);
    const vFov = camera.fov * Math.PI / 180;
    const viewHeight = 2 * dist * Math.tan(vFov / 2);
    return viewHeight * factor;
  }
  return 1;
}

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
        onCommit: (expression) => this.commitWithDimension(expression),
      });
    } else {
      this.expressionInput.updateValue(distance);
      this.expressionInput.updatePosition(this.lastClientX, this.lastClientY);
    }
  }

  private commitWithDimension(expression: string): void {
    if (!this.startPoint || !this.mousePoint) {
      return;
    }
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

    if (isHorizontal) {
      if (atCurrent) {
        this.insertGeometry(`hLine(${dimExpr})`);
      } else {
        this.insertGeometry(`hLine(${this.formatPoint(roundedStart)}, ${dimExpr})`);
      }
    } else {
      if (atCurrent) {
        this.insertGeometry(`vLine(${dimExpr})`);
      } else {
        this.insertGeometry(`vLine(${this.formatPoint(roundedStart)}, ${dimExpr})`);
      }
    }
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
      this.addDot(this.startPoint, START_POINT_COLOR, camera, planeNormal);

      const endPoint = this.getEffectiveEndPoint();
      if (endPoint) {
        this.addDashedLine(this.startPoint, endPoint);

        if (this.lastSnapType !== 'none') {
          const snapColor = this.lastSnapType === 'vertex' ? SNAP_VERTEX_COLOR : SNAP_GRID_COLOR;
          this.addDot(endPoint, snapColor, camera, planeNormal, 0.6);
        }
      }
    } else if (this.mousePoint && this.lastSnapType !== 'none') {
      const snapColor = this.lastSnapType === 'vertex' ? SNAP_VERTEX_COLOR : SNAP_GRID_COLOR;
      this.addDot(this.mousePoint, snapColor, camera, planeNormal, 0.6);
    }

    this.requestRender();
  }

  private addDot(
    point2d: [number, number],
    color: number,
    camera: Camera,
    planeNormal: Vector3,
    opacity = 1,
  ): void {
    const geo = new CircleGeometry(DOT_RADIUS, DOT_SEGMENTS);
    const mat = new MeshBasicMaterial({
      color,
      side: DoubleSide,
      depthTest: false,
      transparent: opacity < 1,
      opacity,
    });
    const dot = new Mesh(geo, mat);
    dot.renderOrder = 4;

    const group = new Group();
    group.renderOrder = 4;
    const pos = localToWorld(point2d, this.plane);
    group.position.copy(pos);
    group.lookAt(pos.clone().add(planeNormal));
    group.scale.setScalar(Math.min(computeViewScale(camera, pos, SCALE_FACTOR), MAX_SCALE));

    dot.onBeforeRender = (_r, _s, cam) => {
      group.scale.setScalar(Math.min(computeViewScale(cam, pos, SCALE_FACTOR), MAX_SCALE));
      group.updateMatrixWorld(true);
    };

    group.add(dot);
    this.previewGroup.add(group);
  }

  private addDashedLine(from: [number, number], to: [number, number]): void {
    const worldFrom = localToWorld(from, this.plane);
    const worldTo = localToWorld(to, this.plane);

    const verts = new Float32Array(6);
    verts[0] = worldFrom.x; verts[1] = worldFrom.y; verts[2] = worldFrom.z;
    verts[3] = worldTo.x; verts[4] = worldTo.y; verts[5] = worldTo.z;

    const geo = new BufferGeometry();
    geo.setAttribute('position', new BufferAttribute(verts, 3));

    const mat = new LineDashedMaterial({
      color: GUIDE_COLOR,
      dashSize: 3,
      gapSize: 2,
      depthTest: false,
    });

    const line = new Line(geo, mat);
    line.computeLineDistances();
    line.renderOrder = 3;
    this.previewGroup.add(line);
  }
}
