import {
  applyRepeat, applyRepeatEdit, fetchFeatureGhostResult, fetchFeatureSources, FeatureEditTarget,
  GhostAxisRef, GhostPlaneRef, GhostSolid, ParsedFeatureStatement, RepeatApplyOptions,
  RepeatDirectionRef, RepeatEditAxisRef, RepeatEditOptions, RepeatEditPlaneRef, RepeatEditTargetRef,
  RepeatGhostRequest, SourceSlotRef,
} from '../../api';
import { toggleEntity } from '../../helpers/entities';
import { SceneObjectRender, SubSelection } from '../../types';
import { SelectedEntity, Viewer } from '../../viewer';
import { StandardPlaneId } from '../../scene/standard-planes';
import { Navbar } from '../../ui/navbar';
import { EditSession, EditSessionInfo } from '../edit-session';
import { RepeatDirection, RepeatPanel } from './repeat-panel';
import { FeatureButton } from './feature-button';
import { FeatureGhostOverlay } from './feature-ghost';
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

/**
 * The statement a resolved source slot names, or null when it names none —
 * an inline argument, a clone, an expression the resolver can't address.
 */
function sourceStatement(slot: SourceSlotRef | undefined): { filePath: string; line: number } | null {
  return slot?.kind === 'sketch' ? { filePath: slot.filePath, line: slot.line } : null;
}

/**
 * The origin plane a plane-like literal names — `'front'`, `"top"`, `'-xy'`.
 * The plane slot only reads back the three unsigned spellings it writes
 * itself; every other wording has to stay a verbatim keep so an apply
 * preserves the user's own text. A ghost only needs the plane, though, and for
 * a mirror the normal's direction doesn't matter: reflecting in `'xy'` and in
 * `'-xy'` is the same reflection.
 */
