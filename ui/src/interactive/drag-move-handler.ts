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
import { SceneContext } from '../scene/scene-context';
import { PlaneData, SceneObjectRender } from '../types';
import { SnapController } from '../snapping/snap-controller';
import {
  projectToSketch,
  localToWorld,
  roundPoint,
  pixelToSketchThreshold,
} from './sketch-plane-utils';

const DRAG_THRESHOLD_PX_SQ = 64;
const GUIDE_COLOR = 0xb0b0b0;
const DRAG_DOT_COLOR = 0xffc578;
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

export class DragMoveHandler {
  private ctx: SceneContext;
  private plane: PlaneData;
  private snapController: SnapController;
  private sceneObjects: SceneObjectRender[] = [];
  private sketchId: string = '';
  private canvas: HTMLCanvasElement;

  private previewGroup: Group;
  private isDragging = false;
  private dragSourceLocation: { line: number; column: number } | null = null;
  private dragStartPoint: [number, number] | null = null;
  private dragCurrentPoint: [number, number] | null = null;
  private downX = 0;
  private downY = 0;
  private startedDrag = false;

  private boundPointerDown: (e: PointerEvent) => void;
  private boundPointerUp: (e: PointerEvent) => void;
  private boundPointerMove: (e: PointerEvent) => void;

  constructor(ctx: SceneContext, plane: PlaneData, snapController: SnapController) {
    this.ctx = ctx;
    this.plane = plane;
    this.snapController = snapController;
    this.canvas = ctx.renderer.domElement;

    this.previewGroup = new Group();
    this.previewGroup.userData.isMetaShape = true;
    this.previewGroup.renderOrder = 5;

    this.boundPointerDown = this.handlePointerDown.bind(this);
    this.boundPointerUp = this.handlePointerUp.bind(this);
    this.boundPointerMove = this.handlePointerMove.bind(this);
  }

  activate(): void {
    this.ctx.scene.add(this.previewGroup);
    this.canvas.addEventListener('pointerdown', this.boundPointerDown, { capture: true });
    this.canvas.addEventListener('pointerup', this.boundPointerUp);
    this.canvas.addEventListener('pointermove', this.boundPointerMove);
  }

  deactivate(): void {
    this.canvas.removeEventListener('pointerdown', this.boundPointerDown, { capture: true });
    this.canvas.removeEventListener('pointerup', this.boundPointerUp);
    this.canvas.removeEventListener('pointermove', this.boundPointerMove);
    this.endDrag();
    this.ctx.scene.remove(this.previewGroup);
    this.disposePreview();
  }

  updatePlane(plane: PlaneData): void {
    this.plane = plane;
  }

  updateSnapController(snapController: SnapController): void {
    this.snapController = snapController;
  }

  updateSceneData(sceneObjects: SceneObjectRender[], sketchId: string): void {
    this.sceneObjects = sceneObjects;
    this.sketchId = sketchId;
  }

  private handlePointerDown(e: PointerEvent): void {
    if (e.button !== 0) {
      return;
    }
    this.downX = e.clientX;
    this.downY = e.clientY;
    this.startedDrag = false;

    const point2d = projectToSketch(this.ctx, this.plane, e.clientX, e.clientY);
    if (!point2d) {
      return;
    }

    const hit = this.findHitGeometry(point2d);
    if (hit) {
      e.stopPropagation();
      e.preventDefault();
      this.dragSourceLocation = hit.sourceLocation;
      this.dragStartPoint = point2d;
      this.isDragging = true;
      this.ctx.cameraControls.enabled = false;
      this.canvas.setPointerCapture(e.pointerId);
    }
  }

  private handlePointerMove(e: PointerEvent): void {
    if (!this.isDragging || !this.dragStartPoint) {
      return;
    }

    const dx = e.clientX - this.downX;
    const dy = e.clientY - this.downY;
    if (!this.startedDrag && dx * dx + dy * dy <= DRAG_THRESHOLD_PX_SQ) {
      return;
    }

    if (!this.startedDrag) {
      this.startedDrag = true;
      this.canvas.style.cursor = 'grabbing';
    }

    const raw = projectToSketch(this.ctx, this.plane, e.clientX, e.clientY);
    if (!raw) {
      return;
    }

    const result = this.snapController.snap(raw);
    this.dragCurrentPoint = result.point2d;
    this.rebuildPreview();
  }

