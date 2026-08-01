import {
  applyRepeat, applyRepeatEdit, FeatureEditTarget, ParsedFeatureStatement,
  RepeatApplyOptions, RepeatDirectionRef, RepeatEditAxisRef, RepeatEditOptions, RepeatEditPlaneRef,
  RepeatEditTargetRef,
} from '../../api';
import { toggleEntity } from '../../helpers/entities';
import { SceneObjectRender, SubSelection } from '../../types';
import { SelectedEntity, Viewer } from '../../viewer';
import { StandardPlaneId } from '../../scene/standard-planes';
import { Navbar } from '../../ui/navbar';
import { EditSession, EditSessionInfo } from '../edit-session';
import { RepeatDirection, RepeatPanel } from './repeat-panel';
import { FeatureButton } from './feature-button';
import { ApplyRunner } from './apply-runner';
import { SketchUISuspender } from './sketch-suspender';
import { OptionRelabeler, refreshScopeVariables } from './option-relabeler';
import { collectRepeatTargets, RepeatTargetOption, resolveRepeatTargetRow } from './repeat-targets';
import {
  AXIS_CONSUMED_MESSAGE, AxisOption, axisLineShapeIds, axisOptionForLocation, axisOptionForShape,
  axisOptionsSignature, collectAxisOptions, labelWithAxisNames, pickedAxisRef,
} from './axis-options';
import {
  PLANE_UNAVAILABLE_MESSAGE, collectPlaneOptions, labelWithPlaneNames, PlaneOption,
  planeOptionForLocation, planeOptionForShape, planeOptionsSignature, resolvePlaneByShapeId,
} from './plane-bases';
import { collectSketchProfiles, sourceChip } from './sketch-profiles';

/** What the seeding hook hands over when the dialog arms. */
export type RepeatEnterSeed = {
  /** The neutral-mode selection (faces/edges) at activation. */
  seed: SelectedEntity[];
  /** The neutral-mode pending plane quad (a clicked plane feature), if any. */
  pendingPlaneShapeId: string | null;
};

/**
 * One chosen target: a timeline-picked feature statement, or — edit mode
 * only — a kept statement target by its position in the parsed
 * `targetTexts`, preserved verbatim. A keep whose expression resolved to a
 * feature statement carries that statement's location (`loc`): it converts
 * into its timeline-row option at the rollback boundary, so the chip shows
 * the feature's own label and the row click toggles it like create mode.
 */
type RepeatTargetChoice =
  | { kind: 'option'; option: RepeatTargetOption }
  | { kind: 'keep'; sourceIndex: number; label: string; loc?: { filePath: string; line: number; column: number } };

/**
 * The Repeat dialog on the create rails: replay one or more timeline
 * features linearly, circularly, mirrored across a plane, or rotated. The
 * features are picked ONLY in the timeline (each row click toggles a
 * numbered chip); the axis comes from the X/Y/Z quick buttons, an axis
 * statement (its dashed line in 3D or its timeline row), or a picked solid
 * edge; the mirror plane from an origin-plane quad, a plane feature (its
 * quad or timeline row), or a picked face. Arming with a selection already
 * highlighted seeds the dialog: one edge opens the Linear type with the edge
 * as the axis, one face (or a pending plane) the Mirror type with it as the
 * plane. Apply writes `repeat('<kind>', …)` — the re-render is the preview,
 * editor undo the rollback. No live geometry preview in this version.
 */
export class RepeatFeatureService {
  private panel: RepeatPanel;
  private button: FeatureButton;
  private armed = false;
  private available = false;
  private targetOptions: RepeatTargetOption[] = [];
  /** The chosen targets, kept in timeline order — the repeat's argument order. */
  private targets: RepeatTargetChoice[] = [];
  private axes: AxisOption[] = [];
  private planes: PlaneOption[] = [];
  private sceneObjects: SceneObjectRender[] = [];
  private sceneSketchActive = false;
  private sketchUI: SketchUISuspender;
  /** Per-direction picked axis edges (the axis slots' `edge` mode). */
  private axisEdgeEntities = new Map<RepeatDirection, SelectedEntity | null>([[1, null], [2, null]]);
  /** The picked mirror face (the plane slot's `face` mode), or null. */
  private planeFaceEntity: SelectedEntity | null = null;
  /** Statement being edited in place (timeline double-click), or null. */
  private editTarget: FeatureEditTarget | null = null;
  /** The parsed statement the edit dialog opened over (keep-slot texts). */
  private editStatement: Extract<ParsedFeatureStatement, { feature: 'repeat' }> | null = null;
  /** View-state half of edit mode: pre-statement rollback + boundary. */
  private session = new EditSession();
  /** A full render arrived mid-session — re-picked shape ids died. */
  private editSceneStale = false;
  private runner: ApplyRunner<RepeatApplyOptions | RepeatEditOptions>;
  private relabeler: OptionRelabeler<{ axes: AxisOption[]; planes: PlaneOption[] }>;

