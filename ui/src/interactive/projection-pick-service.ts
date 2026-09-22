import {
  applyProject, applyProjectEdit, fetchFeatureSources, fetchSketchNames, ApplyFeatureEntity, FeatureEditTarget,
  ParsedFeatureStatement, ProjectionOp, SelectionGroupKind, SketchSourceRef,
} from '../api';
import { mergeUniqueEntities } from '../helpers/entities';
import { SceneObjectRender, SubSelection } from '../types';
import { SelectedEntity, Viewer } from '../viewer';
import { ApplyRunner } from './create-feature/apply-runner';
import { ForeignConfirmation } from './create-feature/foreign-confirmation';
import {
  keepChip, resolveSketchByShapeId, sketchWireShapeIds, sourceChip,
} from './create-feature/sketch-profiles';
import { SketchUISuspender } from './create-feature/sketch-suspender';
import { EditSession, EditSessionInfo } from './edit-session';
import { PickSelection } from './pick-selection';
import { PROJECTION_OP_SPECS, ProjectionOpSpec } from './projection-op';
import { ProjectionPanel } from './projection-panel';
import { SelectionContextMenu } from './selection-menu';

/**
 * The apply payload: the 3D picks, the previous sketches referenced whole,
 * plus the sketch body receiving the call (create mode) — an edit rewrites
 * the statement at its own location instead and carries no sketch.
 */
type ProjectRequest = {
  entities: ApplyFeatureEntity[];
  sketches: SketchSourceRef[];
  sketch: SketchSourceRef | null;
};

/**
 * A previous sketch picked as a whole-sketch source (`project(s1)`): its
 * call site (what the request sends), the chip label (the sketch's bound
 * variable once resolved, else its row name) and the wire shape ids of its
 * rendered geometry (what the viewport highlights — empty for a sketch the
 * scene no longer shows).
 */
type SketchPick = { loc: SketchSourceRef; label: string; wireIds: string[] };

/** One removable chip row: an entity pick (or chain) or a sketch pick. */
type ChipRow = { label: string; members: SelectedEntity[]; sketch: SketchPick | null };

function sameLoc(a: { filePath: string; line: number }, b: { filePath: string; line: number }): boolean {
  return a.filePath === b.filePath && a.line === b.line;
}

/** A `project()` / `intersect()` statement as the parse route reads it. */
type ParsedProject = Extract<ParsedFeatureStatement, { feature: 'project' }>;

/**
 * The Project sketch tool: flatten 3D edges and faces onto the plane of the
 * sketch being edited. The Intersect tool is the same service under
 * `op: 'intersect'` — it sections the picked faces with the sketch plane
 * instead, and everything op-specific (title, prompts, which picks count,
 * the callee written) reads off {@link PROJECTION_OP_SPECS}. Arming it
 * leaves sketch editing (the camera unlocks
 * from the sketch normal and clicks reach the solids again), then every click
 * toggles an edge or a face into the pick set — or, on a previous sketch's
 * geometry, that whole sketch (`project(s1)`, bound like an extrude's
 * profile). Right-click opens the shared
 * multi-select menu — tangent chain, classified bucket, same-type and equal
 * edges — the same filtering the modify tools offer. The selection is explained by
 * the same synthesis the modify tools use — the dialog's expression row shows
 * the winning `project(…)` arguments and its verified alternatives, editable
 * in place. Apply writes the statement into the sketch's own body; Cancel
 * touches no code and hands the viewport back to the sketch.
 *
 * Sources another part owns are allowed: the preview reports them, the
 * dialog raises a notice (Apply publishes them from their owner with
 * `expose()` and projects `<owner>.features.<name>`), and Apply waits for
 * the user's go-ahead — sent as the request's `confirmForeign`.
 */
