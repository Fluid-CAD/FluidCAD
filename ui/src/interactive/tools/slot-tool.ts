import { Vector3 } from 'three';
import { SketchTool, InsertGeometryFn, FetchVariablesFn, PickedPoint } from '../sketch-tool';
import { SceneContext } from '../../scene/scene-context';
import { PlaneData, SceneObjectRender } from '../../types';
import { SnapController } from '../../snapping/snap-controller';
import { SnapManager } from '../../snapping/snap-manager';
import { SnapType, SnapResult, SolvedVertexRef } from '../../snapping/types';
import {
  projectToSketch,
  roundPoint,
  dist2D,
} from '../sketch-plane-utils';
import { ICON_SLOT } from '../../ui/icons';
import { ExpressionInput, CommitResult } from '../../ui/expression-input';
import { classifyDelta } from './ortho-snap';
import { dimMagnitude, emittedPointOnSnap, sameVertexRef, slotEmission } from './solved-emission';
import {
  START_POINT_COLOR,
  SNAP_VERTEX_COLOR,
  SNAP_GRID_COLOR,
  addDot,
  addDashedSlot,
  addDashedLine,
} from './tool-preview-utils';

type ExpressionPhase = 'distance' | 'radius';

/**
 * Two-click slot: the first click anchors the slot (its first cap centre, or
 * its midpoint in centered mode), the drag direction sets the axis and the
 * length input sets the distance, then a radius phase finishes the statement.
 * Every commit uses the distance overload — `slot(start, distance, radius)` —
 * with the direction folded into the distance's sign (axis-snapped slots) or
 * a `.rotate(angle)` chain (free slots). A drag within {@link classifyDelta}'s
 * tolerance of an axis snaps to a plain horizontal or vertical slot; Ctrl
 * keeps the exact cursor angle.
 */
export class SlotTool extends SketchTool {
  readonly id = 'slot' as const;
  readonly label = 'Slot';
  readonly icon = ICON_SLOT;

  private startPoint: [number, number] | null = null;
  /** The anchor as picked, carrying any typed axis expressions. */
  private startPick: PickedPoint | null = null;
  /** Solved sketches: the anchor click's snap provenance. Non-centered mode
   * only — the anchor IS the first cap centre there; the centered anchor is
   * the slot's midpoint, which no slot vertex sits on. */
  private startSnapRef: SolvedVertexRef | null = null;
  /** The cursor's latest snap (mousemove or the commit click). */
  private lastSnap: SnapResult | null = null;
  /** The distance commit's snap — the second cap centre's provenance, held
   * across the radius phase and validated against p1 at emission. */
  private distSnap: SnapResult | null = null;
  private mousePoint: [number, number] | null = null;
  private lastSnapType: SnapType = 'none';
  private ctrlHeld = false;
  private readonly centered: boolean;
  private expressionInput: ExpressionInput;
  private lastClientX = 0;
  private lastClientY = 0;

