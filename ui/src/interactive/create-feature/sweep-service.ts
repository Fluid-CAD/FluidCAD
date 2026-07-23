import {
  applySweep, applySweepEdit, fetchFeatureSources, expandBucket,
  FeatureEditTarget, ParsedFeatureStatement, SelectionGroupKind, SourceSlotRef, SweepApplyOptions,
} from '../../api';
import { mergeUniqueEntities } from '../../helpers/entities';
import { EditSession, EditSessionInfo } from '../edit-session';
import { PickSelection } from '../pick-selection';
import { SelectionContextMenu } from '../selection-menu';
import { SceneObjectRender, SubSelection } from '../../types';
import { SelectedEntity, Viewer } from '../../viewer';
import { Navbar } from '../../ui/navbar';
import { SweepPanel } from './sweep-panel';
import { FeatureButton } from './feature-button';
import { ApplyRunner } from './apply-runner';
import { SketchUISuspender } from './sketch-suspender';
import { OptionRelabeler, refreshScopeVariables } from './option-relabeler';
import {
  collectWireSources, labelWithSketchNames, optionsSignature, resolveWireByShapeId, resolveWireRow,
  SketchProfileOption, sketchWireShapeIds,
} from './sketch-profiles';

type SweepEditRequest = Parameters<typeof applySweepEdit>[1];

/**
 * The Sweep dialog on the create rails: a profile sketch swept along a path.
 * The profile slot takes sketches; the path slot takes any wire source — a
 * sketch or a helix (timeline or wire clicks into the armed slot); the path
 * alternatively takes edge picks, live in the 3D view the whole
 * time the dialog is armed — an edge click re-sources the path to picked
 * edges (listed as removable chips), plain clicks accumulate, right-click
 * offers the multi-select menu (tangent chain, classified bucket, occluded
 * picks), double-click expands the classified bucket, exactly like the
 * modify rails. Arming from inside a sketch suspends sketch editing (same
 * mechanism as sketch-on-face) so the camera is free and clicks pick edges.
 * Apply writes `sweep(<path>[, <profile>])` with `.thin()`/`.remove()`/
 * `.new()` chains — the re-render is the preview, editor undo the rollback.
 */
export class SweepFeatureService {
  private panel: SweepPanel;
  private button: FeatureButton;
  private armed = false;
  private available = false;
  private profiles: SketchProfileOption[] = [];
  private sceneObjects: SceneObjectRender[] = [];
  private hasSolid = false;
  private sceneSketchActive = false;
  private sketchUI: SketchUISuspender;
  /** Statement being edited in place (timeline double-click), or null. */
  private editTarget: FeatureEditTarget | null = null;
  /** View-state half of edit mode: pre-statement rollback + boundary. */
  private session = new EditSession();
  /** Current sources of the edited statement, for seeding and highlighting. */
  private sourceSlots: { profile: SourceSlotRef; path: SourceSlotRef } | null = null;
  /** The seeded path entities were already offered to edge picking once. */
  private pathSeedApplied = false;
  /** A full render arrived mid-session — picks died, sources re-fetch. */
  private editSceneStale = false;

  /** The picked path edges (chain-aware — a chain writes `.withTangents()`). */
  private picks = new PickSelection();
  /** The rendered path chip rows — chip index to pick members. */
  private pathChipRows: { label: string; members: SelectedEntity[] }[] = [];
  private selectionMenu: SelectionContextMenu;
  private runner: ApplyRunner<SweepApplyOptions | SweepEditRequest>;
  private relabeler: OptionRelabeler<SketchProfileOption[]>;

