import {
  applySketchCopy, applySketchCopyEdit, clearBreakpoints, fetchFeatureGhost,
  fetchSketchFeatureSources, ApplyFeatureResponse, Copy2DGhostRequest, FeatureEditTarget,
  GhostSketchAxisRef, GhostSolid, ParsedFeatureStatement,
  SketchApplyEntity, SketchCopyAxis, SketchCopyEditAxis, ValueExpr,
} from '../api';
import { SketchOpSelection } from './sketch-op-service';
import { keepChip } from './create-feature/sketch-profiles';
import { FeatureGhostOverlay } from './create-feature/feature-ghost';
import { PickSlotChip } from './pick-slot';
import { VariableInfo } from '../ui/expression-core';
import { SketchCopyDirection, SketchCopyPanel, SketchCopyArmedSlot } from './sketch-copy-panel';

const PREVIEW_DEBOUNCE_MS = 250;

/** A `copy()` statement as the parse route reads it. */
type ParsedSketchCopy = Extract<ParsedFeatureStatement, { feature: 'copy' }>;

/**
 * The in-sketch copy dialog on the 2D op rails: armed from the sketch
 * toolbar, it reads the hover handler's selected edges — any pick stands for
 * its whole producing primitive — previews the synthesized statement through
 * `/api/apply-feature` (sketch branch), and applies it, writing
 * `copy('linear', local('x'), { count: 3, offset: 20 }, r)` /
 * `copy('circular', [0, 0], { count: 6, angle: 360 }, c)` into the sketch
 * body. Exactly one panel slot is armed at a time and the picks land in it:
 * the Geometry slot collects the targets; an armed Direction slot consumes
 * ONE pick as its sketch-line axis, emitted as `axis(<var>)` — the quick
 * buttons emit the sketch-local `local('x')` / `local('y')` instead.
 *
 * The same dialog edits an existing statement in place ({@link enterEdit}):
 * the timeline double-click's breakpoint pauses the build just BEFORE the
 * statement (the offset edit's contract), its options seed the fields, its
 * axis slots open on "Current: …" keep chips, and its targets seed as
 * highlighted picks — untouched, they rewrite verbatim; re-picked, the whole
 * target list re-synthesizes in pick order.
 */
export class SketchCopyService {
  /** Fired on enter/exit — main.ts suspends the sketch dialog while open. */
  onVisibilityChange?: (visible: boolean) => void;

  private panel: SketchCopyPanel;
  private active = false;
  private previewTimer: number | null = null;
  private previewAbort: AbortController | null = null;
  private applying = false;

  /** Statement being edited in place (timeline double-click), or null. */
  private editTarget: FeatureEditTarget | null = null;
  /** The parsed statement the edit dialog opened over (keep-slot texts). */
  private editStatement: ParsedSketchCopy | null = null;
  /** Chain text at dialog-open; the transform refuses when it drifted. */
  private expectedStatement: string | undefined;
  /**
   * An edit dialog that has not yet seen its sketch — the double-click's
   * breakpoint render is still in flight, so the sketch-less scene it opened
   * over must not fold the dialog away.
   */
  private awaitingEditSketch = false;
  /** Signature of the seeded (statement-own) picks; dirty picks re-synthesize. */
  private seedSignature: string | null = null;
  /** A seed round-trip is in flight — don't start another. */
  private seedLoading = false;

  // Armed-slot pick partitioning (the subtract dialog's idiom): the armed
  // slot's ids ARE the live selection. Arming an axis slot freezes the
  // targets; each pick made there is consumed into the direction's entity
  // and the selection cleared, so the next click replaces it.
  private armedApplied: SketchCopyArmedSlot = 'targets';
  private frozenTargets: string[] = [];
  /** Per-direction picked axis edges (the axis slots' `edge` mode). */
  private axisEntities = new Map<SketchCopyDirection, string | null>([[1, null], [2, null]]);

