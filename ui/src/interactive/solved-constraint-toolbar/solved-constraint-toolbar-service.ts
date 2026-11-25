// Logic behind the solved constraint bar (sketch-rewrite P4): ordered picks
// (from the shared hover/select handler) → legality → statement emission via
// /api/sketch/add-constraint; the dimension flow — the new dimension rides
// the cursor until a click places it, then takes its value; delete of a
// picked constraint statement; and the live ghost — a client-side solve
// previewing the candidate constraint before anything is written.

import { Group } from 'three';
import { Line2 } from 'three/examples/jsm/lines/Line2.js';
import { LineGeometry } from 'three/examples/jsm/lines/LineGeometry.js';
import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js';
import { SceneContext } from '../../scene/scene-context';
import { SceneObjectRender, SourceLocation } from '../../types';
import { applySketchConstraint, insertSolvedGeometry, removeFeature } from '../../api';
import { ExpressionInput, VariableInfo } from '../../ui/expression-input';
import { themeColors } from '../../scene/theme-colors';
import { roundToUnitDecimals } from '../../units/units';
import { sceneUnit } from '../../units/scene-unit';
import { localToWorld, projectToSketch, sketchToClient } from '../sketch-plane-utils';
import { DimensionLabelPlacer } from '../dimension-label-placer';
import { dimensionLabelBox } from '../../meshes/containers/solved-constraint-meshes';
import type { SketchHoverSelectHandler, SolvedPick } from '../sketch-hover-select-handler';
import type { LabelCoords, SolvedConstraintView } from '../../sketch-solver-client';
import {
  LiveSolvedSystem,
  SolvedSketchModel,
  buildSolvedSketchModel,
  dimensionFrame,
  dimensionLabelText,
  layoutConstraintGlyphs,
  tessellateSolvedEntity,
} from '../../sketch-solver-client';
import { LineResolutionRegistry } from '../../meshes/shape-meshes/line-resolution';
import { isEllipseLike } from '../../sketch-solver-client/model';
import type { Vec2 } from '../../sketch-solver-client/resolve';
import { refPoint } from '../../sketch-solver-client/resolve';
import { CONSTRAINT_SHORTCUTS, SolvedConstraintToolbar } from './solved-constraint-toolbar';
import type { ShortcutManager } from '../../ui/shortcut-manager';
import type { SketchDeleteService } from '../sketch-delete-service';
import type { DeletePlan } from '../tools/delete-plan';
import {
  ConstraintButtonId,
  DimensionForm,
  axisChoiceMoot,
  axisDimensionPicks,
  axisFromCursor,
  candidateSpec,
  coincidentRingIds,
  coincidentsAtPicks,
  constraintOptions,
  describeCoincidentRemoval,
  dimensionCandidate,
  dimensionFormFor,
  expandDimensionPicks,
  inferTangency,
  isPointPick,
  measureDimension,
  orderMidpointPicks,
  pickRef,
  orientationReplacement,
  ellipseRadiusAxis,
} from './legality';
import {
  AngleSector,
  angleSectorAt,
  angleSectorFor,
  angleSectorTargets,
} from './angle-sector';
import { constraintTargetFor, sameStatementInstance } from './constraint-targets';
import { DimensionPreview } from './dimension-preview';

const GHOST_OPACITY = 0.45;
/** Entities whose params moved more than this ghost-preview. */
const GHOST_EPS = 1e-6;
/** Below this pointer travel a mousedown+up pair reads as a click (the
 * drag handlers' shared threshold) — placement commits, orbits pass. */
const CLICK_THRESHOLD_PX = 4;
/** The value input's half extents when it opens centered on a placed value —
 * how far its point has to stay inside the viewport for the field to fit. */
const CENTERED_INPUT_HALF_WIDTH_PX = 90;
const CENTERED_INPUT_HALF_HEIGHT_PX = 20;

/** A key that starts typing a dimension's value (or, for Enter, asks for
 * the field): pressed while a dimension is still under the cursor it skips
 * the placing click. */
const VALUE_START_KEY = /^([0-9.\-]|Enter)$/;

const ANGLE_FORM: DimensionForm = { kind: 'angle', axisChoice: false, tangencyChoice: false };

/**
 * A dimension on its way to being placed: its value rides the cursor, its
 * dimension line, leader or arc trailing behind, until a click drops it.
 * Where the cursor is also picks WHAT is measured when the picks leave that
 * open — the horizontal, vertical or aligned measure of a point pair, the
 * sector of two crossing lines.
 */
type DimensionPlacement = {
  id: 'dimension' | 'angle';
  /** The picks as they were made — a click on more geometry extends these. */
  source: SolvedPick[];
  /** The picks the statement names (a lone line is its endpoint pair) — the
   * aligned form measures and emits these. */
  rawPicks: SolvedPick[];
  /** The point pair the horizontal / vertical forms measure and emit (a
   * circle or arc stands in by its center); null when the picks have no
   * such forms. */
  axisPicks: [SolvedPick, SolvedPick] | null;
  form: DimensionForm;
  /** Distance: the axis the cursor's region selects. Ellipse radius: the
   * semi-axis the pick touched. */
  axis: 'x' | 'y' | undefined;
  /** Angle: the sector under the cursor. */
  sector: AngleSector | null;
  /** Where the value is asked to be, sketch-local; null until the pointer
   * is over the sketch — the dimension then shows where the automatic
   * layout puts it. */
  cursor: Vec2 | null;
  /** The placement the preview shows — what a click locks in; null while
   * the automatic layout is shown. */
  label: LabelCoords | null;
};

function picksKey(picks: SolvedPick[]): string {
  return picks.map(p => `${p.entityId}:${p.role ?? 'entity'}`).join('|');
}

