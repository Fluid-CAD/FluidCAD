import {
  applySketchMirror, applySketchMirrorEdit, clearBreakpoints, fetchFeatureGhost,
  fetchSketchFeatureSources, ApplyFeatureResponse, FeatureEditTarget, GhostSolid,
  Mirror2DGhostRequest, ParsedFeatureStatement, SketchApplyEntity, SketchMirrorEditAxis,
} from '../api';
import { SketchOpSelection, SolvedOpRail, SolvedPickRail } from './sketch-op-service';
import { keepChip } from './create-feature/sketch-profiles';
import { FeatureGhostOverlay } from './create-feature/feature-ghost';
import { PickSlotChip } from './pick-slot';
import { SketchMirrorPanel, SketchMirrorArmedSlot } from './sketch-mirror-panel';
import {
  buildMirrorEmission, mirrorTargetsFor, type MirrorAxisInput, type MirrorEmissionError,
  type MirrorEmissionPlan, type MirrorTarget,
} from './tools/mirror-emission';
import type { SolvedPick } from './sketch-hover-select-handler';

/** The mirror dialog's window onto the solved sketch: the picks + model +
 * emission rail of the constraint-native create path, plus the datum-pick
 * eviction the line slot uses. */
export type SolvedMirrorRail = SolvedOpRail & SolvedPickRail;

const PREVIEW_DEBOUNCE_MS = 250;

/**
 * A `mirror()` statement as the parse route reads it. The 3D form's
 * `planeText` is the statement's first argument — for the in-sketch form
 * that is its axis text, which the client routes here by the row's unique
 * type before the parse is asked.
 */
type ParsedSketchMirror = Extract<ParsedFeatureStatement, { feature: 'mirror' }>;

/**
 * The in-sketch mirror dialog on the 2D op rails: armed from the sketch
 * toolbar, it reads the hover handler's selected edges and — like the
 * Rectangle and Fillet tools — writes plain geometry, not a `mirror()`
 * statement: the reflected line/arc/circle/point/bezier statements plus
 * `symmetric(source, image, line)` rows (one per entity, one per bezier
 * control point), planned client-side from the solved model
 * (tools/mirror-emission.ts) and applied through the atomic insert-solved
 * rail. The user gets editable geometry held symmetric by
 * constraints they can read, move and delete. Exactly one panel slot is
 * armed at a time and the picks land in it: the Geometry slot collects the
 * targets; the armed Mirror line slot consumes ONE pick as the line to
 * reflect across — a sketch line (a `.guide()` included) or one of the
 * sketch's datum axes (a click on the X or Y axis line, read off the
 * solved-pick rail), written as `xAxis()` / `yAxis()`.
 *
 * The same dialog edits a hand-written `mirror()` statement in place
 * ({@link enterEdit}), through the server synthesis rail:
 * the timeline double-click's breakpoint pauses the build just BEFORE the
 * statement (the offset edit's contract), its line slot opens on a
 * "Current: …" keep chip, and its targets seed as highlighted picks —
 * untouched, they rewrite verbatim; re-picked, the whole target list
 * re-synthesizes in pick order.
 */
export class SketchMirrorService {
  /** Fired on enter/exit — main.ts suspends the sketch dialog while open. */
  onVisibilityChange?: (visible: boolean) => void;

  private panel: SketchMirrorPanel;
  private active = false;
  private previewTimer: number | null = null;
  private previewAbort: AbortController | null = null;
  private applying = false;

  /** Statement being edited in place (timeline double-click), or null. */
  private editTarget: FeatureEditTarget | null = null;
  /** The parsed statement the edit dialog opened over (keep-slot texts). */
  private editStatement: ParsedSketchMirror | null = null;
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

  // Armed-slot pick partitioning (the 2D copy's idiom): the armed slot's ids
  // ARE the live selection. Arming the line slot freezes the targets; each
  // pick made there is consumed into the line entity and the selection
  // cleared, so the next click replaces it.
  private armedApplied: SketchMirrorArmedSlot = 'targets';
  private frozenTargets: string[] = [];
  /** The picked mirror line (the line slot's `edge` mode). */
  private axisEntity: string | null = null;
  /** The solved pick behind `axisEntity` — the line entity the symmetric
   * rows name (create mode). */
  private axisPick: SolvedPick | null = null;
  /** The solved picks frozen with `frozenTargets` while the line slot is
   * armed (the live selection is cleared then) — the targets re-resolve
   * from these, so a chip's ✕ needs no pick bookkeeping of its own. */
  private frozenPicks: SolvedPick[] = [];
  /** A datum pick is being evicted from the viewport — its own change is not a new pick. */
  private consumingDatum = false;

