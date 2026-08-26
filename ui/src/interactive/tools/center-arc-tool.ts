import { Vector3 } from 'three';
import { SketchTool, InsertGeometryFn, FetchVariablesFn, PickedPoint } from '../sketch-tool';
import { SceneContext } from '../../scene/scene-context';
import { PlaneData, SceneObjectRender } from '../../types';
import { SnapController } from '../../snapping/snap-controller';
import { SnapManager } from '../../snapping/snap-manager';
import { SnapType, SolvedVertexRef } from '../../snapping/types';
import {
  projectToSketch,
  roundPoint,
  dist2D,
} from '../sketch-plane-utils';
import { ICON_CENTER_ARC } from '../../ui/icons';
import { ExpressionInput, VariableInfo, CommitResult } from '../../ui/expression-input';
import {
  START_POINT_COLOR,
  SNAP_VERTEX_COLOR,
  SNAP_GRID_COLOR,
  addDot,
  addDashedLine,
  addDashedArc,
  angleFromCenter,
  pointOnCircle,
  isCCW,
} from './tool-preview-utils';
import { coincident, newTarget, refTarget, type SolvedConstraintParam } from './solved-emission';

const enum State {
  IDLE,
  CENTER_PLACED,
  START_PLACED,
}

export class CenterArcTool extends SketchTool {
  readonly id = 'arc2' as const;
  readonly label = 'Center Arc';
  readonly icon = ICON_CENTER_ARC;

  private state: State = State.IDLE;
  private centerPoint: [number, number] | null = null;
  /** The centre as picked, carrying any typed axis expressions. */
  private centerPick: PickedPoint | null = null;
  private startPoint: [number, number] | null = null;
  /** The start as picked, carrying any typed axis expressions. */
  private startPick: PickedPoint | null = null;
  /** Solved sketches: the two anchor clicks' snap provenance (center/start
   * coincidents on emission). */
  private centerSnapRef: SolvedVertexRef | null = null;
  private startSnapRef: SolvedVertexRef | null = null;
  /** The cursor's snap provenance — the sweep click's endpoint coincident,
   * valid only when the on-circle projection kept the snapped position. */
  private lastSnapRef: SolvedVertexRef | null = null;
  private mousePoint: [number, number] | null = null;
  private lastSnapType: SnapType = 'none';
  private expressionInput: ExpressionInput;
  private lastClientX = 0;
  private lastClientY = 0;
  private lastCCW = true;

