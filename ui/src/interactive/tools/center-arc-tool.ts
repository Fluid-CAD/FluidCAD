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
import { pixelsToWorld } from '../../meshes/screen-scale';
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
} from './tool-preview-utils';
import { coincident, newTarget, refTarget, sameVertexRef, type SolvedConstraintParam } from './solved-emission';

const TWO_PI = Math.PI * 2;
/** A full turn would put the arc's end back on its start, which the
 * three-point fit has no circle for — hold the sweep just shy of one. */
const MAX_SWEEP_DEG = 359.5;
const MAX_SWEEP_RAD = MAX_SWEEP_DEG * (Math.PI / 180);

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
  /** Ctrl state of the click that committed the ∠ pill — the pill's commit
   * callback has no event of its own to read the modifier from. */
  private suppressEndRefOnCommit = false;
  private expressionInput: ExpressionInput;
  private lastClientX = 0;
  private lastClientY = 0;
  /** Sweep from the start ray, signed (positive is counter-clockwise) and
   * carried across cursor samples. Read straight off the cursor's bearing
   * instead, it could never pass a half turn — the shorter way round won. */
  private sweepRad = 0;

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
      this.beginSweep();
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
    this.beginSweep();
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
        // The ∠ pill claims the commit click; remember its modifier so the
        // pill's commit path can still honor Ctrl's snap suppression.
        this.suppressEndRefOnCommit = e.ctrlKey || e.metaKey;
        this.expressionInput.commitCurrentValue();
        this.suppressEndRefOnCommit = false;
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

    // Once the start is down the cursor is an angle, not a position: the
    // grid lattice would step that angle in quantised jumps, so only real
    // geometry snaps the sweep.
    const result = this.state === State.START_PLACED
      ? this.snapController.snapVerticesOnly(raw)
      : this.snapController.snap(raw);
    this.mousePoint = result.point2d;
    this.lastSnapType = result.snapType;
    this.lastSnapRef = result.ref ?? null;
    this.advanceSweep();
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
        this.beginSweep();
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

  private get ccw(): boolean {
    return this.sweepRad >= 0;
  }

  /** Restart the sweep — a fresh start anchor sweeps from zero. */
  private beginSweep(): void {
    this.sweepRad = 0;
  }

  /**
   * Carry the sweep to where the cursor now sits, taking the nearest angle
   * congruent to it rather than its raw bearing: each sample moves the sweep
   * by less than a half turn, so passing 180 degrees keeps going round to a
   * major arc instead of flipping to the short side. Holds at a hair under a
   * full turn, which start and end coinciding would make unbuildable.
   */
  private advanceSweep(): void {
    if (this.state !== State.START_PLACED
      || !this.centerPoint || !this.startPoint || !this.mousePoint) {
      return;
    }
    if (dist2D(this.centerPoint, this.mousePoint) <= 0) {
      return;
    }
    const target = angleFromCenter(this.centerPoint, this.mousePoint)
      - angleFromCenter(this.centerPoint, this.startPoint);
    let step = (target - this.sweepRad) % TWO_PI;
    if (step > Math.PI) {
      step -= TWO_PI;
    } else if (step <= -Math.PI) {
      step += TWO_PI;
    }
    this.sweepRad = Math.max(-MAX_SWEEP_RAD, Math.min(MAX_SWEEP_RAD, this.sweepRad + step));
  }

  private getSweepDeg(): number | null {
    if (this.state !== State.START_PLACED || this.sweepRad === 0) {
      return null;
    }
    return Math.round(Math.abs(this.sweepRad) * (180 / Math.PI) * 100) / 100;
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
    if (!this.centerPoint || !this.startPoint || !this.mousePoint || this.sweepRad === 0) {
      return;
    }
    const radius = dist2D(this.centerPoint, this.startPoint);
    const endAngle = angleFromCenter(this.centerPoint, this.startPoint) + this.sweepRad;
    const endPoint = pointOnCircle(this.centerPoint, radius, endAngle);
    this.emitArc(this.startPick!, endPoint, this.centerPick!, this.ccw, undefined,
      suppressEndRef ? null : this.endSnapRef(endPoint));
  }

  /**
   * The sweep click's snapped vertex as the endpoint's coincident target.
   * The endpoint is the on-circle projection of the cursor, so it sits at
   * the vertex's bearing but generally not its radius — the vertex still
   * reads as "on the arc" when the residue is within the snap radius on
   * screen, and the coincident is exactly how the solver closes it. A vertex
   * far off the circle only locked the sweep angle, not a connection.
   *
   * An axis-datum snap is a line, not a point — its snapped position keeps
   * the cursor's free coordinate, which legitimately sits far from where the
   * arc meets the axis. There the gap that matters is the endpoint's own
   * distance to the axis.
   */
  private endSnapRef(endPoint: [number, number]): SolvedVertexRef | null {
    if (!this.lastSnapRef || !this.mousePoint) {
      return null;
    }
    const tolerance = this.ctx?.renderer
      ? pixelsToWorld(this.ctx.renderer, this.ctx.camera, localToWorld(endPoint, this.plane), 15)
      : 0.01;
    const gap = this.lastSnapRef.datum === 'x-axis' ? Math.abs(endPoint[1])
      : this.lastSnapRef.datum === 'y-axis' ? Math.abs(endPoint[0])
        : dist2D(endPoint, this.mousePoint);
    return gap <= tolerance ? this.lastSnapRef : null;
  }

  private commitFromExpression(result: CommitResult): void {
    if (!this.centerPoint || !this.startPoint) {
      return;
    }
    const { expression, newVariable } = result;
    const num = parseFloat(expression);
    if (isNaN(num) || num <= 0 || num > MAX_SWEEP_DEG) {
      return;
    }
    const sweepRad = num * (Math.PI / 180);
    const radius = dist2D(this.centerPoint, this.startPoint);
    const startAngle = angleFromCenter(this.centerPoint, this.startPoint);
    const direction = this.ccw ? 1 : -1;
    const endAngle = startAngle + direction * sweepRad;
    const endPoint = pointOnCircle(this.centerPoint, radius, endAngle);
    // The ∠ pill claims the commit click, so the sweep's snap provenance has
    // to ride through here too. A typed sweep naturally fails the position
    // check when it lands the endpoint away from the hovered vertex.
    this.emitArc(this.startPick!, endPoint, this.centerPick!, this.ccw, newVariable,
      this.suppressEndRefOnCommit ? null : this.endSnapRef(endPoint));
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
        if (endRef && !(this.startSnapRef && sameVertexRef(endRef, this.startSnapRef))) {
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
        const endAngle = startAngle + this.sweepRad;
        const endPointOnCircle = pointOnCircle(this.centerPoint, radius, endAngle);

        addDashedLine(this.previewGroup, this.centerPoint, endPointOnCircle, this.plane);

        // A zero sweep has no side to draw — addDashedArc would read it as a
        // whole turn and ghost a full circle over the cursor.
        if (this.sweepRad !== 0) {
          addDashedArc(this.previewGroup, this.centerPoint, radius, startAngle, endAngle, this.ccw, this.plane);
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