export class SolvedConstraintToolbarService {
  private view: SolvedConstraintToolbar;
  private valueInput: ExpressionInput;
  private model: SolvedSketchModel | null = null;
  private sketchInfo: { line: number; filePath?: string } | null = null;
  private picks: SolvedPick[] = [];
  private busy = false;
  private dimensionArmed = false;
  private pickedConstraint: { objId?: string; sourceLocation?: SourceLocation } | null = null;
  /** Point–point coincidents the current vertex pick stands for — their
   * ring is not a pick target, so Delete reaches them through the vertex. */
  private vertexCoincidents: SolvedConstraintView[] = [];
  private handler: SketchHoverSelectHandler | null = null;
  private ghostGroup: Group | null = null;
  /** The dimension the open value input is creating — drives the preview
   * and survives re-renders (picks are entityId:role keyed). Angles carry
   * their locked sector (roles are stable; geometry re-anchors). */
  private pendingDimension: {
    picks: SolvedPick[];
    form: DimensionForm;
    sector?: AngleSector | null;
    /** Circle/arc distances: near (min, default) or far (max) side. */
    tangency?: 'min' | 'max';
    /** Distance: measured along one axis (placement-locked). */
    axis?: 'x' | 'y';
    /** Identity of the ORIGINAL picks (pre center-substitution) — the
     * armed flow's retarget test keys on it. */
    rawKey?: string;
    /** Where the dimension was placed, in its own frame — the commit writes
     * it as `.labelAt()`. Absent for a dimension with nowhere to place a
     * value, which opens on the automatic layout. */
    label?: LabelCoords;
  } | null = null;
  private placement: DimensionPlacement | null = null;
  private placementDown: { x: number; y: number; onCanvas: boolean } | null = null;
  /** The dimension being created, drawn the way the sketch will draw it. */
  private preview: DimensionPreview;
  private placer: DimensionLabelPlacer;
  /** Where the pointer is over the canvas, client px; null while it is
   * anywhere else. A placement that starts with the pointer on the sketch
   * (the armed tool's last pick, the D key) begins under it. */
  private pointer: { x: number; y: number } | null = null;
  private cachedVariables: VariableInfo[] = [];
  private boundKeyDown: (e: KeyboardEvent) => void;
  private boundPointerMove: (e: MouseEvent) => void;
  private boundPlacementDown: (e: MouseEvent) => void;
  private boundPlacementUp: (e: MouseEvent) => void;

  constructor(
    private container: HTMLElement,
    private ctx: SceneContext,
    private showMessage: (message: string) => void,
    private fetchVariables: () => Promise<VariableInfo[]>,
    shortcuts: ShortcutManager,
    /** The Delete key's action on selected edges — the bar's button and key route to it. */
    private entityDelete: SketchDeleteService,
  ) {
    this.view = new SolvedConstraintToolbar(container);
    this.valueInput = new ExpressionInput(container);
    this.preview = new DimensionPreview(ctx);
    this.placer = new DimensionLabelPlacer(ctx);
    this.view.onApply = (id) => void this.apply(id);
    // The chords live on the sketch-mode manager the drawing tools use, so
    // the two vocabularies cannot collide; each exists only while its button
    // would accept a click, so an illegal pick set leaves the key alone.
    for (const [id, keys] of Object.entries(CONSTRAINT_SHORTCUTS) as [ConstraintButtonId, string][]) {
      shortcuts.register(keys, () => void this.apply(id), {
        when: () => this.view.isVisible && this.view.isEnabled(id),
      });
    }
    this.view.onDelete = () => this.deletePicked();
    this.view.onHoverButton = (id) => this.updateGhost(id);
    this.boundKeyDown = this.handleKeyDown.bind(this);
    this.boundPointerMove = this.handlePointerMove.bind(this);
    this.boundPlacementDown = this.handlePlacementDown.bind(this);
    this.boundPlacementUp = this.handlePlacementUp.bind(this);
  }

  show(): void {
    if (!this.view.isVisible) {
      this.view.show();
      window.addEventListener('keydown', this.boundKeyDown);
      window.addEventListener('mousemove', this.boundPointerMove);
      void this.fetchVariables().then((variables) => {
        this.cachedVariables = variables;
        // A dimension typed before the read landed completes with it.
        if (this.valueInput.isVisible) {
          this.valueInput.setVariables(variables);
        }
      });
    }
  }

  hide(): void {
    if (this.view.isVisible) {
      window.removeEventListener('keydown', this.boundKeyDown);
      window.removeEventListener('mousemove', this.boundPointerMove);
    }
    this.view.hide();
    this.valueInput.hide();
    this.clearGhost();
    this.cancelPlacement();
    this.clearDimensionPreview();
    this.pointer = null;
    this.dimensionArmed = false;
    this.pickedConstraint = null;
    this.vertexCoincidents = [];
    this.handler?.setPinnedBadges([]);
    this.handler = null;
    this.picks = [];
    this.model = null;
    this.sketchInfo = null;
  }

  /** Per-render: rebuild the read model, re-resolve the picked constraint,
   * refresh the options. Called after the handlers digested the new scene. */
  sketchUpdated(
    sceneObjects: SceneObjectRender[],
    sketchObj: SceneObjectRender,
    handler: SketchHoverSelectHandler | null,
  ): void {
    this.model = buildSolvedSketchModel(sketchObj, sceneObjects);
    this.sketchInfo = sketchObj.sourceLocation
      ? { line: sketchObj.sourceLocation.line, filePath: sketchObj.sourceLocation.filePath }
      : null;
    this.clearGhost();
    // The picked constraint survives re-renders when its statement still
    // exists (objIds are re-minted; match by source line + loop occurrence,
    // or line-only matching re-anchors to a looped statement's first badge).
    if (this.pickedConstraint?.sourceLocation) {
      const loc = this.pickedConstraint.sourceLocation;
      const match = this.model?.constraints.find(
        c => sameStatementInstance(c.obj.sourceLocation, loc),
      );
      this.pickedConstraint = match
        ? { objId: match.obj.id, sourceLocation: match.obj.sourceLocation }
        : null;
    }
    this.refreshPendingDimension();
    this.refreshPlacement();
    this.refreshPicks(handler);
  }

