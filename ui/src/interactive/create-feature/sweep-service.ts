import {
  applySweep, applySweepEdit, fetchFeatureSources, getScopeVariables, ApplyFeatureChain,
  ApplyFeatureResponse, expandBucket, FeatureEditTarget, ParsedFeatureStatement, SelectionGroupKind,
  SourceSlotRef, SweepApplyOptions,
} from '../../api';
import { entityKey, mergeUniqueEntities, sameEntity, selectionChipRows } from '../../helpers/entities';
import { EditSession, EditSessionInfo } from '../edit-session';
import { SelectionContextMenu } from '../selection-menu';
import { SceneObjectRender, SubSelection } from '../../types';
import { SelectedEntity, Viewer } from '../../viewer';
import { Navbar } from '../../ui/navbar';
import { ICON_IMG_FALLBACK } from '../../ui/object-icons';
import { SweepPanel } from './sweep-panel';
import {
  collectSketchProfiles, labelWithSketchNames, optionsSignature, resolveSketchByShapeId, resolveSketchRow,
  SketchProfileOption, sketchWireShapeIds,
} from './sketch-profiles';

const BTN_BASE = 'btn btn-ghost btn-sm h-auto flex-col gap-0.5 px-2 py-1 text-base-content/60';
const BTN_ACTIVE = 'btn btn-soft btn-primary btn-sm h-auto flex-col gap-0.5 px-2 py-1';
/** Small muted caption under the toolbar icon. */
const BTN_LABEL = 'text-[10px] leading-none text-base-content/50';

const PREVIEW_DEBOUNCE_MS = 250;