  constructor(
    container: HTMLElement,
    private viewer: Viewer,
    private navbar: Navbar,
    private hooks: {
      /** May return the current selection state — it seeds the dialog. */
      onEnter?: () => RepeatEnterSeed | void;
      /** Armed or disarmed — lets the Sketch button owner re-check `isActive`. */
      onActiveChange?: () => void;
      onSuspendSketchUI?: () => void;
      onResumeSketchUI?: () => void;
    } = {},
  ) {
    // Repeat rides its own group, registered after the create and modify
    // rails so its button renders last — the navbar draws the separator
    // before it whenever a visible group precedes. The copy service joins
    // this group as a second contributor (no divider between the two replay
    // buttons), so each button hides itself when its own targets are gone.
    // Unlike the create rail it is *not* `immune`: repeating features is a
    // solid-level operation, so the button hides while the exclusive sketch
    // toolbar owns the bar.
    const group = navbar.addGroup('repeat', { visible: false });
    this.button = new FeatureButton(group, {
      icon: '/icons/repeat-linear.png',
      label: 'Repeat',
      tip: 'Repeat features',
      ariaLabel: 'Repeat features along an axis, around an axis, or mirrored',
    });
    this.button.onClick = () => {
      if (this.armed) {
        this.exit();
      } else {
        this.enter();
      }
    };
    this.sketchUI = new SketchUISuspender(viewer, hooks);

    this.panel = new RepeatPanel(container);
    this.panel.onApply = () => void this.runner.apply();
    this.panel.onExit = () => this.exit();
    this.panel.onChange = () => {
      this.panel.setMessage(null);
      this.refreshHighlight();
      this.runner.schedulePreview();
    };
    this.panel.onTypeChange = () => {
      this.syncViewport();
      this.refreshHighlight();
    };
    this.panel.onRemoveTarget = (index) => {
      this.targets.splice(index, 1);
      this.panel.setMessage(null);
      this.refresh();
      this.runner.schedulePreview();
    };
    this.panel.onAxisModeChange = (direction) => {
      // The slot left edge mode (✕, a standard/axis choice) — the entity
      // would otherwise silently ride along into the next edge state.
      this.axisEdgeEntities.set(direction, null);
      this.refreshHighlight();
    };
    this.panel.onPlaneModeChange = () => {
      this.planeFaceEntity = null;
      this.refreshHighlight();
    };
    this.panel.onArmedSlotChange = () => this.syncViewport();

    this.runner = new ApplyRunner({
      panel: this.panel,
      isArmed: () => this.armed,
      build: () => this.editTarget ? this.buildEditRequest() : this.buildRequest(),
      send: (request, extras) => this.editTarget
        ? applyRepeatEdit(this.editTarget, { ...(request as RepeatEditOptions), ...extras })
        : applyRepeat({ ...(request as RepeatApplyOptions), ...extras }),
      onApplied: () => this.exit(this.editTarget ? { editEnd: 'apply' } : { resume: 'lazy' }),
      failMessage: () => this.editTarget ? 'Could not apply the edit.' : 'Could not apply the repeat.',
    });
    this.relabeler = new OptionRelabeler({
      sign: ({ axes, planes }) => `${axisOptionsSignature(axes)}#${planeOptionsSignature(planes)}`,
      load: async ({ axes, planes }) => {
        const [labeledAxes, labeledPlanes] = await Promise.all([
          labelWithAxisNames(axes),
          labelWithPlaneNames(planes),
        ]);
        return { axes: labeledAxes, planes: labeledPlanes };
      },
      isArmed: () => this.armed,
      apply: ({ axes, planes }) => {
        this.axes = axes;
        this.planes = planes;
        this.panel.setOptions(axes, planes);
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

  /**
   * The armed dialog owns viewport clicks; which picks are actually live
   * follows the kind type ({@link syncViewport}) — the viewer routes edge,
   * face, axis and plane-quad clicks here.
   */
  get isPicking(): boolean {
    return this.armed;
  }

  /** Axis-line and edge clicks route here (an armed axis slot). */
  get isAxisPicking(): boolean {
    return this.armed && (this.panel.armedSlot === 'axis1' || this.panel.armedSlot === 'axis2');
  }

  /** Plane-quad and face clicks route here (the armed plane slot). */
  get isPlanePicking(): boolean {
    return this.armed && this.panel.armedSlot === 'plane';
  }

  /** True while armed picking has suspended sketch editing. */
  get sketchUISuspended(): boolean {
    return this.sketchUI.suspended;
  }

  /**
   * Every render lands here. An open edit session owns the view: it keeps
   * the viewport rolled back to just before the edited statement, and at
   * that boundary the slot options rebuild from the pre-statement scene —
   * exactly the features, axes and planes the repeat's arguments can
   * reference.
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
    this.targetOptions = collectRepeatTargets(sceneObjects);
    this.axes = collectAxisOptions(sceneObjects);
    this.planes = collectPlaneOptions(sceneObjects);
    if (this.editSceneStale) {
      this.editSceneStale = false;
      // A scene rebuild killed the re-picked shape ids; keep chips are
      // text-addressed and survive.
      let reset = false;
      for (const direction of [1, 2] as const) {
        if (this.axisEdgeEntities.get(direction)) {
          this.axisEdgeEntities.set(direction, null);
          this.panel.setAxisEdgeChip(direction, null);
          reset = true;
        }
      }
      if (this.planeFaceEntity) {
        this.planeFaceEntity = null;
        this.panel.setPlaneFaceChip(null);
        reset = true;
      }
      if (reset) {
        this.panel.setMessage('The code changed — the re-picked geometry was reset.');
      }
    }
    // Timeline-picked targets re-match by source line. A keep that resolved
    // to a feature statement becomes that row's option — proper label,
    // create-mode toggling; unresolved keeps stay text-addressed verbatim.
    this.targets = this.targets.flatMap((target): RepeatTargetChoice[] => {
      if (target.kind === 'keep') {
        const match = target.loc && this.targetOptions.find(o =>
          o.filePath === target.loc!.filePath && o.line === target.loc!.line);
        return match ? [{ kind: 'option', option: match }] : [target];
      }
      const match = this.targetOptions.find(o =>
        o.filePath === target.option.filePath && o.line === target.option.line);
      return match ? [{ kind: 'option', option: match }] : [];
    });
    this.sortTargets();
    this.panel.setOptions(this.axes, this.planes);
    this.refreshLabels();
    this.syncViewport();
    this.refresh();
    this.runner.schedulePreview();
  }

  update(sceneObjects: SceneObjectRender[]): void {
    this.sceneObjects = sceneObjects;
    this.targetOptions = collectRepeatTargets(sceneObjects);
    this.axes = collectAxisOptions(sceneObjects);
    this.planes = collectPlaneOptions(sceneObjects);
    this.sceneSketchActive = collectSketchProfiles(sceneObjects)[0]?.kind === 'active';
    // A blank document offers the button too (see {@link Viewer.sceneIsEmpty});
    // the dialog then opens on its empty target list.
    this.available = this.targetOptions.length > 0 || this.viewer.sceneIsEmpty;
    this.navbar.setGroupVisible('repeat', this.available);
    this.button.setVisible(this.available);
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
    // Chosen targets re-match against the fresh options by source line;
    // shape ids changed with the render, so picked entities are stale and
    // drop back to their pick prompts.
    this.targets = this.targets.flatMap((target): RepeatTargetChoice[] => {
      if (target.kind === 'keep') {
        return [target];
      }
      const match = this.targetOptions.find(o =>
        o.filePath === target.option.filePath && o.line === target.option.line);
      return match ? [{ kind: 'option', option: match }] : [];
    });
    this.sortTargets();
    for (const direction of [1, 2] as const) {
      if (this.axisEdgeEntities.get(direction)) {
        this.axisEdgeEntities.set(direction, null);
        this.panel.setAxisEdgeChip(direction, null);
      }
    }
    if (this.planeFaceEntity) {
      this.planeFaceEntity = null;
      this.panel.setPlaneFaceChip(null);
    }
    this.panel.setOptions(this.axes, this.planes);
    this.refreshLabels();
    this.syncViewport();
    this.refresh();
    this.runner.schedulePreview();
  }

  /**
   * Open the dialog over an existing repeat statement (timeline
   * double-click). The session rolls the viewport back to just before the
   * statement — the world its arguments see, where the target features,
   * axes and planes it references are visible and pickable. The axis/plane
   * slots start on "Current: …" chips keeping the statement's own
   * expressions; the targets slot starts on one kept chip per statement
   * target, toggled and re-picked in the timeline like create mode. Apply
   * rewrites the statement in place.
   */
  enterEdit(
    target: FeatureEditTarget,
    parsed: Extract<ParsedFeatureStatement, { feature: 'repeat' }>,
    info: Omit<EditSessionInfo, 'target'>,
  ): void {
    if (this.armed) {
      this.exit();
    }
    this.hooks.onEnter?.();
    this.armed = true;
    this.editTarget = target;
    this.editStatement = parsed;
    this.editSceneStale = false;
    this.axisEdgeEntities.set(1, null);
    this.axisEdgeEntities.set(2, null);
    this.planeFaceEntity = null;
    this.targets = parsed.targetTexts.map((label, sourceIndex) => {
      const ref = parsed.targetRefs[sourceIndex];
      return {
        kind: 'keep' as const,
        sourceIndex,
        label,
        loc: ref ? { filePath: target.filePath, line: ref.line, column: ref.column } : undefined,
      };
    });
    this.syncButton();
    this.sketchUI.suspend();
    this.session.begin({ ...info, target });
    void this.refreshScopeVariables();
    this.panel.showEdit({
      kind: parsed.kind,
      directions: parsed.directions,
      spacingMode: parsed.spacingMode,
      centered: parsed.centered,
      count: parsed.count,
      sweep: parsed.sweep,
      angle: parsed.angle,
      axisLabels: parsed.axisTexts,
      planeLabel: parsed.planeText,
    });
    this.syncViewport();
    this.refresh();
    this.runner.schedulePreview();
  }

  enter(): void {
    if (this.armed) {
      return;
    }
    this.session.end('continue');
    const seeded = this.hooks.onEnter?.();
    this.armed = true;
    this.targets = [];
    this.axisEdgeEntities.set(1, null);
    this.axisEdgeEntities.set(2, null);
    this.planeFaceEntity = null;
    // Composing a repeat means looking at the whole scene, not down the
    // active sketch plane — leave sketch editing right away (resumed on
    // cancel; an apply's re-render takes over).
    if (this.sceneSketchActive) {
      this.sketchUI.suspend();
    }
    this.syncButton();
    void this.refreshScopeVariables();
    this.panel.show();
    if (seeded) {
      this.seedFromSelection(seeded);
    }
    this.panel.setOptions(this.axes, this.planes);
    this.refreshLabels();
    this.syncViewport();
    this.refresh();
    this.runner.schedulePreview();
  }

  /**
   * Arm the dialog around whatever was already selected: a pending plane or
   * a single face opens the Mirror type with it as the plane; a single edge
   * opens the Linear type with it as the axis. Any other selection starts on
   * the Linear type blank.
   */
  private seedFromSelection({ seed, pendingPlaneShapeId }: RepeatEnterSeed): void {
    if (pendingPlaneShapeId) {
      const plane = resolvePlaneByShapeId(pendingPlaneShapeId, this.sceneObjects);
      const option = plane?.sourceLocation
        ? planeOptionForLocation(this.planes, plane.sourceLocation)
        : undefined;
      if (option) {
        this.panel.setType('mirror');
        this.panel.selectPlane(option);
        return;
      }
    }
    const faces = seed.filter(e => e.sub.type === 'face');
    const edges = seed.filter(e => e.sub.type === 'edge');
    if (seed.length === 1 && edges.length === 1) {
      this.axisEdgeEntities.set(1, edges[0]);
      this.panel.setAxisEdgeChip(1, 'Picked edge');
      this.panel.armSlot('axis1');
      return;
    }
    if (seed.length === 1 && faces.length === 1) {
      this.panel.setType('mirror');
      this.planeFaceEntity = faces[0];
      this.panel.setPlaneFaceChip('Picked face');
      this.panel.armSlot('plane');
    }
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
    this.editStatement = null;
    this.editSceneStale = false;
    this.targets = [];
    this.axisEdgeEntities.set(1, null);
    this.axisEdgeEntities.set(2, null);
    this.planeFaceEntity = null;
    this.runner.cancelPreview();
    this.viewer.clearHighlight();
    this.viewer.hideStandardPlanes();
    this.viewer.pickFilter = 'all';
    this.viewer.pickAxes = false;
    // pickPlanes is left alone: syncButton's onActiveChange runs the modify
    // service's neutral-mode restore, which owns that channel.
    this.syncButton();
    this.panel.hide();
    this.sketchUI.resume((opts.resume ?? 'immediate') === 'immediate');
  }

  /**
   * Routes viewer clicks while the dialog is armed — the pick channels
   * follow the armed slot, so only its picks arrive. An armed axis slot: a
   * solid edge sets that direction's axis to the edge (clicking it again
   * clears it back), an axis line sets it to that statement. The armed plane
   * slot: a face sets the mirror plane to that face (clicking it again
   * clears it back). Empty-space clicks keep the selection.
   */
  handleClick(shapeId: string | null, sub: SubSelection): void {
    if (!this.armed || !shapeId || !sub) {
      return;
    }
    if (sub.type === 'axis') {
      if (!this.isAxisPicking) {
        return;
      }
      const option = axisOptionForShape(shapeId, this.sceneObjects, this.axes);
      if (!option) {
        this.panel.setMessage(AXIS_CONSUMED_MESSAGE);
        return;
      }
      this.pickAxis(option);
      return;
    }
    if (sub.type === 'edge' && this.isAxisPicking) {
      // The pick lands in the armed direction's slot; re-clicking that
      // direction's edge clears it back.
      const direction = this.panel.armedAxis;
      const next = toggleEntity(this.axisEdgeEntities.get(direction) ?? null, { shapeId, sub });
      this.axisEdgeEntities.set(direction, next);
      this.panel.setAxisEdgeChip(direction, next ? 'Picked edge' : null);
      this.panel.setMessage(null);
      this.refreshHighlight();
      this.runner.schedulePreview();
      return;
    }
    if (sub.type === 'face' && this.isPlanePicking) {
      this.planeFaceEntity = toggleEntity(this.planeFaceEntity, { shapeId, sub });
      this.panel.setPlaneFaceChip(this.planeFaceEntity ? 'Picked face' : null);
      this.panel.setMessage(null);
      this.refreshHighlight();
      this.runner.schedulePreview();
    }
  }

  /** A plane feature's quad was clicked while the Mirror type is up. */
  handlePlanePick(shapeId: string): void {
    if (!this.isPlanePicking) {
      return;
    }
    const option = planeOptionForShape(shapeId, this.sceneObjects, this.planes);
    if (!option) {
      this.panel.setMessage(PLANE_UNAVAILABLE_MESSAGE);
      return;
    }
    this.pickPlane(option);
  }

  /** A shown origin plane was clicked while the Mirror type is up. */
  private readonly onStandardPlanePick = (plane: StandardPlaneId): void => {
    if (!this.isPlanePicking) {
      return;
    }
    this.planeFaceEntity = null;
    this.panel.selectStandardPlane(plane);
    this.panel.setMessage(null);
    this.refreshHighlight();
    this.runner.schedulePreview();
  };

  /**
   * A timeline row was clicked while the dialog is armed: a feature row
   * toggles it in the targets list; axis and plane rows land in their input
   * slots when the current type takes them. Every row is consumed so the
   * default rollback can't close the dialog mid-flow.
   */
  handleTimelinePick(obj: SceneObjectRender): boolean {
    if (!this.armed) {
      return false;
    }
    if (obj.type === 'axis' && obj.sourceLocation) {
      if (!this.panel.usesAxis) {
        this.panel.setMessage('An axis fits the Linear, Circular and Rotate types — a mirror takes a plane.');
        return true;
      }
      const option = axisOptionForLocation(this.axes, obj.sourceLocation);
      if (!option) {
        this.panel.setMessage(AXIS_CONSUMED_MESSAGE);
        return true;
      }
      this.pickAxis(option);
      return true;
    }
    if (obj.type === 'plane' && obj.sourceLocation) {
      if (this.panel.usesAxis) {
        this.panel.setMessage('A plane fits the Mirror type — this type takes an axis.');
        return true;
      }
      const option = planeOptionForLocation(this.planes, obj.sourceLocation);
      if (!option) {
        this.panel.setMessage(PLANE_UNAVAILABLE_MESSAGE);
        return true;
      }
      this.pickPlane(option);
      return true;
    }
    const target = resolveRepeatTargetRow(obj, this.sceneObjects);
    if (!target) {
      this.panel.setMessage('That row cannot be repeated — pick a feature like an extrude, cut or fillet.');
      return true;
    }
    const loc = target.sourceLocation!;
    const option = this.targetOptions.find(o => o.filePath === loc.filePath && o.line === loc.line);
    if (!option) {
      this.panel.setMessage('That feature is not available to repeat.');
      return true;
    }
    // A kept target that resolved to this row counts as the same chip — the
    // click toggles it off instead of duplicating the feature.
    const existing = this.targets.findIndex(t => t.kind === 'option'
      ? t.option.filePath === option.filePath && t.option.line === option.line
      : t.loc !== undefined && t.loc.filePath === option.filePath && t.loc.line === option.line);
    if (existing >= 0) {
      this.targets.splice(existing, 1);
    } else {
      this.targets.push({ kind: 'option', option });
      this.sortTargets();
    }
    // The pick landed in the Features slot — it takes the armed border.
    this.panel.armSlot('targets');
    this.panel.setMessage(null);
    this.refresh();
    this.runner.schedulePreview();
    return true;
  }

  /**
   * Keep the chosen targets in timeline order — `targetOptions` is built by
   * walking the scene objects in build order, so an option's index there is
   * its timeline position. Kept statement targets whose location did not
   * resolve to a timeline row have no position and stay last, in their
   * original argument order.
   */
  private sortTargets(): void {
    const position = (target: RepeatTargetChoice): number => {
      const loc = target.kind === 'option' ? target.option : target.loc;
      const index = loc
        ? this.targetOptions.findIndex(o => o.filePath === loc.filePath && o.line === loc.line)
        : -1;
      return index >= 0 ? index : Number.MAX_SAFE_INTEGER;
    };
    this.targets.sort((a, b) => position(a) - position(b));
  }

  /** An offered axis landed in the armed direction's slot (3D or timeline pick). */
  private pickAxis(option: AxisOption): void {
    this.axisEdgeEntities.set(this.panel.armedAxis, null);
    this.panel.selectAxis(option);
    this.panel.setMessage(null);
    this.refreshHighlight();
    this.runner.schedulePreview();
  }

  /** An offered plane landed in the plane slot (quad or timeline pick). */
  private pickPlane(option: PlaneOption): void {
    this.planeFaceEntity = null;
    this.panel.selectPlane(option);
    this.panel.setMessage(null);
    this.refreshHighlight();
    this.runner.schedulePreview();
  }

  /**
   * One direction's axis request field, or the message blocking it. A keep
   * selection (edit mode) references the statement's own axis by position —
   * the create paths never see one.
   */
  private axisRef(direction: RepeatDirection, named: boolean): RepeatEditAxisRef | { error: string } {
    const which = named ? ` for direction ${direction}` : '';
    const selection = this.panel.axisSelection(direction);
    if (!selection) {
      return { error: `Choose the axis to repeat along${which}.` };
    }
    if (selection.kind === 'keep') {
      return { kind: 'keep', sourceIndex: selection.sourceIndex };
    }
    return pickedAxisRef(selection, this.axisEdgeEntities.get(direction) ?? null,
      `Pick the axis edge${which} first.`);
  }

  /** The plane slot's request field, or the message blocking it. */
  private planeRef(): RepeatEditPlaneRef | { error: string } {
    const selection = this.panel.planeSelection();
    if (!selection) {
      return { error: 'Choose the plane to mirror across.' };
    }
    if (selection.kind === 'keep') {
      return { kind: 'keep' };
    }
    if (selection.kind === 'standard') {
      return { kind: 'standard', plane: selection.plane };
    }
    if (selection.kind === 'plane') {
      const { filePath, line, column } = selection.option;
      return { kind: 'plane', filePath, line, column };
    }
    if (!this.planeFaceEntity) {
      return { error: 'Pick the mirror face first.' };
    }
    return { kind: 'face', entity: this.planeFaceEntity };
  }

  private async refreshScopeVariables(): Promise<void> {
    const line = this.editTarget?.line ?? null;
    await refreshScopeVariables(line, this.panel,
      () => this.armed && (this.editTarget?.line ?? null) === line);
  }

  private buildRequest(): RepeatApplyOptions | { error: string } {
    const values = this.panel.values();
    if ('error' in values) {
      return values;
    }
    if (this.targets.length === 0) {
      return { error: 'Pick the features to repeat in the timeline first.' };
    }
    // Create mode never carries keep entries — every chip is a picked row.
    const targets = this.targets.flatMap(t => t.kind === 'option'
      ? [{ filePath: t.option.filePath, line: t.option.line, column: t.option.column }]
      : []);
    if (values.kind === 'mirror') {
      const plane = this.planeRef();
      if ('error' in plane) {
        return plane;
      }
      if (plane.kind === 'keep') {
        return { error: 'Choose the plane to mirror across.' };
      }
      return { kind: 'mirror', targets, plane };
    }
    if (values.kind === 'linear') {
      const active = this.panel.directions;
      const directions: RepeatDirectionRef[] = [];
      for (let i = 0; i < active.length; i++) {
        const axis = this.axisRef(active[i], active.length > 1);
        if ('error' in axis) {
          return axis;
        }
        if (axis.kind === 'keep') {
          return { error: `Choose the axis to repeat along${active.length > 1 ? ` for direction ${active[i]}` : ''}.` };
        }
        directions.push({ axis, ...values.directions[i] });
      }
      return {
        kind: 'linear', targets, directions, spacingMode: values.spacingMode,
        centered: values.centered || undefined,
        newVariables: values.newVariables,
      };
    }
    const axis = this.axisRef(1, false);
    if ('error' in axis) {
      return axis;
    }
    if (axis.kind === 'keep') {
      return { error: 'Choose the axis to repeat around.' };
    }
    if (values.kind === 'circular') {
      return {
        kind: 'circular', targets, axis, count: values.count, sweep: values.sweep,
        newVariables: values.newVariables,
      };
    }
    return { kind: 'rotate', targets, axis, angle: values.angle, newVariables: values.newVariables };
  }

  /**
   * The edit-mode apply payload. Slots still on their "Current: …" entries
   * ship as keeps — the transform preserves the statement's expressions byte
   * for byte; the target list mixes kept statement targets with re-picked
   * timeline rows (an untouched implicit repeat keeps consuming the previous
   * feature). Re-picked edges/faces synthesize against the session boundary.
   */
  private buildEditRequest(): RepeatEditOptions | { error: string } {
    const values = this.panel.values();
    if ('error' in values) {
      return values;
    }
    // An originally implicit repeat (no explicit target arguments) stays
    // implicit while the targets slot is untouched; explicit targets can be
    // re-picked but never all removed.
    let targets: RepeatEditTargetRef[] | undefined;
    if (this.targets.length > 0) {
      targets = this.targets.map(t => t.kind === 'keep'
        ? { kind: 'verbatim' as const, sourceIndex: t.sourceIndex }
        : {
          kind: 'feature' as const,
          filePath: t.option.filePath,
          line: t.option.line,
          column: t.option.column,
        });
    } else if ((this.editStatement?.targetTexts.length ?? 0) > 0) {
      return { error: 'Pick the features to repeat in the timeline first.' };
    }
    const sessionFields = (needsBoundary: boolean) => ({
      expectedStatement: this.session.expectedStatement,
      before: needsBoundary ? this.session.boundary ?? undefined : undefined,
    });
    if (values.kind === 'mirror') {
      const plane = this.planeRef();
      if ('error' in plane) {
        return plane;
      }
      return { kind: 'mirror', targets, plane, ...sessionFields(plane.kind === 'face') };
    }
    if (values.kind === 'linear') {
      const active = this.panel.directions;
      const directions: NonNullable<RepeatEditOptions['directions']> = [];
      let pickedEdge = false;
      for (let i = 0; i < active.length; i++) {
        const axis = this.axisRef(active[i], active.length > 1);
        if ('error' in axis) {
          return axis;
        }
        pickedEdge ||= axis.kind === 'edge';
        directions.push({ axis, ...values.directions[i] });
      }
      return {
        kind: 'linear', targets, directions, spacingMode: values.spacingMode,
        centered: values.centered || undefined,
        newVariables: values.newVariables,
        ...sessionFields(pickedEdge),
      };
    }
    const axis = this.axisRef(1, false);
    if ('error' in axis) {
      return axis;
    }
    const session = sessionFields(axis.kind === 'edge');
    if (values.kind === 'circular') {
      return {
        kind: 'circular', targets, axis, count: values.count, sweep: values.sweep,
        newVariables: values.newVariables, ...session,
      };
    }
    return { kind: 'rotate', targets, axis, angle: values.angle, newVariables: values.newVariables, ...session };
  }

  // -------------------------------------------------------------------------
  // Viewport reflection + sketch-editing suspension
  // -------------------------------------------------------------------------

  /**
   * The viewer's pick channels follow the panel's armed slot, so the slot
   * border says exactly where the next 3D click lands: an armed axis slot
   * takes solid edges and axis lines; the armed plane slot takes faces,
   * plane quads and the origin planes shown as pick targets; the armed
   * Features slot turns scene picking off — features come from the timeline.
   */
  private syncViewport(): void {
    if (!this.armed) {
      return;
    }
    const axisArmed = this.isAxisPicking;
    const planeArmed = this.isPlanePicking;
    this.viewer.pickSketchWires = false;
    this.viewer.pickAxes = axisArmed;
    this.viewer.pickPlanes = planeArmed;
    this.viewer.pickFilter = axisArmed ? 'edge' : planeArmed ? 'face' : 'none';
    if (planeArmed) {
      this.viewer.showStandardPlanes(this.onStandardPlanePick);
    } else {
      this.viewer.hideStandardPlanes();
    }
  }

  /** Repaint the target chips and the picked-entity highlights. */
  private refresh(): void {
    if (!this.armed) {
      return;
    }
    this.panel.setTargets(this.targets.map(target => target.kind === 'keep'
      ? { label: `Current: ${target.label}`, removable: true }
      : sourceChip(target.option, { removable: true })));
    this.refreshHighlight();
  }

  /**
   * Repaint the viewport selection: the picked axis edge or mirror face, the
   * chosen axis statement's dashed line (tinted whole, like sketch wires),
   * or the chosen plane feature's quad.
   */
  private refreshHighlight(): void {
    if (!this.armed) {
      return;
    }
    const wireIds: string[] = [];
    const entities: SelectedEntity[] = [];
    if (this.panel.usesAxis) {
      for (const direction of this.panel.directions) {
        const selection = this.panel.axisSelection(direction);
        if (selection?.kind === 'axis') {
          wireIds.push(...axisLineShapeIds(selection.option, this.sceneObjects));
        } else if (selection?.kind === 'edge') {
          const entity = this.axisEdgeEntities.get(direction);
          if (entity) {
            entities.push(entity);
          }
        }
      }
    } else {
      const selection = this.panel.planeSelection();
      if (selection?.kind === 'plane') {
        const plane = this.sceneObjects.find(o => o.type === 'plane'
          && o.sourceLocation?.filePath === selection.option.filePath
          && o.sourceLocation?.line === selection.option.line);
        const shapeId = plane?.sceneShapes?.find(s => s.shapeId)?.shapeId;
        if (shapeId) {
          this.viewer.highlightPlaneQuad(shapeId);
          return;
        }
      } else if (selection?.kind === 'face' && this.planeFaceEntity) {
        entities.push(this.planeFaceEntity);
      }
    }
    if (wireIds.length > 0 || entities.length > 0) {
      this.viewer.highlightEntities(entities, wireIds);
    } else {
      this.viewer.clearHighlight();
    }
  }

  /**
   * Async label pass: axes and planes bound to variables show their names
   * ("ringAxis — line 5"). Applied only if the dialog is still armed on the
   * same option sets when the lookups land.
   */
  private refreshLabels(): void {
    void this.relabeler.refresh({ axes: this.axes, planes: this.planes });
  }

  private syncButton(): void {
    this.button.setActive(this.armed);
    // The solo group's visibility already hides the button (and the
    // navbar-managed separator before it) when nothing is repeatable.
    // Every armed flip lands here — the Sketch button disables while a
    // create dialog is up.
    this.hooks.onActiveChange?.();
  }
}
