import { Vector3 } from 'three';
import { SketchTool, InsertGeometryFn, FetchVariablesFn, PickedPoint } from '../sketch-tool';
import { SceneContext } from '../../scene/scene-context';
import { PlaneData, SceneObjectRender } from '../../types';
import { SnapController } from '../../snapping/snap-controller';
import { SnapManager } from '../../snapping/snap-manager';
import { SnapType, SolvedVertexRef } from '../../snapping/types';
import {
  projectToSketch,
  localToWorld,
  roundPoint,
  dist2D,
} from '../sketch-plane-utils';
import { ICON_THREE_POINT_ARC } from '../../ui/icons';
import { ExpressionInput, VariableInfo, CommitResult } from '../../ui/expression-input';
import {
  START_POINT_COLOR,
  GUIDE_COLOR,
  SNAP_VERTEX_COLOR,
  SNAP_GRID_COLOR,
  addDot,
  addDashedLine,
  addDashedArc,
  circumcenter,
  angleFromCenter,
  centerFromChordAndRadius,
} from './tool-preview-utils';
import { pixelsToWorld } from '../../meshes/screen-scale';
import { coincident, newTarget, refTarget, type SolvedConstraintParam } from './solved-emission';

const enum State {
  IDLE,
  START_PLACED,
  END_PLACED,
}

export class ThreePointArcTool extends SketchTool {
  readonly id = 'arc3' as const;
  readonly label = '3-Point Arc';
  readonly icon = ICON_THREE_POINT_ARC;

  private state: State = State.IDLE;
  private startPoint: [number, number] | null = null;
  /** The start as picked, carrying any typed axis expressions. */
  private startPick: PickedPoint | null = null;
  private endPoint: [number, number] | null = null;
  /** The end as picked, carrying any typed axis expressions. */
  private endPick: PickedPoint | null = null;
  /** Solved sketches: the two anchor clicks' snap provenance (start/end
   * coincidents on emission). The bulge click carries none — the center is
   * derived, never picked. */
  private startSnapRef: SolvedVertexRef | null = null;
  private endSnapRef: SolvedVertexRef | null = null;
  private mousePoint: [number, number] | null = null;
  private lastSnapType: SnapType = 'none';
  private expressionInput: ExpressionInput;
  private lastClientX = 0;
  private lastClientY = 0;
  private lastCCW = true;
  private lastCenterOnLeft = true;

  private shiftHeld = false;