  constructor(
    container: HTMLElement,
    private viewer: Viewer,
    private navbar: Navbar,
    private hooks: {
      onEnter?: () => void;
      /** Armed or disarmed — lets the Sketch button owner re-check `isActive`. */
      onActiveChange?: () => void;
      onSuspendSketchUI?: () => void;
      onResumeSketchUI?: () => void;
    } = {},
  ) {
    const group = navbar.getGroup('create') ?? navbar.addGroup('create', { visible: false, immune: true });
    this.button = new FeatureButton(group, {
      icon: '/icons/sweep.png',
      label: 'Sweep',
      tip: 'Sweep a sketch along a path',
      ariaLabel: 'Sweep a sketch along a path',
    });
    this.button.onClick = () => {
      if (this.armed) {
        this.exit();
      } else {
        this.enter();
      }
    };
    this.sketchUI = new SketchUISuspender(viewer, hooks);

    this.panel = new SweepPanel(container);
    this.panel.onApply = () => void this.runner.apply();
    this.panel.onExit = () => this.exit();
    this.panel.onChange = () => {
      this.panel.setMessage(null);
      this.refreshHighlight();
      this.runner.schedulePreview();
    };
    this.panel.onPathModeChange = () => this.syncPathMode();
    this.panel.onRemovePathChip = (index) => this.removePathChip(index);
    this.panel.onPathChipHover = (index) => {
      // Hovering a chip shows just that chip's edges, so the row can be told
      // apart from its siblings; leaving restores the full selection.
      const members = index !== null ? this.pathChipRows[index]?.members : undefined;
      if (members) {
        this.viewer.highlightEntities(members);
      } else {
        this.refreshHighlight();
      }
    };

    // Right-click menu for path edge picks: multi-select groups + sibling
    // buckets ("Select other"). A path is one connected chain, so the
    // geometric same-type/equal groups (scattered edges) are not offered.
    this.selectionMenu = new SelectionContextMenu(container, 'fluidcad-sweep-pick-menu', {
      kinds: ['tangent', 'classified', 'sibling'],
      onSelectGroup: (kind, seed, members) => this.applyGroup(kind, seed, members),
      onPreview: (members) => {
        if (this.isEdgePicking) {
          this.refreshHighlight(members ?? []);
        }
      },
      boundary: () => this.session.boundary ?? undefined,
    });

    this.runner = new ApplyRunner({
      panel: this.panel,
      isArmed: () => this.armed,
      build: () => this.editTarget ? this.buildEditRequest() : this.buildRequest(),
      send: (request, extras) => this.editTarget
        ? applySweepEdit(this.editTarget, { ...(request as SweepEditRequest), ...extras })
        : applySweep({ ...(request as SweepApplyOptions), ...extras }),
      onApplied: () => this.exit(this.editTarget ? { editEnd: 'apply' } : { resume: 'lazy' }),
      failMessage: () => this.editTarget ? 'Could not apply the edit.' : 'Could not apply the sweep.',
    });
    this.relabeler = new OptionRelabeler({
      sign: optionsSignature,
      load: labelWithSketchNames,
      isArmed: () => this.armed,
      apply: (profiles) => {
        this.profiles = profiles;
        this.panel.setOptions(profiles, this.editTarget ? true : this.hasSolid);
      },
    });
  }

  get isActive(): boolean {
    return this.armed;
  }

  /** An edit session is open (the viewport shows the pre-statement rollback). */
  get isEditing(): boolean {
    return this.editTarget !== null;
  }

  /**
   * Edge picks are live the whole time the dialog is armed, in both modes —
   * an edge click re-sources the path to picked edges. The viewer routes
   * edge clicks, double-clicks and right-clicks here.
   */
  get isEdgePicking(): boolean {
    return this.armed;
  }

  /** True while armed edge picking has suspended sketch editing. */
  get sketchUISuspended(): boolean {
    return this.sketchUI.suspended;
  }

