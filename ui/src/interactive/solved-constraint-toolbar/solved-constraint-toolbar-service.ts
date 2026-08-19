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
import { localToWorld, sketchToClient } from '../sketch-plane-utils';
import type { SketchHoverSelectHandler, SolvedPick } from '../sketch-hover-select-handler';
import {
  LiveSolvedSystem,
  SolvedSketchModel,
  buildSolvedSketchModel,
  tessellateSolvedEntity,
} from '../../sketch-solver-client';
import { LineResolutionRegistry } from '../../meshes/shape-meshes/line-resolution';
import { SolvedConstraintToolbar } from './solved-constraint-toolbar';
import {
  ConstraintButtonId,
  DimensionForm,
  DimensionPreviewLayout,
  candidateSpec,
  constraintOptions,
  dimensionFormFor,
  dimensionPreviewLayout,
  expandDimensionPicks,
  isPointPick,
  measureDimension,
} from './legality';

const GHOST_OPACITY = 0.45;
/** Entities whose params moved more than this ghost-preview. */
const GHOST_EPS = 1e-6;
/** = the committed leader's LEADER_OPACITY (solved-constraint-meshes). */
const PREVIEW_LEADER_OPACITY = 0.45;

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
  private ghostGroup: Group | null = null;
  /** The dimension the open value input is creating — drives the preview
   * leader line and survives re-renders (picks are entityId:role keyed). */
  private pendingDimension: { picks: SolvedPick[]; form: DimensionForm } | null = null;
  private previewGroup: Group | null = null;
  private cachedVariables: VariableInfo[] = [];
  private boundKeyDown: (e: KeyboardEvent) => void;

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
    // exists (objIds are re-minted; match by source line).
    if (this.pickedConstraint?.sourceLocation) {
      const line = this.pickedConstraint.sourceLocation.line;
      const match = this.model?.constraints.find(c => c.obj.sourceLocation?.line === line);
      this.pickedConstraint = match
        ? { objId: match.obj.id, sourceLocation: match.obj.sourceLocation }
        : null;
    }
    this.refreshPendingDimension();
    this.selectionChanged(handler);
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
    const measured = model ? measureDimension(model, picks, form) : null;
    if (!model || measured === null) {
      this.valueInput.hide();
      return;
    }
    const layout = dimensionPreviewLayout(model, picks, form);
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
      const retarget = this.valueInput.isVisible
        && !this.valueInput.isTyping
        && picksKey(expandDimensionPicks(picks)) !== picksKey(this.pendingDimension?.picks ?? []);
      if (!this.valueInput.isVisible || retarget) {
        this.openValueInput('dimension', picks);
      }
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
    if (this.dimensionArmed) {
      this.setDimensionArmed(false);
      return true;
    }
    return false;
  }

  private handleKeyDown(e: KeyboardEvent): void {
    if (e.key !== 'Delete' && e.key !== 'Backspace') {
      return;
    }
    const target = e.target as HTMLElement | null;
    if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) {
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

  private async apply(id: ConstraintButtonId): Promise<void> {
    if (this.busy || !this.model || !this.sketchInfo) {
      return;
    }

    if (id === 'dimension' && !dimensionFormFor(this.picks)) {
      // Arm the two-pick flow: the next legal pick pair opens the value input.
      this.setDimensionArmed(!this.dimensionArmed);
      return;
    }

    if (id === 'dimension' || id === 'angle') {
      this.openValueInput(id, this.picks);
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

  private openValueInput(id: 'dimension' | 'angle', dimPicks: SolvedPick[]): void {
    const model = this.model;
    if (!model) {
      return;
    }
    const form = id === 'angle'
      ? { kind: 'angle' as const, axisChoice: false }
      : dimensionFormFor(dimPicks);
    if (!form) {
      return;
    }
    // A lone line dimensions its own length — the endpoint-pair distance.
    const picks = id === 'dimension' ? expandDimensionPicks(dimPicks) : [...dimPicks];
    const measured = measureDimension(model, picks, form);
    if (measured === null) {
      return;
    }
    // The input opens at the label spot of the dimension it will create,
    // with the leader line previewed between the anchors (drawn after
    // show() — a re-targeting show() runs the previous cycle's onHide).
    const layout = dimensionPreviewLayout(model, picks, form);
    const { clientX, clientY } = this.inputPosition(model, layout);
    this.valueInput.show({
      label: form.kind === 'angle' ? '∠' : form.kind === 'radius' ? 'R' : form.kind === 'diameter' ? '⌀' : 'D',
      value: String(measured),
      clientX,
      clientY,
      variables: this.cachedVariables,
      onHide: () => this.clearDimensionPreview(),
      onCommit: ({ expression, newVariable }) => {
        this.valueInput.hide();
        this.setDimensionArmed(false);
        const num = parseFloat(expression);
        const isNumeric = !isNaN(num) && String(num) === expression;
        // add-constraint has no variable-declaration plumbing yet (P8):
        // a P-toggled commit falls back to its numeric initializer so the
        // emitted statement is always valid.
        const finalExpr = newVariable
          ? newVariable.initializer
          : isNumeric ? String(Math.round(num * 100) / 100) : expression;
        const kind = form.kind === 'angle' ? 'angle' : form.kind;
        void this.emit(kind as ConstraintButtonId, picks, finalExpr, undefined);
      },
    });
    this.pendingDimension = { picks, form };
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
    const { clientX, clientY } = sketchToClient(this.ctx, model.plane, layout.at);
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
    if (!layout?.line || !model) {
      return;
    }
    const from = localToWorld(layout.line[0], model.plane);
    const to = localToWorld(layout.line[1], model.plane);
    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new Float32BufferAttribute([
      from.x, from.y, from.z,
      to.x, to.y, to.z,
    ], 3));
    const material = new LineBasicMaterial({
      color: themeColors.constraintColor,
      transparent: true,
      opacity: PREVIEW_LEADER_OPACITY,
      depthTest: false,
    });
    const line = new Line(geometry, material);
    line.renderOrder = 2;
    const group = new Group();
    group.renderOrder = 2;
    group.userData.isMetaShape = true;
    group.add(line);
    this.ctx.scene.add(group);
    this.previewGroup = group;
    this.ctx.requestRender();
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
  ): Promise<void> {
    const info = this.sketchInfo;
    if (!info) {
      return;
    }
    const statementKind = kind === 'dimension' ? 'distance' : kind;
    const targets = picks.map(p => ({
      line: p.sourceLocation?.line ?? -1,
      ...(p.role !== undefined && p.role !== null ? { role: p.role } : {}),
      featureType: p.kind,
    }));
    if (targets.some(t => t.line < 0)) {
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
    if (id === 'dimension' || id === 'angle') {
      const form = id === 'angle' ? { kind: 'angle' as const, axisChoice: false } : dimensionFormFor(this.picks);
      value = form ? measureDimension(model, this.picks, form) ?? undefined : undefined;
    }
    const spec = candidateSpec(id, this.picks, value);
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
