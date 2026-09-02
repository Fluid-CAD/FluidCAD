import { Vector3 } from 'three';
import { SketchTool, InsertGeometryFn, FetchVariablesFn, NewVariable, PickedPoint } from '../../sketch-tool';
import { SceneContext } from '../../../scene/scene-context';
import { PlaneData, SceneObjectRender } from '../../../types';
import { SnapController } from '../../../snapping/snap-controller';
import { SnapManager } from '../../../snapping/snap-manager';
import { projectToSketch, roundPoint } from '../../sketch-plane-utils';
import { ICON_POLYLINE } from '../../../ui/icons';
import { ExpressionInput } from '../../../ui/expression-input';
import { SNAP_VERTEX_COLOR, SNAP_GRID_COLOR, addDot } from '../tool-preview-utils';
import { ModeIndicator } from './mode-indicator';
import { LineMode } from './mode-line';
import { ALineMode } from './mode-aline';
import { ArcMode } from './mode-arc';
import { TArcMode } from './mode-tarc';
import { TLineMode } from './mode-tline';
import {
  PolylinePhase,
  MODE_ORDER,
  type SegmentMode,
  type ModeContext,
  type Point2D,
  type TangentInfo,
  type ClickResult,
  type SolvedSegmentSpec,
} from './types';
import type { SnapResult, SnapType, SolvedVertexRef } from '../../../snapping/types';
import {
  coincident,
  emittedPointOnSnap,
  inferred,
  newTarget,
  refTarget,
  sameVertexRef,
  type SolvedConstraintParam,
} from '../solved-emission';
import { buildSolvedSketchModel, type SolvedEntityView } from '../../../sketch-solver-client/model';

/** The previous solved chain segment: what the next segment's junction
 * coincident and tangent/angle constraints reference. */
type SolvedPrev = {
  /** 1-indexed source line of the segment's statement. */
  line: number;
  featureType: 'line' | 'arc';
  /** Which of its endpoints the chain continues from. */
  junctionRole: 'start' | 'end';
  /** The segment's own oriented (start→end) direction — lines only; the
   * angle constraint's CCW rule is defined on it. */
  orientedDir: Point2D | null;
};

export class PolylineTool extends SketchTool {
  readonly id = 'polyline' as const;
  readonly label = 'Polyline';
  readonly icon = ICON_POLYLINE;

  private phase: PolylinePhase = PolylinePhase.IDLE;
  private startPoint: Point2D | null = null;
  private currentModeIndex = 0;
  private tangent: TangentInfo | null = null;
  /** A typed absolute chain start, held until the first segment writes it. */
  private pendingStart: PickedPoint | null = null;

  private modes: SegmentMode[];
  private expressionInput: ExpressionInput;
  private modeIndicator: ModeIndicator;

  private sceneObjects: SceneObjectRender[] = [];
  private sketchId = '';
  private mousePoint: Point2D | null = null;
  private lastSnapType: SnapType = 'none';
  private lastSnapResult: { point2d: Point2D; worldPoint: import('three').Vector3; snapType: SnapType } | null = null;
  private lastClientX = 0;
  private lastClientY = 0;

  private ctrlHeld = false;

  // ------------------------------------------------- solved-sketch chaining
  /** The previous emitted segment (solved sketches), or null at chain start. */
  private solvedPrev: SolvedPrev | null = null;
  /** A chain-start snap ref awaiting the first segment's start coincident
   * (a circle center, a point, …) — endpoint refs become solvedPrev instead. */
  private solvedStartRef: SolvedVertexRef | null = null;
  /** Emissions are serialized so each knows its predecessor's source line. */
  private solvedEmitChain: Promise<void> = Promise.resolve();
  /** Emissions still awaiting their response. The render can beat the HTTP
   * response (the editor round trip re-renders first), and a resync against
   * the then-STALE solvedPrev would drag the chain start back a segment. */
  private solvedEmitsPending = 0;

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
    this.modeIndicator = new ModeIndicator(container);

    this.modes = [
      new LineMode(),
      new ALineMode(),
      new ArcMode(),
      new TArcMode(),
      new TLineMode(),
    ];

