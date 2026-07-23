import {
  applyLoft, applyLoftEdit, fetchFeatureSources, FeatureEditTarget, LoftApplyOptions,
  LoftEditGuideRef, LoftEditProfileRef, LoftProfileRef, ParsedFeatureStatement, SketchSourceRef,
  SourceSlotRef,
} from '../../api';
import { sameEntity } from '../../helpers/entities';
import { SceneObjectRender, SubSelection } from '../../types';
import { SelectedEntity, Viewer } from '../../viewer';
import { Navbar } from '../../ui/navbar';
import { EditSession, EditSessionInfo } from '../edit-session';
import { LoftPanel } from './loft-panel';
import { FeatureButton } from './feature-button';
import { ApplyRunner } from './apply-runner';
import { SketchUISuspender } from './sketch-suspender';
import { OptionRelabeler, refreshScopeVariables } from './option-relabeler';
import {
  collectWireSources, labelWithSketchNames, optionsSignature, resolveWireByShapeId, resolveWireRow,
  sourceChip, SketchProfileOption, sketchWireShapeIds,
} from './sketch-profiles';

type LoftEditRequest = Parameters<typeof applyLoftEdit>[1];

/**
 * One ordered profile in the dialog: a sketch, a face picked in 3D, or — in
 * edit mode — one of the statement's own arguments kept verbatim (removable
 * and reorderable like any chip; re-read from the fresh parse at apply time
 * by its original argument position).
 */
type LoftProfileItem =
  | { kind: 'sketch'; option: SketchProfileOption }
  | { kind: 'face'; entity: SelectedEntity }
  | { kind: 'verbatim'; sourceIndex: number; label: string };

/** One guide in the dialog: a sketch, or a kept statement argument. */
type LoftGuideItem =
  | { kind: 'sketch'; option: SketchProfileOption }
  | { kind: 'verbatim'; sourceIndex: number; label: string };

/**
 * The Loft dialog on the create rails: an ordered multi-profile slot. Each
 * profile is a numbered, removable chip whose order is the loft's argument
 * order. Profiles come from three sources: face picks in the 3D view (live
 * the whole time the dialog is armed — each click appends a chip, clicking a
 * picked face removes it), sketch-wire picks, and timeline sketch clicks.
 * Up to two guide sketches ride in their own slot — sketch picks land in
 * whichever slot was clicked last — and the start/end takeoff conditions in
 * theirs. Arming from inside a sketch suspends sketch editing immediately
 * (the sweep behavior) so the camera is free and clicks pick faces. Apply
 * writes `loft(<profiles…>)` with `.guides()`/`.startCondition()`
 * /`.endCondition()`/`.thin()`/`.remove()`/`.new()` chains.
 */
export class LoftFeatureService {
  private panel: LoftPanel;
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
  /** Argument counts of the parsed statement — the clean-list baselines. */
  private editParsedProfiles = 0;
  private editParsedGuides = 0;
  /** Current sources per original argument position, for highlighting. */
  private sourceSlots: { profiles: SourceSlotRef[]; guides: SourceSlotRef[] } | null = null;
  /** A full render arrived mid-session — face chips died, sources re-fetch. */
  private editSceneStale = false;