export class ProjectionPickService {
  /**
   * The tool finished (applied or cancelled) — the toolbar disarms it, which
   * comes back through {@link exit} with these options.
   */
  onDone?: (opts?: { resume?: 'immediate' | 'lazy' }) => void;
  /**
   * Fired on enter/exit. The dialog docks in the sketch dialog's spot, so the
   * toolbar service wires this to suspend the sketch dialog while it is open
   * and restore it after — the same contract as the 2D op dialogs.
   */
  onVisibilityChange?: (visible: boolean) => void;

  private readonly panel: ProjectionPanel;
  private readonly sketchUI: SketchUISuspender;
  private readonly selection = new PickSelection();
  /** The previous sketches picked whole, in pick order (chips lead with them). */
  private sketches: SketchPick[] = [];
  /** The last rendered scene — what a sketch-wire pick resolves against. */
  private sceneObjects: SceneObjectRender[] = [];
  private readonly selectionMenu: SelectionContextMenu;
  private readonly runner: ApplyRunner<ProjectRequest>;
  /** The cross-part gate: the preview's foreign picks and their confirmation. */
  private readonly foreign = new ForeignConfirmation();
  /** The sketch receiving the projection, or null while disarmed. */
  private sketch: SketchSourceRef | null = null;
  /** The statement being written — set on every enter, before the panel shows. */
  private op: ProjectionOp = 'project';

  /**
   * The in-place edit's view state (timeline double-click): the session rolls
   * the viewport back to just before the statement and re-asserts that
   * rollback across renders — the fillet/chamfer edit pattern.
   */
  private readonly session = new EditSession();
  /** The statement's own source args — the keep chip and override baseline. */
  private editArgsText = '';
  /** Signature of the seeded (statement-own) picks; dirty picks re-synthesize. */
  private seedSignature: string | null = null;
  /** A full render rebuilt the scene mid-edit; re-seed at the next boundary. */
  private editSceneStale = false;
  /** A successful edit apply — its transform already stripped the breakpoint. */
  private editApplied = false;

  constructor(
    container: HTMLElement,
    private viewer: Viewer,
    hooks: { onSuspendSketchUI?: () => void; onResumeSketchUI?: () => void } = {},
  ) {
    this.sketchUI = new SketchUISuspender(viewer, hooks);

    this.panel = new ProjectionPanel(container);
    this.panel.onApply = () => void this.runner.apply();
    this.panel.onExit = () => this.onDone?.();
    this.panel.onRemoveChip = (index) => this.removeChip(index);
    this.panel.onChipHover = (index) => this.previewChip(index);
    this.panel.onConfirmForeign = () => {
      this.foreign.confirm();
      this.panel.setMessage(null);
      this.syncForeignNotice();
    };

    // Right-click menu for the projected sources: the same multi-select groups
    // the modify tools offer (a projection picks edges and faces alike), so a
    // tangent chain, a classified bucket or every equal edge lands in one gesture.
    this.selectionMenu = new SelectionContextMenu(container, 'fluidcad-projection-pick-menu', {
      kinds: ['tangent', 'classified', 'same-type', 'equal', 'sibling'],
      onSelectGroup: (kind, seed, members) => this.applyGroup(kind, seed, members),
      onPreview: (members) => this.previewSelection(members),
    });

    this.runner = new ApplyRunner({
      panel: this.panel,
      isArmed: () => this.isPicking,
      build: () => this.buildRequest(),
      // One request for both modes: an armed tool synthesizes a new statement
      // into its sketch; an edit rewrites the statement at the session's
      // target, sending its picks for boundary-scoped synthesis only once
      // they differ from the seeded (statement-own) set — an untouched
      // selection keeps the argument text verbatim.
      send: (request, extras) => {
        const editTarget = this.session.target;
        if (editTarget) {
          const repicked = this.picksDirty()
            && (request.entities.length > 0 || request.sketches.length > 0);
          return applyProjectEdit(editTarget, {
            expectedStatement: this.session.expectedStatement,
            before: this.session.boundary ?? undefined,
            entities: repicked ? request.entities : undefined,
            chains: repicked ? this.selection.apiChains() : undefined,
            sketches: repicked ? request.sketches : undefined,
            selectorOverride: this.selectorOverride(),
            ...extras,
          });
        }
        return applyProject(request.entities, request.sketch!, {
          op: this.op,
          chains: this.selection.apiChains(),
          sketches: request.sketches,
          selectorOverride: this.selectorOverride(),
          confirmForeign: this.foreign.confirmed,
          ...extras,
        }).then(result => {
          // An apply refused for want of the go-ahead (the click outran the
          // preview that would have raised the notice) reports the picks
          // too — raise it from here so the next Apply can go through.
          if (!extras.preview && !result.success && result.foreign) {
            this.foreign.update(result.foreign.picks);
            this.syncForeignNotice();
          }
          return result;
        });
      },
      validateApply: () => {
        const reason = this.foreign.blockReason();
        return reason ? { error: reason } : null;
      },
      onApplied: () => {
        // The rewrite strips the double-click's breakpoint atomically with
        // the edit — the exit below must not clear it again (see exit).
        this.editApplied = true;
        this.onDone?.({ resume: 'lazy' });
      },
      failMessage: () => this.spec.failMessage,
      onPreviewSuccess: (result) => {
        this.panel.setMessage(null);
        // An edit that re-picked nothing synthesizes no args — the
        // statement's own source list stands, and the row keeps showing it.
        this.panel.showExpression(
          result.args ?? (this.session.active ? this.editArgsText : ''),
          result.alternatives ?? [],
        );
        this.foreign.update(result.foreign?.picks);
        this.syncForeignNotice();
      },
    });
  }