  /**
   * Every render lands here. An open edit session owns the view: it keeps
   * the viewport rolled back to just before the edited statement, and at
   * that boundary the slot options rebuild from the pre-statement scene —
   * exactly the sketches and edges the sweep's arguments can reference.
   */
  handleSceneRendered(sceneObjects: SceneObjectRender[], stop: number, isRollback: boolean): void {
    const state = this.session.onSceneRendered(sceneObjects, stop, isRollback);
    if (state === 'inactive') {
      this.update(isRollback ? [] : sceneObjects);
      return;
    }
    if (!this.armed) {
      this.session.end('gone');
      return;
    }
    if (state === 'gone') {
      this.exit({ editEnd: 'gone' });
      return;
    }
    if (state === 'waiting') {
      if (!isRollback) {
        this.editSceneStale = true;
      }
      return;
    }
    // At the boundary: rebuild options from the pre-statement scene.
    this.sceneObjects = sceneObjects;
    this.profiles = collectWireSources(sceneObjects);
    this.hideContextMenu();
    if (this.editSceneStale) {
      this.editSceneStale = false;
      if (this.picks.entities.length > 0) {
        this.picks.clear();
        this.pathSeedApplied = false;
        this.panel.setMessage('The code changed — the re-picked path was reset.');
      }
      this.sourceSlots = null;
    }
    if (!this.sourceSlots) {
      void this.loadEditSources();
    }
    this.panel.setOptions(this.profiles, true);
    void this.relabeler.refresh(this.profiles);
    this.refreshPathChips();
    this.refreshHighlight();
    this.runner.schedulePreview();
  }

  update(sceneObjects: SceneObjectRender[]): void {
    this.sceneObjects = sceneObjects;
    this.profiles = collectWireSources(sceneObjects);
    this.hasSolid = sceneObjects.some(o =>
      o.sceneShapes?.some(s => s.shapeType === 'solid' && !s.isMetaShape && !s.isGuide));
    this.sceneSketchActive = this.profiles[0]?.kind === 'active';
    // Offered whenever the scene has anything to work from — like Loft. The
    // dialog itself explains what's missing (a profile sketch, a path).
    this.available = this.hasSolid || this.profiles.length > 0;
    this.navbar.setGroupVisible('create', this.available, 'sweep');
    this.syncButton();
    this.hideContextMenu();
    if (!this.armed) {
      return;
    }
    if (!this.available) {
      this.exit({ resume: 'lazy' });
      return;
    }
    // A render can put a sketch back in front (live editing) — the armed
    // dialog keeps the free 3D view.
    if (this.sceneSketchActive) {
      this.sketchUI.suspend();
    }
    this.viewer.pickSketchWires = true;
    this.viewer.pickFilter = 'edge';
    // Shape ids changed with the render; the viewer already cleared highlights.
    this.picks.clear();
    this.panel.setOptions(this.profiles, this.hasSolid);
    void this.relabeler.refresh(this.profiles);
    this.refreshPathChips();
    this.refreshHighlight();
    this.runner.schedulePreview();
  }

  /**
   * Open the dialog over an existing sweep statement (timeline
   * double-click). The session rolls the viewport back to just before the
   * statement; both slots start on "Current: …" entries that keep the
   * statement's own expressions, and re-sourcing is live — other sketches
   * via the dropdowns/timeline/wire clicks, path edges by picking in 3D
   * (seeded with the statement's current edges when they resolve). Apply
   * rewrites the statement in place.
   */
  enterEdit(
    target: FeatureEditTarget,
    parsed: Extract<ParsedFeatureStatement, { feature: 'sweep' }>,
    info: Omit<EditSessionInfo, 'target'>,
  ): void {
    if (this.armed) {
      this.exit();
    }
    this.hooks.onEnter?.();
    this.armed = true;
    this.editTarget = target;
    this.picks.clear();
    this.pathChipRows = [];
    this.sourceSlots = null;
    this.pathSeedApplied = false;
    this.editSceneStale = false;
    this.syncButton();
    this.sketchUI.suspend();
    this.viewer.pickSketchWires = true;
    this.viewer.pickFilter = 'edge';
    this.session.begin({ ...info, target });
    void this.loadEditSources();
    void this.refreshScopeVariables();
    this.panel.showEdit({
      op: parsed.op,
      thin: parsed.thin,
      pathLabel: parsed.pathText,
      profileLabel: parsed.profileText,
    });
    this.runner.schedulePreview();
  }

