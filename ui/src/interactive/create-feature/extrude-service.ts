import {
  applyExtrude, applyExtrudeEdit, fetchFeatureSources, getScopeVariables, ApplyFeatureResponse,
  ExtrudeEditOptions, ExtrudeProfileRef, FeatureEditTarget, ParsedFeatureStatement, SourceSlotRef,
} from '../../api';
import { sameEntity } from '../../helpers/entities';
import { SceneObjectRender, SubSelection } from '../../types';
import { SelectedEntity, Viewer } from '../../viewer';
import { Navbar } from '../../ui/navbar';
import { ICON_IMG_FALLBACK } from '../../ui/object-icons';
import { EditSession, EditSessionInfo } from '../edit-session';
import { ExtrudePanel } from './extrude-panel';
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
 * The create-features toolbar group (Extrude, for now). Unlike the modify
 * group it registers as `immune`, staying visible while the exclusive sketch
 * toolbar owns the bar — extruding is how a sketch gets finished: applying
 * writes `extrude(25)` after the active sketch, whose consumption is also
 * what exits sketch mode. Outside sketch mode the button shows whenever the
 * scene has anything to work from — an unconsumed sketch or a solid (matching
 * Loft); the dialog's dropdown offers the unconsumed sketches and
 * a chosen one is bound to a variable (`const s = sketch(…)` → `extrude(25,
 * s)`). The only 3D picking is the "Up to face" direction mode, where a face
 * click sets the extrusion's target (`extrude(<face>, s)`); otherwise the
 * re-render is the preview and editor undo is the rollback, as on the
 * modify rails.
 */