  /** The presentation and pick rules of the statement being written. */
  private get spec(): ProjectionOpSpec {
    return PROJECTION_OP_SPECS[this.op];
  }

  /** Armed and consuming viewport clicks. */
  get isPicking(): boolean {
    return this.sketch !== null || this.session.active;
  }

  /** True while the dialog rewrites an existing statement instead of writing one. */
  get isEditing(): boolean {
    return this.session.active;
  }

  /** True while the armed tool has suspended sketch editing. */
  get sketchUISuspended(): boolean {
    return this.sketchUI.suspended;
  }

  /**
   * Arm the tool over the sketch being edited. Composing a projection means
   * looking at the solids, not down the sketch plane, so sketch editing is
   * suspended right away — Cancel resumes it, an Apply's re-render takes over.
   */
  enter(sketch: SketchSourceRef, op: ProjectionOp = 'project'): void {
    if (this.isPicking) {
      return;
    }
    this.sketch = sketch;
    this.selection.clear();
    this.sketches = [];
    this.sketchUI.suspend();
    this.dress(op);
    this.viewer.clearHighlight();
    this.panel.show();
    this.onVisibilityChange?.(true);
  }

  /**
   * Put the service, the panel, the cross-part gate and the viewer's pick
   * channels into `op`'s terms. The sketch-wire channel follows the op:
   * flattening takes previous sketches whole, sectioning never does. The
   * sketch being edited is on screen too — its own wires answer with a
   * hint, never a pick.
   */
  private dress(op: ProjectionOp): void {
    this.op = op;
    this.foreign.wording = this.spec.foreign;
    this.panel.setOp(op);
    this.viewer.pickFilter = this.spec.pickFilter;
    this.viewer.pickSketchWires = this.spec.pickSketches;
  }

  /**
   * Open the dialog over the `project()` statement at `target` (timeline
   * double-click). The session rolls the viewport back to just before the
   * statement's row — the world its arguments see, the projected edges
   * absent — and suspending sketch editing restores the free 3D camera and
   * the Z-up grid over that rolled-back scene (the fillet/chamfer edit
   * pattern). The statement's own sources seed the pick set as highlighted,
   * removable chips; re-picking is live exactly like create mode.
   */
  enterEdit(
    target: FeatureEditTarget,
    parsed: ParsedProject,
    info: Omit<EditSessionInfo, 'target'>,
  ): void {
    this.close({ resume: 'lazy' }, 'reopen');
    this.editArgsText = parsed.argsText;
    this.editApplied = false;
    this.seedSignature = null;
    this.editSceneStale = false;
    this.selection.clear();
    this.sketches = [];
    // The session owns the view: free 3D camera over the rolled-back scene.
    this.sketchUI.suspend();
    this.session.begin({ ...info, target });
    // The statement's own callee decides the mode — an edit never changes it.
    this.dress(parsed.op);
    this.viewer.clearHighlight();
    this.panel.show();
    this.panel.setTitle(this.spec.editTitle);
    this.panel.showExpression(parsed.argsText, []);
    this.refresh();
    void this.loadEditSources();
    this.onVisibilityChange?.(true);
  }

