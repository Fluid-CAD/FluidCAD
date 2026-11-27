import {
  featureGhostScope, fetchFeatureGhostResult, fetchFeatureSources, getScopeVariables,
  type ApplyFeatureResponse, type EditSessionFields, type FeatureEditTarget, type FeatureGhostRequest,
  type FeatureSourcesResult, type GhostOperandRef, type GhostSolid, type OperandInputRef, type ParsedFeatureStatement,
  type SourceSlotRef,
} from '../../api';
import { mergeUniqueEntities } from '../../helpers/entities';
import type { SceneObjectRender, SubSelection } from '../../types';
import type { SelectedEntity, Viewer } from '../../viewer';
import { EditSession, type EditSessionInfo } from '../edit-session';
import type { FeatureDialogExit } from '../feature-dialog-registry';
import { SelectionContextMenu } from '../selection-menu';
import { ApplyRunner } from './apply-runner';
import type { ExtraPickRow } from './extra-pick-row';
import type { FeatureLauncher } from './feature-button';
import { FeatureGhostOverlay } from './feature-ghost';
import type { OperandRowPanel } from './operand-row-panel';
import type { OperandKind } from './operand-slot';
import { RecentClicks, type ClickedPick } from './recent-clicks';
import { applyPickChannels, type PickOutcome } from './schema/schema-pickers';
import { collectSketchProfiles } from './sketch-profiles';
import { SketchUISuspender } from './sketch-suspender';

/** One list per operand row, under the row's name — how every wire carries a row (`first`, `source`). */
export type RowLists<R extends string, T> = Record<R, T[]>;

/** An edit's operand rows: a re-picked row's picks, and nothing for a row that keeps the statement's own argument. */
export type RowEdits<R extends string> = Partial<RowLists<R, OperandInputRef>>;

/**
 * What a tool answers in place of a request its own values keep from being
 * sent — a distance that does not read, or reads zero: the message Apply
 * shows. The statement preview and the curve wait until it is gone.
 */
export type Blocked = { error: string };

/**
 * The wire types of an operand-row tool, each carrying a row under its name
 * as the server's operand rows write and read them: the statement an edit
 * opens over (`firstTexts`), what the engine resolves its operands to
 * (`first`), and the create, edit and preview requests (`first`).
 */
export type OperandRowWires<R extends string> = {
  parsed: ParsedFeatureStatement & Record<`${R}Texts`, string[]>;
  sources: Extract<FeatureSourcesResult, { ok: true }> & RowLists<R, SourceSlotRef>;
  create: RowLists<R, OperandInputRef>;
  edit: EditSessionFields & RowEdits<R>;
  ghost: FeatureGhostRequest & RowLists<R, GhostOperandRef>;
};

/** What the page hears from a dialog. */
export type OperandRowHooks = {
  /** The dialog is about to arm — the page closes every other one. */
  onEnter?: () => void;
  /** Armed or disarmed — lets the Sketch button owner re-check `isActive`. */
  onActiveChange?: () => void;
  onSuspendSketchUI?: () => void;
  onResumeSketchUI?: () => void;
};

/** What an operand-row tool says once, beside its panel and its requests. */
export type OperandRowTool<R extends string, X extends string, T extends OperandRowWires<R>> = {
  /** The statement kind: an edit opens over it and the engine's sources answer for it. */
  kind: T['sources']['feature'];
  /** What a failed Apply names: "Could not apply the intersection curve." */
  noun: string;
  /** The api call writing the statement (or, with `preview`, just rendering it). */
  create(request: T['create']): Promise<ApplyFeatureResponse>;
  /** The api call rewriting the statement at `target` in place. */
  edit(target: FeatureEditTarget, request: T['edit']): Promise<ApplyFeatureResponse>;
  /** The rows beside the operand rows, under the names the panel arms them by. */
  extraRows: Record<X, ExtraPickRow>;
};

/** What Apply and the statement preview send: a new statement, or an edit of the one the dialog opened over. */
type OperandRowRequest<Create, Edit> =
  | { kind: 'create'; request: Create }
  | { kind: 'edit'; target: FeatureEditTarget; request: Edit };