  private boundMouseDown: (e: MouseEvent) => void;
  private boundMouseUp: (e: MouseEvent) => void;
  private boundMouseMove: (e: MouseEvent) => void;
  private boundKeyDown: (e: KeyboardEvent) => void;
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
  }

  protected onActivate(): void {
    this.addPreviewToScene();
    this.canvas.addEventListener('mousedown', this.boundMouseDown);
    this.canvas.addEventListener('mouseup', this.boundMouseUp);
    this.canvas.addEventListener('mousemove', this.boundMouseMove);
    window.addEventListener('keydown', this.boundKeyDown);
  }

  protected onDeactivate(): void {
    this.canvas.removeEventListener('mousedown', this.boundMouseDown);
    this.canvas.removeEventListener('mouseup', this.boundMouseUp);
    this.canvas.removeEventListener('mousemove', this.boundMouseMove);
    window.removeEventListener('keydown', this.boundKeyDown);
    this.resetState();
    this.expressionInput.hide();
    this.removePreviewFromScene();
  }

  onSceneUpdate(sceneObjects: SceneObjectRender[], sketchId: string): void {
    const snapManager = SnapManager.fromSceneObjects(sceneObjects, sketchId, this.plane, this.ctx);
    this.updateSnapManager(snapManager);
    this.refreshVariables();
  }

  /** Both the centre and the start land in the source — the centre inside
   * `.center(...)`, the start as the arc's own position. The third click is
   * an angle, which the expression input already covers. */
  protected override awaitingPoint(): boolean {
    return this.state === State.IDLE || this.state === State.CENTER_PLACED;
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
      this.centerPick = picked;
      this.centerPoint = picked.value;
      this.centerSnapRef = null;
      this.state = State.CENTER_PLACED;
    } else if (this.state === State.CENTER_PLACED) {
      if (dist2D(this.centerPoint!, picked.value) <= 0) {
        return;
      }
      this.startPick = picked;
      this.startPoint = picked.value;
      this.startSnapRef = null;
      this.state = State.START_PLACED;
    }
    this.syncPointInput();
    this.rebuildPreview();
  }

  private resetState(): void {
    this.state = State.IDLE;
    this.centerPoint = null;
    this.centerPick = null;
    this.centerSnapRef = null;
    this.startPoint = null;
    this.startPick = null;
    this.startSnapRef = null;
    this.lastSnapRef = null;
    this.mousePoint = null;
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

    const raw = projectToSketch(this.ctx, this.plane, e.clientX, e.clientY);
    if (!raw) {
      return;
    }

    const result = this.snapController.snap(raw);
    const point = roundPoint(result.point2d);

    if (this.state === State.IDLE) {
      const picked = this.applyPointInput(result.point2d);
      this.consumePoint(picked);
      this.centerSnapRef = !picked.typed && !(e.ctrlKey || e.metaKey) ? result.ref ?? null : null;
      return;
    }

    if (this.state === State.CENTER_PLACED) {
      if (dist2D(this.centerPoint!, point) <= 0) {
        return;
      }
      const picked = this.applyPointInput(result.point2d);
      this.consumePoint(picked);
      this.startSnapRef = !picked.typed && !(e.ctrlKey || e.metaKey) ? result.ref ?? null : null;
      return;
    }

    if (this.state === State.START_PLACED) {
      if (this.expressionInput.isVisible) {
        this.expressionInput.commitCurrentValue();
      } else {
        this.commitFromMouse(e.ctrlKey || e.metaKey);
      }
    }
  }

  private handleMouseMove(e: MouseEvent): void {
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
    this.lastSnapRef = result.ref ?? null;
    this.rebuildPreview();
    if (this.state === State.START_PLACED) {
      this.updateDimensionInput();
    }
  }

  private handleKeyDown(e: KeyboardEvent): void {
    if (e.key === 'Escape') {
      if (this.state === State.START_PLACED) {
        this.startPoint = null;
        this.startPick = null;
        this.startSnapRef = null;
        this.state = State.CENTER_PLACED;
        this.expressionInput.hide();
      } else if (this.state === State.CENTER_PLACED) {
        this.centerPoint = null;
        this.centerPick = null;
        this.centerSnapRef = null;
        this.state = State.IDLE;
      }
      this.rebuildPreview();
    }
  }

  private getSweepDeg(): number | null {
    if (!this.centerPoint || !this.startPoint || !this.mousePoint) {
      return null;
    }
    const startAngle = angleFromCenter(this.centerPoint, this.startPoint);
    const mouseAngle = angleFromCenter(this.centerPoint, this.mousePoint);
    this.lastCCW = isCCW(this.centerPoint, this.startPoint, this.mousePoint);
    let sweep: number;
    if (this.lastCCW) {
      sweep = mouseAngle - startAngle;
      if (sweep <= 0) {
        sweep += Math.PI * 2;
      }
    } else {
      sweep = startAngle - mouseAngle;
      if (sweep <= 0) {
        sweep += Math.PI * 2;
      }
    }
    if (sweep === 0) {
      return null;
    }
    return Math.round(sweep * (180 / Math.PI) * 100) / 100;
  }

  private updateDimensionInput(): void {
    const sweepDeg = this.getSweepDeg();
    if (sweepDeg === null || sweepDeg <= 0) {
      return;
    }

    if (!this.expressionInput.isVisible) {
      this.expressionInput.show({
        label: '∠',
        value: String(sweepDeg),
        clientX: this.lastClientX,
        clientY: this.lastClientY,
        variables: this.cachedVariables,
        numericOnly: true,
        onCommit: (result) => this.commitFromExpression(result),
      });
    } else {
      this.expressionInput.updateValue(sweepDeg);
      this.expressionInput.updatePosition(this.lastClientX, this.lastClientY);
    }
  }

  private commitFromMouse(suppressEndRef: boolean): void {
    if (!this.centerPoint || !this.startPoint || !this.mousePoint) {
      return;
    }
    const ccw = isCCW(this.centerPoint, this.startPoint, this.mousePoint);
    const radius = dist2D(this.centerPoint, this.startPoint);
    const endAngle = angleFromCenter(this.centerPoint, this.mousePoint);
    const endPoint = pointOnCircle(this.centerPoint, radius, endAngle);
    // The end coincident only holds when the on-circle projection didn't
    // move the endpoint off the snapped vertex.
    const endRef = !suppressEndRef && this.lastSnapRef
      && dist2D(endPoint, this.mousePoint) < 1e-6
      ? this.lastSnapRef : null;
    this.emitArc(this.startPick!, endPoint, this.centerPick!, ccw, undefined, endRef);
  }

  private commitFromExpression(result: CommitResult): void {
    if (!this.centerPoint || !this.startPoint) {
      return;
    }
    const { expression, newVariable } = result;
    const num = parseFloat(expression);
    if (isNaN(num) || num <= 0) {
      return;
    }
    const sweepRad = num * (Math.PI / 180);
    const radius = dist2D(this.centerPoint, this.startPoint);
    const startAngle = angleFromCenter(this.centerPoint, this.startPoint);
    const direction = this.lastCCW ? 1 : -1;
    const endAngle = startAngle + direction * sweepRad;
    const endPoint = pointOnCircle(this.centerPoint, radius, endAngle);
    this.emitArc(this.startPick!, endPoint, this.centerPick!, this.lastCCW, newVariable);
  }

  private emitArc(
    start: PickedPoint,
    end: [number, number],
    center: PickedPoint,
    ccw: boolean,
    newVariable?: { name: string; initializer: string },
    endRef: SolvedVertexRef | null = null,
  ): void {
    const re = roundPoint(end);
    const cwSuffix = ccw ? '' : '.cw()';

    if (this.solvedCtx) {
      const startText = this.formatPoint(start.relative ? roundPoint(start.value) : start);
      const centerText = this.formatPoint(center.relative ? roundPoint(center.value) : center);
      // Snap provenance on the picks → coincidents (the Auto-constraints
      // toggle gates the inference; Ctrl suppressed each capture).
      const constraints: SolvedConstraintParam[] = [];
      if (this.autoConstraintsEnabled()) {
        if (this.centerSnapRef) {
          constraints.push(coincident(newTarget(0, 'center'), refTarget(this.centerSnapRef)));
        }
        if (this.startSnapRef) {
          constraints.push(coincident(newTarget(0, 'start'), refTarget(this.startSnapRef)));
        }
        if (endRef
          && !(this.startSnapRef && endRef.line === this.startSnapRef.line
            && endRef.role === this.startSnapRef.role)) {
          constraints.push(coincident(newTarget(0, 'end'), refTarget(endRef)));
        }
      }
      void this.solvedCtx.emit({
        geometry: [{
          kind: 'arc',
          text: `arc(${startText}, ${this.formatPoint(re)}, ${centerText})${cwSuffix}`,
        }],
        constraints,
        ...(start.newVariables.length + center.newVariables.length + (newVariable ? 1 : 0) > 0
          ? { newVariables: [...start.newVariables, ...center.newVariables, ...(newVariable ? [newVariable] : [])] }
          : {}),
      });
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
    } else if (this.state === State.CENTER_PLACED) {
      addDot(this.previewGroup, this.centerPoint!, START_POINT_COLOR, camera, planeNormal, this.plane);
      if (this.mousePoint && this.lastSnapType !== 'none') {
        const color = this.lastSnapType === 'vertex' ? SNAP_VERTEX_COLOR : SNAP_GRID_COLOR;
        addDot(this.previewGroup, this.mousePoint, color, camera, planeNormal, this.plane, 0.6);
      }
    } else if (this.state === State.START_PLACED && this.centerPoint && this.startPoint) {
      addDot(this.previewGroup, this.centerPoint, START_POINT_COLOR, camera, planeNormal, this.plane);
      addDot(this.previewGroup, this.startPoint, START_POINT_COLOR, camera, planeNormal, this.plane);

      addDashedLine(this.previewGroup, this.centerPoint, this.startPoint, this.plane);

      if (this.mousePoint) {
        const radius = dist2D(this.centerPoint, this.startPoint);
        const startAngle = angleFromCenter(this.centerPoint, this.startPoint);
        const mouseAngle = angleFromCenter(this.centerPoint, this.mousePoint);
        const endPointOnCircle = pointOnCircle(this.centerPoint, radius, mouseAngle);

        addDashedLine(this.previewGroup, this.centerPoint, endPointOnCircle, this.plane);

        const ccw = isCCW(this.centerPoint, this.startPoint, this.mousePoint);
        addDashedArc(this.previewGroup, this.centerPoint, radius, startAngle, mouseAngle, ccw, this.plane);

        if (this.lastSnapType !== 'none') {
          const color = this.lastSnapType === 'vertex' ? SNAP_VERTEX_COLOR : SNAP_GRID_COLOR;
          addDot(this.previewGroup, this.mousePoint, color, camera, planeNormal, this.plane, 0.6);
        }
      }
    }

    this.requestRender();
  }
}