  private items: LoftProfileItem[] = [];
  private guides: LoftGuideItem[] = [];
  private runner: ApplyRunner<LoftApplyOptions | LoftEditRequest>;
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
      icon: '/icons/loft.png',
      label: 'Loft',
      tip: 'Loft between two or more profiles',
      ariaLabel: 'Loft between two or more profiles',
    });
    this.button.onClick = () => {
      if (this.armed) {
        this.exit();
      } else {
        this.enter();
      }
    };
    this.sketchUI = new SketchUISuspender(viewer, hooks);

    this.panel = new LoftPanel(container);
    this.panel.onApply = () => void this.applyThroughRunner();
    this.panel.onExit = () => this.exit();
    this.panel.onChange = () => {
      this.panel.setMessage(null);
      this.runner.schedulePreview();
    };
    this.panel.onRemoveProfile = (index) => this.removeProfile(index);
    this.panel.onReorderProfile = (from, to) => this.reorderProfile(from, to);
    this.panel.onRemoveGuide = (index) => this.removeGuide(index);

    this.runner = new ApplyRunner({
      panel: this.panel,
      isArmed: () => this.armed,
      build: () => this.editTarget ? this.buildEditRequest() : this.buildRequest(),
      send: (request, extras) => this.editTarget
        ? applyLoftEdit(this.editTarget, { ...(request as LoftEditRequest), ...extras })
        : applyLoft({ ...(request as LoftApplyOptions), ...extras }),
      onApplied: () => this.exit(this.editTarget ? { editEnd: 'apply' } : { resume: 'lazy' }),
      failMessage: () => this.editTarget ? 'Could not apply the edit.' : 'Could not apply the loft.',
      // A scene-driven preview (update() reruns it without a user action)
      // must clear a refusal that no longer applies.
      onPreviewSuccess: () => this.panel.setMessage(null),
    });
    this.relabeler = new OptionRelabeler({
      sign: optionsSignature,
      load: labelWithSketchNames,
      isArmed: () => this.armed,
      apply: (profiles) => {
        this.profiles = profiles;
        for (const item of this.items) {
          if (item.kind === 'sketch') {
            const refreshed = this.findOption(item.option.filePath, item.option.line);
            if (refreshed) {
              item.option = refreshed;
            }
          }
        }
        for (const guide of this.guides) {
          if (guide.kind === 'sketch') {
            const refreshed = this.findOption(guide.option.filePath, guide.option.line);
            if (refreshed) {
              guide.option = refreshed;
            }
          }
        }
        this.refreshProfilesUI();
      },
    });
  }

  /** Apply keeps the count-aware enable state in sync around the runner. */
  private async applyThroughRunner(): Promise<void> {
    await this.runner.apply();
    this.syncApplyEnabled();
  }

  get isActive(): boolean {
    return this.armed;
  }

  /** An edit session is open (the viewport shows the pre-statement rollback). */
  get isEditing(): boolean {
    return this.editTarget !== null;
  }

  /** Face picks are live the whole time the dialog is armed, in both modes. */
  get isFacePicking(): boolean {
    return this.armed;
  }

  /** True while the armed dialog has suspended sketch editing. */
  get sketchUISuspended(): boolean {
    return this.sketchUI.suspended;
  }

  /**
   * Every render lands here. An open edit session owns the view: it keeps
   * the viewport rolled back to just before the edited statement, and at
   * that boundary the option lists rebuild from the pre-statement scene —
   * exactly the sketches and solids the loft's arguments can reference.
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
    if (this.editSceneStale) {
      this.editSceneStale = false;
      // A scene rebuild killed every picked face's shape id; sketch chips
      // re-match by line, verbatim chips are position-addressed and survive.
      const faces = this.items.filter(item => item.kind === 'face').length;
      if (faces > 0) {
        this.items = this.items.filter(item => item.kind !== 'face');
        this.panel.setMessage('The code changed — re-picked faces were reset.');
      }
      this.sourceSlots = null;
    }
    this.items = this.items.filter(item => {
      if (item.kind !== 'sketch') {
        return true;
      }
      const refreshed = this.findOption(item.option.filePath, item.option.line);
      if (!refreshed) {
        return false;
      }
      item.option = refreshed;
      return true;
    });
    this.guides = this.guides.filter(guide => {
      if (guide.kind !== 'sketch') {
        return true;
      }
      const refreshed = this.findOption(guide.option.filePath, guide.option.line);
      if (!refreshed) {
        return false;
      }
      guide.option = refreshed;
      return true;
    });
    if (!this.sourceSlots) {
      void this.loadEditSources();
    }
    void this.relabeler.refresh(this.profiles);
    this.refreshProfilesUI();
    this.runner.schedulePreview();
  }

  update(sceneObjects: SceneObjectRender[]): void {
    this.sceneObjects = sceneObjects;
    this.profiles = collectWireSources(sceneObjects);
    this.hasSolid = sceneObjects.some(o =>
      o.sceneShapes?.some(s => s.shapeType === 'solid' && !s.isMetaShape && !s.isGuide));
    this.sceneSketchActive = this.profiles[0]?.kind === 'active';
    // A loft needs two profile sources: solid faces to pick, or two sketches
    // (a helix can only ever be a guide, so it doesn't count here).
    this.available = this.hasSolid
      || this.profiles.filter(o => o.feature === 'sketch').length >= 2;
    this.navbar.setGroupVisible('create', this.available, 'loft');
    this.syncButton();
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
    this.viewer.pickFilter = 'face';
    this.viewer.pickSketchWires = true;
    // Shape ids changed with the render: face chips are stale and drop;
    // sketch chips (and guides) are line-addressed and survive while still
    // offered.
    this.items = this.items.filter((item): item is LoftProfileItem & { kind: 'sketch' } => {
      if (item.kind !== 'sketch') {
        return false;
      }
      const refreshed = this.findOption(item.option.filePath, item.option.line);
      if (!refreshed) {
        return false;
      }
      item.option = refreshed;
      return true;
    });
    this.guides = this.guides.filter((guide): guide is LoftGuideItem & { kind: 'sketch' } => {
      if (guide.kind !== 'sketch') {
        return false;
      }
      const refreshed = this.findOption(guide.option.filePath, guide.option.line);
      if (!refreshed) {
        return false;
      }
      guide.option = refreshed;
      return true;
    });
    void this.relabeler.refresh(this.profiles);
    this.refreshProfilesUI();
    this.runner.schedulePreview();
  }

  /**
   * Open the dialog over an existing loft statement (timeline double-click).
   * The session rolls the viewport back to just before the statement; its
   * arguments seed the chip lists as verbatim entries — removable and
   * reorderable like any chip — and face picking / sketch adding is live
   * exactly like create mode. Apply rewrites the statement in place; an
   * untouched list keeps its argument texts verbatim.
   */
  enterEdit(
    target: FeatureEditTarget,
    parsed: Extract<ParsedFeatureStatement, { feature: 'loft' }>,
    info: Omit<EditSessionInfo, 'target'>,
  ): void {
    if (this.armed) {
      this.exit();
    }
    this.hooks.onEnter?.();
    this.armed = true;
    this.editTarget = target;
    this.editParsedProfiles = parsed.profileTexts.length;
    this.editParsedGuides = parsed.guideTexts.length;
    this.items = parsed.profileTexts.map((label, sourceIndex) => ({ kind: 'verbatim', sourceIndex, label }));
    this.guides = parsed.guideTexts.map((label, sourceIndex) => ({ kind: 'verbatim', sourceIndex, label }));
    this.sourceSlots = null;
    this.editSceneStale = false;
    this.syncButton();
    this.sketchUI.suspend();
    this.viewer.pickFilter = 'face';
    this.viewer.pickSketchWires = true;
    this.session.begin({ ...info, target });
    void this.loadEditSources();
    void this.refreshScopeVariables();
    this.panel.showEdit({
      op: parsed.op,
      thin: parsed.thin,
      startCondition: parsed.startCondition,
      endCondition: parsed.endCondition,
    });
    this.refreshProfilesUI();
    this.runner.schedulePreview();
  }

  /**
   * Current sources per original argument position — used purely to light up
   * the statement's own inputs in the rolled-back view (verbatim chips carry
   * the truth as text; nothing here feeds the apply payload).
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
    if (result.ok && result.feature === 'loft') {
      this.sourceSlots = { profiles: result.profiles, guides: result.guides };
    } else {
      this.sourceSlots = { profiles: [], guides: [] };
    }
    this.refreshProfilesUI();
  }

  enter(): void {
    if (this.armed) {
      return;
    }
    this.session.end('continue');
    this.hooks.onEnter?.();
    this.armed = true;
    // Composing a loft means looking at the whole scene, not down the active
    // sketch plane — leave sketch editing right away (resumed on cancel; an
    // apply's re-render takes over).
    if (this.sceneSketchActive) {
      this.sketchUI.suspend();
    }
    this.syncButton();
    this.viewer.pickFilter = 'face';
    this.viewer.pickSketchWires = true;
    this.items = [];
    this.guides = [];
    void this.refreshScopeVariables();
    this.panel.show();
    void this.relabeler.refresh(this.profiles);
    this.refreshProfilesUI();
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
    this.editSceneStale = false;
    this.syncButton();
    this.runner.cancelPreview();
    this.items = [];
    this.guides = [];
    this.viewer.clearHighlight();
    this.viewer.pickFilter = 'all';
    this.viewer.pickSketchWires = false;
    this.panel.hide();
    this.sketchUI.resume((opts.resume ?? 'immediate') === 'immediate');
  }

  /**
   * Routes viewer clicks while the dialog is armed: a face pick appends a
   * profile chip, clicking an already-picked face removes it, empty-space
   * clicks keep the list.
   */
  handleClick(shapeId: string | null, sub: SubSelection): void {
    if (!this.armed || !shapeId || !sub || sub.type !== 'face') {
      return;
    }
    this.panel.setMessage(null);
    const entity: SelectedEntity = { shapeId, sub };
    const existing = this.items.findIndex(item => item.kind === 'face' && sameEntity(item.entity, entity));
    if (existing >= 0) {
      this.items = this.items.filter((_, i) => i !== existing);
    } else {
      this.items = [...this.items, { kind: 'face', entity }];
    }
    this.refreshProfilesUI();
    this.runner.schedulePreview();
  }

  /**
   * A timeline row was clicked while the dialog is armed: the sketch appends
   * a profile chip. Consumed on any sketch row so the default rollback can't
   * close the dialog mid-flow.
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

  /** A sketch wire was clicked in the 3D view: same as a timeline pick. */
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

  /**
   * Sketch picks land in whichever section was focused last. A helix is a
   * bare wire — it can only ever be a guide, so it always lands there.
   */
  private pickSketch(sketch: SceneObjectRender): void {
    const loc = sketch.sourceLocation!;
    const option = this.findOption(loc.filePath, loc.line);
    if (!option) {
      this.panel.setMessage(sketch.type === 'helix'
        ? 'That helix was already consumed — only helixes still rendered in the scene can be used.'
        : 'That sketch was already consumed — only sketches still rendered in the scene can be used.');
      return;
    }
    if (this.panel.armedSection === 'guides' || option.feature === 'helix') {
      this.addGuide(option);
    } else {
      this.addSketchProfile(option);
    }
  }

  /**
   * True when the sketch is already in the loft, as a profile or a guide.
   * A kept (verbatim) chip counts through its resolved current source, so
   * the add-dropdowns never offer a sketch the statement already references.
   */
  private usesSketch(filePath: string, line: number): boolean {
    const verbatimUses = (item: { kind: string; sourceIndex?: number }, slots?: SourceSlotRef[]): boolean => {
      if (item.kind !== 'verbatim' || item.sourceIndex === undefined) {
        return false;
      }
      const slot = slots?.[item.sourceIndex];
      return slot?.kind === 'sketch' && slot.filePath === filePath && slot.line === line;
    };
    return this.items.some(item => (item.kind === 'sketch'
        && item.option.filePath === filePath && item.option.line === line)
        || verbatimUses(item, this.sourceSlots?.profiles))
      || this.guides.some(guide => (guide.kind === 'sketch'
        && guide.option.filePath === filePath && guide.option.line === line)
        || verbatimUses(guide, this.sourceSlots?.guides));
  }

  private addSketchProfile(option: SketchProfileOption): void {
    if (!this.armed) {
      return;
    }
    if (option.feature === 'helix') {
      this.panel.setMessage('A helix is a wire — it can guide the loft, but a profile must be a sketch or a face.');
      return;
    }
    if (this.usesSketch(option.filePath, option.line)) {
      this.panel.setMessage('That sketch is already in the loft — each profile and guide must be different.');
      return;
    }
    this.panel.setMessage(null);
    this.items = [...this.items, { kind: 'sketch', option }];
    this.refreshProfilesUI();
    this.runner.schedulePreview();
  }

  private addGuide(option: SketchProfileOption): void {
    if (!this.armed) {
      return;
    }
    if (this.guides.length >= 2) {
      this.panel.setMessage('A loft takes at most two guides.');
      return;
    }
    if (this.usesSketch(option.filePath, option.line)) {
      this.panel.setMessage('That sketch is already in the loft — each profile and guide must be different.');
      return;
    }
    this.panel.setMessage(null);
    this.guides = [...this.guides, { kind: 'sketch', option }];
    this.refreshProfilesUI();
    this.runner.schedulePreview();
  }

  private removeGuide(index: number): void {
    if (index < 0 || index >= this.guides.length) {
      return;
    }
    this.panel.setMessage(null);
    this.guides = this.guides.filter((_, i) => i !== index);
    this.refreshProfilesUI();
    this.runner.schedulePreview();
  }

  private removeProfile(index: number): void {
    if (index < 0 || index >= this.items.length) {
      return;
    }
    this.panel.setMessage(null);
    this.items = this.items.filter((_, i) => i !== index);
    this.refreshProfilesUI();
    this.runner.schedulePreview();
  }

  /** Move the chip at `from` to position `to` — order is argument order. */
  private reorderProfile(from: number, to: number): void {
    if (from === to || from < 0 || to < 0 || from >= this.items.length || to >= this.items.length) {
      return;
    }
    this.panel.setMessage(null);
    const items = [...this.items];
    const [moved] = items.splice(from, 1);
    items.splice(to, 0, moved);
    this.items = items;
    this.refreshProfilesUI();
    this.runner.schedulePreview();
  }

  /** The request for the current form state, or the message blocking it. */
  private buildRequest(): LoftApplyOptions | { error: string } {
    const values = this.panel.values();
    if ('error' in values) {
      return values;
    }
    if (this.items.length < 2) {
      return { error: 'A loft needs at least two profiles — pick faces or add sketches.' };
    }
    const profiles: LoftProfileRef[] = [];
    for (const item of this.items) {
      if (item.kind === 'verbatim') {
        return { error: 'A kept profile only exists while editing a statement.' };
      }
      if (item.kind === 'sketch') {
        if (!item.option.hasGeometry) {
          return { error: `Nothing is drawn in "${item.option.label}" yet.` };
        }
        profiles.push({
          kind: 'sketch',
          filePath: item.option.filePath,
          line: item.option.line,
          column: item.option.column,
        });
      } else {
        profiles.push({ kind: 'face', entity: item.entity });
      }
    }
    const guides: SketchSourceRef[] = [];
    for (const guide of this.guides) {
      if (guide.kind !== 'sketch') {
        return { error: 'A kept guide only exists while editing a statement.' };
      }
      if (!guide.option.hasGeometry) {
        return { error: `Nothing is drawn in "${guide.option.label}" yet.` };
      }
      guides.push({ filePath: guide.option.filePath, line: guide.option.line, column: guide.option.column });
    }
    // The panel blocks the thin toggle while guides exist; this only guards
    // against a state the UI failed to keep out.
    if (guides.length > 0 && values.thin) {
      return { error: 'Guides cannot be combined with thin walls — remove the guides first.' };
    }
    return {
      op: values.op,
      thin: values.thin,
      profiles,
      guides,
      startCondition: values.startCondition,
      endCondition: values.endCondition,
    };
  }

  /**
   * The edit-mode apply payload. Untouched lists — every chip still a
   * verbatim entry in its original argument order — are omitted entirely, so
   * the transform preserves the statement's texts byte for byte. A changed
   * list ships in full: verbatim keeps by position, sketches by call site,
   * face picks for synthesis against the session boundary.
   */
  private buildEditRequest(): Parameters<typeof applyLoftEdit>[1] | { error: string } {
    const values = this.panel.values();
    if ('error' in values) {
      return values;
    }
    if (this.items.length < 2) {
      return { error: 'A loft needs at least two profiles — pick faces or add sketches.' };
    }
    if (this.guides.length > 0 && values.thin) {
      return { error: 'Guides cannot be combined with thin walls — remove the guides first.' };
    }
    const profilesClean = this.items.length === this.editParsedProfiles
      && this.items.every((item, i) => item.kind === 'verbatim' && item.sourceIndex === i);
    const guidesClean = this.guides.length === this.editParsedGuides
      && this.guides.every((guide, i) => guide.kind === 'verbatim' && guide.sourceIndex === i);

    let profiles: LoftEditProfileRef[] | undefined;
    let hasFacePicks = false;
    if (!profilesClean) {
      profiles = [];
      for (const item of this.items) {
        if (item.kind === 'verbatim') {
          profiles.push({ kind: 'verbatim', sourceIndex: item.sourceIndex });
        } else if (item.kind === 'sketch') {
          if (!item.option.hasGeometry) {
            return { error: `Nothing is drawn in "${item.option.label}" yet.` };
          }
          profiles.push({
            kind: 'sketch',
            filePath: item.option.filePath,
            line: item.option.line,
            column: item.option.column,
          });
        } else {
          hasFacePicks = true;
          profiles.push({ kind: 'face', entity: item.entity });
        }
      }
    }
    let guides: LoftEditGuideRef[] | undefined;
    if (!guidesClean) {
      guides = this.guides.map(guide => guide.kind === 'verbatim'
        ? { kind: 'verbatim' as const, sourceIndex: guide.sourceIndex }
        : {
          kind: 'sketch' as const,
          filePath: guide.option.filePath,
          line: guide.option.line,
          column: guide.option.column,
        });
    }
    return {
      op: values.op,
      thin: values.thin,
      startCondition: values.startCondition,
      endCondition: values.endCondition,
      profiles,
      guides,
      expectedStatement: this.session.expectedStatement,
      before: hasFacePicks ? this.session.boundary ?? undefined : undefined,
    };
  }

  // -------------------------------------------------------------------------
  // Profile list + sketch-editing suspension
  // -------------------------------------------------------------------------

  private refreshProfilesUI(): void {
    this.panel.setProfiles(this.items.map(item =>
      item.kind === 'sketch' ? sourceChip(item.option)
        : { label: item.kind === 'face' ? 'Picked face' : item.label }));
    this.panel.setGuides(this.guides.map(guide =>
      guide.kind === 'sketch' ? sourceChip(guide.option) : { label: guide.label }));
    this.panel.setThinBlocked(this.guides.length > 0);
    const count = this.items.length;
    if (count === 0) {
      this.panel.setHint('Pick sketches or faces');
    } else if (count === 1) {
      this.panel.setHint('1 sketch — add at least one more');
    } else {
      this.panel.setHint(null);
    }
    const faces = this.items
      .filter((item): item is LoftProfileItem & { kind: 'face' } => item.kind === 'face')
      .map(item => item.entity);
    const sketches = [
      ...this.items
        .filter((item): item is LoftProfileItem & { kind: 'sketch' } => item.kind === 'sketch')
        .map(item => item.option),
      ...this.guides
        .filter((guide): guide is LoftGuideItem & { kind: 'sketch' } => guide.kind === 'sketch')
        .map(guide => guide.option),
    ];
    // Kept (verbatim) chips light up through the resolved current sources —
    // the statement's own faces and sketch wires at the rolled-back view.
    for (const item of this.items) {
      if (item.kind === 'verbatim') {
        const slot = this.sourceSlots?.profiles[item.sourceIndex];
        if (slot?.kind === 'entities') {
          faces.push(...slot.entities.map(e => ({ shapeId: e.shapeId, sub: e.sub })));
        } else if (slot?.kind === 'sketch') {
          const option = this.findOption(slot.filePath, slot.line);
          if (option) {
            sketches.push(option);
          }
        }
      }
    }
    for (const guide of this.guides) {
      if (guide.kind === 'verbatim') {
        const slot = this.sourceSlots?.guides[guide.sourceIndex];
        if (slot?.kind === 'sketch') {
          const option = this.findOption(slot.filePath, slot.line);
          if (option) {
            sketches.push(option);
          }
        }
      }
    }
    // Every selected input lights up: picked faces plus the wires of every
    // profile and guide sketch.
    const wireIds = sketches.flatMap(option => sketchWireShapeIds(option, this.sceneObjects));
    if (faces.length > 0 || wireIds.length > 0) {
      this.viewer.highlightEntities(faces, wireIds);
    } else {
      this.viewer.clearHighlight();
    }
    this.syncApplyEnabled();
  }

  private findOption(filePath: string, line: number): SketchProfileOption | undefined {
    return this.profiles.find(o => o.filePath === filePath && o.line === line);
  }

  private syncApplyEnabled(): void {
    this.panel.setApplyEnabled(!this.runner.isApplying && this.items.length >= 2);
  }

  private syncButton(): void {
    this.button.setActive(this.armed);
    this.button.setVisible(this.available);
    // Every armed flip lands here — the Sketch button disables while a
    // create dialog is up.
    this.hooks.onActiveChange?.();
  }
}