  /**
   * Current sources of the edited statement: the profile/path sketches (for
   * highlighting) and the path's resolved edges — the seed offered when edge
   * picking arms, so re-picking starts from the statement's own selection.
   */
  /**
   * Push the variables in scope at the statement (edit mode) or at the end
   * of the file (create mode) to the dialog's expression fields. A response
   * landing after the dialog closed or re-targeted is dropped.
   */
  private async refreshScopeVariables(): Promise<void> {
    const line = this.editTarget?.line ?? null;
    await refreshScopeVariables(line, this.panel,
      () => this.armed && (this.editTarget?.line ?? null) === line);
  }

  private async loadEditSources(): Promise<void> {
    const boundary = this.session.boundary;
    if (!boundary) {
      return;
    }
    const result = await fetchFeatureSources(boundary);
    if (!this.editTarget || this.session.boundary?.index !== boundary.index) {
      return;
    }
    this.sourceSlots = result.ok && result.feature === 'sweep'
      ? { profile: result.profile, path: result.path }
      : { profile: { kind: 'opaque' }, path: { kind: 'opaque' } };
    this.refreshHighlight();
  }

  enter(): void {
    if (this.armed) {
      return;
    }
    this.session.end('continue');
    this.hooks.onEnter?.();
    this.armed = true;
    // Composing a sweep means looking at the whole scene, not down the
    // active sketch plane — leave sketch editing right away (resumed on
    // cancel; an apply's re-render takes over).
    if (this.sceneSketchActive) {
      this.sketchUI.suspend();
    }
    this.viewer.pickSketchWires = true;
    this.viewer.pickFilter = 'edge';
    this.syncButton();
    void this.refreshScopeVariables();
    this.panel.show(this.profiles, this.hasSolid);
    void this.relabeler.refresh(this.profiles);
    this.refreshPathChips();
    this.refreshHighlight();
    this.runner.schedulePreview();
  }

  /**
   * `resume: 'lazy'` re-enables sketch editing without forcing the mode
   * transition — for apply-success and scene-driven exits. User cancels
   * default to `'immediate'`; ending an edit session always resumes lazily
   * (a render follows every session end).
   */
  exit(opts: { resume?: 'immediate' | 'lazy'; editEnd?: 'apply' | 'cancel' | 'continue' | 'gone' } = {}): void {
    if (!this.armed) {
      return;
    }
    const hadSession = this.session.active;
    this.session.end(opts.editEnd ?? 'cancel');
    if (hadSession) {
      opts = { ...opts, resume: 'lazy' };
    }
    this.armed = false;
    this.editTarget = null;
    this.sourceSlots = null;
    this.pathSeedApplied = false;
    this.editSceneStale = false;
    this.syncButton();
    this.runner.cancelPreview();
    this.picks.clear();
    this.pathChipRows = [];
    this.viewer.clearHighlight();
    this.viewer.pickFilter = 'all';
    this.viewer.pickSketchWires = false;
    this.hideContextMenu();
    this.panel.hide();
    this.sketchUI.resume((opts.resume ?? 'immediate') === 'immediate');
  }

  /**
   * Routes viewer edge clicks while the dialog is armed: the first pick
   * re-sources the path to edges (in edit mode seeded with the statement's
   * own edges, so re-picking is incremental), further plain clicks
   * accumulate, clicking a selected edge deselects it (a chain member
   * deselects its whole chain), empty-space clicks keep the selection.
   */
  handleClick(shapeId: string | null, sub: SubSelection): void {
    if (!this.isEdgePicking || !shapeId || !sub || sub.type !== 'edge') {
      return;
    }
    this.hideContextMenu();
    // A helix's wire renders as a regular edge — clicking it selects the
    // helix as the named path source (`sweep(spring)`), not a raw edge pick.
    // A helix not among the options (consumed) falls through to edge picking.
    const owner = resolveWireByShapeId(shapeId, this.sceneObjects);
    if (owner?.type === 'helix' && owner.sourceLocation) {
      const loc = owner.sourceLocation;
      if (this.panel.selectSketch('path', loc.filePath, loc.line)) {
        this.panel.setMessage(null);
        this.refreshHighlight();
        this.runner.schedulePreview();
        return;
      }
    }
    this.panel.setMessage(null);
    this.ensureEdgesSeed();
    this.toggleEntity({ shapeId, sub });
  }