  constructor(
    container: HTMLElement,
    private readonly selection: SketchOpSelection,
    private fetchVariables: () => Promise<VariableInfo[]>,
    private onDone: () => void,
    /** The live viewport geometry overlay, shared with the other 2D op dialogs. */
    private readonly ghost?: FeatureGhostOverlay,
  ) {
    this.panel = new SketchCopyPanel(container);
    this.panel.onApply = () => void this.apply();
    this.panel.onExit = () => {
      // An edit dialog may outlive its toolbar arming (the bar hides while
      // the breakpoint render is in flight), so close it here rather than
      // relying on the toolbar's own disarm to find it.
      this.exit();
      this.onDone();
    };
    this.panel.onChange = () => {
      this.panel.setMessage(null);
      this.schedulePreview();
    };
    this.panel.onTypeChange = () => this.refresh();
    this.panel.onRemoveTarget = (index) => {
      const ids = this.targetIds();
      const shapeId = ids[index];
      if (shapeId === undefined) {
        return;
      }
      if (this.panel.armedSlot === 'targets') {
        this.selection.deselect(shapeId);
      } else {
        this.frozenTargets = this.frozenTargets.filter(id => id !== shapeId);
        this.refresh();
      }
    };
    this.panel.onAxisModeChange = (direction) => {
      // The slot left edge mode (✕, a local-axis choice) — the entity would
      // otherwise silently ride along into the next edge state.
      this.axisEntities.set(direction, null);
    };
    this.panel.onArmedSlotChange = () => this.handleArmedSlotChange();
  }

  get isActive(): boolean {
    return this.active;
  }

  /** The copy dialog runs the regular pick body (SketchOpDialog contract). */
  get isDrawDialog(): boolean {
    return false;
  }

  /** True while the dialog rewrites an existing statement instead of writing one. */
  get isEditing(): boolean {
    return this.editTarget !== null;
  }

  /**
   * True until the edit dialog's own sketch has rendered. The toolbar service
   * keeps the dialog (and the picking handlers) alive through that window.
   */
  get isAwaitingSketch(): boolean {
    return this.awaitingEditSketch;
  }

  /** The edit dialog's sketch has rendered — normal teardown rules resume. */
  noteSketchActive(): void {
    this.awaitingEditSketch = false;
    if (this.editTarget) {
      // Seed the statement's own targets as highlighted picks — deferred
      // past the toolbar's update() so the pick handlers are armed over the
      // just-arrived sketch before the seed selects into them.
      window.setTimeout(() => void this.seedEditSelection(), 0);
    }
  }

  enter(): void {
    if (this.active && !this.editTarget) {
      return;
    }
    // Re-arming the tool over an open edit dialog abandons that edit — it
    // becomes a fresh statement, so the breakpoint it opened with goes too.
    this.exit('reopen');
    this.active = true;
    this.armedApplied = 'targets';
    this.frozenTargets = [];
    this.axisEntities.set(1, null);
    this.axisEntities.set(2, null);
    this.panel.show();
    this.onVisibilityChange?.(true);
    void this.loadVariables();
    this.refresh();
  }

  /**
   * Open the dialog over the `copy()` statement at `target`, prefilled from
   * its parsed options. The double-click that got here left a breakpoint
   * just before the statement, so the build is paused inside its sketch at
   * the state the statement's arguments see: the originals visible, their
   * copies absent, everything re-pickable.
   */
  enterEdit(
    target: FeatureEditTarget,
    parsed: ParsedSketchCopy,
    expectedStatement: string,
  ): void {
    this.exit('reopen');
    this.active = true;
    this.editTarget = target;
    this.editStatement = parsed;
    this.expectedStatement = expectedStatement;
    this.awaitingEditSketch = true;
    this.seedSignature = null;
    this.armedApplied = 'targets';
    this.frozenTargets = [];
    this.axisEntities.set(1, null);
    this.axisEntities.set(2, null);
    this.selection.clear();
    this.panel.showEdit({
      kind: parsed.kind,
      directions: parsed.directions,
      spacingMode: parsed.spacingMode,
      centered: parsed.centered,
      count: parsed.count,
      sweep: parsed.sweep,
      center: parsed.center,
      skip: parsed.skip,
      axisLabels: parsed.axisTexts,
    });
    this.onVisibilityChange?.(true);
    void this.loadVariables();
    this.syncTargetsSlot();
    this.schedulePreview();
  }

