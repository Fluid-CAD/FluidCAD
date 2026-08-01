import {
  applyHelix, applyHelixEdit, fetchFeatureGhost, fetchFeatureSources, FeatureEditTarget,
  GhostHelixSourceRef, GhostSolid, HelixApplyOptions, HelixEditOptions, HelixSourceRef,
  ParsedFeatureStatement, SourceSlotRef,
} from '../../api';
import { toggleEntity } from '../../helpers/entities';
import { SceneObjectRender, SubSelection } from '../../types';
import { SelectedEntity, Viewer } from '../../viewer';
import { Navbar } from '../../ui/navbar';
import { EditSession, EditSessionInfo } from '../edit-session';
import { HelixPanel } from './helix-panel';
import { FeatureButton } from './feature-button';
import { ApplyRunner } from './apply-runner';
import { FeatureGhostOverlay } from './feature-ghost';
import { SketchUISuspender } from './sketch-suspender';
import { OptionRelabeler, refreshScopeVariables } from './option-relabeler';
import { collectSketchProfiles } from './sketch-profiles';
import {
  AXIS_CONSUMED_MESSAGE, AxisOption, axisLineShapeIds, axisOptionForLocation, axisOptionForShape,
  axisOptionsSignature, collectAxisOptions, labelWithAxisNames, pickedAxisRef,
} from './axis-options';

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
  private button: FeatureButton;
  private armed = false;
  private available = false;
  private axes: AxisOption[] = [];
  private sceneObjects: SceneObjectRender[] = [];
  private hasSolid = false;
  private hasSketch = false;
  private sceneSketchActive = false;
  private sketchUI: SketchUISuspender;
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
  private runner: ApplyRunner<HelixApplyOptions | HelixEditOptions>;
  private relabeler: OptionRelabeler<AxisOption[]>;
  /** The live coil drawn in the viewport while the dialog is open. */
  private ghost: FeatureGhostOverlay;

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
      icon: '/icons/helix.png',
      label: 'Helix',
      tip: 'Build a helix around an axis or on a cylindrical face',
      ariaLabel: 'Build a helix around an axis or on a cylindrical face',
    });
    this.button.onClick = () => {
      if (this.armed) {
        this.exit();
      } else {
        this.enter();
      }
    };
    this.sketchUI = new SketchUISuspender(viewer, hooks);
    this.ghost = new FeatureGhostOverlay(viewer);

    this.panel = new HelixPanel(container);
    this.panel.onApply = () => void this.runner.apply();
    this.panel.onExit = () => this.exit();
    this.panel.onChange = () => {
      this.panel.setMessage(null);
      this.refreshHighlight();
      this.runner.schedulePreview();
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
      this.runner.schedulePreview();
    };

    this.runner = new ApplyRunner({
      panel: this.panel,
      isArmed: () => this.armed,
      build: () => this.editTarget ? this.buildEditRequest() : this.buildRequest(),
      send: (request, extras) => this.editTarget
        ? applyHelixEdit(this.editTarget, { ...(request as HelixEditOptions), ...extras })
        : applyHelix({ ...(request as HelixApplyOptions), ...extras }),
      onApplied: () => this.exit(this.editTarget ? { editEnd: 'apply' } : { resume: 'lazy' }),
      failMessage: () => this.editTarget ? 'Could not apply the edit.' : 'Could not apply the helix.',
      // The statement preview's geometric twin: the coil the values describe,
      // drawn in the viewport. Same debounce, same abort scope. A helix puts
      // no material anywhere, so it is always the wire color — there is no
      // add/remove to tell apart.
      ghost: {
        fetch: (_request, signal) => this.fetchGhost(signal),
        apply: (solids) => {
          if (solids) {
            this.ghost.set(solids, 'wire');
          } else {
            this.ghost.clear();
          }
        },
      },
    });
    this.relabeler = new OptionRelabeler({
      sign: axisOptionsSignature,
      load: labelWithAxisNames,
      isArmed: () => this.armed,
      apply: (axes) => {
        this.axes = axes;
        this.panel.setAxisOptions(axes);
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
    return this.sketchUI.suspended;
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
      // Mid-flight to the boundary — whatever the ghost was drawn against is
      // already gone from the view.
      this.ghost.clear();
      if (!isRollback) {
        this.editSceneStale = true;
      }
      return;
    }
    // At the boundary: rebuild options from the pre-statement scene.
    this.ghost.clear();
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
    void this.relabeler.refresh(this.axes);
    this.refreshHighlight();
    this.runner.schedulePreview();
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
    // sketch to sweep the helix with — like Revolve's availability signal —
    // and on a blank document (see {@link Viewer.sceneIsEmpty}).
    this.available = this.hasSolid || this.hasSketch || this.viewer.sceneIsEmpty;
    this.syncButton();
    if (!this.armed) {
      return;
    }
    if (!this.available) {
      this.exit({ resume: 'lazy' });
      return;
    }
    // The geometry under the ghost just changed — drop it now and let the
    // debounce redraw it. Correctness over the flicker.
    this.ghost.clear();
    // A render can put a sketch back in front (live editing) — the armed
    // dialog keeps the free 3D view.
    if (this.sceneSketchActive) {
      this.sketchUI.suspend();
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
    void this.relabeler.refresh(this.axes);
    this.refreshHighlight();
    this.runner.schedulePreview();
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
    this.sketchUI.suspend();
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
    this.runner.schedulePreview();
  }

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
    this.sourceSlot = result.ok && result.feature === 'helix' ? result.source : { kind: 'opaque' };
    this.refreshHighlight();
    // The ghost's keep slot reads `sourceSlot`, which resolves after
    // `enterEdit` already scheduled its preview — re-kick so the kept-source
    // coil appears once the statement's own source is known.
    this.runner.schedulePreview();
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
      this.sketchUI.suspend();
    }
    this.syncButton();
    void this.refreshScopeVariables();
    this.panel.show(this.axes);
    this.syncPickChannels();
    void this.relabeler.refresh(this.axes);
    this.refreshHighlight();
    this.runner.schedulePreview();
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
    this.runner.cancelPreview();
    this.ghost.clear();
    this.viewer.clearHighlight();
    this.viewer.pickFilter = 'all';
    this.viewer.pickSketchWires = false;
    this.viewer.pickAxes = false;
    this.panel.hide();
    this.sketchUI.resume((opts.resume ?? 'immediate') === 'immediate');
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
        const option = axisOptionForShape(shapeId, this.sceneObjects, this.axes);
        if (!option) {
          this.panel.setMessage(AXIS_CONSUMED_MESSAGE);
          return;
        }
        this.pickAxis(option);
        return;
      }
      if (sub.type === 'edge') {
        this.sourceEdgeEntity = toggleEntity(this.sourceEdgeEntity, { shapeId, sub });
        this.panel.setAxisEdgeChip(this.sourceEdgeEntity ? 'Picked edge' : null);
        this.panel.setMessage(null);
        this.refreshHighlight();
        this.runner.schedulePreview();
      }
      return;
    }
    if (sub.type !== 'face') {
      return;
    }
    this.sourceFaceEntity = toggleEntity(this.sourceFaceEntity, { shapeId, sub });
    this.panel.setFaceChip(this.sourceFaceEntity ? 'Picked face' : null);
    this.panel.setMessage(null);
    this.refreshHighlight();
    this.runner.schedulePreview();
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
      const option = axisOptionForLocation(this.axes, obj.sourceLocation);
      if (!option) {
        this.panel.setMessage(AXIS_CONSUMED_MESSAGE);
        return true;
      }
      this.pickAxis(option);
      return true;
    }
    return false;
  }

  /** An offered axis landed in the axis slot (3D or timeline pick). */
  private pickAxis(option: AxisOption): void {
    this.sourceEdgeEntity = null;
    this.panel.selectAxis(option);
    this.panel.setMessage(null);
    this.refreshHighlight();
    this.runner.schedulePreview();
  }

  /**
   * The live geometry for the current form state. Runs off the values the
   * statement preview just validated, so all that is left is to resolve the
   * source slot — and that is where the create and edit dialogs converge: both
   * hand the server an explicit ref, so the endpoint never has to know which
   * mode asked. A slot the ghost can't address (a keep chip over an
   * expression, an armed slot with nothing picked yet) means no ghost.
   */
  private async fetchGhost(signal: AbortSignal): Promise<GhostSolid[] | null> {
    const values = this.panel.values();
    if ('error' in values) {
      return null;
    }
    const source = this.ghostSource();
    if (!source) {
      return null;
    }
    const { mode, newVariables, ...dimensions } = values;
    return fetchFeatureGhost({ feature: 'helix', source, ...dimensions }, signal);
  }

  /** The source the ghost coils around, in the form the kernel resolves. */
  private ghostSource(): GhostHelixSourceRef | null {
    if (this.panel.sourceMode === 'axis') {
      const selection = this.panel.axisSelection();
      if (!selection) {
        return null;
      }
      if (selection.kind === 'standard') {
        return { kind: 'standard', axis: selection.axis };
      }
      if (selection.kind === 'axis') {
        return { kind: 'axis', filePath: selection.option.filePath, line: selection.option.line };
      }
      if (selection.kind === 'edge') {
        // What the apply writes for a picked edge is `axis(<edge>)` — so that
        // is what the ghost coils around, not the edge's own frame.
        const entity = this.sourceEdgeEntity;
        return entity?.sub.type === 'edge'
          ? { kind: 'axis-edge', shapeId: entity.shapeId, index: entity.sub.index }
          : null;
      }
      return this.keptGhostSource();
    }
    const selection = this.panel.faceSelection();
    if (!selection) {
      return null;
    }
    if (selection.kind === 'picked') {
      const entity = this.sourceFaceEntity;
      return entity?.sub.type === 'face'
        ? { kind: 'face', shapeId: entity.shapeId, index: entity.sub.index }
        : null;
    }
    return this.keptGhostSource();
  }

  /**
   * The edited statement's own source, once `loadEditSources` has resolved it.
   * An axis statement travels by call site; a selection travels as the single
   * face or edge it names — and an edge stays an edge here, unlike a fresh
   * pick: `helix(select(edge().circle()))` coils in that circle's frame rather
   * than around it as an axis. Null while the load is still in flight (it
   * re-kicks the preview) or when the argument is an expression the sources
   * query couldn't address.
   */
  private keptGhostSource(): GhostHelixSourceRef | null {
    const slot = this.sourceSlot;
    if (!slot) {
      return null;
    }
    if (slot.kind === 'sketch') {
      return { kind: 'axis', filePath: slot.filePath, line: slot.line };
    }
    // One shape only — the helix source is a single face or edge, and a
    // multi-part selection is a statement the ghost can't stand in for.
    if (slot.kind !== 'entities' || slot.entities.length !== 1) {
      return null;
    }
    const { shapeId, sub } = slot.entities[0];
    return { kind: sub.type, shapeId, index: sub.index };
  }

  /** The source slot's request field, or the message blocking it, or null (kept). */
  private sourceRef(): HelixSourceRef | { error: string } | null {
    if (this.panel.sourceMode === 'axis') {
      const selection = this.panel.axisSelection();
      if (!selection || selection.kind === 'keep') {
        return null;
      }
      return pickedAxisRef(selection, this.sourceEdgeEntity, 'Pick the axis edge first.');
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

  /**
   * The create group is `immune`, so its buttons survive the sketch toolbar's
   * takeover — Extrude and friends must stay reachable to finish a sketch.
   * Helix is not one of them: it is a solid-level feature, so its button hides
   * while a sketch is being edited. An armed session keeps the button (it
   * suspends the sketch UI and doubles as the exit toggle).
   */
  private get buttonVisible(): boolean {
    return this.available && (this.armed || !this.sceneSketchActive);
  }

  private syncButton(): void {
    this.button.setActive(this.armed);
    // Arming/exiting flips the button's visibility too, so the group vote
    // rides along here rather than only on the render path.
    this.navbar.setGroupVisible('create', this.buttonVisible, 'helix');
    this.button.setVisible(this.buttonVisible);
    this.hooks.onActiveChange?.();
  }
}
