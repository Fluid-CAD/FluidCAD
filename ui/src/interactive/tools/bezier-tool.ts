import { Vector3 } from 'three';
import { SketchTool, InsertGeometryFn, FetchVariablesFn, PickedPoint } from '../sketch-tool';
import { SceneContext } from '../../scene/scene-context';
import { PlaneData, SceneObjectRender } from '../../types';
import { SnapController } from '../../snapping/snap-controller';
import { SnapManager } from '../../snapping/snap-manager';
import { SnapType } from '../../snapping/types';
import { projectToSketch, roundPoint } from '../sketch-plane-utils';
import { ICON_BEZIER } from '../../ui/icons';
import {
  START_POINT_COLOR,
  GUIDE_COLOR,
  snapDotColor,
  addDot,
  addDashedLine,
  addDashedBezier,
} from './tool-preview-utils';
import { insertPoint } from '../../api';

type SourceLocation = { filePath: string; line: number; column: number };

export class BezierTool extends SketchTool {
  readonly id = 'bezier' as const;
  readonly label = 'Bezier';
  readonly icon = ICON_BEZIER;

  private activeSourceLocation: SourceLocation | null = null;
  private existingPoles: [number, number][] = [];
  private mousePoint: [number, number] | null = null;
  private lastSnapType: SnapType = 'none';
  private pendingFirstClick = false;
  private pendingStart: [number, number] | null = null;

  private boundMouseDown: (e: MouseEvent) => void;
  private boundMouseUp: (e: MouseEvent) => void;
  private boundMouseMove: (e: MouseEvent) => void;
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
    super(ctx, plane, snapController, insertGeometry, container, fetchVariables);
    this.boundMouseDown = this.handleMouseDown.bind(this);
    this.boundMouseUp = this.handleMouseUp.bind(this);
    this.boundMouseMove = this.handleMouseMove.bind(this);
  }

  protected onActivate(): void {
    this.addPreviewToScene();
    this.canvas.addEventListener('mousedown', this.boundMouseDown);
    this.canvas.addEventListener('mouseup', this.boundMouseUp);
    this.canvas.addEventListener('mousemove', this.boundMouseMove);
  }

  protected onDeactivate(): void {
    this.canvas.removeEventListener('mousedown', this.boundMouseDown);
    this.canvas.removeEventListener('mouseup', this.boundMouseUp);
    this.canvas.removeEventListener('mousemove', this.boundMouseMove);
    this.activeSourceLocation = null;
    this.existingPoles = [];
    this.mousePoint = null;
    this.lastSnapType = 'none';
    this.pendingFirstClick = false;
    this.pendingStart = null;
    this.removePreviewFromScene();
  }

  override handleEscape(): boolean {
    return false;
  }

  onSceneUpdate(sceneObjects: SceneObjectRender[], sketchId: string): void {
    const snapManager = SnapManager.fromSceneObjects(sceneObjects, sketchId, this.plane, this.ctx);
    this.updateSnapManager(snapManager);

    // Only sync with a scene bezier once the user has initiated drawing.
    // A fresh activation must wait for the first click.
    if (!this.activeSourceLocation && !this.pendingFirstClick) {
      this.rebuildPreview();
      return;
    }

    let lastBezier: SceneObjectRender | null = null;
    for (let i = sceneObjects.length - 1; i >= 0; i--) {
      const obj = sceneObjects[i];
      if (obj.parentId === sketchId && (obj as any).type === 'bezier') {
        lastBezier = obj;
        break;
      }
    }

    if (lastBezier && lastBezier.sourceLocation) {
      const startPt = (lastBezier as any).object?.startPoint as [number, number] | null | undefined;
      const resolved = (lastBezier as any).object?.resolvedPoints as [number, number][] | undefined;
      this.activeSourceLocation = lastBezier.sourceLocation;
      this.existingPoles = startPt ? [startPt, ...(resolved ?? [])] : [];
      this.pendingFirstClick = false;
      this.pendingStart = null;
    }

    this.rebuildPreview();
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

    if (this.pendingFirstClick) {
      return;
    }

    const raw = projectToSketch(this.ctx, this.plane, e.clientX, e.clientY);
    if (!raw) {
      return;
    }

    const result = this.snapController.snap(raw);
    const point = roundPoint(result.point2d);

    if (!this.activeSourceLocation) {
      this.startCurve(this.applyPointInput(result.point2d));
      return;
    }

    insertPoint(point, this.activeSourceLocation);
  }

  /** Only the first pole: later poles go through `insertPoint`, which writes
   * a bare position and has no way to carry a typed expression. */
  protected override awaitingPoint(): boolean {
    return !this.activeSourceLocation && !this.pendingFirstClick;
  }

  protected override onTypedPoint(point: PickedPoint): void {
    this.startCurve(point);
  }

  /** `bezier()` has no cursor-relative form, so a relative pick resolves to
   * the absolute position its expressions already carry. */
  private startCurve(picked: PickedPoint): void {
    this.insertGeometry(
      `bezier(${this.formatPoint(picked)})`,
      picked.newVariables.length > 0 ? picked.newVariables : undefined,
    );
    this.pendingFirstClick = true;
    this.pendingStart = picked.value;
    this.syncPointInput();
    this.rebuildPreview();
  }

  private handleMouseMove(e: MouseEvent): void {
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
  }

  private rebuildPreview(): void {
    this.disposePreview();

    const camera = this.ctx.camera;
    const planeNormal = new Vector3(this.plane.normal.x, this.plane.normal.y, this.plane.normal.z);

    const allPoles: [number, number][] = [...this.existingPoles];
    if (allPoles.length === 0 && this.pendingStart) {
      allPoles.push(this.pendingStart);
    }
    if (this.mousePoint && (this.activeSourceLocation || this.pendingStart)) {
      allPoles.push(this.mousePoint);
    }

    if (allPoles.length >= 2) {
      for (let i = 1; i < allPoles.length; i++) {
        addDashedLine(this.previewGroup, allPoles[i - 1], allPoles[i], this.plane);
      }
      addDashedBezier(this.previewGroup, allPoles, this.plane);
    }

    for (let i = 0; i < allPoles.length; i++) {
      const color = i === 0 ? START_POINT_COLOR : GUIDE_COLOR;
      const opacity = i === 0 ? 1 : 0.85;
      addDot(this.previewGroup, allPoles[i], color, camera, planeNormal, this.plane, opacity);
    }

    if (this.mousePoint && this.lastSnapType !== 'none') {
      addDot(this.previewGroup, this.mousePoint, snapDotColor(this.lastSnapType), camera, planeNormal, this.plane, 0.6);
    }

    this.requestRender();
  }
}