  /**
   * Seed the pick set with the statement's current sources, resolved by the
   * server: 3D sources as entities on the pre-statement solids, whole-sketch
   * sources by call site — the highlighted, removable chips the dialog opens
   * with. Unresolvable sources (clones, exotic selectors, a sketch entity
   * referenced on its own) leave the set empty and the keep chip standing —
   * new picks then REPLACE the statement's args. A re-picked (dirty)
   * selection is never clobbered by a re-seed.
   */
  private async loadEditSources(): Promise<void> {
    const boundary = this.session.boundary;
    if (!boundary) {
      return;
    }
    const result = await fetchFeatureSources(boundary);
    if (!this.session.active || this.session.boundary?.index !== boundary.index || this.picksDirty()) {
      return;
    }
    const sketchSlots = result.ok && (result.feature === 'projection' || result.feature === 'intersect')
      ? (result.sketches ?? [])
      : [];
    if (result.ok && (result.feature === 'projection' || result.feature === 'intersect')
      && result.selection.kind === 'entities' && sketchSlots.every(slot => slot.kind === 'sketch')) {
      this.selection.entities = result.selection.entities.map(e => ({ shapeId: e.shapeId, sub: e.sub }));
      this.selection.chains = [];
      this.sketches = sketchSlots.flatMap(slot => slot.kind === 'sketch' ? [this.sketchPickAt(slot)] : []);
      this.seedSignature = this.sourceSignature();
      void this.labelSketches();
    } else {
      this.selection.clear();
      this.sketches = [];
      this.seedSignature = null;
    }
    this.refresh();
  }

  /**
   * True when the sources no longer match the seeded ones — the apply then
   * sends the picks for synthesis instead of keeping the args verbatim.
   */
  private picksDirty(): boolean {
    if (!this.session.active) {
      return false;
    }
    if (this.seedSignature === null) {
      return this.selection.entities.length > 0 || this.sketches.length > 0;
    }
    return this.sourceSignature() !== this.seedSignature || this.selection.chains.length > 0;
  }

  /** The pick set's identity: the entity signature plus the sketch call sites. */
  private sourceSignature(): string {
    const sketches = this.sketches.map(pick => `${pick.loc.filePath}:${pick.loc.line}`).join(',');
    return `${this.selection.signature()}|${sketches}`;
  }

  /**
   * `resume: 'lazy'` gives sketch editing back without forcing the mode
   * transition — for apply-success and for exits driven by something else
   * taking the viewport (another dialog arming, the sketch going away), where
   * a forced re-render would fight the view that caller is installing. User
   * cancels resume immediately.
   */
  exit(opts: { resume?: 'immediate' | 'lazy' } = {}): void {
    this.close(opts, this.editApplied ? 'apply' : 'cancel');
  }

