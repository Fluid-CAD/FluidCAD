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
import { SketchTool, InsertGeometryFn } from '../sketch-tool';
import { SceneContext } from '../../scene/scene-context';
import { PlaneData, SceneObjectRender } from '../../types';
import { SnapController } from '../../snapping/snap-controller';
import { SnapManager } from '../../snapping/snap-manager';
import { SnapType } from '../../snapping/types';
import {
  projectToSketch,
  localToWorld,
  roundPoint,
  dist2D,
} from '../sketch-plane-utils';
import { ICON_CIRCLE } from '../../ui/icons';
import { DimensionInput } from '../../ui/dimension-input';

const START_POINT_COLOR = 0x22cc66;
const GUIDE_COLOR = 0xb0b0b0;
const SNAP_VERTEX_COLOR = 0xffc578;
const SNAP_GRID_COLOR = 0x888888;
const DOT_RADIUS = 2.5;
const DOT_SEGMENTS = 16;
const CIRCLE_SEGMENTS = 64;
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

export class CircleTool extends SketchTool {
  readonly id = 'circle' as const;
  readonly label = 'Circle';
  readonly icon = ICON_CIRCLE;

  private centerPoint: [number, number] | null = null;
  private mousePoint: [number, number] | null = null;
  private lastSnapType: SnapType = 'none';
  private dimensionInput: DimensionInput;
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
  ) {
    super(ctx, plane, snapController, insertGeometry);
    this.dimensionInput = new DimensionInput(container);
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
  }

  deactivate(): void {
    this.canvas.removeEventListener('mousedown', this.boundMouseDown);
    this.canvas.removeEventListener('mouseup', this.boundMouseUp);
    this.canvas.removeEventListener('mousemove', this.boundMouseMove);
    window.removeEventListener('keydown', this.boundKeyDown);
    this.centerPoint = null;
    this.mousePoint = null;
    this.dimensionInput.hide();
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

    if (!this.centerPoint) {
      this.centerPoint = point;
      this.rebuildPreview();
      return;
    }

    if (this.dimensionInput.isVisible) {
      this.dimensionInput.commitCurrentValue();
    } else {
      const diameter = Math.round(dist2D(this.centerPoint, point) * 2 * 100) / 100;
      if (diameter <= 0) {
        return;
      }
      this.commitCircle(this.centerPoint, diameter);
    }
    this.dimensionInput.hide();
    this.centerPoint = null;
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
      if (this.centerPoint) {
        this.centerPoint = null;
        this.dimensionInput.hide();
        this.rebuildPreview();
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

    if (!this.dimensionInput.isVisible) {
      this.dimensionInput.show(
        '⌀',
        diameter,
        this.lastClientX,
        this.lastClientY,
        (value) => {
          if (this.centerPoint) {
            this.commitCircle(this.centerPoint, Math.round(value * 100) / 100);
            this.dimensionInput.hide();
            this.centerPoint = null;
            this.rebuildPreview();
          }
        },
      );
    } else {
      this.dimensionInput.updateValue(diameter);
      this.dimensionInput.updatePosition(this.lastClientX, this.lastClientY);
    }
  }

  private commitCircle(center: [number, number], diameter: number): void {
    const atCurrent = this.isAtCurrentPosition(center);
    if (atCurrent) {
      this.insertGeometry(`circle(${diameter})`);
    } else {
      this.insertGeometry(`circle(${this.formatPoint(center)}, ${diameter})`);
    }
  }

  private rebuildPreview(): void {
    this.disposePreview();

    const camera = this.ctx.camera;
    const planeNormal = new Vector3(this.plane.normal.x, this.plane.normal.y, this.plane.normal.z);

    if (this.centerPoint) {
      this.addDot(this.centerPoint, START_POINT_COLOR, camera, planeNormal);

      if (this.mousePoint) {
        const radius = dist2D(this.centerPoint, this.mousePoint);
        if (radius > 0) {
          this.addDashedCircle(this.centerPoint, radius);
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

  private addDashedCircle(center: [number, number], radius: number): void {
    const verts = new Float32Array((CIRCLE_SEGMENTS + 1) * 3);
    for (let i = 0; i <= CIRCLE_SEGMENTS; i++) {
      const angle = (i / CIRCLE_SEGMENTS) * Math.PI * 2;
      const pt: [number, number] = [
        center[0] + Math.cos(angle) * radius,
        center[1] + Math.sin(angle) * radius,
      ];
      const w = localToWorld(pt, this.plane);
      verts[i * 3] = w.x;
      verts[i * 3 + 1] = w.y;
      verts[i * 3 + 2] = w.z;
    }

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
