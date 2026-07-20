import {
  applyWrap, applyWrapEdit, fetchFeatureSources, getScopeVariables, ApplyFeatureResponse,
  FeatureEditTarget, ParsedFeatureStatement, SourceSlotRef, WrapEditOptions,
} from '../../api';
import { sameEntity } from '../../helpers/entities';
import { EditSession, EditSessionInfo } from '../edit-session';
import { SceneObjectRender, SubSelection } from '../../types';
import { SelectedEntity, Viewer } from '../../viewer';
import { Navbar } from '../../ui/navbar';
import { ICON_IMG_FALLBACK } from '../../ui/object-icons';
import { WrapPanel } from './wrap-panel';
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
 * The Wrap dialog on the create rails: a sketch developed onto a curved face
 * (cylindrical or conical), raised from the surface by a thickness — emboss
 * with Add, deboss with Remove, standalone pad with New. The sketch comes
 * from the timeline or wire clicks (like the sweep profile); the target face
 * is a single face pick, live in the 3D view the whole time the dialog is
 * armed (the extrude up-to-face behavior). Arming from inside a sketch
 * suspends sketch editing so the camera is free and clicks reach the solid.
 * Apply writes `wrap(<thickness>, <sketch>, <face>)` with `.remove()` /
 * `.new()` chains — the re-render is the preview, editor undo the rollback.
 */
export class WrapFeatureService {
  private panel: WrapPanel;
  private button: HTMLButtonElement;
  /** daisyUI tooltip wrapper around {@link button}; hides with the button so no phantom toolbar gap. */
  private buttonWrap: HTMLElement;
  private armed = false;
  private available = false;
  private applying = false;
  private options: SketchProfileOption[] = [];
  private sceneObjects: SceneObjectRender[] = [];
  private hasSolid = false;
  private sceneSketchActive = false;
  private suspendedSketchUI = false;
  /** The picked target face, or null while the slot wants a pick. */
  private faceEntity: SelectedEntity | null = null;
  /** Statement being edited in place (timeline double-click), or null. */
  private editTarget: FeatureEditTarget | null = null;
  /** View-state half of edit mode: pre-statement rollback + boundary. */
  private session = new EditSession();
  /** Current sources of the edited statement, for seeding and highlighting. */
  private sourceSlots: { sketch: SourceSlotRef; face: SourceSlotRef } | null = null;
  /** A full render arrived mid-session — a re-picked face's shape id died. */
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
    this.button.setAttribute('aria-label', 'Wrap a sketch onto a curved face');
    this.button.innerHTML = `<img src="/icons/wrap.png" ${ICON_IMG_FALLBACK} class="w-8 h-8 object-contain" alt="" /><span class="${BTN_LABEL}">Wrap</span>`;
    this.button.addEventListener('click', () => {
      if (this.armed) {
        this.exit();
      } else {
        this.enter();
      }
    });
    this.buttonWrap = document.createElement('span');
    this.buttonWrap.className = 'tooltip tooltip-bottom';
    this.buttonWrap.dataset.tip = 'Wrap a sketch onto a curved face';
    // Anchors the Shell button, which slots in just ahead of Wrap.
    this.buttonWrap.dataset.tool = 'wrap';
    this.buttonWrap.appendChild(this.button);
    group.appendChild(this.buttonWrap);

