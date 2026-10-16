import { Vector3 } from 'three';
import { SketchTool, InsertGeometryFn, FetchVariablesFn, PickedPoint } from '../sketch-tool';
import { SceneContext } from '../../scene/scene-context';
import { PlaneData, SceneObjectRender, SourceLocation } from '../../types';
import { SnapController } from '../../snapping/snap-controller';
import { SnapManager } from '../../snapping/snap-manager';
import { SnapType, SolvedVertexRef } from '../../snapping/types';
import { projectToSketch, roundPoint } from '../sketch-plane-utils';
import type { CurveKind } from '../../sketch-solver-client';
import { refTarget } from './solved-emission';
import {
  START_POINT_COLOR,
  GUIDE_COLOR,
  snapDotColor,
  addDot,
} from './tool-preview-utils';
import { insertPoint } from '../../api';

/**
 * The click-per-point drawing tool shared by the Bezier and Spline tools:
 * the first click writes the statement with its first point (through the
 * legacy insert rail — the statement is an anchor-point statement, not a
 * solved emission entity), every later click appends a point to it
 * (`insertPoint`), and Escape leaves the tool. A snapped point gets a
 * `coincident(curve.point(i), <ref>)` through the solved rail. Subclasses
 * name the statement (`kind`) and draw the preview curve through the
 * points placed so far plus the cursor.
 */
export abstract class ControlPointCurveTool extends SketchTool {
  /** The statement callee and render type — `bezier` or `spline`. */
  protected abstract readonly kind: CurveKind;

  private activeSourceLocation: SourceLocation | null = null;
  private existingPoints: [number, number][] = [];
  private mousePoint: [number, number] | null = null;
  private lastSnapType: SnapType = 'none';
  private pendingFirstClick = false;
  private pendingStart: [number, number] | null = null;
  /** First-point snap ref, queued until a render adopts the statement (the
   * coincident needs its source line). */
  private pendingStartRef: SolvedVertexRef | null = null;
  /** Points inserted since the last scene sync — keeps the emitted
   * pointIndex right when clicks outpace renders. */
  private insertedSinceSync = 0;

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

  /**
   * The preview of the curve through `points` (the placed points plus the
   * cursor, two or more) — dashed, into `previewGroup`.
   */
  protected abstract drawPreviewCurve(points: [number, number][]): void;

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
    this.existingPoints = [];
    this.mousePoint = null;
    this.lastSnapType = 'none';
    this.pendingFirstClick = false;
    this.pendingStart = null;
    this.pendingStartRef = null;
    this.insertedSinceSync = 0;
    this.removePreviewFromScene();
  }

  override handleEscape(): boolean {
    return false;
  }

  onSceneUpdate(sceneObjects: SceneObjectRender[], sketchId: string): void {
    const snapManager = SnapManager.fromSceneObjects(sceneObjects, sketchId, this.plane, this.ctx);
    this.updateSnapManager(snapManager);

    // Only sync with a scene curve once the user has initiated drawing.
    // A fresh activation must wait for the first click.
    if (!this.activeSourceLocation && !this.pendingFirstClick) {
      this.rebuildPreview();
      return;
    }

    let lastCurve: SceneObjectRender | null = null;
    for (let i = sceneObjects.length - 1; i >= 0; i--) {
      const obj = sceneObjects[i];
      if (obj.parentId === sketchId && (obj as any).type === this.kind) {
        lastCurve = obj;
        break;
      }
    }

    if (lastCurve && lastCurve.sourceLocation) {
      const startPt = (lastCurve as any).object?.startPoint as [number, number] | null | undefined;
      const resolved = (lastCurve as any).object?.resolvedPoints as [number, number][] | undefined;
      this.activeSourceLocation = lastCurve.sourceLocation;
      this.existingPoints = startPt ? [startPt, ...(resolved ?? [])] : [];
      this.pendingFirstClick = false;
      this.pendingStart = null;
      this.insertedSinceSync = 0;
      // The first point's snap coincident waited for the statement's source
      // line — emit it now that a render adopted the statement.
      if (this.pendingStartRef) {
        const ref = this.pendingStartRef;
        this.pendingStartRef = null;
        this.emitSnapConstraint(0, ref);
      }
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
    const snapRef = this.autoConstraintsEnabled() ? result.ref ?? null : null;

    if (!this.activeSourceLocation) {
      this.startCurve(this.applyPointInput(result.point2d), snapRef);
      return;
    }

    // The point being added is the statement's next point-like argument —
    // count the points the last render showed plus any inserts still in
    // flight, so fast clicks keep their indices.
    const pointIndex = this.existingPoints.length + this.insertedSinceSync;
    insertPoint(point, this.activeSourceLocation);
    this.insertedSinceSync++;
    if (snapRef) {
      this.emitSnapConstraint(pointIndex, snapRef);
    }
  }

  /** Auto-constraint for a snapped point: `coincident(curve.point(i), <ref>)`
   * through the solved emission rail (constraints-only — the statement
   * itself grows through the legacy insert-point rail). */
  private emitSnapConstraint(pointIndex: number, ref: SolvedVertexRef): void {
    const loc = this.activeSourceLocation;
    if (!this.solvedCtx || !loc) {
      return;
    }
    void this.solvedCtx.emit({
      geometry: [],
      constraints: [{
        kind: 'coincident',
        targets: [
          {
            line: loc.line,
            ...(loc.occurrence !== undefined ? { occurrence: loc.occurrence } : {}),
            featureType: this.kind,
            pointIndex,
          },
          refTarget(ref),
        ],
        inferred: true,
      }],
    });
  }

  /** Only the first point: later points go through `insertPoint`, which
   * writes a bare position and has no way to carry a typed expression. */
  protected override awaitingPoint(): boolean {
    return !this.activeSourceLocation && !this.pendingFirstClick;
  }

  protected override onTypedPoint(point: PickedPoint): void {
    this.startCurve(point, null);
  }

  /** The curve statements have no cursor-relative form, so a relative pick
   * resolves to the absolute position its expressions already carry. A
   * snapped first point queues its coincident until a render adopts the
   * statement. */
  private startCurve(picked: PickedPoint, snapRef: SolvedVertexRef | null): void {
    this.insertGeometry(
      `${this.kind}(${this.formatPoint(picked)})`,
      picked.newVariables.length > 0 ? picked.newVariables : undefined,
    );
    this.pendingFirstClick = true;
    this.pendingStart = picked.value;
    this.pendingStartRef = snapRef;
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

    const allPoints: [number, number][] = [...this.existingPoints];
    if (allPoints.length === 0 && this.pendingStart) {
      allPoints.push(this.pendingStart);
    }
    if (this.mousePoint && (this.activeSourceLocation || this.pendingStart)) {
      allPoints.push(this.mousePoint);
    }

    if (allPoints.length >= 2) {
      this.drawPreviewCurve(allPoints);
    }

    for (let i = 0; i < allPoints.length; i++) {
      const color = i === 0 ? START_POINT_COLOR : GUIDE_COLOR;
      const opacity = i === 0 ? 1 : 0.85;
      addDot(this.previewGroup, allPoints[i], color, camera, planeNormal, this.plane, opacity);
    }

    if (this.mousePoint && this.lastSnapType !== 'none') {
      addDot(this.previewGroup, this.mousePoint, snapDotColor(this.lastSnapType), camera, planeNormal, this.plane, 0.6);
    }

    this.requestRender();
  }
}
