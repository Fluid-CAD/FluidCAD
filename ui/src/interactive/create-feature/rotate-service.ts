import {
  applyRotate, applyRotateEdit, FeatureEditTarget, fetchFeatureGhostResult, fetchFeatureSources,
  GhostAxisRef, GhostSolid, ParsedFeatureStatement, RotateApplyOptions, RotateEditAxisRef,
  RotateEditOptions, RotateEditTargetRef, RotateGhostRequest, SourceSlotRef,
} from '../../api';
import { toggleEntity } from '../../helpers/entities';
import { SceneObjectRender, SubSelection } from '../../types';
import { SelectedEntity, Viewer } from '../../viewer';
import { Navbar } from '../../ui/navbar';
import { EditSession, EditSessionInfo } from '../edit-session';
import { SolidPickSelection } from '../solid-pick';
import { RotatePanel } from './rotate-panel';
import { FeatureButton } from './feature-button';
import { FeatureGhostOverlay } from './feature-ghost';
import { ApplyRunner } from './apply-runner';
import { SketchUISuspender } from './sketch-suspender';
import { OptionRelabeler, refreshScopeVariables } from './option-relabeler';
import { collectSolidTargets, solidTargetForRow, solidTargetForShapeId, SolidTargetOption } from './solid-targets';
import {
  AXIS_CONSUMED_MESSAGE, AxisOption, axisLineShapeIds, axisOptionForLocation, axisOptionForShape,
  axisOptionsSignature, collectAxisOptions, labelWithAxisNames, pickedAxisRef,
} from './axis-options';
import { collectSketchProfiles, sourceChip } from './sketch-profiles';

/** What the seeding hook hands over when the dialog arms. */
export type RotateEnterSeed = {
  /** The neutral-mode selection (faces/edges) at activation. */
  seed: SelectedEntity[];
};

/**
 * One chosen target: a whole-solid pick resolved to its statement, or —
 * edit mode only — a kept statement target by its position in the parsed
 * `targetTexts`, preserved verbatim. A keep whose expression resolved to a
 * statement carries that statement's location (`loc`): it converts into its
 * solid option at the rollback boundary, so the chip shows the statement's
 * own label and a re-pick toggles it like create mode.
 */