export class ExtrudeFeatureService {
  private panel: ExtrudePanel;
  private button: HTMLButtonElement;
  /** daisyUI tooltip wrapper around {@link button}; hides with the button so no phantom toolbar gap. */
  private buttonWrap: HTMLElement;
  private armed = false;
  private available = false;
  private options: SketchProfileOption[] = [];
  private sceneObjects: SceneObjectRender[] = [];
  private hasSolid = false;
  private sceneSketchActive = false;
  /** The picked up-to-face target ("Up to face" direction, both modes). */
  private toFaceEntity: SelectedEntity | null = null;
  /** A full render arrived mid-session — a re-picked face's shape id died. */
  private editSceneStale = false;
  private labelSignature = '';
  private applying = false;
  /** Statement being edited in place (timeline double-click), or null. */
  private editTarget: FeatureEditTarget | null = null;
  /** View-state half of edit mode: pre-statement rollback + boundary. */
  private session = new EditSession();
  /** The statement's current profile source, for highlighting the keep slot. */
  private sourceProfile: SourceSlotRef | null = null;
  /** The statement's current to-face target, for highlighting its keep chip. */
  private sourceToFace: SourceSlotRef | null = null;
  /** Sketch editing is suspended while an edit session owns the view. */
  private suspendedSketchUI = false;
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
      /** An edit session armed while a sketch is edited — release the sketch UI. */
      onSuspendSketchUI?: () => void;
      /** The suspension ended without an apply — restore the sketch UI. */
      onResumeSketchUI?: () => void;
    } = {},
  ) {
    const group = navbar.addGroup('create', { visible: false, immune: true });
    this.button = document.createElement('button');
    this.button.className = BTN_BASE;
    this.button.setAttribute('aria-label', 'Extrude a sketch');
    this.button.innerHTML = `<img src="/icons/extrude.png" ${ICON_IMG_FALLBACK} class="w-8 h-8 object-contain" alt="" /><span class="${BTN_LABEL}">Extrude</span>`;
    this.button.addEventListener('click', () => {
      if (this.armed) {
        this.exit();
      } else {
        this.enter();
      }
    });
    this.buttonWrap = document.createElement('span');
    this.buttonWrap.className = 'tooltip tooltip-bottom';
    this.buttonWrap.dataset.tip = 'Extrude a sketch';
    this.buttonWrap.appendChild(this.button);
    group.appendChild(this.buttonWrap);

    this.panel = new ExtrudePanel(container);
    this.panel.onApply = () => this.apply();
    this.panel.onExit = () => this.exit();
    this.panel.onChange = () => {
      this.panel.setMessage(null);
      this.syncFacePickMode();
      this.refreshHighlight();
      this.schedulePreview();
    };
    this.panel.onRemoveFace = () => {
      this.toFaceEntity = null;
      this.panel.setFaceChip(null);
      this.panel.setMessage(null);
      this.refreshHighlight();
      this.schedulePreview();
    };
  }

  get isActive(): boolean {
    return this.armed;
  }

  /** An edit session is open (the viewport shows the pre-statement rollback). */
  get isEditing(): boolean {
    return this.editTarget !== null;
  }

  /**
   * Face picks are live while the dialog's direction is "Up to face" — the
   * click sets the extrusion's target face. In edit mode the pick resolves
   * against the rolled-back pre-statement scene (the loft edit behavior).
   */
  get isFacePicking(): boolean {
    return this.armed && this.panel.isToFace();
  }

  /** True while an edit session has suspended sketch editing. */
  get sketchUISuspended(): boolean {
    return this.suspendedSketchUI;
  }

  /**
   * Every render lands here. An open edit session owns the view: it keeps
   * the viewport rolled back to just before the edited statement, and at
   * that boundary the profile options rebuild from the pre-statement scene —
   * exactly the sketches the extrude's argument can reference (its own
   * current profile included, unconsumed there).
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
        this.sourceProfile = null;
        this.editSceneStale = true;
      }
      return;
    }
    // At the boundary: rebuild options from the pre-statement scene.
    this.sceneObjects = sceneObjects;
    this.options = collectSketchProfiles(sceneObjects);
    if (this.editSceneStale) {
      this.editSceneStale = false;
      // A scene rebuild killed the re-picked face's shape id; the keep chip
      // is text-addressed and survives.
      if (this.toFaceEntity) {
        this.toFaceEntity = null;
        this.panel.setFaceChip(null);
        this.panel.setMessage('The code changed — the re-picked face was reset.');
      }
    }
    this.viewer.pickSketchWires = true;
    this.panel.setOptions(this.options);
    this.syncFacePickMode();
    if (!this.sourceProfile) {
      void this.loadEditSources();
    }
    this.refreshSketchLabels();
    this.refreshHighlight();
    this.schedulePreview();
  }

  /**
   * Scene re-rendered: recompute the offered profiles and button visibility.
   * The dialog stays open across re-renders — in sketch mode every drawn
   * entity re-renders the scene, and closing would fight the user.
   */
  update(sceneObjects: SceneObjectRender[]): void {
    this.sceneObjects = sceneObjects;
    this.options = collectSketchProfiles(sceneObjects);
    this.sceneSketchActive = this.options[0]?.kind === 'active';
    this.hasSolid = sceneObjects.some(o =>
      o.sceneShapes?.some(s => s.shapeType === 'solid' && !s.isMetaShape && !s.isGuide));
    // Offered whenever the scene has anything to work from — like Loft. With
    // no unconsumed sketch the dialog opens on a placeholder dropdown.
    this.available = this.hasSolid || this.options.length > 0;
    // The group is shared with the Sketch button — vote via our own slot and
    // hide our own button; the group shows while either contributor needs it.
    this.navbar.setGroupVisible('create', this.available, 'extrude');
    this.syncButton();
    if (!this.armed) {
      return;
    }
    if (!this.available) {
      this.exit({ resume: 'lazy' });
      return;
    }
    // Shape ids changed with the render — a picked target face is stale and
    // drops back to the pick prompt (the loft behavior).
    if (this.toFaceEntity) {
      this.toFaceEntity = null;
      this.panel.setFaceChip(null);
    }
    this.viewer.pickSketchWires = true;
    this.panel.setOptions(this.options);
    this.syncFacePickMode();
    this.refreshSketchLabels();
    this.refreshHighlight();
    this.schedulePreview();
  }

  /**
   * Open the dialog over an existing extrude/cut statement (timeline
   * double-click). The session rolls the viewport back to just before the
   * statement; the profile dropdown starts on a "Current: …" entry that
   * keeps the statement's own profile and offers the pre-statement sketches
   * as replacements — pickable via the dropdown, timeline rows, or wire
   * clicks in 3D. Apply rewrites the statement in place.
   */
  enterEdit(
    target: FeatureEditTarget,
    parsed: Extract<ParsedFeatureStatement, { feature: 'extrude' }>,
    info: Omit<EditSessionInfo, 'target'>,
  ): void {
    if (this.armed) {
      this.exit();
    }
    this.hooks.onEnter?.();
    this.armed = true;
    this.editTarget = target;
    this.sourceProfile = null;
    this.sourceToFace = null;
    this.toFaceEntity = null;
    this.editSceneStale = false;
    this.syncButton();
    this.suspendSketchUI();
    this.viewer.pickSketchWires = true;
    this.session.begin({ ...info, target });
    void this.loadEditSources();
    void this.refreshScopeVariables();
    this.panel.showEdit({
      op: parsed.op,
      distance: parsed.distance,
      distance2: parsed.distance2,
      symmetric: parsed.symmetric,
      draft: parsed.draft,
      drill: parsed.drill,
      thin: parsed.thin,
      profileLabel: parsed.profileText,
      toFaceLabel: parsed.toFaceText,
    });
    this.syncFacePickMode();
    this.schedulePreview();
  }

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

  /** The statement's current profile and target, for highlighting keep slots. */
  private async loadEditSources(): Promise<void> {
    const boundary = this.session.boundary;
    if (!boundary) {
      return;
    }
    const result = await fetchFeatureSources(boundary);
    if (!this.editTarget || this.session.boundary?.index !== boundary.index) {
      return;
    }
    if (result.ok && (result.feature === 'extrude' || result.feature === 'cut')) {
      this.sourceProfile = result.profile;
      this.sourceToFace = result.toFace ?? null;
    } else {
      this.sourceProfile = { kind: 'opaque' };
      this.sourceToFace = null;
    }
    this.refreshHighlight();
  }

  enter(): void {
    if (this.armed) {
      return;
    }
    this.session.end('continue');
    this.hooks.onEnter?.();
    this.armed = true;
    this.toFaceEntity = null;
    // Clicking a sketch's wires in the 3D view selects it as the profile.
    this.viewer.pickSketchWires = true;
    this.syncButton();
    void this.refreshScopeVariables();
    this.panel.show(this.options);
    // The direction select persists across sessions — re-arm face picking
    // when the dialog reopens on "Up to face".
    this.syncFacePickMode();
    this.refreshSketchLabels();
    this.refreshHighlight();
    this.schedulePreview();
  }

  /**
   * Async label pass: sketches bound to variables show their names in the
   * dropdown ("spine — line 3"). Applied only if the dialog is still armed
   * on the same option set when the lookup lands.
   */
  private async refreshSketchLabels(): Promise<void> {
    const signature = optionsSignature(this.options);
    this.labelSignature = signature;
    const labeled = await labelWithSketchNames(this.options);
    if (!this.armed || this.labelSignature !== signature) {
      return;
    }
    this.options = labeled;
    this.panel.setOptions(labeled);
  }

  /**
   * `resume: 'lazy'` re-enables sketch editing without forcing the mode
   * transition — for apply-success and scene-driven exits, where a render
   * follows. User cancels default to `'immediate'` (a create-mode "Up to
   * face" suspension has no follow-up render to resume it); ending an edit
   * session always resumes lazily (a render follows every session end —
   * the cancel-restore rollback, an apply's rebuild).
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
    this.sourceProfile = null;
    this.sourceToFace = null;
    this.toFaceEntity = null;
    this.editSceneStale = false;
    this.viewer.pickFilter = 'all';
    this.viewer.pickSketchWires = false;
    this.viewer.clearHighlight();
    this.syncButton();
    this.cancelPreview();
    this.panel.hide();
    this.resumeSketchUI((opts.resume ?? 'immediate') === 'immediate');
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
   * Highlight the selected profile's wires — and the picked up-to-face
   * target — in the 3D view. The active sketch is skipped in create mode:
   * extrude doesn't suspend sketch editing there, and painting the sketch
   * being edited would fight the sketch tools. An edit session's keep entry
   * lights up the statement's own profile via the resolved current source.
   */
  private refreshHighlight(): void {
    if (!this.armed) {
      return;
    }
    let option = this.panel.selectedOption();
    if (!option && this.editTarget && this.panel.profileSelection()?.kind === 'keep'
      && this.sourceProfile?.kind === 'sketch') {
      const slot = this.sourceProfile;
      option = this.options.find(o => o.filePath === slot.filePath && o.line === slot.line) ?? null;
    }
    const wireIds = option && (option.kind === 'other' || this.editTarget)
      ? sketchWireShapeIds(option, this.sceneObjects)
      : [];
    // The target face: the re-pick, or an edit session's keep chip through
    // the resolved current source (the statement's own face at the boundary).
    const faces: SelectedEntity[] = [];
    if (this.isFacePicking) {
      if (this.toFaceEntity) {
        faces.push(this.toFaceEntity);
      } else if (this.editTarget && this.panel.faceSelection()?.kind === 'keep'
        && this.sourceToFace?.kind === 'entities') {
        faces.push(...this.sourceToFace.entities.map(e => ({ shapeId: e.shapeId, sub: e.sub })));
      }
    }
    if (wireIds.length > 0 || faces.length > 0) {
      this.viewer.highlightEntities(faces, wireIds);
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

  /**
   * A timeline row was clicked while the dialog is armed. A sketch row (or a
   * child entity of one — the rect/circle rows nested under it) selects that
   * sketch as the profile. Returns true to consume the click — including on
   * an already-consumed sketch, where the timeline's default rollback would
   * otherwise close the dialog mid-flow.
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
    const index = this.options.findIndex(o => o.filePath === loc.filePath && o.line === loc.line);
    if (index < 0) {
      this.panel.setMessage('That sketch was already consumed — only sketches still rendered in the scene can be extruded.');
      return;
    }
    this.panel.selectProfile(index);
    this.panel.setMessage(null);
    this.refreshHighlight();
    this.schedulePreview();
  }

  /**
   * Routes viewer clicks while face picking is live: a face click sets the
   * up-to-face target (clicking the picked face again clears it); empty-space
   * clicks keep it.
   */
  handleClick(shapeId: string | null, sub: SubSelection): void {
    if (!this.isFacePicking || !shapeId || !sub || sub.type !== 'face') {
      return;
    }
    const entity: SelectedEntity = { shapeId, sub };
    this.toFaceEntity = this.toFaceEntity && sameEntity(this.toFaceEntity, entity) ? null : entity;
    this.panel.setFaceChip(this.toFaceEntity ? 'Picked face' : null);
    this.panel.setMessage(null);
    this.refreshHighlight();
    this.schedulePreview();
  }

  /**
   * The viewer's pick mode follows the direction select: "Up to face" picks
   * faces only, and — in create mode — an active sketch releases the view
   * (the loft/sweep behavior) so the camera is free and clicks reach the
   * solid. Flipping the direction back restores both. Edit mode owns the
   * suspension wholesale, so only the pick filter tracks the direction there.
   */
  private syncFacePickMode(): void {
    if (!this.armed) {
      return;
    }
    const picking = this.panel.isToFace();
    this.viewer.pickFilter = picking ? 'face' : 'all';
    if (this.editTarget) {
      return;
    }
    if (picking && this.sceneSketchActive) {
      this.suspendSketchUI();
    } else if (!picking) {
      this.resumeSketchUI(true);
    }
  }

  private async apply(): Promise<void> {
    if (!this.armed || this.applying) {
      return;
    }
    const values = this.panel.values();
    if ('error' in values) {
      this.panel.setMessage(values.error);
      return;
    }
    if (this.editTarget) {
      this.applying = true;
      this.panel.setApplyEnabled(false);
      try {
        const result = await applyExtrudeEdit(this.editTarget, {
          ...values,
          ...this.editSourceFields(),
        });
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
    const option = this.panel.selectedOption();
    if (!option) {
      this.panel.setMessage('No sketch to extrude.');
      return;
    }
    if (!option.hasGeometry) {
      this.panel.setMessage('Draw a profile in the sketch first.');
      return;
    }

    this.applying = true;
    this.panel.setApplyEnabled(false);
    try {
      const result = await applyExtrude({
        ...values,
        profile: profileRef(option),
        toFace: this.panel.isToFace() ? this.toFaceEntity ?? undefined : undefined,
      });
      if (result.success) {
        // The editor round-trip re-renders the scene; that render is the
        // preview and editor undo is the rollback.
        this.exit({ resume: 'lazy' });
      } else {
        this.panel.setMessage(result.reason ?? 'Could not apply the extrude.');
      }
    } finally {
      this.applying = false;
      this.panel.setApplyEnabled(true);
    }
  }

  // -------------------------------------------------------------------------
  // Statement preview: debounced server render, so a bound profile shows the
  // variable name the transform will actually write.
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
    const values = this.panel.values();
    const option = this.editTarget ? null : this.panel.selectedOption();
    if ('error' in values || (!this.editTarget && !option)) {
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
        ? await applyExtrudeEdit(this.editTarget, {
          ...values,
          ...this.editSourceFields(),
          preview: true,
          signal: abort.signal,
        })
        : await applyExtrude({
          ...values,
          profile: profileRef(option!),
          toFace: this.panel.isToFace() ? this.toFaceEntity ?? undefined : undefined,
          preview: true,
          signal: abort.signal,
        });
    } catch {
      return; // aborted
    }
    if (seq !== this.previewSeq || !this.armed) {
      return;
    }
    this.panel.setPreview(result.success ? result.preview ?? null : null);
    if (!result.success && result.reason && (this.editTarget || this.panel.isToFace())) {
      // The statement changed shape under the dialog (an undo, a concurrent
      // edit) or the picked target face has no safe selector — surface the
      // refusal before Apply.
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

  /**
   * The edit apply/preview's session fields: the staleness guard, the
   * re-sourced profile when the slot moved off its "Current: …" entry, and
   * the to-face target while that direction is selected — `keep` for the
   * statement's own target, a face pick (with the boundary it resolves
   * against) for a re-pick. No toFace field means the distance form.
   */
  private editSourceFields(): Pick<ExtrudeEditOptions, 'expectedStatement' | 'before' | 'profile' | 'toFace'> {
    const selection = this.panel.profileSelection();
    const profile = selection?.kind === 'sketch'
      ? {
        mode: 'bound' as const,
        filePath: selection.option.filePath,
        line: selection.option.line,
        column: selection.option.column,
      }
      : undefined;
    let toFace: ExtrudeEditOptions['toFace'];
    if (this.panel.isToFace()) {
      toFace = this.toFaceEntity
        ? { kind: 'face', entity: this.toFaceEntity }
        : { kind: 'keep' };
    }
    return {
      expectedStatement: this.session.expectedStatement,
      before: toFace?.kind === 'face' ? this.session.boundary ?? undefined : undefined,
      profile,
      toFace,
    };
  }
}

function profileRef(option: SketchProfileOption): ExtrudeProfileRef {
  return {
    mode: option.kind === 'active' ? 'active' : 'bound',
    filePath: option.filePath,
    line: option.line,
    column: option.column,
  };
}

