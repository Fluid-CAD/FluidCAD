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
  private isResizing = false;
  private hasMoved = false;
  private hitResult: DragHitResult | null = null;
  private startPoint: [number, number] | null = null;
  private currentPoint: [number, number] | null = null;
  private lastClientX = 0;
  private lastClientY = 0;

  private expressionInput: ExpressionInput;
  private fetchVariables: FetchVariablesFn;
  private cachedVariables: VariableInfo[] = [];

  private boundPointerDown: (e: PointerEvent) => void;
  private boundPointerMove: (e: PointerEvent) => void;
  private boundKeyDown: (e: KeyboardEvent) => void;

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
    this.boundPointerMove = this.handlePointerMove.bind(this);
    this.boundKeyDown = this.handleKeyDown.bind(this);
  }

  activate(): void {
    this.ctx.scene.add(this.previewGroup);
    this.canvas.addEventListener('pointerdown', this.boundPointerDown, { capture: true });
    this.canvas.addEventListener('pointermove', this.boundPointerMove);
    window.addEventListener('keydown', this.boundKeyDown);
  }

  deactivate(): void {
    this.canvas.removeEventListener('pointerdown', this.boundPointerDown, { capture: true });
    this.canvas.removeEventListener('pointermove', this.boundPointerMove);
    window.removeEventListener('keydown', this.boundKeyDown);
    this.endResize();
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
    if (e.button !== 0) return;

    if (this.isResizing) {
      this.commitResize();
      e.stopPropagation();
      e.preventDefault();
      return;
    }

    const point2d = projectToSketch(this.ctx, this.plane, e.clientX, e.clientY);
    if (!point2d) return;

    const hit = this.findHitGeometry(point2d);
    if (hit) {
      e.stopPropagation();
      e.preventDefault();
      this.startResize(hit, point2d, e.clientX, e.clientY);
    }
  }

  private startResize(hit: DragHitResult, point2d: [number, number], clientX: number, clientY: number): void {
    this.isResizing = true;
    this.hasMoved = false;
    this.hitResult = hit;
    this.startPoint = point2d;
    this.currentPoint = point2d;
    this.ctx.cameraControls.enabled = false;
    this.canvas.style.cursor = 'crosshair';
    this.showDimensionInput(clientX, clientY);
  }

  private commitResize(): void {
    if (this.expressionInput.isVisible) {
      this.expressionInput.commitCurrentValue();
    }
    this.endResize();
  }

  private handleKeyDown(e: KeyboardEvent): void {
    if (e.key === 'Escape' && this.isResizing) {
      this.endResize();
    }
  }

  private handlePointerMove(e: PointerEvent): void {
    if (!this.isResizing) return;

    const raw = projectToSketch(this.ctx, this.plane, e.clientX, e.clientY);
    if (!raw) return;

    this.hasMoved = true;
    const result = this.snapController.snap(raw);
    this.currentPoint = result.point2d;
    this.lastClientX = e.clientX;
    this.lastClientY = e.clientY;
    this.rebuildPreview();
    this.updateDimensionValue();
    this.expressionInput.updatePosition(e.clientX, e.clientY);
  }

  private showDimensionInput(clientX: number, clientY: number): void {
    if (!this.hitResult || !this.startPoint) return;
    const { uniqueType, hitZone, sourceLocation } = this.hitResult;

    let label: string | null = null;
    let value = 0;

    if (uniqueType === 'circle') {
      label = '⌀';
      const center = this.hitResult.anchorPoint!;
      const ddx = this.startPoint[0] - center[0];
      const ddy = this.startPoint[1] - center[1];
      value = Math.round(2 * Math.sqrt(ddx * ddx + ddy * ddy) * 100) / 100;
    } else if ((uniqueType === 'hline' || uniqueType === 'vline') && hitZone === 'end') {
      label = uniqueType === 'hline' ? 'H:' : 'V:';
      const start = this.hitResult.anchorPoint!;
      value = uniqueType === 'hline'
        ? Math.round(Math.abs(this.startPoint[0] - start[0]) * 100) / 100
        : Math.round(Math.abs(this.startPoint[1] - start[1]) * 100) / 100;
    }

    if (label === null) return;

    if (this.cachedVariables.length === 0) {
      this.fetchVariables().then(vars => { this.cachedVariables = vars; });
    }

    const numericFallback = String(value);

    this.expressionInput.show({
      label,
      value: numericFallback,
      clientX,
      clientY,
      variables: this.cachedVariables,
      onCommit: (expression) => {
        if (!this.hitResult) return;
        const { sourceLocation: sl, uniqueType: ut } = this.hitResult;
        const num = parseFloat(expression);
        const isNumeric = !isNaN(num) && String(num) === expression;

        let finalExpr = expression;
        if (isNumeric && ut !== 'circle') {
          const sign = this.computeDistanceSign();
          finalExpr = String(Math.round(sign * num * 100) / 100);
        } else if (isNumeric) {
          finalExpr = String(Math.round(num * 100) / 100);
        }

        fetch('/api/update-dimension-expression', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ expression: finalExpr, sourceLocation: sl }),
        });
        this.endResize();
      },
    });

    fetch('/api/dimension-expression', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sourceLine: sourceLocation.line }),
    })
      .then(r => r.ok ? r.json() : { expression: null })
      .catch(() => ({ expression: null }))
      .then(({ expression }) => {
        if (expression && !this.hasMoved && this.isResizing) {
          this.expressionInput.updateValue(expression);
        }
      });
  }

  private computeDistanceSign(): number {
    if (!this.hitResult || !this.currentPoint) return 1;
    const start = this.hitResult.anchorPoint!;
    if (this.hitResult.uniqueType === 'hline') {
      return this.currentPoint[0] >= start[0] ? 1 : -1;
    }
    return this.currentPoint[1] >= start[1] ? 1 : -1;
  }

  private updateDimensionValue(): void {
    if (!this.expressionInput.isVisible || !this.currentPoint || !this.hitResult) return;
    const { uniqueType, anchorPoint } = this.hitResult;
    let value: number;
    if (uniqueType === 'circle') {
      const center = anchorPoint!;
      const ddx = this.currentPoint[0] - center[0];
      const ddy = this.currentPoint[1] - center[1];
      value = Math.round(2 * Math.sqrt(ddx * ddx + ddy * ddy) * 100) / 100;
    } else {
      const start = anchorPoint!;
      const raw = uniqueType === 'hline'
        ? this.currentPoint[0] - start[0]
        : this.currentPoint[1] - start[1];
      value = Math.round(Math.abs(raw) * 100) / 100;
    }
    this.expressionInput.updateValue(value);
  }

  private endResize(): void {
    this.isResizing = false;
    this.hasMoved = false;
    this.hitResult = null;
    this.startPoint = null;
    this.currentPoint = null;
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

    if (!this.currentPoint || !this.hitResult) return;

    const { uniqueType, hitZone, anchorPoint, fixedVertex } = this.hitResult;
    const camera = this.ctx.camera;
    const planeNormal = new Vector3(this.plane.normal.x, this.plane.normal.y, this.plane.normal.z);

    if (uniqueType === 'circle' && anchorPoint) {
      const center = anchorPoint;
      const ddx = this.currentPoint[0] - center[0];
      const ddy = this.currentPoint[1] - center[1];
      const radius = Math.sqrt(ddx * ddx + ddy * ddy);
      this.addDot(center, START_DOT_COLOR, camera, planeNormal);
      this.addDashedCircle(center, radius);
    } else if (uniqueType === 'hline' || uniqueType === 'vline') {
      if (hitZone === 'end') {
        const start = anchorPoint!;
        const constrainedEnd: [number, number] = uniqueType === 'hline'
          ? [this.currentPoint[0], start[1]]
          : [start[0], this.currentPoint[1]];
        this.addDot(start, START_DOT_COLOR, camera, planeNormal);
        this.addDashedLine(start, constrainedEnd);
        this.addDot(constrainedEnd, 0xffc578, camera, planeNormal);
      } else {
        const d = this.hitResult.originalDistance ?? 0;
        const newEnd: [number, number] = uniqueType === 'hline'
          ? [this.currentPoint[0] + d, this.currentPoint[1]]
          : [this.currentPoint[0], this.currentPoint[1] + d];
        this.addDot(this.currentPoint, START_DOT_COLOR, camera, planeNormal);
        this.addDashedLine(this.currentPoint, newEnd);
        this.addDot(newEnd, 0xffc578, camera, planeNormal);
      }
    } else if (uniqueType === 'line-two-points' && fixedVertex) {
      if (hitZone === 'start') {
        this.addDot(this.currentPoint, 0xffc578, camera, planeNormal);
        this.addDashedLine(this.currentPoint, fixedVertex);
        this.addDot(fixedVertex, START_DOT_COLOR, camera, planeNormal);
      } else {
        this.addDot(fixedVertex, START_DOT_COLOR, camera, planeNormal);
        this.addDashedLine(fixedVertex, this.currentPoint);
        this.addDot(this.currentPoint, 0xffc578, camera, planeNormal);
      }
    } else {
      this.addDot(this.currentPoint, 0xffc578, camera, planeNormal);
      if (this.startPoint) {
        this.addDashedLine(this.startPoint, this.currentPoint);
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
