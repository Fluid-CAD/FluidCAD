import {
  applyProject, applyProjectEdit, fetchFeatureSources, ApplyFeatureEntity, FeatureEditTarget,
  ParsedFeatureStatement, SelectionGroupKind, SketchSourceRef,
} from '../api';
import { mergeUniqueEntities } from '../helpers/entities';
import { SceneObjectRender, SubSelection } from '../types';
import { SelectedEntity, Viewer } from '../viewer';
import { ApplyRunner } from './create-feature/apply-runner';
import { keepChip } from './create-feature/sketch-profiles';
import { SketchUISuspender } from './create-feature/sketch-suspender';
import { EditSession, EditSessionInfo } from './edit-session';
import { PickSelection } from './pick-selection';
import { ProjectionPanel } from './projection-panel';
import { SelectionContextMenu } from './selection-menu';

/**
 * The apply payload: the picks plus the sketch body receiving the call
 * (create mode) — an edit rewrites the statement at its own location instead
 * and carries no sketch.
 */
type ProjectRequest = { entities: ApplyFeatureEntity[]; sketch: SketchSourceRef | null };

/** A `project()` statement as the parse route reads it. */
type ParsedProject = Extract<ParsedFeatureStatement, { feature: 'project' }>;

/**
 * The Project sketch tool: flatten 3D edges and faces onto the plane of the
 * sketch being edited. Arming it leaves sketch editing (the camera unlocks
 * from the sketch normal and clicks reach the solids again), then every click
 * toggles an edge or a face into the pick set. Right-click opens the shared
 * multi-select menu — tangent chain, classified bucket, same-type and equal
 * edges — the same filtering the modify tools offer. The selection is explained by
 * the same synthesis the modify tools use — the dialog's expression row shows
 * the winning `project(…)` arguments and its verified alternatives, editable
 * in place. Apply writes the statement into the sketch's own body; Cancel
 * touches no code and hands the viewport back to the sketch.
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
  private readonly selectionMenu: SelectionContextMenu;
  private readonly runner: ApplyRunner<ProjectRequest>;
  /** The sketch receiving the projection, or null while disarmed. */
  private sketch: SketchSourceRef | null = null;

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
          const repicked = this.picksDirty() && request.entities.length > 0;
          return applyProjectEdit(editTarget, {
            expectedStatement: this.session.expectedStatement,
            before: this.session.boundary ?? undefined,
            entities: repicked ? request.entities : undefined,
            chains: repicked ? this.selection.apiChains() : undefined,
            selectorOverride: this.selectorOverride(),
            ...extras,
          });
        }
        return applyProject(request.entities, request.sketch!, {
          chains: this.selection.apiChains(),
          selectorOverride: this.selectorOverride(),
          ...extras,
        });
      },
      onApplied: () => {
        // The rewrite strips the double-click's breakpoint atomically with
        // the edit — the exit below must not clear it again (see exit).
        this.editApplied = true;
        this.onDone?.({ resume: 'lazy' });
      },
      failMessage: () => 'Could not apply the projection.',
      onPreviewSuccess: (result) => {
        this.panel.setMessage(null);
        // An edit that re-picked nothing synthesizes no args — the
        // statement's own source list stands, and the row keeps showing it.
        this.panel.showExpression(
          result.args ?? (this.session.active ? this.editArgsText : ''),
          result.alternatives ?? [],
        );
      },
    });
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
  enter(sketch: SketchSourceRef): void {
    if (this.isPicking) {
      return;
    }
    this.sketch = sketch;
    this.selection.clear();
    this.sketchUI.suspend();
    // Both kinds project, and sketch wires stay out of it — the sources are
    // the solids around the sketch, not the sketch's own geometry.
    this.viewer.pickFilter = 'all';
    this.viewer.pickSketchWires = false;
    this.viewer.clearHighlight();
    this.panel.show();
    this.onVisibilityChange?.(true);
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
    // The session owns the view: free 3D camera over the rolled-back scene.
    this.sketchUI.suspend();
    this.session.begin({ ...info, target });
    this.viewer.pickFilter = 'all';
    this.viewer.pickSketchWires = false;
    this.viewer.clearHighlight();
    this.panel.show();
    this.panel.setTitle('Edit projection');
    this.panel.showExpression(parsed.argsText, []);
    this.refresh();
    void this.loadEditSources();
    this.onVisibilityChange?.(true);
  }

  /**
   * Seed the pick set with the statement's current sources, resolved by the
   * server onto the pre-statement solids — the highlighted, removable chips
   * the dialog opens with. Unresolvable sources (clones, exotic selectors)
   * leave the set empty and the keep chip standing — new picks then REPLACE
   * the statement's args. A re-picked (dirty) selection is never clobbered
   * by a re-seed.
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
    if (result.ok && result.feature === 'projection' && result.selection.kind === 'entities') {
      this.selection.entities = result.selection.entities.map(e => ({ shapeId: e.shapeId, sub: e.sub }));
      this.selection.chains = [];
      this.seedSignature = this.selection.signature();
    } else {
      this.selection.clear();
      this.seedSignature = null;
    }
    this.refresh();
  }

  /**
   * True when the selection no longer matches the seeded one — the apply
   * then sends the picks for synthesis instead of keeping the args verbatim.
   */
  private picksDirty(): boolean {
    if (!this.session.active) {
      return false;
    }
    if (this.seedSignature === null) {
      return this.selection.entities.length > 0;
    }
    return this.selection.signature() !== this.seedSignature || this.selection.chains.length > 0;
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
    this.selectionMenu.hide();
    this.runner.cancelPreview();
    this.panel.hide();
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
    if (!this.isPicking || this.selection.isEmpty) {
      return;
    }
    this.selection.clear();
    this.selectionMenu.hide();
    this.viewer.clearHighlight();
    this.panel.setMessage('The code changed — the picked geometry was reset.');
    this.refresh();
  }

  /** A viewport click while armed: the pick toggles into the source set. */
  handleClick(shapeId: string | null, sub: SubSelection): void {
    if (!this.isPicking || !shapeId || !sub || (sub.type !== 'edge' && sub.type !== 'face')) {
      return;
    }
    this.panel.setMessage(null);
    this.selection.toggle({ shapeId, sub });
    this.refresh();
  }

  /** Right-click on an edge/face: the multi-select menu for that pick. */
  handleContextMenu(shapeId: string | null, sub: SubSelection, clientX: number, clientY: number): void {
    if (!this.isPicking) {
      return;
    }
    this.selectionMenu.hide();
    if (!shapeId || !sub || (sub.type !== 'edge' && sub.type !== 'face')) {
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
    this.highlight(members ? mergeUniqueEntities(this.selection.entities, members) : this.selection.entities);
  }

  /** The request for the current pick set, or the message blocking it. */
  private buildRequest(): ProjectRequest | { error: string } {
    if (this.session.active) {
      // An edit with no re-picks is complete — the statement's own source
      // arguments stand (or the edited expression row replaces them).
      return { entities: this.selection.entities, sketch: null };
    }
    if (!this.sketch) {
      return { error: 'No sketch to project into.' };
    }
    if (this.selection.isEmpty) {
      return { error: 'Pick the edges or faces to project.' };
    }
    return { entities: this.selection.entities, sketch: this.sketch };
  }

  /** The hand-edited argument list, or undefined while it matches synthesis. */
  private selectorOverride(): string | undefined {
    const edited = this.panel.expression.value;
    const synthesized = this.panel.expression.synthesizedArgs;
    return edited !== '' && synthesized !== null && edited !== synthesized ? edited : undefined;
  }

  private removeChip(index: number): void {
    const row = this.selection.chipRows()[index];
    if (!row) {
      return;
    }
    // A row toggles off exactly as a viewport click on its entity would.
    this.selection.toggle(row.members[0]);
    this.refresh();
  }

  /** Chip hover: light up just that row's entities until the pointer leaves. */
  private previewChip(index: number | null): void {
    if (!this.isPicking) {
      return;
    }
    const row = index === null ? null : this.selection.chipRows()[index];
    this.highlight(row ? row.members : this.selection.entities);
  }

  private refresh(): void {
    const rows = this.selection.chipRows();
    if (rows.length === 0 && this.session.active) {
      // An edit whose sources could not be seeded (and one whose picks were
      // all removed) shows the statement's own argument text as the keep
      // chip — it stands until something is picked.
      this.panel.setChips([keepChip(this.editArgsText)]);
      this.panel.setPrompt('Pick edges or faces to re-source');
    } else {
      this.panel.setChips(rows.map(row => ({
        label: row.label,
        badge: '●',
        removable: true,
      })));
      this.panel.setPrompt(null);
    }
    this.highlight(this.selection.entities);
    if (this.selection.isEmpty && !this.session.active) {
      // Nothing to synthesize — fold the row now instead of after a debounce.
      this.runner.cancelPreview();
      this.panel.hideExpression();
      return;
    }
    this.runner.schedulePreview();
  }

  private highlight(entities: SelectedEntity[]): void {
    if (entities.length > 0) {
      this.viewer.highlightEntities(entities);
    } else {
      this.viewer.clearHighlight();
    }
  }
}
