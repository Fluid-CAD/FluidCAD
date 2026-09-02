import { Vector3 } from 'three';
import { SketchTool, InsertGeometryFn, FetchVariablesFn, PickedPoint } from '../sketch-tool';
import { SceneContext } from '../../scene/scene-context';
import { PlaneData, SceneObjectRender } from '../../types';
import { SnapController } from '../../snapping/snap-controller';
import { SnapManager } from '../../snapping/snap-manager';
import { SnapType } from '../../snapping/types';
import {
  projectToSketch,
  roundPoint,
} from '../sketch-plane-utils';
import { ICON_LINE } from '../../ui/icons';
import { ExpressionInput, VariableInfo, CommitResult } from '../../ui/expression-input';
import {
  START_POINT_COLOR,
  SNAP_VERTEX_COLOR,
  SNAP_GRID_COLOR,
  addDot,
  addDashedLine,
} from './tool-preview-utils';
import { classifyDelta, orthoEffectiveEnd, LineDirection } from './ortho-snap';
import {
  coincident,
  dimMagnitude,
  emittedPointOnSnap,
  inferred,
  inferredOrtho,
  newTarget,
  refTarget,
  sameVertexRef,
  type SolvedConstraintParam,
} from './solved-emission';
import type { SnapResult, SolvedVertexRef } from '../../snapping/types';

export class LineTool extends SketchTool {
  readonly id = 'line' as const;
  readonly label = 'Line';
  readonly icon = ICON_LINE;

