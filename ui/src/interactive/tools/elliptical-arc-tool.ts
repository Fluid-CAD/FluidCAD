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
  sketchToClient,
  dist2D,
} from '../sketch-plane-utils';
import { pixelsToWorld } from '../../meshes/screen-scale';
import { ICON_ELLIPTICAL_ARC } from '../../ui/icons';
import { ExpressionInput, VariableInfo, CommitResult } from '../../ui/expression-input';
import {
  START_POINT_COLOR,
  SNAP_VERTEX_COLOR,
  SNAP_GRID_COLOR,
  addDot,
  addDashedLine,
  addDashedEllipse,
  addDashedEllipseArc,
} from './tool-preview-utils';
import {
  coincident, dimMagnitude, eArcText, inferred, newTarget, refTarget, sameVertexRef,
  type SolvedConstraintParam,
} from './solved-emission';
import { carrySweep } from './sweep-carry';
import {
  ellipseParamOf,
  ellipsePointAt,
  type EllipseFrame,
} from '../../../../lib/sketch-solver/earc-geometry.js';

/** A whole turn would put the arc's end back on its start, and that is the
 * Ellipse tool's shape: hold the sweep just shy of one. */
const MAX_SWEEP_RAD = 359.5 * (Math.PI / 180);

/** How far (screen pixels) a snapped vertex may sit from the ellipse and
 * still be what an end of the arc is joined to. */
const END_SNAP_PX = 15;

const enum Stage {
  /** Waiting for the centre click. */
  Center,
  /** Centre down: the cursor stretches the semi-radii, RX pill then RY. */
  Radii,
  /** The ellipse is set: the next click picks where the arc starts. */
  Start,
  /** The start is down: the cursor sweeps the arc to where it ends. */
  End,
}

type RadiusPhase = 'rx' | 'ry';

/**
 * Elliptical arc: `eArc(start, end, center, rx, ry)`, an open piece of an
 * ellipse drawn with its axes along the sketch plane's.
 *
 * The gesture is the Ellipse tool's followed by the Center Arc tool's. The
 * first click (or the X/Y pill) lands the centre; the cursor then stretches
 * the semi-radii along the plane's X and Y axes, one pill each (RX, then
 * RY), a click or Enter committing the pill in hand. With the ellipse set,
 * a click picks where on it the arc starts, the cursor sweeps the arc
 * round from there, and a last click ends it.
 *
 * Nothing is inferred beyond the snaps: a centre, start or end that lands
 * on a vertex becomes a coincident on that point of the arc, and the
 * rotation is left free like a drawn ellipse's. A TYPED RX or RY lands as a
 * `radius(ea, v, 'x' | 'y')` dimension; a cursor-sized one stays a free
 * guess.
 */
export class EllipticalArcTool extends SketchTool {
  readonly id = 'earc' as const;
  readonly label = 'Elliptical Arc';
  readonly icon = ICON_ELLIPTICAL_ARC;

  private stage: Stage = Stage.Center;

  private centerPoint: [number, number] | null = null;
  /** The centre as picked: same position, plus any typed axis expressions. */
  private centerPick: PickedPoint | null = null;
  /** The centre click's snap provenance. */
  private centerSnapRef: SolvedVertexRef | null = null;

  private mousePoint: [number, number] | null = null;
  private lastSnapType: SnapType = 'none';
  /** The cursor's snap provenance, read when a start or end click lands. */
  private lastSnapRef: SolvedVertexRef | null = null;
  private lastClientX = 0;
  private lastClientY = 0;

  private expressionInput: ExpressionInput;
  private radiusPhase: RadiusPhase = 'rx';
  private rxExpression: CommitResult | null = null;
  private ryExpression: CommitResult | null = null;
  /** Whether each pill was committed with a typed value (a dimension). */
  private rxTyped = false;
  private ryTyped = false;
  /** The committed RX as a magnitude for the preview while RY is set. */
  private lockedRx: number | null = null;
  /** Both semi-radii as magnitudes once the ellipse is set. */
  private radii: { rx: number; ry: number } | null = null;