  /** A re-render landed while the value input is open: re-anchor the
   * preview and the input to the new model, and refresh the measured seed
   * (updateValue respects typed text). The placement is in the dimension's
   * own frame, so it follows the geometry. Geometry gone ⇒ close. */
  private refreshPendingDimension(): void {
    const pending = this.pendingDimension;
    if (!pending || !this.valueInput.isVisible) {
      return;
    }
    const model = this.model;
    // Re-derive a locked angle sector against the fresh geometry (the roles
    // are its stable identity) and store it back: the commit reads the
    // stored sector, whose emission ORDER can legitimately flip when the
    // moving geometry carries the turn across 180°.
    if (pending.sector && model) {
      pending.sector = angleSectorFor(
        model, pending.picks[0], pending.picks[1], pending.sector.aRole, pending.sector.bRole,
      );
      if (!pending.sector) {
        this.valueInput.hide();
        return;
      }
    }
    const candidate = model
      ? dimensionCandidate(model, pending.picks, pending.form, pending.axis, pending.sector, pending.tangency)
      : null;
    if (!model || !candidate || candidate.value === undefined) {
      this.valueInput.hide();
      return;
    }
    this.drawPendingDimension(model, candidate, pending.label);
    const at = this.inputPosition(model, candidate, pending.label);
    this.valueInput.updatePosition(at.clientX, at.clientY);
    this.valueInput.updateValue(candidate.value);
  }

  /** The shared selection changed under a click — recompute the pick list
   * and options. A click on geometry (or on empty space) supersedes a
   * picked badge: Delete follows what the user picked last. */
  selectionChanged(handler: SketchHoverSelectHandler | null): void {
    this.pickedConstraint = null;
    this.refreshPicks(handler);
  }

  /** Recompute the pick list and options from the handler's selection. */
  private refreshPicks(handler: SketchHoverSelectHandler | null): void {
    this.handler = handler;
    this.picks = handler?.getSolvedPicks() ?? [];
    this.clearGhost();
    this.view.setOptions(constraintOptions(this.picks));
    this.vertexCoincidents = this.model ? coincidentsAtPicks(this.model, this.picks) : [];
    this.refreshDelete();
    // The armed dimension tool fires as soon as the picks form a legal
    // dimension — the pick that completes one puts it under the cursor to
    // be placed (locked plan §0.4). A further pick while the input is open
    // RE-TARGETS it (a lone line's length upgrades to line–line when the
    // second line lands), unless the user already typed a value.
    if (this.dimensionArmed) {
      const picks = this.armedDimensionPicks();
      if (!picks) {
        return;
      }
      const key = picksKey(expandDimensionPicks(picks));
      // An active placement on the same picks stays as-is (re-renders and
      // selection echoes must not reset the cursor-chosen form).
      const placing = this.placement !== null
        && picksKey(this.placement.rawPicks) === key;
      const retarget = this.valueInput.isVisible
        && !this.valueInput.isTyping
        && key !== (this.pendingDimension?.rawKey ?? '');
      if ((!this.valueInput.isVisible && !placing) || retarget) {
        this.beginDimension(picks);
      }
    }
  }

  /** A legal dimension pick set goes under the cursor to be placed. */
  private beginDimension(picks: SolvedPick[]): void {
    const form = dimensionFormFor(picks);
    if (form) {
      this.startPlacement('dimension', picks, form);
    }
  }

  /** The pick set the armed dimension tool dimensions: the full set when it
   * forms a dimension, else the MOST RECENT picks — the armed flow's toggle
   * policy accumulates, so a stray earlier pick (an edge caught next to the
   * intended vertex) must not wedge the tool shut. */
  private armedDimensionPicks(): SolvedPick[] | null {
    if (dimensionFormFor(this.picks)) {
      return this.picks;
    }
    if (this.picks.length > 2 && dimensionFormFor(this.picks.slice(-2))) {
      return this.picks.slice(-2);
    }
    if (this.picks.length > 1 && dimensionFormFor(this.picks.slice(-1))) {
      return this.picks.slice(-1);
    }
    return null;
  }

  /** A constraint badge was clicked — remember it for delete. */
  noteConstraintPick(pick: { objId?: string; sourceLocation?: SourceLocation }): void {
    this.pickedConstraint = pick;
    this.refreshDelete();
  }

  /**
   * The Delete key's plan for the selected edges, or null when none are
   * selected. The armed dimension tool owns the picks while it waits for
   * its second one — never a delete target.
   */
  private entityDeletePlan(): DeletePlan | null {
    return this.dimensionArmed ? null : this.entityDelete.plan();
  }

  /** What Delete targets right now: a picked badge first, else the
   * selected edges, else the coincidents behind the vertex pick — the ring
   * tints so the target is visible. */
  private refreshDelete(): void {
    if (this.pickedConstraint) {
      this.view.setDeleteEnabled(true);
      // The picked chip stays lit until the selection changes (an edge or
      // vertex pick, an empty-space click) or another chip is picked —
      // both routes replace `pickedConstraint` and land back here.
      this.handler?.setPinnedBadges(
        this.pickedConstraint.objId !== undefined ? [this.pickedConstraint.objId] : [],
      );
      return;
    }
    const entities = this.entityDeletePlan();
    if (entities) {
      if (entities.ok === false) {
        this.view.setDeleteEnabled(false, undefined, entities.reason);
      } else {
        this.view.setDeleteEnabled(true, entities.label);
      }
      this.handler?.setPinnedBadges([]);
      return;
    }
    const label = this.model ? describeCoincidentRemoval(this.model, this.vertexCoincidents) : null;
    this.view.setDeleteEnabled(label !== null, label ?? undefined);
    this.handler?.setPinnedBadges(
      this.model && label !== null ? coincidentRingIds(this.model, this.vertexCoincidents) : [],
    );
  }