/** What a timeline row an operand row takes nothing from is told, after the row's name. */
const ROW_REFUSAL: Record<OperandKind, string> = {
  curve: 'holds no curve — pick a sketch\'s or a curve\'s row, or edges in the viewport.',
  surface: 'holds no surface — pick a surface\'s row, or faces in the viewport.',
};

/** What a row of each kind picks one by one, for the message that says they were reset. */
const PICKED: Record<OperandKind, string> = { curve: 'edges', surface: 'faces' };

/**
 * The service of an operand-row dialog: a tool whose statement takes rows
 * of curve and surface picks ({@link OperandRowPanel}), with options of its
 * own, that previews its result as a curve and is edited back from its
 * timeline row. Curves › Intersect and Curves › Project are two.
 *
 * It owns what every such dialog does alike:
 *
 * - **Entering and exiting**, in create mode from the launcher and in edit
 *   mode over a statement ({@link enterEdit}): the session rolls the view back
 *   to just before the statement, each row opens on its argument as
 *   "Current: …" chips (`<row>Texts`), lit once the engine says what they
 *   resolve to (the sources' `<row>`), and Apply rewrites only the rows that
 *   were re-picked.
 * - **Routing every gesture into the armed row**: a click, a sketch's wire
 *   in a curve row, a timeline row (refused in the row's words), a
 *   right-click group and a double-click growing an operand row. A
 *   double-click's two clicks land first; when the first handed the border
 *   on and the second landed in the next row as its echo — the same pick,
 *   or the face behind the edge or the sketch's wire the first picked — the
 *   second is taken back out, and the gesture grows the row it started in.
 * - **The requests**: each row's picks for Apply, an edit and the preview,
 *   a kept row standing in the preview as what the engine resolved it to.
 * - **Every render**, the highlight of what the rows hold, the viewer's
 *   channels for the armed row and the launcher's state.
 *
 * A tool declares its rows and options in its panel, and here only what
 * differs: whether the scene offers what it works on, its request building
 * ({@link createRequest}, {@link editRequest}, {@link ghostRequest}) — which
 * may answer {@link Blocked} while a value of its own does not read — the
 * options and extra rows an edit seeds ({@link seedEdit},
 * {@link seedSources}) and the rows beside its operand rows that take picks
 * of their own ({@link ExtraPickRow}). A panel with value fields has the
 * variables in scope listed for them each time the dialog opens.
 */
export abstract class OperandRowService<
  R extends string,
  X extends string,
  T extends OperandRowWires<R>,
  P extends OperandRowPanel<R, X> = OperandRowPanel<R, X>,