  /**
   * Close the dialog. A cancelled edit clears the breakpoint its double-click
   * placed; `apply`'s own transform strips them atomically with the rewrite,
   * and `reopen` hands over to a fresh dialog.
   */
  exit(reason: 'cancel' | 'apply' | 'reopen' = 'cancel'): void {
    if (!this.active) {
      return;
    }
    const wasEditing = this.editTarget !== null;
    this.active = false;
    this.editTarget = null;
    this.editStatement = null;
    this.expectedStatement = undefined;
    this.awaitingEditSketch = false;
    this.seedSignature = null;
    this.frozenTargets = [];
    this.axisEntities.set(1, null);
    this.axisEntities.set(2, null);
    this.cancelPreview();
    this.ghost?.clear();
    this.panel.hide();
    this.panel.setApplyEnabled(false);
    this.onVisibilityChange?.(false);
    if (wasEditing && reason === 'cancel') {
      clearBreakpoints();
    }
  }

  /** The selected set or the scene changed — refresh the chips and preview. */
  refresh(): void {
    if (!this.active) {
      return;
    }
    this.consumeAxisPick();
    this.syncTargetsSlot();
    this.schedulePreview();
  }

  /**
   * Arm-transition bookkeeping: leaving the targets slot freezes its picks;
   * arriving back restores them. The axis slots always start their picking
   * from an empty selection — their content is the consumed entity chip.
   */
  private handleArmedSlotChange(): void {
    const next = this.panel.armedSlot;
    if (next === this.armedApplied) {
      return;
    }
    if (this.armedApplied === 'targets') {
      this.frozenTargets = this.selection.ids();
    }
    this.armedApplied = next;
    this.selection.clear();
    if (next === 'targets') {
      this.selection.select(this.frozenTargets);
    }
    this.refresh();
  }

  /**
   * While an axis slot is armed, the newest selected edge IS the direction
   * pick: consume it into the slot's chip and clear the live selection, so
   * the next click replaces it.
   */
  private consumeAxisPick(): void {
    if (this.panel.armedSlot !== 'axis1' && this.panel.armedSlot !== 'axis2') {
      return;
    }
    const ids = this.selection.ids();
    if (ids.length === 0) {
      return;
    }
    const direction = this.panel.armedAxis;
    const shapeId = ids[ids.length - 1];
    this.axisEntities.set(direction, shapeId);
    this.panel.setAxisEdgeChip(direction, this.selection.describe(shapeId).label);
    this.panel.setMessage(null);
    this.selection.clear();
  }

  /** The target picks: the live selection, or the frozen set while an axis slot is armed. */
  private targetIds(): string[] {
    return this.panel.armedSlot === 'targets' ? this.selection.ids() : this.frozenTargets;
  }

  /**
   * Mirror the picked geometry into the slot as numbered chips; an edit with
   * no re-picks shows its statement's own targets as the keep chip instead.
   */
  private syncTargetsSlot(): void {
    const chips: PickSlotChip[] = this.targetIds().map((shapeId, index) => {
      const pick = this.selection.describe(shapeId);
      return {
        label: pick.label,
        badge: String(index + 1),
        removable: true,
        line: pick.line,
        onGoto: pick.goTo,
      };
    });
    if (chips.length === 0 && this.editTarget) {
      const targetTexts = this.editStatement?.targetTexts ?? [];
      const label = targetTexts.length > 0 ? targetTexts.join(', ') : 'whole sketch';
      this.panel.setTargets([keepChip(label)], 'Pick edges to re-target');
    } else {
      this.panel.setTargets(chips, chips.length === 0 ? 'Pick sketch geometry to copy' : null);
    }
  }