    this.boundMouseDown = this.handleMouseDown.bind(this);
    this.boundMouseUp = this.handleMouseUp.bind(this);
    this.boundMouseMove = this.handleMouseMove.bind(this);
    this.boundKeyDown = this.handleKeyDown.bind(this);
    this.boundKeyUp = this.handleKeyUp.bind(this);

    this.expressionInput.onSpaceOverride = () => {
      this.cycleMode(1);
    };
    // Space keeps cycling modes while a coordinate field has focus, matching
    // the dimension input — otherwise typing a start point would trap it.
    this.pointInput.onSpaceOverride = () => {
      this.cycleMode(1);
    };
  }

  private get currentMode(): SegmentMode {
    return this.modes[this.currentModeIndex];
  }

  protected onActivate(): void {
    this.addPreviewToScene();
    this.canvas.addEventListener('mousedown', this.boundMouseDown);
    this.canvas.addEventListener('mouseup', this.boundMouseUp);
    this.canvas.addEventListener('mousemove', this.boundMouseMove);
    window.addEventListener('keydown', this.boundKeyDown);
    window.addEventListener('keyup', this.boundKeyUp);
    this.modeIndicator.show(this.currentMode.id);
  }

  protected onDeactivate(): void {
    this.canvas.removeEventListener('mousedown', this.boundMouseDown);
    this.canvas.removeEventListener('mouseup', this.boundMouseUp);
    this.canvas.removeEventListener('mousemove', this.boundMouseMove);
    window.removeEventListener('keydown', this.boundKeyDown);
    window.removeEventListener('keyup', this.boundKeyUp);
    this.expressionInput.hide();
    this.modeIndicator.dispose();
    this.phase = PolylinePhase.IDLE;
    this.startPoint = null;
    this.tangent = null;
    this.pendingStart = null;
    this.solvedPrev = null;
    this.solvedStartRef = null;
    this.ctrlHeld = false;

    this.removePreviewFromScene();
  }

  onSceneUpdate(sceneObjects: SceneObjectRender[], sketchId: string): void {
    this.sceneObjects = sceneObjects;
    this.sketchId = sketchId;
    const snapManager = SnapManager.fromSceneObjects(sceneObjects, sketchId, this.plane, this.ctx);
    this.updateSnapManager(snapManager);
    this.refreshVariables();

    if (this.phase === PolylinePhase.DRAWING && this.startPoint && this.solvedCtx) {
      this.resyncSolvedChain();
    }
  }

  override handleEscape(): boolean {
    // Typed coordinates clear first; only a clean pill lets Escape fall
    // through to backing out of the chain.
    if (this.handlePointInputEscape()) {
      return true;
    }
    const ctx = this.buildModeContext();
    if (ctx && this.currentMode.handleEscape(ctx)) {
      this.rebuildPreview();
      return true;            // mode backed out one sub-step (e.g. arc through-point)
    }
    if (this.phase === PolylinePhase.DRAWING) {
      if (ctx) {
        this.currentMode.exit(ctx);
      }
      this.expressionInput.hide();
      this.phase = PolylinePhase.IDLE;
      this.startPoint = null;
      this.tangent = null;
      this.pendingStart = null;
      this.solvedPrev = null;
      this.solvedStartRef = null;
      this.rebuildPreview();
      return true;            // chain ended; tool stays armed for a new chain
    }
    return false;             // idle -> let the toolbar disarm the tool
  }

  private buildModeContext(): ModeContext | null {
    if (!this.startPoint) {
      return null;
    }

    const planeNormal = new Vector3(this.plane.normal.x, this.plane.normal.y, this.plane.normal.z);

    return {
      plane: this.plane,
      previewGroup: this.previewGroup,
      camera: this.ctx.camera,
      planeNormal,
      tangent: this.tangent,
      startPoint: this.startPoint,
      pendingStartText: () => this.pendingStart ? this.formatPoint(this.pendingStart) : null,
      setSnapHint: (hint) => this.modeIndicator.setHint(hint),
      resolveCommittedValue: (result) => SketchTool.resolveCommittedValue(result, this.cachedVariables),
      formatPoint: (p) => this.formatPoint(p),
      solved: this.solvedCtx
        ? {
          prevEntity: () => this.solvedPrev
            ? { line: this.solvedPrev.line, featureType: this.solvedPrev.featureType }
            : null,
          prevKind: () => this.solvedPrev?.featureType ?? null,
          prevOrientedDir: () => this.solvedPrev?.orientedDir ?? null,
          emitSegment: (spec) => this.emitSolvedSegment(spec),
          autoConstraints: () => this.autoConstraintsEnabled(),
        }
        : null,
      requestRender: () => this.requestRender(),
      isOrthoOverride: () => this.ctrlHeld,
      showExpressionInput: (opts) => {
        if (!this.expressionInput.isVisible) {
          this.expressionInput.show({
            ...opts,
            variables: this.cachedVariables,
          });
        }
      },
      updateExpressionValue: (v) => this.expressionInput.updateValue(v),
      updateExpressionPosition: (x, y) => this.expressionInput.updatePosition(x, y),
      hideExpressionInput: () => this.expressionInput.hide(),
      isExpressionVisible: () => this.expressionInput.isVisible,
      isExpressionTyping: () => this.expressionInput.isTyping,
      commitExpressionValue: () => this.expressionInput.commitCurrentValue(),
      onSegmentCommitted: (result) => this.handleModeCommit(result),
    };
  }

  private handleModeCommit(result: import('./types').SegmentCommitResult): void {
    const { endpoint, exitTangent } = result;

    this.startPoint = endpoint;
    this.tangent = exitTangent;

    if (this.currentMode.requiresTangent && !this.tangent) {
      this.advanceToNextValidMode();
      this.modeIndicator.update(this.currentMode.id);
    }

    const newCtx = this.buildModeContext()!;
    this.currentMode.enter(newCtx);
    this.rebuildPreview();
  }

  private handleMouseDown(e: MouseEvent): void {
    this.downX = e.clientX;
    this.downY = e.clientY;
    this.syncModifiers(e);
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

    if (this.phase === PolylinePhase.IDLE) {
      this.beginChainAt(this.applyPointInput(result.point2d), result);
      return;
    }

    const modeCtx = this.buildModeContext();
    if (!modeCtx) {
      return;
    }

    const clickResult: ClickResult = this.currentMode.handleClick(point, result, modeCtx);

    if (clickResult.kind === 'committed') {
      this.handleModeCommit(clickResult.result);
    } else {
      this.rebuildPreview();
    }
  }

  /** Only the first vertex of a fresh chain; every later click is a segment,
   * whose dimension the mode's own input already covers. */
  protected override awaitingPoint(): boolean {
    return this.phase === PolylinePhase.IDLE;
  }

  protected override onTypedPoint(point: PickedPoint): void {
    this.beginChainAt(point);
  }

  /**
   * Open a chain at a picked point. A typed absolute address is deferred and
   * rides on the first segment as its explicit start argument
   * (`line(start, end)`) — one fully-specified statement; no pen exists.
   */
  private beginChainAt(picked: PickedPoint, snap?: SnapResult): void {
    this.pendingStart = null;
    this.solvedPrev = null;
    this.solvedStartRef = null;
    if (picked.typed) {
      this.pendingStart = picked;
    }

    if (this.solvedCtx && !picked.typed && snap?.ref && !this.ctrlHeld && this.autoConstraintsEnabled()) {
      // Opening the chain on an existing entity vertex: an endpoint of a
      // line/arc chains fully (junction coincident + tangent modes, exactly
      // like mid-chain); any other vertex just pins the first segment's
      // start with a coincident.
      const ref = snap.ref;
      if ((ref.featureType === 'line' || ref.featureType === 'arc')
        && (ref.role === 'start' || ref.role === 'end')) {
        const entity = this.findSolvedEntityByLine(ref.line);
        this.solvedPrev = {
          line: ref.line,
          featureType: ref.featureType,
          junctionRole: ref.role,
          orientedDir: entity ? solvedLineOrientedDir(entity) : null,
        };
      } else {
        this.solvedStartRef = ref;
      }
    }

    this.startPoint = picked.value;
    this.phase = PolylinePhase.DRAWING;
    // Solved sketches have no kernel pen; the tangent comes from the
    // (resumed) previous segment's geometry at the junction.
    this.tangent = this.solvedPrev ? this.solvedJunctionTangent() : null;

    if (!this.isModeUsable(this.currentMode, this.buildModeContext())) {
      this.advanceToNextValidMode();
    }

    const modeCtx = this.buildModeContext()!;
    this.currentMode.enter(modeCtx);
    this.modeIndicator.update(this.currentMode.id);
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
    this.lastSnapResult = result;

    this.modeIndicator.updatePosition(e.clientX, e.clientY);

    if (this.phase === PolylinePhase.DRAWING) {
      const modeCtx = this.buildModeContext();
      if (modeCtx) {
        this.currentMode.handleMouseMove(result.point2d, result, e.clientX, e.clientY, modeCtx);
      }
    }

    // Solved sketches: make the coincident inference visible before commit —
    // a snapped entity vertex will emit a constraint, Ctrl or the dialog's
    // Auto-constraints toggle suppresses it.
    // (The edge-snap hints that share this line are legacy-only.)
    if (this.solvedCtx) {
      this.modeIndicator.setHint(
        result.ref && !this.ctrlHeld && this.autoConstraintsEnabled() ? 'coincident' : null,
      );
    }

    this.rebuildPreview();
  }

  private handleKeyDown(e: KeyboardEvent): void {
    this.syncModifiers(e);
    if (e.key === ' ') {
      e.preventDefault();
      this.cycleMode(e.shiftKey ? -1 : 1);
      return;
    }
    if (e.key === 'Control' || e.key === 'Meta') {
      this.refreshAfterModifierChange();
    }
  }

  private handleKeyUp(e: KeyboardEvent): void {
    this.syncModifiers(e);
    if (e.key === 'Control' || e.key === 'Meta') {
      this.refreshAfterModifierChange();
    }
  }

  private syncModifiers(e: MouseEvent | KeyboardEvent): void {
    this.ctrlHeld = e.ctrlKey || e.metaKey;
  }

  // A Ctrl/Meta transition changes the ortho classification mid-gesture, so the
  // current mode re-sees the last mouse position under the new modifier state.
  private refreshAfterModifierChange(): void {
    if (this.phase !== PolylinePhase.DRAWING) {
      return;
    }
    const modeCtx = this.buildModeContext();
    if (modeCtx && this.mousePoint && this.lastSnapResult) {
      this.currentMode.handleMouseMove(this.mousePoint, this.lastSnapResult, this.lastClientX, this.lastClientY, modeCtx);
    }
    this.rebuildPreview();
  }

  // A mode is usable when its tangent requirement is met and its optional
  // availability gate passes. Availability only matters once a chain is being
  // drawn: with no context (IDLE) every mode counts as available.
  private isModeUsable(mode: SegmentMode, modeCtx: ModeContext | null): boolean {
    if (mode.requiresTangent && !this.tangent) {
      return false;
    }
    if (!modeCtx) {
      return true;
    }
    return mode.isAvailable?.(modeCtx) ?? true;
  }

  private cycleMode(direction: number): void {
    const modeCtx = this.buildModeContext();
    if (modeCtx) {
      this.expressionInput.hide();
      this.currentMode.exit(modeCtx);
    }

    const startIndex = this.currentModeIndex;
    for (let i = 0; i < MODE_ORDER.length; i++) {
      this.currentModeIndex = (this.currentModeIndex + direction + MODE_ORDER.length) % MODE_ORDER.length;
      const candidate = this.modes[this.currentModeIndex];
      if (this.isModeUsable(candidate, modeCtx)) {
        break;
      }
      if (this.currentModeIndex === startIndex) {
        break;
      }
    }

    this.modeIndicator.update(this.currentMode.id);

    if (this.phase === PolylinePhase.DRAWING) {
      const newCtx = this.buildModeContext();
      if (newCtx) {
        this.currentMode.enter(newCtx);
        if (this.mousePoint && this.lastSnapResult) {
          this.currentMode.handleMouseMove(this.mousePoint, this.lastSnapResult, this.lastClientX, this.lastClientY, newCtx);
        }
      }
    }

    this.rebuildPreview();
  }

  private advanceToNextValidMode(): void {
    const modeCtx = this.buildModeContext();
    const startIndex = this.currentModeIndex;
    for (let i = 0; i < MODE_ORDER.length; i++) {
      this.currentModeIndex = (this.currentModeIndex + 1) % MODE_ORDER.length;
      if (this.isModeUsable(this.modes[this.currentModeIndex], modeCtx)) {
        return;
      }
      if (this.currentModeIndex === startIndex) {
        return;
      }
    }
  }

  // ------------------------------------------------- solved-sketch chaining

  /**
   * Assemble and send one segment through the atomic insert-solved rail
   * (P5): the mode's geometry + constraints, prefixed by the junction
   * coincident to the previous segment (or the chain-start snap ref) and
   * suffixed by the end-snap coincident. The junction coincident is the
   * gesture itself (explicit); the snap coincidents and the mode's
   * auto-ortho row are inferred, and the rail's redundancy trial drops any
   * of them the sketch already enforces. Emissions are serialized on a
   * promise chain so each knows its predecessor's source line; a refusal
   * ends the chain (the preview no longer matches the source).
   */
  private emitSolvedSegment(spec: SolvedSegmentSpec): void {
    if (!this.solvedCtx) {
      return;
    }
    const constraints: SolvedConstraintParam[] = [];
    const prev = this.solvedPrev;
    const startRef = this.solvedStartRef;
    this.solvedStartRef = null;

    if (prev) {
      constraints.push(coincident(
        newTarget(0, 'start'),
        { line: prev.line, role: prev.junctionRole, featureType: prev.featureType },
      ));
    } else if (startRef) {
      constraints.push(inferred(coincident(newTarget(0, 'start'), refTarget(startRef))));
    }

    const endRef = spec.endSnap?.ref;
    // Up-to-2dp-rounding match: the emitted endpoint is always rounded while
    // the snapped vertex rarely sits on the grid — an exact comparison here
    // dropped nearly every end coincident onto solver-adjusted vertices.
    const endMatchesSnap = !spec.endPoint || !spec.endSnap
      || emittedPointOnSnap(spec.endPoint, spec.endSnap.point2d, spec.endSnap.ref);
    const isJunctionRef = (ref: SolvedVertexRef) =>
      (prev && ref.line === prev.line && ref.role === prev.junctionRole)
      || (startRef && sameVertexRef(ref, startRef));
    const keptEndRef = endRef && endMatchesSnap && !this.ctrlHeld
      && this.autoConstraintsEnabled() && !isJunctionRef(endRef) ? endRef : null;
    constraints.push(...(spec.constraints ?? []));
    if (keptEndRef) {
      constraints.push(inferred(coincident(newTarget(0, 'end'), refTarget(keptEndRef))));
    }

    // Spend the pending typed start's declarations (mirrors insertSegment).
    const pending = this.pendingStart;
    this.pendingStart = null;
    const modeVars = spec.newVariable === undefined
      ? []
      : Array.isArray(spec.newVariable) ? spec.newVariable : [spec.newVariable];
    const newVariables = [...(pending?.newVariables ?? []), ...modeVars];

    const emission = {
      geometry: [{ kind: spec.kind, text: spec.text }],
      constraints,
      ...(newVariables.length > 0 ? { newVariables } : {}),
    };
    // Optimistic bookkeeping so the NEXT segment's angle/tangent math has
    // its direction even before the line number arrives.
    const orientedDir = spec.kind === 'line' && spec.endPoint
      ? normalizedDir(this.startPoint, spec.endPoint) : null;
    const solvedCtx = this.solvedCtx;
    this.solvedEmitsPending++;
    this.solvedEmitChain = this.solvedEmitChain.then(async () => {
      const result = await solvedCtx.emit(emission);
      this.solvedEmitsPending--;
      if (result.success && result.geometryLines?.length) {
        this.solvedPrev = {
          line: result.geometryLines[0],
          featureType: spec.kind,
          junctionRole: 'end',
          orientedDir,
        };
      } else if (!result.success && this.phase === PolylinePhase.DRAWING) {
        // The source refused the segment — the drawn chain no longer matches
        // reality, so end it (the toast already named the reason).
        this.phase = PolylinePhase.IDLE;
        this.startPoint = null;
        this.tangent = null;
        this.solvedPrev = null;
        this.expressionInput.hide();
        this.rebuildPreview();
      }
    });
  }

  /** The solved entity view whose statement starts at `line`, if rendered. */
  private findSolvedEntityByLine(line: number): SolvedEntityView | null {
    const sketchObj = this.sceneObjects.find(obj => obj.id === this.sketchId);
    if (!sketchObj) {
      return null;
    }
    const model = buildSolvedSketchModel(sketchObj, this.sceneObjects);
    for (const e of model?.entities.values() ?? []) {
      if (e.obj.sourceLocation?.line === line) {
        return e;
      }
    }
    return null;
  }

  /** The drawing-direction tangent at the solved chain's junction — the
   * previous segment's geometric tangent, pointing away from the junction. */
  private solvedJunctionTangent(): TangentInfo | null {
    const prev = this.solvedPrev;
    if (!prev || !this.startPoint) {
      return null;
    }
    const entity = this.findSolvedEntityByLine(prev.line);
    if (!entity) {
      // Not rendered yet — fall back to the optimistic bookkeeping.
      return prev.orientedDir
        ? {
          direction: prev.junctionRole === 'end'
            ? prev.orientedDir
            : [-prev.orientedDir[0], -prev.orientedDir[1]],
          point: this.startPoint,
        }
        : null;
    }
    const dir = solvedTangentAt(entity, prev.junctionRole);
    return dir ? { direction: dir, point: this.startPoint } : null;
  }

  /**
   * Re-anchor the solved chain from the payload after each render: the
   * previous segment's statement may have re-solved (constraints move
   * guesses), so the chain continues from the entity's actual junction.
   */
  private resyncSolvedChain(): void {
    const prev = this.solvedPrev;
    if (!prev || this.solvedEmitsPending > 0) {
      return;
    }
    const entity = this.findSolvedEntityByLine(prev.line);
    if (!entity) {
      return;
    }
    const junction = entity[prev.junctionRole];
    if (!junction) {
      return;
    }
    this.startPoint = [junction[0], junction[1]];
    this.solvedPrev = { ...prev, orientedDir: solvedLineOrientedDir(entity) };
    const tangent = this.solvedJunctionTangent();
    if (tangent) {
      this.tangent = tangent;
    }
    this.rebuildPreview();
  }

  private rebuildPreview(): void {
    this.disposePreview();

    const planeNormal = new Vector3(this.plane.normal.x, this.plane.normal.y, this.plane.normal.z);

    if (this.phase === PolylinePhase.DRAWING) {
      const modeCtx = this.buildModeContext();
      if (modeCtx) {
        this.currentMode.rebuildPreview(modeCtx);
      }
    } else if (this.mousePoint && this.lastSnapType !== 'none') {
      const snapColor = this.lastSnapType === 'vertex' ? SNAP_VERTEX_COLOR : SNAP_GRID_COLOR;
      addDot(this.previewGroup, this.mousePoint, snapColor, this.ctx.camera, planeNormal, this.plane, 0.6);
    }

    this.requestRender();
  }
}