    this.panel = new WrapPanel(container);
    this.panel.onApply = () => this.apply();
    this.panel.onExit = () => this.exit();
    this.panel.onChange = () => {
      this.panel.setMessage(null);
      this.refreshHighlight();
      this.schedulePreview();
    };
    this.panel.onRemoveFace = () => {
      this.faceEntity = null;
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
   * Face picks are live the whole time the dialog is armed — the click sets
   * the wrap's target face. In edit mode the pick resolves against the
   * rolled-back pre-statement scene.
   */
  get isFacePicking(): boolean {
    return this.armed;
  }

  /** True while the armed dialog has suspended sketch editing. */
  get sketchUISuspended(): boolean {
    return this.suspendedSketchUI;
  }

  /**
   * Every render lands here. An open edit session owns the view: it keeps
   * the viewport rolled back to just before the edited statement, and at
   * that boundary the sketch options rebuild from the pre-statement scene —
   * exactly the sketches and faces the wrap's arguments can reference.
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
    this.options = collectSketchProfiles(sceneObjects);
    if (this.editSceneStale) {
      this.editSceneStale = false;
      // A scene rebuild killed the re-picked face's shape id; the keep chip
      // is text-addressed and survives.
      if (this.faceEntity) {
        this.faceEntity = null;
        this.panel.setFaceChip(null);
        this.panel.setMessage('The code changed — the re-picked face was reset.');
      }
      this.sourceSlots = null;
    }
    if (!this.sourceSlots) {
      void this.loadEditSources();
    }
    this.viewer.pickSketchWires = true;
    this.viewer.pickFilter = 'face';
    this.panel.setOptions(this.options);
    this.refreshSketchLabels();
    this.refreshHighlight();
    this.schedulePreview();
  }

  update(sceneObjects: SceneObjectRender[]): void {
    this.sceneObjects = sceneObjects;
    this.options = collectSketchProfiles(sceneObjects);
    this.sceneSketchActive = this.options[0]?.kind === 'active';
    this.hasSolid = sceneObjects.some(o =>
      o.sceneShapes?.some(s => s.shapeType === 'solid' && !s.isMetaShape && !s.isGuide));
    // Offered whenever the scene has a solid to wrap onto — the target face
    // lives on one. The dialog itself explains what else is missing.
    this.available = this.hasSolid;
    this.navbar.setGroupVisible('create', this.available, 'wrap');
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
    this.viewer.pickSketchWires = true;
    this.viewer.pickFilter = 'face';
    // Shape ids changed with the render — a picked target face is stale and
    // drops back to the pick prompt (the extrude behavior).
    if (this.faceEntity) {
      this.faceEntity = null;
      this.panel.setFaceChip(null);
    }
    this.panel.setOptions(this.options);
    this.refreshSketchLabels();
    this.refreshHighlight();
    this.schedulePreview();
  }

  /**
   * Open the dialog over an existing wrap statement (timeline double-click).
   * The session rolls the viewport back to just before the statement; both
   * slots start on "Current: …" entries that keep the statement's own
   * expressions, and re-sourcing is live — other sketches via the
   * timeline/wire clicks, the target by picking a face in 3D. Apply rewrites
   * the statement in place.
   */
  enterEdit(
    target: FeatureEditTarget,
    parsed: Extract<ParsedFeatureStatement, { feature: 'wrap' }>,
    info: Omit<EditSessionInfo, 'target'>,
  ): void {
    if (this.armed) {
      this.exit();
    }
    this.hooks.onEnter?.();
    this.armed = true;
    this.editTarget = target;
    this.faceEntity = null;
    this.sourceSlots = null;
    this.editSceneStale = false;
    this.syncButton();
    this.suspendSketchUI();
    this.viewer.pickSketchWires = true;
    this.viewer.pickFilter = 'face';
    this.session.begin({ ...info, target });
    void this.loadEditSources();
    void this.refreshScopeVariables();
    this.panel.showEdit({
      op: parsed.op,
      thickness: parsed.thickness,
      sketchLabel: parsed.sketchText,
      faceLabel: parsed.faceText,
    });
    this.schedulePreview();
  }

  /**
   * Current sources of the edited statement: the sketch (for highlighting)
   * and the target face's resolved entities on the pre-statement solids.
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
    this.sourceSlots = result.ok && result.feature === 'wrap'
      ? { sketch: result.sketch, face: result.face }
      : { sketch: { kind: 'opaque' }, face: { kind: 'opaque' } };
    this.refreshHighlight();
  }

  enter(): void {
    if (this.armed) {
      return;
    }
    this.session.end('continue');
    this.hooks.onEnter?.();
    this.armed = true;
    this.faceEntity = null;
    // Composing a wrap means picking a face on the solid, not looking down
    // the active sketch plane — leave sketch editing right away (resumed on
    // cancel; an apply's re-render takes over).
    if (this.sceneSketchActive) {
      this.suspendSketchUI();
    }
    this.viewer.pickSketchWires = true;
    this.viewer.pickFilter = 'face';
    this.syncButton();
    void this.refreshScopeVariables();
    this.panel.show(this.options);
    this.refreshSketchLabels();
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
    this.faceEntity = null;
    this.syncButton();
    this.cancelPreview();
    this.viewer.clearHighlight();
    this.viewer.pickFilter = 'all';
    this.viewer.pickSketchWires = false;
    this.panel.hide();
    this.resumeSketchUI((opts.resume ?? 'immediate') === 'immediate');
  }

  /**
   * Routes viewer face clicks while the dialog is armed: a face click sets
   * the wrap's target (clicking the picked face again clears it);
   * empty-space clicks keep it.
   */
  handleClick(shapeId: string | null, sub: SubSelection): void {
    if (!this.isFacePicking || !shapeId || !sub || sub.type !== 'face') {
      return;
    }
    const entity: SelectedEntity = { shapeId, sub };
    this.faceEntity = this.faceEntity && sameEntity(this.faceEntity, entity) ? null : entity;
    this.panel.setFaceChip(this.faceEntity ? 'Picked face' : null);
    this.panel.setMessage(null);
    this.refreshHighlight();
    this.schedulePreview();
  }

  /**
   * A timeline row was clicked while the dialog is armed: the sketch lands
   * in the sketch slot. Consumed on any sketch row so the default rollback
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
   * sketch lands in the sketch slot.
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
    if (!this.panel.selectSketch(loc.filePath, loc.line)) {
      this.panel.setMessage('That sketch was already consumed — only sketches still rendered in the scene can be used.');
      return;
    }
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
        const result = await applyWrapEdit(this.editTarget, request);
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
      const result = await applyWrap(request);
      if (result.success) {
        // The editor round-trip re-renders the scene; that render is the
        // preview and editor undo is the rollback.
        this.exit({ resume: 'lazy' });
      } else {
        this.panel.setMessage(result.reason ?? 'Could not apply the wrap.');
      }
    } finally {
      this.applying = false;
      this.panel.setApplyEnabled(true);
    }
  }

  /** The request for the current form state, or the message blocking it. */
  private buildRequest(): Parameters<typeof applyWrap>[0] | { error: string } {
    const values = this.panel.values();
    if ('error' in values) {
      return values;
    }
    const sketch = this.panel.selectedSketch();
    if (!sketch) {
      return { error: 'No sketch to wrap.' };
    }
    if (!sketch.hasGeometry) {
      return { error: 'Draw something in the sketch first.' };
    }
    if (!this.faceEntity) {
      return { error: 'Pick the target face to wrap onto.' };
    }
    return {
      op: values.op,
      thickness: values.thickness,
      sketch: { filePath: sketch.filePath, line: sketch.line, column: sketch.column },
      face: this.faceEntity,
    };
  }

  /**
   * The edit-mode apply payload. Slots still on their "Current: …" entry are
   * omitted, so the transform preserves the statement's expressions byte for
   * byte; a re-sourced sketch ships as a sketch ref, a re-picked face as a
   * pick (synthesized against the session boundary).
   */
  private buildEditRequest(): WrapEditOptions | { error: string } {
    const values = this.panel.values();
    if ('error' in values) {
      return values;
    }
    let sketch: WrapEditOptions['sketch'];
    const sketchSel = this.panel.sketchSelection();
    if (sketchSel?.kind === 'sketch') {
      if (!sketchSel.option.hasGeometry) {
        return { error: `Nothing is drawn in "${sketchSel.option.label}" yet.` };
      }
      sketch = {
        kind: 'sketch',
        filePath: sketchSel.option.filePath,
        line: sketchSel.option.line,
        column: sketchSel.option.column,
      };
    }
    const face: WrapEditOptions['face'] = this.faceEntity
      ? { kind: 'face', entity: this.faceEntity }
      : undefined;
    return {
      op: values.op,
      thickness: values.thickness,
      sketch,
      face,
      expectedStatement: this.session.expectedStatement,
      before: face?.kind === 'face' ? this.session.boundary ?? undefined : undefined,
    };
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
   * chips ("logo — line 3"). Applied only if the dialog is still armed on
   * the same option set when the lookup lands.
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
   * Repaint the viewport selection: the picked target face plus the wires of
   * the chosen sketch — the dialog's inputs stay visible in 3D. Slots kept
   * on the statement's own expressions light up through the resolved current
   * sources at the rolled-back view.
   */
  private refreshHighlight(): void {
    if (!this.armed) {
      return;
    }
    const sketches: SketchProfileOption[] = [];
    const sketchSel = this.panel.sketchSelection();
    if (sketchSel?.kind === 'sketch') {
      sketches.push(sketchSel.option);
    } else if (sketchSel?.kind === 'keep' && this.sourceSlots?.sketch.kind === 'sketch') {
      const slot = this.sourceSlots.sketch;
      const option = this.options.find(o => o.filePath === slot.filePath && o.line === slot.line);
      if (option) {
        sketches.push(option);
      }
    }
    const faces: SelectedEntity[] = [];
    if (this.faceEntity) {
      faces.push(this.faceEntity);
    } else if (this.editTarget && this.panel.faceSelection()?.kind === 'keep'
      && this.sourceSlots?.face.kind === 'entities') {
      faces.push(...this.sourceSlots.face.entities.map(e => ({ shapeId: e.shapeId, sub: e.sub })));
    }
    const wireIds = sketches.flatMap(option => sketchWireShapeIds(option, this.sceneObjects));
    if (faces.length > 0 || wireIds.length > 0) {
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
        ? await applyWrapEdit(this.editTarget, {
          ...(request as WrapEditOptions),
          preview: true,
          signal: abort.signal,
        })
        : await applyWrap({
          ...(request as Parameters<typeof applyWrap>[0]),
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
    if (!result.success && result.reason) {
      // Pre-Apply refusals (an unsynthesizable face, a drifted statement)
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