  /**
   * Seed the pick set with the statement's own target edges, resolved by the
   * server against the paused sketch. Unresolvable args leave the set empty
   * and the keep chip standing; a re-picked (dirty) selection is never
   * clobbered.
   */
  private async seedEditSelection(): Promise<void> {
    const target = this.editTarget;
    if (!target || this.seedLoading || this.panel.armedSlot !== 'targets') {
      return;
    }
    if (this.selection.ids().length === 0) {
      this.seedSignature = null;
    }
    if (this.picksDirty()) {
      return;
    }
    this.seedLoading = true;
    try {
      const result = await fetchSketchFeatureSources(target, this.expectedStatement);
      if (this.editTarget !== target || this.picksDirty() || this.panel.armedSlot !== 'targets') {
        return;
      }
      if (result.ok && result.shapeIds.length > 0) {
        this.selection.select(result.shapeIds);
        this.seedSignature = this.selectionSignature();
      }
    } finally {
      this.seedLoading = false;
    }
  }

  /** Sorted signature of the current target picks, for seed-dirty detection. */
  private selectionSignature(): string {
    return [...this.targetIds()].sort().join('|');
  }

  /**
   * True when the target set no longer matches the seeded one — the apply
   * then sends the picks for synthesis instead of keeping the args verbatim.
   */
  private picksDirty(): boolean {
    if (!this.editTarget) {
      return false;
    }
    if (this.seedSignature === null) {
      return this.targetIds().length > 0;
    }
    return this.selectionSignature() !== this.seedSignature;
  }

  /** Feed the sketch scope's variables to the fields' dropdowns. */
  private async loadVariables(): Promise<void> {
    const variables = await this.fetchVariables();
    if (this.active) {
      this.panel.setScopeVariables(variables);
    }
  }

  /**
   * One direction's axis as the request carries it, or the message blocking
   * it. A keep selection (edit mode) references the statement's own axis by
   * position — the create path never sees one.
   */
  private axisFor(direction: SketchCopyDirection, named: boolean): SketchCopyEditAxis | { error: string } {
    const which = named ? ` for direction ${direction}` : '';
    const selection = this.panel.axisSelection(direction);
    if (!selection) {
      return { error: `Choose the direction to copy along${which} — Local X, Local Y, or a sketch line.` };
    }
    if (selection.kind === 'keep') {
      return { kind: 'keep', sourceIndex: selection.sourceIndex };
    }
    if (selection.kind === 'standard') {
      // The quick buttons are the sketch-local axes in this dialog.
      return { kind: 'local', axis: selection.axis as 'x' | 'y' };
    }
    if (selection.kind === 'edge') {
      return this.axisEntities.get(direction)
        ? { kind: 'edge' }
        : { error: `Pick the direction line${which} first.` };
    }
    // The axis-statement kind is never offered here (a top-level axis()
    // cannot bind into the sketch body).
    return { error: `Choose the direction to copy along${which}.` };
  }

  /** The picked axis edges of the active edge-kind directions, in order. */
  private axisPickEntities(
    directions: { axis: SketchCopyEditAxis }[] | undefined,
  ): SketchApplyEntity[] {
    if (!directions) {
      return [];
    }
    const entities: SketchApplyEntity[] = [];
    const active = this.panel.directions;
    for (let i = 0; i < directions.length; i++) {
      if (directions[i].axis.kind === 'edge') {
        const shapeId = this.axisEntities.get(active[i])!;
        entities.push({ shapeId });
      }
    }
    return entities;
  }

  private schedulePreview(): void {
    if (!this.active) {
      return;
    }
    if (this.previewTimer !== null) {
      window.clearTimeout(this.previewTimer);
    }
    this.previewTimer = window.setTimeout(() => {
      this.previewTimer = null;
      void this.runPreview();
    }, PREVIEW_DEBOUNCE_MS);
  }

  private cancelPreview(): void {
    if (this.previewTimer !== null) {
      window.clearTimeout(this.previewTimer);
      this.previewTimer = null;
    }
    this.previewAbort?.abort();
    this.previewAbort = null;
  }

