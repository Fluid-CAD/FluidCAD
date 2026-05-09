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

  private boundMouseDown: (e: MouseEvent) => void;
  private boundMouseUp: (e: MouseEvent) => void;
  private boundMouseMove: (e: MouseEvent) => void;

  constructor(ctx: SceneContext, plane: PlaneData, snapController: SnapController) {
    this.ctx = ctx;
    this.plane = plane;
    this.snapController = snapController;
    this.canvas = ctx.renderer.domElement;

    this.previewGroup = new Group();
    this.previewGroup.userData.isMetaShape = true;
    this.previewGroup.renderOrder = 5;

    this.boundMouseDown = this.handleMouseDown.bind(this);
    this.boundMouseUp = this.handleMouseUp.bind(this);
    this.boundMouseMove = this.handleMouseMove.bind(this);
  }

  activate(): void {
    this.ctx.scene.add(this.previewGroup);
    this.canvas.addEventListener('mousedown', this.boundMouseDown);
    this.canvas.addEventListener('mouseup', this.boundMouseUp);
    this.canvas.addEventListener('mousemove', this.boundMouseMove);
  }

  deactivate(): void {
    this.canvas.removeEventListener('mousedown', this.boundMouseDown);
    this.canvas.removeEventListener('mouseup', this.boundMouseUp);
    this.canvas.removeEventListener('mousemove', this.boundMouseMove);
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

  private handleMouseDown(e: MouseEvent): void {
    this.downX = e.clientX;
    this.downY = e.clientY;
    this.startedDrag = false;

    const point2d = projectToSketch(this.ctx, this.plane, e.clientX, e.clientY);
    if (!point2d) {
      return;
    }

    const hit = this.findHitGeometry(point2d);
    if (hit) {
      this.dragSourceLocation = hit.sourceLocation;
      this.dragStartPoint = point2d;
      this.isDragging = true;
    }
  }

  private handleMouseMove(e: MouseEvent): void {
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
      this.ctx.cameraControls.enabled = false;
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

  private handleMouseUp(_e: MouseEvent): void {
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

    for (const child of sketchChildren) {
      if (!child.sourceLocation) {
        continue;
      }
      for (const part of child.ownShapes) {
        if (!part.shapeId) {
          continue;
        }
        for (const mesh of part.meshes) {
          if (this.isPointNearMesh(point2d, mesh.vertices)) {
            return { sourceLocation: child.sourceLocation };
          }
        }
      }
    }

    return null;
  }

  private isPointNearMesh(point2d: [number, number], vertices: number[]): boolean {
    const threshold = 5;
    for (let i = 0; i < vertices.length; i += 3) {
      const worldPt = { x: vertices[i], y: vertices[i + 1], z: vertices[i + 2] };
      const rel = new Vector3(
        worldPt.x - this.plane.origin.x,
        worldPt.y - this.plane.origin.y,
        worldPt.z - this.plane.origin.z,
      );
      const xDir = new Vector3(this.plane.xDirection.x, this.plane.xDirection.y, this.plane.xDirection.z);
      const yDir = new Vector3(this.plane.yDirection.x, this.plane.yDirection.y, this.plane.yDirection.z);
      const vx = rel.dot(xDir);
      const vy = rel.dot(yDir);
      const dx = vx - point2d[0];
      const dy = vy - point2d[1];
      if (dx * dx + dy * dy < threshold * threshold) {
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