/**
 * The Sweep dialog on the create rails: a profile sketch swept along a path.
 * Both slots take sketches (timeline or wire clicks into the armed slot);
 * the path alternatively takes edge picks, live in the 3D view the whole
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
  private button: HTMLButtonElement;
  /** daisyUI tooltip wrapper around {@link button}; hides with the button so no phantom toolbar gap. */
  private buttonWrap: HTMLElement;
  private armed = false;
  private available = false;
  private applying = false;
  private profiles: SketchProfileOption[] = [];
  private sceneObjects: SceneObjectRender[] = [];
  private hasSolid = false;
  private sceneSketchActive = false;
  private suspendedSketchUI = false;
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

  private entities: SelectedEntity[] = [];
  private chains: { seed: SelectedEntity; members: SelectedEntity[] }[] = [];
  /** The rendered path chip rows — chip index to pick members. */
  private pathChipRows: { label: string; members: SelectedEntity[] }[] = [];
  private selectionMenu: SelectionContextMenu;
  private labelSignature = '';

  private previewTimer: number | null = null;
  private previewAbort: AbortController | null = null;
  private previewSeq = 0;

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
    this.button = document.createElement('button');
    this.button.className = BTN_BASE;
    this.button.setAttribute('aria-label', 'Sweep a sketch along a path');
    this.button.innerHTML = `<img src="/icons/sweep.png" ${ICON_IMG_FALLBACK} class="w-8 h-8 object-contain" alt="" /><span class="${BTN_LABEL}">Sweep</span>`;
    this.button.addEventListener('click', () => {
      if (this.armed) {
        this.exit();
      } else {
        this.enter();
      }
    });
    this.buttonWrap = document.createElement('span');
    this.buttonWrap.className = 'tooltip tooltip-bottom';
    this.buttonWrap.dataset.tip = 'Sweep a sketch along a path';
    this.buttonWrap.appendChild(this.button);
    group.appendChild(this.buttonWrap);

    this.panel = new SweepPanel(container);
    this.panel.onApply = () => this.apply();
    this.panel.onExit = () => this.exit();
    this.panel.onChange = () => {
      this.panel.setMessage(null);
      this.refreshHighlight();
      this.schedulePreview();
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
    return this.suspendedSketchUI;
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
    this.profiles = collectSketchProfiles(sceneObjects);
    this.hideContextMenu();
    if (this.editSceneStale) {
      this.editSceneStale = false;
      if (this.entities.length > 0) {
        this.entities = [];
        this.chains = [];
        this.pathSeedApplied = false;
        this.panel.setMessage('The code changed — the re-picked path was reset.');
      }
      this.sourceSlots = null;
    }
    if (!this.sourceSlots) {
      void this.loadEditSources();
    }
    this.panel.setOptions(this.profiles, true);
    this.refreshSketchLabels();
    this.refreshPathChips();
    this.refreshHighlight();
    this.schedulePreview();
  }

  update(sceneObjects: SceneObjectRender[]): void {
    this.sceneObjects = sceneObjects;
    this.profiles = collectSketchProfiles(sceneObjects);
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
      this.suspendSketchUI();
    }
    this.viewer.pickSketchWires = true;
    this.viewer.pickFilter = 'edge';
    // Shape ids changed with the render; the viewer already cleared highlights.
    this.entities = [];
    this.chains = [];
    this.panel.setOptions(this.profiles, this.hasSolid);
    this.refreshSketchLabels();
    this.refreshPathChips();
    this.refreshHighlight();
    this.schedulePreview();
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
    this.entities = [];
    this.chains = [];
    this.pathChipRows = [];
    this.sourceSlots = null;
    this.pathSeedApplied = false;
    this.editSceneStale = false;
    this.syncButton();
    this.suspendSketchUI();
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
    this.schedulePreview();
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
    const variables = await getScopeVariables(line);
    if (this.armed && (this.editTarget?.line ?? null) === line) {
      this.panel.setScopeVariables(variables);
    }
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
      this.suspendSketchUI();
    }
    this.viewer.pickSketchWires = true;
    this.viewer.pickFilter = 'edge';
    this.syncButton();
    void this.refreshScopeVariables();
    this.panel.show(this.profiles, this.hasSolid);
    this.refreshSketchLabels();
    this.refreshPathChips();
    this.refreshHighlight();
    this.schedulePreview();
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
    this.cancelPreview();
    this.entities = [];
    this.chains = [];
    this.pathChipRows = [];
    this.viewer.clearHighlight();
    this.viewer.pickFilter = 'all';
    this.viewer.pickSketchWires = false;
    this.hideContextMenu();
    this.panel.hide();
    this.resumeSketchUI((opts.resume ?? 'immediate') === 'immediate');
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
    if (this.entities.length === 0 && this.sourceSlots?.path.kind === 'entities') {
      this.entities = this.sourceSlots.path.entities.map(e => ({ shapeId: e.shapeId, sub: e.sub }));
    }
  }

  /** Toggle a plain pick; a chain member toggles its whole chain off. */
  private toggleEntity(entity: SelectedEntity): void {
    const chain = this.chains.find(c => c.members.some(m => sameEntity(m, entity)));
    if (chain) {
      const memberKeys = new Set(chain.members.map(entityKey));
      this.entities = this.entities.filter(e => !memberKeys.has(entityKey(e)));
      this.chains = this.chains.filter(c => c !== chain);
    } else {
      const existing = this.entities.findIndex(e => sameEntity(e, entity));
      if (existing >= 0) {
        this.entities = this.entities.filter((_, i) => i !== existing);
      } else {
        this.entities = [...this.entities, entity];
      }
    }
    // Chips first: an emptied edit selection collapses back to the kept
    // path, and the highlight must paint that state.
    this.refreshPathChips();
    this.refreshHighlight();
    this.schedulePreview();
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
    const merged = mergeUniqueEntities(this.entities, members.filter(m => m.sub.type === 'edge'));
    if (merged.length === this.entities.length) {
      return;
    }
    this.entities = merged;
    this.refreshPathChips();
    this.refreshHighlight();
    this.schedulePreview();
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
    const memberKeys = new Set(members.map(entityKey));
    this.chains = this.chains.filter(c => !c.members.some(m => memberKeys.has(entityKey(m))));
    this.entities = [
      ...this.entities.filter(e => !memberKeys.has(entityKey(e))),
      ...members,
    ];
    this.chains.push({ seed, members });
    this.refreshPathChips();
    this.refreshHighlight();
    this.schedulePreview();
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
    const sketch = resolveSketchRow(obj, this.sceneObjects);
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
    const sketch = resolveSketchByShapeId(shapeId, this.sceneObjects);
    if (!sketch?.sourceLocation) {
      return false;
    }
    this.pickSketch(sketch);
    return true;
  }

  private pickSketch(sketch: SceneObjectRender): void {
    const loc = sketch.sourceLocation!;
    if (!this.panel.selectSketch(this.panel.armedSlot, loc.filePath, loc.line)) {
      this.panel.setMessage('That sketch was already consumed — only sketches still rendered in the scene can be used.');
      return;
    }
    // A path pick already synced the mode via onPathModeChange.
    this.panel.setMessage(null);
    this.refreshHighlight();
    this.schedulePreview();
  }

  private async apply(): Promise<void> {
    if (!this.armed || this.applying) {
      return;
    }
    if (this.editTarget) {
      const request = this.buildEditRequest();
      if ('error' in request) {
        this.panel.setMessage(request.error);
        return;
      }
      this.applying = true;
      this.panel.setApplyEnabled(false);
      try {
        const result = await applySweepEdit(this.editTarget, request);
        if (result.success) {
          this.exit({ editEnd: 'apply' });
        } else {
          this.panel.setMessage(result.reason ?? 'Could not apply the edit.');
        }
      } finally {
        this.applying = false;
        this.panel.setApplyEnabled(true);
      }
      return;
    }
    const request = this.buildRequest();
    if ('error' in request) {
      this.panel.setMessage(request.error);
      return;
    }
    this.applying = true;
    this.panel.setApplyEnabled(false);
    try {
      const result = await applySweep(request);
      if (result.success) {
        // The editor round-trip re-renders the scene; that render is the
        // preview and editor undo is the rollback.
        this.exit({ resume: 'lazy' });
      } else {
        this.panel.setMessage(result.reason ?? 'Could not apply the sweep.');
      }
    } finally {
      this.applying = false;
      this.panel.setApplyEnabled(true);
    }
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
      if (this.entities.length === 0) {
        return { error: 'Pick the path edges first.' };
      }
      path = {
        kind: 'edges',
        entities: this.entities,
        chains: this.chains.map((c): ApplyFeatureChain => ({ seed: c.seed, members: c.members })),
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
      if (this.entities.length === 0) {
        return { error: 'Pick the path edges first.' };
      }
      path = {
        kind: 'edges',
        entities: this.entities,
        chains: this.chains.map((c): ApplyFeatureChain => ({ seed: c.seed, members: c.members })),
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
    if (this.entities.length > 0 || this.chains.length > 0) {
      this.entities = [];
      this.chains = [];
    }
    this.pathChipRows = [];
    this.pathSeedApplied = false;
    this.hideContextMenu();
    this.refreshHighlight();
  }

  private suspendSketchUI(): void {
    if (this.suspendedSketchUI) {
      return;
    }
    this.suspendedSketchUI = true;
    this.viewer.suspendSketchEditing();
    this.hooks.onSuspendSketchUI?.();
  }

  private resumeSketchUI(immediate: boolean): void {
    if (!this.suspendedSketchUI) {
      return;
    }
    this.suspendedSketchUI = false;
    this.viewer.resumeSketchEditing(immediate);
    if (immediate) {
      this.hooks.onResumeSketchUI?.();
    }
  }

  /**
   * Async label pass: sketches bound to variables show their names in the
   * chips ("spine — line 3"). Applied only if the dialog is still armed
   * on the same option set when the lookup lands.
   */
  private async refreshSketchLabels(): Promise<void> {
    const signature = optionsSignature(this.profiles);
    this.labelSignature = signature;
    const labeled = await labelWithSketchNames(this.profiles);
    if (!this.armed || this.labelSignature !== signature) {
      return;
    }
    this.profiles = labeled;
    this.panel.setOptions(labeled, this.editTarget ? true : this.hasSolid);
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
    const shown = mergeUniqueEntities(mergeUniqueEntities(this.entities, keepEntities), previewMembers);
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
    this.pathChipRows = selectionChipRows(this.entities, this.chains);
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
    this.button.className = this.armed ? BTN_ACTIVE : BTN_BASE;
    this.buttonWrap.classList.toggle('hidden', !this.available);
    // Every armed flip lands here — the Sketch button disables while a
    // create dialog is up.
    this.hooks.onActiveChange?.();
  }

  // -------------------------------------------------------------------------
  // Statement preview: debounced server render with truthful variable names.
  // -------------------------------------------------------------------------

  private schedulePreview(): void {
    this.cancelPreview();
    if (!this.armed) {
      return;
    }
    this.previewTimer = window.setTimeout(() => {
      this.previewTimer = null;
      this.runPreview();
    }, PREVIEW_DEBOUNCE_MS);
  }

  private async runPreview(): Promise<void> {
    if (!this.armed || this.applying) {
      return;
    }
    // Edit mode previews the full edit payload — re-sourced slots included —
    // so the preview is the exact statement Apply will write.
    const request = this.editTarget ? this.buildEditRequest() : this.buildRequest();
    if ('error' in request) {
      this.panel.setPreview(null);
      return;
    }
    const seq = ++this.previewSeq;
    this.previewAbort?.abort();
    const abort = new AbortController();
    this.previewAbort = abort;

    let result: ApplyFeatureResponse;
    try {
      result = this.editTarget
        ? await applySweepEdit(this.editTarget, {
          ...(request as Parameters<typeof applySweepEdit>[1]),
          preview: true,
          signal: abort.signal,
        })
        : await applySweep({ ...(request as SweepApplyOptions), preview: true, signal: abort.signal });
    } catch {
      return; // aborted
    }
    if (seq !== this.previewSeq || !this.armed) {
      return;
    }
    this.panel.setPreview(result.success ? result.preview ?? null : null);
    if (!result.success && result.reason) {
      // Pre-Apply refusals (unsynthesizable path, multi-part selection)
      // surface immediately, like the modify rails.
      this.panel.setMessage(result.reason);
    }
  }

  private cancelPreview(): void {
    if (this.previewTimer !== null) {
      window.clearTimeout(this.previewTimer);
      this.previewTimer = null;
    }
    this.previewAbort?.abort();
    this.previewAbort = null;
    this.previewSeq++;
  }
}