  private boundMouseDown: (e: MouseEvent) => void;
  private boundMouseUp: (e: MouseEvent) => void;
  private boundMouseMove: (e: MouseEvent) => void;
  private boundKeyDown: (e: KeyboardEvent) => void;
  private boundKeyUp: (e: KeyboardEvent) => void;
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
    this.expressionInput = new ExpressionInput(container);
    this.boundMouseDown = this.handleMouseDown.bind(this);
    this.boundMouseUp = this.handleMouseUp.bind(this);
    this.boundMouseMove = this.handleMouseMove.bind(this);
    this.boundKeyDown = this.handleKeyDown.bind(this);
    this.boundKeyUp = this.handleKeyUp.bind(this);
  }

  protected onActivate(): void {
    this.addPreviewToScene();
    this.canvas.addEventListener('mousedown', this.boundMouseDown);
    this.canvas.addEventListener('mouseup', this.boundMouseUp);
    this.canvas.addEventListener('mousemove', this.boundMouseMove);
    window.addEventListener('keydown', this.boundKeyDown);
    window.addEventListener('keyup', this.boundKeyUp);
  }

  protected onDeactivate(): void {
    this.canvas.removeEventListener('mousedown', this.boundMouseDown);
    this.canvas.removeEventListener('mouseup', this.boundMouseUp);
    this.canvas.removeEventListener('mousemove', this.boundMouseMove);
    window.removeEventListener('keydown', this.boundKeyDown);
    window.removeEventListener('keyup', this.boundKeyUp);
    this.resetState();
    this.expressionInput.hide();
    this.removePreviewFromScene();
  }

  onSceneUpdate(sceneObjects: SceneObjectRender[], sketchId: string): void {
    const snapManager = SnapManager.fromSceneObjects(sceneObjects, sketchId, this.plane, this.ctx);
    this.updateSnapManager(snapManager);
    this.refreshVariables();
  }

  /** Both endpoints land in the source; the third click is a bulge, which
   * the expression input already covers. */
  protected override awaitingPoint(): boolean {
    return this.state === State.IDLE || this.state === State.START_PLACED;
  }

  protected override onTypedPoint(point: PickedPoint): void {
    this.consumePoint(point);
  }

  /** Single writer for both halves of each anchor, so the position the
   * preview draws and the expressions the statement emits cannot drift.
   * Clears the anchor's snap ref — the mouse pick path re-captures it right
   * after (typed picks never carry one). */
  private consumePoint(picked: PickedPoint): void {
    if (this.state === State.IDLE) {
      this.startPick = picked;
      this.startPoint = picked.value;
      this.startSnapRef = null;
      this.state = State.START_PLACED;
    } else if (this.state === State.START_PLACED) {
      if (dist2D(this.startPoint!, picked.value) <= 0) {
        return;
      }
      this.endPick = picked;
      this.endPoint = picked.value;
      this.endSnapRef = null;
      this.state = State.END_PLACED;
    }
    this.syncPointInput();
    this.rebuildPreview();
  }

  private resetState(): void {
    this.state = State.IDLE;
    this.startPoint = null;
    this.startPick = null;
    this.startSnapRef = null;
    this.endPoint = null;
    this.endPick = null;
    this.endSnapRef = null;
    this.mousePoint = null;
  }

  private handleMouseDown(e: MouseEvent): void {
    this.downX = e.clientX;
    this.downY = e.clientY;
  }

  private handleMouseUp(e: MouseEvent): void {
    this.shiftHeld = e.shiftKey;
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

    if (this.state === State.IDLE) {
      const picked = this.applyPointInput(result.point2d);
      this.consumePoint(picked);
      this.startSnapRef = !picked.typed && !(e.ctrlKey || e.metaKey) ? result.ref ?? null : null;
      return;
    }

    if (this.state === State.START_PLACED) {
      if (dist2D(this.startPoint!, point) <= 0) {
        return;
      }
      const picked = this.applyPointInput(result.point2d);
      this.consumePoint(picked);
      this.endSnapRef = !picked.typed && !(e.ctrlKey || e.metaKey) ? result.ref ?? null : null;
      return;
    }

    if (this.state === State.END_PLACED) {
      if (this.expressionInput.isVisible) {
        this.expressionInput.commitCurrentValue();
      } else {
        this.commitFromMouse();
      }
    }
  }

  private handleMouseMove(e: MouseEvent): void {
    this.shiftHeld = e.shiftKey;
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
    if (this.state === State.END_PLACED) {
      this.updateDimensionInput();
    }
  }

  private handleKeyDown(e: KeyboardEvent): void {
    if (e.key === 'Escape') {
      if (this.state === State.END_PLACED) {
        this.endPoint = null;
        this.endPick = null;
        this.endSnapRef = null;
        this.state = State.START_PLACED;
        this.expressionInput.hide();
      } else if (this.state === State.START_PLACED) {
        this.startPoint = null;
        this.startPick = null;
        this.startSnapRef = null;
        this.state = State.IDLE;
      }
      this.rebuildPreview();
    }
    if (e.key === 'Shift' && !this.shiftHeld) {
      this.shiftHeld = true;
      this.rebuildPreview();
      if (this.state === State.END_PLACED) {
        this.updateDimensionInput();
      }
    }
  }

  private handleKeyUp(e: KeyboardEvent): void {
    if (e.key === 'Shift' && this.shiftHeld) {
      this.shiftHeld = false;
      this.rebuildPreview();
      if (this.state === State.END_PLACED) {
        this.updateDimensionInput();
      }
    }
  }

  private snapCenterToCollinear(center: [number, number]): [number, number] | null {
    if (!this.startPoint || !this.endPoint) {
      return null;
    }
    const dx = this.endPoint[0] - this.startPoint[0];
    const dy = this.endPoint[1] - this.startPoint[1];
    const lenSq = dx * dx + dy * dy;
    if (lenSq < 1e-10) {
      return null;
    }
    const cx = center[0] - this.startPoint[0];
    const cy = center[1] - this.startPoint[1];
    const perpDist = Math.abs(cx * dy - cy * dx) / Math.sqrt(lenSq);

    const midWorld = localToWorld(
      [(this.startPoint[0] + this.endPoint[0]) / 2, (this.startPoint[1] + this.endPoint[1]) / 2],
      this.plane,
    );
    const threshold = pixelsToWorld(this.ctx.renderer, this.ctx.camera, midWorld, 10);

    if (perpDist >= threshold) {
      return null;
    }
    return [
      (this.startPoint[0] + this.endPoint[0]) / 2,
      (this.startPoint[1] + this.endPoint[1]) / 2,
    ];
  }

  private computeCenter(): [number, number] | null {
    if (!this.startPoint || !this.endPoint || !this.mousePoint) {
      return null;
    }
    const raw = circumcenter(this.startPoint, this.endPoint, this.mousePoint);
    if (!raw) {
      return null;
    }
    if (this.shiftHeld) {
      return raw;
    }
    return this.snapCenterToCollinear(raw) ?? raw;
  }

  private isMouseCCW(): boolean {
    if (!this.startPoint || !this.endPoint || !this.mousePoint) {
      return true;
    }
    const center = this.computeCenter();
    if (!center) {
      return true;
    }
    const startAngle = angleFromCenter(center, this.startPoint);
    const endAngle = angleFromCenter(center, this.endPoint);
    const mouseAngle = angleFromCenter(center, this.mousePoint);
    let startToMouse = mouseAngle - startAngle;
    if (startToMouse < 0) {
      startToMouse += Math.PI * 2;
    }
    let startToEnd = endAngle - startAngle;
    if (startToEnd < 0) {
      startToEnd += Math.PI * 2;
    }
    return startToMouse < startToEnd;
  }

  private updateDimensionInput(): void {
    const center = this.computeCenter();
    if (!center || !this.startPoint) {
      return;
    }

    const radius = Math.round(dist2D(center, this.startPoint) * 100) / 100;
    if (radius <= 0) {
      return;
    }

    this.lastCCW = this.isMouseCCW();
    const dx = this.endPoint![0] - this.startPoint![0];
    const dy = this.endPoint![1] - this.startPoint![1];
    const cx = center[0] - this.startPoint![0];
    const cy = center[1] - this.startPoint![1];
    this.lastCenterOnLeft = (dx * cy - dy * cx) > 0;

    if (!this.expressionInput.isVisible) {
      this.expressionInput.show({
        label: 'R',
        value: String(radius),
        clientX: this.lastClientX,
        clientY: this.lastClientY,
        variables: this.cachedVariables,
        numericOnly: true,
        onCommit: (result) => this.commitFromExpression(result),
      });
    } else {
      this.expressionInput.updateValue(radius);
      this.expressionInput.updatePosition(this.lastClientX, this.lastClientY);
    }
  }

  private commitFromMouse(): void {
    if (!this.startPoint || !this.endPoint) {
      return;
    }
    const center = this.computeCenter();
    if (!center) {
      return;
    }
    this.emitArc(this.startPick!, this.endPick!, center, this.isMouseCCW());
  }

  private commitFromExpression(result: CommitResult): void {
    if (!this.startPoint || !this.endPoint) {
      return;
    }
    const { expression, newVariable } = result;
    const num = parseFloat(expression);
    if (isNaN(num) || num <= 0) {
      return;
    }
    const center = centerFromChordAndRadius(this.startPoint, this.endPoint, num, this.lastCenterOnLeft);
    if (!center) {
      return;
    }
    this.emitArc(this.startPick!, this.endPick!, center, this.lastCCW, newVariable);
  }

  private emitArc(
    start: PickedPoint,
    end: PickedPoint,
    center: [number, number],
    ccw: boolean,
    newVariable?: { name: string; initializer: string },
  ): void {
    const rc = roundPoint(center);
    const cwSuffix = ccw ? '' : '.cw()';

    if (this.solvedCtx) {
      const startText = this.formatPoint(start.relative ? roundPoint(start.value) : start);
      const endText = this.formatPoint(end.relative ? roundPoint(end.value) : end);
      // Snap provenance on the two anchor clicks → coincidents (the
      // Auto-constraints toggle gates the inference; Ctrl suppressed the
      // capture per pick).
      const constraints: SolvedConstraintParam[] = [];
      if (this.autoConstraintsEnabled()) {
        if (this.startSnapRef) {
          constraints.push(coincident(newTarget(0, 'start'), refTarget(this.startSnapRef)));
        }
        if (this.endSnapRef
          && !(this.startSnapRef && this.endSnapRef.line === this.startSnapRef.line
            && this.endSnapRef.role === this.startSnapRef.role)) {
          constraints.push(coincident(newTarget(0, 'end'), refTarget(this.endSnapRef)));
        }
      }
      void this.solvedCtx.emit({
        geometry: [{
          kind: 'arc',
          text: `arc(${startText}, ${endText}, ${this.formatPoint(rc)})${cwSuffix}`,
        }],
        constraints,
        ...(start.newVariables.length + end.newVariables.length + (newVariable ? 1 : 0) > 0
          ? { newVariables: [...start.newVariables, ...end.newVariables, ...(newVariable ? [newVariable] : [])] }
          : {}),
      });
    } else {
      const suffix = `.center(${this.formatPoint(rc)})${cwSuffix}`;
      this.insertAtPoint(
        start,
        (point) => `arc(${point}, ${this.formatPoint(end)})${suffix}`,
        () => `arc(${this.formatPoint(end)})${suffix}`,
        [...end.newVariables, ...(newVariable ? [newVariable] : [])],
      );
    }
    this.expressionInput.hide();
    this.resetState();
    this.rebuildPreview();
  }

  private rebuildPreview(): void {
    this.disposePreview();

    const camera = this.ctx.camera;
    const planeNormal = new Vector3(this.plane.normal.x, this.plane.normal.y, this.plane.normal.z);

    if (this.state === State.IDLE) {
      if (this.mousePoint && this.lastSnapType !== 'none') {
        const color = this.lastSnapType === 'vertex' ? SNAP_VERTEX_COLOR : SNAP_GRID_COLOR;
        addDot(this.previewGroup, this.mousePoint, color, camera, planeNormal, this.plane, 0.6);
      }
    } else if (this.state === State.START_PLACED) {
      addDot(this.previewGroup, this.startPoint!, START_POINT_COLOR, camera, planeNormal, this.plane);
      if (this.mousePoint && this.lastSnapType !== 'none') {
        const color = this.lastSnapType === 'vertex' ? SNAP_VERTEX_COLOR : SNAP_GRID_COLOR;
        addDot(this.previewGroup, this.mousePoint, color, camera, planeNormal, this.plane, 0.6);
      }
    } else if (this.state === State.END_PLACED && this.startPoint && this.endPoint) {
      addDot(this.previewGroup, this.startPoint, START_POINT_COLOR, camera, planeNormal, this.plane);
      addDot(this.previewGroup, this.endPoint, START_POINT_COLOR, camera, planeNormal, this.plane);

      addDashedLine(this.previewGroup, this.startPoint, this.endPoint, this.plane);

      if (this.mousePoint) {
        const center = this.computeCenter();
        if (center) {
          const radius = dist2D(center, this.startPoint);
          const startAngle = angleFromCenter(center, this.startPoint);
          const endAngle = angleFromCenter(center, this.endPoint);
          const ccw = this.isMouseCCW();
          addDashedArc(this.previewGroup, center, radius, startAngle, endAngle, ccw, this.plane);
          addDot(this.previewGroup, center, GUIDE_COLOR, camera, planeNormal, this.plane, 0.7);
          addDashedLine(this.previewGroup, center, this.startPoint, this.plane);
          addDashedLine(this.previewGroup, center, this.endPoint, this.plane);
        }

        if (this.lastSnapType !== 'none') {
          const color = this.lastSnapType === 'vertex' ? SNAP_VERTEX_COLOR : SNAP_GRID_COLOR;
          addDot(this.previewGroup, this.mousePoint, color, camera, planeNormal, this.plane, 0.6);
        }
      }
    }

    this.requestRender();
  }
}
