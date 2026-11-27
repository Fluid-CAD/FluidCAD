import {
  applyProjectedCurve, applyProjectedCurveEdit, featureGhostScope, fetchFeatureGhostResult, fetchFeatureSources,
  type DirectionRef, type FeatureEditTarget, type GhostDirectionRef, type GhostOperandRef, type GhostSolid,
  type OperandInputRef, type ParsedFeatureStatement, type ProjectedCurveApplyOptions, type ProjectedCurveEditOptions,
  type SourceSlotRef,
} from '../../api';
import { mergeUniqueEntities } from '../../helpers/entities';
import { hasSolid, hasSurface } from '../../helpers/scene-utils';
import type { StandardAxisId } from '../../scene/standard-axes';
import type { StandardPlaneId } from '../../scene/standard-planes';
import type { SceneObjectRender, SubSelection } from '../../types';
import type { Navbar } from '../../ui/navbar';
import type { SelectedEntity, Viewer } from '../../viewer';
import { EditSession, type EditSessionInfo } from '../edit-session';
import type { ConnectorPickDetail, FeatureDialogExit } from '../feature-dialog-registry';
import { SelectionContextMenu } from '../selection-menu';
import { ApplyRunner } from './apply-runner';
import { ConnectorPicks } from './connector-picks';
import { detachedLauncher, type FeatureLauncher } from './feature-button';
import { FeatureGhostOverlay } from './feature-ghost';
import type { OperandSlotControl } from './operand-slot';
import { ProjectedCurvePanel, type ProjectionRow } from './projected-curve-panel';
import { applyPickChannels, type PickOutcome } from './schema/schema-pickers';
import { collectSketchProfiles } from './sketch-profiles';
import { SketchUISuspender } from './sketch-suspender';

/** The parsed statement the dialog edits. */
type ParsedProjectedCurve = Extract<ParsedFeatureStatement, { feature: 'projected-curve' }>;

/** The two operand rows. */
type OperandRow = 'source' | 'target';

/** What the engine resolved each operand of the edited statement to, per row, and its direction. */
type EditSources = Record<OperandRow, SourceSlotRef[]> & { direction: SourceSlotRef | null };

const OPERAND_ROWS: readonly OperandRow[] = ['source', 'target'];

/** The same sub-shape of the same shape. */
function samePick(a: { shapeId: string; sub: NonNullable<SubSelection> }, b: { shapeId: string; sub: NonNullable<SubSelection> }): boolean {
  return a.shapeId === b.shapeId && a.sub.type === b.sub.type && a.sub.index === b.sub.index;
}

/** What a viewport click picked: an edge, a face, a sketch's wire. */
type ClickedPick = { shapeId: string; sub: NonNullable<SubSelection> };

/** One viewport click, as a double-click that follows it reads it back. */
type RecentClick = {
  row: ProjectionRow;
  pick: ClickedPick;
  /** The row took it (or took it back off). */
  taken: boolean;
  /** It handed the armed border on to another row. */
  handedOn: boolean;
};

/** The refusal of an apply with an empty row. */
const EMPTY_ROW: Record<OperandRow, string> = {
  source: 'Pick the curves to project: sketches, curves, or edges of a body.',
  target: 'Pick the faces to project onto: surfaces, or faces of a body.',
};

/** What a timeline row the armed row takes no such thing from answers. */
const ROW_REFUSAL: Record<ProjectionRow, string> = {
  source: 'holds no curve — pick a sketch\'s or a curve\'s row, or edges in the viewport.',
  target: 'holds no surface — pick a surface\'s row, or faces in the viewport.',
  direction: 'gives no direction — pick an axis, a plane or a connector row, or an edge or a face in the viewport.',
};

/**
 * The Project dialog, opened from the Curves menu: `project(source,
 * target)` outside a sketch, curves thrown onto faces. Its rows
 * ({@link ProjectedCurvePanel}) collect the curves (sketches and curve
 * objects whole, edges of bodies), the faces they land on (surfaces whole,
 * faces of bodies) and the line they travel along — a world axis, an
 * `axis()`, a straight edge, a connector, or a plane, an origin plane or a
 * planar face standing for its normal; empty it is the normal of the plane
 * the curves lie in. The mode and what is kept are two button rows. A
 * double-click grows the armed operand row by an edge's chain or loop or a
 * face's bucket, and the right-click menu's groups land in it as plain
 * picks. Once both operand rows hold a pick the curve previews, in the
 * colour of an applied curve, and an engine refusal (the projection misses
 * the faces, curves that lie in no plane with no direction) shows in the
 * dialog. Apply writes the statement; the re-render is the result, editor
 * undo the rollback.
 *
 * *Normal to surface* hides the Direction row and leaves its pick out of
 * every request, where the row keeps it for a switch back.
 *
 * A timeline double-click reopens it over an existing statement: the view
 * rolls back to just before it, the rows open on the statement's own
 * arguments as "Current: …" chips and its own direction, the mode and Keep
 * as written, and Apply sends only what changed — a row, the mode, Keep,
 * a direction re-picked or removed.
 */
