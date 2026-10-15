import {
  applySplit, applySplitEdit, FeatureEditTarget, featureGhostScope, fetchFeatureGhostResult, fetchFeatureSources,
  GhostPlaneRef, GhostSolid, ParsedFeatureStatement, SketchSourceRef, SourceSlotRef, SplitApplyOptions,
  SplitEditOptions, SplitEditPlaneRef, SplitEditTargetRef, SplitGhostRequest, SplitPlaneRef,
} from '../../api';
import { toggleEntity } from '../../helpers/entities';
import { SceneObjectRender, SubSelection } from '../../types';
import { SelectedEntity, Viewer } from '../../viewer';
import { Navbar } from '../../ui/navbar';
import { StandardPlaneId } from '../../scene/standard-planes';
import { EditSession, EditSessionInfo } from '../edit-session';
import { SolidPickSelection } from '../solid-pick';
import { SplitPanel } from './split-panel';
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
import { collectSketchProfiles, resolveSketchRow, sourceChip } from './sketch-profiles';
import { iconUrl } from '../../ui/icon-url';

/** What the seeding hook hands over when the dialog arms. */
export type SplitEnterSeed = {
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
type SplitTargetChoice =
  | { kind: 'option'; option: SolidTargetOption }
  | { kind: 'keep'; sourceIndex: number; label: string; loc?: { filePath: string; line: number; column: number } };

/** A sketched line picked as the cut's seed: its statement and its sketch's, by call site. */
type SeedLinePick = {
  shapeId: string;
  line: SketchSourceRef;
  sketch: SketchSourceRef;
  label: string;
};

/**
 * The statement a resolved source slot names, or null when it names none —
 * an inline argument, a clone, an expression the resolver can't address.
 */
function sourceStatement(slot: SourceSlotRef | undefined | null): SketchSourceRef | null {
  return slot?.kind === 'sketch' ? { filePath: slot.filePath, line: slot.line, column: slot.column } : null;
}

/**
 * The Split dialog on the create rails — the modifier that parts solids at
 * a plane. The cut comes from an origin-plane quad, a `plane()` feature (its
 * quad in 3D or its timeline row), a picked planar face, or a sketched line
 * picked in the viewport — the plane the line would sweep out of its sketch.
 * The solids are optional: picked in the viewport (any face or edge click
 * while the Solids slot is armed selects the owning solid whole) or by their
 * timeline rows, or left empty to split every solid in scope. A translucent
 * ghost draws the cut plane through the bodies as it is dialled in — and,
 * when one side is dropped, the pieces that go in the cut's red. Apply
 * writes `split(<cut>[, { keep }], …)` — the re-render is the
 * preview, editor undo the rollback.
 */
export class SplitFeatureService {
  private panel: SplitPanel;
  private button: FeatureButton;
  private armed = false;
  private available = false;
  private targetOptions: SolidTargetOption[] = [];
  /** The chosen targets, in pick order — the split's argument order. */
  private targets: SplitTargetChoice[] = [];
  private planes: PlaneOption[] = [];
  private sceneObjects: SceneObjectRender[] = [];
  private sceneSketchActive = false;
  private sketchUI: SketchUISuspender;
  /** The shared whole-solid highlight (the target chips' viewport echo). */
  private solidPick: SolidPickSelection;
  /** The picked cut face (the cut slot's `face` mode), or null. */
  private planeFaceEntity: SelectedEntity | null = null;
  /** The picked seed line (the cut slot's `sketchLine` mode), or null. */
  private seedLine: SeedLinePick | null = null;
  /** Statement being edited in place (timeline double-click), or null. */
  private editTarget: FeatureEditTarget | null = null;
  /** The parsed statement the edit dialog opened over (keep-slot texts). */
  private editStatement: Extract<ParsedFeatureStatement, { feature: 'split' }> | null = null;
  /** View-state half of edit mode: pre-statement rollback + boundary. */
  private session = new EditSession();
  /** A full render arrived mid-session — re-picked shape ids died. */
  private editSceneStale = false;
  /**
   * Current sources of the edited statement, for the keep chips' ghost: the
   * split solids by call site, and the cut the statement names. Null until
   * the query lands (or when it can't answer).
   */
  private sourceSlots: { targets: SourceSlotRef[]; plane: SourceSlotRef | null } | null = null;
  private runner: ApplyRunner<SplitApplyOptions | SplitEditOptions>;
  private relabeler: OptionRelabeler<PlaneOption[]>;
  /** The translucent cut the current split would make. */
  private ghost: FeatureGhostOverlay;

  constructor(
    container: HTMLElement,
    private viewer: Viewer,
    private navbar: Navbar,
    private hooks: {
      /** May return the current selection state — it seeds the dialog. */
      onEnter?: () => SplitEnterSeed | void;
      /** Armed or disarmed — lets the Sketch button owner re-check `isActive`. */
      onActiveChange?: () => void;
      onSuspendSketchUI?: () => void;
      onResumeSketchUI?: () => void;
      /** The file a split of every solid lands in — the open document. */
      filePath: () => string | null;
    },
  ) {
    // Split joins the transform group — the tools that reposition, reflect
    // or part existing bodies. Like the repeat group it is not `immune`: it
    // hides while the exclusive sketch toolbar owns the bar.
    const group = navbar.getGroup('transform') ?? navbar.addGroup('transform', { visible: false });
    this.button = new FeatureButton(group, {
      icon: iconUrl('split'),
      label: 'Split',
      tip: 'Split solids',
      ariaLabel: 'Split solids at a plane or along a sketch line',
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

    this.panel = new SplitPanel(container);
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
      // The slot left face / sketch-line mode (✕, a standard/plane choice) —
      // the pick would otherwise silently ride along into the next state.
      this.planeFaceEntity = null;
      this.seedLine = null;
      this.refreshHighlight();
    };
    this.panel.onArmedSlotChange = () => this.syncViewport();

    this.runner = new ApplyRunner({
      panel: this.panel,
      isArmed: () => this.armed,
      build: () => this.editTarget ? this.buildEditRequest() : this.buildRequest(),
      send: (request, extras) => this.editTarget
        ? applySplitEdit(this.editTarget, { ...(request as SplitEditOptions), ...extras })
        : applySplit({ ...(request as SplitApplyOptions), ...extras }),
      onApplied: () => this.exit(this.editTarget ? { editEnd: 'apply' } : { resume: 'lazy' }),
      failMessage: () => this.editTarget ? 'Could not apply the edit.' : 'Could not apply the split.',
      // The statement preview's geometric twin: the cut plane drawn through
      // the bodies it reaches, and the dropped pieces in red. Same debounce,
      // same abort scope.
      ghost: {
        fetch: (_request, signal) => this.fetchGhost(signal),
        apply: (solids) => {
          if (solids) {
            this.ghost.set(solids, 'plane');
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
   * edge, plane-quad and sketch-wire clicks here.
   */
  get isPicking(): boolean {
    return this.armed;
  }

  /** Plane-quad, face and sketch-wire clicks route here (the armed cut slot). */
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
   * exactly the solids and planes the split's arguments can reference.
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
      this.sourceSlots = null;
      if (this.planeFaceEntity || this.seedLine) {
        this.planeFaceEntity = null;
        this.seedLine = null;
        this.panel.setPlaneFaceChip(null);
        this.panel.setSketchLineChip(null);
        this.panel.setMessage('The code changed — the re-picked geometry was reset.');
      }
    }
    this.targets = this.targets.flatMap((target): SplitTargetChoice[] => {
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
    this.navbar.setGroupVisible('transform', this.available, 'split');
    this.button.setVisible(this.available);
    this.syncButton();
    if (!this.armed) {
      return;
    }
    if (!this.available) {
      this.exit({ resume: 'lazy' });
      return;
    }
    this.ghost.clear();
    if (this.sceneSketchActive) {
      this.sketchUI.suspend();
    }
    // Chosen targets re-match against the fresh options by source line;
    // shape ids changed with the render, so picked entities are stale and
    // drop back to their pick prompts.
    this.targets = this.targets.flatMap((target): SplitTargetChoice[] => {
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
    if (this.seedLine) {
      // A seed line is addressed by call site, so it survives a render when
      // its statement still draws a line there.
      const owner = sceneObjects.find(o => o.sourceLocation?.filePath === this.seedLine!.line.filePath
        && o.sourceLocation.line === this.seedLine!.line.line
        && o.sourceLocation.column === this.seedLine!.line.column && (o.type as string) === 'line');
      const shapeId = owner?.sceneShapes?.[0]?.shapeId ?? owner?.hiddenShapes?.[0]?.shapeId;
      if (owner && shapeId) {
        this.seedLine = { ...this.seedLine, shapeId };
      } else {
        this.seedLine = null;
        this.panel.setSketchLineChip(null);
      }
    }
    this.panel.setOptions(this.planes);
    this.refreshLabels();
    this.syncViewport();
    this.refresh();
    this.runner.schedulePreview();
  }

  /**
   * Open the dialog over an existing split statement (timeline
   * double-click). The session rolls the viewport back to just before the
   * statement — the world its arguments see. The cut slot starts on a
   * "Current: …" chip keeping the statement's own expression; the targets
   * slot starts on one kept chip per statement target. Apply rewrites the
   * statement in place.
   */
  enterEdit(
    target: FeatureEditTarget,
    parsed: Extract<ParsedFeatureStatement, { feature: 'split' }>,
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
    this.seedLine = null;
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
      keep: parsed.keep,
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
    this.seedLine = null;
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
   * fills the cut slot.
   */
  private seedFromSelection({ seed, pendingPlaneShapeId }: SplitEnterSeed): void {
    if (pendingPlaneShapeId) {
      const plane = resolvePlaneByShapeId(pendingPlaneShapeId, this.sceneObjects);
      const option = plane?.sourceLocation
        ? planeOptionForLocation(this.planes, plane.sourceLocation)
        : undefined;
      if (option) {
        this.panel.selectPlane(option);
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
    this.editStatement = null;
    this.editSceneStale = false;
    this.sourceSlots = null;
    this.targets = [];
    this.planeFaceEntity = null;
    this.seedLine = null;
    this.solidPick.set([]);
    this.runner.cancelPreview();
    this.ghost.clear();
    this.viewer.clearHighlight();
    this.viewer.pickFilter = 'all';
    this.viewer.pickSketchWires = false;
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
   * its faces again clears it back). The armed cut slot: a face sets the cut
   * to that face's plane (clicking it again clears it back).
   */
  handleClick(shapeId: string | null, sub: SubSelection): void {
    if (!this.armed || !shapeId || !sub) {
      return;
    }
    if (sub.type === 'face' && this.isPlanePicking) {
      this.seedLine = null;
      this.panel.setSketchLineChip(null);
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
        this.panel.setMessage('That shape cannot be split — pick a solid.');
        return;
      }
      this.toggleTarget(option);
    }
  }

  /**
   * A sketch wire was clicked while the cut slot is armed: the line it
   * belongs to seeds the cut — the plane the line sweeps out of its sketch.
   * Only a `line()` statement that is a direct child of a sketch qualifies;
   * the server exports it through the sketch callback's return value.
   * Returns whether the dialog consumed the click.
   */
  handleSketchPick(shapeId: string): boolean {
    if (!this.isPlanePicking) {
      return false;
    }
    const owner = this.sceneObjects.find(o => o.sceneShapes?.some(s => s.shapeId === shapeId)
      || o.hiddenShapes?.some(s => s.shapeId === shapeId));
    if (!owner) {
      return false;
    }
    const sketch = resolveSketchRow(owner, this.sceneObjects);
    if (!sketch || sketch === owner) {
      this.panel.setMessage('Pick a single sketch line — the cut follows the plane that line sweeps out of its sketch.');
      return true;
    }
    if ((owner.type as string) !== 'line' || !owner.sourceLocation || !sketch.sourceLocation) {
      this.panel.setMessage('Only a straight sketch line seeds a split — pick a line() of the sketch.');
      return true;
    }
    if (owner.sourceLocation.filePath !== sketch.sourceLocation.filePath) {
      this.panel.setMessage('The seed line and its sketch live in different files.');
      return true;
    }
    if (this.seedLine && this.seedLine.line.line === owner.sourceLocation.line
      && this.seedLine.line.column === owner.sourceLocation.column) {
      // Clicking the picked line again clears it back.
      this.seedLine = null;
      this.panel.setSketchLineChip(null);
    } else {
      this.planeFaceEntity = null;
      this.panel.setPlaneFaceChip(null);
      this.seedLine = {
        shapeId,
        line: { ...owner.sourceLocation },
        sketch: { ...sketch.sourceLocation },
        label: `Sketch line — line ${owner.sourceLocation.line}`,
      };
      this.panel.setSketchLineChip(this.seedLine.label);
    }
    this.panel.setMessage(null);
    this.refreshHighlight();
    this.runner.schedulePreview();
    return true;
  }

  /** A plane feature's quad was clicked while the cut slot is armed. */
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

  /** A shown origin plane was clicked while the cut slot is armed. */
  private readonly onStandardPlanePick = (plane: StandardPlaneId): void => {
    if (!this.isPlanePicking) {
      return;
    }
    this.planeFaceEntity = null;
    this.seedLine = null;
    this.panel.setSketchLineChip(null);
    this.panel.selectStandardPlane(plane);
    this.panel.setMessage(null);
    this.refreshHighlight();
    this.runner.schedulePreview();
  };

  /**
   * A timeline row was clicked while the dialog is armed: a solid row
   * toggles it in the targets list; plane rows land in the cut slot. Every
   * row is consumed so the default rollback can't close the dialog mid-flow.
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
      this.panel.setMessage('That row has no solid to split — pick a solid-producing feature.');
      return true;
    }
    this.toggleTarget(option);
    return true;
  }

  /** Toggle a solid target chip (viewport or timeline pick). */
  private toggleTarget(option: SolidTargetOption): void {
    const existing = this.targets.findIndex(t => t.kind === 'option'
      ? t.option.filePath === option.filePath && t.option.line === option.line
      : t.loc !== undefined && t.loc.filePath === option.filePath && t.loc.line === option.line);
    if (existing >= 0) {
      this.targets.splice(existing, 1);
    } else {
      this.targets.push({ kind: 'option', option });
    }
    this.panel.armSlot('targets');
    this.panel.setMessage(null);
    this.refresh();
    this.runner.schedulePreview();
  }

  /** An offered plane landed in the cut slot (quad or timeline pick). */
  private pickPlane(option: PlaneOption): void {
    this.planeFaceEntity = null;
    this.seedLine = null;
    this.panel.setSketchLineChip(null);
    this.panel.selectPlane(option);
    this.panel.setMessage(null);
    this.refreshHighlight();
    this.runner.schedulePreview();
  }

  /** The cut slot's request field, or the message blocking it. */
  private planeRef(): SplitEditPlaneRef | { error: string } {
    const selection = this.panel.planeSelection();
    if (!selection) {
      return { error: 'Pick the cut — a plane, a face or a sketch line.' };
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
    if (selection.kind === 'sketchLine') {
      if (!this.seedLine) {
        return { error: 'Pick the sketch line first.' };
      }
      return { kind: 'sketchLine', sketch: this.seedLine.sketch, line: this.seedLine.line };
    }
    if (!this.planeFaceEntity) {
      return { error: 'Pick the cut face first.' };
    }
    return { kind: 'face', entity: this.planeFaceEntity };
  }

  /**
   * The edited statement's own sources, resolved against the pre-statement
   * scene: what its kept chips actually name. Only the ghost reads them — the
   * apply rewrites a keep verbatim.
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
    this.sourceSlots = result.ok && result.feature === 'split'
      ? { targets: result.targets, plane: result.plane }
      : { targets: [], plane: null };
    this.runner.schedulePreview();
  }

  // -------------------------------------------------------------------------
  // Live geometry ("ghost")
  // -------------------------------------------------------------------------

  /**
   * The live geometry for the current form state: the cut plane through the
   * bodies it reaches, plus the dropped pieces in red. A slot the ghost can't
   * address (a cut still unpicked, a keep chip over an expression) means no
   * ghost.
   */
  private async fetchGhost(signal: AbortSignal): Promise<GhostSolid[] | null> {
    const values = this.panel.values();
    const targets = this.ghostTargets();
    if (!targets) {
      return null;
    }
    const plane = this.ghostPlane();
    if (!plane) {
      return null;
    }
    const request: SplitGhostRequest = {
      feature: 'split',
      keep: values.keep,
      targets,
      plane,
      exclude: this.editTarget
        ? { filePath: this.editTarget.filePath, line: this.editTarget.line }
        : undefined,
    };
    const result = await fetchFeatureGhostResult(request, featureGhostScope(this.editTarget), signal);
    if (result.notice && !signal.aborted && this.armed) {
      this.panel.setMessage(result.notice);
    }
    return result.solids;
  }

  /**
   * The solids being split, by call site — an empty list for an implicit
   * split of every solid. A kept chip travels as the statement its
   * expression named, or as whatever the sources query resolved that
   * argument to; a target neither could place means no ghost at all.
   */
  private ghostTargets(): { filePath: string; line: number }[] | null {
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

  /** The cut slot, in the form the kernel resolves. */
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
        ? { kind: 'face', shapeId: this.planeFaceEntity.shapeId, index: this.planeFaceEntity.sub.index }
        : null;
    }
    if (selection.kind === 'sketchLine') {
      return this.seedLine
        ? { kind: 'sketchLine', filePath: this.seedLine.line.filePath, line: this.seedLine.line.line, column: this.seedLine.line.column }
        : null;
    }
    // The kept statement cut, as the sources query resolved it: a `plane()`
    // the statement names, the face it was written from, or the seed line's
    // own statement inside its sketch.
    const slot = this.sourceSlots?.plane;
    if (slot?.kind === 'sketch') {
      const isPlane = planeOptionForLocation(this.planes, { filePath: slot.filePath, line: slot.line });
      return isPlane
        ? { kind: 'plane', filePath: slot.filePath, line: slot.line }
        : { kind: 'sketchLine', filePath: slot.filePath, line: slot.line, column: slot.column };
    }
    const face = slot?.kind === 'entities' ? slot.entities[0] : null;
    if (face && face.sub.type === 'face') {
      return { kind: 'face', shapeId: face.shapeId, index: face.sub.index };
    }
    const standard = standardPlaneFromText(this.editStatement?.planeText);
    return standard ? { kind: 'standard', plane: standard } : null;
  }

  private buildRequest(): SplitApplyOptions | { error: string } {
    const values = this.panel.values();
    const filePath = this.hooks.filePath();
    if (!filePath) {
      return { error: 'Open a model file first.' };
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
      return { error: 'Pick the cut — a plane, a face or a sketch line.' };
    }
    return {
      targets, plane: plane as SplitPlaneRef, keep: values.keep, filePath,
    };
  }

  /**
   * The edit-mode apply payload. A cut slot still on its "Current: …" entry
   * ships as a keep — the transform preserves the statement's expression
   * byte for byte; the target list mixes kept statement targets with
   * re-picked solids, and an emptied list makes the split implicit again.
   * A re-picked face synthesizes against the session boundary.
   */
  private buildEditRequest(): SplitEditOptions | { error: string } {
    const values = this.panel.values();
    const targets: SplitEditTargetRef[] = this.targets.map(t => t.kind === 'keep'
      ? { kind: 'verbatim' as const, sourceIndex: t.sourceIndex }
      : { kind: 'feature' as const, filePath: t.option.filePath, line: t.option.line, column: t.option.column });
    const plane = this.planeRef();
    if ('error' in plane) {
      return plane;
    }
    return {
      plane,
      keep: values.keep,
      targets,
      expectedStatement: this.session.expectedStatement,
      before: plane.kind === 'face' ? this.session.boundary ?? undefined : undefined,
    };
  }

  // -------------------------------------------------------------------------
  // Viewport reflection + sketch-editing suspension
  // -------------------------------------------------------------------------

  /**
   * The viewer's pick channels follow the panel's armed slot: the armed
   * Solids slot takes any face or edge (the pick selects the owning solid
   * whole); the armed cut slot takes faces, plane quads, the origin planes
   * shown as pick targets, and sketch wires (a seed line).
   */
  private syncViewport(): void {
    if (!this.armed) {
      return;
    }
    const planeArmed = this.isPlanePicking;
    this.viewer.pickSketchWires = planeArmed;
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
   * cut face or the chosen plane feature's quad — one combined pass through
   * the shared picker.
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

  private refreshLabels(): void {
    void this.relabeler.refresh(this.planes);
  }

  private syncButton(): void {
    this.button.setActive(this.armed);
    this.hooks.onActiveChange?.();
  }
}