  /**
   * Tear the tool down. The edit reasons map onto {@link EditSession.end}:
   * a cancelled edit clears the breakpoint its double-click placed, an
   * `apply`'s transform strips it atomically with the rewrite, `reopen`
   * hands over to a fresh edit whose breakpoint is already in the file, and
   * `gone` means a code change already superseded the session.
   */
  private close(
    opts: { resume?: 'immediate' | 'lazy' },
    reason: 'cancel' | 'apply' | 'reopen' | 'gone',
  ): void {
    if (!this.isPicking) {
      return;
    }
    this.session.end(reason === 'reopen' ? 'continue' : reason);
    this.sketch = null;
    this.editArgsText = '';
    this.seedSignature = null;
    this.editSceneStale = false;
    this.editApplied = false;
    this.selection.clear();
    this.sketches = [];
    this.foreign.reset();
    this.selectionMenu.hide();
    this.runner.cancelPreview();
    this.panel.hide();
    // The sketch-wire channel was this tool's; hand it back closed, as the
    // create dialogs do, before sketch editing resumes.
    this.viewer.pickSketchWires = false;
    this.viewer.clearHighlight();
    this.sketchUI.resume((opts.resume ?? 'immediate') === 'immediate');
    this.onVisibilityChange?.(false);
  }

  /**
   * Route every render through the edit session first: it keeps the view on
   * the pre-statement boundary and re-seeds there. Without a session this is
   * the plain armed-tool update — shape ids changed, so picks drop back to
   * the prompt (the wrap dialog's behavior for its target face).
   */
  handleSceneRendered(sceneObjects: SceneObjectRender[], stop: number, isRollback: boolean): void {
    this.sceneObjects = sceneObjects;
    const state = this.session.onSceneRendered(sceneObjects, stop, isRollback);
    if (state === 'inactive') {
      if (!isRollback) {
        this.update(sceneObjects);
      }
      return;
    }
    if (state === 'gone') {
      // The statement vanished under the edit (a code change) — a full
      // render is in flight; fold the dialog without touching the code.
      this.close({ resume: 'lazy' }, 'gone');
      this.onDone?.();
      return;
    }
    if (state === 'waiting') {
      if (!isRollback) {
        // A full render rebuilt the scene: every seeded shape id died. The
        // re-asserting rollback is in flight; re-seed when it lands.
        this.editSceneStale = true;
      }
      return;
    }
    // At the boundary: the meshes were just rebuilt (updateView ran first).
    this.selectionMenu.hide();
    if (this.editSceneStale) {
      this.editSceneStale = false;
      if (this.picksDirty()) {
        // The re-picked selection can't survive a scene rebuild — old shape
        // ids resolve nowhere. Reset to the statement's own sources.
        this.selection.clear();
        this.sketches = [];
        this.seedSignature = null;
        this.panel.setMessage('The code changed — the re-picked selection was reset.');
      }
      void this.loadEditSources();
    }
    this.refresh();
  }

  /**
   * A render landed while the tool is armed (create mode): shape ids changed
   * with it, so the picks no longer address anything and drop back to the
   * prompt.
   */
  private update(_sceneObjects: SceneObjectRender[]): void {
    if (!this.isPicking || this.isEmpty) {
      return;
    }
    this.selection.clear();
    this.sketches = [];
    this.foreign.reset();
    this.syncForeignNotice();
    this.selectionMenu.hide();
    this.viewer.clearHighlight();
    this.panel.setMessage('The code changed — the picked geometry was reset.');
    this.refresh();
  }

  /** True when the statement takes this kind of pick (faces only, for intersect). */
  private accepts(sub: SubSelection | null): sub is Extract<SubSelection, { type: 'edge' | 'face' }> {
    return !!sub && (this.spec.picks as readonly string[]).includes(sub.type);
  }

  /** Nothing picked yet — no entities, no sketches. */
  private get isEmpty(): boolean {
    return this.selection.isEmpty && this.sketches.length === 0;
  }

  /**
   * A viewport click while armed: an edge or face toggles into the source
   * set; a sketch wire toggles its whole sketch.
   */
  handleClick(shapeId: string | null, sub: SubSelection): void {
    if (!this.isPicking || !shapeId) {
      return;
    }
    if (sub?.type === 'sketch') {
      this.handleSketchPick(shapeId);
      return;
    }
    if (!this.accepts(sub)) {
      return;
    }
    this.panel.setMessage(null);
    this.selection.toggle({ shapeId, sub });
    this.refresh();
  }

