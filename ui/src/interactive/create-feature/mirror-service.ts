import {
  applyMirror, applyMirrorEdit, FeatureEditTarget, fetchFeatureGhostResult, fetchFeatureSources,
  GhostPlaneRef, GhostSolid, MirrorApplyOptions, MirrorEditOptions, MirrorEditTargetRef,
  MirrorGhostRequest, ParsedFeatureStatement, RepeatEditPlaneRef, SourceSlotRef,
} from '../../api';
import { toggleEntity } from '../../helpers/entities';
import { SceneObjectRender, SubSelection } from '../../types';
import { SelectedEntity, Viewer } from '../../viewer';
import { Navbar } from '../../ui/navbar';
import { StandardPlaneId } from '../../scene/standard-planes';
import { EditSession, EditSessionInfo } from '../edit-session';
import { SolidPickSelection } from '../solid-pick';
import { MirrorPanel } from './mirror-panel';
import { FeatureButton } from './feature-button';
import { FeatureGhostOverlay } from './feature-ghost';
import { ApplyRunner } from './apply-runner';
import { SketchUISuspender } from './sketch-suspender';
import { OptionRelabeler } from './option-relabeler';
import { collectSolidTargets, solidTargetForRow, solidTargetForShapeId, SolidTargetOption } from './solid-targets';
import {
  PLANE_UNAVAILABLE_MESSAGE, collectPlaneOptions, labelWithPlaneNames, PlaneOption,
  planeOptionForLocation, planeOptionForShape, planeOptionsSignature, planeQuadShapeIds,
  resolvePlaneByShapeId, standardPlaneFromText,
} from './plane-bases';
import { collectSketchProfiles, sourceChip } from './sketch-profiles';

/** What the seeding hook hands over when the dialog arms. */
export type MirrorEnterSeed = {
  /** The neutral-mode selection (faces/edges) at activation. */
  seed: SelectedEntity[];
  /** The neutral-mode pending plane quad (a clicked plane feature), if any. */
  pendingPlaneShapeId: string | null;
};

/**
 * One chosen target: a whole-solid pick resolved to its statement, or —
 * edit mode only — a kept statement target by its position in the parsed
 * `targetTexts`, preserved verbatim. A keep whose expression resolved to a
 * statement carries that statement's location (`loc`): it converts into its
 * solid option at the rollback boundary, so the chip shows the statement's
 * own label and a re-pick toggles it like create mode.
 */
type MirrorTargetChoice =
  | { kind: 'option'; option: SolidTargetOption }
  | { kind: 'keep'; sourceIndex: number; label: string; loc?: { filePath: string; line: number; column: number } };

/**
 * The statement a resolved source slot names, or null when it names none —
 * an inline argument, a clone, an expression the resolver can't address.
 */
function sourceStatement(slot: SourceSlotRef | undefined | null): { filePath: string; line: number } | null {
  return slot?.kind === 'sketch' ? { filePath: slot.filePath, line: slot.line } : null;
}

/**
 * The Mirror dialog on the create rails — the first of the transform tools:
 * reflect one or more solids across a plane. The solids are picked in the
 * viewport — any face or edge click while the Solids slot is armed selects
 * the owning solid whole (the shape-properties picker's idiom, shared via
 * {@link SolidPickSelection}) — or by their timeline rows; the plane comes
 * from an origin-plane quad, a `plane()` feature (its quad in 3D or its
 * timeline row), or a picked planar face — the repeat mirror's exact picker.
 * Arming with a selection already highlighted seeds the dialog: the selected
 * entities' solids open as target chips, a pending plane fills the plane
 * slot. A translucent ghost draws the reflection as it is dialled in — each
 * target's own body under the apply's exact mirror matrix. Apply writes
 * `mirror(<plane>, …)` — the re-render is the preview, editor undo the
 * rollback.
 */
