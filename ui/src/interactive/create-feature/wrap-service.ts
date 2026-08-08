import {
  applyWrap, applyWrapEdit, fetchFeatureSources, FeatureEditTarget, ParsedFeatureStatement,
  SourceSlotRef, WrapEditOptions,
} from '../../api';
import { toggleEntity } from '../../helpers/entities';
import { EditSession, EditSessionInfo } from '../edit-session';
import { SceneObjectRender, SubSelection } from '../../types';
import { SelectedEntity, Viewer } from '../../viewer';
import { Navbar } from '../../ui/navbar';
import { WrapPanel } from './wrap-panel';
import { FeatureButton } from './feature-button';
import { ApplyRunner } from './apply-runner';
import { SketchUISuspender } from './sketch-suspender';
import { OptionRelabeler, refreshScopeVariables } from './option-relabeler';
import {
  collectSketchProfiles, labelWithSketchNames, optionsSignature, resolveSketchByShapeId, resolveSketchRow,
  SketchProfileOption, sketchWireShapeIds,
} from './sketch-profiles';

type WrapApplyRequest = Parameters<typeof applyWrap>[0];

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
  private button: FeatureButton;
  private armed = false;
  private available = false;
  private options: SketchProfileOption[] = [];
  private sceneObjects: SceneObjectRender[] = [];
  private hasSolid = false;
  private sceneSketchActive = false;
  private sketchUI: SketchUISuspender;
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
  private runner: ApplyRunner<WrapApplyRequest | WrapEditOptions>;
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
      icon: '/icons/wrap.png',
      label: 'Wrap',
      tip: 'Wrap a sketch onto a curved face',
      ariaLabel: 'Wrap a sketch onto a curved face',
      // Anchors the Shell button, which slots in just ahead of Wrap.
      datasetTool: 'wrap',
    });
    this.button.onClick = () => {
      if (this.armed) {
        this.exit();
      } else {
        this.enter();
      }
    };
    this.sketchUI = new SketchUISuspender(viewer, hooks);

    this.panel = new WrapPanel(container);
    this.panel.onApply = () => void this.runner.apply();
    this.panel.onExit = () => this.exit();
    this.panel.onChange = () => {
      this.panel.setMessage(null);
      this.refreshHighlight();
      this.runner.schedulePreview();
    };
    this.panel.onRemoveFace = () => {
      this.faceEntity = null;
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
        ? applyWrapEdit(this.editTarget, { ...(request as WrapEditOptions), ...extras })
        : applyWrap({ ...(request as WrapApplyRequest), ...extras }),
      onApplied: () => this.exit(this.editTarget ? { editEnd: 'apply' } : { resume: 'lazy' }),
      failMessage: () => this.editTarget ? 'Could not apply the edit.' : 'Could not apply the wrap.',
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
   * Face picks are live the whole time the dialog is armed — the click sets
   * the wrap's target face. In edit mode the pick resolves against the
   * rolled-back pre-statement scene.
   */
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
    void this.relabeler.refresh(this.options);
    this.refreshHighlight();
    this.runner.schedulePreview();
  }

  update(sceneObjects: SceneObjectRender[]): void {
    this.sceneObjects = sceneObjects;
    this.options = collectSketchProfiles(sceneObjects);
    this.sceneSketchActive = this.options[0]?.kind === 'active';
    this.hasSolid = sceneObjects.some(o =>
      o.sceneShapes?.some(s => s.shapeType === 'solid' && !s.isMetaShape && !s.isGuide));
    // Offered whenever the scene has a solid to wrap onto — the target face
    // lives on one — and on a blank document (see {@link Viewer.sceneIsEmpty}).
    // The dialog itself explains what else is missing.
    this.available = this.hasSolid || this.viewer.sceneIsEmpty;
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
      this.sketchUI.suspend();
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
    void this.relabeler.refresh(this.options);
    this.refreshHighlight();
    this.runner.schedulePreview();
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
    this.sketchUI.suspend();
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
    this.runner.schedulePreview();
  }

  private async refreshScopeVariables(): Promise<void> {
    const line = this.editTarget?.line ?? null;
    await refreshScopeVariables(line, this.panel,
      () => this.armed && (this.editTarget?.line ?? null) === line);
  }

  /**
   * Current sources of the edited statement: the sketch (for highlighting)
   * and the target face's resolved entities on the pre-statement solids.
   */
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
      this.sketchUI.suspend();
    }
    this.viewer.pickSketchWires = true;
    this.viewer.pickFilter = 'face';
    this.syncButton();
    void this.refreshScopeVariables();
    this.panel.show(this.options);
    void this.relabeler.refresh(this.options);
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
    this.faceEntity = null;
    this.syncButton();
    this.runner.cancelPreview();
    this.viewer.clearHighlight();
    this.viewer.pickFilter = 'all';
    this.viewer.pickSketchWires = false;
    this.panel.hide();
    this.sketchUI.resume((opts.resume ?? 'immediate') === 'immediate');
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
    this.faceEntity = toggleEntity(this.faceEntity, { shapeId, sub });
    this.panel.setFaceChip(this.faceEntity ? 'Picked face' : null);
    this.panel.setMessage(null);
    this.refreshHighlight();
    this.runner.schedulePreview();
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
    this.runner.schedulePreview();
  }

  /** The request for the current form state, or the message blocking it. */
  private buildRequest(): WrapApplyRequest | { error: string } {
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
    this.button.setActive(this.armed);
    this.button.setVisible(this.available);
    // Every armed flip lands here — the Sketch button disables while a
    // create dialog is up.
    this.hooks.onActiveChange?.();
  }
}
