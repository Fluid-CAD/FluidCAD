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
import { ExpressionInput, VariableInfo } from '../ui/expression-input';
import { FetchVariablesFn } from './sketch-tool';

type DragHitResult = {
  sourceLocation: { line: number; column: number };
  uniqueType: string;
  hitZone: 'start' | 'end' | 'body';
  anchorPoint?: [number, number];
  fixedVertex?: [number, number];
  originalDistance?: number;
};

const DRAG_THRESHOLD_PX_SQ = 64;
const GUIDE_COLOR = 0xb0b0b0;
const DOT_RADIUS = 2.5;
const DOT_SEGMENTS = 16;
const SCALE_FACTOR = 0.003;
const MAX_SCALE = 1.5;
const CIRCLE_PREVIEW_SEGMENTS = 64;
const START_DOT_COLOR = 0x22cc66;

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
  private dragHitResult: DragHitResult | null = null;
  private dragStartPoint: [number, number] | null = null;
  private dragCurrentPoint: [number, number] | null = null;
  private downX = 0;
  private downY = 0;
  private startedDrag = false;
  private committed = false;
  private lastClientX = 0;
  private lastClientY = 0;

  private expressionInput: ExpressionInput;
  private fetchVariables: FetchVariablesFn;
  private cachedVariables: VariableInfo[] = [];

  private boundPointerDown: (e: PointerEvent) => void;
  private boundPointerUp: (e: PointerEvent) => void;
  private boundPointerMove: (e: PointerEvent) => void;

  constructor(ctx: SceneContext, plane: PlaneData, snapController: SnapController, container: HTMLElement, fetchVariables: FetchVariablesFn) {
    this.ctx = ctx;
    this.plane = plane;
    this.snapController = snapController;
    this.canvas = ctx.renderer.domElement;

    this.previewGroup = new Group();
    this.previewGroup.userData.isMetaShape = true;
    this.previewGroup.renderOrder = 5;

    this.expressionInput = new ExpressionInput(container);
    this.fetchVariables = fetchVariables;

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
    this.committed = false;

    const point2d = projectToSketch(this.ctx, this.plane, e.clientX, e.clientY);
    if (!point2d) {
      return;
    }

    const hit = this.findHitGeometry(point2d);
    if (hit) {
      e.stopPropagation();
      e.preventDefault();
      this.dragSourceLocation = hit.sourceLocation;
      this.dragHitResult = hit;
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
      this.showDimensionInput(e.clientX, e.clientY);
    }

    const raw = projectToSketch(this.ctx, this.plane, e.clientX, e.clientY);
    if (!raw) {
      return;
    }

    const result = this.snapController.snap(raw);
    this.dragCurrentPoint = result.point2d;
    this.lastClientX = e.clientX;
    this.lastClientY = e.clientY;
    this.rebuildPreview();
    this.updateDimensionValue();
    this.expressionInput.updatePosition(e.clientX, e.clientY);
  }

  private showDimensionInput(clientX: number, clientY: number): void {
    if (!this.dragHitResult || !this.dragStartPoint) {
      return;
    }
    const { uniqueType, hitZone } = this.dragHitResult;

    let label: string | null = null;
    let value = 0;

    if (uniqueType === 'circle') {
      label = '⌀';
      const center = this.dragHitResult.anchorPoint!;
      const ddx = this.dragStartPoint[0] - center[0];
      const ddy = this.dragStartPoint[1] - center[1];
      value = Math.round(2 * Math.sqrt(ddx * ddx + ddy * ddy) * 100) / 100;
    } else if ((uniqueType === 'hline' || uniqueType === 'vline') && hitZone === 'end') {
      label = uniqueType === 'hline' ? 'H:' : 'V:';
      const start = this.dragHitResult.anchorPoint!;
      value = uniqueType === 'hline'
        ? Math.round(Math.abs(this.dragStartPoint[0] - start[0]) * 100) / 100
        : Math.round(Math.abs(this.dragStartPoint[1] - start[1]) * 100) / 100;
    }

    if (label === null) {
      return;
    }

    if (this.cachedVariables.length === 0) {
      this.fetchVariables().then(vars => { this.cachedVariables = vars; });
    }

    this.expressionInput.show({
      label,
      value: String(value),
      clientX,
      clientY,
      variables: this.cachedVariables,
      onCommit: (expression) => {
        if (this.committed || !this.dragHitResult) {
          return;
        }
        this.committed = true;
        const { sourceLocation, uniqueType: ut } = this.dragHitResult;
        const num = parseFloat(expression);
        const isNumeric = !isNaN(num) && String(num) === expression;

        if (isNumeric) {
          if (ut === 'circle') {
            fetch('/api/update-dimension', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ newValue: Math.round(num * 100) / 100, sourceLocation }),
            });
          } else {
            const sign = this.computeDistanceSign();
            fetch('/api/update-dimension', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ newValue: Math.round(sign * num * 100) / 100, sourceLocation }),
            });
          }
        } else {
          fetch('/api/update-dimension-expression', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ expression, sourceLocation }),
          });
        }
        this.endDrag();
      },
    });
  }

  private computeDistanceSign(): number {
    if (!this.dragHitResult || !this.dragCurrentPoint) {
      return 1;
    }
    const start = this.dragHitResult.anchorPoint!;
    if (this.dragHitResult.uniqueType === 'hline') {
      return this.dragCurrentPoint[0] >= start[0] ? 1 : -1;
    }
    return this.dragCurrentPoint[1] >= start[1] ? 1 : -1;
  }

  private updateDimensionValue(): void {
    if (!this.expressionInput.isVisible || !this.dragCurrentPoint || !this.dragHitResult) {
      return;
    }
    const { uniqueType, anchorPoint } = this.dragHitResult;
    let value: number;
    if (uniqueType === 'circle') {
      const center = anchorPoint!;
      const ddx = this.dragCurrentPoint[0] - center[0];
      const ddy = this.dragCurrentPoint[1] - center[1];
      value = Math.round(2 * Math.sqrt(ddx * ddx + ddy * ddy) * 100) / 100;
    } else {
      const start = anchorPoint!;
      const raw = uniqueType === 'hline'
        ? this.dragCurrentPoint[0] - start[0]
        : this.dragCurrentPoint[1] - start[1];
      value = Math.round(Math.abs(raw) * 100) / 100;
    }
    this.expressionInput.updateValue(value);
  }

  private handlePointerUp(_e: PointerEvent): void {
    if (!this.isDragging) {
      return;
    }

    if (this.committed) {
      this.endDrag();
      return;
    }

    if (this.startedDrag && this.dragCurrentPoint && this.dragHitResult) {
      const newPos = roundPoint(this.dragCurrentPoint);
      const { sourceLocation, uniqueType, hitZone, anchorPoint } = this.dragHitResult;

      if (uniqueType === 'circle') {
        const center = anchorPoint!;
        const ddx = newPos[0] - center[0];
        const ddy = newPos[1] - center[1];
        const newDiameter = Math.round(2 * Math.sqrt(ddx * ddx + ddy * ddy) * 100) / 100;
        fetch('/api/update-dimension', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ newValue: newDiameter, sourceLocation }),
        });
      } else if (uniqueType === 'line-two-points') {
        const pointIndex = hitZone === 'start' ? 0 : -1;
        fetch('/api/update-position', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ newPosition: newPos, sourceLocation, pointIndex }),
        });
      } else if (uniqueType === 'hline' || uniqueType === 'vline') {
        if (hitZone === 'start') {
          fetch('/api/update-position', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ newPosition: newPos, sourceLocation, pointIndex: 0 }),
          });
        } else {
          const start = anchorPoint!;
          let newDistance = uniqueType === 'hline'
            ? newPos[0] - start[0]
            : newPos[1] - start[1];
          newDistance = Math.round(newDistance * 100) / 100;
          fetch('/api/update-dimension', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ newValue: newDistance, sourceLocation }),
          });
        }
      } else {
        fetch('/api/update-position', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ newPosition: newPos, sourceLocation }),
        });
      }
    }

    this.endDrag();
  }

  private endDrag(): void {
    this.isDragging = false;
    this.startedDrag = false;
    this.committed = false;
    this.dragSourceLocation = null;
    this.dragHitResult = null;
    this.dragStartPoint = null;
    this.dragCurrentPoint = null;
    this.ctx.cameraControls.enabled = true;
    this.canvas.style.cursor = '';
    this.expressionInput.hide();
    this.disposePreview();
    this.ctx.requestRender();
  }

  private findHitGeometry(point2d: [number, number]): DragHitResult | null {
    const sketchChildren = this.sceneObjects.filter(o => o.parentId === this.sketchId);
    const threshold = pixelToSketchThreshold(this.ctx, 12);
    const thresholdSq = threshold * threshold;

    let bestHit: DragHitResult | null = null;
    let bestDistSq = Infinity;

    for (const child of sketchChildren) {
      if (!child.sourceLocation) {
        continue;
      }
      const uniqueType = (child as any).uniqueType as string | undefined;
      const sourceLocation = child.sourceLocation;

      for (const part of child.sceneShapes) {
        if (part.isMetaShape) {
          continue;
        }
        for (const mesh of part.meshes) {
          const verts2d = this.meshToSketch2D(mesh.vertices);
          if (verts2d.length === 0) {
            continue;
          }

          if (uniqueType === 'circle') {
            let cx = 0, cy = 0;
            for (const v of verts2d) {
              cx += v[0];
              cy += v[1];
            }
            cx /= verts2d.length;
            cy /= verts2d.length;

            for (const v of verts2d) {
              const ddx = v[0] - point2d[0];
              const ddy = v[1] - point2d[1];
              const d = ddx * ddx + ddy * ddy;
              if (d < thresholdSq && d < bestDistSq) {
                bestHit = { sourceLocation, uniqueType, hitZone: 'body', anchorPoint: [cx, cy] };
                bestDistSq = d;
              }
            }
          } else if (uniqueType === 'line-two-points' || uniqueType === 'hline' || uniqueType === 'vline') {
            const startV = verts2d[0];
            const endV = verts2d[verts2d.length - 1];

            const sdx = startV[0] - point2d[0];
            const sdy = startV[1] - point2d[1];
            const startDist = sdx * sdx + sdy * sdy;

            const edx = endV[0] - point2d[0];
            const edy = endV[1] - point2d[1];
            const endDist = edx * edx + edy * edy;

            const isConstrained = uniqueType === 'hline' || uniqueType === 'vline';
            const dist = isConstrained
              ? (uniqueType === 'hline' ? endV[0] - startV[0] : endV[1] - startV[1])
              : undefined;

            if (startDist < thresholdSq && startDist < bestDistSq && startDist <= endDist) {
              bestHit = {
                sourceLocation, uniqueType: uniqueType || '', hitZone: 'start',
                anchorPoint: startV, fixedVertex: endV, originalDistance: dist,
              };
              bestDistSq = startDist;
            }
            if (endDist < thresholdSq && endDist < bestDistSq && endDist < startDist) {
              bestHit = {
                sourceLocation, uniqueType: uniqueType || '', hitZone: 'end',
                anchorPoint: startV, fixedVertex: startV,
              };
              bestDistSq = endDist;
            }
          } else {
            for (const v of verts2d) {
              const ddx = v[0] - point2d[0];
              const ddy = v[1] - point2d[1];
              const d = ddx * ddx + ddy * ddy;
              if (d < thresholdSq && d < bestDistSq) {
                bestHit = { sourceLocation, uniqueType: uniqueType || '', hitZone: 'body' };
                bestDistSq = d;
              }
            }
          }
        }
      }
    }

    return bestHit;
  }

  private meshToSketch2D(vertices: number[]): [number, number][] {
    const ox = this.plane.origin.x, oy = this.plane.origin.y, oz = this.plane.origin.z;
    const xx = this.plane.xDirection.x, xy = this.plane.xDirection.y, xz = this.plane.xDirection.z;
    const yx = this.plane.yDirection.x, yy = this.plane.yDirection.y, yz = this.plane.yDirection.z;
    const result: [number, number][] = [];
    for (let i = 0; i < vertices.length; i += 3) {
      const rx = vertices[i] - ox, ry = vertices[i + 1] - oy, rz = vertices[i + 2] - oz;
      result.push([rx * xx + ry * xy + rz * xz, rx * yx + ry * yy + rz * yz]);
    }
    return result;
  }

  // ── Preview rendering ──────────────────────────────────────────────

  private rebuildPreview(): void {
    this.disposePreview();

    if (!this.dragCurrentPoint || !this.dragHitResult) {
      return;
    }

    const { uniqueType, hitZone, anchorPoint, fixedVertex } = this.dragHitResult;
    const camera = this.ctx.camera;
    const planeNormal = new Vector3(this.plane.normal.x, this.plane.normal.y, this.plane.normal.z);

    if (uniqueType === 'circle' && anchorPoint) {
      const center = anchorPoint;
      const ddx = this.dragCurrentPoint[0] - center[0];
      const ddy = this.dragCurrentPoint[1] - center[1];
      const radius = Math.sqrt(ddx * ddx + ddy * ddy);
      this.addDot(center, START_DOT_COLOR, camera, planeNormal);
      this.addDashedCircle(center, radius);
    } else if (uniqueType === 'hline' || uniqueType === 'vline') {
      if (hitZone === 'end') {
        const start = anchorPoint!;
        const constrainedEnd: [number, number] = uniqueType === 'hline'
          ? [this.dragCurrentPoint[0], start[1]]
          : [start[0], this.dragCurrentPoint[1]];
        this.addDot(start, START_DOT_COLOR, camera, planeNormal);
        this.addDashedLine(start, constrainedEnd);
        this.addDot(constrainedEnd, 0xffc578, camera, planeNormal);
      } else {
        const d = this.dragHitResult.originalDistance ?? 0;
        const newEnd: [number, number] = uniqueType === 'hline'
          ? [this.dragCurrentPoint[0] + d, this.dragCurrentPoint[1]]
          : [this.dragCurrentPoint[0], this.dragCurrentPoint[1] + d];
        this.addDot(this.dragCurrentPoint, START_DOT_COLOR, camera, planeNormal);
        this.addDashedLine(this.dragCurrentPoint, newEnd);
        this.addDot(newEnd, 0xffc578, camera, planeNormal);
      }
    } else if (uniqueType === 'line-two-points' && fixedVertex) {
      if (hitZone === 'start') {
        this.addDot(this.dragCurrentPoint, 0xffc578, camera, planeNormal);
        this.addDashedLine(this.dragCurrentPoint, fixedVertex);
        this.addDot(fixedVertex, START_DOT_COLOR, camera, planeNormal);
      } else {
        this.addDot(fixedVertex, START_DOT_COLOR, camera, planeNormal);
        this.addDashedLine(fixedVertex, this.dragCurrentPoint);
        this.addDot(this.dragCurrentPoint, 0xffc578, camera, planeNormal);
      }
    } else {
      this.addDot(this.dragCurrentPoint, 0xffc578, camera, planeNormal);
      if (this.dragStartPoint) {
        this.addDashedLine(this.dragStartPoint, this.dragCurrentPoint);
      }
    }

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

  private addDashedCircle(center: [number, number], radius: number): void {
    const verts = new Float32Array((CIRCLE_PREVIEW_SEGMENTS + 1) * 3);
    for (let i = 0; i <= CIRCLE_PREVIEW_SEGMENTS; i++) {
      const angle = (i / CIRCLE_PREVIEW_SEGMENTS) * Math.PI * 2;
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
    line.renderOrder = 5;
    this.previewGroup.add(line);
  }
}