export class ProjectedCurveFeatureService {
  private readonly panel: ProjectedCurvePanel;
  private readonly launcher: FeatureLauncher;
  private readonly sketchUI: SketchUISuspender;
  private readonly ghost: FeatureGhostOverlay;
  private readonly selectionMenu: SelectionContextMenu;
  private readonly connectors: ConnectorPicks;
  private readonly runner: ApplyRunner<ProjectedCurveApplyOptions | ProjectedCurveEditOptions>;
  private armed = false;
  private available = false;
  private sceneObjects: SceneObjectRender[] = [];
  private sceneSketchActive = false;
  /** Statement being edited in place (timeline double-click), or null. */
  private editTarget: FeatureEditTarget | null = null;
  /** The statement the edit opened over. */
  private parsed: ParsedProjectedCurve | null = null;
  /** View-state half of edit mode: pre-statement rollback + boundary. */
  private readonly session = new EditSession();
  /** What the edited statement's operands and direction resolve to at the boundary; null until the engine answers. */
  private sources: EditSources | null = null;
  /** The rows have not seen the boundary yet: what they picked before it was on another scene. */
  private beforeBoundary = false;
  /** A full render arrived mid-session — the picked edges' and faces' ids died. */
  private editSceneStale = false;
  /** The last two viewport clicks: the two a double-click arrives after. */
  private recentClicks: RecentClick[] = [];

