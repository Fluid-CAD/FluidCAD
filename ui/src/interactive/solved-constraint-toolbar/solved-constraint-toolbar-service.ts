// Logic behind the solved constraint bar (sketch-rewrite P4): ordered picks
// (from the shared hover/select handler) → legality → statement emission via
// /api/sketch/add-constraint; the two-pick dimension flow with a value
// input; delete of a picked constraint statement; and the live ghost — a
// client-side solve previewing the candidate constraint before anything is
// written.

import { BufferGeometry, Float32BufferAttribute, Group, Line, LineBasicMaterial } from 'three';
import { Line2 } from 'three/examples/jsm/lines/Line2.js';
import { LineGeometry } from 'three/examples/jsm/lines/LineGeometry.js';
import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js';
import { SceneContext } from '../../scene/scene-context';
import { SceneObjectRender, SourceLocation } from '../../types';
import { applySketchConstraint, removeFeature } from '../../api';
import { ExpressionInput, VariableInfo } from '../../ui/expression-input';
import { themeColors } from '../../scene/theme-colors';
import { localToWorld, projectToSketch, sketchToClient } from '../sketch-plane-utils';
import {
  ANGLE_ARC_PX_RADIUS,
  buildAngleArc,
  buildAngleExtensions,
  buildDimensionReadout,
} from '../../meshes/containers/solved-constraint-meshes';
import { buildDimensionArrows } from '../../meshes/containers/dimension-arrows';
import type { SketchHoverSelectHandler, SolvedPick } from '../sketch-hover-select-handler';
import type { ArrowEnds } from '../../sketch-solver-client';
import { angleLabelPlacement } from '../../sketch-solver-client';
import type { AngleLabelPlacement } from '../../sketch-solver-client';
import {
  LiveSolvedSystem,
  SolvedSketchModel,
  buildSolvedSketchModel,
  tessellateSolvedEntity,
} from '../../sketch-solver-client';
import { LineResolutionRegistry } from '../../meshes/shape-meshes/line-resolution';
import type { Vec2 } from '../../sketch-solver-client/resolve';
import { refPoint } from '../../sketch-solver-client/resolve';
import { SolvedConstraintToolbar } from './solved-constraint-toolbar';
import {
  ConstraintButtonId,
  DimensionForm,
  DimensionPreviewLayout,
  axisDimensionPicks,
  axisFromCursor,
  candidateSpec,
  constraintOptions,
  dimensionFormFor,
  dimensionPreviewLayout,
  distancePlacementMoot,
  expandDimensionPicks,
  inferTangency,
  isPointPick,
  measureDimension,
  pickRef,
} from './legality';
import {
  AngleSector,
  angleSectorAt,
  angleSectorFor,
  angleSectorTargets,
} from './angle-sector';
import { constraintTargetFor, sameStatementInstance } from './constraint-targets';

const GHOST_OPACITY = 0.45;
/** Entities whose params moved more than this ghost-preview. */
const GHOST_EPS = 1e-6;
/** = the committed leader's LEADER_OPACITY (solved-constraint-meshes). */
const PREVIEW_LEADER_OPACITY = 0.45;
/** Live sector preview during angle placement (label included). */
const PLACEMENT_OPACITY = 0.65;
/** Pixel offset from the arc center to the value input — the committed
 * glyph's label radius ((ANGLE_ARC_RADIUS + textSize) in arc px). */
const ANGLE_INPUT_OFFSET_PX = 46;
/** The value input's half extents, standing in for the label box when the
 * adaptive angle placement positions it (see angleLabelPlacement). */
const ANGLE_INPUT_HALF_WIDTH_PX = 60;
const ANGLE_INPUT_HALF_HEIGHT_PX = 16;
/** Below this pointer travel a mousedown+up pair reads as a click (the
 * drag handlers' shared threshold) — placement commits, orbits pass. */
const CLICK_THRESHOLD_PX = 4;

function picksKey(picks: SolvedPick[]): string {
  return picks.map(p => `${p.entityId}:${p.role ?? 'entity'}`).join('|');
}