  /**
   * The first edge gesture of an edit session starts from the statement's
   * own path edges (when they resolve) instead of from scratch.
   */
  private ensureEdgesSeed(): void {
    if (!this.editTarget || this.pathSeedApplied) {
      return;
    }
    this.pathSeedApplied = true;
    if (this.picks.entities.length === 0 && this.sourceSlots?.path.kind === 'entities') {
      this.picks.entities = this.sourceSlots.path.entities.map(e => ({ shapeId: e.shapeId, sub: e.sub }));
    }
  }

  /** Toggle a plain pick; a chain member toggles its whole chain off. */
  private toggleEntity(entity: SelectedEntity): void {
    this.picks.toggle(entity);
    // Chips first: an emptied edit selection collapses back to the kept
    // path, and the highlight must paint that state.
    this.refreshPathChips();
    this.refreshHighlight();
    this.runner.schedulePreview();
  }

  /** A path chip's ✕: remove that pick (a chain chip removes its chain). */
  private removePathChip(index: number): void {
    const row = this.pathChipRows[index];
    if (!row) {
      return;
    }
    this.panel.setMessage(null);
    this.toggleEntity(row.members[0]);
  }

  /** Double-click: expand the pick to its whole classified bucket. */
  async handleDoubleClick(shapeId: string | null, sub: SubSelection): Promise<void> {
    if (!this.isEdgePicking || !shapeId || !sub || sub.type !== 'edge') {
      return;
    }
    this.hideContextMenu();
    const result = await expandBucket({ shapeId, sub }, this.session.boundary ?? undefined);
    if (!this.isEdgePicking) {
      return;
    }
    if ('error' in result) {
      this.panel.setMessage(result.error);
      return;
    }
    this.ensureEdgesSeed();
    this.mergeEntities(result.members.map(m => ({ shapeId: m.shapeId, sub: m.sub })));
  }

  /** Merge group members into the path selection as plain picks. */
  private mergeEntities(members: SelectedEntity[]): void {
    if (!this.picks.merge(members.filter(m => m.sub.type === 'edge'))) {
      return;
    }
    this.refreshPathChips();
    this.refreshHighlight();
    this.runner.schedulePreview();
  }

  /** Right-click on an edge: the multi-select menu for that path pick. */
  handleContextMenu(shapeId: string | null, sub: SubSelection, clientX: number, clientY: number): void {
    if (!this.isEdgePicking) {
      return;
    }
    this.hideContextMenu();
    if (!shapeId || !sub || sub.type !== 'edge') {
      return;
    }
    // The hover tint would otherwise be stashed as an "original" color by the
    // preview highlight and stick around after the preview restores it.
    this.viewer.clearHover();
    void this.selectionMenu.open({ shapeId, sub }, clientX, clientY);
  }

  /** A multi-select menu group was clicked. */
  private applyGroup(kind: SelectionGroupKind, seed: SelectedEntity, members: SelectedEntity[]): void {
    if (!this.isEdgePicking) {
      return;
    }
    this.panel.setMessage(null);
    this.ensureEdgesSeed();
    if (kind === 'tangent') {
      this.addChain(seed, members);
    } else {
      this.mergeEntities(members);
    }
  }

  /** Record a tangent chain: it owns its members, replacing overlapping picks. */
  private addChain(seed: SelectedEntity, members: SelectedEntity[]): void {
    this.picks.addChain(seed, members);
    this.refreshPathChips();
    this.refreshHighlight();
    this.runner.schedulePreview();
  }

  /**
   * A timeline row was clicked while the dialog is armed: the sketch lands in
   * the focused slot. Consumed on any sketch row so the default rollback
   * can't close the dialog mid-flow.
   */
  handleTimelinePick(obj: SceneObjectRender): boolean {
    if (!this.armed) {
      return false;
    }
    const sketch = resolveWireRow(obj, this.sceneObjects);
    if (!sketch?.sourceLocation) {
      return false;
    }
    this.pickSketch(sketch);
    return true;
  }