  /** Where the arc starts: a parameter of the ellipse, and its point. */
  private startParam = 0;
  private startPoint: [number, number] | null = null;
  private startSnapRef: SolvedVertexRef | null = null;
  /** Sweep from the start, signed (positive is counter-clockwise) and
   * carried across cursor samples so it can pass a half turn. */
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

  protected override onVariablesLoaded(variables: VariableInfo[]): void {
    this.expressionInput.setVariables(variables);
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
    this.removePreviewFromScene();
  }

  onSceneUpdate(sceneObjects: SceneObjectRender[], sketchId: string): void {
    const snapManager = SnapManager.fromSceneObjects(sceneObjects, sketchId, this.plane, this.ctx);
    this.updateSnapManager(snapManager);
    this.refreshVariables();
  }

  /** Only the centre lands in the source as typed: the radii come from the
   * RX/RY pills, and the two ends are places on the ellipse, not free
   * coordinates. */
  protected override awaitingPoint(): boolean {
    return this.stage === Stage.Center;
  }

  protected override onTypedPoint(point: PickedPoint): void {
    this.consumeCenter(point);
  }

  /** Single writer for both halves of the anchor, so the position the
   * preview draws and the expressions the statement emits cannot drift.
   * Clears the snap ref: the mouse pick path re-captures it right after
   * (typed picks never carry one). */
  private consumeCenter(center: PickedPoint): void {
    this.centerPick = center;
    this.centerPoint = center.value;
    this.centerSnapRef = null;
    this.stage = Stage.Radii;
    this.syncPointInput();
    this.rebuildPreview();
  }

  private resetState(): void {
    this.stage = Stage.Center;
    this.centerPoint = null;
    this.centerPick = null;
    this.centerSnapRef = null;
    this.mousePoint = null;
    this.lastSnapRef = null;
    this.resetRadii();
    this.resetArc();
    this.expressionInput.hide();
  }

  private resetRadii(): void {
    this.radiusPhase = 'rx';
    this.rxExpression = null;
    this.ryExpression = null;
    this.rxTyped = false;
    this.ryTyped = false;
    this.lockedRx = null;
    this.radii = null;
  }

  private resetArc(): void {
    this.startParam = 0;
    this.startPoint = null;
    this.startSnapRef = null;
    this.sweepRad = 0;
  }

  // ----------------------------------------------------------------- input

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
    const suppressSnap = e.ctrlKey || e.metaKey;

    if (this.stage === Stage.Center) {
      const result = this.snapController.snap(raw);
      // The pill contributes any axis the user typed; free axes come from
      // the cursor, so a plain click behaves exactly as it always did.
      const picked = this.applyPointInput(result.point2d);
      this.consumeCenter(picked);
      this.centerSnapRef = !picked.typed && !suppressSnap ? result.ref ?? null : null;
      return;
    }

    if (this.stage === Stage.Radii) {
      if (this.expressionInput.isVisible) {
        this.expressionInput.commitCurrentValue();
      } else {
        this.commitRadiiFromCursor(roundPoint(this.snapController.snap(raw).point2d));
      }
      return;
    }