  private async runPreview(): Promise<void> {
    this.previewAbort?.abort();
    const abort = new AbortController();
    this.previewAbort = abort;
    try {
      const result = await this.send({ preview: true, signal: abort.signal });
      if (abort.signal.aborted || !this.active) {
        return;
      }
      if (result === null) {
        // Incomplete form — the hint already sits in the message row.
        this.panel.setPreview(null);
        this.panel.setApplyEnabled(false);
        this.ghost?.clear();
        return;
      }
      if (result.success) {
        this.panel.setPreview(result.preview ?? null);
        this.panel.setMessage(null);
        this.panel.setApplyEnabled(true);
        // The statement preview's geometric twin, chained under the same
        // abort scope — the way the shared op dialog chains its ghost.
        await this.runGhost(abort.signal);
      } else {
        this.panel.setPreview(null);
        this.panel.setApplyEnabled(false);
        this.panel.setMessage(result.reason ?? 'Could not synthesize the copy for this selection');
        // A statement the apply would refuse must not keep its geometry up.
        this.ghost?.clear();
      }
    } catch (err) {
      if (!(err instanceof DOMException && err.name === 'AbortError')) {
        this.panel.setMessage('Could not reach the FluidCAD server');
        this.ghost?.clear();
      }
    }
  }

  /**
   * Draw the live ghost clones for the just-previewed values, or clear the
   * overlay when the request can't be addressed. Runs on the statement
   * preview's own abort signal, so a superseded preview also supersedes its
   * ghost; a stale answer is dropped rather than drawn.
   */
  private async runGhost(signal: AbortSignal): Promise<void> {
    if (!this.ghost) {
      return;
    }
    const request = this.ghostRequest();
    if (!request) {
      this.ghost.clear();
      return;
    }
    let solids: GhostSolid[] | null;
    try {
      solids = await fetchFeatureGhost(request, signal);
    } catch {
      return; // aborted
    }
    if (signal.aborted || !this.active) {
      return;
    }
    if (solids) {
      this.ghost.set(solids, 'wire');
    } else {
      this.ghost.clear();
    }
  }

  /**
   * The live geometry request for the current dialog state, or null when it
   * can't be addressed. The target picks travel as they are; with none
   * picked, an edit whose keep chip stands over an EMPTY argument list is
   * the whole-sketch form (entities: []), while one standing over real
   * target args has nothing addressable to preview — its seed either failed
   * or was cleared. A direction slot resolves like the 3D dialogs' axis
   * slots: the quick buttons are the sketch-local axes, a picked line ships
   * its shapeId, and a kept `axis(v)` text is unaddressable — no ghost until
   * it is re-chosen (a kept `local('x')` already reads back as its button).
   */
  private ghostRequest(): Copy2DGhostRequest | null {
    const values = this.panel.values();
    if ('error' in values) {
      return null;
    }
    const ids = this.targetIds();
    if (ids.length === 0
      && (!this.editTarget || (this.editStatement?.targetTexts ?? []).length > 0)) {
      return null;
    }
    const entities = ids.map(shapeId => ({ shapeId }));

    if (values.kind === 'circular') {
      return {
        feature: 'copy2d',
        kind: 'circular',
        entities,
        axes: [],
        directions: [],
        // The circular form never writes `centered` from this dialog.
        centered: false,
        center: values.center,
        count: values.count,
        sweep: values.sweep,
        skip: values.skip,
      };
    }

    const axes: GhostSketchAxisRef[] = [];
    const active = this.panel.directions;
    for (const direction of active) {
      const selection = this.panel.axisSelection(direction);
      if (!selection || selection.kind === 'keep' || selection.kind === 'axis') {
        return null;
      }
      if (selection.kind === 'standard') {
        // The quick buttons are the sketch-local axes in this dialog.
        axes.push({ kind: 'local', axis: selection.axis as 'x' | 'y' });
      } else {
        const shapeId = this.axisEntities.get(direction);
        if (!shapeId) {
          return null;
        }
        axes.push({ kind: 'edge', shapeId });
      }
    }
    return {
      feature: 'copy2d',
      kind: 'linear',
      entities,
      axes,
      directions: values.directions.map(direction => ({
        count: direction.count,
        offset: values.spacingMode === 'offset' ? direction.value : null,
        length: values.spacingMode === 'length' ? direction.value : null,
      })),
      centered: values.centered,
      center: null,
      count: null,
      sweep: null,
      skip: values.skip,
    };
  }