  /**
   * A sketch wire was clicked in the 3D view: same as a timeline pick — the
   * sketch lands in the focused slot.
   */
  handleSketchPick(shapeId: string): boolean {
    if (!this.armed) {
      return false;
    }
    const sketch = resolveWireByShapeId(shapeId, this.sceneObjects);
    if (!sketch?.sourceLocation) {
      return false;
    }
    this.pickSketch(sketch);
    return true;
  }

  private pickSketch(sketch: SceneObjectRender): void {
    const loc = sketch.sourceLocation!;
    // A helix is a bare wire: it can only be the path, never the planar
    // profile. Route it to the path slot regardless of which slot is armed.
    const slot = sketch.type === 'helix' ? 'path' : this.panel.armedSlot;
    if (!this.panel.selectSketch(slot, loc.filePath, loc.line)) {
      this.panel.setMessage(sketch.type === 'helix'
        ? 'That helix was already consumed — only helixes still rendered in the scene can be used.'
        : 'That sketch was already consumed — only sketches still rendered in the scene can be used.');
      return;
    }
    // A path pick already synced the mode via onPathModeChange.
    this.panel.setMessage(null);
    this.refreshHighlight();
    this.runner.schedulePreview();
  }

  /** The request for the current form state, or the message blocking it. */
  private buildRequest(): SweepApplyOptions | { error: string } {
    const values = this.panel.values();
    if ('error' in values) {
      return values;
    }
    const profile = this.panel.selectedProfile();
    if (!profile) {
      return { error: 'No profile sketch to sweep.' };
    }
    if (!profile.hasGeometry) {
      return { error: 'Draw a profile in the sketch first.' };
    }
    const pathSel = this.panel.pathSelection();
    if (!pathSel) {
      return { error: 'Choose a path for the sweep.' };
    }
    let path: SweepApplyOptions['path'];
    if (pathSel.kind === 'sketch') {
      const option = pathSel.option;
      if (option.filePath === profile.filePath && option.line === profile.line) {
        return { error: 'The profile and path must be different sketches.' };
      }
      if (!option.hasGeometry) {
        return { error: 'The path sketch has nothing drawn.' };
      }
      path = { kind: 'sketch', filePath: option.filePath, line: option.line, column: option.column };
    } else {
      if (this.picks.isEmpty) {
        return { error: 'Pick the path edges first.' };
      }
      path = {
        kind: 'edges',
        entities: this.picks.entities,
        chains: this.picks.apiChains(),
      };
    }
    return {
      op: values.op,
      thin: values.thin,
      profile: {
        mode: profile.kind === 'active' ? 'active' : 'bound',
        filePath: profile.filePath,
        line: profile.line,
        column: profile.column,
      },
      path,
    };
  }

  /**
   * The edit-mode apply payload. Slots still on their "Current: …" entry are
   * omitted, so the transform preserves the statement's expressions byte for
   * byte; a re-sourced path/profile ships as a sketch ref or edge picks (the
   * latter synthesized against the session boundary).
   */
  private buildEditRequest(): Parameters<typeof applySweepEdit>[1] | { error: string } {
    const values = this.panel.values();
    if ('error' in values) {
      return values;
    }
    const pathSel = this.panel.pathSelection();
    const profileSel = this.panel.profileSelection();

    let path: Parameters<typeof applySweepEdit>[1]['path'];
    if (pathSel?.kind === 'sketch') {
      if (!pathSel.option.hasGeometry) {
        return { error: 'The path sketch has nothing drawn.' };
      }
      path = {
        kind: 'sketch',
        filePath: pathSel.option.filePath,
        line: pathSel.option.line,
        column: pathSel.option.column,
      };
    } else if (pathSel?.kind === 'edges') {
      if (this.picks.isEmpty) {
        return { error: 'Pick the path edges first.' };
      }
      path = {
        kind: 'edges',
        entities: this.picks.entities,
        chains: this.picks.apiChains(),
      };
    }
    let profile: Parameters<typeof applySweepEdit>[1]['profile'];
    if (profileSel?.kind === 'sketch') {
      if (!profileSel.option.hasGeometry) {
        return { error: `Nothing is drawn in "${profileSel.option.label}" yet.` };
      }
      profile = {
        kind: 'sketch',
        filePath: profileSel.option.filePath,
        line: profileSel.option.line,
        column: profileSel.option.column,
      };
    }
    return {
      op: values.op,
      thin: values.thin,
      path,
      profile,
      expectedStatement: this.session.expectedStatement,
      before: path?.kind === 'edges' ? this.session.boundary ?? undefined : undefined,
    };
  }