> {
  private readonly launcher: FeatureLauncher;
  private readonly sketchUI: SketchUISuspender;
  private readonly ghost: FeatureGhostOverlay;
  private readonly selectionMenu: SelectionContextMenu;
  private readonly runner: ApplyRunner<OperandRowRequest<T['create'], T['edit']>>;
  private armed = false;
  private available = false;
  private sceneObjects: SceneObjectRender[] = [];
  private sceneSketchActive = false;
  /** Statement being edited in place (timeline double-click), or null. */
  private editTarget: FeatureEditTarget | null = null;
  /** The statement the edit opened over. */
  private parsed: T['parsed'] | null = null;
  /** View-state half of edit mode: pre-statement rollback + boundary. */
  private readonly session = new EditSession();
  /** What the edited statement's operands resolve to at the boundary, per row; null until the engine answers. */
  private sources: RowLists<R, SourceSlotRef> | null = null;
  /** The rows have not seen the boundary yet: what they picked before it was on another scene. */
  private beforeBoundary = false;
  /** A full render arrived mid-session — the picked edges' and faces' ids died. */
  private editSceneStale = false;
  /** The last two viewport clicks into an operand row: the two a double-click arrives after. */
  private readonly recentClicks = new RecentClicks<R>();

  protected constructor(
    container: HTMLElement,
    protected readonly viewer: Viewer,
    launcher: FeatureLauncher,
    private readonly hooks: OperandRowHooks,
    protected readonly panel: P,
    private readonly tool: OperandRowTool<R, X, T>,
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

    this.panel.onApply = () => void this.runner.apply();
    this.panel.onExit = () => this.exit();
    // A chip's ✕, an option.
    this.panel.onChange = () => this.changed();
    this.panel.onArmedRowChange = () => {
      this.selectionMenu.hide();
      this.closeExtras();
      this.syncChannels();
    };
    for (const extra of this.extras) {
      extra.onPick = outcome => this.landExtra(outcome);
    }

    // Every group is offered, and each lands in the armed operand row as plain picks.
    this.selectionMenu = new SelectionContextMenu(container, `fluidcad-${tool.kind}-select-menu`, {
      kinds: ['tangent', 'loop', 'classified', 'same-type', 'equal', 'sibling'],
      onSelectGroup: (_kind, _seed, members) => {
        const row = this.armedOperandRow();
        if (this.armed && row !== null) {
          this.land(row, this.panel.slot(row).takeMembers(members));
        }
      },
      onPreview: (members) => this.refreshHighlight(members ?? []),
      boundary: () => this.session.boundary ?? undefined,
    });

    this.runner = new ApplyRunner<OperandRowRequest<T['create'], T['edit']>>({
      panel: this.panel,
      session: this.session,
      isArmed: () => this.armed,
      build: () => this.editTarget ? this.buildEditRequest(this.editTarget) : this.buildCreateRequest(),
      send: (built, extras) => built.kind === 'edit'
        ? this.tool.edit(built.target, { ...built.request, ...extras })
        : this.tool.create({ ...built.request, ...extras }),
      onApplied: () => this.exit(this.editTarget ? { editEnd: 'apply' } : { resume: 'lazy' }),
      failMessage: () => this.editTarget ? 'Could not apply the edit.' : `Could not apply the ${this.tool.noun}.`,
      // The statement preview's geometric twin: the curve itself, in the
      // blue an applied curve wears.
      ghost: {
        fetch: (_built, signal) => this.fetchGhost(signal),
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

  /** A curve row is armed: a sketch's wire is its pick. */
  get isCurvePicking(): boolean {
    const row = this.armedOperandRow();
    return this.armed && row !== null && this.panel.slot(row).kind === 'curve';
  }

  /** True while armed picking has suspended sketch editing. */
  get sketchUISuspended(): boolean {
    return this.sketchUI.suspended;
  }

  /** The dialog's panel, for the tests to drive. */
  get dialogPanel(): P {
    return this.panel;
  }

  // -------------------------------------------------------------------------
  // What a tool says
  // -------------------------------------------------------------------------

  /** Whether the scene holds what the tool works on: without it the launcher greys out and an open dialog closes. */
  protected abstract isAvailable(sceneObjects: SceneObjectRender[]): boolean;

  /**
   * The create request from the rows' picks, each row holding at least one:
   * the rows, then the tool's options — or {@link Blocked} while one of its
   * values does not read.
   */
  protected abstract createRequest(rows: RowLists<R, OperandInputRef>): T['create'] | Blocked;

  /**
   * The edit request: the re-picked rows (a row left out keeps the
   * statement's own argument), what changed of the tool's options, and
   * {@link editSession} — or {@link Blocked}, as for {@link createRequest}.
   */
  protected abstract editRequest(rows: RowEdits<R>, parsed: T['parsed']): T['edit'] | Blocked;

  /** The preview request from the rows as the preview addresses them, or null while something it needs is not known yet. */
  protected abstract ghostRequest(rows: RowLists<R, GhostOperandRef>): T['ghost'] | null;

  /** Edit mode, once the operand rows hold the statement's own arguments: the options as written, and the extra rows' own. */
  protected seedEdit(_parsed: T['parsed']): void {}

  /**
   * What the engine resolved the edited statement to, once the operand rows
   * took theirs — null when it could not say: the extra rows' own.
   */
  protected seedSources(_sources: T['sources'] | null): void {}

  /**
   * The edit session's fields every edit request carries: the statement it
   * expects, and — when a re-picked row names an edge or a face, or the
   * tool's own fields do (`picksEntities`: a picked direction edge) — the
   * boundary the selector is synthesized against.
   */
  protected editSession(rows: RowEdits<R>, picksEntities = false): EditSessionFields {
    const picks = picksEntities || this.panel.rows.some(row => rows[row]?.some(input => input.kind !== 'statement'));
    return {
      expectedStatement: this.session.expectedStatement,
      before: picks ? this.session.boundary ?? undefined : undefined,
    };
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
        this.panel.setMessage(`The code changed — the re-picked ${this.pickedNoun()} were reset.`);
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
    this.available = this.isAvailable(sceneObjects);
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
    this.recentClicks.forget();
    // Composing a curve means looking at the whole scene, not down the
    // active sketch plane (resumed on cancel; an apply's re-render takes over).
    if (this.sceneSketchActive) {
      this.sketchUI.suspend();
    }
    this.syncLauncher();
    this.panel.show();
    this.panel.setMessage(null);
    void this.loadScopeVariables();
    this.setRowScenes({ dropEntities: true });
    this.syncChannels();
    this.refreshHighlight();
    this.runner.schedulePreview();
  }

  /**
   * Open over an existing statement (timeline double-click). The session
   * rolls the viewport back to just before the statement; each operand row
   * opens on its argument's operands as "Current: …" chips, lit once the
   * engine says what they resolve to, and the tool seeds its options and
   * extra rows as written. Apply rewrites the statement in place, sending
   * only what changed.
   */
  enterEdit(target: FeatureEditTarget, parsed: T['parsed'], info: Omit<EditSessionInfo, 'target'>): void {
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
    this.recentClicks.forget();
    this.syncLauncher();
    this.sketchUI.suspend();
    this.session.begin({ ...info, target });
    this.panel.showEdit();
    this.panel.setMessage(null);
    for (const row of this.panel.rows) {
      this.panel.slot(row).seedKeep(this.rowTexts(parsed, row));
    }
    this.seedEdit(parsed);
    void this.loadScopeVariables();
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
    this.recentClicks.forget();
    this.syncLauncher();
    this.runner.cancelPreview();
    this.ghost.clear();
    this.selectionMenu.hide();
    this.closeExtras();
    // The rows let go of what they hold, a consumed object they kept drawn among it.
    this.panel.clearRows();
    this.viewer.clearHighlight();
    this.viewer.pickFilter = 'all';
    this.viewer.pickSketchWires = false;
    this.viewer.pickAxes = false;
    for (const extra of this.extras) {
      extra.release();
    }
    this.panel.hide();
    this.sketchUI.resume((opts.resume ?? 'immediate') === 'immediate');
  }

  /**
   * The variables in scope where the statement sits — the edited one, or
   * the end of the active part a new one lands at — for the panel's value
   * fields, when it has any. An answer landing after the dialog closed or
   * moved to another statement is dropped. Fetched through this module's
   * own api import, as every other request of the dialog is, not through
   * `option-relabeler`'s helper: the ui suite runs without isolation, and
   * that module keeps the `getScopeVariables` of whichever test file
   * loaded it first.
   */
  private async loadScopeVariables(): Promise<void> {
    if (!this.panel.hasValueFields) {
      return;
    }
    const line = this.editTarget?.line ?? null;
    const variables = await getScopeVariables(line);
    if (this.armed && (this.editTarget?.line ?? null) === line) {
      this.panel.setScopeVariables(variables);
    }
  }

  // -------------------------------------------------------------------------
  // Picks
  // -------------------------------------------------------------------------

  /**
   * A viewport click lands in the armed row: in an operand row an edge or a
   * face as itself, or the whole object it stands for (a sketch, a curve, a
   * surface); in an extra row whatever that row takes.
   */
  handleClick(shapeId: string | null, sub: SubSelection): void {
    if (!this.armed || !shapeId || !sub) {
      return;
    }
    this.selectionMenu.hide();
    const row = this.armedOperandRow();
    if (row === null) {
      this.recentClicks.forget();
      void this.takeExtraClick(this.armedExtra(), shapeId, sub);
      return;
    }
    const outcome = this.panel.slot(row).takeClick(shapeId, sub);
    this.land(row, outcome);
    this.remember(row, { shapeId, sub }, outcome);
  }

  /** A sketch's wire clicked while a curve row is armed: the whole sketch. */
  handleSketchPick(shapeId: string): boolean {
    if (!this.isCurvePicking) {
      return false;
    }
    this.selectionMenu.hide();
    const row = this.armedOperandRow();
    const pick: ClickedPick = { shapeId, sub: { type: 'sketch', index: 0 } };
    const outcome = this.panel.slot(row).takeClick(shapeId, pick.sub);
    this.land(row, outcome);
    this.remember(row, pick, outcome);
    return true;
  }

  /**
   * A double-click on an edge or a face of a body: the operand row the
   * gesture started in grows by an edge's tangent chain or rim loop, or a
   * face's bucket (a sketch's or a surface's pick is whole already). The
   * gesture's own two clicks have toggled the pick; the members join either
   * way. The answer lands only in the row that asked, if it is still armed.
   */
  async handleDoubleClick(shapeId: string | null, sub: SubSelection): Promise<void> {
    const armed = this.armedOperandRow();
    if (!this.armed || !shapeId || !sub || armed === null) {
      return;
    }
    this.selectionMenu.hide();
    const { row, seed, repaired } = this.gestureRow(armed, { shapeId, sub });
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

  /** A right-click on an edge or a face of a body: the multi-select menu for it, its group landing in the armed operand row. */
  handleContextMenu(shapeId: string | null, sub: SubSelection, clientX: number, clientY: number): void {
    if (!this.armed) {
      return;
    }
    this.selectionMenu.hide();
    const row = this.armedOperandRow();
    if (row === null || !shapeId || (sub?.type !== 'face' && sub?.type !== 'edge')) {
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
   * curve's row in a curve row, the row of an object holding a surface in a
   * surface row, whatever an extra row takes. Any other row is refused in
   * the dialog — consumed either way, so the default rollback can't close
   * the dialog mid-flow.
   */
  handleTimelinePick(obj: SceneObjectRender): boolean {
    if (!this.armed) {
      return false;
    }
    const row = this.armedOperandRow();
    if (row === null) {
      const extra = this.armedExtra();
      const outcome = extra.takeRow(obj);
      if (outcome === 'ignored') {
        this.panel.setMessage(`${obj.name || 'That row'} ${extra.rowRefusal}`);
      } else {
        this.landExtra(outcome);
      }
      return true;
    }
    const slot = this.panel.slot(row);
    const outcome = slot.takeRow(obj);
    if (outcome === 'ignored') {
      this.panel.setMessage(`${obj.name || 'That row'} ${ROW_REFUSAL[slot.kind]}`);
      return true;
    }
    this.land(row, outcome);
    return true;
  }

  /** The rows beside the operand rows, in the panel's order. */
  private get extras(): ExtraPickRow[] {
    return this.panel.extraRows.map(row => this.tool.extraRows[row]);
  }

  /** The armed operand row, or null while a row beside them holds the border. */
  private armedOperandRow(): R | null {
    const row = this.panel.armedRow;
    return this.panel.isOperandRow(row) ? row : null;
  }

  /** The armed row beside the operand rows, or null while an operand row holds the border. */
  private armedExtra(): ExtraPickRow | null {
    const row = this.panel.armedRow;
    return this.panel.isOperandRow(row) ? null : this.tool.extraRows[row];
  }

  /** Keep the click for a double-click that may follow it. */
  private remember(row: R, pick: ClickedPick, outcome: PickOutcome): void {
    this.recentClicks.remember(row, pick, outcome === 'taken', this.panel.armedRow !== row);
  }

  /**
   * The row a double-click at `pick` grows — `armed`, unless its two clicks
   * show it started in another ({@link RecentClicks}): then its second
   * click comes back out of the row it landed in, and the row where it
   * started takes the border back.
   */
  private gestureRow(armed: R, pick: ClickedPick): { row: R; seed: ClickedPick; repaired: boolean } {
    const start = this.recentClicks.gestureStart(armed, pick);
    if (start.repaired) {
      if (start.takeBack) {
        this.panel.slot(start.takeBack.row).takeClick(start.takeBack.pick.shapeId, start.takeBack.pick.sub);
      }
      this.panel.armRow(start.row);
      this.refreshHighlight();
    }
    return start;
  }

  /** An extra row's answer to a click, once it has it (the engine may be asked first). */
  private async takeExtraClick(extra: ExtraPickRow, shapeId: string, sub: NonNullable<SubSelection>): Promise<void> {
    const outcome = await extra.takeClick(shapeId, sub);
    if (this.armed) {
      this.landExtra(outcome);
    }
  }

  /** What an operand row answered: the pick lands, handing the border on from `row` when the next row is empty, or its refusal shows. */
  private land(row: R, outcome: PickOutcome): void {
    if (this.took(outcome)) {
      this.panel.advanceFrom(row);
      this.changed();
    }
  }

  /** What an extra row answered: the pick lands, or its refusal shows. */
  private landExtra(outcome: PickOutcome): void {
    if (this.took(outcome)) {
      this.changed();
    }
  }

  /** Whether a row took the pick; a refusal shows in the dialog. */
  private took(outcome: PickOutcome): boolean {
    if (outcome === 'ignored') {
      return false;
    }
    if (outcome !== 'taken') {
      this.panel.setMessage(outcome.message);
      return false;
    }
    return true;
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

  /** The create request: every row's picks and the tool's options, or the message of the first empty row or of what the tool blocks. */
  private buildCreateRequest(): OperandRowRequest<T['create'], T['edit']> | Blocked {
    const rows = {} as RowLists<R, OperandInputRef>;
    for (const row of this.panel.rows) {
      const inputs = this.rowInputs(row);
      if (!inputs || inputs.length === 0) {
        return { error: this.panel.emptyMessage(row) };
      }
      rows[row] = inputs;
    }
    const request = this.createRequest(rows);
    return isBlocked(request) ? request : { kind: 'create', request };
  }

  /**
   * The edit request. A row still on its "Current: …" chips is left out, so
   * the statement's own argument is written back byte for byte; a re-picked
   * row ships its picks, edges and faces synthesized against the session
   * boundary.
   */
  private buildEditRequest(target: FeatureEditTarget): OperandRowRequest<T['create'], T['edit']> | Blocked {
    const rows: RowEdits<R> = {};
    for (const row of this.panel.rows) {
      const inputs = this.rowInputs(row);
      if (inputs && inputs.length === 0) {
        return { error: this.panel.emptyMessage(row) };
      }
      if (inputs) {
        rows[row] = inputs;
      }
    }
    const request = this.editRequest(rows, this.parsed);
    return isBlocked(request) ? request : { kind: 'edit', target, request };
  }

  /** A row's picks as the apply route takes them, in pick order; null while it keeps the statement's own argument. */
  private rowInputs(row: R): OperandInputRef[] | null {
    const held = this.panel.slot(row).picks();
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
   * What the rows describe, once every row holds something the preview can
   * address and the tool's request is complete. An engine refusal the
   * server marks as worth saying shows in the dialog.
   */
  private async fetchGhost(signal: AbortSignal): Promise<GhostSolid[] | null> {
    const rows = {} as RowLists<R, GhostOperandRef>;
    for (const row of this.panel.rows) {
      const refs = this.ghostRow(row);
      if (!refs) {
        return null;
      }
      rows[row] = refs;
    }
    const request = this.ghostRequest(rows);
    if (!request) {
      return null;
    }
    const result = await fetchFeatureGhostResult(request, featureGhostScope(this.editTarget), signal);
    if (result.notice && !signal.aborted && this.armed) {
      this.panel.setMessage(result.notice);
    }
    return result.solids;
  }

  /**
   * A row's picks on the preview wire. A kept row stands as what the engine
   * resolved its operands to — a statement by call site, a selection as its
   * edges (curve row) or faces (surface row); null while that is not known
   * or an operand has no such form (an expression).
   */
  private ghostRow(row: R): GhostOperandRef[] | null {
    const slot = this.panel.slot(row);
    const held = slot.picks();
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
    const wanted = slot.kind === 'curve' ? 'edge' : 'face';
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

  /** The statement's own operand texts for `row`. */
  private rowTexts(parsed: T['parsed'], row: R): string[] {
    const texts: Record<`${R}Texts`, string[]> = parsed;
    return texts[`${row}Texts`];
  }

  /** The engine's sources answer for this tool's statement. */
  private isOwnSources(result: FeatureSourcesResult): result is T['sources'] {
    return result.ok && result.feature === this.tool.kind;
  }

  /**
   * What the edited statement's operands resolve to at the boundary: the
   * kept chips light them, the preview stands on them, and a row's first
   * pick starts from them. A row already re-picked keeps its picks.
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
    const own = this.isOwnSources(result) ? result : null;
    const sources = {} as RowLists<R, SourceSlotRef>;
    for (const row of this.panel.rows) {
      sources[row] = own ? own[row] : [];
    }
    this.sources = sources;
    for (const row of this.panel.rows) {
      const slot = this.panel.slot(row);
      if ('keep' in slot.picks()) {
        slot.seedKeep(this.rowTexts(parsed, row), sources[row]);
      } else {
        slot.setKeepRefs(sources[row]);
      }
    }
    this.seedSources(own);
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
    let dropped = false;
    for (const row of this.panel.rows) {
      dropped = this.panel.slot(row).setScene(this.sceneObjects, opts) || dropped;
    }
    for (const extra of this.extras) {
      dropped = extra.setScene(this.sceneObjects, opts) || dropped;
    }
    return dropped;
  }

  /** The viewer offers what the armed row takes, and each extra row shows or hides what only it offers. */
  private syncChannels(): void {
    if (!this.armed) {
      return;
    }
    const row = this.armedOperandRow();
    const armedExtra = this.armedExtra();
    applyPickChannels(this.viewer, row === null ? armedExtra.channels() : this.panel.slot(row).channels());
    for (const extra of this.extras) {
      extra.aim(extra === armedExtra);
    }
  }

  /**
   * Light up what the rows hold — an edge or a face as itself, a sketch or a
   * curve by its wires, a surface whole, a kept argument as what it resolved
   * to, and what an extra row on show holds — with `preview`, the picks a
   * hovered menu item would add.
   */
  private refreshHighlight(preview: SelectedEntity[] = []): void {
    if (!this.armed) {
      return;
    }
    const entities: SelectedEntity[] = [];
    const wireIds: string[] = [];
    const shapeIds: string[] = [];
    const planeQuadIds: string[] = [];
    for (const row of this.panel.rows) {
      const lit = this.panel.slot(row).highlight();
      entities.push(...lit.entities);
      wireIds.push(...lit.wireIds);
      shapeIds.push(...lit.shapeIds);
    }
    for (const extra of this.extras) {
      const lit = extra.paint();
      entities.push(...lit.entities);
      wireIds.push(...lit.wireIds);
      planeQuadIds.push(...lit.planeQuadIds);
    }
    const all = mergeUniqueEntities(entities, preview);
    if (all.length === 0 && wireIds.length === 0 && shapeIds.length === 0 && planeQuadIds.length === 0) {
      this.viewer.clearHighlight();
      return;
    }
    this.viewer.highlightEntities(all, wireIds, shapeIds, planeQuadIds);
  }

  /** Close what the extra rows opened over the viewport. */
  private closeExtras(): void {
    for (const extra of this.extras) {
      extra.close();
    }
  }

  /** What the operand rows pick one by one: "faces", "edges and faces". */
  private pickedNoun(): string {
    const kinds = new Set(this.panel.rows.map(row => this.panel.slot(row).kind));
    return (['curve', 'surface'] as const).filter(kind => kinds.has(kind)).map(kind => PICKED[kind]).join(' and ');
  }

  private syncLauncher(): void {
    this.launcher.setActive(this.armed);
    this.launcher.setDisabled(!this.available);
    this.hooks.onActiveChange?.();
  }
}

/** The tool answered the message blocking its request, not the request. */
function isBlocked<Q extends object>(request: Q | Blocked): request is Blocked {
  return 'error' in request;
}