/** The value input's spot on an angle preview — the committed readout's
 * adaptive placement with the input's box standing in for the label's, so
 * a thin wedge pushes the input out (or beside the arc) instead of parking
 * it on both rays at once. */
function angleInputPlacement(arc: { startAngle: number; sweep: number }): AngleLabelPlacement {
  return angleLabelPlacement(
    arc.startAngle, arc.sweep,
    ANGLE_INPUT_HALF_WIDTH_PX, ANGLE_INPUT_HALF_HEIGHT_PX,
    ANGLE_INPUT_OFFSET_PX, ANGLE_ARC_PX_RADIUS,
  );
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
  private ghostGroup: Group | null = null;
  /** The dimension the open value input is creating — drives the preview
   * leader line and survives re-renders (picks are entityId:role keyed).
   * Angles carry their locked sector (roles are stable; geometry
   * re-anchors). */
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
  } | null = null;
  private previewGroup: Group | null = null;
  /** Interactive angle placement (FreeCAD-style): the sector under the
   * cursor previews live; a click locks it and opens the value input. */
  private anglePlacement: {
    picks: [SolvedPick, SolvedPick];
    sector: AngleSector;
    lastCursor: [number, number] | null;
  } | null = null;
  /** Interactive distance placement: the cursor's smart-dimension region
   * picks the form — within the pair's x-range above/below → horizontal,
   * within the y-range beside → vertical, else aligned — and a click locks
   * it and opens the value input (mirrors the angle placement). */
  private distancePlacement: {
    /** Expanded original picks — the aligned region measures/emits these. */
    rawPicks: SolvedPick[];
    /** Center-substituted point pair — the axis regions measure/emit these. */
    axisPicks: [SolvedPick, SolvedPick];
    form: DimensionForm;
    axis: 'x' | 'y' | undefined;
  } | null = null;
  private placementGroup: Group | null = null;
  private placementTexture: { dispose(): void } | null = null;
  private placementDown: { x: number; y: number; onCanvas: boolean } | null = null;
  private cachedVariables: VariableInfo[] = [];
  private boundKeyDown: (e: KeyboardEvent) => void;
  private boundPlacementMove: (e: MouseEvent) => void;
  private boundDistanceMove: (e: MouseEvent) => void;
  private boundPlacementDown: (e: MouseEvent) => void;
  private boundPlacementUp: (e: MouseEvent) => void;

  constructor(
    private container: HTMLElement,
    private ctx: SceneContext,
    private showMessage: (message: string) => void,
    private fetchVariables: () => Promise<VariableInfo[]>,
  ) {
    this.view = new SolvedConstraintToolbar(container);
    this.valueInput = new ExpressionInput(container);
    this.view.onApply = (id) => void this.apply(id);
    this.view.onDelete = () => this.deletePicked();
    this.view.onHoverButton = (id) => this.updateGhost(id);
    this.boundKeyDown = this.handleKeyDown.bind(this);
    this.boundPlacementMove = this.handlePlacementMove.bind(this);
    this.boundDistanceMove = this.handleDistanceMove.bind(this);
    this.boundPlacementDown = this.handlePlacementDown.bind(this);
    this.boundPlacementUp = this.handlePlacementUp.bind(this);
  }

  show(): void {
    if (!this.view.isVisible) {
      this.view.show();
      window.addEventListener('keydown', this.boundKeyDown);
      void this.fetchVariables().then((variables) => {
        this.cachedVariables = variables;
      });
    }
  }

  hide(): void {
    if (this.view.isVisible) {
      window.removeEventListener('keydown', this.boundKeyDown);
    }
    this.view.hide();
    this.valueInput.hide();
    this.clearGhost();
    this.clearDimensionPreview();
    this.cancelAnglePlacement();
    this.cancelDistancePlacement();
    this.dimensionArmed = false;
    this.pickedConstraint = null;
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
    this.refreshAnglePlacement();
    this.refreshDistancePlacement();
    this.selectionChanged(handler);
  }

  /** A re-render landed during distance placement: redraw the preview
   * against the fresh model (picks are entityId:role keyed — stable).
   * Geometry gone ⇒ drawDistancePreview cancels itself. */
  private refreshDistancePlacement(): void {
    if (this.distancePlacement) {
      this.drawDistancePreview();
    }
  }

  /** A re-render landed during angle placement: re-anchor the sector
   * preview against the fresh model (roles are the stable identity).
   * Geometry gone ⇒ cancel. */
  private refreshAnglePlacement(): void {
    const p = this.anglePlacement;
    const model = this.model;
    if (!p) {
      return;
    }
    const sector = model
      ? angleSectorFor(model, p.picks[0], p.picks[1], p.sector.aRole, p.sector.bRole)
      : null;
    if (!sector || !sector.at) {
      this.cancelAnglePlacement();
      return;
    }
    p.sector = sector;
    this.drawPlacementPreview(sector);
  }

  /** A re-render landed while the value input is open: re-anchor the
   * preview line and the input to the new model, and refresh the measured
   * seed (updateValue respects typed text). Geometry gone ⇒ close. */
  private refreshPendingDimension(): void {
    if (!this.pendingDimension || !this.valueInput.isVisible) {
      return;
    }
    const { picks, form } = this.pendingDimension;
    const model = this.model;
    // Re-derive a locked angle sector against the fresh geometry (the roles
    // are its stable identity) and store it back: the commit reads the
    // stored sector, whose emission ORDER can legitimately flip when the
    // moving geometry carries the turn across 180°.
    let sector = this.pendingDimension.sector;
    if (sector && model) {
      sector = angleSectorFor(model, picks[0], picks[1], sector.aRole, sector.bRole);
      this.pendingDimension.sector = sector;
      if (!sector) {
        this.valueInput.hide();
        return;
      }
    }
    const { tangency, axis } = this.pendingDimension;
    const measured = model ? measureDimension(model, picks, form, axis, sector, tangency) : null;
    if (!model || measured === null) {
      this.valueInput.hide();
      return;
    }
    const layout = dimensionPreviewLayout(model, picks, form, axis, sector, tangency);
    this.drawDimensionPreview(layout);
    const pos = this.inputPosition(model, layout);
    this.valueInput.updatePosition(pos.clientX, pos.clientY);
    this.valueInput.updateValue(measured);
  }

  /** The shared selection changed — recompute the pick list and options. */
  selectionChanged(handler: SketchHoverSelectHandler | null): void {
    this.picks = handler?.getSolvedPicks() ?? [];
    this.clearGhost();
    this.view.setOptions(constraintOptions(this.picks));
    this.view.setDeleteEnabled(this.pickedConstraint !== null);
    // The armed dimension tool fires as soon as the picks form a legal
    // dimension — the second pick opens the value input (locked plan §0.4).
    // A further pick while the input is open RE-TARGETS it (a lone line's
    // length upgrades to line–line when the second line lands), unless the
    // user already typed a value.
    if (this.dimensionArmed) {
      const picks = this.armedDimensionPicks();
      if (!picks) {
        return;
      }
      const key = picksKey(expandDimensionPicks(picks));
      // An active placement on the same picks stays as-is (re-renders and
      // selection echoes must not reset the cursor-chosen form).
      const placing = this.distancePlacement !== null
        && picksKey(this.distancePlacement.rawPicks) === key;
      const retarget = this.valueInput.isVisible
        && !this.valueInput.isTyping
        && key !== (this.pendingDimension?.rawKey ?? '');
      if ((!this.valueInput.isVisible && !placing) || retarget) {
        this.beginDimension(picks);
      }
    }
  }

  /** Route a legal dimension pick set to its flow: axis-capable distances
   * (point pairs, a lone line's length, circle/arc pairs and point–round
   * via their centers) go through cursor placement — the mouse position
   * picks aligned vs horizontal vs vertical before the value input opens;
   * everything else opens the input directly. */
  private beginDimension(picks: SolvedPick[]): void {
    const form = dimensionFormFor(picks);
    if (!form) {
      return;
    }
    if (form.kind === 'distance' && form.axisChoice) {
      this.startDistancePlacement(picks, form);
      return;
    }
    this.openValueInput('dimension', picks);
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
    this.view.setDeleteEnabled(true);
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
    if (this.anglePlacement) {
      this.cancelAnglePlacement();
      return true;
    }
    if (this.distancePlacement) {
      this.cancelDistancePlacement();
      return true;
    }
    if (this.dimensionArmed) {
      this.setDimensionArmed(false);
      return true;
    }
    return false;
  }

  private handleKeyDown(e: KeyboardEvent): void {
    if (e.key !== 'Delete' && e.key !== 'Backspace' && e.key !== 'Escape') {
      return;
    }
    const target = e.target as HTMLElement | null;
    if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) {
      return;
    }
    // The drawing-tool Esc ladder (sketch-toolbar) only fires while a
    // drawing tool is armed — the solved flows (angle placement, armed
    // dimension, open value input) own their Escape here.
    if (e.key === 'Escape') {
      if (this.handleEscape()) {
        e.preventDefault();
        e.stopPropagation();
      }
      return;
    }
    if (this.pickedConstraint) {
      e.preventDefault();
      this.deletePicked();
    }
  }

  private setDimensionArmed(armed: boolean): void {
    this.dimensionArmed = armed;
    this.view.setDimensionArmed(armed);
  }

  // -- interactive angle placement -------------------------------------------

  /** ∠ on two picked lines: preview the sector under the cursor (arc +
   * live readout at the intersection, FreeCAD-style); a click locks the
   * sector and opens the value input there. Near-parallel lines have no
   * sectors to choose — skip straight to the input on the default sector. */
  private startAnglePlacement(): void {
    const model = this.model;
    if (!model || this.picks.length !== 2) {
      return;
    }
    this.valueInput.hide();
    const [a, b] = this.picks;
    const sector = angleSectorAt(model, a, b, null);
    if (!sector) {
      return;
    }
    if (!sector.at) {
      this.openValueInput('angle', [a, b], sector);
      return;
    }
    this.anglePlacement = { picks: [a, b], sector, lastCursor: null };
    this.drawPlacementPreview(sector);
    this.ctx.renderer.domElement.addEventListener('mousemove', this.boundPlacementMove);
    // Capture-phase on window: the commit click must not reach the hover
    // handler's selection toggle; >4px travels (orbits) pass through.
    window.addEventListener('mousedown', this.boundPlacementDown, true);
    window.addEventListener('mouseup', this.boundPlacementUp, true);
  }

  private cancelAnglePlacement(): void {
    if (!this.anglePlacement) {
      return;
    }
    this.anglePlacement = null;
    this.placementDown = null;
    this.ctx.renderer.domElement.removeEventListener('mousemove', this.boundPlacementMove);
    window.removeEventListener('mousedown', this.boundPlacementDown, true);
    window.removeEventListener('mouseup', this.boundPlacementUp, true);
    this.removePlacementPreview();
  }

  private handlePlacementMove(e: MouseEvent): void {
    const p = this.anglePlacement;
    const model = this.model;
    if (!p || !model) {
      return;
    }
    const cursor = projectToSketch(this.ctx, model.plane, e.clientX, e.clientY);
    if (!cursor) {
      return;
    }
    p.lastCursor = cursor;
    const sector = angleSectorAt(model, p.picks[0], p.picks[1], cursor);
    if (!sector || !sector.at) {
      return;
    }
    // Geometry is static during placement — only a sector CHANGE redraws.
    const changed = sector.aRole !== p.sector.aRole || sector.bRole !== p.sector.bRole;
    p.sector = sector;
    if (changed) {
      this.drawPlacementPreview(sector);
    }
  }

  private handlePlacementDown(e: MouseEvent): void {
    if (!this.anglePlacement && !this.distancePlacement) {
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
    if ((!this.anglePlacement && !this.distancePlacement) || !down || !down.onCanvas) {
      return;
    }
    if (Math.hypot(e.clientX - down.x, e.clientY - down.y) > CLICK_THRESHOLD_PX) {
      return;
    }
    e.stopPropagation();
    e.preventDefault();
    if (this.anglePlacement) {
      const { picks, sector } = this.anglePlacement;
      this.cancelAnglePlacement();
      this.openValueInput('angle', picks, sector);
      return;
    }
    const d = this.distancePlacement!;
    const picks = d.axis !== undefined ? d.axisPicks : d.rawPicks;
    const rawKey = picksKey(d.rawPicks);
    const axis = d.axis;
    this.cancelDistancePlacement();
    this.openValueInput('dimension', picks, null, axis, rawKey);
  }

  private drawPlacementPreview(sector: AngleSector): void {
    this.removePlacementPreview();
    const model = this.model;
    if (!model || !sector.at) {
      return;
    }
    const visual = buildAngleArc(
      sector.at,
      sector.startAngle,
      sector.sweep,
      `${sector.valueDeg}°`,
      model.plane,
      model.plane.normal,
      themeColors.constraintColor,
      PLACEMENT_OPACITY,
      sector.tails,
    );
    // World-scale dashed extensions ride OUTSIDE the screen-scaled arc
    // group — a plain wrapper keeps one handle for add/dispose.
    const wrapper = new Group();
    wrapper.userData.isMetaShape = true;
    wrapper.add(visual.group);
    const ext = buildAngleExtensions(
      sector.extensions, model.plane, themeColors.constraintColor, PLACEMENT_OPACITY,
    );
    if (ext) {
      wrapper.add(ext);
    }
    this.ctx.scene.add(wrapper);
    this.placementGroup = wrapper;
    this.placementTexture = visual.ownedTexture;
    this.ctx.requestRender();
  }

  private removePlacementPreview(): void {
    if (!this.placementGroup) {
      return;
    }
    this.ctx.scene.remove(this.placementGroup);
    this.placementGroup.traverse((child) => {
      const mesh = child as unknown as { geometry?: { dispose(): void }; material?: { dispose(): void } };
      mesh.geometry?.dispose?.();
      mesh.material?.dispose?.();
    });
    this.placementTexture?.dispose();
    this.placementTexture = null;
    this.placementGroup = null;
    this.ctx.requestRender();
  }

  // -- interactive distance placement -----------------------------------------

  /** Axis-capable distance picks: preview the form the cursor's region
   * selects (aligned / horizontal / vertical, with a live readout); a click
   * locks it and opens the value input. Picks without an axis form fall
   * back to the direct input. */
  private startDistancePlacement(dimPicks: SolvedPick[], form: DimensionForm): void {
    const axisPicks = axisDimensionPicks(dimPicks);
    if (!this.model || !axisPicks) {
      this.openValueInput('dimension', dimPicks);
      return;
    }
    // An axis-aligned point pair has no placement choice — the one axis the
    // cursor could pick measures what the aligned form measures. Straight
    // to the value input.
    const rawPicks = expandDimensionPicks(dimPicks);
    const a = refPoint(this.model, pickRef(axisPicks[0]));
    const b = refPoint(this.model, pickRef(axisPicks[1]));
    if (a && b && distancePlacementMoot(rawPicks, a, b)) {
      this.openValueInput('dimension', dimPicks);
      return;
    }
    this.valueInput.hide();
    this.cancelDistancePlacement();
    this.distancePlacement = {
      rawPicks,
      axisPicks,
      form,
      axis: undefined,
    };
    this.drawDistancePreview();
    if (!this.distancePlacement) {
      // The preview couldn't resolve its anchors — drawDistancePreview
      // cancelled the placement (listeners were never installed).
      return;
    }
    this.ctx.renderer.domElement.addEventListener('mousemove', this.boundDistanceMove);
    // Capture-phase on window, like the angle placement: the commit click
    // must not reach the hover handler's selection toggle.
    window.addEventListener('mousedown', this.boundPlacementDown, true);
    window.addEventListener('mouseup', this.boundPlacementUp, true);
  }

  private cancelDistancePlacement(): void {
    if (!this.distancePlacement) {
      return;
    }
    this.distancePlacement = null;
    this.placementDown = null;
    this.ctx.renderer.domElement.removeEventListener('mousemove', this.boundDistanceMove);
    window.removeEventListener('mousedown', this.boundPlacementDown, true);
    window.removeEventListener('mouseup', this.boundPlacementUp, true);
    this.removePlacementPreview();
  }

  private handleDistanceMove(e: MouseEvent): void {
    const p = this.distancePlacement;
    const model = this.model;
    if (!p || !model) {
      return;
    }
    const cursor = projectToSketch(this.ctx, model.plane, e.clientX, e.clientY);
    const a = refPoint(model, pickRef(p.axisPicks[0]));
    const b = refPoint(model, pickRef(p.axisPicks[1]));
    if (!cursor || !a || !b) {
      return;
    }
    const axis = axisFromCursor(a, b, cursor);
    // Geometry is static during placement — only a region CHANGE redraws.
    if (axis === p.axis) {
      return;
    }
    p.axis = axis;
    this.drawDistancePreview();
  }

  /** The leader of the form the current region selects (exactly where the
   * committed glyph will land) plus a live value readout offset from its
   * midpoint. Anchors gone (deleted under a re-render) ⇒ cancel. */
  private drawDistancePreview(): void {
    this.removePlacementPreview();
    const p = this.distancePlacement;
    const model = this.model;
    if (!p || !model) {
      return;
    }
    const axisForm = p.axis !== undefined;
    const picks = axisForm ? p.axisPicks : p.rawPicks;
    const tangency = axisForm ? undefined : inferTangency(model, p.rawPicks, p.form);
    const measured = measureDimension(model, picks, p.form, p.axis, null, tangency);
    const layout = dimensionPreviewLayout(model, picks, p.form, p.axis, null, tangency);
    if (measured === null || !layout?.line) {
      this.cancelDistancePlacement();
      return;
    }
    const wrapper = new Group();
    wrapper.userData.isMetaShape = true;
    wrapper.add(this.buildLeaderGroup(layout.line, model, PLACEMENT_OPACITY, layout.arrows));
    // Dashed witness extensions to anchors the axis leader doesn't reach.
    const ext = buildAngleExtensions(
      layout.extensions ?? [], model.plane, themeColors.constraintColor, PLACEMENT_OPACITY,
    );
    if (ext) {
      wrapper.add(ext);
    }
    // Readout offset perpendicular to the leader, like the committed label.
    const dx = layout.line[1][0] - layout.line[0][0];
    const dy = layout.line[1][1] - layout.line[0][1];
    const len = Math.hypot(dx, dy);
    const offsetDir: Vec2 = len < 1e-9 ? [0, 1] : [-dy / len, dx / len];
    const label = p.axis === 'x' ? `H ${measured}` : p.axis === 'y' ? `V ${measured}` : String(measured);
    const readout = buildDimensionReadout(
      layout.at, label, offsetDir, model.plane, model.plane.normal,
      themeColors.constraintColor, PLACEMENT_OPACITY,
    );
    wrapper.add(readout.group);
    this.ctx.scene.add(wrapper);
    this.placementGroup = wrapper;
    this.placementTexture = readout.ownedTexture;
    this.ctx.requestRender();
  }

  private async apply(id: ConstraintButtonId): Promise<void> {
    if (this.busy || !this.model || !this.sketchInfo) {
      return;
    }
    this.cancelAnglePlacement();
    this.cancelDistancePlacement();

    if (id === 'dimension' && !dimensionFormFor(this.picks)) {
      // Arm the two-pick flow: the next legal pick pair opens the value input.
      this.setDimensionArmed(!this.dimensionArmed);
      return;
    }

    if (id === 'angle') {
      this.startAnglePlacement();
      return;
    }

    if (id === 'dimension') {
      this.beginDimension(this.picks);
      return;
    }

    const spec = candidateSpec(id, this.picks);
    if (!spec) {
      return;
    }
    await this.emit(id, this.orderedTargets(id), undefined, undefined);
  }

  /** Emission arg order per kind (the statement forms are positional):
   * midpoint(point, line); symmetric(a, b, mirrorLine); rest keep pick order. */
  private orderedTargets(id: ConstraintButtonId): SolvedPick[] {
    if (id === 'midpoint') {
      const point = this.picks.find(isPointPick)!;
      const line = this.picks.find(p => p !== point)!;
      return [point, line];
    }
    if (id === 'symmetric') {
      const points = this.picks.filter(isPointPick);
      const line = this.picks.find(p => !isPointPick(p))!;
      return [...points, line];
    }
    return this.picks;
  }

  private openValueInput(
    id: 'dimension' | 'angle',
    dimPicks: SolvedPick[],
    sector?: AngleSector | null,
    axis?: 'x' | 'y',
    rawKey?: string,
  ): void {
    const model = this.model;
    if (!model) {
      return;
    }
    const form = id === 'angle'
      ? { kind: 'angle' as const, axisChoice: false, tangencyChoice: false }
      : dimensionFormFor(dimPicks);
    if (!form) {
      return;
    }
    // A lone line dimensions its own length — the endpoint-pair distance.
    const picks = id === 'dimension' ? expandDimensionPicks(dimPicks) : [...dimPicks];
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
    const measured = measureDimension(model, picks, form, axis, angleSector, tangency);
    if (measured === null) {
      return;
    }
    // The input opens at the label spot of the dimension it will create,
    // with the leader line previewed between the anchors (drawn after
    // show() — a re-targeting show() runs the previous cycle's onHide).
    const layout = dimensionPreviewLayout(model, picks, form, axis, angleSector, tangency);
    const { clientX, clientY } = this.inputPosition(model, layout);
    this.valueInput.show({
      label: form.kind === 'angle' ? '∠'
        : form.kind === 'radius' ? 'R'
          : form.kind === 'diameter' ? '⌀'
            : axis === 'x' ? 'H' : axis === 'y' ? 'V' : 'D',
      value: String(measured),
      clientX,
      clientY,
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
        // add-constraint has no variable-declaration plumbing yet (P8):
        // a P-toggled commit falls back to its numeric initializer so the
        // emitted statement is always valid.
        const finalExpr = newVariable
          ? newVariable.initializer
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
        );
      },
    });
    this.pendingDimension = {
      picks, form, sector: angleSector, tangency, axis,
      rawKey: rawKey ?? picksKey(picks),
    };
    this.drawDimensionPreview(layout);
  }

  /** The value input sits at the preview's label anchor, clamped into the
   * viewport; without an anchor it falls back to the under-toolbar spot. */
  private inputPosition(
    model: SolvedSketchModel,
    layout: DimensionPreviewLayout | null,
  ): { clientX: number; clientY: number } {
    const rect = this.container.getBoundingClientRect();
    if (!layout) {
      return { clientX: rect.left + rect.width / 2 - 60, clientY: rect.top + 190 };
    }
    let { clientX, clientY } = sketchToClient(this.ctx, model.plane, layout.at);
    if (layout.arc) {
      // Sit at the arc's label spot — the same adaptive placement the
      // committed readout uses, so a thin wedge pushes the input out (or
      // beside the arc) instead of parking it on both rays at once. The
      // input's box stands in for the label's.
      const placed = angleInputPlacement(layout.arc);
      const probe = sketchToClient(this.ctx, model.plane, [
        layout.at[0] + Math.cos(placed.angle),
        layout.at[1] + Math.sin(placed.angle),
      ]);
      const dx = probe.clientX - clientX;
      const dy = probe.clientY - clientY;
      const len = Math.hypot(dx, dy) || 1;
      clientX += (dx / len) * placed.radiusPx;
      clientY += (dy / len) * placed.radiusPx;
    }
    return {
      clientX: Math.min(Math.max(clientX, rect.left + 8), rect.right - 180),
      clientY: Math.min(Math.max(clientY, rect.top + 60), rect.bottom - 24),
    };
  }

  /** Leader line between the dimension's anchors while the value input is
   * open — same styling as the committed glyph's leader, so commit only
   * swaps in the label. */
  private drawDimensionPreview(layout: DimensionPreviewLayout | null): void {
    this.removePreviewLine();
    const model = this.model;
    if (!layout || !model) {
      return;
    }
    if (layout.arc) {
      // Label-less sector arc — the open value input IS the readout, so the
      // arc trails out to wherever the adaptive placement parks the input.
      const visual = buildAngleArc(
        layout.at,
        layout.arc.startAngle,
        layout.arc.sweep,
        null,
        model.plane,
        model.plane.normal,
        themeColors.constraintColor,
        PREVIEW_LEADER_OPACITY,
        layout.arc.tails,
        angleInputPlacement(layout.arc).arcRadiusPx,
      );
      const wrapper = new Group();
      wrapper.userData.isMetaShape = true;
      wrapper.add(visual.group);
      const ext = buildAngleExtensions(
        layout.arc.extensions, model.plane, themeColors.constraintColor,
      );
      if (ext) {
        wrapper.add(ext);
      }
      this.ctx.scene.add(wrapper);
      this.previewGroup = wrapper;
      this.ctx.requestRender();
      return;
    }
    if (!layout.line) {
      return;
    }
    const group = this.buildLeaderGroup(layout.line, model, PREVIEW_LEADER_OPACITY, layout.arrows);
    group.userData.isMetaShape = true;
    const ext = buildAngleExtensions(
      layout.extensions ?? [], model.plane, themeColors.constraintColor, PREVIEW_LEADER_OPACITY,
    );
    if (ext) {
      group.add(ext);
    }
    this.ctx.scene.add(group);
    this.previewGroup = group;
    this.ctx.requestRender();
  }

  /** One world-scale leader segment, styled like the committed glyph's —
   * arrowheads included, so committing only swaps in the label. */
  private buildLeaderGroup(
    seg: [Vec2, Vec2],
    model: SolvedSketchModel,
    opacity: number,
    arrows?: ArrowEnds,
  ): Group {
    const from = localToWorld(seg[0], model.plane);
    const to = localToWorld(seg[1], model.plane);
    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new Float32BufferAttribute([
      from.x, from.y, from.z,
      to.x, to.y, to.z,
    ], 3));
    const material = new LineBasicMaterial({
      color: themeColors.constraintColor,
      transparent: true,
      opacity,
      depthTest: false,
    });
    const line = new Line(geometry, material);
    line.renderOrder = 2;
    const group = new Group();
    group.renderOrder = 2;
    group.add(line);
    if (arrows) {
      const heads = buildDimensionArrows(
        seg, model.plane, model.plane.normal, themeColors.constraintColor, opacity, 2, arrows,
      );
      if (heads) {
        group.add(heads);
      }
    }
    return group;
  }

  private removePreviewLine(): void {
    if (!this.previewGroup) {
      return;
    }
    this.ctx.scene.remove(this.previewGroup);
    this.previewGroup.traverse((child) => {
      const mesh = child as unknown as { geometry?: { dispose(): void }; material?: { dispose(): void } };
      mesh.geometry?.dispose?.();
      mesh.material?.dispose?.();
    });
    this.previewGroup = null;
    this.ctx.requestRender();
  }

  private clearDimensionPreview(): void {
    this.pendingDimension = null;
    this.removePreviewLine();
  }

  private async emit(
    kind: ConstraintButtonId | 'distance' | 'radius' | 'diameter',
    picks: SolvedPick[],
    valueExpr: string | undefined,
    axis: 'x' | 'y' | undefined,
    tangency?: 'max',
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
    });
    this.busy = false;
    this.view.setBusy(false);
    if (!result.success) {
      this.showMessage(result.reason ?? `Could not add the ${statementKind} constraint`);
    }
  }

  private deletePicked(): void {
    const loc = this.pickedConstraint?.sourceLocation;
    if (!loc) {
      return;
    }
    // Constraint removal is a statement deletion, never a geometry rewrite
    // (locked plan §0.1) — the timeline's remove rail does exactly that.
    removeFeature(loc);
    this.pickedConstraint = null;
    this.view.setDeleteEnabled(false);
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
      const form = id === 'angle' ? { kind: 'angle' as const, axisChoice: false, tangencyChoice: false } : dimensionFormFor(this.picks);
      if (id === 'angle' && this.picks.length === 2) {
        sector = angleSectorAt(model, this.picks[0], this.picks[1], null);
      }
      value = form ? measureDimension(model, this.picks, form, undefined, sector) ?? undefined : undefined;
    }
    const spec = candidateSpec(id, this.picks, value, undefined, sector);
    if (!spec) {
      return;
    }
    const live = LiveSolvedSystem.fromSnapshot(model.solver);
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