export class MirrorFeatureService {
  private panel: MirrorPanel;
  private button: FeatureButton;
  private armed = false;
  private available = false;
  private targetOptions: SolidTargetOption[] = [];
  /** The chosen targets, in pick order — the mirror's argument order. */
  private targets: MirrorTargetChoice[] = [];
  private planes: PlaneOption[] = [];
  private sceneObjects: SceneObjectRender[] = [];
  private sceneSketchActive = false;
  private sketchUI: SketchUISuspender;
  /** The shared whole-solid highlight (the target chips' viewport echo). */
  private solidPick: SolidPickSelection;
  /** The picked mirror face (the plane slot's `face` mode), or null. */
  private planeFaceEntity: SelectedEntity | null = null;
  /** Statement being edited in place (timeline double-click), or null. */
  private editTarget: FeatureEditTarget | null = null;
  /** The parsed statement the edit dialog opened over (keep-slot texts). */
  private editStatement: Extract<ParsedFeatureStatement, { feature: 'mirror' }> | null = null;
  /** View-state half of edit mode: pre-statement rollback + boundary. */
  private session = new EditSession();
  /** A full render arrived mid-session — re-picked shape ids died. */
  private editSceneStale = false;
  /**
   * Current sources of the edited statement, for the keep chips' ghost: the
   * mirrored solids by call site, and the plane the statement names. Null
   * until the query lands (or when it can't answer).
   */
  private sourceSlots: { targets: SourceSlotRef[]; plane: SourceSlotRef | null } | null = null;
  private runner: ApplyRunner<MirrorApplyOptions | MirrorEditOptions>;
  private relabeler: OptionRelabeler<PlaneOption[]>;
  /** The translucent reflection the current mirror would place. */
  private ghost: FeatureGhostOverlay;

