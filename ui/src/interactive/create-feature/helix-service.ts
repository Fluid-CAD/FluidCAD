import {
  applyHelix, applyHelixEdit, fetchFeatureSources, getScopeVariables, ApplyFeatureResponse,
  FeatureEditTarget, HelixApplyOptions, HelixEditOptions, HelixSourceRef, ParsedFeatureStatement,
  SourceSlotRef,
} from '../../api';
import { sameEntity } from '../../helpers/entities';
import { SceneObjectRender, SubSelection } from '../../types';
import { SelectedEntity, Viewer } from '../../viewer';
import { Navbar } from '../../ui/navbar';
import { ICON_IMG_FALLBACK } from '../../ui/object-icons';
import { EditSession, EditSessionInfo } from '../edit-session';
import { HelixPanel } from './helix-panel';
import { collectSketchProfiles } from './sketch-profiles';
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
 * The Helix dialog on the create rails: a helical wire built around an axis or
 * on a cylindrical/conical face, chosen by the From-axis / From-face tabs. In
 * axis mode the axis slot takes the X/Y/Z quick buttons, an axis statement's
 * dashed line clicked in 3D (the viewer's `pickAxes` channel), an axis row in
 * the timeline, or a single solid edge — written `axis(<edge>)` (the revolve
 * axis idiom). In face mode the face slot takes a single cylindrical face
 * picked in 3D (the wrap idiom). The tab decides which channel is live. A
 * helix is a wire, not a solid, so there is no add/remove/new operation — Apply
 * writes `helix(<source>)` with the chained geometry configurators
 * (`.radius()`, `.pitch()`, `.turns()`, …); the re-render is the preview,
 * editor undo the rollback.
 */
export class HelixFeatureService {
  private panel: HelixPanel;
  private button: HTMLButtonElement;
  /** daisyUI tooltip wrapper around {@link button}; hides with the button so no phantom toolbar gap. */
  private buttonWrap: HTMLElement;
  private armed = false;
  private available = false;
  private applying = false;
  private axes: AxisOption[] = [];
  private sceneObjects: SceneObjectRender[] = [];
  private hasSolid = false;
  private hasSketch = false;
  private sceneSketchActive = false;
  private suspendedSketchUI = false;
  /** The picked axis edge (axis mode's edge source), or null. */
  private sourceEdgeEntity: SelectedEntity | null = null;
  /** The picked cylindrical face (face mode's source), or null. */
  private sourceFaceEntity: SelectedEntity | null = null;
  /** Statement being edited in place (timeline double-click), or null. */
  private editTarget: FeatureEditTarget | null = null;
  /** View-state half of edit mode: pre-statement rollback + boundary. */
  private session = new EditSession();
  /** Current source of the edited statement, for highlighting the keep slot. */
  private sourceSlot: SourceSlotRef | null = null;
  /** A full render arrived mid-session — a re-picked source's shape id died. */
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
    this.button.setAttribute('aria-label', 'Build a helix around an axis or on a cylindrical face');
    this.button.innerHTML = `<img src="/icons/helix.png" ${ICON_IMG_FALLBACK} class="w-8 h-8 object-contain" alt="" /><span class="${BTN_LABEL}">Helix</span>`;
    this.button.addEventListener('click', () => {
      if (this.armed) {
        this.exit();
      } else {
        this.enter();
      }
    });
    this.buttonWrap = document.createElement('span');
    this.buttonWrap.className = 'tooltip tooltip-bottom';
    this.buttonWrap.dataset.tip = 'Build a helix around an axis or on a cylindrical face';
    this.buttonWrap.appendChild(this.button);
    group.appendChild(this.buttonWrap);

    this.panel = new HelixPanel(container);
    this.panel.onApply = () => this.apply();
    this.panel.onExit = () => this.exit();
    this.panel.onChange = () => {
      this.panel.setMessage(null);
      this.refreshHighlight();
      this.schedulePreview();
    };
    this.panel.onModeChange = () => {
      // A fresh mode is a fresh source choice — the previous mode's picked
      // entity would otherwise ride along invisibly into the new channel.
      this.sourceEdgeEntity = null;
      this.sourceFaceEntity = null;
      this.syncPickChannels();
    };
    this.panel.onAxisModeChange = () => {
      // The axis slot left edge mode (✕, a standard/axis choice) — drop its entity.
      this.sourceEdgeEntity = null;
      this.refreshHighlight();
    };
    this.panel.onRemoveFace = () => {
      this.sourceFaceEntity = null;
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

  /** The armed dialog owns viewport clicks. */
  get isPicking(): boolean {
    return this.armed;
  }

  /** Axis mode: the viewer routes axis-line and solid-edge clicks here. */
  get isAxisPicking(): boolean {
    return this.armed && this.panel.sourceMode === 'axis';
  }

  /** Face mode: the viewer routes face clicks here. */
  get isFacePicking(): boolean {
    return this.armed && this.panel.sourceMode === 'face';
  }

  /** True while armed picking has suspended sketch editing. */
  get sketchUISuspended(): boolean {
    return this.suspendedSketchUI;
  }

  /**
   * Every render lands here. An open edit session owns the view: it keeps the
   * viewport rolled back to just before the edited statement, and at that
   * boundary the axis options rebuild from the pre-statement scene.
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
    this.axes = collectAxisOptions(sceneObjects);
    if (this.editSceneStale) {
      this.editSceneStale = false;
      // A scene rebuild killed the re-picked source's shape id; the keep chip
      // is text-addressed and survives.
      if (this.sourceEdgeEntity || this.sourceFaceEntity) {
        this.sourceEdgeEntity = null;
        this.sourceFaceEntity = null;
        this.panel.setAxisEdgeChip(null);
        this.panel.setFaceChip(null);
        this.panel.setMessage('The code changed — the re-picked source was reset.');
      }
      this.sourceSlot = null;
    }
    if (!this.sourceSlot) {
      void this.loadEditSources();
    }
    this.syncPickChannels();
    this.panel.setAxisOptions(this.axes);
    this.refreshLabels();
    this.refreshHighlight();
    this.schedulePreview();
  }

  update(sceneObjects: SceneObjectRender[]): void {
    this.sceneObjects = sceneObjects;
    this.axes = collectAxisOptions(sceneObjects);
    const profiles = collectSketchProfiles(sceneObjects);
    this.hasSketch = profiles.length > 0;
    this.hasSolid = sceneObjects.some(o =>
      o.sceneShapes?.some(s => s.shapeType === 'solid' && !s.isMetaShape && !s.isGuide));
    this.sceneSketchActive = profiles[0]?.kind === 'active';
    // Offered whenever the scene has a solid (face mode + edge picks) or a
    // sketch to sweep the helix with — like Revolve's availability signal.
    this.available = this.hasSolid || this.hasSketch;
    this.navbar.setGroupVisible('create', this.available, 'helix');
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
    // Shape ids changed with the render — a picked source edge/face is stale
    // and drops back to the pick prompt.
    if (this.sourceEdgeEntity || this.sourceFaceEntity) {
      this.sourceEdgeEntity = null;
      this.sourceFaceEntity = null;
      this.panel.setAxisEdgeChip(null);
      this.panel.setFaceChip(null);
    }
    this.panel.setAxisOptions(this.axes);
    this.refreshLabels();
    this.refreshHighlight();
    this.schedulePreview();
  }

  /**
   * Open the dialog over an existing helix statement (timeline double-click).
   * The session rolls the viewport back to just before the statement; the
   * source slot starts on a "Current: …" entry that keeps the statement's own
   * expression, and re-sourcing is live — the axis via the X/Y/Z buttons, an
   * axis line or an edge in axis mode, a face in face mode. Apply rewrites the
   * statement in place.
   */
  enterEdit(
    target: FeatureEditTarget,
    parsed: Extract<ParsedFeatureStatement, { feature: 'helix' }>,
    info: Omit<EditSessionInfo, 'target'>,
  ): void {
    if (this.armed) {
      this.exit();
    }
    this.hooks.onEnter?.();
    this.armed = true;
    this.editTarget = target;
    this.sourceEdgeEntity = null;
    this.sourceFaceEntity = null;
    this.sourceSlot = null;
    this.editSceneStale = false;
    this.syncButton();
    this.suspendSketchUI();
    this.session.begin({ ...info, target });
    void this.loadEditSources();
    void this.refreshScopeVariables();
    this.panel.showEdit({
      mode: parsed.sourceMode,
      sourceLabel: parsed.sourceText,
      radius: parsed.radius,
      endRadius: parsed.endRadius,
      pitch: parsed.pitch,
      turns: parsed.turns,
      height: parsed.height,
      startOffset: parsed.startOffset,
      endOffset: parsed.endOffset,
    });
    this.syncPickChannels();
    this.schedulePreview();
  }

  /**
   * Push the variables in scope at the statement (edit mode) or at the end of
   * the file (create mode) to the dialog's expression fields. A response
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
    this.sourceSlot = result.ok && result.feature === 'helix' ? result.source : { kind: 'opaque' };
    this.refreshHighlight();
  }

  enter(): void {
    if (this.armed) {
      return;
    }
    this.session.end('continue');
    this.hooks.onEnter?.();
    this.armed = true;
    this.sourceEdgeEntity = null;
    this.sourceFaceEntity = null;
    // Composing a helix means looking at the whole scene, not down the active
    // sketch plane — leave sketch editing right away (resumed on cancel; an
    // apply's re-render takes over).
    if (this.sceneSketchActive) {
      this.suspendSketchUI();
    }
    this.syncButton();
    void this.refreshScopeVariables();
    this.panel.show(this.axes);
    this.syncPickChannels();
    this.refreshLabels();
    this.refreshHighlight();
    this.schedulePreview();
  }

  /**
   * `resume: 'lazy'` re-enables sketch editing without forcing the mode
   * transition — for apply-success and scene-driven exits. User cancels
   * default to `'immediate'`; ending an edit session always resumes lazily.
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
    this.sourceSlot = null;
    this.editSceneStale = false;
    this.sourceEdgeEntity = null;
    this.sourceFaceEntity = null;
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
   * Routes viewer clicks while the dialog is armed. Axis mode: an axis line
   * selects that statement, a solid edge sets the axis to that edge (clicking
   * it again clears it). Face mode: a face sets the helix's source face.
   */
  handleClick(shapeId: string | null, sub: SubSelection): void {
    if (!this.armed || !shapeId || !sub) {
      return;
    }
    if (this.panel.sourceMode === 'axis') {
      if (sub.type === 'axis') {
        const axis = resolveAxisByShapeId(shapeId, this.sceneObjects);
        const option = axis?.sourceLocation
          ? this.axes.find(o => o.filePath === axis.sourceLocation!.filePath && o.line === axis.sourceLocation!.line)
          : undefined;
        if (!option) {
          this.panel.setMessage('That axis was already consumed — only axes still shown in the scene can be picked.');
          return;
        }
        this.sourceEdgeEntity = null;
        this.panel.selectAxis(option);
        this.panel.setMessage(null);
        this.refreshHighlight();
        this.schedulePreview();
        return;
      }
      if (sub.type === 'edge') {
        const entity: SelectedEntity = { shapeId, sub };
        this.sourceEdgeEntity = this.sourceEdgeEntity && sameEntity(this.sourceEdgeEntity, entity) ? null : entity;
        this.panel.setAxisEdgeChip(this.sourceEdgeEntity ? 'Picked edge' : null);
        this.panel.setMessage(null);
        this.refreshHighlight();
        this.schedulePreview();
      }
      return;
    }
    if (sub.type !== 'face') {
      return;
    }
    const entity: SelectedEntity = { shapeId, sub };
    this.sourceFaceEntity = this.sourceFaceEntity && sameEntity(this.sourceFaceEntity, entity) ? null : entity;
    this.panel.setFaceChip(this.sourceFaceEntity ? 'Picked face' : null);
    this.panel.setMessage(null);
    this.refreshHighlight();
    this.schedulePreview();
  }

  /**
   * A timeline row was clicked while the dialog is armed: in axis mode an axis
   * row lands in the axis slot. Consumed so the default rollback can't close
   * the dialog mid-flow.
   */
  handleTimelinePick(obj: SceneObjectRender): boolean {
    if (!this.armed || this.panel.sourceMode !== 'axis') {
      return false;
    }
    if (obj.type === 'axis' && obj.sourceLocation) {
      const loc = obj.sourceLocation;
      const option = this.axes.find(o => o.filePath === loc.filePath && o.line === loc.line);
      if (!option) {
        this.panel.setMessage('That axis was already consumed — only axes still shown in the scene can be picked.');
        return true;
      }
      this.sourceEdgeEntity = null;
      this.panel.selectAxis(option);
      this.panel.setMessage(null);
      this.refreshHighlight();
      this.schedulePreview();
      return true;
    }
    return false;
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
        const result = await applyHelixEdit(this.editTarget, request);
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
      const result = await applyHelix(request);
      if (result.success) {
        // The editor round-trip re-renders the scene; that render is the
        // preview and editor undo is the rollback.
        this.exit({ resume: 'lazy' });
      } else {
        this.panel.setMessage(result.reason ?? 'Could not apply the helix.');
      }
    } finally {
      this.applying = false;
      this.panel.setApplyEnabled(true);
    }
  }

  /** The source slot's request field, or the message blocking it, or null (kept). */
  private sourceRef(): HelixSourceRef | { error: string } | null {
    if (this.panel.sourceMode === 'axis') {
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
      if (!this.sourceEdgeEntity) {
        return { error: 'Pick the axis edge first.' };
      }
      return { kind: 'edge', entity: this.sourceEdgeEntity };
    }
    const selection = this.panel.faceSelection();
    if (!selection || selection.kind === 'keep') {
      return null;
    }
    if (!this.sourceFaceEntity) {
      return { error: 'Pick the cylindrical face first.' };
    }
    return { kind: 'face', entity: this.sourceFaceEntity };
  }

  /** The request for the current form state, or the message blocking it. */
  private buildRequest(): HelixApplyOptions | { error: string } {
    const values = this.panel.values();
    if ('error' in values) {
      return values;
    }
    const source = this.sourceRef();
    if (source === null) {
      return {
        error: this.panel.sourceMode === 'axis'
          ? 'Choose an axis for the helix.'
          : 'Pick a cylindrical face for the helix.',
      };
    }
    if ('error' in source) {
      return source;
    }
    const { mode, ...options } = values;
    return { source, ...options };
  }

  /**
   * The edit-mode apply payload. A source still on its "Current: …" entry is
   * omitted, so the transform preserves the statement's expression byte for
   * byte; a re-sourced axis/edge/face ships as the matching ref (synthesized
   * against the session boundary for picks).
   */
  private buildEditRequest(): HelixEditOptions | { error: string } {
    const values = this.panel.values();
    if ('error' in values) {
      return values;
    }
    let source: HelixSourceRef | undefined;
    const sourceResult = this.sourceRef();
    if (sourceResult !== null) {
      if ('error' in sourceResult) {
        return sourceResult;
      }
      source = sourceResult;
    }
    const { mode, ...options } = values;
    const needsBoundary = source?.kind === 'edge' || source?.kind === 'face';
    return {
      ...options,
      source,
      expectedStatement: this.session.expectedStatement,
      before: needsBoundary ? this.session.boundary ?? undefined : undefined,
    };
  }

  /** The viewer's pick channels follow the source mode: axis → axis lines and
   * solid edges; face → faces. */
  private syncPickChannels(): void {
    if (!this.armed) {
      return;
    }
    const axisMode = this.panel.sourceMode === 'axis';
    this.viewer.pickSketchWires = false;
    this.viewer.pickAxes = axisMode;
    this.viewer.pickFilter = axisMode ? 'edge' : 'face';
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
   * Async label pass: axes bound to variables show their names ("coilAxis —
   * line 5"). Applied only if the dialog is still armed on the same option
   * set when the lookups land.
   */
  private async refreshLabels(): Promise<void> {
    const signature = axisOptionsSignature(this.axes);
    this.labelSignature = signature;
    const axes = await labelWithAxisNames(this.axes);
    if (!this.armed || this.labelSignature !== signature) {
      return;
    }
    this.axes = axes;
    this.panel.setAxisOptions(axes);
  }

  /**
   * Repaint the viewport selection: the chosen axis statement's dashed line,
   * the picked axis edge, or the picked source face. A kept source lights up
   * through the resolved current source at the rolled-back view.
   */
  private refreshHighlight(): void {
    if (!this.armed) {
      return;
    }
    const wireIds: string[] = [];
    const entities: SelectedEntity[] = [];

    if (this.panel.sourceMode === 'axis') {
      const axisSel = this.panel.axisSelection();
      if (axisSel?.kind === 'axis') {
        wireIds.push(...axisLineShapeIds(axisSel.option, this.sceneObjects));
      } else if (axisSel?.kind === 'edge' && this.sourceEdgeEntity) {
        entities.push(this.sourceEdgeEntity);
      } else if (axisSel?.kind === 'keep') {
        this.pushKeptSource(wireIds, entities);
      }
    } else {
      const faceSel = this.panel.faceSelection();
      if (faceSel?.kind === 'picked' && this.sourceFaceEntity) {
        entities.push(this.sourceFaceEntity);
      } else if (faceSel?.kind === 'keep') {
        this.pushKeptSource(wireIds, entities);
      }
    }

    if (wireIds.length > 0 || entities.length > 0) {
      this.viewer.highlightEntities(entities, wireIds);
    } else {
      this.viewer.clearHighlight();
    }
  }

  /** The edited statement's own source, resolved at the rolled-back view. */
  private pushKeptSource(wireIds: string[], entities: SelectedEntity[]): void {
    if (!this.editTarget || !this.sourceSlot) {
      return;
    }
    if (this.sourceSlot.kind === 'sketch') {
      wireIds.push(...axisLineShapeIds(this.sourceSlot, this.sceneObjects));
    } else if (this.sourceSlot.kind === 'entities') {
      entities.push(...this.sourceSlot.entities.map(e => ({ shapeId: e.shapeId, sub: e.sub })));
    }
  }

  private syncButton(): void {
    this.button.className = this.armed ? BTN_ACTIVE : BTN_BASE;
    this.buttonWrap.classList.toggle('hidden', !this.available);
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
        ? await applyHelixEdit(this.editTarget, {
          ...(request as HelixEditOptions),
          preview: true,
          signal: abort.signal,
        })
        : await applyHelix({ ...(request as HelixApplyOptions), preview: true, signal: abort.signal });
    } catch {
      return; // aborted
    }
    if (seq !== this.previewSeq || !this.armed) {
      return;
    }
    this.panel.setPreview(result.success ? result.preview ?? null : null);
    if (!result.success && result.reason) {
      // Pre-Apply refusals (a non-cylindrical face, an unsynthesizable edge, a
      // statement that changed shape under the dialog) surface immediately.
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