  private startPoint: [number, number] | null = null;
  /** The start as picked: same position, plus any typed axis expressions. */
  private startPick: PickedPoint | null = null;
  /** Solved sketches: the start click's snap provenance (for the coincident). */
  private startSnapRef: SolvedVertexRef | null = null;
  /** Solved sketches: the latest cursor snap (the end click's provenance). */
  private lastSnapRef: SolvedVertexRef | null = null;
  /** The snapped position lastSnapRef refers to — validates that a commit's
   * resolved endpoint actually landed on the snapped vertex. */
  private lastSnapPoint: [number, number] | null = null;
  private mousePoint: [number, number] | null = null;
  private lastSnapType: SnapType = 'none';
  private ctrlHeld = false;
  private expressionInput: ExpressionInput;
  private lastClientX = 0;
  private lastClientY = 0;
  private sceneObjects: SceneObjectRender[] = [];
  private sketchId = '';

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
    this.startPoint = null;
    this.startPick = null;
    this.mousePoint = null;
    this.ctrlHeld = false;
    this.expressionInput.hide();
    this.removePreviewFromScene();
  }

  onSceneUpdate(sceneObjects: SceneObjectRender[], sketchId: string): void {
    this.sceneObjects = sceneObjects;
    this.sketchId = sketchId;
    const snapManager = SnapManager.fromSceneObjects(sceneObjects, sketchId, this.plane, this.ctx);
    this.updateSnapManager(snapManager);
    this.refreshVariables();
  }

  private handleMouseDown(e: MouseEvent): void {
    this.downX = e.clientX;
    this.downY = e.clientY;
    this.syncModifiers(e);
  }

  private handleMouseUp(e: MouseEvent): void {
    this.syncModifiers(e);
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

    if (!this.startPoint) {
      this.consumeStart(this.applyPointInput(result.point2d), result);
      return;
    }

    // The click's own snap is the end's provenance — fresher than the last
    // mousemove sample the tracking fields hold.
    this.lastSnapRef = result.ref ?? null;
    this.lastSnapPoint = result.ref ? result.point2d : null;

    if (this.expressionInput.isVisible) {
      this.expressionInput.commitCurrentValue();
    } else {
      this.commitLine(this.startPick!, point);
    }
    this.expressionInput.hide();
    this.startPoint = null;
    this.startPick = null;
    this.rebuildPreview();
  }

  /** The start is the point that lands in the source. The end is covered by
   * the H:/V:/T: dimension input when it applies, and by re-picking the
   * endpoint afterwards when it does not. */
  protected override awaitingPoint(): boolean {
    return this.startPoint === null;
  }

  protected override onTypedPoint(point: PickedPoint): void {
    this.consumeStart(point);
  }

  /** Single writer for both halves of the anchor, so the position the preview
   * draws and the expressions the statement emits cannot drift. */
  private consumeStart(start: PickedPoint, snap?: SnapResult): void {
    this.startPick = start;
    this.startPoint = start.value;
    this.startSnapRef = !start.typed && !this.ctrlHeld ? snap?.ref ?? null : null;
    this.syncPointInput();
    this.rebuildPreview();
  }

  private handleMouseMove(e: MouseEvent): void {
    this.lastClientX = e.clientX;
    this.lastClientY = e.clientY;
    this.syncModifiers(e);

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
    this.lastSnapPoint = result.ref ? result.point2d : null;
    this.rebuildPreview();
    this.updateDimensionInput();
  }

  private syncModifiers(e: MouseEvent | KeyboardEvent): void {
    this.ctrlHeld = e.ctrlKey || e.metaKey;
  }

  private handleKeyDown(e: KeyboardEvent): void {
    this.syncModifiers(e);
    if (e.key === 'Shift' || e.key === 'Control' || e.key === 'Meta') {
      this.rebuildPreview();
      this.updateDimensionInput();
    }
    if (e.key === 'Escape') {
      // Typed coordinates clear first; only a clean pill lets Escape fall
      // through to cancelling the in-progress line.
      if (this.handlePointInputEscape()) {
        return;
      }
      if (this.startPoint) {
        this.startPoint = null;
        this.startPick = null;
        this.expressionInput.hide();
        this.rebuildPreview();
      }
    }
  }

  private handleKeyUp(e: KeyboardEvent): void {
    this.syncModifiers(e);
    if (e.key === 'Shift' || e.key === 'Control' || e.key === 'Meta') {
      this.rebuildPreview();
      this.updateDimensionInput();
    }
  }

  /**
   * Classify a start->end delta as near-horizontal, near-vertical, or free.
   * Holding Ctrl forces 'free' so the user can draw at the exact cursor angle.
   */
  private classifyDelta(dx: number, dy: number): LineDirection {
    return classifyDelta(dx, dy, this.ctrlHeld);
  }

  private lineDirection(): LineDirection {
    if (!this.startPoint || !this.mousePoint) {
      return 'free';
    }
    return this.classifyDelta(
      this.mousePoint[0] - this.startPoint[0],
      this.mousePoint[1] - this.startPoint[1],
    );
  }

  private getEffectiveEndPoint(): [number, number] | null {
    if (!this.startPoint || !this.mousePoint) {
      return null;
    }

    return orthoEffectiveEnd(this.startPoint, this.mousePoint, this.lineDirection());
  }

  private updateDimensionInput(): void {
    if (!this.startPoint || !this.mousePoint) {
      this.expressionInput.hide();
      return;
    }

    const dir = this.lineDirection();
    if (dir === 'free') {
      this.expressionInput.hide();
      return;
    }

    const isHorizontal = dir === 'horizontal';
    const dx = this.mousePoint[0] - this.startPoint[0];
    const dy = this.mousePoint[1] - this.startPoint[1];
    const distance = Math.abs(isHorizontal ? dx : dy);

    if (!this.expressionInput.isVisible) {
      this.expressionInput.show({
        label: isHorizontal ? 'H:' : 'V:',
        value: String(Math.round(distance * 100) / 100),
        clientX: this.lastClientX,
        clientY: this.lastClientY,
        variables: this.cachedVariables,
        onCommit: (result) => this.commitWithDimension(result),
      });
    } else {
      this.expressionInput.updateValue(distance);
      this.expressionInput.updatePosition(this.lastClientX, this.lastClientY);
    }
  }

  private commitWithDimension(result: CommitResult): void {
    if (!this.startPoint || !this.mousePoint) {
      return;
    }
    const { expression, newVariable } = result;
    const dx = this.mousePoint[0] - this.startPoint[0];
    const dy = this.mousePoint[1] - this.startPoint[1];
    const isHorizontal = Math.abs(dx) >= Math.abs(dy);
    const sign = isHorizontal ? Math.sign(dx) : Math.sign(dy);
    const dimExpr = SketchTool.applySignedDimension(expression, sign);

    if (this.solvedCtx) {
      const committedDist = parseFloat(dimExpr);
      const resolvedDist = isNaN(committedDist)
        ? Math.round(sign * Math.abs(isHorizontal ? dx : dy) * 100) / 100
        : committedDist;
      const start = this.startPick!.value;
      const end: [number, number] = isHorizontal
        ? [start[0] + resolvedDist, start[1]]
        : [start[0], start[1] + resolvedDist];
      const constraints: SolvedConstraintParam[] = this.autoConstraintsEnabled()
        ? [inferredOrtho(isHorizontal ? 'horizontal' : 'vertical')]
        : [];
      // Only a TYPED value becomes a dimension; a click merely commits the
      // pill's mouse-tracked value.
      if (this.expressionInput.isTyping) {
        constraints.push({
          kind: 'distance',
          targets: [{ newIndex: 0, role: 'start' }, { newIndex: 0, role: 'end' }],
          valueExpr: dimMagnitude(expression),
        });
      }
      // The H/V pill claims the commit click, so the end's snap provenance
      // has to ride through here too — kept only when the resolved ortho
      // endpoint still sits on the snapped vertex.
      const endRef = this.lastSnapRef && this.lastSnapPoint
        && emittedPointOnSnap(end, this.lastSnapPoint, this.lastSnapRef)
        ? this.lastSnapRef : null;
      this.emitSolvedLine(this.startPick!, roundPoint(end), endRef, constraints,
        newVariable ? [newVariable] : []);
    }

    this.expressionInput.hide();
    this.startPoint = null;
    this.startPick = null;
    this.rebuildPreview();
  }

  private commitLine(start: PickedPoint, end: [number, number]): void {
    const roundedEnd = roundPoint(end);
    const dx = roundedEnd[0] - start.value[0];
    const dy = roundedEnd[1] - start.value[1];
    const dir = this.classifyDelta(dx, dy);

    if (this.solvedCtx) {
      if (dir === 'free') {
        this.emitSolvedLine(start, roundedEnd, this.lastSnapRef, []);
      } else {
        const isHorizontal = dir === 'horizontal';
        const effectiveEnd = roundPoint(orthoEffectiveEnd(start.value, roundedEnd, dir));
        // The ortho quantization may have moved the end off the snapped
        // vertex — the coincident only holds when it didn't.
        const stillSnapped = this.lastSnapRef && this.lastSnapPoint
          && emittedPointOnSnap(effectiveEnd, this.lastSnapPoint, this.lastSnapRef);
        // Auto-constraints off: the ortho quantization still applies (a
        // drafting aid, as in legacy sketches) but the H/V stays unwritten.
        this.emitSolvedLine(start, effectiveEnd, stillSnapped ? this.lastSnapRef : null,
          this.autoConstraintsEnabled()
            ? [inferredOrtho(isHorizontal ? 'horizontal' : 'vertical')]
            : []);
      }
    }
  }

  /** Solved emission for one line: geometry + the given constraints, plus
   * the start/end snap coincidents (Ctrl and the Auto-constraints toggle
   * suppress inference). Inferred rows are marked for the emission rail's
   * redundancy trial — a vertical between two vertices the sketch already
   * stacks, or with both ends on one axis, never reaches the source. */
  private emitSolvedLine(
    start: PickedPoint,
    end: [number, number],
    endRef: SolvedVertexRef | null,
    constraints: SolvedConstraintParam[],
    newVariables: { name: string; initializer: string }[] = [],
  ): void {
    const infer = this.autoConstraintsEnabled();
    const all: SolvedConstraintParam[] = [];
    if (this.startSnapRef && infer) {
      all.push(inferred(coincident(newTarget(0, 'start'), refTarget(this.startSnapRef))));
    }
    const keptEndRef = endRef && infer && !this.ctrlHeld
      && !(this.startSnapRef && sameVertexRef(endRef, this.startSnapRef))
      ? endRef : null;
    if (keptEndRef) {
      all.push(inferred(coincident(newTarget(0, 'end'), refTarget(keptEndRef))));
    }
    all.push(...constraints);
    void this.solvedCtx!.emit({
      geometry: [{
        kind: 'line',
        // A relative pick's axis expressions are offsets, not coordinates —
        // only the resolved value is a valid solved-mode literal.
        text: `line(${this.formatPoint(start.relative ? roundPoint(start.value) : start)}, ${this.formatPoint(end)})`,
      }],
      constraints: all,
      ...(start.newVariables.length + newVariables.length > 0
        ? { newVariables: [...start.newVariables, ...newVariables] } : {}),
    });
    this.startSnapRef = null;
  }

  private rebuildPreview(): void {
    this.disposePreview();

    const camera = this.ctx.camera;
    const planeNormal = new Vector3(this.plane.normal.x, this.plane.normal.y, this.plane.normal.z);

    if (this.startPoint) {
      addDot(this.previewGroup, this.startPoint, START_POINT_COLOR, camera, planeNormal, this.plane);

      const endPoint = this.getEffectiveEndPoint();
      if (endPoint) {
        addDashedLine(this.previewGroup, this.startPoint, endPoint, this.plane);

        if (this.lastSnapType !== 'none') {
          const snapColor = this.lastSnapType === 'vertex' ? SNAP_VERTEX_COLOR : SNAP_GRID_COLOR;
          addDot(this.previewGroup, endPoint, snapColor, camera, planeNormal, this.plane, 0.6);
        }
      }
    } else if (this.mousePoint && this.lastSnapType !== 'none') {
      const snapColor = this.lastSnapType === 'vertex' ? SNAP_VERTEX_COLOR : SNAP_GRID_COLOR;
      addDot(this.previewGroup, this.mousePoint, snapColor, camera, planeNormal, this.plane, 0.6);
    }

    this.requestRender();
  }
}