  private expressionPhase: ExpressionPhase = 'distance';
  /** The committed length, already signed for axis-snapped directions. */
  private distanceExpression: CommitResult | null = null;
  /** `.rotate(...)` chain locked with the distance; '' for horizontal. */
  private rotateSuffix = '';
  /** Whether the distance pill's value was actually TYPED — typed sizes
   * become explicit dimensions in a solved sketch. */
  private distanceTyped = false;
  /** Unit axis direction locked at the distance commit. */
  private lockedDir: [number, number] | null = null;
  /** Numeric full length for the preview, signed along {@link lockedDir}. */
  private lockedDistance: number | null = null;

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
    centered: boolean,
  ) {
    super(ctx, plane, snapController, insertGeometry, container, fetchVariables);
    this.expressionInput = new ExpressionInput(container);
    this.centered = centered;
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
    this.removePreviewFromScene();
  }

  onSceneUpdate(sceneObjects: SceneObjectRender[], sketchId: string): void {
    const snapManager = SnapManager.fromSceneObjects(sceneObjects, sketchId, this.plane, this.ctx);
    this.updateSnapManager(snapManager);
    this.refreshVariables();
  }

  override handleEscape(): boolean {
    if (!this.startPoint) {
      return false;
    }
    if (this.expressionPhase === 'radius') {
      this.expressionPhase = 'distance';
      this.distanceExpression = null;
      this.rotateSuffix = '';
      this.lockedDir = null;
      this.lockedDistance = null;
      this.distSnap = null;
      this.expressionInput.hide();
      this.rebuildPreview();
      return true;
    }
    this.resetState();
    this.rebuildPreview();
    return true;
  }

  /** The anchor is the point that lands in the source; the drag sets the
   * slot's length, which the expression input already covers. */
  protected override awaitingPoint(): boolean {
    return this.startPoint === null;
  }

  protected override onTypedPoint(point: PickedPoint): void {
    this.consumeStart(point);
  }

  /** Single writer for both halves of the anchor, so the position the preview
   * draws and the expressions the statement emits cannot drift. Clears the
   * anchor's snap ref — the mouse pick path re-captures it right after
   * (typed picks never carry one). */
  private consumeStart(start: PickedPoint): void {
    this.startPick = start;
    this.startPoint = start.value;
    this.startSnapRef = null;
    this.syncPointInput();
    this.rebuildPreview();
  }

  private resetState(): void {
    this.startPoint = null;
    this.startPick = null;
    this.startSnapRef = null;
    this.distSnap = null;
    this.mousePoint = null;
    this.expressionPhase = 'distance';
    this.distanceExpression = null;
    this.rotateSuffix = '';
    this.lockedDir = null;
    this.lockedDistance = null;
    this.expressionInput.hide();
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

    this.ctrlHeld = e.ctrlKey;
    const result = this.snapController.snap(raw);
    const point = roundPoint(result.point2d);

    if (!this.startPoint) {
      const picked = this.applyPointInput(result.point2d);
      this.consumeStart(picked);
      // Non-centered slots anchor at the first cap centre — a snapped anchor
      // becomes its coincident. The centered anchor is the slot midpoint,
      // which no slot vertex sits on.
      this.startSnapRef = !this.centered && !picked.typed && !(e.ctrlKey || e.metaKey)
        ? result.ref ?? null : null;
      return;
    }

    // The click's own snap is fresher than the last mousemove sample.
    this.lastSnap = result;

    if (this.expressionInput.isVisible) {
      this.expressionInput.commitCurrentValue();
      return;
    }

    if (this.expressionPhase === 'distance') {
      this.mousePoint = point;
      const span = this.getSlotSpan();
      if (!span) {
        return;
      }
      const length = Math.round(dist2D(span.left, span.right) * 100) / 100;
      if (length <= 0) {
        return;
      }
      this.onDistanceCommit({ expression: String(length) });
      return;
    }

    const radius = this.computeRadiusFromMouse(point);
    if (radius <= 0) {
      return;
    }
    this.onRadiusCommit({ expression: String(radius) });
  }

  private handleMouseMove(e: MouseEvent): void {
    this.lastClientX = e.clientX;
    this.lastClientY = e.clientY;
    this.ctrlHeld = e.ctrlKey;

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
    this.lastSnap = result;
    this.rebuildPreview();
    this.updateDimensionInput();
  }

  private handleKeyDown(e: KeyboardEvent): void {
    if (e.key === 'Escape') {
      if (this.handleEscape()) {
        e.stopPropagation();
      }
      return;
    }
    if (e.key === 'Control') {
      this.ctrlHeld = true;
      this.rebuildPreview();
      this.updateDimensionInput();
    }
  }

  private handleKeyUp(e: KeyboardEvent): void {
    if (e.key === 'Control') {
      this.ctrlHeld = false;
      this.rebuildPreview();
      this.updateDimensionInput();
    }
  }

  /**
   * The slot's cap centres for the current phase. While setting the distance
   * the mouse drives the axis — snapped onto ±x/±y when the drag is within
   * the ortho tolerance — and in centered mode the anchor is the midpoint, so
   * the caps sit mirrored around it. After the distance commit the caps are
   * frozen from the locked direction and length.
   */
  private getSlotSpan(): { left: [number, number]; right: [number, number] } | null {
    if (!this.startPoint) {
      return null;
    }

    if (this.expressionPhase === 'radius') {
      if (!this.lockedDir || this.lockedDistance === null) {
        return null;
      }
      const d = this.lockedDistance;
      const left: [number, number] = this.centered
        ? [this.startPoint[0] - this.lockedDir[0] * d / 2, this.startPoint[1] - this.lockedDir[1] * d / 2]
        : this.startPoint;
      return { left, right: [left[0] + this.lockedDir[0] * d, left[1] + this.lockedDir[1] * d] };
    }

    if (!this.mousePoint) {
      return null;
    }
    const dx = this.mousePoint[0] - this.startPoint[0];
    const dy = this.mousePoint[1] - this.startPoint[1];
    const direction = classifyDelta(dx, dy, this.ctrlHeld);
    const delta: [number, number] = direction === 'horizontal' ? [dx, 0]
      : direction === 'vertical' ? [0, dy]
        : [dx, dy];
    const left: [number, number] = this.centered
      ? [this.startPoint[0] - delta[0], this.startPoint[1] - delta[1]]
      : this.startPoint;
    return { left, right: [this.startPoint[0] + delta[0], this.startPoint[1] + delta[1]] };
  }

  private getSlotAxis(): { dir: [number, number]; leftCenter: [number, number]; rightCenter: [number, number] } | null {
    const span = this.getSlotSpan();
    if (!span) {
      return null;
    }
    const dx = span.right[0] - span.left[0];
    const dy = span.right[1] - span.left[1];
    const length = Math.sqrt(dx * dx + dy * dy);
    if (length < 1e-10) {
      return null;
    }
    return { dir: [dx / length, dy / length], leftCenter: span.left, rightCenter: span.right };
  }

  private computeRadiusFromMouse(point: [number, number]): number {
    const axis = this.getSlotAxis();
    if (!axis) {
      return 0;
    }
    const dx = point[0] - axis.leftCenter[0];
    const dy = point[1] - axis.leftCenter[1];
    const perpDist = Math.abs(-axis.dir[1] * dx + axis.dir[0] * dy);
    return Math.round(perpDist * 100) / 100;
  }

  private updateDimensionInput(): void {
    if (!this.startPoint || !this.mousePoint) {
      return;
    }

    if (this.expressionPhase === 'distance') {
      const span = this.getSlotSpan();
      if (!span) {
        return;
      }
      const length = Math.round(dist2D(span.left, span.right) * 100) / 100;
      if (length <= 0) {
        return;
      }
      if (!this.expressionInput.isVisible) {
        this.expressionInput.show({
          label: 'D',
          value: String(length),
          clientX: this.lastClientX,
          clientY: this.lastClientY,
          variables: this.cachedVariables,
          onCommit: (result) => this.onDistanceCommit(result),
        });
      } else {
        this.expressionInput.updateValue(length);
        this.expressionInput.updatePosition(this.lastClientX, this.lastClientY);
      }
      return;
    }

    const radius = this.computeRadiusFromMouse(this.mousePoint);
    if (radius <= 0) {
      return;
    }
    if (!this.expressionInput.isVisible) {
      this.expressionInput.show({
        label: 'R',
        value: String(radius),
        clientX: this.lastClientX,
        clientY: this.lastClientY,
        variables: this.cachedVariables,
        onCommit: (result) => this.onRadiusCommit(result),
      });
    } else {
      this.expressionInput.updateValue(radius);
      this.expressionInput.updatePosition(this.lastClientX, this.lastClientY);
    }
  }

  /**
   * Lock the axis from the drag at commit time. Axis-snapped slots re-apply
   * the drag direction onto the committed length ({@link SketchTool.applySignedDimension}
   * — a typed variable stays a positive magnitude, negated at the use site),
   * vertical ones gain `.rotate(90)`; a free drag keeps the typed magnitude
   * and carries its exact angle in `.rotate(...)`.
   */
  private onDistanceCommit(result: CommitResult): void {
    if (!this.startPoint || !this.mousePoint) {
      return;
    }

    const dx = this.mousePoint[0] - this.startPoint[0];
    const dy = this.mousePoint[1] - this.startPoint[1];
    const direction = classifyDelta(dx, dy, this.ctrlHeld);
    const factor = this.centered ? 2 : 1;

    this.distanceTyped = this.expressionInput.isTyping;
    // The distance click's snap — the second cap centre's provenance, kept
    // for the emission's position check (Ctrl suppresses the inference).
    this.distSnap = this.ctrlHeld ? null : this.lastSnap;
    if (direction === 'horizontal' || direction === 'vertical') {
      const axisDelta = direction === 'horizontal' ? dx : dy;
      const sign = Math.sign(axisDelta) || 1;
      this.distanceExpression = {
        expression: SketchTool.applySignedDimension(result.expression, sign),
        newVariable: result.newVariable,
      };
      this.rotateSuffix = direction === 'vertical' ? '.rotate(90)' : '';
      this.lockedDir = direction === 'horizontal' ? [1, 0] : [0, 1];
      this.lockedDistance = SketchTool.resolveCommittedValue(this.distanceExpression, this.cachedVariables)
        ?? Math.round(axisDelta * factor * 100) / 100;
    } else {
      const length = Math.sqrt(dx * dx + dy * dy);
      if (length < 1e-10) {
        return;
      }
      this.distanceExpression = result;
      const angle = Math.round(Math.atan2(dy, dx) * 180 / Math.PI * 100) / 100;
      this.rotateSuffix = angle !== 0 ? `.rotate(${angle})` : '';
      this.lockedDir = [dx / length, dy / length];
      this.lockedDistance = SketchTool.resolveCommittedValue(this.distanceExpression, this.cachedVariables)
        ?? Math.round(length * factor * 100) / 100;
    }

    this.expressionPhase = 'radius';

    queueMicrotask(() => {
      if (this.mousePoint) {
        const radius = this.computeRadiusFromMouse(this.mousePoint);
        this.expressionInput.show({
          label: 'R',
          value: String(radius),
          clientX: this.lastClientX,
          clientY: this.lastClientY,
          variables: this.cachedVariables,
          onCommit: (r) => this.onRadiusCommit(r),
        });
      }
      this.rebuildPreview();
    });
  }

  private onRadiusCommit(result: CommitResult): void {
    if (!this.startPoint || !this.distanceExpression) {
      return;
    }
    this.commitSlot(this.startPick!, this.distanceExpression, result);
    this.resetState();
    this.rebuildPreview();
  }

  private commitSlot(
    start: PickedPoint,
    distanceResult: CommitResult,
    radiusResult: CommitResult,
  ): void {
    const newVariables = [distanceResult.newVariable, radiusResult.newVariable]
      .filter((v): v is NonNullable<typeof v> => v !== undefined);

    if (this.solvedCtx) {
      const radiusTyped = this.expressionInput.isTyping;
      const dist = this.lockedDistance;
      const dir = this.lockedDir;
      const radius = (() => {
        const num = parseFloat(radiusResult.expression);
        if (!isNaN(num) && String(num) === radiusResult.expression) {
          return num;
        }
        return SketchTool.resolveCommittedValue(radiusResult, this.cachedVariables);
      })();
      if (dist === null || !dir || radius === null || radius <= 0 || dist === 0) {
        return;
      }
      const anchor = start.value;
      const p0: [number, number] = this.centered
        ? [anchor[0] - dir[0] * dist / 2, anchor[1] - dir[1] * dist / 2]
        : [anchor[0], anchor[1]];
      const p1: [number, number] = [p0[0] + dir[0] * dist, p0[1] + dir[1] * dist];
      // Snap provenance → cap-centre coincidents (the Auto-constraints toggle
      // gates the inference). The anchor IS p0 in non-centered mode; the
      // distance click's snap holds only when the committed p1 still sits on
      // the snapped vertex (an ortho or typed distance may have moved it).
      const infer = this.autoConstraintsEnabled();
      const p0Snap = infer ? this.startSnapRef : null;
      const p1Snap = infer && this.distSnap?.ref
        && emittedPointOnSnap(p1, this.distSnap.point2d, this.distSnap.ref)
        && !(p0Snap && sameVertexRef(this.distSnap.ref, p0Snap))
        ? this.distSnap.ref : null;
      const emission = slotEmission({
        p0,
        p1,
        radius,
        ...(this.distanceTyped ? { lengthDim: dimMagnitude(distanceResult.expression) } : {}),
        ...(radiusTyped ? { radiusDim: dimMagnitude(radiusResult.expression) } : {}),
        ...(p0Snap ? { p0Snap } : {}),
        ...(p1Snap ? { p1Snap } : {}),
      });
      const variables = [...start.newVariables, ...newVariables];
      void this.solvedCtx.emit({
        ...emission,
        ...(variables.length > 0 ? { newVariables: variables } : {}),
      });
      this.distanceTyped = false;
    }
  }

  private rebuildPreview(): void {
    this.disposePreview();

    const camera = this.ctx.camera;
    const planeNormal = new Vector3(this.plane.normal.x, this.plane.normal.y, this.plane.normal.z);

    if (this.startPoint) {
      addDot(this.previewGroup, this.startPoint, START_POINT_COLOR, camera, planeNormal, this.plane);

      const axis = this.getSlotAxis();
      if (axis) {
        const distance = dist2D(axis.leftCenter, axis.rightCenter);
        if (distance > 0) {
          if (this.expressionPhase === 'radius' && this.mousePoint) {
            const radius = this.computeRadiusFromMouse(this.mousePoint);
            if (radius > 0) {
              addDashedSlot(this.previewGroup, axis.leftCenter, axis.rightCenter, radius, this.plane);
            } else {
              addDashedLine(this.previewGroup, axis.leftCenter, axis.rightCenter, this.plane);
            }
            addDot(this.previewGroup, axis.rightCenter, START_POINT_COLOR, camera, planeNormal, this.plane);
          } else {
            addDashedSlot(this.previewGroup, axis.leftCenter, axis.rightCenter, distance / 6, this.plane);
            addDot(this.previewGroup, axis.rightCenter, SNAP_VERTEX_COLOR, camera, planeNormal, this.plane);
          }
        }
      }
    } else if (this.mousePoint && this.lastSnapType !== 'none') {
      const snapColor = this.lastSnapType === 'vertex' ? SNAP_VERTEX_COLOR : SNAP_GRID_COLOR;
      addDot(this.previewGroup, this.mousePoint, snapColor, camera, planeNormal, this.plane, 0.6);
    }

    this.requestRender();
  }
}
