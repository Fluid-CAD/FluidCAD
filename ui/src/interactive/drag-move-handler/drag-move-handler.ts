import { Group } from 'three';
import { SceneContext } from '../../scene/scene-context';
import { PlaneData, SceneObjectRender } from '../../types';
import { SnapController } from '../../snapping/snap-controller';
import { projectToSketch } from '../sketch-plane-utils';
import { FetchVariablesFn } from '../sketch-tool';
import { findHitGeometry } from './hit-detection';
import { rebuildDragPreview, disposePreviewGroup } from './drag-preview';
import { commitPositionMove } from './commit-position';
import { DimensionInputController } from './dimension-input';
import {
  constrainToPerpBisector,
  constrainToTangentPerp,
} from './constraint-math';
import {
  DragHitResult,
  PendingHit,
  GetSketchSourceLineFn,
  DRAG_THRESHOLD_PX,
} from './types';

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

  private dimensionInput: DimensionInputController;
  private getSketchSourceLine: GetSketchSourceLineFn;

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
    this.getSketchSourceLine = getSketchSourceLine;

    this.previewGroup = new Group();
    this.previewGroup.userData.isMetaShape = true;
    this.previewGroup.renderOrder = 5;

    this.dimensionInput = new DimensionInputController(container, fetchVariables, getSketchSourceLine);
    this.dimensionInput.onRequestEndResize = () => this.endResize();
    this.dimensionInput.onRequestCloseStandalone = () => {
      this.dimensionInput.closeStandalone();
      this.hitResult = null;
    };

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
    this.dimensionInput.closeStandalone();
    this.pendingHit = null;
    this.ctx.scene.remove(this.previewGroup);
    disposePreviewGroup(this.previewGroup);
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
    this.dimensionInput.refreshVariables();
  }

  private handleCanvasPointerDown(e: PointerEvent): void {
    if (e.button !== 0 || this._isResizing) {
      return;
    }
    if (this.dimensionInput.standaloneInputActive && this.dimensionInput.containsElement(e.target)) {
      return;
    }

    const point2d = projectToSketch(this.ctx, this.plane, e.clientX, e.clientY);
    if (!point2d) {
      return;
    }

    const hit = findHitGeometry(point2d, this.sceneObjects, this.sketchId, this.plane, this.ctx);
    if (!hit) {
      return;
    }

    this.pendingHit = {
      hit,
      point2d,
      clientX: e.clientX,
      clientY: e.clientY,
    };
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
    this.dimensionInput.showForDrag(hit, pending.point2d, pending.clientX, pending.clientY);
  }

  private commitResize(): void {
    if (this.dimensionInput.isVisible && this.hasMoved) {
      this.dimensionInput.commitIfVisible(this.hasMoved);
    } else if (this.currentPoint && this.hitResult) {
      commitPositionMove(this.currentPoint, this.hitResult, this.getSketchSourceLine);
    }
    this.endResize();
  }

  private handleKeyDown(e: KeyboardEvent): void {
    if (e.key !== 'Escape') {
      return;
    }
    if (this._isResizing) {
      this.endResize();
    } else if (this.dimensionInput.standaloneInputActive) {
      this.dimensionInput.closeStandalone();
      this.hitResult = null;
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

    if (this.hitResult?.uniqueType === 'tline' && this.hitResult.hitZone === 'end'
        && this.hitResult.anchorPoint && this.hitResult.tangentDir) {
      const start = this.hitResult.anchorPoint;
      const t = this.hitResult.tangentDir;
      const dx = this.currentPoint[0] - start[0];
      const dy = this.currentPoint[1] - start[1];
      const proj = dx * t[0] + dy * t[1];
      this.currentPoint = [start[0] + t[0] * proj, start[1] + t[1] * proj];
    }

    if (this.hitResult?.hitZone === 'center' && this.hitResult.uniqueType === 'arc'
        && this.hitResult.fixedVertex && this.hitResult.fixedVertex2) {
      if (e.shiftKey) {
        this.currentPoint = constrainToPerpBisector(this.currentPoint, this.hitResult.fixedVertex, this.hitResult.fixedVertex2);
      }
    }

    if (this.hitResult?.hitZone === 'center' && this.hitResult.tangentDir && this.hitResult.fixedVertex) {
      this.currentPoint = constrainToTangentPerp(this.currentPoint, this.hitResult.fixedVertex, this.hitResult.tangentDir);
    }

    if (this.hitResult?.uniqueType === 'slot' && !this.hitResult.slotHasTwoPoints
        && (this.hitResult.hitZone === 'start' || this.hitResult.hitZone === 'end')
        && this.hitResult.slotAxisDir && this.hitResult.slotOtherCenter) {
      const dir = this.hitResult.slotAxisDir;
      const other = this.hitResult.slotOtherCenter;
      const ddx = this.currentPoint[0] - other[0];
      const ddy = this.currentPoint[1] - other[1];
      const proj = ddx * dir[0] + ddy * dir[1];
      this.currentPoint = [other[0] + dir[0] * proj, other[1] + dir[1] * proj];
    }

    disposePreviewGroup(this.previewGroup);
    if (this.currentPoint && this.hitResult) {
      rebuildDragPreview(this.previewGroup, this.currentPoint, this.startPoint, this.hitResult, this.ctx.camera, this.plane);
    }
    this.ctx.requestRender();

    if (this.currentPoint && this.hitResult) {
      this.dimensionInput.updateValue(this.hitResult, this.currentPoint);
    }
    this.dimensionInput.updatePosition(e.clientX, e.clientY);
  }

  private handleCanvasDoubleClick(e: MouseEvent): void {
    if (this._isResizing) {
      return;
    }
    const point2d = projectToSketch(this.ctx, this.plane, e.clientX, e.clientY);
    if (!point2d) {
      return;
    }
    const hit = findHitGeometry(point2d, this.sceneObjects, this.sketchId, this.plane, this.ctx);
    if (!hit) {
      return;
    }
    if (hit.uniqueType === 'line-two-points') {
      return;
    }

    this.hitResult = hit;
    this.startPoint = null;
    this.currentPoint = null;
    if (!this.dimensionInput.showForDoubleClick(hit, e.clientX, e.clientY)) {
      this.hitResult = null;
    }
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
    this.dimensionInput.hide();
    disposePreviewGroup(this.previewGroup);
    this.ctx.requestRender();
  }
}