  /** While the two-pick dimension tool is armed, plain clicks must
   * ACCUMULATE picks (the selection handler's toggle policy) — pick one,
   * pick two, get the value input; nobody holds Ctrl inside an armed tool. */
  get isDimensionArmed(): boolean {
    return this.dimensionArmed;
  }

  handleEscape(): boolean {
    if (this.valueInput.isVisible) {
      this.valueInput.hide();
      return true;
    }
    if (this.placement) {
      this.cancelPlacement();
      return true;
    }
    if (this.dimensionArmed) {
      this.setDimensionArmed(false);
      return true;
    }
    return false;
  }

  private handleKeyDown(e: KeyboardEvent): void {
    const startsValue = this.placement !== null && VALUE_START_KEY.test(e.key)
      && !e.ctrlKey && !e.metaKey && !e.altKey;
    if (!startsValue && e.key !== 'Delete' && e.key !== 'Backspace' && e.key !== 'Escape') {
      return;
    }
    const target = e.target as HTMLElement | null;
    if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) {
      return;
    }
    if (startsValue) {
      // The value input takes the focus inside this keydown, so the
      // character it types lands in the field, over the selected measure.
      // Enter only opens the field: the measured value is still to confirm.
      if (e.key === 'Enter') {
        e.preventDefault();
      }
      this.typeThroughPlacement();
      return;
    }
    // The drawing-tool Esc ladder (sketch-toolbar) only fires while a
    // drawing tool is armed — the solved flows (a dimension being placed,
    // armed dimension, open value input) own their Escape here.
    if (e.key === 'Escape') {
      if (this.handleEscape()) {
        e.preventDefault();
        e.stopPropagation();
      }
      return;
    }
    if (this.pickedConstraint || this.vertexCoincidents.length > 0 || this.entityDeletePlan()) {
      e.preventDefault();
      this.deletePicked();
    }
  }

  private setDimensionArmed(armed: boolean): void {
    this.dimensionArmed = armed;
    this.view.setDimensionArmed(armed);
  }

  // -- placing a dimension as it is drawn -------------------------------------

  /**
   * Put the dimension `picks` make under the cursor: its value follows the
   * pointer and its dimension line, leader or arc trails along, drawn as the
   * committed dimension will be. A click drops it there and opens the value
   * input on the spot. Typing a value instead skips the placing: the input
   * opens on the automatic layout, and no placement is written. Until the
   * pointer reaches the sketch (the bar's button was clicked) the automatic
   * layout is what shows. A dimension with nowhere to place a value (lines
   * too near parallel to meet, a span of no length) skips straight to the
   * input.
   */
  private startPlacement(id: 'dimension' | 'angle', picks: SolvedPick[], form: DimensionForm): void {
    const model = this.model;
    if (!model) {
      return;
    }
    this.valueInput.hide();
    this.cancelPlacement();
    const rawPicks = id === 'dimension' ? expandDimensionPicks(picks) : [...picks];
    // A lone ellipse dimensions ONE semi-radius: the axis its touch is
    // nearer to (RX at the ends of the RX axis, RY at the ends of RY).
    const ellipse = form.kind === 'radius' && rawPicks.length === 1 && isEllipseLike(rawPicks[0].kind);
    this.placement = {
      id,
      source: picks,
      rawPicks,
      axisPicks: this.axisPicksFor(model, picks, rawPicks, form),
      form,
      axis: ellipse ? ellipseRadiusAxis(model, rawPicks[0]) : undefined,
      sector: null,
      cursor: this.pointerOnSketch(model),
      label: null,
    };
    // Capture-phase on window: the click that places must not reach the
    // hover handler's selection toggle; >4px travels (orbits) pass through.
    window.addEventListener('mousedown', this.boundPlacementDown, true);
    window.addEventListener('mouseup', this.boundPlacementUp, true);
    this.refreshPlacement();
  }

  /**
   * The point pair the cursor can measure horizontally or vertically, or
   * null when the picks offer the aligned measure alone: no axis form at
   * all, or a pair already lying along an axis — the one axis the cursor
   * could pick measures what the aligned form measures.
   */
  private axisPicksFor(
    model: SolvedSketchModel,
    picks: SolvedPick[],
    rawPicks: SolvedPick[],
    form: DimensionForm,
  ): [SolvedPick, SolvedPick] | null {
    const axisPicks = form.kind === 'distance' && form.axisChoice ? axisDimensionPicks(picks) : null;
    if (!axisPicks) {
      return null;
    }
    const a = refPoint(model, pickRef(axisPicks[0]));
    const b = refPoint(model, pickRef(axisPicks[1]));
    return a && b && axisChoiceMoot(rawPicks, a, b) ? null : axisPicks;
  }

  private cancelPlacement(): void {
    if (!this.placement) {
      return;
    }
    this.placement = null;
    this.placementDown = null;
    window.removeEventListener('mousedown', this.boundPlacementDown, true);
    window.removeEventListener('mouseup', this.boundPlacementUp, true);
    this.preview.clear();
  }

  /** The picks the placement's current form measures and emits. */
  private placementPicks(p: DimensionPlacement): SolvedPick[] {
    return p.axis !== undefined && p.axisPicks ? p.axisPicks : p.rawPicks;
  }

  /** The pointer on the sketch plane; null while it is off the canvas. */
  private pointerOnSketch(model: SolvedSketchModel): Vec2 | null {
    return this.pointer
      ? projectToSketch(this.ctx, model.plane, this.pointer.x, this.pointer.y)
      : null;
  }

  /**
   * A value was typed while the dimension was still under the cursor: skip
   * the placing click. What is measured stays what the preview showed (the
   * cursor's form or sector); where its value goes is left to the automatic
   * layout — a spot the cursor merely happened to be at is not a placement
   * worth writing into the statement.
   */
  private typeThroughPlacement(): void {
    const p = this.placement;
    if (!p) {
      return;
    }
    const picks = this.placementPicks(p);
    this.cancelPlacement();
    this.openValueInput(p.id, picks, p.sector, p.axis, picksKey(p.rawPicks));
  }

  /**
   * Redraw the dimension being placed — the cursor moved, or a re-render
   * brought a fresh model (picks are entityId:role keyed — stable). Returns
   * whether it is still being placed: geometry that is gone cancels it, and
   * a dimension with nowhere to place a value hands over to the value input.
   */
  private refreshPlacement(): boolean {
    const p = this.placement;
    if (!p) {
      return false;
    }
    const outcome = this.drawPlacement(p);
    if (outcome === 'placing') {
      return true;
    }
    this.cancelPlacement();
    if (outcome === 'unplaceable') {
      this.openValueInput(p.id, this.placementPicks(p), p.sector, p.axis, picksKey(p.rawPicks));
    }
    return false;
  }

  private drawPlacement(p: DimensionPlacement): 'placing' | 'unplaceable' | 'gone' {
    const model = this.model;
    if (!model) {
      return 'gone';
    }
    if (p.id === 'angle') {
      // Two crossing lines bound four sectors — the cursor's is dimensioned.
      p.sector = angleSectorAt(model, p.rawPicks[0], p.rawPicks[1], p.cursor);
      if (!p.sector) {
        return 'gone';
      }
    } else if (p.axisPicks) {
      // The smart-dimension regions around the measured pair: above or
      // below it the horizontal measure, beside it the vertical one, inside
      // or diagonal the aligned one.
      const a = refPoint(model, pickRef(p.axisPicks[0]));
      const b = refPoint(model, pickRef(p.axisPicks[1]));
      p.axis = p.cursor && a && b ? axisFromCursor(a, b, p.cursor) : undefined;
    }
    const picks = this.placementPicks(p);
    // Axis forms measure center-to-center — no tangency side exists.
    const tangency = p.axis !== undefined ? undefined : inferTangency(model, picks, p.form);
    const candidate = dimensionCandidate(model, picks, p.form, p.axis, p.sector, tangency);
    if (!candidate) {
      return 'gone';
    }
    const frame = dimensionFrame(model, candidate);
    if (!frame) {
      return 'unplaceable';
    }
    p.label = p.cursor
      ? this.placer.coordsFor(
        model.plane, frame, p.cursor, dimensionLabelBox(dimensionLabelText(model, candidate)),
      )
      : null;
    this.preview.show(
      model,
      p.label ? { ...candidate, label: p.label } : candidate,
      { value: true, inHand: p.label !== null },
    );
    return 'placing';
  }

  private handlePointerMove(e: MouseEvent): void {
    // Only the canvas carries the value: over the bar or a panel the
    // pointer is not on the sketch, whatever the plane behind it says.
    const onCanvas = e.target === this.ctx.renderer.domElement;
    this.pointer = onCanvas ? { x: e.clientX, y: e.clientY } : null;
    const p = this.placement;
    const model = this.model;
    if (!p || !model || !onCanvas) {
      return;
    }
    const cursor = projectToSketch(this.ctx, model.plane, e.clientX, e.clientY);
    if (cursor) {
      p.cursor = cursor;
      this.refreshPlacement();
    }
  }

  private handlePlacementDown(e: MouseEvent): void {
    if (!this.placement) {
      return;
    }
    this.placementDown = {
      x: e.clientX,
      y: e.clientY,
      onCanvas: e.target === this.ctx.renderer.domElement,
    };
  }

  private handlePlacementUp(e: MouseEvent): void {
    const down = this.placementDown;
    this.placementDown = null;
    const p = this.placement;
    if (!p || !down || !down.onCanvas) {
      return;
    }
    if (Math.hypot(e.clientX - down.x, e.clientY - down.y) > CLICK_THRESHOLD_PX) {
      return;
    }
    if (this.clickExtendsPicks(p)) {
      // The click is a pick: the selection takes it, and the armed tool
      // re-targets the dimension from the new pick set.
      return;
    }
    e.stopPropagation();
    e.preventDefault();
    // The click IS the placement: the value lands exactly under it, even
    // when no move event brought the cursor there first.
    const model = this.model;
    const cursor = model ? projectToSketch(this.ctx, model.plane, e.clientX, e.clientY) : null;
    if (cursor) {
      p.cursor = cursor;
      if (!this.refreshPlacement()) {
        return;
      }
    }
    const picks = this.placementPicks(p);
    const { id, sector, axis, label } = p;
    const rawKey = picksKey(p.rawPicks);
    this.cancelPlacement();
    this.openValueInput(id, picks, sector, axis, rawKey, label ?? undefined);
  }

  /**
   * Does a click right now add a pick instead of dropping the dimension?
   * Only while the armed tool is placing a ONE-pick dimension (a line's
   * length, a circle's diameter, an arc's radius) and the cursor is on
   * geometry that makes a two-pick dimension with it: the line's length
   * becomes the distance to the second line. A dimension that already has
   * its two picks is complete — every click places it, wherever it lands.
   */
  private clickExtendsPicks(p: DimensionPlacement): boolean {
    if (!this.dimensionArmed || p.id !== 'dimension' || p.source.length !== 1) {
      return false;
    }
    const extra = this.handler?.hoverPick() ?? null;
    return extra !== null && dimensionFormFor([p.source[0], extra]) !== null;
  }

  private async apply(id: ConstraintButtonId): Promise<void> {
    if (this.busy || !this.model || !this.sketchInfo) {
      return;
    }
    this.cancelPlacement();

    if (id === 'dimension' && !dimensionFormFor(this.picks)) {
      // Arm the two-pick flow: the next legal pick set goes under the cursor.
      this.setDimensionArmed(!this.dimensionArmed);
      return;
    }

    if (id === 'angle') {
      // ∠ on two picked lines: the sector under the cursor is dimensioned,
      // its arc drawn through the cursor.
      if (this.picks.length === 2) {
        this.startPlacement('angle', this.picks, ANGLE_FORM);
      }
      return;
    }

    if (id === 'dimension') {
      this.beginDimension(this.picks);
      return;
    }

    const spec = candidateSpec(id, this.specPicks(id));
    if (!spec) {
      return;
    }
    await this.emit(id, this.orderedTargets(id), undefined, undefined);
  }

  /** Picks in the order `candidateSpec` reads them: the three-point
   * Midpoint form puts the constrained point (geometry decides which)
   * first; every other kind reads the raw pick order. */
  private specPicks(id: ConstraintButtonId): SolvedPick[] {
    if (id === 'midpoint' && this.model) {
      return orderMidpointPicks(this.model, this.picks);
    }
    return this.picks;
  }

  /** Emission arg order per kind (the statement forms are positional):
   * midpoint(point, line) / midpoint(point, a, b); symmetric(a, b,
   * mirrorLine) — the point form gathers the points first, the entity form
   * keeps pick order; rest keep pick order. */
  private orderedTargets(id: ConstraintButtonId): SolvedPick[] {
    if (id === 'midpoint') {
      if (this.picks.length === 3) {
        return this.specPicks(id);
      }
      const point = this.picks.find(isPointPick)!;
      const line = this.picks.find(p => p !== point)!;
      return [point, line];
    }
    if (id === 'symmetric') {
      const points = this.picks.filter(isPointPick);
      if (points.length === 2) {
        const line = this.picks.find(p => !isPointPick(p))!;
        return [...points, line];
      }
      // Entity form: pick order is the statement order — the two entities,
      // then the mirror line (legality demands it last).
      return this.picks;
    }
    return this.picks;
  }

  /**
   * Open the value input on a dimension. `label` is where it was placed (in
   * its own frame): the input opens centered on that spot and the commit
   * writes the placement with the statement. Without one the dimension sits
   * where the automatic layout puts it.
   */
  private openValueInput(
    id: 'dimension' | 'angle',
    dimPicks: SolvedPick[],
    sector?: AngleSector | null,
    axis?: 'x' | 'y',
    rawKey?: string,
    label?: LabelCoords,
  ): void {
    const model = this.model;
    if (!model) {
      return;
    }
    const form = id === 'angle' ? ANGLE_FORM : dimensionFormFor(dimPicks);
    if (!form) {
      return;
    }
    // A lone line dimensions its own length — the endpoint-pair distance.
    const picks = id === 'dimension' ? expandDimensionPicks(dimPicks) : [...dimPicks];
    // A lone ellipse dimensions ONE semi-radius: the axis its touch is
    // nearer to (RX at the ends of the RX axis, RY at the ends of RY).
    if (form.kind === 'radius' && picks.length === 1 && isEllipseLike(picks[0].kind) && axis === undefined) {
      axis = ellipseRadiusAxis(model, picks[0]);
    }
    // An angle dimensions a SECTOR — the placement-locked one, or the
    // default between the start→end directions.
    const angleSector = id === 'angle'
      ? sector ?? angleSectorAt(model, picks[0], picks[1], null)
      : null;
    if (id === 'angle' && !angleSector) {
      return;
    }
    // Circle/arc distances pick their tangency side from the TOUCH: a click
    // on the side of the circumference facing the other target measures the
    // near side (min, the default); the opposite side measures far (max).
    // The timeline row's "Use min/max tangent" flips a committed statement.
    // Axis forms measure center-to-center — no tangency side exists.
    const tangency = axis !== undefined ? undefined : inferTangency(model, picks, form);
    const candidate = dimensionCandidate(model, picks, form, axis, angleSector, tangency);
    if (!candidate || candidate.value === undefined) {
      return;
    }
    // The input opens where the dimension's value will be drawn, with the
    // rest of the dimension previewed around it (drawn after show() — a
    // re-targeting show() runs the previous cycle's onHide).
    const { clientX, clientY } = this.inputPosition(model, candidate, label);
    this.valueInput.show({
      label: form.kind === 'angle' ? '∠'
        : form.kind === 'radius' ? (picks[0] && isEllipseLike(picks[0].kind) ? (axis === 'y' ? 'RY' : 'RX') : 'R')
          : form.kind === 'diameter' ? '⌀'
            : axis === 'x' ? 'H' : axis === 'y' ? 'V' : 'D',
      value: String(candidate.value),
      clientX,
      clientY,
      centered: label !== undefined,
      variables: this.cachedVariables,
      onHide: () => this.clearDimensionPreview(),
      // There are no negative angles — a sector's angle is its own positive
      // measure; the other side is another sector. Inline refusal keeps the
      // input open for a corrected value.
      validate: form.kind !== 'angle' ? undefined : (expression) => {
        const num = parseFloat(expression);
        const isNumeric = !isNaN(num) && String(num) === expression;
        return isNumeric && (num < 0 || num >= 360)
          ? 'Angles are 0–360° — dimension the other side by picking its sector'
          : null;
      },
      onCommit: ({ expression, newVariable }) => {
        const num = parseFloat(expression);
        const isNumeric = !isNaN(num) && String(num) === expression;
        // Re-renders under the open input re-derive the sector (its
        // emission ORDER can flip past 180°) — read the fresh one before
        // hide() clears it.
        const sectorNow = this.pendingDimension?.sector ?? angleSector;
        this.valueInput.hide();
        this.setDimensionArmed(false);
        // A declaring commit (`pitch = 64`, or a fresh name over the
        // measured value) names the variable in the statement and rides
        // the declaration along — a `param()` initializer lands at the top
        // of the part body, exactly as the dialogs' fields do.
        const finalExpr = newVariable
          ? newVariable.name
          : isNumeric ? String(Math.round(num * 100) / 100) : expression;
        const kind = form.kind === 'angle' ? 'angle' : form.kind;
        // The sector orders the arguments and orients each line ('start'
        // renders as the .start() accessor) so the statement names the
        // dimensioned sector with a positive value.
        const emitPicks = form.kind === 'angle' && sectorNow
          ? angleSectorTargets(picks[0], picks[1], sectorNow)
          : picks;
        void this.emit(
          kind as ConstraintButtonId, emitPicks, finalExpr, axis,
          tangency === 'max' ? 'max' : undefined,
          newVariable ? [newVariable] : undefined,
          // Rounded like a dragged label: what is written is a number a
          // person can read back.
          label ? [
            roundToUnitDecimals(label[0], sceneUnit.current),
            roundToUnitDecimals(label[1], sceneUnit.current),
          ] : undefined,
        );
      },
    });
    this.pendingDimension = {
      picks, form, sector: angleSector, tangency, axis,
      rawKey: rawKey ?? picksKey(picks),
      ...(label ? { label } : {}),
    };
    this.drawPendingDimension(model, candidate, label);
  }

  /**
   * Where the value input opens, client px: on the dimension's value. A
   * placed dimension gives the center of its text (the input opens centered
   * there); an automatic one the spot its label is laid out from. Clamped
   * into the viewport; with no spot at all it falls back to under the bar.
   */
  private inputPosition(
    model: SolvedSketchModel,
    candidate: SolvedConstraintView,
    label: LabelCoords | undefined,
  ): { clientX: number; clientY: number } {
    const rect = this.container.getBoundingClientRect();
    const frame = label ? dimensionFrame(model, candidate) : null;
    const center = frame && label
      ? this.placer.centerOf(
        model.plane, frame, label, dimensionLabelBox(dimensionLabelText(model, candidate)),
      )
      : null;
    if (center) {
      const at = sketchToClient(this.ctx, model.plane, center);
      return {
        clientX: Math.min(
          Math.max(at.clientX, rect.left + CENTERED_INPUT_HALF_WIDTH_PX),
          rect.right - CENTERED_INPUT_HALF_WIDTH_PX,
        ),
        clientY: Math.min(
          Math.max(at.clientY, rect.top + CENTERED_INPUT_HALF_HEIGHT_PX),
          rect.bottom - CENTERED_INPUT_HALF_HEIGHT_PX,
        ),
      };
    }
    const value = layoutConstraintGlyphs({ ...model, constraints: [candidate] })
      .find(glyph => glyph.type === 'text' || glyph.type === 'angle-arc');
    if (!value || !('at' in value)) {
      return { clientX: rect.left + rect.width / 2 - 60, clientY: rect.top + 190 };
    }
    const at = sketchToClient(this.ctx, model.plane, value.at);
    return {
      clientX: Math.min(Math.max(at.clientX, rect.left + 8), rect.right - 180),
      clientY: Math.min(Math.max(at.clientY, rect.top + 60), rect.bottom - 24),
    };
  }

  /** The dimension around the open value input: its line, leader or arc
   * where the commit will draw them — the input itself stands in for the
   * value. */
  private drawPendingDimension(
    model: SolvedSketchModel,
    candidate: SolvedConstraintView,
    label: LabelCoords | undefined,
  ): void {
    this.preview.show(model, label ? { ...candidate, label } : candidate, { value: false });
  }

  private clearDimensionPreview(): void {
    this.pendingDimension = null;
    this.preview.clear();
  }

  private async emit(
    kind: ConstraintButtonId | 'distance' | 'radius' | 'diameter',
    picks: SolvedPick[],
    valueExpr: string | undefined,
    axis: 'x' | 'y' | undefined,
    tangency?: 'max',
    newVariables?: { name: string; initializer: string }[],
    /** A dimension placed as it was drawn: its `.labelAt()` position. */
    label?: LabelCoords,
  ): Promise<void> {
    const info = this.sketchInfo;
    if (!info) {
      return;
    }
    const statementKind = kind === 'dimension' ? 'distance' : kind;
    const targets = picks.map(constraintTargetFor);
    if (targets.some(t => t.line !== undefined && t.line < 0)) {
      this.showMessage('The picked geometry has no source statement');
      return;
    }
    // A lone line/ellipse has ONE orientation: a repeated H/V is a no-op,
    // the other kind replaces what is there in the same edit (never a
    // second statement the solver can only report as a conflict).
    const orientation = (kind === 'horizontal' || kind === 'vertical') && this.model
      ? orientationReplacement(this.model, kind, picks)
      : null;
    if (orientation && orientation.alreadyApplied.length > 0) {
      this.showMessage(`Already ${kind}`);
      return;
    }
    const removalLines = (orientation?.replaced ?? [])
      .map(c => c.obj.sourceLocation?.line)
      .filter((line): line is number => typeof line === 'number');
    if (orientation && removalLines.length === orientation.replaced.length && removalLines.length > 0) {
      this.busy = true;
      this.view.setBusy(true);
      const swapped = await insertSolvedGeometry({
        sketchLine: info.line,
        filePath: info.filePath,
        geometry: [],
        constraints: [{ kind, targets }],
        removals: [...new Set(removalLines)].map(line => ({ line })),
      });
      this.busy = false;
      this.view.setBusy(false);
      if (!swapped.success) {
        this.showMessage(swapped.reason ?? `Could not add the ${kind} constraint`);
      }
      return;
    }
    this.busy = true;
    this.view.setBusy(true);
    const result = await applySketchConstraint({
      sketchLine: info.line,
      filePath: info.filePath,
      kind: statementKind,
      targets,
      ...(valueExpr !== undefined ? { valueExpr } : {}),
      ...(axis !== undefined ? { axis } : {}),
      ...(tangency !== undefined ? { tangency } : {}),
      ...(label !== undefined ? { label } : {}),
      ...(newVariables !== undefined ? { newVariables } : {}),
    });
    this.busy = false;
    this.view.setBusy(false);
    if (!result.success) {
      this.showMessage(result.reason ?? `Could not add the ${statementKind} constraint`);
    }
  }

  private deletePicked(): void {
    const loc = this.pickedConstraint?.sourceLocation;
    if (loc) {
      // Constraint removal is a statement deletion, never a geometry rewrite
      // (locked plan §0.1) — the timeline's remove rail does exactly that.
      removeFeature(loc);
      this.pickedConstraint = null;
      this.refreshDelete();
      return;
    }
    if (this.entityDeletePlan()) {
      void this.entityDelete.run();
      return;
    }
    void this.deleteVertexCoincidents();
  }

  /** Remove every coincident the vertex pick stands for in ONE edit — the
   * insert-solved rail's removals (one statement per remove-feature message
   * would race each other's line shifts). */
  private async deleteVertexCoincidents(): Promise<void> {
    const info = this.sketchInfo;
    const targets = this.vertexCoincidents;
    if (this.busy || !info || targets.length === 0) {
      return;
    }
    const lines = targets
      .map(c => c.obj.sourceLocation?.line)
      .filter((line): line is number => typeof line === 'number');
    if (lines.length !== targets.length) {
      this.showMessage('The coincident has no source statement');
      return;
    }
    this.busy = true;
    this.view.setBusy(true);
    const result = await insertSolvedGeometry({
      sketchLine: info.line,
      filePath: info.filePath,
      geometry: [],
      constraints: [],
      removals: [...new Set(lines)].map(line => ({ line })),
    });
    this.busy = false;
    this.view.setBusy(false);
    if (!result.success) {
      this.showMessage(result.reason ?? 'Could not remove the coincident');
    }
  }

  // -- live ghost -----------------------------------------------------------

  /** Preview the solve with the candidate constraint as a temporary row —
   * cheap (client-side solve on a throwaway system). Dimensional candidates
   * preview at their measured value, which is already satisfied, so only
   * the valueless constraints show motion. */
  private updateGhost(id: ConstraintButtonId | null): void {
    this.clearGhost();
    const model = this.model;
    if (!id || !model?.solver) {
      return;
    }
    let value: number | undefined;
    let sector: AngleSector | null = null;
    if (id === 'dimension' || id === 'angle') {
      const form = id === 'angle' ? ANGLE_FORM : dimensionFormFor(this.picks);
      if (id === 'angle' && this.picks.length === 2) {
        sector = angleSectorAt(model, this.picks[0], this.picks[1], null);
      }
      value = form ? measureDimension(model, this.picks, form, undefined, sector) ?? undefined : undefined;
    }
    const spec = candidateSpec(id, this.specPicks(id), value, undefined, sector);
    if (!spec) {
      return;
    }
    // The ghost previews what the click WRITES: an H/V that replaces the
    // entity's other orientation solves without the replaced statement.
    const orientation = id === 'horizontal' || id === 'vertical'
      ? orientationReplacement(model, id, this.picks)
      : null;
    let snapshot = model.solver;
    if (orientation && orientation.replaced.length > 0) {
      const dropped = new Set(orientation.replaced.map(c => c.obj.object?.constraintId as number | undefined));
      snapshot = { ...snapshot, constraints: snapshot.constraints.filter(c => !dropped.has(c.id)) };
    }
    const live = LiveSolvedSystem.fromSnapshot(snapshot);
    if (!live) {
      return;
    }
    try {
      live.constrain(spec);
    } catch {
      return;
    }
    live.solve();

    const plane = model.plane;
    const group = new Group();
    group.userData.isMetaShape = true;
    group.renderOrder = 5;
    let anyMoved = false;
    for (const [entityId, view] of model.entities) {
      const before = model.solver.entities.find(e => e.id === entityId);
      const offset = before?.paramOffset ?? -1;
      const g = live.entityGeometry(entityId);
      if (!g || offset < 0) {
        continue;
      }
      const params = live.entityParams(entityId);
      const moved = params.some((v, i) => Math.abs(v - model.solver!.params[offset + i]) > GHOST_EPS);
      if (!moved) {
        continue;
      }
      anyMoved = true;
      const ghostView = { ...view, ...g };
      const points = tessellateSolvedEntity(ghostView);
      if (!points || points.length < 2) {
        continue;
      }
      const positions: number[] = [];
      for (const p of points) {
        const world = localToWorld(p, plane);
        positions.push(world.x, world.y, world.z);
      }
      const geometry = new LineGeometry();
      geometry.setPositions(positions);
      const material = new LineMaterial({
        color: themeColors.highlightColor.getHex(),
        linewidth: 2,
        transparent: true,
        opacity: GHOST_OPACITY,
        depthWrite: false,
        depthTest: false,
      });
      LineResolutionRegistry.register(material);
      const line = new Line2(geometry, material);
      line.renderOrder = 5;
      group.add(line);
    }
    if (!anyMoved) {
      return;
    }
    this.ctx.scene.add(group);
    this.ghostGroup = group;
    this.ctx.requestRender();
  }

  private clearGhost(): void {
    if (!this.ghostGroup) {
      return;
    }
    this.ctx.scene.remove(this.ghostGroup);
    this.ghostGroup.traverse((child) => {
      const mesh = child as unknown as { geometry?: { dispose(): void }; material?: { dispose(): void } };
      mesh.geometry?.dispose?.();
      mesh.material?.dispose?.();
    });
    this.ghostGroup = null;
    this.ctx.requestRender();
  }
}