    const result = this.snapController.snapVerticesOnly(raw);
    this.mousePoint = result.point2d;
    this.lastSnapRef = result.ref ?? null;
    if (this.stage === Stage.Start) {
      this.placeStart(suppressSnap);
      return;
    }
    this.advanceSweep();
    this.commitArc(suppressSnap);
  }

  private handleMouseMove(e: MouseEvent): void {
    this.lastClientX = e.clientX;
    this.lastClientY = e.clientY;

    const raw = projectToSketch(this.ctx, this.plane, e.clientX, e.clientY);
    if (!raw) {
      this.mousePoint = null;
      this.lastSnapType = 'none';
      this.lastSnapRef = null;
      this.rebuildPreview();
      return;
    }

    // Once the ellipse is set the cursor is a place along it, not a
    // position: the grid lattice would step that place in quantised jumps,
    // so only real geometry snaps the ends.
    const onEllipse = this.stage === Stage.Start || this.stage === Stage.End;
    const result = onEllipse ? this.snapController.snapVerticesOnly(raw) : this.snapController.snap(raw);
    this.mousePoint = result.point2d;
    this.lastSnapType = result.snapType;
    this.lastSnapRef = result.ref ?? null;
    this.advanceSweep();
    this.rebuildPreview();
    if (this.stage === Stage.Radii) {
      this.updateRadiusPill();
    }
  }

  private handleKeyDown(e: KeyboardEvent): void {
    if (e.key !== 'Escape') {
      return;
    }
    // Typed coordinates clear first; only a clean pill lets Escape fall
    // through to stepping the gesture back.
    if (this.handlePointInputEscape()) {
      return;
    }
    this.stepBack();
  }

  /** Escape undoes one step: the end's sweep, then the start, then the
   * radii, then the centre. */
  private stepBack(): void {
    if (this.stage === Stage.End) {
      this.resetArc();
      this.stage = Stage.Start;
    } else if (this.stage === Stage.Start) {
      this.resetRadii();
      this.stage = Stage.Radii;
    } else if (this.stage === Stage.Radii) {
      this.resetState();
    }
    this.expressionInput.hide();
    this.syncPointInput();
    this.rebuildPreview();
  }

  // ----------------------------------------------------------------- radii

  /** The cursor's semi-radii: its axis offsets from the centre, 2dp. */
  private cursorRadii(point: [number, number]): { rx: number; ry: number } {
    const center = this.centerPoint!;
    return {
      rx: Math.round(Math.abs(point[0] - center[0]) * 100) / 100,
      ry: Math.round(Math.abs(point[1] - center[1]) * 100) / 100,
    };
  }

  /** What the preview draws while the radii are being set: the locked RX
   * once committed, the cursor otherwise. */
  private previewRadii(point: [number, number]): { rx: number; ry: number } {
    const { rx, ry } = this.cursorRadii(point);
    return { rx: this.lockedRx ?? rx, ry };
  }

  /** The pill sits on the semi-axis it sets: the X extreme for RX, the Y
   * extreme for RY, on the side the cursor is on. */
  private radiusPillAnchor(): { clientX: number; clientY: number } {
    if (!this.centerPoint || !this.mousePoint) {
      return { clientX: this.lastClientX, clientY: this.lastClientY };
    }
    const center = this.centerPoint;
    const { rx, ry } = this.previewRadii(this.mousePoint);
    const xSign = this.mousePoint[0] >= center[0] ? 1 : -1;
    const ySign = this.mousePoint[1] >= center[1] ? 1 : -1;
    const at: [number, number] = this.radiusPhase === 'rx'
      ? [center[0] + xSign * rx, center[1]]
      : [center[0], center[1] + ySign * ry];
    return sketchToClient(this.ctx, this.plane, at);
  }

  /** A typed literal must be a positive radius; expressions are checked
   * by the kernel at build time. */
  private static radiusRefusal(expression: string): string | null {
    const num = parseFloat(expression);
    if (!isNaN(num) && String(num) === expression && num <= 0) {
      return 'A radius must be positive';
    }
    return null;
  }

  private showRadiusPill(phase: RadiusPhase, value: number): void {
    const anchor = this.radiusPillAnchor();
    this.expressionInput.show({
      label: phase === 'rx' ? 'RX' : 'RY',
      value: String(value),
      clientX: anchor.clientX,
      clientY: anchor.clientY,
      variables: this.cachedVariables,
      validate: EllipticalArcTool.radiusRefusal,
      onCommit: (result) => {
        // Read before the pill hides: a typed value becomes a dimension.
        const typed = this.expressionInput.isTyping;
        if (phase === 'rx') {
          this.onRxCommit(result, typed);
        } else {
          this.onRyCommit(result, typed);
        }
      },
    });
  }

  private updateRadiusPill(): void {
    if (!this.centerPoint || !this.mousePoint) {
      return;
    }
    const { rx, ry } = this.cursorRadii(this.mousePoint);
    const value = this.radiusPhase === 'rx' ? rx : ry;
    if (value <= 0) {
      return;
    }
    if (!this.expressionInput.isVisible) {
      this.showRadiusPill(this.radiusPhase, value);
    } else {
      const anchor = this.radiusPillAnchor();
      this.expressionInput.updateValue(value);
      this.expressionInput.updatePosition(anchor.clientX, anchor.clientY);
    }
  }

  /** A committed pill as a magnitude for the preview: the value itself
   * when statically resolvable (a number, a known variable), else the
   * cursor's own radius at commit time. The statement still carries the
   * expression. */
  private committedMagnitude(result: CommitResult, phase: RadiusPhase): number | null {
    const resolved = SketchTool.resolveCommittedMagnitude(result, this.cachedVariables);
    if (resolved !== null) {
      return resolved;
    }
    if (this.mousePoint && this.centerPoint) {
      const cursor = this.cursorRadii(this.mousePoint);
      return phase === 'rx' ? cursor.rx : cursor.ry;
    }
    return null;
  }

  private onRxCommit(result: CommitResult, typed: boolean): void {
    this.rxExpression = result;
    this.rxTyped = typed;
    this.lockedRx = this.committedMagnitude(result, 'rx');
    this.radiusPhase = 'ry';

    // The pill hides itself after the commit callback; re-open it for RY
    // once that has run.
    queueMicrotask(() => {
      if (this.stage === Stage.Radii && this.mousePoint && this.centerPoint) {
        this.showRadiusPill('ry', this.cursorRadii(this.mousePoint).ry);
      }
      this.rebuildPreview();
    });
  }

  private onRyCommit(result: CommitResult, typed: boolean): void {
    if (!this.rxExpression) {
      return;
    }
    this.lockRadii(this.rxExpression, result, this.rxTyped, typed);
  }

  /** A click with no pill in hand: both semi-radii off the cursor. */
  private commitRadiiFromCursor(point: [number, number]): void {
    if (!this.centerPoint) {
      return;
    }
    const { rx, ry } = this.cursorRadii(point);
    if ((this.rxExpression === null && rx <= 0) || ry <= 0) {
      return;
    }
    this.lockRadii(this.rxExpression ?? { expression: String(rx) }, { expression: String(ry) }, this.rxTyped, false);
  }

  /** The ellipse is set: keep the expressions the statement will carry and
   * the magnitudes the rest of the gesture draws with, and move on to the
   * start. An expression the tool cannot size (an unknown name with no
   * cursor to fall back on) leaves the gesture where it is. */
  private lockRadii(rxResult: CommitResult, ryResult: CommitResult, rxTyped: boolean, ryTyped: boolean): void {
    const rx = this.lockedRx ?? this.committedMagnitude(rxResult, 'rx');
    const ry = this.committedMagnitude(ryResult, 'ry');
    if (rx === null || ry === null || !(rx > 0) || !(ry > 0)) {
      return;
    }
    this.rxExpression = rxResult;
    this.ryExpression = ryResult;
    this.rxTyped = rxTyped;
    this.ryTyped = ryTyped;
    this.radii = { rx, ry };
    this.resetArc();
    this.stage = Stage.Start;
    this.expressionInput.hide();
    this.rebuildPreview();
  }

  // ------------------------------------------------------------------- arc

  /** The ellipse being drawn, axis-aligned like the Ellipse tool's. */
  private frame(): EllipseFrame | null {
    if (!this.centerPoint || !this.radii) {
      return null;
    }
    return { cx: this.centerPoint[0], cy: this.centerPoint[1], rx: this.radii.rx, ry: this.radii.ry, theta: 0 };
  }

  /**
   * A snapped vertex as the coincident target of an end placed at
   * `onEllipse`. The end is the cursor read onto the ellipse, so it sits in
   * the vertex's direction but generally not at its distance: the vertex
   * still reads as "on the arc" when the gap is within the snap radius on
   * screen, and the coincident is exactly how the solver closes it. A
   * vertex far off the ellipse only picked the place, not a join.
   *
   * An axis-datum snap is a line, not a point: its snapped position keeps
   * the cursor's free coordinate, so the gap that matters there is the
   * end's own distance to the axis.
   */
  private joinRefAt(onEllipse: [number, number]): SolvedVertexRef | null {
    if (!this.lastSnapRef || !this.mousePoint) {
      return null;
    }
    const tolerance = this.ctx?.renderer
      ? pixelsToWorld(this.ctx.renderer, this.ctx.camera, localToWorld(onEllipse, this.plane), END_SNAP_PX)
      : 0.01;
    const gap = this.lastSnapRef.datum === 'x-axis' ? Math.abs(onEllipse[1])
      : this.lastSnapRef.datum === 'y-axis' ? Math.abs(onEllipse[0])
        : dist2D(onEllipse, this.mousePoint);
    return gap <= tolerance ? this.lastSnapRef : null;
  }

  /** The start click: the place on the ellipse the cursor names. */
  private placeStart(suppressSnap: boolean): void {
    const frame = this.frame();
    if (!frame || !this.mousePoint || dist2D(this.centerPoint!, this.mousePoint) <= 0) {
      return;
    }
    this.startParam = ellipseParamOf(frame, this.mousePoint[0], this.mousePoint[1]);
    this.startPoint = ellipsePointAt(frame, this.startParam);
    this.startSnapRef = suppressSnap ? null : this.joinRefAt(this.startPoint);
    this.sweepRad = 0;
    this.stage = Stage.End;
    this.rebuildPreview();
  }

  /** Carry the sweep to the place on the ellipse the cursor now names. */
  private advanceSweep(): void {
    const frame = this.frame();
    if (this.stage !== Stage.End || !frame || !this.mousePoint) {
      return;
    }
    if (dist2D(this.centerPoint!, this.mousePoint) <= 0) {
      return;
    }
    const target = ellipseParamOf(frame, this.mousePoint[0], this.mousePoint[1]) - this.startParam;
    this.sweepRad = carrySweep(this.sweepRad, target, MAX_SWEEP_RAD);
  }

  /** The end click: write the arc. */
  private commitArc(suppressSnap: boolean): void {
    const frame = this.frame();
    if (!frame || !this.startPoint || !this.centerPick || !this.rxExpression || !this.ryExpression
      || this.sweepRad === 0) {
      return;
    }
    const endPoint = ellipsePointAt(frame, this.startParam + this.sweepRad);
    const endRef = suppressSnap ? null : this.joinRefAt(endPoint);
    this.emitArc(this.startPoint, endPoint, endRef);
    this.resetState();
    this.syncPointInput();
    this.rebuildPreview();
  }

  private emitArc(start: [number, number], end: [number, number], endRef: SolvedVertexRef | null): void {
    if (!this.solvedCtx || !this.centerPick || !this.rxExpression || !this.ryExpression) {
      return;
    }
    const constraints: SolvedConstraintParam[] = [];
    // Snap provenance on the three clicks becomes coincidents (the Auto-
    // constraints toggle gates the inference; Ctrl suppressed each capture).
    // The rotation is never inferred, like a drawn ellipse's.
    if (this.autoConstraintsEnabled()) {
      if (this.centerSnapRef) {
        constraints.push(inferred(coincident(newTarget(0, 'center'), refTarget(this.centerSnapRef))));
      }
      if (this.startSnapRef) {
        constraints.push(inferred(coincident(newTarget(0, 'start'), refTarget(this.startSnapRef))));
      }
      if (endRef && !(this.startSnapRef && sameVertexRef(endRef, this.startSnapRef))) {
        constraints.push(inferred(coincident(newTarget(0, 'end'), refTarget(endRef))));
      }
    }
    // A typed semi-radius is a dimension the user specified, like a typed
    // circle diameter; a cursor-sized one is a free guess.
    if (this.rxTyped) {
      constraints.push({ kind: 'radius', targets: [newTarget(0)], valueExpr: dimMagnitude(this.rxExpression.expression), axis: 'x' });
    }
    if (this.ryTyped) {
      constraints.push({ kind: 'radius', targets: [newTarget(0)], valueExpr: dimMagnitude(this.ryExpression.expression), axis: 'y' });
    }
    const variables = [
      ...this.centerPick.newVariables,
      ...[this.rxExpression.newVariable, this.ryExpression.newVariable]
        .filter((v): v is NonNullable<typeof v> => v !== undefined),
    ];
    void this.solvedCtx.emit({
      geometry: [{
        kind: 'eArc',
        text: eArcText(
          roundPoint(start),
          roundPoint(end),
          this.centerPick,
          dimMagnitude(this.rxExpression.expression),
          dimMagnitude(this.ryExpression.expression),
          undefined,
          this.sweepRad < 0,
        ),
      }],
      constraints,
      ...(variables.length > 0 ? { newVariables: variables } : {}),
    });
  }

  // --------------------------------------------------------------- preview

  protected rebuildPreview(): void {
    this.disposePreview();

    const camera = this.ctx.camera;
    const planeNormal = new Vector3(this.plane.normal.x, this.plane.normal.y, this.plane.normal.z);
    const snapDot = (): void => {
      if (this.mousePoint && this.lastSnapType !== 'none') {
        const color = this.lastSnapType === 'vertex' ? SNAP_VERTEX_COLOR : SNAP_GRID_COLOR;
        addDot(this.previewGroup, this.mousePoint, color, camera, planeNormal, this.plane, 0.6);
      }
    };

    if (this.stage === Stage.Center || !this.centerPoint) {
      snapDot();
      this.requestRender();
      return;
    }
    addDot(this.previewGroup, this.centerPoint, START_POINT_COLOR, camera, planeNormal, this.plane);

    if (this.stage === Stage.Radii) {
      if (this.mousePoint) {
        const { rx, ry } = this.previewRadii(this.mousePoint);
        if (rx > 0 && ry > 0) {
          addDashedEllipse(this.previewGroup, this.centerPoint, rx, ry, this.plane);
        }
      }
      this.requestRender();
      return;
    }

    const frame = this.frame();
    if (!frame) {
      this.requestRender();
      return;
    }

    if (this.stage === Stage.Start) {
      // The whole ellipse, with the place the cursor names on it.
      addDashedEllipse(this.previewGroup, this.centerPoint, frame.rx, frame.ry, this.plane);
      if (this.mousePoint && dist2D(this.centerPoint, this.mousePoint) > 0) {
        const at = ellipsePointAt(frame, ellipseParamOf(frame, this.mousePoint[0], this.mousePoint[1]));
        addDashedLine(this.previewGroup, this.centerPoint, at, this.plane);
        addDot(this.previewGroup, at, START_POINT_COLOR, camera, planeNormal, this.plane, 0.6);
      }
      snapDot();
      this.requestRender();
      return;
    }

    if (this.startPoint) {
      addDot(this.previewGroup, this.startPoint, START_POINT_COLOR, camera, planeNormal, this.plane);
      addDashedLine(this.previewGroup, this.centerPoint, this.startPoint, this.plane);
      // A zero sweep has no side to draw yet.
      if (this.sweepRad !== 0) {
        const end = ellipsePointAt(frame, this.startParam + this.sweepRad);
        addDashedLine(this.previewGroup, this.centerPoint, end, this.plane);
        addDashedEllipseArc(
          this.previewGroup,
          { ...frame, startParam: this.startParam, sweep: this.sweepRad },
          this.plane,
        );
      }
      snapDot();
    }

    this.requestRender();
  }
}