type RotateTargetChoice =
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
 * The Rotate dialog on the create rails — the mirror's transform sibling:
 * turn one or more solids around an axis, moving them (the default) or
 * leaving copies behind. The solids are picked in the viewport — any face or
 * edge click while the Solids slot is armed selects the owning solid whole
 * (the shape-properties picker's idiom, shared via {@link SolidPickSelection})
 * — or by their timeline rows; the axis comes from the X/Y/Z quick buttons,
 * an axis statement (its dashed line in 3D or its timeline row), or a picked
 * straight solid edge — the revolve axis's exact picker. Arming with a
 * selection already highlighted seeds the dialog: the selected entities'
 * solids open as target chips. A translucent ghost draws the turned bodies as
 * the angle is dialled in — each target's own body under the apply's exact
 * rotation matrix. Apply writes `rotate(<axis>, <angle>, …)` — the re-render
 * is the preview, editor undo the rollback.
 */
export class RotateFeatureService {
  private panel: RotatePanel;
  private button: FeatureButton;
  private armed = false;
  private available = false;
  private targetOptions: SolidTargetOption[] = [];
  /** The chosen targets, in pick order — the rotate's argument order. */
  private targets: RotateTargetChoice[] = [];
  private axes: AxisOption[] = [];
  private sceneObjects: SceneObjectRender[] = [];
  private sceneSketchActive = false;
  private sketchUI: SketchUISuspender;
  /** The shared whole-solid highlight (the target chips' viewport echo). */
  private solidPick: SolidPickSelection;
  /** The picked axis edge (the axis slot's `edge` mode), or null. */
  private axisEdgeEntity: SelectedEntity | null = null;
  /** Statement being edited in place (timeline double-click), or null. */
  private editTarget: FeatureEditTarget | null = null;
  /** The parsed statement the edit dialog opened over (keep-slot texts). */
  private editStatement: Extract<ParsedFeatureStatement, { feature: 'rotate' }> | null = null;
  /** View-state half of edit mode: pre-statement rollback + boundary. */
  private session = new EditSession();
  /** A full render arrived mid-session — re-picked shape ids died. */
  private editSceneStale = false;
  /**
   * Current sources of the edited statement, for the keep chips' ghost: the
   * rotated solids by call site, and the axis the statement names. Null
   * until the query lands (or when it can't answer).
   */
  private sourceSlots: { targets: SourceSlotRef[]; axis: SourceSlotRef | null } | null = null;
  private runner: ApplyRunner<RotateApplyOptions | RotateEditOptions>;
  private relabeler: OptionRelabeler<AxisOption[]>;
  /** The translucent turned bodies the current rotate would place. */
  private ghost: FeatureGhostOverlay;

  constructor(
    container: HTMLElement,
    private viewer: Viewer,
    private navbar: Navbar,
    private hooks: {
      /** May return the current selection state — it seeds the dialog. */
      onEnter?: () => RotateEnterSeed | void;
      /** Armed or disarmed — lets the Sketch button owner re-check `isActive`. */
      onActiveChange?: () => void;
      onSuspendSketchUI?: () => void;
      onResumeSketchUI?: () => void;
    } = {},
  ) {
    // Rotate joins the transform group as its second contributor: the tools
    // that reposition or reflect existing bodies sit together (Mirror,
    // Rotate) with no divider between them. The group shows while either
    // service votes visible; like the repeat group it is not `immune` — it
    // hides while the exclusive sketch toolbar owns the bar.
    const group = navbar.getGroup('transform') ?? navbar.addGroup('transform', { visible: false });
    this.button = new FeatureButton(group, {
      icon: '/icons/rotate.png',
      label: 'Rotate',
      tip: 'Rotate solids',
      ariaLabel: 'Rotate solids around an axis',
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

    this.panel = new RotatePanel(container);
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
    this.panel.onAxisModeChange = () => {
      // The slot left edge mode (✕, a standard/axis choice) — the entity
      // would otherwise silently ride along into the next edge state.
      this.axisEdgeEntity = null;
      this.refreshHighlight();
    };
    this.panel.onArmedSlotChange = () => this.syncViewport();

    this.runner = new ApplyRunner({
      panel: this.panel,
      isArmed: () => this.armed,
      build: () => this.editTarget ? this.buildEditRequest() : this.buildRequest(),
      send: (request, extras) => this.editTarget
        ? applyRotateEdit(this.editTarget, { ...(request as RotateEditOptions), ...extras })
        : applyRotate({ ...(request as RotateApplyOptions), ...extras }),
      onApplied: () => this.exit(this.editTarget ? { editEnd: 'apply' } : { resume: 'lazy' }),
      failMessage: () => this.editTarget ? 'Could not apply the edit.' : 'Could not apply the rotate.',
      // The statement preview's geometric twin: the target solids stamped
      // where the rotation would put them, drawn translucent in the
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
      sign: (axes) => axisOptionsSignature(axes),
      load: (axes) => labelWithAxisNames(axes),
      isArmed: () => this.armed,
      apply: (axes) => {
        this.axes = axes;
        this.panel.setOptions(axes);
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
   * follows the armed slot ({@link syncViewport}) — the viewer routes edge,
   * face and axis clicks here.
   */
  get isPicking(): boolean {
    return this.armed;
  }

  /** Axis-line and edge clicks route here (the armed axis slot). */
  get isAxisPicking(): boolean {
    return this.armed && this.panel.armedSlot === 'axis';
  }

  /** True while armed picking has suspended sketch editing. */
  get sketchUISuspended(): boolean {
    return this.sketchUI.suspended;
  }

  /**
   * Every render lands here. An open edit session owns the view: it keeps
   * the viewport rolled back to just before the edited statement, and at
   * that boundary the slot options rebuild from the pre-statement scene —
   * exactly the solids and axes the rotate's arguments can reference.
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
    this.axes = collectAxisOptions(sceneObjects);
    if (this.editSceneStale) {
      this.editSceneStale = false;
      // A scene rebuild killed the re-picked shape ids; keep chips are
      // text-addressed and survive — but the entities their slots resolved to
      // died with the render, so the statement's own sources re-fetch.
      this.sourceSlots = null;
      if (this.axisEdgeEntity) {
        this.axisEdgeEntity = null;
        this.panel.setAxisEdgeChip(null);
        this.panel.setMessage('The code changed — the re-picked geometry was reset.');
      }
    }
    // Picked targets re-match by source line. A keep that resolved to a
    // solid statement becomes that statement's option — proper label,
    // create-mode toggling; unresolved keeps stay text-addressed verbatim.
    this.targets = this.targets.flatMap((target): RotateTargetChoice[] => {
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
    this.panel.setOptions(this.axes);
    this.refreshLabels();
    this.syncViewport();
    this.refresh();
    this.runner.schedulePreview();
  }

  update(sceneObjects: SceneObjectRender[]): void {
    this.sceneObjects = sceneObjects;
    this.targetOptions = collectSolidTargets(sceneObjects);
    this.axes = collectAxisOptions(sceneObjects);
    this.sceneSketchActive = collectSketchProfiles(sceneObjects)[0]?.kind === 'active';
    this.available = this.targetOptions.length > 0;
    this.navbar.setGroupVisible('transform', this.available, 'rotate');
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
    this.targets = this.targets.flatMap((target): RotateTargetChoice[] => {
      if (target.kind === 'keep') {
        return [target];
      }
      const match = this.targetOptions.find(o =>
        o.filePath === target.option.filePath && o.line === target.option.line);
      return match ? [{ kind: 'option', option: match }] : [];
    });
    if (this.axisEdgeEntity) {
      this.axisEdgeEntity = null;
      this.panel.setAxisEdgeChip(null);
    }
    this.panel.setOptions(this.axes);
    this.refreshLabels();
    this.syncViewport();
    this.refresh();
    this.runner.schedulePreview();
  }

  /**
   * Open the dialog over an existing rotate statement (timeline
   * double-click). The session rolls the viewport back to just before the
   * statement — the world its arguments see, where the solids and axes it
   * references are visible and pickable. The axis slot starts on a
   * "Current: …" chip keeping the statement's own expression; the targets
   * slot starts on one kept chip per statement target, toggled and re-picked
   * like create mode. Apply rewrites the statement in place.
   */
  enterEdit(
    target: FeatureEditTarget,
    parsed: Extract<ParsedFeatureStatement, { feature: 'rotate' }>,
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
    this.axisEdgeEntity = null;
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
      mode: parsed.copy ? 'copy' : 'move',
      angle: parsed.angle,
      axisLabel: parsed.axisText,
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
    this.axisEdgeEntity = null;
    // Composing a rotate means looking at the whole scene, not down the
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
    this.panel.setOptions(this.axes);
    this.refreshLabels();
    this.syncViewport();
    this.refresh();
    this.runner.schedulePreview();
  }

  /**
   * Arm the dialog around whatever was already selected: every selected
   * face/edge resolves to its owning solid, and the distinct solids open as
   * the initial target chips.
   */
  private seedFromSelection({ seed }: RotateEnterSeed): void {
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
    this.axisEdgeEntity = null;
    this.solidPick.set([]);
    this.runner.cancelPreview();
    this.ghost.clear();
    this.viewer.clearHighlight();
    this.viewer.pickFilter = 'all';
    this.viewer.pickAxes = false;
    this.syncButton();
    this.panel.hide();
    this.sketchUI.resume((opts.resume ?? 'immediate') === 'immediate');
  }

  /**
   * Routes viewer clicks while the dialog is armed — the pick channels
   * follow the armed slot, so only its picks arrive. The armed Solids slot:
   * any face or edge click selects the owning solid whole (clicking one of
   * its faces again clears it back). The armed axis slot: a solid edge sets
   * the axis to that edge (clicking it again clears it back), an axis line
   * sets it to that statement. Empty-space clicks keep the selection.
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
      const next = toggleEntity(this.axisEdgeEntity, { shapeId, sub });
      this.axisEdgeEntity = next;
      this.panel.setAxisEdgeChip(next ? 'Picked edge' : null);
      this.panel.setMessage(null);
      this.refreshHighlight();
      this.runner.schedulePreview();
      return;
    }
    if ((sub.type === 'face' || sub.type === 'edge') && this.panel.armedSlot === 'targets') {
      const option = solidTargetForShapeId(shapeId, this.targetOptions);
      if (!option) {
        this.panel.setMessage('That shape cannot be rotated — pick a solid.');
        return;
      }
      this.toggleTarget(option);
    }
  }

  /**
   * A timeline row was clicked while the dialog is armed: a solid row
   * toggles it in the targets list; axis rows land in the axis slot. Every
   * row is consumed so the default rollback can't close the dialog mid-flow.
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
    const option = solidTargetForRow(obj, this.targetOptions);
    if (!option) {
      this.panel.setMessage('That row has no solid to rotate — pick a solid-producing feature.');
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

  /** An offered axis landed in the axis slot (3D or timeline pick). */
  private pickAxis(option: AxisOption): void {
    this.axisEdgeEntity = null;
    this.panel.selectAxis(option);
    this.panel.setMessage(null);
    this.refreshHighlight();
    this.runner.schedulePreview();
  }

  /**
   * The axis slot's request field, or the message blocking it. A keep
   * selection (edit mode) references the statement's own axis text — the
   * create paths never see one.
   */
  private axisRef(): RotateEditAxisRef | { error: string } {
    const selection = this.panel.axisSelection();
    if (!selection) {
      return { error: 'Choose the axis to rotate around.' };
    }
    if (selection.kind === 'keep') {
      return { kind: 'keep' };
    }
    return pickedAxisRef(selection, this.axisEdgeEntity, 'Pick the axis edge first.');
  }

  private async refreshScopeVariables(): Promise<void> {
    const line = this.editTarget?.line ?? null;
    await refreshScopeVariables(line, this.panel,
      () => this.armed && (this.editTarget?.line ?? null) === line);
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
    this.sourceSlots = result.ok && result.feature === 'rotate'
      ? { targets: result.targets, axis: result.axis }
      : { targets: [], axis: null };
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
   * body, stamped under the rotation the apply itself would produce. Both
   * dialogs hand the server explicit refs, so the endpoint never has to know
   * which mode asked. A slot the ghost can't address (no solids yet, an axis
   * still unpicked, a keep chip over an expression) means no ghost.
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
    const axis = this.ghostAxis();
    if (!axis) {
      return null;
    }
    const request: RotateGhostRequest = {
      feature: 'rotate',
      targets,
      axis,
      angle: values.angle,
    };
    const result = await fetchFeatureGhostResult(request, signal);
    // Only a limit the user can act on reaches the panel — never an ordinary
    // refusal (a stale pick, an expression the server can't evaluate: those
    // just leave the viewport as it was). A superseded fetch says nothing
    // either.
    if (result.notice && !signal.aborted && this.armed) {
      this.panel.setMessage(result.notice);
    }
    return result.solids;
  }

  /**
   * The solids being turned, by call site. A kept chip travels as the
   * statement its expression named, or — for one the parse couldn't address —
   * as whatever the sources query resolved that argument to. A target neither
   * could place means no ghost at all: a rotate missing one of its bodies is
   * a different rotate, not a partial one.
   *
   * An implicit rotate (no target arguments at all) turns every object active
   * at its own line (rotate.ts:48-57), which in an edit session's rolled-back
   * scene is exactly the statements the targets slot is offering — so those
   * are what it ghosts.
   */
  private ghostTargets(): { filePath: string; line: number }[] | null {
    if (this.targets.length === 0) {
      if (!this.editTarget || (this.editStatement?.targetTexts.length ?? 0) > 0) {
        return null;
      }
      const implicit = this.targetOptions.map(o => ({ filePath: o.filePath, line: o.line }));
      return implicit.length > 0 ? implicit : null;
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

  /** The axis slot, in the form the kernel resolves. */
  private ghostAxis(): GhostAxisRef | null {
    const selection = this.panel.axisSelection();
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
      return this.axisEdgeEntity
        ? { kind: 'edge', shapeId: this.axisEdgeEntity.shapeId, index: this.axisEdgeEntity.sub.index }
        : null;
    }
    // The kept statement axis, as the sources query resolved it — an `axis()`
    // the statement names by variable. A world-axis literal never reaches here
    // (the slot reads `'z'` as the standard selection itself), and anything
    // else is an expression no ghost can stand in for.
    const loc = sourceStatement(this.sourceSlots?.axis);
    return loc ? { kind: 'axis', filePath: loc.filePath, line: loc.line } : null;
  }

  private buildRequest(): RotateApplyOptions | { error: string } {
    const values = this.panel.values();
    if ('error' in values) {
      return values;
    }
    if (this.targets.length === 0) {
      return { error: 'Pick the solids to rotate in the viewport first.' };
    }
    // Create mode never carries keep entries — every chip is a picked solid.
    const targets = this.targets.flatMap(t => t.kind === 'option'
      ? [{ filePath: t.option.filePath, line: t.option.line, column: t.option.column }]
      : []);
    const axis = this.axisRef();
    if ('error' in axis) {
      return axis;
    }
    if (axis.kind === 'keep') {
      return { error: 'Choose the axis to rotate around.' };
    }
    return {
      targets, axis, angle: values.angle, copy: values.mode === 'copy',
      newVariables: values.newVariables,
    };
  }

  /**
   * The edit-mode apply payload. An axis slot still on its "Current: …"
   * entry ships as a keep — the transform preserves the statement's
   * expression byte for byte; the target list mixes kept statement targets
   * with re-picked solids (an untouched implicit rotate keeps turning every
   * active object). A re-picked edge synthesizes against the session
   * boundary.
   */
  private buildEditRequest(): RotateEditOptions | { error: string } {
    const values = this.panel.values();
    if ('error' in values) {
      return values;
    }
    // An originally implicit rotate (no explicit target arguments) stays
    // implicit while the targets slot is untouched; explicit targets can be
    // re-picked but never all removed.
    let targets: RotateEditTargetRef[] | undefined;
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
      return { error: 'Pick the solids to rotate in the viewport first.' };
    }
    const axis = this.axisRef();
    if ('error' in axis) {
      return axis;
    }
    return {
      axis,
      angle: values.angle,
      copy: values.mode === 'copy',
      targets,
      newVariables: values.newVariables,
      expectedStatement: this.session.expectedStatement,
      before: axis.kind === 'edge' ? this.session.boundary ?? undefined : undefined,
    };
  }

  // -------------------------------------------------------------------------
  // Viewport reflection + sketch-editing suspension
  // -------------------------------------------------------------------------

  /**
   * The viewer's pick channels follow the panel's armed slot, so the slot
   * border says exactly where the next 3D click lands: the armed Solids slot
   * takes any face or edge (the pick selects the owning solid whole); the
   * armed axis slot takes solid edges and axis lines.
   */
  private syncViewport(): void {
    if (!this.armed) {
      return;
    }
    const axisArmed = this.isAxisPicking;
    this.viewer.pickSketchWires = false;
    this.viewer.pickAxes = axisArmed;
    this.viewer.pickPlanes = false;
    this.viewer.pickFilter = axisArmed ? 'edge' : 'all';
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
   * axis edge or the chosen axis statement's dashed line (tinted whole, like
   * sketch wires) — one combined pass through the shared picker.
   */
  private refreshHighlight(): void {
    if (!this.armed) {
      return;
    }
    const wireIds: string[] = [];
    const entities: SelectedEntity[] = [];
    const selection = this.panel.axisSelection();
    if (selection?.kind === 'axis') {
      wireIds.push(...axisLineShapeIds(selection.option, this.sceneObjects));
    } else if (selection?.kind === 'edge' && this.axisEdgeEntity) {
      entities.push(this.axisEdgeEntity);
    }
    this.solidPick.set(this.targets.flatMap(t => t.kind === 'option' ? t.option.shapeIds : []));
    this.solidPick.refreshHighlight({ entities, wireIds });
  }

  /**
   * Async label pass: axes bound to variables show their names
   * ("ringAxis — line 5"). Applied only if the dialog is still armed on the
   * same option set when the lookups land.
   */
  private refreshLabels(): void {
    void this.relabeler.refresh(this.axes);
  }

  private syncButton(): void {
    this.button.setActive(this.armed);
    // Every armed flip lands here — the Sketch button disables while a
    // create dialog is up.
    this.hooks.onActiveChange?.();
  }
}