  constructor(
    container: HTMLElement,
    private viewer: Viewer,
    private navbar: Navbar,
    private hooks: {
      /** May return the current selection state — it seeds the dialog. */
      onEnter?: () => MirrorEnterSeed | void;
      /** Armed or disarmed — lets the Sketch button owner re-check `isActive`. */
      onActiveChange?: () => void;
      onSuspendSketchUI?: () => void;
      onResumeSketchUI?: () => void;
    } = {},
  ) {
    // Mirror opens the transform group — the tools that reposition or
    // reflect existing bodies. Like the repeat group it is not `immune`: it
    // hides while the exclusive sketch toolbar owns the bar.
    const group = navbar.getGroup('transform') ?? navbar.addGroup('transform', { visible: false });
    this.button = new FeatureButton(group, {
      icon: '/icons/mirror.png',
      label: 'Mirror',
      tip: 'Mirror solids',
      ariaLabel: 'Mirror solids across a plane',
      hidden: true,
    });
    this.button.onClick = () => {
      if (this.armed) {
        this.exit();
      } else {
        this.enter();
      }
    };
    this.sketchUI = new SketchUISuspender(viewer, hooks);
    this.solidPick = new SolidPickSelection(viewer, { multiple: true });
    this.ghost = new FeatureGhostOverlay(viewer);

    this.panel = new MirrorPanel(container);
    this.panel.onApply = () => void this.runner.apply();
    this.panel.onExit = () => this.exit();
    this.panel.onChange = () => {
      this.panel.setMessage(null);
      this.refreshHighlight();
      this.runner.schedulePreview();
    };
    this.panel.onRemoveTarget = (index) => {
      this.targets.splice(index, 1);
      this.panel.setMessage(null);
      this.refresh();
      this.runner.schedulePreview();
    };
    this.panel.onPlaneModeChange = () => {
      // The slot left face mode (✕, a standard/plane choice) — the entity
      // would otherwise silently ride along into the next face state.
      this.planeFaceEntity = null;
      this.refreshHighlight();
    };
    this.panel.onArmedSlotChange = () => this.syncViewport();

    this.runner = new ApplyRunner({
      panel: this.panel,
      isArmed: () => this.armed,
      build: () => this.editTarget ? this.buildEditRequest() : this.buildRequest(),
      send: (request, extras) => this.editTarget
        ? applyMirrorEdit(this.editTarget, { ...(request as MirrorEditOptions), ...extras })
        : applyMirror({ ...(request as MirrorApplyOptions), ...extras }),
      onApplied: () => this.exit(this.editTarget ? { editEnd: 'apply' } : { resume: 'lazy' }),
      failMessage: () => this.editTarget ? 'Could not apply the edit.' : 'Could not apply the mirror.',
      // The statement preview's geometric twin: the target solids stamped
      // where the reflection would put them, drawn translucent in the
      // viewport. Same debounce, same abort scope.
      ghost: {
        fetch: (_request, signal) => this.fetchGhost(signal),
        apply: (solids) => {
          if (solids) {
            this.ghost.set(solids, 'add');
          } else {
            this.ghost.clear();
          }
        },
      },
    });
    this.relabeler = new OptionRelabeler({
      sign: (planes) => planeOptionsSignature(planes),
      load: (planes) => labelWithPlaneNames(planes),
      isArmed: () => this.armed,
      apply: (planes) => {
        this.planes = planes;
        this.panel.setOptions(planes);
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
   * follows the armed slot ({@link syncViewport}) — the viewer routes face,
   * edge and plane-quad clicks here.
   */
  get isPicking(): boolean {
    return this.armed;
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
   * exactly the solids and planes the mirror's arguments can reference.
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
    this.targetOptions = collectSolidTargets(sceneObjects);
    this.planes = collectPlaneOptions(sceneObjects);
    if (this.editSceneStale) {
      this.editSceneStale = false;
      // A scene rebuild killed the re-picked shape ids; keep chips are
      // text-addressed and survive — but the entities their slots resolved to
      // died with the render, so the statement's own sources re-fetch.
      this.sourceSlots = null;
      if (this.planeFaceEntity) {
        this.planeFaceEntity = null;
        this.panel.setPlaneFaceChip(null);
        this.panel.setMessage('The code changed — the re-picked geometry was reset.');
      }
    }
    // Picked targets re-match by source line. A keep that resolved to a
    // solid statement becomes that statement's option — proper label,
    // create-mode toggling; unresolved keeps stay text-addressed verbatim.
    this.targets = this.targets.flatMap((target): MirrorTargetChoice[] => {
      if (target.kind === 'keep') {
        const match = target.loc && this.targetOptions.find(o =>
          o.filePath === target.loc!.filePath && o.line === target.loc!.line);
        return match ? [{ kind: 'option', option: match }] : [target];
      }
      const match = this.targetOptions.find(o =>
        o.filePath === target.option.filePath && o.line === target.option.line);
      return match ? [{ kind: 'option', option: match }] : [];
    });
    if (!this.sourceSlots) {
      void this.loadEditSources();
    }
    this.panel.setOptions(this.planes);
    this.refreshLabels();
    this.syncViewport();
    this.refresh();
    this.runner.schedulePreview();
  }

  update(sceneObjects: SceneObjectRender[]): void {
    this.sceneObjects = sceneObjects;
    this.targetOptions = collectSolidTargets(sceneObjects);
    this.planes = collectPlaneOptions(sceneObjects);
    this.sceneSketchActive = collectSketchProfiles(sceneObjects)[0]?.kind === 'active';
    this.available = this.targetOptions.length > 0;
    this.navbar.setGroupVisible('transform', this.available);
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
    this.targets = this.targets.flatMap((target): MirrorTargetChoice[] => {
      if (target.kind === 'keep') {
        return [target];
      }
      const match = this.targetOptions.find(o =>
        o.filePath === target.option.filePath && o.line === target.option.line);
      return match ? [{ kind: 'option', option: match }] : [];
    });
    if (this.planeFaceEntity) {
      this.planeFaceEntity = null;
      this.panel.setPlaneFaceChip(null);
    }
    this.panel.setOptions(this.planes);
    this.refreshLabels();
    this.syncViewport();
    this.refresh();
    this.runner.schedulePreview();
  }

  /**
   * Open the dialog over an existing mirror statement (timeline
   * double-click). The session rolls the viewport back to just before the
   * statement — the world its arguments see, where the solids and planes it
   * references are visible and pickable. The plane slot starts on a
   * "Current: …" chip keeping the statement's own expression; the targets
   * slot starts on one kept chip per statement target, toggled and re-picked
   * like create mode. Apply rewrites the statement in place.
   */
  enterEdit(
    target: FeatureEditTarget,
    parsed: Extract<ParsedFeatureStatement, { feature: 'mirror' }>,
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
    this.panel.showEdit({
      op: parsed.op,
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
    this.planeFaceEntity = null;
    // Composing a mirror means looking at the whole scene, not down the
    // active sketch plane — leave sketch editing right away (resumed on
    // cancel; an apply's re-render takes over).
    if (this.sceneSketchActive) {
      this.sketchUI.suspend();
    }
    this.syncButton();
    this.panel.show();
    if (seeded) {
      this.seedFromSelection(seeded);
    }
    this.panel.setOptions(this.planes);
    this.refreshLabels();
    this.syncViewport();
    this.refresh();
    this.runner.schedulePreview();
  }

  /**
   * Arm the dialog around whatever was already selected: every selected
   * face/edge resolves to its owning solid, and the distinct solids open as
   * the initial target chips; a pending plane (a clicked plane feature)
   * fills the plane slot.
   */
  private seedFromSelection({ seed, pendingPlaneShapeId }: MirrorEnterSeed): void {
    if (pendingPlaneShapeId) {
      const plane = resolvePlaneByShapeId(pendingPlaneShapeId, this.sceneObjects);
      const option = plane?.sourceLocation
        ? planeOptionForLocation(this.planes, plane.sourceLocation)
        : undefined;
      if (option) {
        this.panel.selectPlane(option);
        // The plane is chosen — the next pick composes the target list.
        this.panel.armSlot('targets');
      }
    }
    for (const entity of seed) {
      const option = solidTargetForShapeId(entity.shapeId, this.targetOptions);
      if (option && !this.targets.some(t => t.kind === 'option'
        && t.option.filePath === option.filePath && t.option.line === option.line)) {
        this.targets.push({ kind: 'option', option });
      }
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
    this.targets = [];
    this.planeFaceEntity = null;
    this.solidPick.set([]);
    this.runner.cancelPreview();
    this.ghost.clear();
    this.viewer.clearHighlight();
    this.viewer.pickFilter = 'all';
    this.viewer.hideStandardPlanes();
    // pickPlanes is left alone: syncButton's onActiveChange runs the modify
    // service's neutral restore, which owns the channel.
    this.syncButton();
    this.panel.hide();
    this.sketchUI.resume((opts.resume ?? 'immediate') === 'immediate');
  }

  /**
   * Routes viewer clicks while the dialog is armed — the pick channels
   * follow the armed slot, so only its picks arrive. The armed Solids slot:
   * any face or edge click selects the owning solid whole (clicking one of
   * its faces again clears it back). The armed plane slot: a face sets the
   * mirror plane to that face (clicking it again clears it back). Empty-space
   * clicks keep the selection.
   */
  handleClick(shapeId: string | null, sub: SubSelection): void {
    if (!this.armed || !shapeId || !sub) {
      return;
    }
    if (sub.type === 'face' && this.isPlanePicking) {
      this.planeFaceEntity = toggleEntity(this.planeFaceEntity, { shapeId, sub });
      this.panel.setPlaneFaceChip(this.planeFaceEntity ? 'Picked face' : null);
      this.panel.setMessage(null);
      this.refreshHighlight();
      this.runner.schedulePreview();
      return;
    }
    if ((sub.type === 'face' || sub.type === 'edge') && this.panel.armedSlot === 'targets') {
      const option = solidTargetForShapeId(shapeId, this.targetOptions);
      if (!option) {
        this.panel.setMessage('That shape cannot be mirrored — pick a solid.');
        return;
      }
      this.toggleTarget(option);
    }
  }

  /** A plane feature's quad was clicked while the plane slot is armed. */
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

  /** A shown origin plane was clicked while the plane slot is armed. */
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
   * A timeline row was clicked while the dialog is armed: a solid row
   * toggles it in the targets list; plane rows land in the plane slot.
   * Every row is consumed so the default rollback can't close the dialog
   * mid-flow.
   */
  handleTimelinePick(obj: SceneObjectRender): boolean {
    if (!this.armed) {
      return false;
    }
    if (obj.type === 'plane' && obj.sourceLocation) {
      const option = planeOptionForLocation(this.planes, obj.sourceLocation);
      if (!option) {
        this.panel.setMessage(PLANE_UNAVAILABLE_MESSAGE);
        return true;
      }
      this.pickPlane(option);
      return true;
    }
    const option = solidTargetForRow(obj, this.targetOptions);
    if (!option) {
      this.panel.setMessage('That row has no solid to mirror — pick a solid-producing feature.');
      return true;
    }
    this.toggleTarget(option);
    return true;
  }

  /** Toggle a solid target chip (viewport or timeline pick). */
  private toggleTarget(option: SolidTargetOption): void {
    // A kept target that resolved to this statement counts as the same chip
    // — the pick toggles it off instead of duplicating the solid.
    const existing = this.targets.findIndex(t => t.kind === 'option'
      ? t.option.filePath === option.filePath && t.option.line === option.line
      : t.loc !== undefined && t.loc.filePath === option.filePath && t.loc.line === option.line);
    if (existing >= 0) {
      this.targets.splice(existing, 1);
    } else {
      this.targets.push({ kind: 'option', option });
    }
    // The pick landed in the Solids slot — it takes the armed border.
    this.panel.armSlot('targets');
    this.panel.setMessage(null);
    this.refresh();
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

  /**
   * The edited statement's own sources, resolved against the pre-statement
   * scene: what its kept chips actually name. Only the ghost reads them — the
   * apply rewrites a keep verbatim — so a query that can't answer costs a
   * preview, never a correct statement.
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
    this.sourceSlots = result.ok && result.feature === 'mirror'
      ? { targets: result.targets, plane: result.plane }
      : { targets: [], plane: null };
    // The ghost's keep slots read `sourceSlots`, which resolves after
    // `enterEdit` already scheduled its preview — re-kick so the ghost appears
    // now that the statement's own sources are known.
    this.runner.schedulePreview();
  }

  // -------------------------------------------------------------------------
  // Live geometry ("ghost")
  // -------------------------------------------------------------------------

  /**
   * The live geometry for the current form state: each target solid's own
   * body, stamped under the reflection the apply itself would produce. Both
   * dialogs hand the server explicit refs, so the endpoint never has to know
   * which mode asked. A slot the ghost can't address (no solids yet, a plane
   * still unpicked, a keep chip over an expression) means no ghost.
   */
  private async fetchGhost(signal: AbortSignal): Promise<GhostSolid[] | null> {
    const targets = this.ghostTargets();
    if (!targets) {
      return null;
    }
    const plane = this.ghostPlane();
    if (!plane) {
      return null;
    }
    const request: MirrorGhostRequest = {
      feature: 'mirror',
      op: this.panel.values().op,
      targets,
      plane,
    };
    const result = await fetchFeatureGhostResult(request, signal);
    // Only a limit the user can act on reaches the panel — never an ordinary
    // refusal (a stale pick, a consumed statement: those just leave the
    // viewport as it was). A superseded fetch says nothing either.
    if (result.notice && !signal.aborted && this.armed) {
      this.panel.setMessage(result.notice);
    }
    return result.solids;
  }

  /**
   * The solids being reflected, by call site. A kept chip travels as the
   * statement its expression named, or — for one the parse couldn't address —
   * as whatever the sources query resolved that argument to. A target neither
   * could place means no ghost at all: a mirror missing one of its bodies is
   * a different mirror, not a partial one.
   *
   * An implicit mirror (no target arguments at all) reflects the LAST
   * feature at its own line (mirror-shape.ts:55) — in the edit session's
   * rolled-back scene that is the last statement the targets slot offers.
   */
  private ghostTargets(): { filePath: string; line: number }[] | null {
    if (this.targets.length === 0) {
      if (!this.editTarget || (this.editStatement?.targetTexts.length ?? 0) > 0) {
        return null;
      }
      const last = this.targetOptions[this.targetOptions.length - 1];
      return last ? [{ filePath: last.filePath, line: last.line }] : null;
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

  /** The plane slot, in the form the kernel resolves. */
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

  private buildRequest(): MirrorApplyOptions | { error: string } {
    if (this.targets.length === 0) {
      return { error: 'Pick the solids to mirror in the viewport first.' };
    }
    // Create mode never carries keep entries — every chip is a picked solid.
    const targets = this.targets.flatMap(t => t.kind === 'option'
      ? [{ filePath: t.option.filePath, line: t.option.line, column: t.option.column }]
      : []);
    const plane = this.planeRef();
    if ('error' in plane) {
      return plane;
    }
    if (plane.kind === 'keep') {
      return { error: 'Choose the plane to mirror across.' };
    }
    return { targets, plane, op: this.panel.values().op };
  }

  /**
   * The edit-mode apply payload. A plane slot still on its "Current: …"
   * entry ships as a keep — the transform preserves the statement's
   * expression byte for byte; the target list mixes kept statement targets
   * with re-picked solids (an untouched implicit mirror keeps reflecting the
   * last feature). A re-picked face synthesizes against the session boundary.
   */
  private buildEditRequest(): MirrorEditOptions | { error: string } {
    // An originally implicit mirror (no explicit target arguments) stays
    // implicit while the targets slot is untouched; explicit targets can be
    // re-picked but never all removed.
    let targets: MirrorEditTargetRef[] | undefined;
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
      return { error: 'Pick the solids to mirror in the viewport first.' };
    }
    const plane = this.planeRef();
    if ('error' in plane) {
      return plane;
    }
    return {
      plane,
      op: this.panel.values().op,
      targets,
      expectedStatement: this.session.expectedStatement,
      before: plane.kind === 'face' ? this.session.boundary ?? undefined : undefined,
    };
  }

  // -------------------------------------------------------------------------
  // Viewport reflection + sketch-editing suspension
  // -------------------------------------------------------------------------

  /**
   * The viewer's pick channels follow the panel's armed slot, so the slot
   * border says exactly where the next 3D click lands: the armed Solids slot
   * takes any face or edge (the pick selects the owning solid whole); the
   * armed plane slot takes faces, plane quads and the origin planes shown as
   * pick targets.
   */
  private syncViewport(): void {
    if (!this.armed) {
      return;
    }
    const planeArmed = this.isPlanePicking;
    this.viewer.pickSketchWires = false;
    this.viewer.pickAxes = false;
    this.viewer.pickPlanes = planeArmed;
    this.viewer.pickFilter = planeArmed ? 'face' : 'all';
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
   * Repaint the viewport selection: the chosen solids whole, plus the picked
   * mirror face or the chosen plane feature's quad — one combined pass
   * through the shared picker.
   */
  private refreshHighlight(): void {
    if (!this.armed) {
      return;
    }
    const entities: SelectedEntity[] = [];
    const planeQuadIds: string[] = [];
    const selection = this.panel.planeSelection();
    if (selection?.kind === 'plane') {
      planeQuadIds.push(...planeQuadShapeIds(selection.option, this.sceneObjects));
    } else if (selection?.kind === 'face' && this.planeFaceEntity) {
      entities.push(this.planeFaceEntity);
    }
    this.solidPick.set(this.targets.flatMap(t => t.kind === 'option' ? t.option.shapeIds : []));
    this.solidPick.refreshHighlight({ entities, planeQuadIds });
  }

  /**
   * Async label pass: planes bound to variables show their names
   * ("midPlane — line 5"). Applied only if the dialog is still armed on the
   * same option set when the lookups land.
   */
  private refreshLabels(): void {
    void this.relabeler.refresh(this.planes);
  }

  private syncButton(): void {
    this.button.setActive(this.armed);
    // Every armed flip lands here — the Sketch button disables while a
    // create dialog is up.
    this.hooks.onActiveChange?.();
  }
}