  /**
   * A sketch-wire pick: the wire's sketch toggles into the source set as a
   * whole-sketch reference. The sketch being edited is on screen too and
   * cannot project itself — its wires answer with a hint. A sketch drawn
   * after this one is refused by the server's preview (it cannot be
   * referenced before it exists), so the click lands and the row explains.
   */
  private handleSketchPick(shapeId: string): void {
    if (!this.spec.pickSketches) {
      return;
    }
    const row = resolveSketchByShapeId(shapeId, this.sceneObjects);
    const loc = row?.sourceLocation;
    if (!row || !loc) {
      return;
    }
    this.panel.setMessage(null);
    if (this.sketch && sameLoc(loc, this.sketch)) {
      this.panel.setMessage('That is the sketch being edited — pick a previous sketch.');
      return;
    }
    const index = this.sketches.findIndex(pick => sameLoc(pick.loc, loc));
    if (index >= 0) {
      this.sketches = this.sketches.filter((_, i) => i !== index);
    } else {
      this.sketches = [...this.sketches, this.sketchPickAt(loc, row)];
      void this.labelSketches();
    }
    this.refresh();
  }

  /**
   * A whole-sketch pick for a call site: its rendered wires (for the
   * highlight) and a provisional label from its row — the bound variable
   * name replaces it once {@link labelSketches} resolves.
   */
  private sketchPickAt(loc: { filePath: string; line: number; column: number }, row?: SceneObjectRender): SketchPick {
    const sketchRow = row ?? this.sceneObjects.find(o => o.type === 'sketch'
      && o.sourceLocation !== undefined && sameLoc(o.sourceLocation, loc));
    return {
      loc: { filePath: loc.filePath, line: loc.line, column: loc.column },
      label: sketchRow?.name ?? 'Sketch',
      wireIds: sketchWireShapeIds(loc, this.sceneObjects),
    };
  }

  /**
   * Relabel the sketch chips with the variable each statement is bound to
   * (`s1`, `layout`) — resolved over the live buffer server-side, applied
   * only while the same sketches are still picked.
   */
  private async labelSketches(): Promise<void> {
    const picks = this.sketches;
    if (picks.length === 0) {
      return;
    }
    const names = await fetchSketchNames(picks.map(pick => pick.loc.line), 'sketch');
    if (!this.isPicking || this.sketches !== picks) {
      return;
    }
    this.sketches = picks.map((pick, i) => names[i] ? { ...pick, label: names[i]! } : pick);
    this.refresh();
  }

  /** Right-click on an edge/face: the multi-select menu for that pick. */
  handleContextMenu(shapeId: string | null, sub: SubSelection, clientX: number, clientY: number): void {
    if (!this.isPicking) {
      return;
    }
    this.selectionMenu.hide();
    if (!shapeId || !this.accepts(sub)) {
      return;
    }
    // The hover tint would otherwise be stashed as an "original" color by the
    // preview highlight and stick around after the preview restores it.
    this.viewer.clearHover();
    void this.selectionMenu.open({ shapeId, sub }, clientX, clientY);
  }

  /** A multi-select menu group was clicked: chain or merge into the pick set. */
  private applyGroup(kind: SelectionGroupKind, seed: SelectedEntity, members: SelectedEntity[]): void {
    if (!this.isPicking) {
      return;
    }
    this.panel.setMessage(null);
    if (kind === 'tangent') {
      // Tangent chains stay chains — they synthesize to `.withTangents()`.
      this.selection.addChain(seed, members);
      this.refresh();
    } else {
      this.mergeEntities(members);
    }
  }

  /** Merge group members into the pick set as plain picks. */
  private mergeEntities(members: SelectedEntity[]): void {
    if (!this.selection.merge(members)) {
      return;
    }
    this.refresh();
  }

  /** Menu-hover preview: show the pick set as the hovered click would leave it. */
  private previewSelection(members: SelectedEntity[] | null): void {
    if (!this.isPicking) {
      return;
    }
    this.highlight(
      members ? mergeUniqueEntities(this.selection.entities, members) : this.selection.entities,
      this.allWireIds(),
    );
  }