  private handlePointerUp(_e: PointerEvent): void {
    if (!this.isDragging) {
      return;
    }

    if (this.startedDrag && this.dragCurrentPoint && this.dragSourceLocation) {
      const newPos = roundPoint(this.dragCurrentPoint);
      fetch('/api/update-position', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          newPosition: newPos,
          sourceLocation: this.dragSourceLocation,
        }),
      });
    }

    this.endDrag();
  }

  private endDrag(): void {
    this.isDragging = false;
    this.startedDrag = false;
    this.dragSourceLocation = null;
    this.dragStartPoint = null;
    this.dragCurrentPoint = null;
    this.ctx.cameraControls.enabled = true;
    this.canvas.style.cursor = '';
    this.disposePreview();
    this.ctx.requestRender();
  }

  private findHitGeometry(point2d: [number, number]): { sourceLocation: { line: number; column: number } } | null {
    const sketchChildren = this.sceneObjects.filter(o => o.parentId === this.sketchId);
    const threshold = pixelToSketchThreshold(this.ctx, 12);

    for (const child of sketchChildren) {
      if (!child.sourceLocation) {
        continue;
      }
      for (const part of child.sceneShapes) {
        for (const mesh of part.meshes) {
          if (this.isPointNearMesh(point2d, mesh.vertices, threshold)) {
            return { sourceLocation: child.sourceLocation };
          }
        }
      }
    }

    return null;
  }

  private isPointNearMesh(point2d: [number, number], vertices: number[], threshold: number): boolean {
    const thresholdSq = threshold * threshold;
    const ox = this.plane.origin.x, oy = this.plane.origin.y, oz = this.plane.origin.z;
    const xx = this.plane.xDirection.x, xy = this.plane.xDirection.y, xz = this.plane.xDirection.z;
    const yx = this.plane.yDirection.x, yy = this.plane.yDirection.y, yz = this.plane.yDirection.z;
    for (let i = 0; i < vertices.length; i += 3) {
      const rx = vertices[i] - ox, ry = vertices[i + 1] - oy, rz = vertices[i + 2] - oz;
      const vx = rx * xx + ry * xy + rz * xz;
      const vy = rx * yx + ry * yy + rz * yz;
      const dx = vx - point2d[0];
      const dy = vy - point2d[1];
      if (dx * dx + dy * dy < thresholdSq) {
        return true;
      }
    }
    return false;
  }

  private rebuildPreview(): void {
    this.disposePreview();

    if (!this.dragStartPoint || !this.dragCurrentPoint) {
      return;
    }

    const camera = this.ctx.camera;
    const planeNormal = new Vector3(this.plane.normal.x, this.plane.normal.y, this.plane.normal.z);

    this.addDot(this.dragCurrentPoint, DRAG_DOT_COLOR, camera, planeNormal);
    this.addDashedLine(this.dragStartPoint, this.dragCurrentPoint);

    this.ctx.requestRender();
  }

  private disposePreview(): void {
    while (this.previewGroup.children.length > 0) {
      const child = this.previewGroup.children[0];
      this.previewGroup.remove(child);
      const obj = child as any;
      if (obj.geometry) {
        obj.geometry.dispose();
      }
      if (obj.material) {
        obj.material.dispose();
      }
    }
  }

  private addDot(
    point2d: [number, number],
    color: number,
    camera: Camera,
    planeNormal: Vector3,
  ): void {
    const geo = new CircleGeometry(DOT_RADIUS, DOT_SEGMENTS);
    const mat = new MeshBasicMaterial({
      color,
      side: DoubleSide,
      depthTest: false,
    });
    const dot = new Mesh(geo, mat);
    dot.renderOrder = 5;

    const group = new Group();
    group.renderOrder = 5;
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
    line.renderOrder = 5;
    this.previewGroup.add(line);
  }
}