  // -------------------------------------------------------------------------
  // Path-mode sync + sketch-editing suspension
  // -------------------------------------------------------------------------

  /**
   * The path slot left edge mode (a sketch pick, a ✕ back to the kept
   * expression): drop the edge picks and re-offer the edit seed on the next
   * edge gesture.
   */
  private syncPathMode(): void {
    if (this.panel.pathSelection()?.kind === 'edges') {
      return;
    }
    this.picks.clear();
    this.pathChipRows = [];
    this.pathSeedApplied = false;
    this.hideContextMenu();
    this.refreshHighlight();
  }

  /**
   * Repaint the viewport selection: the picked path edges plus the wires of
   * the sketches chosen in the slots — the dialog's inputs stay visible in
   * 3D. `previewMembers` (a hovered menu item) show on top of the selection.
   */
  private refreshHighlight(previewMembers: SelectedEntity[] = []): void {
    if (!this.armed) {
      return;
    }
    const sketches: SketchProfileOption[] = [];
    const keepEntities: SelectedEntity[] = [];
    const profile = this.panel.selectedProfile();
    if (profile) {
      sketches.push(profile);
    }
    const path = this.panel.pathSelection();
    if (path?.kind === 'sketch') {
      sketches.push(path.option);
    }
    // Slots kept on the statement's own expressions light up through the
    // resolved current sources at the rolled-back view.
    const keepSlot = (slot: SourceSlotRef | undefined): void => {
      if (slot?.kind === 'entities') {
        keepEntities.push(...slot.entities.map(e => ({ shapeId: e.shapeId, sub: e.sub })));
      } else if (slot?.kind === 'sketch') {
        const option = this.profiles.find(o => o.filePath === slot.filePath && o.line === slot.line);
        if (option) {
          sketches.push(option);
        }
      }
    };
    if (this.panel.profileSelection()?.kind === 'keep') {
      keepSlot(this.sourceSlots?.profile);
    }
    if (path?.kind === 'keep') {
      keepSlot(this.sourceSlots?.path);
    }
    const wireIds = sketches.flatMap(option => sketchWireShapeIds(option, this.sceneObjects));
    const shown = mergeUniqueEntities(mergeUniqueEntities(this.picks.entities, keepEntities), previewMembers);
    if (shown.length > 0 || wireIds.length > 0) {
      this.viewer.highlightEntities(shown, wireIds);
    } else {
      this.viewer.clearHighlight();
    }
  }

  /**
   * Reflect the pick set into the path slot's chips. An edit selection
   * emptied out by ✕ clicks reverts to the statement's own path — the kept
   * expression is what Apply would preserve, and it stays reachable.
   */
  private refreshPathChips(): void {
    this.pathChipRows = this.picks.chipRows();
    if (this.pathChipRows.length === 0 && this.editTarget
      && this.panel.pathSelection()?.kind === 'edges') {
      this.pathSeedApplied = false;
      this.panel.setPathKeep();
      return;
    }
    this.panel.setPathEdgeChips(this.pathChipRows.map((row, index) => ({
      label: row.label,
      badge: String(index + 1),
      removable: true,
    })));
  }

  private hideContextMenu(): void {
    this.selectionMenu.hide();
  }

  private syncButton(): void {
    this.button.setActive(this.armed);
    this.button.setVisible(this.available);
    // Every armed flip lands here — the Sketch button disables while a
    // create dialog is up.
    this.hooks.onActiveChange?.();
  }
}
