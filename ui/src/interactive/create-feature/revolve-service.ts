import {
  applyRevolve, applyRevolveEdit, fetchFeatureGhost, fetchFeatureSources, FeatureEditTarget,
  GhostAxisRef, GhostSolid, ParsedFeatureStatement, RevolveApplyOptions, RevolveAxisRef,
  RevolveEditOptions, SourceSlotRef,
} from '../../api';
import { toggleEntity } from '../../helpers/entities';
import { SceneObjectRender, SubSelection } from '../../types';
import { SelectedEntity, Viewer } from '../../viewer';
import { Navbar } from '../../ui/navbar';
import { EditSession, EditSessionInfo } from '../edit-session';
import { RevolvePanel } from './revolve-panel';
import { FeatureButton } from './feature-button';
import { FeatureGhostOverlay, GhostKind } from './feature-ghost';
import { ApplyRunner } from './apply-runner';
import { SketchUISuspender } from './sketch-suspender';
import { OptionRelabeler, refreshScopeVariables } from './option-relabeler';
import {
  collectSketchProfiles, labelWithSketchNames, optionsSignature, resolveSketchByShapeId, resolveSketchRow,
  SketchProfileOption, sketchWireShapeIds,
} from './sketch-profiles';
import {
  AXIS_CONSUMED_MESSAGE, AxisOption, axisLineShapeIds, axisOptionForLocation, axisOptionForShape,
  axisOptionsSignature, collectAxisOptions, labelWithAxisNames, pickedAxisRef,
} from './axis-options';

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
  private button: FeatureButton;
  private armed = false;
  private available = false;
  private profiles: SketchProfileOption[] = [];
  private axes: AxisOption[] = [];
  private sceneObjects: SceneObjectRender[] = [];
  private hasSolid = false;
  private sceneSketchActive = false;
  private sketchUI: SketchUISuspender;
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
  private runner: ApplyRunner<RevolveApplyOptions | Parameters<typeof applyRevolveEdit>[1]>;
  private relabeler: OptionRelabeler<{ profiles: SketchProfileOption[]; axes: AxisOption[] }>;
  /** The translucent body the current values would sweep. */
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
      icon: '/icons/revolve.png',
      label: 'Revolve',
      tip: 'Revolve a sketch around an axis',
      ariaLabel: 'Revolve a sketch around an axis',
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

    this.panel = new RevolvePanel(container);
    this.panel.onApply = () => void this.runner.apply();
    this.panel.onExit = () => this.exit();
    this.panel.onChange = () => {
      this.panel.setMessage(null);
      this.refreshHighlight();
      this.runner.schedulePreview();
    };
    this.panel.onAxisModeChange = () => {
      // The slot left edge mode (✕, a standard/axis choice) — the entity
      // would otherwise silently ride along into the next edge state.
      this.axisEdgeEntity = null;
      this.refreshHighlight();
    };
    this.panel.onArmedSlotChange = () => this.syncPickChannels();

    this.runner = new ApplyRunner({
      panel: this.panel,
      isArmed: () => this.armed,
      build: () => this.editTarget ? this.buildEditRequest() : this.buildRequest(),
      send: (request, extras) => this.editTarget
        ? applyRevolveEdit(this.editTarget, { ...(request as Parameters<typeof applyRevolveEdit>[1]), ...extras })
        : applyRevolve({ ...(request as RevolveApplyOptions), ...extras }),
      onApplied: () => this.exit(this.editTarget ? { editEnd: 'apply' } : { resume: 'lazy' }),
      failMessage: () => this.editTarget ? 'Could not apply the edit.' : 'Could not apply the revolve.',
      // The statement preview's geometric twin: the body the values describe,
      // drawn translucent in the viewport. Same debounce, same abort scope.
      ghost: {
        fetch: (_request, signal) => this.fetchGhost(signal),
        apply: (solids) => {
          if (solids) {
            this.ghost.set(solids, this.ghostKind());
          } else {
            this.ghost.clear();
          }
        },
      },
    });
    this.relabeler = new OptionRelabeler({
      sign: ({ profiles, axes }) => `${optionsSignature(profiles)}#${axisOptionsSignature(axes)}`,
      load: async ({ profiles, axes }) => {
        const [labeledProfiles, labeledAxes] = await Promise.all([
          labelWithSketchNames(profiles),
          labelWithAxisNames(axes),
        ]);
        return { profiles: labeledProfiles, axes: labeledAxes };
      },
      isArmed: () => this.armed,
      apply: ({ profiles, axes }) => {
        this.profiles = profiles;
        this.axes = axes;
        this.panel.setOptions(profiles, axes);
      },
    });
  }

  get isActive(): boolean {
    return this.armed;
  }

  /** The toolbar button, mirrored into the Finish Sketch grid during sketch mode. */
  get toolbarButton(): FeatureButton {
    return this.button;
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
    return this.sketchUI.suspended;
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
    this.runner.schedulePreview();
  }

  update(sceneObjects: SceneObjectRender[]): void {
    this.sceneObjects = sceneObjects;
    this.profiles = collectSketchProfiles(sceneObjects);
    this.axes = collectAxisOptions(sceneObjects);
    this.hasSolid = sceneObjects.some(o =>
      o.sceneShapes?.some(s => s.shapeType === 'solid' && !s.isMetaShape && !s.isGuide));
    this.sceneSketchActive = this.profiles[0]?.kind === 'active';
    // Offered whenever the scene has anything to work from — like Extrude —
    // and on a blank document (see {@link Viewer.sceneIsEmpty}).
    this.available = this.hasSolid || this.profiles.length > 0 || this.viewer.sceneIsEmpty;
    this.navbar.setGroupVisible('create', this.available, 'revolve');
    this.syncButton();
    if (!this.armed) {
      return;
    }
    // The geometry under the ghost just changed — drop it now and let the
    // debounce redraw it. Correctness over the flicker.
    this.ghost.clear();
    if (!this.available) {
      this.exit({ resume: 'lazy' });
      return;
    }
    // A render can put a sketch back in front (live editing) — the armed
    // dialog keeps the free 3D view.
    if (this.sceneSketchActive) {
      this.sketchUI.suspend();
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
    this.runner.schedulePreview();
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
    this.sketchUI.suspend();
    this.session.begin({ ...info, target });
    void this.loadEditSources();
    void this.refreshScopeVariables();
    this.panel.showEdit({
      op: parsed.op,
      angle: parsed.angle ?? 360,
      symmetric: parsed.symmetric,
      thin: parsed.thin,
      axisLabel: parsed.axisText,
      profileLabel: parsed.profileText,
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
    this.sourceSlots = result.ok && result.feature === 'revolve'
      ? { profile: result.profile, axis: result.axis }
      : { profile: { kind: 'opaque' }, axis: { kind: 'opaque' } };
    this.refreshHighlight();
    // The ghost's keep slots read `sourceSlots`, which resolves after
    // `enterEdit` already scheduled its preview — re-kick so the ghost
    // appears now that the statement's own profile and axis are known.
    this.runner.schedulePreview();
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
      this.sketchUI.suspend();
    }
    this.syncButton();
    void this.refreshScopeVariables();
    this.panel.show(this.profiles, this.axes);
    this.syncPickChannels();
    this.refreshLabels();
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
    this.editSceneStale = false;
    this.axisEdgeEntity = null;
    this.syncButton();
    this.runner.cancelPreview();
    // The overlay is a compiledMesh sibling, so no render tears it down —
    // every way out of the dialog (apply, cancel, scene-driven) lands here.
    this.ghost.clear();
    this.viewer.clearHighlight();
    this.viewer.pickFilter = 'all';
    this.viewer.pickSketchWires = false;
    this.viewer.pickAxes = false;
    this.panel.hide();
    this.sketchUI.resume((opts.resume ?? 'immediate') === 'immediate');
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
      const option = axisOptionForShape(shapeId, this.sceneObjects, this.axes);
      if (!option) {
        this.panel.setMessage(AXIS_CONSUMED_MESSAGE);
        return;
      }
      this.pickAxis(option);
      return;
    }
    if (sub.type !== 'edge') {
      return;
    }
    this.axisEdgeEntity = toggleEntity(this.axisEdgeEntity, { shapeId, sub });
    this.panel.setAxisEdgeChip(this.axisEdgeEntity ? 'Picked edge' : null);
    this.panel.setMessage(null);
    this.refreshHighlight();
    this.runner.schedulePreview();
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
      const option = axisOptionForLocation(this.axes, obj.sourceLocation);
      if (!option) {
        this.panel.setMessage(AXIS_CONSUMED_MESSAGE);
        return true;
      }
      this.pickAxis(option);
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

  /** An offered axis landed in the axis slot (3D or timeline pick). */
  private pickAxis(option: AxisOption): void {
    this.axisEdgeEntity = null;
    this.panel.selectAxis(option);
    this.panel.setMessage(null);
    this.refreshHighlight();
    this.runner.schedulePreview();
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
    this.runner.schedulePreview();
  }

  /** Green while the revolution adds material, red while it cuts. */
  private ghostKind(): GhostKind {
    const values = this.panel.values();
    return !('error' in values) && values.op === 'remove' ? 'remove' : 'add';
  }

  /**
   * The live geometry for the current form state. Runs off the values the
   * statement preview just validated, so all that is left is to resolve the
   * two slots — and that is where the create and edit dialogs converge: both
   * hand the server explicit refs, so the endpoint never has to know which
   * mode asked. A slot the ghost can't address (a keep chip over an
   * expression, an armed edge slot with nothing picked yet) means no ghost.
   */
  private async fetchGhost(signal: AbortSignal): Promise<GhostSolid[] | null> {
    const values = this.panel.values();
    if ('error' in values) {
      return null;
    }
    const profile = this.ghostProfile();
    const axis = this.ghostAxis();
    if (!profile || !axis) {
      return null;
    }
    return fetchFeatureGhost({
      feature: 'revolve',
      op: values.op,
      angle: values.angle,
      symmetric: values.symmetric,
      thin: values.thin,
      profile,
      axis,
    }, signal);
  }

  /** The sketch the ghost revolves, or null while there is nothing to sweep. */
  private ghostProfile(): { filePath: string; line: number } | null {
    if (this.editTarget) {
      const selection = this.panel.profileSelection();
      if (selection?.kind === 'sketch') {
        return selection.option.hasGeometry
          ? { filePath: selection.option.filePath, line: selection.option.line }
          : null;
      }
      // The keep chip: the statement's own profile, once `loadEditSources`
      // has resolved it. Null while that is still in flight (the load
      // re-kicks the preview) or when the argument is an expression the
      // sources query couldn't address.
      return this.sourceSlots?.profile.kind === 'sketch'
        ? { filePath: this.sourceSlots.profile.filePath, line: this.sourceSlots.profile.line }
        : null;
    }
    const option = this.panel.selectedProfile();
    // An empty sketch blocks Apply but not the statement preview — and it has
    // no region to sweep, so it has no ghost either.
    if (!option || !option.hasGeometry) {
      return null;
    }
    return { filePath: option.filePath, line: option.line };
  }

  /** The axis the ghost sweeps around, in the form the kernel resolves. */
  private ghostAxis(): GhostAxisRef | null {
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
      const entity = this.axisEdgeEntity;
      return entity?.sub.type === 'edge'
        ? { kind: 'edge', shapeId: entity.shapeId, index: entity.sub.index }
        : null;
    }
    // Keep: the statement's own axis, which resolves to an `axis()` call site
    // or to nothing the ghost can address (a standard literal reads as the
    // standard selection above, never as keep).
    return this.sourceSlots?.axis.kind === 'sketch'
      ? { kind: 'axis', filePath: this.sourceSlots.axis.filePath, line: this.sourceSlots.axis.line }
      : null;
  }

  /** The axis slot's request field, or the message blocking it. */
  private axisRef(): RevolveAxisRef | { error: string } | null {
    const selection = this.panel.axisSelection();
    if (!selection || selection.kind === 'keep') {
      return null;
    }
    return pickedAxisRef(selection, this.axisEdgeEntity, 'Pick the axis edge first.');
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
      symmetric: values.symmetric,
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
      symmetric: values.symmetric,
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

  /**
   * Async label pass: sketches and axes bound to variables show their names
   * ("profile — line 3", "ringAxis — line 5"). Applied only if the dialog is
   * still armed on the same option sets when the lookups land.
   */
  private refreshLabels(): void {
    void this.relabeler.refresh({ profiles: this.profiles, axes: this.axes });
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
    this.button.setActive(this.armed);
    this.button.setVisible(this.available);
    // Every armed flip lands here — the Sketch button disables while a
    // create dialog is up.
    this.hooks.onActiveChange?.();
  }
}
