// Logic behind the solved constraint bar (sketch-rewrite P4): ordered picks
// (from the shared hover/select handler) → legality → statement emission via
// /api/sketch/add-constraint; the two-pick dimension flow with a value
// input; delete of a picked constraint statement; and the live ghost — a
// client-side solve previewing the candidate constraint before anything is
// written.

import { Group } from 'three';
import { Line2 } from 'three/examples/jsm/lines/Line2.js';
import { LineGeometry } from 'three/examples/jsm/lines/LineGeometry.js';
import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js';
import { SceneContext } from '../../scene/scene-context';
import { PlaneData, SceneObjectRender, SourceLocation } from '../../types';
import { applySketchConstraint, removeFeature } from '../../api';
import { ExpressionInput, VariableInfo } from '../../ui/expression-input';
import { themeColors } from '../../scene/theme-colors';
import { localToWorld } from '../sketch-plane-utils';
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
  candidateSpec,
  constraintOptions,
  dimensionFormFor,
  isPointPick,
  measureDimension,
} from './legality';

const GHOST_OPACITY = 0.45;
/** Entities whose params moved more than this ghost-preview. */
const GHOST_EPS = 1e-6;

export class SolvedConstraintToolbarService {
  private view: SolvedConstraintToolbar;
  private valueInput: ExpressionInput;
  private handler: SketchHoverSelectHandler | null = null;
  private model: SolvedSketchModel | null = null;
  private sketchInfo: { line: number; filePath?: string } | null = null;
  private picks: SolvedPick[] = [];
  private busy = false;
  private dimensionArmed = false;
  private pickedConstraint: { objId?: string; sourceLocation?: SourceLocation } | null = null;
  private ghostGroup: Group | null = null;
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
    this.dimensionArmed = false;
    this.pickedConstraint = null;
    this.picks = [];
    this.model = null;
    this.sketchInfo = null;
    this.handler = null;
  }

  /** Per-render: rebuild the read model, re-resolve the picked constraint,
   * refresh the options. Called after the handlers digested the new scene. */
  sketchUpdated(
    sceneObjects: SceneObjectRender[],
    sketchObj: SceneObjectRender,
    handler: SketchHoverSelectHandler | null,
  ): void {
    this.handler = handler;
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
    this.selectionChanged(handler);
  }

  /** The shared selection changed — recompute the pick list and options. */
  selectionChanged(handler: SketchHoverSelectHandler | null): void {
    this.handler = handler;
    this.picks = handler?.getSolvedPicks() ?? [];
    this.clearGhost();
    this.view.setOptions(constraintOptions(this.picks));
    this.view.setDeleteEnabled(this.pickedConstraint !== null);
    // The armed dimension tool fires as soon as the picks form a legal
    // dimension — the second pick opens the value input (locked plan §0.4).
    if (this.dimensionArmed && !this.valueInput.isVisible && dimensionFormFor(this.picks)) {
      this.openValueInput('dimension');
    }
  }

  /** A constraint badge was clicked — remember it for delete. */
  noteConstraintPick(pick: { objId?: string; sourceLocation?: SourceLocation }): void {
    this.pickedConstraint = pick;
    this.view.setDeleteEnabled(true);
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
      this.openValueInput(id);
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

  private openValueInput(id: 'dimension' | 'angle'): void {
    const model = this.model;
    if (!model) {
      return;
    }
    const form = id === 'angle'
      ? { kind: 'angle' as const, axisChoice: false }
      : dimensionFormFor(this.picks);
    if (!form) {
      return;
    }
    const picks = [...this.picks];
    const measured = measureDimension(model, picks, form);
    if (measured === null) {
      return;
    }
    const rect = this.container.getBoundingClientRect();
    this.valueInput.show({
      label: form.kind === 'angle' ? '∠' : form.kind === 'radius' ? 'R' : form.kind === 'diameter' ? '⌀' : 'D',
      value: String(measured),
      clientX: rect.left + rect.width / 2 - 60,
      clientY: rect.top + 190,
      variables: this.cachedVariables,
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
