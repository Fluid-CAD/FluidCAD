import {
  applyRevolve, applyRevolveEdit, fetchFeatureSources, ApplyFeatureResponse, FeatureEditTarget,
  ParsedFeatureStatement, RevolveApplyOptions, RevolveAxisRef, RevolveEditOptions, SourceSlotRef,
} from '../../api';
import { sameEntity } from '../../helpers/entities';
import { SceneObjectRender, SubSelection } from '../../types';
import { SelectedEntity, Viewer } from '../../viewer';
import { Navbar } from '../../ui/navbar';
import { ICON_IMG_FALLBACK } from '../../ui/object-icons';
import { EditSession, EditSessionInfo } from '../edit-session';
import { RevolvePanel } from './revolve-panel';
import {
  collectSketchProfiles, labelWithSketchNames, optionsSignature, resolveSketchByShapeId, resolveSketchRow,
  SketchProfileOption, sketchWireShapeIds,
} from './sketch-profiles';
import {
  AxisOption, axisLineShapeIds, axisOptionsSignature, collectAxisOptions, labelWithAxisNames,
  resolveAxisByShapeId,
} from './axis-options';

const BTN_BASE = 'btn btn-ghost btn-sm h-auto flex-col gap-0.5 px-2 py-1 text-base-content/60';
const BTN_ACTIVE = 'btn btn-soft btn-primary btn-sm h-auto flex-col gap-0.5 px-2 py-1';
/** Small muted caption under the toolbar icon. */
const BTN_LABEL = 'text-[10px] leading-none text-base-content/50';

const PREVIEW_DEBOUNCE_MS = 250;

/**
 * The Revolve dialog on the create rails: a profile sketch swept around an
 * axis. The profile slot takes sketches (timeline or wire clicks); the axis
 * slot takes the X/Y/Z quick buttons, an axis statement's dashed line
 * clicked in 3D (the first axis-picking dialog — the viewer's opt-in
 * `pickAxes` channel), an axis row in the timeline, or a single solid edge
 * picked in 3D — written as `axis(<edge selector>)`. Exactly one slot is
 * armed at a time (clicked to activate — the sweep/loft idiom) and the
 * viewer's pick channels follow it, so the slot border says where the next
 * 3D click lands. Apply writes `revolve(<axis>[, <angle>][, <profile>])`
 * with `.thin()`/`.remove()`/`.new()` chains — the re-render is the
 * preview, editor undo the rollback.
 */
export class RevolveFeatureService {
  private panel: RevolvePanel;
  private button: HTMLButtonElement;
  /** daisyUI tooltip wrapper around {@link button}; hides with the button so no phantom toolbar gap. */
  private buttonWrap: HTMLElement;
  private armed = false;
  private available = false;
  private applying = false;
  private profiles: SketchProfileOption[] = [];
  private axes: AxisOption[] = [];
  private sceneObjects: SceneObjectRender[] = [];
  private hasSolid = false;
  private sceneSketchActive = false;
  private suspendedSketchUI = false;
  /** The picked axis edge (the axis slot's `edge` mode), or null. */
  private axisEdgeEntity: SelectedEntity | null = null;
  /** Statement being edited in place (timeline double-click), or null. */
  private editTarget: FeatureEditTarget | null = null;
  /** View-state half of edit mode: pre-statement rollback + boundary. */
  private session = new EditSession();
  /** Current sources of the edited statement, for highlighting keep slots. */
  private sourceSlots: { profile: SourceSlotRef; axis: SourceSlotRef } | null = null;
  /** A full render arrived mid-session — a re-picked edge's shape id died. */
  private editSceneStale = false;
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
    this.button.setAttribute('aria-label', 'Revolve a sketch around an axis');
    this.button.innerHTML = `<img src="/icons/revolve.png" ${ICON_IMG_FALLBACK} class="w-8 h-8 object-contain" alt="" /><span class="${BTN_LABEL}">Revolve</span>`;
    this.button.addEventListener('click', () => {
      if (this.armed) {
        this.exit();
      } else {
        this.enter();
      }
    });
    this.buttonWrap = document.createElement('span');
    this.buttonWrap.className = 'tooltip tooltip-bottom';
    this.buttonWrap.dataset.tip = 'Revolve a sketch around an axis';
    this.buttonWrap.appendChild(this.button);
    group.appendChild(this.buttonWrap);