function normalizedDir(from: Point2D, to: Point2D): Point2D | null {
  const dx = to[0] - from[0];
  const dy = to[1] - from[1];
  const len = Math.hypot(dx, dy);
  return len > 1e-10 ? [dx / len, dy / len] : null;
}

/** A solved line entity's oriented (start→end) direction; null for arcs. */
function solvedLineOrientedDir(entity: SolvedEntityView): Point2D | null {
  if (entity.kind !== 'line' || !entity.start || !entity.end) {
    return null;
  }
  return normalizedDir(entity.start, entity.end);
}

/** The drawing-direction tangent leaving a solved line/arc at one of its
 * endpoints: away from the junction along the entity's geometry. */
function solvedTangentAt(entity: SolvedEntityView, role: 'start' | 'end'): Point2D | null {
  if (entity.kind === 'line') {
    const dir = solvedLineOrientedDir(entity);
    if (!dir) {
      return null;
    }
    return role === 'end' ? dir : [-dir[0], -dir[1]];
  }
  if (entity.kind === 'arc' && entity.center) {
    const p = entity[role];
    if (!p) {
      return null;
    }
    const dx = p[0] - entity.center[0];
    const dy = p[1] - entity.center[1];
    const len = Math.hypot(dx, dy);
    if (len < 1e-10) {
      return null;
    }
    // Sweep tangent at p: CCW = (-dy, dx); .cw() flips. Leaving from the
    // START runs backward along the sweep.
    const sweep: Point2D = entity.cw ? [dy / len, -dx / len] : [-dy / len, dx / len];
    return role === 'end' ? sweep : [-sweep[0], -sweep[1]];
  }
  return null;
}