  constructor(
    container: HTMLElement,
    private readonly selection: SketchOpSelection,
    private onDone: () => void,
    /** The live viewport geometry overlay, shared with the other 2D op dialogs. */
    private readonly ghost: FeatureGhostOverlay | undefined,
    /**
     * The solved picks beyond edge ids (where a click on the sketch's X or
     * Y datum axis shows up), the read model and the emission rail.
     */
    private readonly rail: SolvedMirrorRail,
  ) {
    this.panel = new SketchMirrorPanel(container);
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
    this.panel.onAxisModeChange = () => {
      // The slot left edge mode (✕, a local-axis choice) — the entity would
      // otherwise silently ride along into the next edge state.
      this.axisEntity = null;
      this.axisPick = null;
    };
    this.panel.onArmedSlotChange = () => this.handleArmedSlotChange();
  }

  get isActive(): boolean {
    return this.active;
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
    this.frozenPicks = [];
    this.axisEntity = null;
    this.axisPick = null;
    this.panel.show();
    this.onVisibilityChange?.(true);
    this.refresh();
  }

  /**
   * Open the dialog over the `mirror()` statement at `target`, prefilled from
   * its parsed arguments. The double-click that got here left a breakpoint
   * just before the statement, so the build is paused inside its sketch at
   * the state the statement's arguments see: the originals visible, their
   * reflections absent, everything re-pickable.
   */
  enterEdit(
    target: FeatureEditTarget,
    parsed: ParsedSketchMirror,
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
    this.frozenPicks = [];
    this.axisEntity = null;
    this.axisPick = null;
    this.selection.clear();
    // The parse's `planeText` is the statement's first argument — the
    // in-sketch form's axis.
    this.panel.showEdit({ axisLabel: parsed.planeText });
    this.onVisibilityChange?.(true);
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
    this.frozenPicks = [];
    this.axisEntity = null;
    this.axisPick = null;
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
   * arriving back restores them. The line slot always starts its picking
   * from an empty selection — its content is the consumed entity chip.
   */
  private handleArmedSlotChange(): void {
    const next = this.panel.armedSlot;
    if (next === this.armedApplied) {
      return;
    }
    if (this.armedApplied === 'targets') {
      this.frozenTargets = this.selection.ids();
      this.frozenPicks = this.rail.picks();
    }
    this.armedApplied = next;
    this.selection.clear();
    if (next === 'targets') {
      this.selection.select(this.frozenTargets);
    }
    this.refresh();
  }

  /**
   * While the line slot is armed, the newest pick IS the mirror line:
   * consume it into the slot's chip and clear it from the viewport, so the
   * next click replaces it. An edge pick becomes the line entity; a click on
   * the sketch's X or Y datum axis (a solved-pick datum, never an edge id)
   * becomes the standard chip the apply writes as `xAxis()` / `yAxis()`.
   */
  private consumeAxisPick(): void {
    if (this.panel.armedSlot !== 'axis' || this.consumingDatum) {
      return;
    }
    const ids = this.selection.ids();
    if (ids.length > 0) {
      const shapeId = ids[ids.length - 1];
      this.axisEntity = shapeId;
      // The solved pick behind the edge — the line entity the symmetric
      // rows will name; a shape with no solver identity leaves it null and
      // the plan refuses honestly.
      this.axisPick = this.rail.picks().find(pick => pick.shapeId === shapeId) ?? null;
      this.panel.setAxisEdgeChip(this.selection.describe(shapeId).label);
      this.panel.setMessage(null);
      this.selection.clear();
      return;
    }
    const datums = this.rail.picks()
      .filter(pick => pick.datum === 'x-axis' || pick.datum === 'y-axis');
    if (datums.length === 0) {
      return;
    }
    const pick = datums[datums.length - 1];
    this.axisEntity = null;
    this.axisPick = null;
    this.panel.selectDatumAxis(pick.datum === 'x-axis' ? 'x' : 'y');
    this.panel.setMessage(null);
    // Evicting the datum re-enters through onSelectionChange — the flag
    // keeps that echo from reading as a fresh pick.
    this.consumingDatum = true;
    try {
      for (const datum of datums) {
        this.rail.deselect(datum);
      }
    } finally {
      this.consumingDatum = false;
    }
    this.schedulePreview();
  }

  /** The target picks: the live selection, or the frozen set while the line slot is armed. */
  private targetIds(): string[] {
    return this.panel.armedSlot === 'targets' ? this.selection.ids() : this.frozenTargets;
  }

  /**
   * The mirror targets behind {@link targetIds} — live or frozen — resolved
   * against the solved picks and model: entity edge picks, and bezier
   * curves (no solver entity of their own) by their statement.
   */
  private mirrorTargets(): { targets: MirrorTarget[]; unresolved: string[] } {
    const picks = this.panel.armedSlot === 'targets' ? this.rail.picks() : this.frozenPicks;
    return mirrorTargetsFor(this.targetIds(), picks, this.rail.model());
  }

  /**
   * The constraint-native plan for the create dialog: the reflected
   * geometry + symmetric rows for the current picks, an error to show, or
   * null while the form is incomplete (still picking — no hint yet).
   */
  private createPlan(): MirrorEmissionPlan | MirrorEmissionError | null {
    if (this.targetIds().length === 0) {
      return null;
    }
    const { targets, unresolved } = this.mirrorTargets();
    if (unresolved.length > 0) {
      const labels = unresolved.map(shapeId => this.selection.describe(shapeId).label);
      return {
        ok: false,
        reason: `${labels.join(', ')}: the picked geometry has no solver identity — pick drawn lines, arcs, circles, ellipses, beziers or points`,
      };
    }
    const selection = this.panel.axisSelection();
    if (!selection || selection.kind === 'keep') {
      return null;
    }
    let axis: MirrorAxisInput;
    if (selection.kind === 'standard') {
      axis = { kind: 'datum', axis: selection.axis as 'x' | 'y' };
    } else if (this.axisPick) {
      axis = { kind: 'pick', pick: this.axisPick };
    } else if (this.axisEntity) {
      return { ok: false, reason: 'the mirror line must be a sketched line — pick a line or one of the sketch axes' };
    } else {
      return null;
    }
    const model = this.rail.model();
    if (!model) {
      return { ok: false, reason: 'the sketch has not rendered yet' };
    }
    return buildMirrorEmission({ targets, model, axis });
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
      this.panel.setTargets(chips, chips.length === 0 ? 'Pick sketch geometry to mirror' : null);
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

  /**
   * The mirror line as the request carries it, or the message blocking it.
   * A keep selection (edit mode) references the statement's own axis text —
   * the create path never sees one.
   */
  private axisFor(): SketchMirrorEditAxis | { error: string } {
    const selection = this.panel.axisSelection();
    if (!selection) {
      return { error: 'Pick the line to mirror across — a sketch line or one of the sketch axes.' };
    }
    if (selection.kind === 'keep') {
      return { kind: 'keep' };
    }
    if (selection.kind === 'standard') {
      // A picked datum axis is a sketch-local axis in this dialog.
      return { kind: 'local', axis: selection.axis as 'x' | 'y' };
    }
    return this.axisEntity
      ? { kind: 'edge' }
      : { error: 'Pick the mirror line first.' };
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
    // Create mode plans client-side from the solved model — no synthesis
    // round trip; the geometry statements about to be written stand in for
    // the statement preview, and the ghost still previews the reflection.
    if (!this.editTarget) {
      const plan = this.createPlan();
      if (plan === null) {
        this.panel.setPreview(null);
        this.panel.setMessage(null);
        this.panel.setApplyEnabled(true);
        this.ghost?.clear();
        return;
      }
      if ('reason' in plan) {
        this.panel.setPreview(null);
        this.panel.setApplyEnabled(false);
        this.panel.setMessage(plan.reason);
        this.ghost?.clear();
        return;
      }
      this.panel.setPreview(plan.preview.join('\n'));
      this.panel.setMessage(null);
      this.panel.setApplyEnabled(true);
      try {
        await this.runGhost(abort.signal);
      } catch {
        // aborted
      }
      return;
    }
    try {
      const result = await this.send({ preview: true, signal: abort.signal, quiet: true });
      if (abort.signal.aborted || !this.active) {
        return;
      }
      if (result === null) {
        // Incomplete form: the user is still picking, so no hint yet — Apply
        // stays clickable, and its click is what surfaces what is missing.
        this.panel.setPreview(null);
        this.panel.setMessage(null);
        this.panel.setApplyEnabled(true);
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
        this.panel.setMessage(result.reason ?? 'Could not synthesize the mirror for this selection');
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
   * Draw the live reflected ghost for the current picks, or clear the
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
   * or was cleared. The line slot resolves like the copy dialog's direction
   * slots: a picked datum axis is a sketch-local axis, a picked line ships
   * its shapeId, and a kept line text is unaddressable — no ghost until it
   * is re-chosen (a kept `xAxis()` already reads back as its standard chip).
   */
  private ghostRequest(): Mirror2DGhostRequest | null {
    const ids = this.targetIds();
    if (ids.length === 0
      && (!this.editTarget || (this.editStatement?.targetTexts ?? []).length > 0)) {
      return null;
    }
    const selection = this.panel.axisSelection();
    if (!selection || selection.kind === 'keep') {
      return null;
    }
    const axis = selection.kind === 'standard'
      ? { kind: 'local' as const, axis: selection.axis as 'x' | 'y' }
      : this.axisEntity
        ? { kind: 'edge' as const, shapeId: this.axisEntity }
        : null;
    if (!axis) {
      return null;
    }
    return {
      feature: 'mirror2d',
      entities: ids.map(shapeId => ({ shapeId })),
      axis,
    };
  }

  /**
   * One request for both modes, or null when the form is incomplete: an
   * armed dialog synthesizes a new statement for the picked geometry; an
   * edit rewrites the statement at `editTarget`, sending its target picks
   * only once they differ from what it opened with. An incomplete form
   * shows what is missing only when asked (`quiet` off — the Apply click);
   * the preview stays silent while the user is still picking.
   */
  private send(options: {
    preview?: boolean;
    signal?: AbortSignal;
    quiet?: boolean;
  }): Promise<ApplyFeatureResponse> | null {
    const incomplete = this.missingInput();
    if (incomplete !== null) {
      if (!options.quiet) {
        this.panel.setMessage(incomplete);
      }
      return null;
    }
    const targets = this.targetIds().map(shapeId => ({ shapeId }));
    const axis = this.axisFor() as SketchMirrorEditAxis;
    const axisEntities: SketchApplyEntity[] | undefined = axis.kind === 'edge'
      ? [{ shapeId: this.axisEntity! }]
      : undefined;

    if (this.editTarget) {
      const repicked = this.picksDirty() && targets.length > 0;
      return applySketchMirrorEdit(this.editTarget, {
        axis,
        entities: repicked ? targets : undefined,
        axisEntities,
        expectedStatement: this.expectedStatement,
        preview: options.preview,
        signal: options.signal,
      });
    }
    // Create mode never carries keeps (missingInput refuses them) — the
    // remaining kinds are the create request's.
    return applySketchMirror(targets, {
      axis: axis as Exclude<SketchMirrorEditAxis, { kind: 'keep' }>,
      axisEntities,
      preview: options.preview,
      signal: options.signal,
    });
  }

  /**
   * What the form still needs before a request can go out, or null when it
   * is complete: geometry to mirror (an edit may keep its statement's own),
   * and the line to mirror across — a create dialog has no statement axis
   * to keep, so its slot must hold a real pick.
   */
  private missingInput(): string | null {
    if (!this.editTarget && this.targetIds().length === 0) {
      return 'Pick sketch geometry to mirror first.';
    }
    const axis = this.axisFor();
    if ('error' in axis) {
      return axis.error;
    }
    if (!this.editTarget && axis.kind === 'keep') {
      return 'Pick the line to mirror across.';
    }
    return null;
  }

  private async apply(): Promise<void> {
    if (this.applying || !this.active) {
      return;
    }
    this.applying = true;
    this.panel.setApplyEnabled(false);
    try {
      if (!this.editTarget) {
        // Constraint-native create: emit the reflected geometry + symmetric
        // rows through the insert-solved rail.
        const plan = this.createPlan();
        if (plan === null) {
          this.panel.setMessage(this.missingInput() ?? 'Pick sketch geometry to mirror first.');
          this.panel.setApplyEnabled(true);
          return;
        }
        if ('reason' in plan) {
          this.panel.setMessage(plan.reason);
          this.panel.setApplyEnabled(true);
          return;
        }
        const result = await this.rail.emit(plan.request);
        if (result.success) {
          this.onDone();
        } else {
          this.panel.setMessage(result.reason ?? 'Could not apply the mirror');
          this.panel.setApplyEnabled(true);
        }
        return;
      }
      const request = this.send({});
      if (request === null) {
        // The click surfaced what is missing; the button stays available
        // for the next try once it is picked.
        this.panel.setApplyEnabled(true);
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
        this.panel.setMessage(result.reason ?? 'Could not apply the mirror');
        this.panel.setApplyEnabled(true);
      }
    } finally {
      this.applying = false;
    }
  }
}