  /**
   * One request for both modes, or null (with the hint shown) when the form
   * is incomplete: an armed dialog synthesizes a new statement for the
   * picked geometry; an edit rewrites the statement at `editTarget`, sending
   * its target picks only once they differ from what it opened with.
   */
  private send(options: {
    preview?: boolean;
    signal?: AbortSignal;
  }): Promise<ApplyFeatureResponse> | null {
    const values = this.panel.values();
    if ('error' in values) {
      this.panel.setMessage(values.error);
      return null;
    }
    const targets = this.targetIds().map(shapeId => ({ shapeId }));
    if (!this.editTarget && targets.length === 0) {
      this.panel.setMessage('Pick sketch geometry to copy first.');
      return null;
    }

    let directions: { axis: SketchCopyEditAxis; count: ValueExpr; value: ValueExpr }[] | undefined;
    if (values.kind === 'linear') {
      const active = this.panel.directions;
      directions = [];
      for (let i = 0; i < active.length; i++) {
        const axis = this.axisFor(active[i], active.length > 1);
        if ('error' in axis) {
          this.panel.setMessage(axis.error);
          return null;
        }
        if (!this.editTarget && axis.kind === 'keep') {
          this.panel.setMessage('Choose the direction to copy along.');
          return null;
        }
        directions.push({ axis, ...values.directions[i] });
      }
    }
    const axisEntities = this.axisPickEntities(directions);
    const shared = {
      newVariables: values.newVariables,
      preview: options.preview,
      signal: options.signal,
    };

    if (this.editTarget) {
      const repicked = this.picksDirty() && targets.length > 0;
      if (values.kind === 'linear') {
        return applySketchCopyEdit(this.editTarget, {
          kind: 'linear',
          directions,
          spacingMode: values.spacingMode,
          centered: values.centered || undefined,
          skip: values.skip.length > 0 ? values.skip : undefined,
          entities: repicked ? targets : undefined,
          axisEntities: axisEntities.length > 0 ? axisEntities : undefined,
          expectedStatement: this.expectedStatement,
          ...shared,
        });
      }
      return applySketchCopyEdit(this.editTarget, {
        kind: 'circular',
        center: values.center,
        count: values.count,
        sweep: values.sweep,
        skip: values.skip.length > 0 ? values.skip : undefined,
        entities: repicked ? targets : undefined,
        expectedStatement: this.expectedStatement,
        ...shared,
      });
    }

    if (values.kind === 'linear') {
      return applySketchCopy(targets, {
        kind: 'linear',
        // Create mode never carries keeps — checked above.
        directions: directions as { axis: SketchCopyAxis; count: ValueExpr; value: ValueExpr }[],
        spacingMode: values.spacingMode,
        centered: values.centered || undefined,
        skip: values.skip.length > 0 ? values.skip : undefined,
        axisEntities: axisEntities.length > 0 ? axisEntities : undefined,
        ...shared,
      });
    }
    return applySketchCopy(targets, {
      kind: 'circular',
      center: values.center,
      count: values.count,
      sweep: values.sweep,
      skip: values.skip.length > 0 ? values.skip : undefined,
      ...shared,
    });
  }

  private async apply(): Promise<void> {
    if (this.applying || !this.active) {
      return;
    }
    this.applying = true;
    this.panel.setApplyEnabled(false);
    try {
      const request = this.send({});
      if (request === null) {
        return;
      }
      const result = await request;
      if (result.success) {
        if (this.editTarget) {
          // The rewrite strips the double-click's breakpoint atomically with
          // the edit — clearing it again here could clobber that write.
          this.exit('apply');
        }
        this.onDone();
      } else {
        this.panel.setMessage(result.reason ?? 'Could not apply the copy');
        this.panel.setApplyEnabled(true);
      }
    } finally {
      this.applying = false;
    }
  }
}