  /** The request for the current pick set, or the message blocking it. */
  private buildRequest(): ProjectRequest | { error: string } {
    const sketches = this.sketches.map(pick => pick.loc);
    if (this.session.active) {
      // An edit with no re-picks is complete — the statement's own source
      // arguments stand (or the edited expression row replaces them).
      return { entities: this.selection.entities, sketches, sketch: null };
    }
    if (!this.sketch) {
      return { error: 'No sketch to write into.' };
    }
    if (this.isEmpty) {
      return { error: this.spec.emptyMessage };
    }
    return { entities: this.selection.entities, sketches, sketch: this.sketch };
  }

  /** The hand-edited argument list, or undefined while it matches synthesis. */
  private selectorOverride(): string | undefined {
    const edited = this.panel.expression.value;
    const synthesized = this.panel.expression.synthesizedArgs;
    return edited !== '' && synthesized !== null && edited !== synthesized ? edited : undefined;
  }

  /** The chip rows in display order: the sketch picks, then the entity picks. */
  private chipRows(): ChipRow[] {
    return [
      ...this.sketches.map(sketch => ({ label: sketch.label, members: [], sketch })),
      ...this.selection.chipRows().map(row => ({ ...row, sketch: null })),
    ];
  }

  private removeChip(index: number): void {
    const row = this.chipRows()[index];
    if (!row) {
      return;
    }
    // A row toggles off exactly as a viewport click on its source would.
    if (row.sketch) {
      this.sketches = this.sketches.filter(pick => pick !== row.sketch);
    } else {
      this.selection.toggle(row.members[0]);
    }
    this.refresh();
  }

  /** Chip hover: light up just that row's sources until the pointer leaves. */
  private previewChip(index: number | null): void {
    if (!this.isPicking) {
      return;
    }
    const row = index === null ? null : this.chipRows()[index];
    if (!row) {
      this.highlight(this.selection.entities, this.allWireIds());
      return;
    }
    this.highlight(row.members, row.sketch ? row.sketch.wireIds : []);
  }

  private refresh(): void {
    const rows = this.chipRows();
    if (rows.length === 0 && this.session.active) {
      // An edit whose sources could not be seeded (and one whose picks were
      // all removed) shows the statement's own argument text as the keep
      // chip — it stands until something is picked.
      this.panel.setChips([keepChip(this.editArgsText)]);
      this.panel.setPrompt(this.spec.repickPrompt);
    } else {
      this.panel.setChips(rows.map(row => row.sketch
        ? sourceChip({ ...row.sketch.loc, label: row.label }, { badge: '●', removable: true })
        : { label: row.label, badge: '●', removable: true }));
      this.panel.setPrompt(null);
    }
    this.highlight(this.selection.entities, this.allWireIds());
    if (this.isEmpty && !this.session.active) {
      // Nothing to synthesize — fold the row now instead of after a debounce.
      this.runner.cancelPreview();
      this.panel.hideExpression();
      this.foreign.reset();
      this.syncForeignNotice();
      return;
    }
    this.runner.schedulePreview();
  }

  /** Mirror the cross-part gate into the panel's notice row. */
  private syncForeignNotice(): void {
    if (!this.foreign.present) {
      this.panel.setForeignNotice(null);
      return;
    }
    const confirmed = this.foreign.confirmed;
    this.panel.setForeignNotice({
      text: (confirmed ? this.foreign.summary() : this.foreign.message()) ?? '',
      confirmed,
    });
  }

  /** Every picked sketch's rendered wires, for the whole-set highlight. */
  private allWireIds(): string[] {
    return this.sketches.flatMap(pick => pick.wireIds);
  }

  private highlight(entities: SelectedEntity[], wireIds: string[] = []): void {
    if (entities.length > 0 || wireIds.length > 0) {
      this.viewer.highlightEntities(entities, wireIds);
    } else {
      this.viewer.clearHighlight();
    }
  }
}