    this.panel = new RevolvePanel(container);
    this.panel.onApply = () => this.apply();
    this.panel.onExit = () => this.exit();
    this.panel.onChange = () => {
      this.panel.setMessage(null);
      this.refreshHighlight();
      this.schedulePreview();
    };
    this.panel.onAxisModeChange = () => {
      // The slot left edge mode (✕, a standard/axis choice) — the entity
      // would otherwise silently ride along into the next edge state.
      this.axisEdgeEntity = null;
      this.refreshHighlight();
    };
    this.panel.onArmedSlotChange = () => this.syncPickChannels();
  }

  get isActive(): boolean {
    return this.armed;
  }

  /** An edit session is open (the viewport shows the pre-statement rollback). */
  get isEditing(): boolean {
    return this.editTarget !== null;
  }

  /**
   * The armed dialog owns viewport clicks; which picks are actually live
   * follows the panel's armed slot ({@link syncPickChannels}) — the viewer
   * routes edge and axis clicks here.
   */
  get isAxisPicking(): boolean {
    return this.armed;
  }

  /** True while armed picking has suspended sketch editing. */
  get sketchUISuspended(): boolean {
    return this.suspendedSketchUI;
  }

  /**
   * Every render lands here. An open edit session owns the view: it keeps
   * the viewport rolled back to just before the edited statement, and at
   * that boundary the slot options rebuild from the pre-statement scene —
   * exactly the sketches and axes the revolve's arguments can reference.
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
    this.axes = collectAxisOptions(sceneObjects);
    if (this.editSceneStale) {
      this.editSceneStale = false;
      // A scene rebuild killed the re-picked edge's shape id; the keep chip
      // is text-addressed and survives.
      if (this.axisEdgeEntity) {
        this.axisEdgeEntity = null;
        this.panel.setAxisEdgeChip(null);
        this.panel.setMessage('The code changed — the re-picked edge was reset.');
      }
      this.sourceSlots = null;
    }
    if (!this.sourceSlots) {
      void this.loadEditSources();
    }
    this.syncPickChannels();
    this.panel.setOptions(this.profiles, this.axes);
    this.refreshLabels();
    this.refreshHighlight();
    this.schedulePreview();
  }

  update(sceneObjects: SceneObjectRender[]): void {
    this.sceneObjects = sceneObjects;
    this.profiles = collectSketchProfiles(sceneObjects);
    this.axes = collectAxisOptions(sceneObjects);
    this.hasSolid = sceneObjects.some(o =>
      o.sceneShapes?.some(s => s.shapeType === 'solid' && !s.isMetaShape && !s.isGuide));
    this.sceneSketchActive = this.profiles[0]?.kind === 'active';
    // Offered whenever the scene has anything to work from — like Extrude.
    this.available = this.hasSolid || this.profiles.length > 0;
    this.navbar.setGroupVisible('create', this.available, 'revolve');
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
      this.suspendSketchUI();
    }
    this.syncPickChannels();
    // Shape ids changed with the render — a picked axis edge is stale and
    // drops back to the pick prompt.
    if (this.axisEdgeEntity) {
      this.axisEdgeEntity = null;
      this.panel.setAxisEdgeChip(null);
    }
    this.panel.setOptions(this.profiles, this.axes);
    this.refreshLabels();
    this.refreshHighlight();
    this.schedulePreview();
  }

  /**
   * Open the dialog over an existing revolve statement (timeline
   * double-click). The session rolls the viewport back to just before the
   * statement; both slots start on "Current: …" entries that keep the
   * statement's own expressions, and re-sourcing is live — other sketches
   * via the timeline/wire clicks, the axis via the X/Y/Z buttons, an axis
   * line or a solid edge picked in 3D. Apply rewrites the statement in
   * place.
   */
  enterEdit(
    target: FeatureEditTarget,
    parsed: Extract<ParsedFeatureStatement, { feature: 'revolve' }>,
    info: Omit<EditSessionInfo, 'target'>,
  ): void {
    if (this.armed) {
      this.exit();
    }
    this.hooks.onEnter?.();
    this.armed = true;
    this.editTarget = target;
    this.axisEdgeEntity = null;
    this.sourceSlots = null;
    this.editSceneStale = false;
    this.syncButton();
    this.suspendSketchUI();
    this.session.begin({ ...info, target });
    void this.loadEditSources();
    this.panel.showEdit({
      op: parsed.op,
      angle: parsed.angle ?? 360,
      thin: parsed.thin,
      axisLabel: parsed.axisText,
      profileLabel: parsed.profileText ?? 'Current sketch (implicit)',
    });
    this.syncPickChannels();
    this.schedulePreview();
  }

  /** The statement's current profile and axis, for highlighting keep slots. */
  private async loadEditSources(): Promise<void> {
    const boundary = this.session.boundary;
    if (!boundary) {
      return;
    }
    const result = await fetchFeatureSources(boundary);
    if (!this.editTarget || this.session.boundary?.index !== boundary.index) {
      return;
    }
    this.sourceSlots = result.ok && result.feature === 'revolve'
      ? { profile: result.profile, axis: result.axis }
      : { profile: { kind: 'opaque' }, axis: { kind: 'opaque' } };
    this.refreshHighlight();
  }

  enter(): void {
    if (this.armed) {
      return;
    }
    this.session.end('continue');
    this.hooks.onEnter?.();
    this.armed = true;
    this.axisEdgeEntity = null;
    // Composing a revolve means looking at the whole scene, not down the
    // active sketch plane — leave sketch editing right away (resumed on
    // cancel; an apply's re-render takes over).
    if (this.sceneSketchActive) {
      this.suspendSketchUI();
    }
    this.syncButton();
    this.panel.show(this.profiles, this.axes);
    this.syncPickChannels();
    this.refreshLabels();
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
    this.editSceneStale = false;
    this.axisEdgeEntity = null;
    this.syncButton();
    this.cancelPreview();
    this.viewer.clearHighlight();
    this.viewer.pickFilter = 'all';
    this.viewer.pickSketchWires = false;
    this.viewer.pickAxes = false;
    this.panel.hide();
    this.resumeSketchUI((opts.resume ?? 'immediate') === 'immediate');
  }

  /**
   * Routes viewer clicks while the dialog is armed: a solid edge sets the
   * axis to that edge (clicking it again clears it back), an axis line sets
   * the axis to that statement, empty-space clicks keep the selection.
   */
  handleClick(shapeId: string | null, sub: SubSelection): void {
    if (!this.isAxisPicking || !shapeId || !sub) {
      return;
    }
    if (sub.type === 'axis') {
      const axis = resolveAxisByShapeId(shapeId, this.sceneObjects);
      const option = axis?.sourceLocation
        ? this.axes.find(o => o.filePath === axis.sourceLocation!.filePath && o.line === axis.sourceLocation!.line)
        : undefined;
      if (!option) {
        this.panel.setMessage('That axis was already consumed — only axes still shown in the scene can be picked.');
        return;
      }
      this.axisEdgeEntity = null;
      this.panel.selectAxis(option);
      this.panel.setMessage(null);
      this.refreshHighlight();
      this.schedulePreview();
      return;
    }
    if (sub.type !== 'edge') {
      return;
    }
    const entity: SelectedEntity = { shapeId, sub };
    this.axisEdgeEntity = this.axisEdgeEntity && sameEntity(this.axisEdgeEntity, entity) ? null : entity;
    this.panel.setAxisEdgeChip(this.axisEdgeEntity ? 'Picked edge' : null);
    this.panel.setMessage(null);
    this.refreshHighlight();
    this.schedulePreview();
  }

  /**
   * A timeline row was clicked while the dialog is armed: a sketch row lands
   * in the profile slot, an axis row in the axis slot. Consumed so the
   * default rollback can't close the dialog mid-flow.
   */
  handleTimelinePick(obj: SceneObjectRender): boolean {
    if (!this.armed) {
      return false;
    }
    if (obj.type === 'axis' && obj.sourceLocation) {
      const loc = obj.sourceLocation;
      const option = this.axes.find(o => o.filePath === loc.filePath && o.line === loc.line);
      if (!option) {
        this.panel.setMessage('That axis was already consumed — only axes still shown in the scene can be picked.');
        return true;
      }
      this.axisEdgeEntity = null;
      this.panel.selectAxis(option);
      this.panel.setMessage(null);
      this.refreshHighlight();
      this.schedulePreview();
      return true;
    }
    const sketch = resolveSketchRow(obj, this.sceneObjects);
    if (!sketch?.sourceLocation) {
      return false;
    }
    this.pickSketch(sketch);
    return true;
  }

  /** A sketch wire was clicked in the 3D view: selects it as the profile. */
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
    const index = this.profiles.findIndex(o => o.filePath === loc.filePath && o.line === loc.line);
    if (index < 0) {
      this.panel.setMessage('That sketch was already consumed — only sketches still rendered in the scene can be revolved.');
      return;
    }
    this.panel.selectProfile(index);
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
        const result = await applyRevolveEdit(this.editTarget, request);
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
      const result = await applyRevolve(request);
      if (result.success) {
        // The editor round-trip re-renders the scene; that render is the
        // preview and editor undo is the rollback.
        this.exit({ resume: 'lazy' });
      } else {
        this.panel.setMessage(result.reason ?? 'Could not apply the revolve.');
      }
    } finally {
      this.applying = false;
      this.panel.setApplyEnabled(true);
    }
  }

  /** The axis slot's request field, or the message blocking it. */
  private axisRef(): RevolveAxisRef | { error: string } | null {
    const selection = this.panel.axisSelection();
    if (!selection || selection.kind === 'keep') {
      return null;
    }
    if (selection.kind === 'standard') {
      return { kind: 'standard', axis: selection.axis };
    }
    if (selection.kind === 'axis') {
      const option = selection.option;
      return { kind: 'axis', filePath: option.filePath, line: option.line, column: option.column };
    }
    if (!this.axisEdgeEntity) {
      return { error: 'Pick the axis edge first.' };
    }
    return { kind: 'edge', entity: this.axisEdgeEntity };
  }

  /** The request for the current form state, or the message blocking it. */
  private buildRequest(): RevolveApplyOptions | { error: string } {
    const values = this.panel.values();
    if ('error' in values) {
      return values;
    }
    const profile = this.panel.selectedProfile();
    if (!profile) {
      return { error: 'No sketch to revolve.' };
    }
    if (!profile.hasGeometry) {
      return { error: 'Draw a profile in the sketch first.' };
    }
    const axis = this.axisRef();
    if (axis === null) {
      return { error: 'Choose the axis to revolve around.' };
    }
    if ('error' in axis) {
      return axis;
    }
    return {
      op: values.op,
      angle: values.angle,
      thin: values.thin,
      profile: {
        mode: profile.kind === 'active' ? 'active' : 'bound',
        filePath: profile.filePath,
        line: profile.line,
        column: profile.column,
      },
      axis,
    };
  }

  /**
   * The edit-mode apply payload. Slots still on their "Current: …" entry are
   * omitted, so the transform preserves the statement's expressions byte for
   * byte; a re-sourced axis ships as a standard axis, an axis-statement ref,
   * or an edge pick (the latter synthesized against the session boundary).
   */
  private buildEditRequest(): Parameters<typeof applyRevolveEdit>[1] | { error: string } {
    const values = this.panel.values();
    if ('error' in values) {
      return values;
    }
    let axis: RevolveAxisRef | undefined;
    const axisResult = this.axisRef();
    if (axisResult !== null) {
      if ('error' in axisResult) {
        return axisResult;
      }
      axis = axisResult;
    }
    let profile: RevolveEditOptions['profile'];
    const profileSel = this.panel.profileSelection();
    if (profileSel?.kind === 'sketch') {
      if (!profileSel.option.hasGeometry) {
        return { error: `Nothing is drawn in "${profileSel.option.label}" yet.` };
      }
      profile = {
        mode: 'bound',
        filePath: profileSel.option.filePath,
        line: profileSel.option.line,
        column: profileSel.option.column,
      };
    }
    return {
      op: values.op,
      angle: values.angle,
      thin: values.thin,
      profile,
      axis,
      expectedStatement: this.session.expectedStatement,
      before: axis?.kind === 'edge' ? this.session.boundary ?? undefined : undefined,
    };
  }

  /**
   * The viewer's pick channels follow the panel's armed slot, so the slot
   * border says exactly where the next 3D click lands: profile armed →
   * sketch wires only; axis armed → solid edges and axis lines only.
   * Timeline rows are typed and always route (re-arming their slot).
   */
  private syncPickChannels(): void {
    if (!this.armed) {
      return;
    }
    const axisArmed = this.panel.armedSlot === 'axis';
    this.viewer.pickSketchWires = !axisArmed;
    this.viewer.pickAxes = axisArmed;
    this.viewer.pickFilter = axisArmed ? 'edge' : 'none';
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
   * Async label pass: sketches and axes bound to variables show their names
   * ("profile — line 3", "ringAxis — line 5"). Applied only if the dialog is
   * still armed on the same option sets when the lookups land.
   */
  private async refreshLabels(): Promise<void> {
    const signature = `${optionsSignature(this.profiles)}#${axisOptionsSignature(this.axes)}`;
    this.labelSignature = signature;
    const [profiles, axes] = await Promise.all([
      labelWithSketchNames(this.profiles),
      labelWithAxisNames(this.axes),
    ]);
    if (!this.armed || this.labelSignature !== signature) {
      return;
    }
    this.profiles = profiles;
    this.axes = axes;
    this.panel.setOptions(profiles, axes);
  }

  /**
   * Repaint the viewport selection: the profile's wires, the chosen axis
   * statement's dashed line (tinted whole, like sketch wires), and the
   * picked axis edge. Keep slots light up through the resolved current
   * sources at the rolled-back view.
   */
  private refreshHighlight(): void {
    if (!this.armed) {
      return;
    }
    const wireIds: string[] = [];
    const entities: SelectedEntity[] = [];

    let profileOption = this.panel.selectedProfile();
    if (!profileOption && this.editTarget && this.panel.profileSelection()?.kind === 'keep'
      && this.sourceSlots?.profile.kind === 'sketch') {
      const slot = this.sourceSlots.profile;
      profileOption = this.profiles.find(o => o.filePath === slot.filePath && o.line === slot.line) ?? null;
    }
    // The active sketch is skipped in create mode — painting the sketch
    // being edited would fight the sketch tools (the extrude behavior).
    if (profileOption && (profileOption.kind === 'other' || this.editTarget)) {
      wireIds.push(...sketchWireShapeIds(profileOption, this.sceneObjects));
    }

    const axisSel = this.panel.axisSelection();
    if (axisSel?.kind === 'axis') {
      wireIds.push(...axisLineShapeIds(axisSel.option, this.sceneObjects));
    } else if (axisSel?.kind === 'edge' && this.axisEdgeEntity) {
      entities.push(this.axisEdgeEntity);
    } else if (axisSel?.kind === 'keep' && this.sourceSlots?.axis.kind === 'sketch') {
      wireIds.push(...axisLineShapeIds(this.sourceSlots.axis, this.sceneObjects));
    } else if (axisSel?.kind === 'keep' && this.sourceSlots?.axis.kind === 'entities') {
      entities.push(...this.sourceSlots.axis.entities.map(e => ({ shapeId: e.shapeId, sub: e.sub })));
    }

    if (wireIds.length > 0 || entities.length > 0) {
      this.viewer.highlightEntities(entities, wireIds);
    } else {
      this.viewer.clearHighlight();
    }
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
        ? await applyRevolveEdit(this.editTarget, {
          ...(request as Parameters<typeof applyRevolveEdit>[1]),
          preview: true,
          signal: abort.signal,
        })
        : await applyRevolve({ ...(request as RevolveApplyOptions), preview: true, signal: abort.signal });
    } catch {
      return; // aborted
    }
    if (seq !== this.previewSeq || !this.armed) {
      return;
    }
    this.panel.setPreview(result.success ? result.preview ?? null : null);
    if (!result.success && result.reason) {
      // Pre-Apply refusals (an unsynthesizable axis edge, a statement that
      // changed shape under the dialog) surface immediately.
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
