import {
  applyExtrude, applyExtrudeEdit, fetchFeatureGhost, fetchFeatureSources, ExtrudeEditOptions,
  ExtrudeProfileRef, FeatureEditTarget, GhostSolid, ParsedFeatureStatement, SourceSlotRef,
} from '../../api';
import { toggleEntity } from '../../helpers/entities';
import { SceneObjectRender, SourceLocation, SubSelection } from '../../types';
import { SelectedEntity, Viewer } from '../../viewer';
import { Navbar } from '../../ui/navbar';
import { EditSession, EditSessionInfo } from '../edit-session';
import { SolidPickSelection } from '../solid-pick';
import { ExtrudePanel } from './extrude-panel';
import { FeatureButton } from './feature-button';
import { ApplyRunner } from './apply-runner';
import { FeatureGhostOverlay, GhostKind } from './feature-ghost';
import { SketchUISuspender } from './sketch-suspender';
import { OptionRelabeler, refreshScopeVariables } from './option-relabeler';
import { enclosingPartLocOf, ScopeTargetList, scopePartLocation } from './scope-targets';
import {
  collectExtrudeProfiles, labelWithSketchNames, optionsSignature, resolveProfileByShapeId, resolveProfileRow,
  SketchProfileOption, sketchWireShapeIds,
} from './sketch-profiles';

type ExtrudeApplyRequest = Parameters<typeof applyExtrude>[0];

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
 * click sets the extrusion's target (`extrude(<face>, s)`) — its "Up to first
 * face" / "Up to last face" siblings write the literal the kernel resolves
 * (`extrude('first-face', s)`) and pick nothing; otherwise the re-render is
 * the preview and editor undo is the rollback, as on the modify rails.
 */
