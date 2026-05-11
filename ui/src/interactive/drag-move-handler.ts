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
import { pointToSegmentDist } from './sketch-edge-utils';
import { ExpressionInput, VariableInfo } from '../ui/expression-input';
type GetSketchSourceLineFn = () => number | null;
import { FetchVariablesFn } from './sketch-tool';

type DragHitResult = {
  sourceLocation: { line: number; column: number };
  uniqueType: string;
  hitZone: 'start' | 'end' | 'body';
  anchorPoint?: [number, number];
  fixedVertex?: [number, number];
  originalDistance?: number;
  initialValue?: number;
  draggedVertices?: [number, number][];
};

type PendingHit = {
  hit: DragHitResult;
  point2d: [number, number];
  clientX: number;
  clientY: number;
};

const GUIDE_COLOR = 0xb0b0b0;
const DOT_RADIUS = 2.5;
const DOT_SEGMENTS = 16;
const SCALE_FACTOR = 0.003;
const MAX_SCALE = 1.5;
const CIRCLE_PREVIEW_SEGMENTS = 64;
const START_DOT_COLOR = 0x22cc66;
const DRAG_THRESHOLD_PX = 4;

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
  private _isResizing = false;
  private hasMoved = false;
  private hitResult: DragHitResult | null = null;
  private startPoint: [number, number] | null = null;
  private currentPoint: [number, number] | null = null;
  private grabOffset: [number, number] | null = null;

  private pendingHit: PendingHit | null = null;
  private standaloneInputActive = false;

  private expressionInput: ExpressionInput;
  private fetchVariables: FetchVariablesFn;
  private getSketchSourceLine: GetSketchSourceLineFn;
  private cachedVariables: VariableInfo[] = [];

  private boundCanvasPointerDown: (e: PointerEvent) => void;
  private boundPointerMove: (e: PointerEvent) => void;
  private boundPointerUp: (e: PointerEvent) => void;
  private boundKeyDown: (e: KeyboardEvent) => void;
  private boundCanvasDoubleClick: (e: MouseEvent) => void;

  constructor(
    ctx: SceneContext,
    plane: PlaneData,
    snapController: SnapController,
    container: HTMLElement,
    fetchVariables: FetchVariablesFn,
    getSketchSourceLine: GetSketchSourceLineFn,
  ) {
    this.ctx = ctx;
    this.plane = plane;
    this.snapController = snapController;
    this.canvas = ctx.renderer.domElement;

    this.previewGroup = new Group();
    this.previewGroup.userData.isMetaShape = true;
    this.previewGroup.renderOrder = 5;

    this.expressionInput = new ExpressionInput(container);
    this.fetchVariables = fetchVariables;
    this.getSketchSourceLine = getSketchSourceLine;

    this.boundCanvasPointerDown = this.handleCanvasPointerDown.bind(this);
    this.boundPointerMove = this.handlePointerMove.bind(this);
    this.boundPointerUp = this.handlePointerUp.bind(this);
    this.boundKeyDown = this.handleKeyDown.bind(this);
    this.boundCanvasDoubleClick = this.handleCanvasDoubleClick.bind(this);
  }

  get isResizing(): boolean {
    return this._isResizing;
  }

  activate(): void {
    this.ctx.scene.add(this.previewGroup);
    this.canvas.addEventListener('pointerdown', this.boundCanvasPointerDown, { capture: true });
    this.canvas.addEventListener('dblclick', this.boundCanvasDoubleClick);
    window.addEventListener('pointermove', this.boundPointerMove);
    window.addEventListener('pointerup', this.boundPointerUp, { capture: true });
    window.addEventListener('keydown', this.boundKeyDown);
  }

  deactivate(): void {
    this.canvas.removeEventListener('pointerdown', this.boundCanvasPointerDown, { capture: true });
    this.canvas.removeEventListener('dblclick', this.boundCanvasDoubleClick);
    window.removeEventListener('pointermove', this.boundPointerMove);
    window.removeEventListener('pointerup', this.boundPointerUp, { capture: true });
    window.removeEventListener('keydown', this.boundKeyDown);
    this.endResize();
    this.closeStandaloneInput();
    this.pendingHit = null;
    this.ctx.scene.remove(this.previewGroup);
    this.disposePreview();
  }

  updatePlane(plane: PlaneData): void {
    this.plane = plane;
  }

  updateSnapController(snapController: SnapController): void {
    this.snapController = snapController;
    if (this._isResizing && this.hitResult?.draggedVertices) {
      this.snapController.setExcludedVertices(this.hitResult.draggedVertices);
    }
  }

  updateSceneData(sceneObjects: SceneObjectRender[], sketchId: string): void {
    this.sceneObjects = sceneObjects;
    this.sketchId = sketchId;
    this.fetchVariables().then(vars => { this.cachedVariables = vars; });
  }

  private handleCanvasPointerDown(e: PointerEvent): void {
    if (e.button !== 0 || this._isResizing) {
      return;
    }
    if (this.standaloneInputActive && this.expressionInput.containsElement(e.target)) {
      return;
    }

    const point2d = projectToSketch(this.ctx, this.plane, e.clientX, e.clientY);
    if (!point2d) {
      return;
    }

    const hit = this.findHitGeometry(point2d);
    if (!hit) {
      return;
    }

    this.pendingHit = {
      hit,
      point2d,
      clientX: e.clientX,
      clientY: e.clientY,
    };
    // Preempt camera-controls so it can't start panning before we cross
    // the drag threshold. Re-enabled in endResize or in handlePointerUp
    // if the click never turns into a drag.
    this.ctx.cameraControls.enabled = false;
    e.stopPropagation();
  }

  private handlePointerUp(e: PointerEvent): void {
    if (e.button !== 0) {
      return;
    }

    if (this._isResizing) {
      this.commitResize();
      e.stopPropagation();
      e.preventDefault();
      return;
    }

    // Sub-threshold pointerup: discard pending, re-enable camera controls
    // (preempted in handleCanvasPointerDown), and let the event bubble so
    // SketchHoverSelectHandler can handle click-to-select.
    if (this.pendingHit) {
      this.pendingHit = null;
      this.ctx.cameraControls.enabled = true;
    }
  }

  private startResize(pending: PendingHit): void {
    this._isResizing = true;
    this.hasMoved = false;
    this.hitResult = pending.hit;
    this.startPoint = pending.point2d;
    this.currentPoint = pending.point2d;

    const hit = pending.hit;
    if (hit.hitZone === 'body' && hit.anchorPoint && (hit.uniqueType === 'hline' || hit.uniqueType === 'vline' || hit.uniqueType === 'line-two-points')) {
      this.grabOffset = [pending.point2d[0] - hit.anchorPoint[0], pending.point2d[1] - hit.anchorPoint[1]];
    } else {
      this.grabOffset = null;
    }

    this.ctx.cameraControls.enabled = false;
    this.canvas.style.cursor = 'crosshair';
    this.snapController.setExcludedVertices(hit.draggedVertices ?? []);
    this.showDimensionInputForDrag(pending.clientX, pending.clientY);
  }

  private commitResize(): void {
    if (this.expressionInput.isVisible && this.hasMoved) {
      this.expressionInput.commitCurrentValue();
    } else if (this.currentPoint && this.hitResult) {
      this.commitPositionMove();
    }
    this.endResize();
  }

  private commitPositionMove(): void {
    if (!this.currentPoint || !this.hitResult) {
      return;
    }
    const newPos = roundPoint(this.currentPoint);
    const { sourceLocation, uniqueType, hitZone, anchorPoint, fixedVertex } = this.hitResult;

    if (uniqueType === 'line-two-points' && hitZone === 'body' && anchorPoint && fixedVertex) {
      const dx = fixedVertex[0] - anchorPoint[0];
      const dy = fixedVertex[1] - anchorPoint[1];
      const newStart = newPos;
      const newEnd = roundPoint([newPos[0] + dx, newPos[1] + dy]);
      fetch('/api/set-line-position', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ newStart, newEnd, sourceLocation }),
      });
      return;
    }

    if (uniqueType === 'line-two-points') {
      const pointIndex = hitZone === 'start' ? 0 : -1;
      fetch('/api/update-position', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ newPosition: newPos, sourceLocation, pointIndex }),
      });
    } else if ((uniqueType === 'hline' || uniqueType === 'vline') && (hitZone === 'start' || hitZone === 'body')) {
      fetch('/api/update-position', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ newPosition: newPos, sourceLocation, pointIndex: 0 }),
      });
    } else {
      fetch('/api/update-position', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ newPosition: newPos, sourceLocation }),
      });
    }
  }

  private handleKeyDown(e: KeyboardEvent): void {
    if (e.key !== 'Escape') {
      return;
    }
    if (this._isResizing) {
      this.endResize();
    } else if (this.standaloneInputActive) {
      this.closeStandaloneInput();
    }
  }

  private handlePointerMove(e: PointerEvent): void {
    if (this.pendingHit && !this._isResizing) {
      const dx = e.clientX - this.pendingHit.clientX;
      const dy = e.clientY - this.pendingHit.clientY;
      if (dx * dx + dy * dy >= DRAG_THRESHOLD_PX * DRAG_THRESHOLD_PX) {
        const pending = this.pendingHit;
        this.pendingHit = null;
        this.startResize(pending);
      } else {
        return;
      }
    }

    if (!this._isResizing) {
      return;
    }

    const raw = projectToSketch(this.ctx, this.plane, e.clientX, e.clientY);
    if (!raw) {
      return;
    }

    this.hasMoved = true;
    if (this.grabOffset && this.hitResult?.hitZone === 'body') {
      const candidateAnchor: [number, number] = [
        raw[0] - this.grabOffset[0],
        raw[1] - this.grabOffset[1],
      ];
      const result = this.snapController.snap(candidateAnchor);
      this.currentPoint = result.point2d;
    } else {
      const result = this.snapController.snap(raw);
      this.currentPoint = result.point2d;
    }
    this.rebuildPreview();
    this.updateDimensionValue();
    this.expressionInput.updatePosition(e.clientX, e.clientY);
  }

  private showDimensionInputForDrag(clientX: number, clientY: number): void {
    if (!this.hitResult || !this.startPoint) {
      return;
    }
    const { uniqueType, hitZone } = this.hitResult;

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

    if (label === null) {
      return;
    }

    this.openDimensionInput(label, value, clientX, clientY);
  }

  private handleCanvasDoubleClick(e: MouseEvent): void {
    if (this._isResizing) {
      return;
    }
    const point2d = projectToSketch(this.ctx, this.plane, e.clientX, e.clientY);
    if (!point2d) {
      return;
    }
    const hit = this.findHitGeometry(point2d);
    if (!hit) {
      return;
    }
    if (hit.uniqueType === 'line-two-points') {
      return;
    }

    let label: string;
    let value: number;
    if (hit.uniqueType === 'circle') {
      label = '⌀';
      value = hit.initialValue ?? 0;
    } else if (hit.uniqueType === 'hline' || hit.uniqueType === 'vline') {
      label = hit.uniqueType === 'hline' ? 'H:' : 'V:';
      value = Math.abs(hit.initialValue ?? 0);
    } else {
      return;
    }

    this.hitResult = hit;
    this.startPoint = null;
    this.currentPoint = null;
    this.standaloneInputActive = true;
    this.openDimensionInput(label, value, e.clientX, e.clientY);
  }

  private openDimensionInput(label: string, value: number, clientX: number, clientY: number): void {
    if (!this.hitResult) {
      return;
    }
    const { sourceLocation } = this.hitResult;
    const numericFallback = String(value);

    this.expressionInput.show({
      label,
      value: numericFallback,
      clientX,
      clientY,
      variables: this.cachedVariables,
      onCommit: (result) => {
        if (!this.hitResult) {
          return;
        }
        const { expression, newVariable } = result;
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

        const sketchSourceLine = this.getSketchSourceLine();
        fetch('/api/update-dimension-expression', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            expression: finalExpr,
            sourceLocation: sl,
            sketchSourceLine,
            newVariable: newVariable ?? null,
          }),
        });
        if (this._isResizing) {
          this.endResize();
        } else {
          this.closeStandaloneInput();
        }
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
        if (!expression) {
          return;
        }
        if (this._isResizing && !this.hasMoved) {
          this.expressionInput.updateValue(expression);
        } else if (this.standaloneInputActive) {
          this.expressionInput.updateValue(expression);
        }
      });
  }

  private computeDistanceSign(): number {
    if (!this.hitResult) {
      return 1;
    }
    if (this.currentPoint) {
      const start = this.hitResult.anchorPoint!;
      if (this.hitResult.uniqueType === 'hline') {
        return this.currentPoint[0] >= start[0] ? 1 : -1;
      }
      return this.currentPoint[1] >= start[1] ? 1 : -1;
    }
    // Standalone mode (no drag): infer sign from the existing geometry.
    const dist = this.hitResult.initialValue ?? this.hitResult.originalDistance ?? 0;
    return dist >= 0 ? 1 : -1;
  }

  private updateDimensionValue(): void {
    if (!this.expressionInput.isVisible || !this.currentPoint || !this.hitResult) {
      return;
    }
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

  private closeStandaloneInput(): void {
    if (!this.standaloneInputActive) {
      return;
    }
    this.standaloneInputActive = false;
    this.hitResult = null;
    this.expressionInput.hide();
  }

  private endResize(): void {
    this._isResizing = false;
    this.hasMoved = false;
    this.hitResult = null;
    this.startPoint = null;
    this.currentPoint = null;
    this.grabOffset = null;
    this.pendingHit = null;
    this.ctx.cameraControls.enabled = true;
    this.canvas.style.cursor = '';
    this.snapController.setExcludedVertices([]);
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
            const uniqueVerts: [number, number][] = [];
            const DUP_EPS_SQ = 1e-6;
            for (const v of verts2d) {
              let isDup = false;
              for (const u of uniqueVerts) {
                const dx = u[0] - v[0];
                const dy = u[1] - v[1];
                if (dx * dx + dy * dy < DUP_EPS_SQ) {
                  isDup = true;
                  break;
                }
              }
              if (!isDup) {
                uniqueVerts.push(v);
              }
            }
            let cx = 0, cy = 0;
            for (const v of uniqueVerts) {
              cx += v[0];
              cy += v[1];
            }
            cx /= uniqueVerts.length;
            cy /= uniqueVerts.length;

            const sample = uniqueVerts[0];
            const sdx = sample[0] - cx;
            const sdy = sample[1] - cy;
            const radius = Math.sqrt(sdx * sdx + sdy * sdy);
            const diameter = Math.round(2 * radius * 100) / 100;

            for (const v of verts2d) {
              const ddx = v[0] - point2d[0];
              const ddy = v[1] - point2d[1];
              const d = ddx * ddx + ddy * ddy;
              if (d < thresholdSq && d < bestDistSq) {
                bestHit = {
                  sourceLocation, uniqueType, hitZone: 'body',
                  anchorPoint: [cx, cy],
                  initialValue: diameter,
                };
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
            const signedDist = isConstrained
              ? (uniqueType === 'hline' ? endV[0] - startV[0] : endV[1] - startV[1])
              : undefined;
            const initialValue = isConstrained
              ? Math.round((signedDist ?? 0) * 100) / 100
              : undefined;

            const nearAnyEndpoint = startDist < thresholdSq || endDist < thresholdSq;

            if (startDist < thresholdSq && startDist < bestDistSq && startDist <= endDist) {
              bestHit = {
                sourceLocation, uniqueType: uniqueType || '', hitZone: 'start',
                anchorPoint: startV, fixedVertex: endV,
                originalDistance: signedDist,
                initialValue,
                draggedVertices: [startV],
              };
              bestDistSq = startDist;
            }
            if (endDist < thresholdSq && endDist < bestDistSq && endDist < startDist) {
              bestHit = {
                sourceLocation, uniqueType: uniqueType || '', hitZone: 'end',
                anchorPoint: startV, fixedVertex: startV,
                initialValue,
                draggedVertices: [endV],
              };
              bestDistSq = endDist;
            }

            // Body hit only competes when the pointer is NOT within an
            // endpoint's hit radius — otherwise the perpendicular bodyDist
            // (often ~0) would beat the diagonal distance to a vertex even
            // when the user clearly clicked near the endpoint.
            if (!nearAnyEndpoint) {
              const bodyDist = pointToSegmentDist(
                point2d[0], point2d[1],
                startV[0], startV[1],
                endV[0], endV[1],
              );
              const bodyDistSq = bodyDist * bodyDist;
              if (bodyDistSq < thresholdSq && bodyDistSq < bestDistSq) {
                bestHit = {
                  sourceLocation,
                  uniqueType: uniqueType || '',
                  hitZone: 'body',
                  anchorPoint: startV,
                  fixedVertex: endV,
                  originalDistance: signedDist,
                  initialValue,
                  draggedVertices: [startV, endV],
                };
                bestDistSq = bodyDistSq;
              }
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

    if (!this.currentPoint || !this.hitResult) {
      return;
    }

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
    } else if (uniqueType === 'line-two-points' && fixedVertex && anchorPoint) {
      if (hitZone === 'body') {
        const dx = fixedVertex[0] - anchorPoint[0];
        const dy = fixedVertex[1] - anchorPoint[1];
        const newEnd: [number, number] = [this.currentPoint[0] + dx, this.currentPoint[1] + dy];
        this.addDot(this.currentPoint, START_DOT_COLOR, camera, planeNormal);
        this.addDashedLine(this.currentPoint, newEnd);
        this.addDot(newEnd, 0xffc578, camera, planeNormal);
      } else if (hitZone === 'start') {
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