  constructor(
    container: HTMLElement,
    private readonly viewer: Viewer,
    _navbar: Navbar,
    launcher: FeatureLauncher = detachedLauncher(),
    private readonly hooks: {
      onEnter?: () => void;
      /** Armed or disarmed — lets the Sketch button owner re-check `isActive`. */
      onActiveChange?: () => void;
      onSuspendSketchUI?: () => void;
      onResumeSketchUI?: () => void;
    } = {},
  ) {
    this.launcher = launcher;
    this.launcher.onClick = () => {
      if (this.armed) {
        this.exit();
      } else {
        this.enter();
      }
    };
    this.sketchUI = new SketchUISuspender(viewer, hooks);
    this.ghost = new FeatureGhostOverlay(viewer);
    this.connectors = new ConnectorPicks(container, viewer);

    this.panel = new ProjectedCurvePanel(container);
    this.panel.onApply = () => void this.runner.apply();
    this.panel.onExit = () => this.exit();
    // A chip's ✕, the mode, Keep.
    this.panel.onChange = () => this.changed();
    this.panel.onArmedRowChange = () => {
      this.selectionMenu.hide();
      this.connectors.close();
      this.syncChannels();
    };

    // Every group is offered, and each lands in the armed operand row as plain picks.
    this.selectionMenu = new SelectionContextMenu(container, 'fluidcad-projected-curve-select-menu', {
      kinds: ['tangent', 'loop', 'classified', 'same-type', 'equal', 'sibling'],
      onSelectGroup: (_kind, _seed, members) => {
        const row = this.panel.armedRow;
        if (this.armed && row !== 'direction') {
          this.land(row, this.panel.slot(row).takeMembers(members));
        }
      },
      onPreview: (members) => this.refreshHighlight(members ?? []),
      boundary: () => this.session.boundary ?? undefined,
    });

    this.runner = new ApplyRunner({
      panel: this.panel,
      session: this.session,
      isArmed: () => this.armed,
      build: () => this.editTarget ? this.buildEditRequest() : this.buildRequest(),
      send: (request, extras) => this.editTarget
        ? applyProjectedCurveEdit(this.editTarget, { ...(request as ProjectedCurveEditOptions), ...extras })
        : applyProjectedCurve({ ...(request as ProjectedCurveApplyOptions), ...extras }),
      onApplied: () => this.exit(this.editTarget ? { editEnd: 'apply' } : { resume: 'lazy' }),
      failMessage: () => this.editTarget ? 'Could not apply the edit.' : 'Could not apply the projected curve.',
      // The statement preview's geometric twin: the curve itself, in the
      // blue an applied curve wears.
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
  }

  get isActive(): boolean {
    return this.armed;
  }

  /** An edit session is open (the viewport shows the pre-statement rollback). */
  get isEditing(): boolean {
    return this.editTarget !== null;
  }

  /** The armed dialog owns viewport clicks, double-clicks and the right-click menu. */
  get isPicking(): boolean {
    return this.armed;
  }

  /** The Direction row is armed: axis lines, plane quads and connector gizmos are its picks. */
  get isDirectionPicking(): boolean {
    return this.armed && this.panel.armedRow === 'direction';
  }

  /** The Curves row is armed: a sketch's wire is its pick. */
  get isCurvePicking(): boolean {
    return this.armed && this.panel.armedRow === 'source';
  }

  /** True while armed picking has suspended sketch editing. */
  get sketchUISuspended(): boolean {
    return this.sketchUI.suspended;
  }

  /** The dialog's panel, for the tests to drive. */
  get dialogPanel(): ProjectedCurvePanel {
    return this.panel;
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  /**
   * Every render lands here. An open edit session owns the view: it keeps
   * the viewport rolled back to just before the edited statement, and at
   * that boundary the rows re-resolve against the pre-statement scene.
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
      // Mid-flight to the boundary — whatever the ghost was drawn against
      // is already gone from the view.
      this.ghost.clear();
      if (!isRollback) {
        this.editSceneStale = true;
      }
      return;
    }
    // At the boundary: the rows re-resolve against the pre-statement scene.
    this.ghost.clear();
    this.sceneObjects = sceneObjects;
    const stale = this.editSceneStale || this.beforeBoundary;
    const dropped = this.setRowScenes({ dropEntities: stale });
    this.beforeBoundary = false;
    if (this.editSceneStale) {
      this.editSceneStale = false;
      // The engine's answer named edges and faces by ids the rebuild retired.
      this.sources = null;
      if (dropped) {
        this.panel.setMessage('The code changed — the re-picked edges and faces were reset.');
      }
    }
    if (!this.sources) {
      void this.loadEditSources();
    }
    this.syncChannels();
    this.refreshHighlight();
    this.runner.schedulePreview();
  }

  update(sceneObjects: SceneObjectRender[]): void {
    this.sceneObjects = sceneObjects;
    this.sceneSketchActive = collectSketchProfiles(sceneObjects)[0]?.kind === 'active';
    // Curves go onto a body — a solid or a surface — and a body's edges are
    // curves to throw themselves, so a body is all it needs.
    this.available = hasSolid(sceneObjects) || hasSurface(sceneObjects);
    this.syncLauncher();
    if (!this.armed) {
      return;
    }
    if (!this.available) {
      this.exit({ resume: 'lazy' });
      return;
    }
    // The geometry under the ghost just changed — drop it now and let the
    // debounce redraw it.
    this.ghost.clear();
    // A render can put a sketch back in front (live editing) — the armed
    // dialog keeps the free 3D view.
    if (this.sceneSketchActive) {
      this.sketchUI.suspend();
    }
    // Shape ids changed with the render: picked edges and faces drop, whole
    // objects re-find their statements.
    this.setRowScenes({ dropEntities: true });
    this.syncChannels();
    this.refreshHighlight();
    this.runner.schedulePreview();
  }

  enter(): void {
    if (this.armed) {
      return;
    }
    this.session.end('continue');
    this.hooks.onEnter?.();
    this.armed = true;
    this.editTarget = null;
    this.parsed = null;
    this.sources = null;
    this.recentClicks = [];
    // Composing a curve means looking at the whole scene, not down the
    // active sketch plane (resumed on cancel; an apply's re-render takes over).
    if (this.sceneSketchActive) {
      this.sketchUI.suspend();
    }
    this.syncLauncher();
    this.panel.show();
    this.panel.setMessage(null);
    this.setRowScenes({ dropEntities: true });
    this.syncChannels();
    this.refreshHighlight();
    this.runner.schedulePreview();
  }

  /**
   * Open over an existing projected curve (timeline double-click). The
   * session rolls the viewport back to just before the statement; the rows
   * open on its arguments' operands as "Current: …" chips and the Direction
   * row on its own direction — a world axis or origin plane literal as that
   * axis or plane — each lit once the engine says what it resolves to; the
   * mode and Keep open as written. Apply rewrites the statement in place,
   * sending only what changed.
   */
  enterEdit(target: FeatureEditTarget, parsed: ParsedProjectedCurve, info: Omit<EditSessionInfo, 'target'>): void {
    if (this.armed) {
      this.exit();
    }
    this.hooks.onEnter?.();
    this.armed = true;
    this.editTarget = target;
    this.parsed = parsed;
    this.sources = null;
    this.beforeBoundary = true;
    this.editSceneStale = false;
    this.recentClicks = [];
    this.syncLauncher();
    this.sketchUI.suspend();
    this.session.begin({ ...info, target });
    this.panel.showEdit({ mode: parsed.mode, keep: parsed.keep });
    this.panel.setMessage(null);
    this.panel.source.seedKeep(parsed.sourceTexts);
    this.panel.target.seedKeep(parsed.targetTexts);
    this.panel.direction.seedKeep(parsed.directionText);
    this.setRowScenes({ dropEntities: true });
    void this.loadEditSources();
    this.syncChannels();
    this.refreshHighlight();
    this.runner.schedulePreview();
  }

  /**
   * `resume: 'lazy'` re-enables sketch editing without forcing the mode
   * transition — for apply-success and scene-driven exits. User cancels
   * default to `'immediate'`; ending an edit session always resumes lazily.
   */
  exit(opts: FeatureDialogExit = {}): void {
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
    this.parsed = null;
    this.sources = null;
    this.beforeBoundary = false;
    this.editSceneStale = false;
    this.recentClicks = [];
    this.syncLauncher();
    this.runner.cancelPreview();
    this.ghost.clear();
    this.selectionMenu.hide();
    this.connectors.close();
    // The rows let go of what they hold, a consumed sketch they kept drawn among it.
    this.panel.clearRows();
    this.viewer.clearHighlight();
    this.viewer.pickFilter = 'all';
    this.viewer.pickSketchWires = false;
    this.viewer.pickAxes = false;
    this.viewer.pickPlanes = false;
    this.viewer.setConnectorPicking(false);
    this.viewer.setPickedConnectors([]);
    this.viewer.setSelectedStandardAxes([]);
    this.viewer.hideStandardAxes();
    this.viewer.hideStandardPlanes();
    this.panel.hide();
    this.sketchUI.resume((opts.resume ?? 'immediate') === 'immediate');
  }

  // -------------------------------------------------------------------------
  // Picks
  // -------------------------------------------------------------------------

  /**
   * A viewport click lands in the armed row: an edge in Curves (a sketch's
   * or a curve's whole object), a face in Onto (a surface's whole surface),
   * and in Direction an edge, a face, an `axis()` line or a `plane()` quad —
   * a straight edge or a planar face, the engine asked which it is.
   */
  handleClick(shapeId: string | null, sub: SubSelection): void {
    if (!this.armed || !shapeId || !sub) {
      return;
    }
    this.selectionMenu.hide();
    const row = this.panel.armedRow;
    if (row === 'direction') {
      this.recentClicks = [];
      void this.takeDirection(this.panel.direction.takeClick(shapeId, sub));
      return;
    }
    const outcome = this.panel.slot(row).takeClick(shapeId, sub);
    this.land(row, outcome);
    this.remember(row, { shapeId, sub }, outcome);
  }

  /** Keep the last two clicks for a double-click that may follow them. */
  private remember(row: OperandRow, pick: ClickedPick, outcome: PickOutcome): void {
    this.recentClicks = [...this.recentClicks.slice(-1), {
      row,
      pick,
      taken: outcome === 'taken',
      handedOn: this.panel.armedRow !== row,
    }];
  }

  /** A sketch's wire clicked while Curves is armed: the whole sketch. */
  handleSketchPick(shapeId: string): boolean {
    if (!this.isCurvePicking) {
      return false;
    }
    this.selectionMenu.hide();
    const pick: ClickedPick = { shapeId, sub: { type: 'sketch', index: 0 } };
    const outcome = this.panel.source.takeClick(shapeId, pick.sub);
    this.land('source', outcome);
    this.remember('source', pick, outcome);
    return true;
  }

  /** A `plane()` quad clicked while Direction is armed: its normal. */
  handlePlanePick(shapeId: string): void {
    if (!this.isDirectionPicking) {
      return;
    }
    this.landDirection(this.panel.direction.takePlaneQuad(shapeId));
  }

  /**
   * A connector gizmo clicked while Direction is armed: the connector's Z
   * axis through its origin. Several gizmos under the cursor ask which first.
   */
  handleConnectorPick(connectorId: string | null, detail?: ConnectorPickDetail): void {
    if (!this.isDirectionPicking || !connectorId) {
      return;
    }
    const refusal = this.connectors.pick(connectorId, detail,
      option => this.landDirection(this.panel.direction.takeConnector(option.id)));
    if (refusal) {
      this.panel.setMessage(refusal);
    }
  }

  /**
   * A double-click on an edge or a face of a body: the operand row the
   * gesture started in grows by an edge's tangent chain or rim loop, or a
   * face's bucket (a sketch's or a surface's pick is whole already). The
   * gesture's own two clicks have toggled the pick; the members join either
   * way. The answer lands only in the row that asked, if it is still armed.
   */
  async handleDoubleClick(shapeId: string | null, sub: SubSelection): Promise<void> {
    if (!this.armed || !shapeId || !sub || this.panel.armedRow === 'direction') {
      return;
    }
    this.selectionMenu.hide();
    const { row, seed, repaired } = this.gestureRow({ shapeId, sub });
    const outcome = await this.panel.slot(row).takeDoubleClick(seed.shapeId, seed.sub, this.session.boundary ?? undefined);
    if (!this.armed || this.panel.armedRow !== row) {
      return;
    }
    if (outcome !== 'taken' && repaired) {
      // Nothing joined, but the pick stays: hand the border on again.
      this.panel.advanceFrom(row);
      this.refreshHighlight();
      this.runner.schedulePreview();
    }
    this.land(row, outcome);
  }

  /**
   * The row a double-click at `pick` belongs to, and what it grows from.
   * Its first click can fill Curves and hand the border to an empty Onto,
   * which its second click then lands in — on the face under the cursor,
   * since Onto picks faces where Curves picked the edge (or the sketch's
   * wire) in front of it. That click is taken back out of Onto, and the
   * gesture goes on in Curves, where it started, from what its first click
   * picked.
   */
  private gestureRow(pick: ClickedPick): { row: OperandRow; seed: ClickedPick; repaired: boolean } {
    const [first, second] = this.recentClicks.length === 2 ? this.recentClicks : [];
    this.recentClicks = [];
    const armed = this.panel.armedRow as OperandRow;
    if (!first || !second || !first.handedOn || second.row === first.row || first.row === 'direction'
      || !(samePick(second.pick, pick) || samePick(first.pick, pick))) {
      return { row: armed, seed: pick, repaired: false };
    }
    if (second.taken && second.row !== 'direction') {
      this.panel.slot(second.row).takeClick(second.pick.shapeId, second.pick.sub);
    }
    this.panel.armRow(first.row);
    this.refreshHighlight();
    return { row: first.row, seed: first.pick, repaired: true };
  }

  /** A right-click on an edge or a face of a body: the multi-select menu for it, its group landing in the armed operand row. */
  handleContextMenu(shapeId: string | null, sub: SubSelection, clientX: number, clientY: number): void {
    if (!this.armed) {
      return;
    }
    this.selectionMenu.hide();
    const row = this.panel.armedRow;
    if (row === 'direction' || !shapeId || (sub?.type !== 'face' && sub?.type !== 'edge')) {
      return;
    }
    if (this.panel.slot(row).expands(shapeId, sub)) {
      // The hover tint would otherwise be stashed as an "original" colour by
      // the preview highlight and stick around after the preview restores it.
      this.viewer.clearHover();
      void this.selectionMenu.open({ shapeId, sub }, clientX, clientY);
    }
  }

  /**
   * A timeline row while armed lands in the armed row: a sketch's or a
   * curve's row in Curves, the row of an object holding a surface in Onto,
   * an `axis()`, a `plane()` or a connector in Direction. Any other row is
   * refused in the dialog — consumed either way, so the default rollback
   * can't close the dialog mid-flow.
   */
  handleTimelinePick(obj: SceneObjectRender): boolean {
    if (!this.armed) {
      return false;
    }
    const row = this.panel.armedRow;
    const outcome = row === 'direction' ? this.panel.direction.takeRow(obj) : this.panel.slot(row).takeRow(obj);
    if (outcome === 'ignored') {
      this.panel.setMessage(`${obj.name || 'That row'} ${ROW_REFUSAL[row]}`);
      return true;
    }
    if (row === 'direction') {
      this.landDirection(outcome);
    } else {
      this.land(row, outcome);
    }
    return true;
  }

  /** A shown world axis or origin plane clicked while Direction is armed. */
  private readonly onStandardPick = (name: StandardAxisId | StandardPlaneId): void => {
    if (this.isDirectionPicking) {
      this.landDirection(this.panel.direction.takeStandard(name));
    }
  };

  /** What an operand row answered: the pick lands (the first in Curves hands the border on), or its refusal shows. */
  private land(row: OperandRow, outcome: PickOutcome): void {
    if (outcome === 'ignored') {
      return;
    }
    if (outcome !== 'taken') {
      this.panel.setMessage(outcome.message);
      return;
    }
    this.panel.advanceFrom(row);
    this.changed();
  }

  /** The Direction row's answer to a click, once the engine has said what an edge or a face is. */
  private async takeDirection(answer: Promise<PickOutcome>): Promise<void> {
    const outcome = await answer;
    if (this.armed) {
      this.landDirection(outcome);
    }
  }

  /** What the Direction row answered: the direction lands, or its refusal shows. */
  private landDirection(outcome: PickOutcome): void {
    if (outcome === 'ignored') {
      return;
    }
    if (outcome !== 'taken') {
      this.panel.setMessage(outcome.message);
      return;
    }
    this.changed();
  }

  /** What the rows hold changed: the message clears, the highlight and the preview follow. */
  private changed(): void {
    this.panel.setMessage(null);
    this.refreshHighlight();
    this.runner.schedulePreview();
  }

  // -------------------------------------------------------------------------
  // Requests
  // -------------------------------------------------------------------------

  /**
   * The create request: both operand rows' picks, the mode, the direction —
   * null when the row is empty or hidden by *Normal to surface* — and what
   * is kept; or the message blocking it.
   */
  private buildRequest(): ProjectedCurveApplyOptions | { error: string } {
    const source = this.rowInputs(this.panel.source);
    if (!source || source.length === 0) {
      return { error: EMPTY_ROW.source };
    }
    const target = this.rowInputs(this.panel.target);
    if (!target || target.length === 0) {
      return { error: EMPTY_ROW.target };
    }
    const mode = this.panel.mode;
    const held = mode === 'direction' ? this.panel.direction.value() : null;
    const direction = held && !('keep' in held) ? held : null;
    return { source, target, mode, direction, keep: this.panel.keep };
  }

  /**
   * The edit request: only what changed. An operand row still on its
   * "Current: …" chips is left out, so the statement's own argument is
   * written back byte for byte; the mode and Keep are sent when they differ
   * from the statement's. The direction is left out while the row keeps the
   * statement's own (a literal read back as its axis or plane among them);
   * it is `cleared` when the row was emptied, or hidden by *Normal to
   * surface*, over a statement that has one — the engine refuses a
   * direction with mode `'normal'`. A re-picked edge or face, in a row or
   * as the direction, is synthesized against the session boundary.
   */
  private buildEditRequest(): ProjectedCurveEditOptions | { error: string } {
    const parsed = this.parsed!;
    const source = this.rowInputs(this.panel.source) ?? undefined;
    const target = this.rowInputs(this.panel.target) ?? undefined;
    for (const row of OPERAND_ROWS) {
      const inputs = row === 'source' ? source : target;
      if (inputs && inputs.length === 0) {
        return { error: EMPTY_ROW[row] };
      }
    }
    const mode = this.panel.mode;
    const keep = this.panel.keep;
    const direction = this.editDirection(parsed);
    const picksEntities = [source, target].some(inputs => inputs?.some(input => input.kind !== 'statement'))
      || direction?.kind === 'edge' || direction?.kind === 'face';
    return {
      source,
      target,
      mode: mode !== parsed.mode ? mode : undefined,
      direction,
      keep: keep !== parsed.keep ? keep : undefined,
      expectedStatement: this.session.expectedStatement,
      before: picksEntities ? this.session.boundary ?? undefined : undefined,
    };
  }

  /** An edit's direction: left out (kept as written), cleared, or the new one. */
  private editDirection(parsed: ParsedProjectedCurve): DirectionRef | { kind: 'cleared' } | undefined {
    const written = parsed.directionText;
    const held = this.panel.mode === 'direction' ? this.panel.direction.value() : null;
    if (held === null) {
      return written !== null ? { kind: 'cleared' } : undefined;
    }
    if ('keep' in held || ProjectedCurveFeatureService.writtenAs(held, written)) {
      return undefined;
    }
    return held;
  }

  /** A world axis or an origin plane the statement already names by its literal (`'z'`, `"xy"`). */
  private static writtenAs(direction: DirectionRef, text: string | null): boolean {
    const literal = text?.trim().match(/^['"](x|y|z|xy|xz|yz)['"]$/)?.[1];
    if (!literal) {
      return false;
    }
    return (direction.kind === 'standard' && direction.axis === literal)
      || (direction.kind === 'standard-plane' && direction.plane === literal);
  }

  /** A row's picks as the apply route takes them, in pick order; null while it keeps the statement's own argument. */
  private rowInputs(slot: OperandSlotControl): OperandInputRef[] | null {
    const held = slot.picks();
    if ('keep' in held) {
      return null;
    }
    return held.picks.flatMap((pick): OperandInputRef[] => {
      if (pick.kind === 'object') {
        const loc = pick.row.sourceLocation;
        return loc ? [{ kind: 'statement', filePath: loc.filePath, line: loc.line, column: loc.column }] : [];
      }
      const sub = pick.entity.sub;
      return sub?.type === 'face' || sub?.type === 'edge'
        ? [{ kind: sub.type, shapeId: pick.entity.shapeId, index: sub.index }]
        : [];
    });
  }

  /**
   * The curve the rows describe, once both operand rows hold something the
   * preview can address and the direction, when one is kept, resolves. An
   * engine refusal the server marks as worth saying — the projection misses
   * the faces, curves in no plane with no direction — shows in the dialog.
   */
  private async fetchGhost(signal: AbortSignal): Promise<GhostSolid[] | null> {
    const source = this.ghostRow('source');
    const target = this.ghostRow('target');
    if (!source || !target) {
      return null;
    }
    const direction = this.ghostDirection();
    if (direction === undefined) {
      return null;
    }
    const result = await fetchFeatureGhostResult(
      { feature: 'projected-curve', source, target, mode: this.panel.mode, direction, keep: this.panel.keep },
      featureGhostScope(this.editTarget),
      signal,
    );
    if (result.notice && !signal.aborted && this.armed) {
      this.panel.setMessage(result.notice);
    }
    return result.solids;
  }

  /**
   * The direction on the preview wire: null for none (an empty row, or
   * *Normal to surface*), the row's pick, or a kept one as the engine
   * resolved it; undefined while a kept direction stands for nothing the
   * preview can read (an expression, or the answer still in flight).
   */
  private ghostDirection(): GhostDirectionRef | null | undefined {
    if (this.panel.mode !== 'direction') {
      return null;
    }
    const held = this.panel.direction.value();
    if (held === null) {
      return null;
    }
    return this.panel.direction.ghost() ?? undefined;
  }

  /**
   * A row's picks on the preview wire. A kept row stands as what the engine
   * resolved its operands to — a statement by call site, a selection as its
   * edges or faces; null while that is not known or an operand has no such
   * form (an expression).
   */
  private ghostRow(row: OperandRow): GhostOperandRef[] | null {
    const held = this.panel.slot(row).picks();
    if (!('keep' in held)) {
      const refs = held.picks.flatMap((pick): GhostOperandRef[] => {
        if (pick.kind === 'object') {
          const loc = pick.row.sourceLocation;
          return loc ? [{ kind: 'statement', filePath: loc.filePath, line: loc.line }] : [];
        }
        const sub = pick.entity.sub;
        return sub?.type === 'face' || sub?.type === 'edge'
          ? [{ kind: sub.type, shapeId: pick.entity.shapeId, index: sub.index }]
          : [];
      });
      return refs.length > 0 ? refs : null;
    }
    const kept = this.sources?.[row];
    if (!kept || kept.length === 0) {
      return null;
    }
    const wanted = row === 'source' ? 'edge' : 'face';
    const refs: GhostOperandRef[] = [];
    for (const ref of kept) {
      if (ref.kind === 'sketch') {
        refs.push({ kind: 'statement', filePath: ref.filePath, line: ref.line });
      } else if (ref.kind === 'entities' && ref.entities.length > 0 && ref.entities.every(e => e.sub.type === wanted)) {
        refs.push(...ref.entities.map((e): GhostOperandRef => ({ kind: wanted, shapeId: e.shapeId, index: e.sub.index })));
      } else {
        return null;
      }
    }
    return refs;
  }

  /**
   * What the edited statement's operands and direction resolve to at the
   * boundary: the kept chips light them, the preview stands on them, and a
   * row's first pick starts from them. A row already re-picked keeps its
   * picks.
   */
  private async loadEditSources(): Promise<void> {
    const boundary = this.session.boundary;
    const parsed = this.parsed;
    if (!boundary || !parsed) {
      return;
    }
    const result = await fetchFeatureSources(boundary);
    if (!this.editTarget || this.parsed !== parsed || this.session.boundary?.index !== boundary.index) {
      return;
    }
    const sources: EditSources = result.ok && result.feature === 'projected-curve'
      ? { source: result.source, target: result.target, direction: result.direction }
      : { source: [], target: [], direction: null };
    this.sources = sources;
    for (const row of OPERAND_ROWS) {
      const slot = this.panel.slot(row);
      const texts = row === 'source' ? parsed.sourceTexts : parsed.targetTexts;
      if ('keep' in slot.picks()) {
        slot.seedKeep(texts, sources[row]);
      } else {
        slot.setKeepRefs(sources[row]);
      }
    }
    this.panel.direction.setKeptSource(sources.direction);
    this.refreshHighlight();
    // The kept rows' preview reads the sources, which resolve after the
    // dialog opened — re-kick it.
    this.runner.schedulePreview();
  }

  // -------------------------------------------------------------------------
  // Viewport
  // -------------------------------------------------------------------------

  /** Hand every row the scene; answers whether an edge or a face the user picked was dropped. */
  private setRowScenes(opts: { dropEntities: boolean }): boolean {
    const source = this.panel.source.setScene(this.sceneObjects, opts);
    const target = this.panel.target.setScene(this.sceneObjects, opts);
    this.connectors.collect(this.sceneObjects);
    // A picked direction edge or face dies with any render that re-mints ids.
    const direction = opts.dropEntities ? this.panel.direction.setScene(this.sceneObjects) : false;
    return source || target || direction;
  }

  /**
   * The viewer offers what the armed row takes: edges and sketch wires for
   * Curves, faces for Onto, and for Direction edges, faces, axis lines, plane
   * quads, connectors and the world axes and origin planes shown.
   */
  private syncChannels(): void {
    if (!this.armed) {
      return;
    }
    const row = this.panel.armedRow;
    const channels = row === 'direction' ? this.panel.direction.channels() : this.panel.slot(row).channels();
    applyPickChannels(this.viewer, channels);
    if (channels.standardAxes) {
      this.viewer.showStandardAxes(this.onStandardPick);
    } else {
      this.viewer.hideStandardAxes();
    }
    if (channels.standardPlanes) {
      this.viewer.showStandardPlanes(this.onStandardPick);
    } else {
      this.viewer.hideStandardPlanes();
    }
  }

  /**
   * Light up what the rows hold — an edge or a face as itself, a sketch or a
   * curve by its wires, a surface whole, a kept argument as what it resolved
   * to, and the direction while its row is shown — with `preview`, the picks
   * a hovered menu item would add.
   */
  private refreshHighlight(preview: SelectedEntity[] = []): void {
    if (!this.armed) {
      return;
    }
    const entities: SelectedEntity[] = [];
    const wireIds: string[] = [];
    const shapeIds: string[] = [];
    const planeQuadIds: string[] = [];
    for (const row of OPERAND_ROWS) {
      const lit = this.panel.slot(row).highlight();
      entities.push(...lit.entities);
      wireIds.push(...lit.wireIds);
      shapeIds.push(...lit.shapeIds);
    }
    let standardAxes: StandardAxisId[] = [];
    let connectorIds: string[] = [];
    if (this.panel.directionShown) {
      const lit = this.panel.direction.highlight();
      entities.push(...lit.entities);
      wireIds.push(...lit.wireIds);
      planeQuadIds.push(...lit.planeQuadIds);
      standardAxes = lit.standardAxes;
      connectorIds = lit.connectorIds;
    }
    this.viewer.setSelectedStandardAxes(standardAxes);
    this.viewer.setPickedConnectors(connectorIds);
    const all = mergeUniqueEntities(entities, preview);
    if (all.length === 0 && wireIds.length === 0 && shapeIds.length === 0 && planeQuadIds.length === 0) {
      this.viewer.clearHighlight();
      return;
    }
    this.viewer.highlightEntities(all, wireIds, shapeIds, planeQuadIds);
  }

  private syncLauncher(): void {
    this.launcher.setActive(this.armed);
    this.launcher.setDisabled(!this.available);
    this.hooks.onActiveChange?.();
  }
}