export class ExtrudeFeatureService {
  private panel: ExtrudePanel;
  private button: FeatureButton;
  private armed = false;
  private available = false;
  private options: SketchProfileOption[] = [];
  private sceneObjects: SceneObjectRender[] = [];
  private hasSolid = false;
  private sceneSketchActive = false;
  /** The picked up-to-face target ("Up to face" direction, both modes). */
  private toFaceEntity: SelectedEntity | null = null;
  /** The `.scope(…)` targets, part-restricted whole-solid picks. */
  private scope = new ScopeTargetList();
  /** The edited statement's enclosing part — the scope picker's restriction. */
  private editPartLoc: SourceLocation | null = null;
  /** The shared whole-solid highlight (the scope chips' viewport echo). */
  private solidPick: SolidPickSelection;
  /** A full render arrived mid-session — a re-picked face's shape id died. */
  private editSceneStale = false;
  /** Statement being edited in place (timeline double-click), or null. */
  private editTarget: FeatureEditTarget | null = null;
  /** View-state half of edit mode: pre-statement rollback + boundary. */
  private session = new EditSession();
  /** The statement's current profile source, for highlighting the keep slot. */
  private sourceProfile: SourceSlotRef | null = null;
  /** The statement's current to-face target, for highlighting its keep chip. */
  private sourceToFace: SourceSlotRef | null = null;
  private sketchUI: SketchUISuspender;
  /** The translucent body the current values would build, drawn in the view. */
  private ghost: FeatureGhostOverlay;
  private runner: ApplyRunner<ExtrudeApplyRequest | ExtrudeEditOptions>;
  private relabeler: OptionRelabeler<SketchProfileOption[]>;

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
    this.button = new FeatureButton(group, {
      icon: '/icons/extrude.png',
      label: 'Extrude',
      tip: 'Extrude a sketch',
      ariaLabel: 'Extrude a sketch',
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
    this.solidPick = new SolidPickSelection(viewer, { multiple: true });

    this.panel = new ExtrudePanel(container);
    this.panel.onApply = () => void this.runner.apply();
    this.panel.onExit = () => this.exit();
    this.panel.onChange = () => {
      this.panel.setMessage(null);
      this.syncFacePickMode();
      // The profile choice drives the scope's part restriction (producers
      // win — the statement inserts in the profile's scope).
      this.refreshScope();
      this.runner.schedulePreview();
    };
    this.panel.onRemoveFace = () => {
      this.toFaceEntity = null;
      this.panel.setFaceChip(null);
      this.panel.setMessage(null);
      this.refreshHighlight();
      this.runner.schedulePreview();
    };
    this.panel.onRemoveScope = (index) => {
      this.scope.removeAt(index);
      this.panel.setMessage(null);
      this.refreshScope();
      this.runner.schedulePreview();
    };
    this.panel.onArmedPickChange = () => this.syncFacePickMode();

    this.runner = new ApplyRunner({
      panel: this.panel,
      isArmed: () => this.armed,
      build: () => this.editTarget ? this.buildEditRequest() : this.buildRequest(),
      send: (request, extras) => this.editTarget
        ? applyExtrudeEdit(this.editTarget, { ...(request as ExtrudeEditOptions), ...extras })
        : applyExtrude({ ...(request as ExtrudeApplyRequest), ...extras }),
      onApplied: () => this.exit(this.editTarget ? { editEnd: 'apply' } : { resume: 'lazy' }),
      failMessage: () => this.editTarget ? 'Could not apply the edit.' : 'Could not apply the extrude.',
      // An empty sketch blocks Apply but not the preview — the would-be
      // statement still shows with nothing in the profile yet.
      validateApply: () => {
        const option = this.editTarget ? null : this.panel.selectedOption();
        return option && !option.hasGeometry ? { error: 'Draw a profile in the sketch first.' } : null;
      },
      // Create-mode distance previews stay quiet — transient failures would
      // flash while sketching. The statement changed shape under the dialog
      // (an undo, a concurrent edit) or the picked target face has no safe
      // selector — those surface before Apply.
      surfacePreviewReasons: () => this.editTarget !== null || this.panel.isToFace(),
      // The statement preview's geometric twin: the prism the values describe,
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
      sign: optionsSignature,
      load: labelWithSketchNames,
      isArmed: () => this.armed,
      apply: (options) => {
        this.options = options;
        this.panel.setOptions(options);
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
   * Face picks are live while the dialog's direction is "Up to face" — the
   * click sets the extrusion's target face. In edit mode the pick resolves
   * against the rolled-back pre-statement scene (the loft edit behavior).
   * The armed scope slot takes the clicks over instead (whole-solid picks).
   */
  get isFacePicking(): boolean {
    return this.armed && this.panel.isToFace() && !this.panel.scopePickArmed;
  }

  /** The scope slot is armed — face/edge clicks toggle whole scope solids. */
  get isScopePicking(): boolean {
    return this.armed && this.panel.scopePickArmed;
  }

  /** True while an edit session has suspended sketch editing. */
  get sketchUISuspended(): boolean {
    return this.sketchUI.suspended;
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
      // Mid-flight to the boundary — whatever the ghost was drawn against is
      // already gone from the view.
      this.ghost.clear();
      if (!isRollback) {
        this.sourceProfile = null;
        this.editSceneStale = true;
      }
      return;
    }
    // At the boundary: rebuild options from the pre-statement scene. A keep
    // chip whose argument named a statement becomes that statement's option.
    this.ghost.clear();
    this.sceneObjects = sceneObjects;
    this.options = collectExtrudeProfiles(sceneObjects);
    this.scope.setScene(sceneObjects, this.scopePartLoc(), { resolveKeeps: true });
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
    this.viewer.pickProfileWires = true;
    this.panel.setOptions(this.options);
    this.syncFacePickMode();
    if (!this.sourceProfile) {
      void this.loadEditSources();
    }
    void this.relabeler.refresh(this.options);
    this.panel.setScopeChips(this.scope.chips());
    this.refreshHighlight();
    this.runner.schedulePreview();
  }

  /**
   * Scene re-rendered: recompute the offered profiles and button visibility.
   * The dialog stays open across re-renders.
   */
  update(sceneObjects: SceneObjectRender[]): void {
    this.sceneObjects = sceneObjects;
    this.options = collectExtrudeProfiles(sceneObjects);
    this.sceneSketchActive = this.options[0]?.kind === 'active';
    this.hasSolid = sceneObjects.some(o =>
      o.sceneShapes?.some(s => s.shapeType === 'solid' && !s.isMetaShape && !s.isGuide));
    // Offered whenever the scene has anything to work from — like Loft. With
    // no unconsumed sketch the dialog opens on a placeholder dropdown, which
    // is also what a blank document gets (see {@link Viewer.sceneIsEmpty}):
    // there the whole toolbar shows rather than three buttons.
    this.available = this.hasSolid || this.options.length > 0 || this.viewer.sceneIsEmpty;
    // The group is shared with the Sketch button — vote via our own slot and
    // hide our own button; the group shows while either contributor needs it.
    this.navbar.setGroupVisible('create', this.available, 'extrude');
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
    // Shape ids changed with the render — a picked target face is stale and
    // drops back to the pick prompt (the loft behavior). Chosen scope solids
    // re-match by source line instead.
    if (this.toFaceEntity) {
      this.toFaceEntity = null;
      this.panel.setFaceChip(null);
    }
    this.scope.setScene(sceneObjects, this.scopePartLoc());
    this.viewer.pickSketchWires = true;
    this.viewer.pickProfileWires = true;
    this.panel.setOptions(this.options);
    this.syncFacePickMode();
    void this.relabeler.refresh(this.options);
    this.panel.setScopeChips(this.scope.chips());
    this.refreshHighlight();
    this.runner.schedulePreview();
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
    // The statement's enclosing part restricts the scope picker — derived
    // from the pre-rollback scene, where the edited row still renders.
    this.editPartLoc = enclosingPartLocOf(target, this.sceneObjects);
    this.scope.seedKeeps(parsed, target.filePath);
    this.syncButton();
    this.sketchUI.suspend();
    this.viewer.pickSketchWires = true;
    this.viewer.pickProfileWires = true;
    this.session.begin({ ...info, target });
    void this.loadEditSources();
    void this.refreshScopeVariables();
    this.panel.showEdit({
      op: parsed.op,
      distance: parsed.distance,
      distance2: parsed.distance2,
      symmetric: parsed.symmetric,
      draft: parsed.draft,
      endOffset: parsed.endOffset,
      drill: parsed.drill,
      thin: parsed.thin,
      profileLabel: parsed.profileText,
      toFaceLabel: parsed.toFaceText,
      toFaceKind: parsed.toFaceKind,
    });
    this.panel.setScopeChips(this.scope.chips());
    this.syncFacePickMode();
    this.runner.schedulePreview();
  }

  private async refreshScopeVariables(): Promise<void> {
    const line = this.editTarget?.line ?? null;
    await refreshScopeVariables(line, this.panel,
      () => this.armed && (this.editTarget?.line ?? null) === line);
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
    // The ghost's keep-profile path reads `sourceProfile`, which resolves
    // after `enterEdit` already scheduled its preview — re-kick so the ghost
    // appears now that the statement's own sketch is known.
    this.runner.schedulePreview();
  }

  enter(): void {
    if (this.armed) {
      return;
    }
    this.session.end('continue');
    this.hooks.onEnter?.();
    this.armed = true;
    this.toFaceEntity = null;
    this.scope.clear();
    this.editPartLoc = null;
    // Composing the extrude — and looking over its ghost preview — means the
    // whole scene, not the view down the active sketch plane: leave sketch
    // editing right away (resumed on cancel; an apply's re-render takes over).
    if (this.sceneSketchActive) {
      this.sketchUI.suspend();
    }
    // Clicking a sketch's wires in the 3D view selects it as the profile.
    this.viewer.pickSketchWires = true;
    this.viewer.pickProfileWires = true;
    this.syncButton();
    void this.refreshScopeVariables();
    this.panel.show(this.options);
    // The direction select persists across sessions — re-arm face picking
    // when the dialog reopens on "Up to face".
    this.syncFacePickMode();
    void this.relabeler.refresh(this.options);
    this.refreshScope();
    this.runner.schedulePreview();
  }

  /**
   * `resume: 'lazy'` re-enables sketch editing without forcing the mode
   * transition — for apply-success and scene-driven exits, where a render
   * follows. User cancels default to `'immediate'` (a create-mode
   * suspension has no follow-up render to resume it); ending an edit
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
    this.scope.clear();
    this.editPartLoc = null;
    this.solidPick.set([]);
    this.editSceneStale = false;
    this.viewer.pickFilter = 'all';
    this.viewer.pickSketchWires = false;
    this.viewer.pickProfileWires = false;
    this.viewer.clearHighlight();
    this.syncButton();
    this.runner.cancelPreview();
    // The overlay is a compiledMesh sibling, so no render tears it down —
    // every way out of the dialog (apply, cancel, scene-driven) lands here.
    this.ghost.clear();
    this.panel.hide();
    this.sketchUI.resume((opts.resume ?? 'immediate') === 'immediate');
  }

  /**
   * Highlight the selected profile's wires — and the picked up-to-face
   * target — in the 3D view. The active sketch is skipped in create mode
   * (the shared create-dialog behavior): it is the default selection, drawn
   * front and center in the suspended view already. An edit session's keep
   * entry lights up the statement's own profile via the resolved current
   * source.
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
    // The chosen scope solids ride the same pass, highlighted whole.
    this.solidPick.set(this.scope.shapeIds());
    this.solidPick.refreshHighlight({ entities: faces, wireIds });
  }

  /**
   * The part the scope picker is restricted to: the edited statement's own
   * enclosing part, or — create mode — the chosen profile's (producers win:
   * the new statement inserts in the profile's scope), falling back to the
   * timeline's active part. Null offers top-level solids only.
   */
  private scopePartLoc(): SourceLocation | null {
    if (this.editTarget) {
      return this.editPartLoc;
    }
    const option = this.panel.selectedOption();
    return scopePartLocation(option ? { filePath: option.filePath, line: option.line } : null, this.sceneObjects);
  }

  /** Recompute the offered scope solids, the chips and the highlight. */
  private refreshScope(): void {
    if (!this.armed) {
      return;
    }
    this.scope.setScene(this.sceneObjects, this.scopePartLoc());
    this.panel.setScopeChips(this.scope.chips());
    this.refreshHighlight();
  }

  private syncButton(): void {
    this.button.setActive(this.armed);
    this.button.setVisible(this.available);
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
    const sketch = resolveProfileRow(obj, this.sceneObjects);
    if (sketch?.sourceLocation) {
      this.pickSketch(sketch);
      return true;
    }
    // A solid row toggles it in the scope list — unambiguous, so no arming
    // is needed. Rows outside the scope's part fall through untouched.
    const option = this.scope.optionForRow(obj);
    if (option && this.scopeOffered()) {
      this.toggleScope(option);
      return true;
    }
    return false;
  }

  /** A sketch wire was clicked in the 3D view: selects it as the profile. */
  handleSketchPick(shapeId: string): boolean {
    if (!this.armed) {
      return false;
    }
    const sketch = resolveProfileByShapeId(shapeId, this.sceneObjects);
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
    this.runner.schedulePreview();
  }

  /**
   * Routes viewer clicks: with the scope slot armed, any face or edge click
   * selects the owning solid whole and toggles it in the scope list; while
   * face picking is live instead, a face click sets the up-to-face target
   * (clicking the picked face again clears it). Empty-space clicks keep both.
   */
  handleClick(shapeId: string | null, sub: SubSelection): void {
    if (this.isScopePicking) {
      if (!shapeId || !sub || (sub.type !== 'face' && sub.type !== 'edge')) {
        return;
      }
      const option = this.scope.optionForShapeId(shapeId);
      if (!option) {
        this.panel.setMessage('That shape cannot scope the boolean — pick a solid in the same part.');
        return;
      }
      this.toggleScope(option);
      return;
    }
    if (!this.isFacePicking || !shapeId || !sub || sub.type !== 'face') {
      return;
    }
    this.toFaceEntity = toggleEntity(this.toFaceEntity, { shapeId, sub });
    this.panel.setFaceChip(this.toFaceEntity ? 'Picked face' : null);
    this.panel.setMessage(null);
    this.refreshHighlight();
    this.runner.schedulePreview();
  }

  /** The scope section applies at all — hidden outright on the New op. */
  private scopeOffered(): boolean {
    return this.panel.op !== 'new';
  }

  /** Toggle a solid scope chip (viewport or timeline pick). */
  private toggleScope(option: NonNullable<ReturnType<ScopeTargetList['optionForRow']>>): void {
    this.scope.toggle(option);
    this.panel.setMessage(null);
    this.refreshScope();
    this.runner.schedulePreview();
  }

  /**
   * The viewer's pick mode follows the armed slot: "Up to face" picks faces
   * only; the armed scope slot opens everything — any face or edge click
   * resolves to its owning solid. (The sketch suspension is owned by
   * enter/exit — the dialog holds the free 3D view for its whole lifetime.)
   */
  private syncFacePickMode(): void {
    if (!this.armed) {
      return;
    }
    this.viewer.pickFilter = this.isFacePicking ? 'face' : 'all';
  }

  /** Green while the extrusion adds material, red while it cuts. */
  private ghostKind(): GhostKind {
    const values = this.panel.values();
    return !('error' in values) && values.op === 'remove' ? 'remove' : 'add';
  }

  /**
   * The live geometry for the current form state. Runs off the values the
   * statement preview just validated, so the only thing left to resolve is
   * the profile — and that is where the create and edit dialogs converge:
   * both hand the server an explicit `{filePath, line}`, so the endpoint
   * never has to know which mode asked.
   */
  private async fetchGhost(signal: AbortSignal): Promise<GhostSolid[] | null> {
    // The up-to-face modes end on scene geometry, which the ghost doesn't
    // resolve yet — they simply show none.
    if (this.panel.isToFace() || this.panel.faceTarget()) {
      return null;
    }
    const values = this.panel.values();
    if ('error' in values) {
      return null;
    }
    const profile = this.ghostProfile();
    if (!profile) {
      return null;
    }
    return fetchFeatureGhost({
      feature: 'extrude',
      op: values.op,
      distance: values.distance,
      distance2: values.distance2,
      symmetric: values.symmetric,
      draft: values.draft,
      endOffset: values.endOffset,
      drill: values.drill,
      thin: values.thin,
      profile,
    }, signal);
  }

  /** The sketch the ghost extrudes, or null while there is nothing to sweep. */
  private ghostProfile(): { filePath: string; line: number } | null {
    if (this.editTarget) {
      const selection = this.panel.profileSelection();
      if (selection?.kind === 'sketch') {
        return { filePath: selection.option.filePath, line: selection.option.line };
      }
      // The keep chip: the statement's own profile, once `loadEditSources`
      // has resolved it. Null while that is still in flight (the load
      // re-kicks the preview) or when the argument is an expression the
      // sources query couldn't address.
      return this.sourceProfile?.kind === 'sketch'
        ? { filePath: this.sourceProfile.filePath, line: this.sourceProfile.line }
        : null;
    }
    const option = this.panel.selectedOption();
    // An empty sketch blocks Apply but not the statement preview — and it has
    // no region to sweep, so it has no ghost either.
    if (!option || !option.hasGeometry) {
      return null;
    }
    return { filePath: option.filePath, line: option.line };
  }

  /** The create request for the current form state, or the blocking message. */
  private buildRequest(): ExtrudeApplyRequest | { error: string } {
    const values = this.panel.values();
    if ('error' in values) {
      return values;
    }
    const option = this.panel.selectedOption();
    if (!option) {
      return { error: 'No sketch to extrude.' };
    }
    return {
      ...values,
      profile: profileRef(option),
      toFace: this.panel.faceTarget()
        ?? (this.panel.isToFace() ? this.toFaceEntity ?? undefined : undefined),
      // A separate body has no boolean to scope — the hidden section's picks
      // stay parked in case the user switches back.
      scope: values.op === 'new' ? undefined : this.scope.createRefs(),
    };
  }

  /**
   * The edit-mode apply payload: the form values plus the session fields —
   * the staleness guard, the re-sourced profile when the slot moved off its
   * "Current: …" entry, and the to-face target while one of those directions
   * is selected — `keep` for the statement's own target, a face pick (with
   * the boundary it resolves against) for a re-pick, the literal for
   * first/last-face. No toFace field means the distance form.
   */
  private buildEditRequest(): ExtrudeEditOptions | { error: string } {
    const values = this.panel.values();
    if ('error' in values) {
      return values;
    }
    const selection = this.panel.profileSelection();
    const profile = selection?.kind === 'sketch'
      ? {
        mode: 'bound' as const,
        feature: selection.option.feature === 'offset' ? 'offset' as const : undefined,
        filePath: selection.option.filePath,
        line: selection.option.line,
        column: selection.option.column,
      }
      : undefined;
    let toFace: ExtrudeEditOptions['toFace'];
    const faceTarget = this.panel.faceTarget();
    if (faceTarget) {
      toFace = { kind: faceTarget };
    } else if (this.panel.isToFace()) {
      toFace = this.toFaceEntity
        ? { kind: 'face', entity: this.toFaceEntity }
        : { kind: 'keep' };
    }
    return {
      ...values,
      expectedStatement: this.session.expectedStatement,
      before: toFace?.kind === 'face' ? this.session.boundary ?? undefined : undefined,
      profile,
      toFace,
      // The dialog owns the chain it shows: the full list on Add/Remove, and
      // an explicit drop on New — `.new()` resets the fusion scope, so a
      // statement rewritten to a separate body must not keep one.
      scope: values.op === 'new' ? [] : this.scope.editRefs(),
    };
  }
}

function profileRef(option: SketchProfileOption): ExtrudeProfileRef {
  return {
    mode: option.kind === 'active' ? 'active' : 'bound',
    feature: option.feature === 'offset' ? 'offset' : undefined,
    filePath: option.filePath,
    line: option.line,
    column: option.column,
  };
}
