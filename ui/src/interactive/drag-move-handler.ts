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
import { pointToSegmentDist, isInteractiveSketchType } from './sketch-edge-utils';
import { ExpressionInput, VariableInfo } from '../ui/expression-input';
import { circumcenter, angleFromCenter, addDashedArc, isCCW } from './tools/tool-preview-utils';
import {
  setLinePosition,
  updatePosition,
  setChainPositions,
  updateDimensionExpression,
  getDimensionExpression,
} from '../api';
type GetSketchSourceLineFn = () => number | null;
import { FetchVariablesFn } from './sketch-tool';

type DragHitResult = {
  sourceLocation: { line: number; column: number };
  uniqueType: string;
  hitZone: 'start' | 'end' | 'body' | 'center';
  anchorPoint?: [number, number];
  fixedVertex?: [number, number];
  fixedVertex2?: [number, number];
  originalDistance?: number;
  initialValue?: number;
  draggedVertices?: [number, number][];
  arcCCW?: boolean;
  arcArgCount?: number;
  tangentDir?: [number, number];
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
      setLinePosition(newStart, newEnd, sourceLocation);
      return;
    }

    if (uniqueType === 'line-two-points') {
      const pointIndex = hitZone === 'start' ? 0 : -1;
      updatePosition(newPos, sourceLocation, pointIndex);
    } else if (uniqueType === 'arc' && anchorPoint && fixedVertex) {
      const isOnePoint = this.hitResult.arcArgCount === 2;
      const endIdx = isOnePoint ? 0 : 1;
      const centerIdx = isOnePoint ? 1 : 2;
      if (hitZone === 'center') {
        const startV = fixedVertex;
        const endV = this.hitResult.fixedVertex2!;
        const radius = Math.sqrt(
          (startV[0] - newPos[0]) ** 2 + (startV[1] - newPos[1]) ** 2,
        );
        const endAngle = Math.atan2(endV[1] - newPos[1], endV[0] - newPos[0]);
        const projectedEnd = roundPoint([
          newPos[0] + radius * Math.cos(endAngle),
          newPos[1] + radius * Math.sin(endAngle),
        ]);
        setChainPositions(
          [
            { pointIndex: endIdx, position: projectedEnd },
            { pointIndex: centerIdx, position: newPos },
          ],
          sourceLocation,
        );
      } else {
        const newCenter = roundPoint(this.computeArcCenter(anchorPoint, fixedVertex, newPos));
        const pointIndex = hitZone === 'start' ? 0 : endIdx;
        setChainPositions(
          [
            { pointIndex, position: newPos },
            { pointIndex: centerIdx, position: newCenter },
          ],
          sourceLocation,
        );
      }
    } else if ((uniqueType === 'hline' || uniqueType === 'vline') && (hitZone === 'start' || hitZone === 'body')) {
      updatePosition(newPos, sourceLocation, 0);
    } else if (uniqueType === 'tarc-to-point' || uniqueType === 'tarc-to-point-tangent') {
      const endIdx = uniqueType === 'tarc-to-point' ? 0 : 1;
      if (hitZone === 'center' && fixedVertex && this.hitResult.fixedVertex2) {
        const startV = fixedVertex;
        const oldEnd = this.hitResult.fixedVertex2;
        const radius = Math.sqrt(
          (startV[0] - newPos[0]) ** 2 + (startV[1] - newPos[1]) ** 2,
        );
        const endAngle = Math.atan2(oldEnd[1] - newPos[1], oldEnd[0] - newPos[0]);
        const projectedEnd = roundPoint([
          newPos[0] + radius * Math.cos(endAngle),
          newPos[1] + radius * Math.sin(endAngle),
        ]);
        updatePosition(projectedEnd, sourceLocation, endIdx);
      } else {
        updatePosition(newPos, sourceLocation, endIdx);
      }
    } else {
      updatePosition(newPos, sourceLocation);
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

    if (this.hitResult?.hitZone === 'start' && this.hitResult.anchorPoint
        && (this.hitResult.uniqueType === 'hline' || this.hitResult.uniqueType === 'vline')) {
      if (this.hitResult.uniqueType === 'hline') {
        this.currentPoint = [this.currentPoint[0], this.hitResult.anchorPoint[1]];
      } else {
        this.currentPoint = [this.hitResult.anchorPoint[0], this.currentPoint[1]];
      }
    }

    if (e.shiftKey && this.hitResult?.hitZone === 'center' && this.hitResult.uniqueType === 'arc') {
      this.currentPoint = this.constrainToPerpBisector(this.currentPoint);
    }

    if (this.hitResult?.hitZone === 'center' && this.hitResult.tangentDir && this.hitResult.fixedVertex) {
      this.currentPoint = this.constrainToTangentPerp(this.currentPoint, this.hitResult.fixedVertex, this.hitResult.tangentDir);
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
        updateDimensionExpression(finalExpr, sl, sketchSourceLine, newVariable);
        if (this._isResizing) {
          this.endResize();
        } else {
          this.closeStandaloneInput();
        }
      },
    });

    getDimensionExpression(sourceLocation.line).then(({ expression }) => {
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
      if (!child.sourceLocation || !isInteractiveSketchType(child.uniqueType)) {
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

            if (endDist < thresholdSq && endDist < bestDistSq) {
              bestHit = {
                sourceLocation, uniqueType: uniqueType || '', hitZone: 'end',
                anchorPoint: startV, fixedVertex: startV,
                initialValue,
                draggedVertices: [endV],
              };
              bestDistSq = endDist;
            }

            if (child.object?.hasExplicitStart === true
                && !(isConstrained && child.object?.centered === true)
                && startDist < thresholdSq && startDist < bestDistSq) {
              bestHit = {
                sourceLocation, uniqueType: uniqueType || '', hitZone: 'start',
                anchorPoint: startV, fixedVertex: endV,
                originalDistance: signedDist,
                draggedVertices: [startV],
              };
              bestDistSq = startDist;
            }

            // Body hit only competes when the pointer is NOT within an
            // endpoint's hit radius — otherwise the perpendicular bodyDist
            // (often ~0) would beat the diagonal distance to a vertex even
            // when the user clearly clicked near the endpoint.
            if (!nearAnyEndpoint && uniqueType === 'line-two-points') {
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
          } else if (uniqueType === 'arc' && verts2d.length >= 3) {
            const startV = verts2d[0];
            const endV = verts2d[verts2d.length - 1];
            const hasExplicitStart = child.object?.startPoint !== undefined;
            const arcArgCount = hasExplicitStart ? 3 : 2;

            let centerV: [number, number] | null = null;
            for (const sp of child.sceneShapes) {
              if (!sp.isMetaShape) {
                continue;
              }
              for (const md of sp.meshes) {
                if (md.vertices.length === 3 && md.indices.length === 0) {
                  const cv = this.meshToSketch2D(md.vertices);
                  if (cv.length === 1) {
                    centerV = cv[0];
                  }
                }
              }
            }

            if (!centerV) {
              const midV = verts2d[Math.floor(verts2d.length / 2)];
              centerV = circumcenter(startV, midV, endV);
            }

            if (centerV) {
              const midV = verts2d[Math.floor(verts2d.length / 2)];
              const arcCCW = isCCW(centerV, startV, midV);

              const sdx = startV[0] - point2d[0];
              const sdy = startV[1] - point2d[1];
              const startDist = sdx * sdx + sdy * sdy;

              const edx = endV[0] - point2d[0];
              const edy = endV[1] - point2d[1];
              const endDist = edx * edx + edy * edy;

              const cdx = centerV[0] - point2d[0];
              const cdy = centerV[1] - point2d[1];
              const centerDist = cdx * cdx + cdy * cdy;

              const minDist = Math.min(startDist, endDist, centerDist);

              if (hasExplicitStart && startDist < thresholdSq && startDist < bestDistSq && startDist === minDist) {
                bestHit = {
                  sourceLocation, uniqueType: 'arc', hitZone: 'start',
                  anchorPoint: centerV,
                  fixedVertex: endV,
                  draggedVertices: [startV],
                  arcCCW, arcArgCount,
                };
                bestDistSq = startDist;
              }
              if (endDist < thresholdSq && endDist < bestDistSq && endDist === minDist) {
                bestHit = {
                  sourceLocation, uniqueType: 'arc', hitZone: 'end',
                  anchorPoint: centerV,
                  fixedVertex: startV,
                  draggedVertices: [endV],
                  arcCCW, arcArgCount,
                };
                bestDistSq = endDist;
              }
              if (centerDist < thresholdSq && centerDist < bestDistSq && centerDist === minDist) {
                bestHit = {
                  sourceLocation, uniqueType: 'arc', hitZone: 'center',
                  anchorPoint: centerV,
                  fixedVertex: startV,
                  fixedVertex2: endV,
                  draggedVertices: [centerV],
                  arcCCW, arcArgCount,
                };
                bestDistSq = centerDist;
              }
            }
          } else if ((uniqueType === 'tarc-to-point' || uniqueType === 'tarc-to-point-tangent') && verts2d.length >= 2) {
            const startV = verts2d[0];
            const endV = verts2d[verts2d.length - 1];

            const tdx = verts2d[1][0] - startV[0];
            const tdy = verts2d[1][1] - startV[1];
            const tlen = Math.sqrt(tdx * tdx + tdy * tdy);
            const tangent: [number, number] = tlen > 1e-10
              ? [tdx / tlen, tdy / tlen]
              : [1, 0];

            let centerV: [number, number] | null = null;
            for (const sp of child.sceneShapes) {
              if (!sp.isMetaShape) {
                continue;
              }
              for (const md of sp.meshes) {
                if (md.vertices.length === 3 && md.indices.length === 0) {
                  const cv = this.meshToSketch2D(md.vertices);
                  if (cv.length === 1) {
                    centerV = cv[0];
                  }
                }
              }
            }

            if (!centerV) {
              const midV = verts2d[Math.floor(verts2d.length / 2)];
              centerV = circumcenter(startV, midV, endV);
            }

            const midV = verts2d[Math.floor(verts2d.length / 2)];
            const arcCCW = centerV ? isCCW(centerV, startV, midV) : true;

            const edx = endV[0] - point2d[0];
            const edy = endV[1] - point2d[1];
            const endDist = edx * edx + edy * edy;

            if (endDist < thresholdSq && endDist < bestDistSq) {
              bestHit = {
                sourceLocation,
                uniqueType: uniqueType || '',
                hitZone: 'end',
                anchorPoint: startV,
                fixedVertex: startV,
                draggedVertices: [endV],
                tangentDir: tangent,
                arcCCW,
              };
              bestDistSq = endDist;
            }

            if (centerV) {
              const cdx = centerV[0] - point2d[0];
              const cdy = centerV[1] - point2d[1];
              const centerDist = cdx * cdx + cdy * cdy;

              if (centerDist < thresholdSq && centerDist < bestDistSq) {
                bestHit = {
                  sourceLocation,
                  uniqueType: uniqueType || '',
                  hitZone: 'center',
                  anchorPoint: startV,
                  fixedVertex: startV,
                  fixedVertex2: endV,
                  draggedVertices: [centerV],
                  tangentDir: tangent,
                  arcCCW,
                };
                bestDistSq = centerDist;
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

  private constrainToPerpBisector(point: [number, number]): [number, number] {
    if (!this.hitResult?.fixedVertex || !this.hitResult.fixedVertex2) {
      return point;
    }
    const startV = this.hitResult.fixedVertex;
    const endV = this.hitResult.fixedVertex2;
    const mx = (startV[0] + endV[0]) / 2;
    const my = (startV[1] + endV[1]) / 2;
    const dx = endV[0] - startV[0];
    const dy = endV[1] - startV[1];
    const px = -dy;
    const py = dx;
    const lenSq = px * px + py * py;
    if (lenSq < 1e-10) {
      return point;
    }
    const t = ((point[0] - mx) * px + (point[1] - my) * py) / lenSq;
    return [mx + t * px, my + t * py];
  }

  private constrainToTangentPerp(
    point: [number, number],
    startV: [number, number],
    tangent: [number, number],
  ): [number, number] {
    const px = -tangent[1];
    const py = tangent[0];
    const t = (point[0] - startV[0]) * px + (point[1] - startV[1]) * py;
    return [startV[0] + t * px, startV[1] + t * py];
  }

  private computeTangentArc(
    start: [number, number],
    end: [number, number],
    tangent: [number, number],
  ): { center: [number, number]; radius: number; startAngle: number; endAngle: number; ccw: boolean } | null {
    const perpX = -tangent[1];
    const perpY = tangent[0];
    const dx = start[0] - end[0];
    const dy = start[1] - end[1];
    const distSq = dx * dx + dy * dy;
    const dDotN = dx * perpX + dy * perpY;
    if (Math.abs(dDotN) < 1e-10) {
      return null;
    }
    const t = -distSq / (2 * dDotN);
    const radius = Math.abs(t);
    const center: [number, number] = [start[0] + perpX * t, start[1] + perpY * t];
    const startAngle = angleFromCenter(center, start);
    const endAngle = angleFromCenter(center, end);
    return { center, radius, startAngle, endAngle, ccw: t >= 0 };
  }

  private computeArcCenter(
    oldCenter: [number, number],
    pointA: [number, number],
    pointB: [number, number],
  ): [number, number] {
    const mx = (pointA[0] + pointB[0]) / 2;
    const my = (pointA[1] + pointB[1]) / 2;
    const dx = pointB[0] - pointA[0];
    const dy = pointB[1] - pointA[1];
    const px = -dy;
    const py = dx;
    const lenSq = px * px + py * py;
    if (lenSq < 1e-10) {
      return oldCenter;
    }
    const cx = oldCenter[0] - mx;
    const cy = oldCenter[1] - my;
    const t = (cx * px + cy * py) / lenSq;
    return [mx + t * px, my + t * py];
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
    } else if (uniqueType === 'arc' && anchorPoint && fixedVertex) {
      const ccw = this.hitResult.arcCCW !== false;
      if (hitZone === 'center') {
        const startV = fixedVertex;
        const endV = this.hitResult.fixedVertex2!;
        const center = this.currentPoint;
        const radius = Math.sqrt(
          (startV[0] - center[0]) ** 2 + (startV[1] - center[1]) ** 2,
        );
        const startAngle = angleFromCenter(center, startV);
        const endAngle = angleFromCenter(center, endV);
        const projectedEnd: [number, number] = [
          center[0] + radius * Math.cos(endAngle),
          center[1] + radius * Math.sin(endAngle),
        ];
        this.addDot(startV, START_DOT_COLOR, camera, planeNormal);
        addDashedArc(this.previewGroup, center, radius, startAngle, endAngle, ccw, this.plane, 5);
        this.addDot(projectedEnd, START_DOT_COLOR, camera, planeNormal);
        this.addDot(center, 0xffc578, camera, planeNormal);
      } else {
        const newCenter = this.computeArcCenter(anchorPoint, fixedVertex, this.currentPoint);
        const radius = Math.sqrt(
          (this.currentPoint[0] - newCenter[0]) ** 2 + (this.currentPoint[1] - newCenter[1]) ** 2,
        );
        if (hitZone === 'start') {
          const startAngle = angleFromCenter(newCenter, this.currentPoint);
          const endAngle = angleFromCenter(newCenter, fixedVertex);
          this.addDot(this.currentPoint, 0xffc578, camera, planeNormal);
          addDashedArc(this.previewGroup, newCenter, radius, startAngle, endAngle, ccw, this.plane, 5);
          this.addDot(fixedVertex, START_DOT_COLOR, camera, planeNormal);
        } else {
          const startAngle = angleFromCenter(newCenter, fixedVertex);
          const endAngle = angleFromCenter(newCenter, this.currentPoint);
          this.addDot(fixedVertex, START_DOT_COLOR, camera, planeNormal);
          addDashedArc(this.previewGroup, newCenter, radius, startAngle, endAngle, ccw, this.plane, 5);
          this.addDot(this.currentPoint, 0xffc578, camera, planeNormal);
        }
      }
    } else if ((uniqueType === 'tarc-to-point' || uniqueType === 'tarc-to-point-tangent') && fixedVertex && this.hitResult.tangentDir) {
      const startV = fixedVertex;
      const tangent = this.hitResult.tangentDir;
      if (hitZone === 'center') {
        const center = this.currentPoint;
        const endV = this.hitResult.fixedVertex2!;
        const radius = Math.sqrt(
          (startV[0] - center[0]) ** 2 + (startV[1] - center[1]) ** 2,
        );
        const startAngle = angleFromCenter(center, startV);
        const endAngle = angleFromCenter(center, endV);
        const ccw = this.hitResult.arcCCW !== false;
        const projectedEnd: [number, number] = [
          center[0] + radius * Math.cos(endAngle),
          center[1] + radius * Math.sin(endAngle),
        ];
        this.addDot(startV, START_DOT_COLOR, camera, planeNormal);
        addDashedArc(this.previewGroup, center, radius, startAngle, endAngle, ccw, this.plane, 5);
        this.addDot(projectedEnd, START_DOT_COLOR, camera, planeNormal);
        this.addDot(center, 0xffc578, camera, planeNormal);
      } else {
        const arc = this.computeTangentArc(startV, this.currentPoint, tangent);
        if (arc) {
          this.addDot(startV, START_DOT_COLOR, camera, planeNormal);
          addDashedArc(this.previewGroup, arc.center, arc.radius, arc.startAngle, arc.endAngle, arc.ccw, this.plane, 5);
          this.addDot(this.currentPoint, 0xffc578, camera, planeNormal);
        } else {
          this.addDot(startV, START_DOT_COLOR, camera, planeNormal);
          this.addDashedLine(startV, this.currentPoint);
          this.addDot(this.currentPoint, 0xffc578, camera, planeNormal);
        }
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