function standardPlaneFromText(text: string | null | undefined): 'xy' | 'xz' | 'yz' | null {
  switch ((text ?? '').trim().match(/^['"]([a-z-]+)['"]$/)?.[1]) {
    case 'xy':
    case '-xy':
    case 'top':
    case 'bottom':
      return 'xy';
    case 'xz':
    case '-xz':
    case 'front':
    case 'back':
      return 'xz';
    case 'yz':
    case '-yz':
    case 'right':
    case 'left':
      return 'yz';
    default:
      return null;
  }
}

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
 * plane. A translucent ghost draws the instances as they are dialled in —
 * each target's own body, stamped where the pattern would put it. Apply
 * writes `repeat('<kind>', …)` — the re-render is the preview, editor undo
 * the rollback.
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
  /**
   * The edited statement names no targets of its own — `repeat('linear', …)`
   * with nothing after the options, which replays whatever came before it. The
   * slot still shows that feature (resolved through the sources query), and the
   * statement stays implicit until the list is actually changed.
   */
  private implicitTargets = false;
  /** The targets slot was edited — an implicit repeat becomes explicit. */
  private targetsTouched = false;
  /**
   * Current sources of the edited statement, for the keep chips' ghost: the
   * target features by call site, the axes each direction turns around, and
   * the mirror plane. Null until the query lands (or when it can't answer).
   */
  private sourceSlots: {
    targets: SourceSlotRef[];
    axes: SourceSlotRef[];
    plane: SourceSlotRef | null;
  } | null = null;
  private runner: ApplyRunner<RepeatApplyOptions | RepeatEditOptions>;
  private relabeler: OptionRelabeler<{ axes: AxisOption[]; planes: PlaneOption[] }>;
  /** The translucent instances the current pattern would place. */
  private ghost: FeatureGhostOverlay;

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
    this.ghost = new FeatureGhostOverlay(viewer);

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
      this.targetsTouched = true;
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
      // The statement preview's geometric twin: the target features stamped
      // where the pattern would put them, drawn translucent in the viewport.
      // Same debounce, same abort scope.
      ghost: {
        fetch: (_request, signal) => this.fetchGhost(signal),
        apply: (solids) => {
          if (solids) {
            // Every instance is material arriving, cut targets included — a
            // pattern preview shows where the tool lands, not what it removes.
            this.ghost.set(solids, 'add');
          } else {
            this.ghost.clear();
          }
        },
      },
      surfacePreviewReasons: () => this.surfaceReasons(),
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
    this.targetOptions = collectRepeatTargets(sceneObjects);
    this.axes = collectAxisOptions(sceneObjects);
    this.planes = collectPlaneOptions(sceneObjects);
    if (this.editSceneStale) {
      this.editSceneStale = false;
      // A scene rebuild killed the re-picked shape ids; keep chips are
      // text-addressed and survive — but the entities their slots resolved to
      // died with the render, so the statement's own sources re-fetch.
      this.sourceSlots = null;
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
    // Options are rebuilt from the pre-statement scene now, so an implicit
    // statement's chip can finally carry its feature's own timeline label.
    this.seedImplicitTargets();
    this.sortTargets();
    if (!this.sourceSlots) {
      void this.loadEditSources();
    }
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
    // The geometry under the ghost just changed — drop it now and let the
    // debounce redraw it. Correctness over the flicker.
    this.ghost.clear();
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
    this.sourceSlots = null;
    this.implicitTargets = parsed.targetTexts.length === 0;
    this.targetsTouched = false;
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
    void this.loadEditSources();
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
    this.implicitTargets = false;
    this.targetsTouched = false;
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
    this.sourceSlots = null;
    this.implicitTargets = false;
    this.targetsTouched = false;
    this.targets = [];
    this.axisEdgeEntities.set(1, null);
    this.axisEdgeEntities.set(2, null);
    this.planeFaceEntity = null;
    this.runner.cancelPreview();
    // The overlay is a compiledMesh sibling, so no render tears it down —
    // every way out of the dialog (apply, cancel, scene-driven) lands here.
    this.ghost.clear();
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
    this.targetsTouched = true;
    // The pick landed in the Features slot — it takes the armed border.
    this.panel.armSlot('targets');
    this.panel.setMessage(null);
    this.refresh();
    this.runner.schedulePreview();
    return true;
  }

  /**
   * Fill the Features slot for a statement that names no targets of its own.
   * `repeat('linear', ['x','y'], {…})` replays whatever came before it, so
   * there is no argument to keep verbatim — but the sources query knows which
   * feature that is, and leaving the slot on its "Pick features in the
   * timeline" prompt makes an edit dialog look like it lost them.
   *
   * The chip is the feature's own timeline row, so it hovers, toggles and
   * re-picks exactly like create mode. Applying it back unchanged still writes
   * an implicit statement — {@link buildEditRequest} only spells the targets
   * out once the list has actually been touched.
   */
  private seedImplicitTargets(): void {
    if (!this.implicitTargets || this.targetsTouched || this.targets.length > 0) {
      return;
    }
    for (const slot of this.sourceSlots?.targets ?? []) {
      const loc = sourceStatement(slot);
      const option = loc && this.targetOptions.find(o =>
        o.filePath === loc.filePath && o.line === loc.line);
      if (option) {
        this.targets.push({ kind: 'option', option });
      }
    }
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

  /**
   * The edited statement's own sources, for the slots still on their "Current:
   * …" chips: the features it replays, the axes it walks, its mirror plane.
   * The panel already reads a world-axis or origin-plane literal straight off
   * the argument text, so what this adds is everything else — an `axis()`
   * variable, a `plane()` statement, the face a mirror was written from.
   *
   * A response landing after the dialog closed or re-targeted is dropped.
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
    this.sourceSlots = result.ok && result.feature === 'repeat'
      ? { targets: result.targets, axes: result.axes, plane: result.plane ?? null }
      : { targets: [], axes: [], plane: null };
    this.seedImplicitTargets();
    this.sortTargets();
    this.refresh();
    // The ghost's keep slots read `sourceSlots`, which resolves after
    // `enterEdit` already scheduled its preview — re-kick so the ghost appears
    // now that the statement's own sources are known.
    this.runner.schedulePreview();
  }

  // -------------------------------------------------------------------------
  // Live geometry ("ghost")
  // -------------------------------------------------------------------------

  /**
   * The live geometry for the current form state: each target feature's own
   * body, stamped where the pattern would put it. Runs off the values the
   * statement preview just validated, so all that is left is to resolve the
   * slots — and that is where the create and edit dialogs converge: both hand
   * the server explicit refs, so the endpoint never has to know which mode
   * asked. A slot the ghost can't address (no targets yet, an axis still
   * unpicked, a keep chip over an expression) means no ghost.
   */
  private async fetchGhost(signal: AbortSignal): Promise<GhostSolid[] | null> {
    const values = this.panel.values();
    if ('error' in values) {
      return null;
    }
    const targets = this.ghostTargets();
    if (!targets) {
      return null;
    }
    const request: RepeatGhostRequest = {
      feature: 'repeat',
      kind: values.kind,
      targets,
      axes: [],
      plane: null,
      directions: [],
      centered: false,
      count: null,
      sweep: null,
      angle: null,
    };
    if (values.kind === 'mirror') {
      const plane = this.ghostPlane();
      if (!plane) {
        return null;
      }
      request.plane = plane;
    } else if (values.kind === 'linear') {
      const active = this.panel.directions;
      for (let i = 0; i < active.length; i++) {
        const axis = this.ghostAxis(active[i]);
        if (!axis) {
          return null;
        }
        const { count, value } = values.directions[i];
        request.axes.push(axis);
        request.directions.push({
          count,
          offset: values.spacingMode === 'offset' ? value : null,
          length: values.spacingMode === 'length' ? value : null,
        });
      }
      request.centered = values.centered;
    } else {
      const axis = this.ghostAxis(1);
      if (!axis) {
        return null;
      }
      request.axes.push(axis);
      if (values.kind === 'circular') {
        request.count = values.count;
        request.sweep = values.sweep;
      } else {
        request.angle = values.angle;
      }
    }
    const result = await fetchFeatureGhostResult(request, signal);
    // Only a limit the user can act on reaches the panel — never an ordinary
    // refusal (a stale pick, an expression the server can't evaluate: those
    // just leave the viewport as it was). A superseded fetch says nothing
    // either: its answer is about a form state already typed past, or a
    // dialog that has since closed.
    if (result.notice && !signal.aborted && this.armed && this.surfaceReasons()) {
      this.panel.setMessage(result.notice);
    }
    return result.solids;
  }

  /**
   * Whether a refused preview is worth putting in front of the user. Editing,
   * always — the dialog opened over a statement that exists. Composing, only
   * once features have been picked: before that "nothing to repeat" is the
   * prompt, not an error.
   */
  private surfaceReasons(): boolean {
    return this.editTarget !== null || this.targets.length > 0;
  }

  /**
   * The features being replayed, by call site. A kept chip travels as the
   * timeline row its expression named, or — for one the parse couldn't
   * address — as whatever the sources query resolved that argument to. A
   * target neither could place means no ghost at all: a pattern missing one of
   * its bodies is a different pattern, not a partial one.
   *
   * An implicit repeat (no target arguments at all, replaying the statement
   * before it) has no chips to read, so its targets come from the query alone.
   */
  private ghostTargets(): { filePath: string; line: number }[] | null {
    if (this.targets.length === 0) {
      return this.editTarget ? this.resolvedTargets(this.sourceSlots?.targets) : null;
    }
    const refs: { filePath: string; line: number }[] = [];
    for (const target of this.targets) {
      const loc = target.kind === 'option'
        ? target.option
        : target.loc ?? sourceStatement(this.sourceSlots?.targets[target.sourceIndex]);
      if (!loc) {
        return null;
      }
      refs.push({ filePath: loc.filePath, line: loc.line });
    }
    return refs;
  }

  /** The statement call sites a resolved slot list names — all of them, or none. */
  private resolvedTargets(slots: SourceSlotRef[] | undefined): { filePath: string; line: number }[] | null {
    if (!slots || slots.length === 0) {
      return null;
    }
    const refs: { filePath: string; line: number }[] = [];
    for (const slot of slots) {
      const loc = sourceStatement(slot);
      if (!loc) {
        return null;
      }
      refs.push(loc);
    }
    return refs;
  }

  /** One direction's axis slot, in the form the kernel resolves. */
  private ghostAxis(direction: RepeatDirection): GhostAxisRef | null {
    const selection = this.panel.axisSelection(direction);
    if (!selection) {
      return null;
    }
    if (selection.kind === 'standard') {
      return { kind: 'standard', axis: selection.axis };
    }
    if (selection.kind === 'axis') {
      const { filePath, line } = selection.option;
      return { kind: 'axis', filePath, line };
    }
    if (selection.kind === 'edge') {
      const entity = this.axisEdgeEntities.get(direction);
      return entity ? { kind: 'edge', shapeId: entity.shapeId, index: entity.sub.index } : null;
    }
    // The kept statement axis, as the sources query resolved it — an `axis()`
    // the statement names by variable. A world-axis literal never reaches here
    // (the slot reads `'z'` as the standard selection itself), and anything
    // else is an expression no ghost can stand in for.
    const loc = sourceStatement(this.sourceSlots?.axes[selection.sourceIndex]);
    return loc ? { kind: 'axis', filePath: loc.filePath, line: loc.line } : null;
  }

  /** The mirror plane slot, in the form the kernel resolves. */
  private ghostPlane(): GhostPlaneRef | null {
    const selection = this.panel.planeSelection();
    if (!selection) {
      return null;
    }
    if (selection.kind === 'standard') {
      return { kind: 'standard', plane: selection.plane };
    }
    if (selection.kind === 'plane') {
      const { filePath, line } = selection.option;
      return { kind: 'plane', filePath, line };
    }
    if (selection.kind === 'face') {
      return this.planeFaceEntity
        ? {
          kind: 'face',
          shapeId: this.planeFaceEntity.shapeId,
          index: this.planeFaceEntity.sub.index,
        }
        : null;
    }
    // The kept statement plane, as the sources query resolved it: a `plane()`
    // the statement names, or the face a mirror was written from.
    const slot = this.sourceSlots?.plane;
    if (slot?.kind === 'sketch') {
      return { kind: 'plane', filePath: slot.filePath, line: slot.line };
    }
    const face = slot?.kind === 'entities' ? slot.entities[0] : null;
    if (face && face.sub.type === 'face') {
      return { kind: 'face', shapeId: face.shapeId, index: face.sub.index };
    }
    // An origin plane written any other way — `'front'`, `'-xy'`. It builds
    // no statement to point at, so the query can't reach it and the slot keeps
    // the wording verbatim; the ghost reads the plane straight off that text.
    const standard = standardPlaneFromText(this.editStatement?.planeText);
    return standard ? { kind: 'standard', plane: standard } : null;
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
    if (this.implicitTargets && !this.targetsTouched) {
      // Untouched: the statement keeps consuming the feature before it, and
      // the chip the slot shows is only telling the user which one that is.
    } else if (this.targets.length > 0) {
      targets = this.targets.map(t => t.kind === 'keep'
        ? { kind: 'verbatim' as const, sourceIndex: t.sourceIndex }
        : {
          kind: 'feature' as const,
          filePath: t.option.filePath,
          line: t.option.line,
          column: t.option.column,
        });
    } else if ((this.editStatement?.targetTexts.length ?? 0) > 0 || this.implicitTargets) {
      // Explicit targets can be re-picked but never all removed — and once an
      // implicit statement's own chip has been taken away, an empty slot means
      // what it says rather than quietly repeating the old feature.
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
