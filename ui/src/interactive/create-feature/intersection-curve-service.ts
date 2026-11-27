import {
  applyIntersectionCurve, applyIntersectionCurveEdit, featureGhostScope, fetchFeatureGhostResult, fetchFeatureSources,
  type FeatureEditTarget, type GhostOperandRef, type GhostSolid, type IntersectionCurveApplyOptions,
  type IntersectionCurveEditOptions, type OperandInputRef, type ParsedFeatureStatement, type SourceSlotRef,
} from '../../api';
import { mergeUniqueEntities, sameEntity } from '../../helpers/entities';
import { hasSolid, hasSurface } from '../../helpers/scene-utils';
import type { SceneObjectRender, SubSelection } from '../../types';
import type { Navbar } from '../../ui/navbar';
import type { SelectedEntity, Viewer } from '../../viewer';
import { EditSession, type EditSessionInfo } from '../edit-session';
import type { FeatureDialogExit } from '../feature-dialog-registry';
import { SelectionContextMenu } from '../selection-menu';
import { ApplyRunner } from './apply-runner';
import { detachedLauncher, type FeatureLauncher } from './feature-button';
import { FeatureGhostOverlay } from './feature-ghost';
import { IntersectionCurvePanel, type IntersectionRow } from './intersection-curve-panel';
import type { OperandSlotControl } from './operand-slot';
import { applyPickChannels, type PickOutcome } from './schema/schema-pickers';
import { collectSketchProfiles } from './sketch-profiles';
import { SketchUISuspender } from './sketch-suspender';

/** The parsed statement the dialog edits. */
type ParsedIntersectionCurve = Extract<ParsedFeatureStatement, { feature: 'intersection-curve' }>;

/** What the engine resolved each operand of the edited statement to, per row. */
type EditSources = Record<IntersectionRow, SourceSlotRef[]>;

const ROWS: readonly IntersectionRow[] = ['first', 'second'];

/** One viewport click, as a double-click that follows it reads it back. */
type RecentClick = {
  row: IntersectionRow;
  entity: SelectedEntity;
  /** The row took it (or took it back off). */
  taken: boolean;
  /** It handed the armed border on to the other row. */
  handedOn: boolean;
};

/** The refusal of an apply with an empty row. */
const EMPTY_ROW: Record<IntersectionRow, string> = {
  first: 'Pick the first selection: surfaces, or faces of a body.',
  second: 'Pick the second selection: the surfaces or faces the first one crosses.',
};

/**
 * The Intersect dialog, opened from the Curves menu: `intersect(first,
 * second)` outside a sketch, the curve where two sets of faces meet. Its two
 * surface rows ({@link IntersectionCurvePanel}) collect the picks — a face of
 * a solid as that face, a surface whole — from the viewport and the
 * timeline; a double-click on a face of a body grows the armed row by the
 * face's bucket, and the right-click menu's groups land in it as plain
 * faces. Once both rows hold a pick the curve previews, in the colour of an
 * applied curve, and an engine refusal (the two sides do not cross, a face
 * on both) shows in the dialog. Apply writes the statement; the re-render
 * is the result, editor undo the rollback.
 *
 * A timeline double-click reopens it over an existing statement: the view
 * rolls back to just before it, each row opens on the statement's own
 * argument as "Current: …" chips, and Apply rewrites only the row that was
 * re-picked — a row left alone (a `plane()` the dialog cannot pick among
 * them) is written back as it was.
 */
export class IntersectionCurveFeatureService {
  private readonly panel: IntersectionCurvePanel;
  private readonly launcher: FeatureLauncher;
  private readonly sketchUI: SketchUISuspender;
  private readonly ghost: FeatureGhostOverlay;
  private readonly selectionMenu: SelectionContextMenu;
  private readonly runner: ApplyRunner<IntersectionCurveApplyOptions | IntersectionCurveEditOptions>;
  private armed = false;
  private available = false;
  private sceneObjects: SceneObjectRender[] = [];
  private sceneSketchActive = false;
  /** Statement being edited in place (timeline double-click), or null. */
  private editTarget: FeatureEditTarget | null = null;
  /** The statement the edit opened over. */
  private parsed: ParsedIntersectionCurve | null = null;
  /** View-state half of edit mode: pre-statement rollback + boundary. */
  private readonly session = new EditSession();
  /** What the edited statement's operands resolve to at the boundary; null until the engine answers. */
  private sources: EditSources | null = null;
  /** The rows have not seen the boundary yet: what they picked before it was on another scene. */
  private beforeBoundary = false;
  /** A full render arrived mid-session — the picked faces' ids died. */
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

    this.panel = new IntersectionCurvePanel(container);
    this.panel.onApply = () => void this.runner.apply();
    this.panel.onExit = () => this.exit();
    // A chip's ✕.
    this.panel.onChange = () => this.changed();
    this.panel.onArmedRowChange = () => this.selectionMenu.hide();

    // Every group is offered, and each lands in the armed row as plain faces.
    this.selectionMenu = new SelectionContextMenu(container, 'fluidcad-intersection-curve-select-menu', {
      kinds: ['tangent', 'loop', 'classified', 'same-type', 'equal', 'sibling'],
      onSelectGroup: (_kind, _seed, members) => {
        if (this.armed) {
          this.land(this.panel.armedRow, this.panel.armedSlot.takeMembers(members));
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
        ? applyIntersectionCurveEdit(this.editTarget, { ...(request as IntersectionCurveEditOptions), ...extras })
        : applyIntersectionCurve({ ...(request as IntersectionCurveApplyOptions), ...extras }),
      onApplied: () => this.exit(this.editTarget ? { editEnd: 'apply' } : { resume: 'lazy' }),
      failMessage: () => this.editTarget ? 'Could not apply the edit.' : 'Could not apply the intersection curve.',
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

  /**
   * The armed dialog owns viewport clicks, double-clicks and the right-click
   * menu: both rows are surface rows, so every armed moment picks faces.
   */
  get isPicking(): boolean {
    return this.armed;
  }

  /** True while armed picking has suspended sketch editing. */
  get sketchUISuspended(): boolean {
    return this.sketchUI.suspended;
  }

  /** The dialog's panel, for the tests to drive. */
  get dialogPanel(): IntersectionCurvePanel {
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
      // The engine's answer named faces by ids the rebuild retired.
      this.sources = null;
      if (dropped) {
        this.panel.setMessage('The code changed — the re-picked faces were reset.');
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
    // A curve where two sets of faces meet needs a body to cut: a solid or
    // a surface.
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
    // Shape ids changed with the render: picked faces drop, whole surfaces
    // re-find their statements.
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
   * Open over an existing intersection curve (timeline double-click). The
   * session rolls the viewport back to just before the statement; each row
   * opens on its argument's operands as "Current: …" chips, lit once the
   * engine says what they resolve to. Apply rewrites the statement in place,
   * a row nobody touched as it was written.
   */
  enterEdit(target: FeatureEditTarget, parsed: ParsedIntersectionCurve, info: Omit<EditSessionInfo, 'target'>): void {
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
    this.panel.showEdit();
    this.panel.setMessage(null);
    this.panel.first.seedKeep(parsed.firstTexts);
    this.panel.second.seedKeep(parsed.secondTexts);
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
    // The rows let go of what they hold, a consumed surface they kept drawn among it.
    this.panel.clearRows();
    this.viewer.clearHighlight();
    this.viewer.pickFilter = 'all';
    this.viewer.pickSketchWires = false;
    this.viewer.pickAxes = false;
    this.panel.hide();
    this.sketchUI.resume((opts.resume ?? 'immediate') === 'immediate');
  }

  // -------------------------------------------------------------------------
  // Picks
  // -------------------------------------------------------------------------

  /** A face click lands in the armed row: a face of a solid as itself, a face of a surface as the whole surface. */
  handleClick(shapeId: string | null, sub: SubSelection): void {
    if (!this.armed || !shapeId || !sub) {
      return;
    }
    this.selectionMenu.hide();
    const row = this.panel.armedRow;
    const outcome = this.panel.armedSlot.takeClick(shapeId, sub);
    this.land(row, outcome);
    this.recentClicks = sub.type === 'face'
      ? [...this.recentClicks.slice(-1), {
        row,
        entity: { shapeId, sub },
        taken: outcome === 'taken',
        handedOn: this.panel.armedRow !== row,
      }]
      : [];
  }

  /**
   * A double-click on a face of a body: the row the gesture started in grows
   * by the face's bucket (a surface's face is its whole surface already).
   * The gesture's own two clicks have toggled the face; the members join
   * either way. The answer lands only in the row that asked, if it is still
   * armed.
   */
  async handleDoubleClick(shapeId: string | null, sub: SubSelection): Promise<void> {
    if (!this.armed || !shapeId || !sub) {
      return;
    }
    this.selectionMenu.hide();
    const { row, repaired } = sub.type === 'face'
      ? this.gestureRow({ shapeId, sub })
      : { row: this.panel.armedRow, repaired: false };
    const outcome = await this.panel.slot(row).takeDoubleClick(shapeId, sub, this.session.boundary ?? undefined);
    if (!this.armed || this.panel.armedRow !== row) {
      return;
    }
    if (outcome !== 'taken' && repaired) {
      // Nothing joined, but the face stays picked: hand the border on again.
      this.panel.advanceFrom(row);
      this.refreshHighlight();
      this.runner.schedulePreview();
    }
    this.land(row, outcome);
  }

  /**
   * The row a double-click on `entity` belongs to. Its first click can fill
   * First and hand the border to an empty Second, which its second click
   * then lands in: that click is taken back out of Second, and the gesture
   * goes on in First, where it started.
   */
  private gestureRow(entity: { shapeId: string; sub: { type: 'face'; index: number } }): { row: IntersectionRow; repaired: boolean } {
    const [first, second] = this.recentClicks.length === 2 ? this.recentClicks : [];
    this.recentClicks = [];
    if (!first || !second || !first.handedOn || second.row === first.row
      || !sameEntity(first.entity, entity) || !sameEntity(second.entity, entity)) {
      return { row: this.panel.armedRow, repaired: false };
    }
    if (second.taken) {
      this.panel.slot(second.row).takeClick(entity.shapeId, entity.sub);
    }
    this.panel.armRow(first.row);
    this.refreshHighlight();
    return { row: first.row, repaired: true };
  }

  /** A right-click on a face of a body: the multi-select menu for it, its group landing in the armed row. */
  handleContextMenu(shapeId: string | null, sub: SubSelection, clientX: number, clientY: number): void {
    if (!this.armed) {
      return;
    }
    this.selectionMenu.hide();
    if (shapeId && sub?.type === 'face' && this.panel.armedSlot.expands(shapeId, sub)) {
      // The hover tint would otherwise be stashed as an "original" colour by
      // the preview highlight and stick around after the preview restores it.
      this.viewer.clearHover();
      void this.selectionMenu.open({ shapeId, sub }, clientX, clientY);
    }
  }

  /**
   * A timeline row while armed: the row of an object holding a surface lands
   * in the armed row as that surface. Any other row is refused in the
   * dialog — consumed either way, so the default rollback can't close the
   * dialog mid-flow.
   */
  handleTimelinePick(obj: SceneObjectRender): boolean {
    if (!this.armed) {
      return false;
    }
    const outcome = this.panel.armedSlot.takeRow(obj);
    if (outcome === 'ignored') {
      this.panel.setMessage(`${obj.name || 'That row'} holds no surface — pick a surface's row, or faces in the viewport.`);
      return true;
    }
    this.land(this.panel.armedRow, outcome);
    return true;
  }

  /** What a row answered: the pick lands (First's first pick hands the border on), or its refusal shows. */
  private land(row: IntersectionRow, outcome: PickOutcome): void {
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

  /** What the rows hold changed: the message clears, the highlight and the preview follow. */
  private changed(): void {
    this.panel.setMessage(null);
    this.refreshHighlight();
    this.runner.schedulePreview();
  }

  // -------------------------------------------------------------------------
  // Requests
  // -------------------------------------------------------------------------

  /** The create request: both rows' picks, or the message blocking it. */
  private buildRequest(): IntersectionCurveApplyOptions | { error: string } {
    const first = this.rowInputs(this.panel.first);
    if (!first || first.length === 0) {
      return { error: EMPTY_ROW.first };
    }
    const second = this.rowInputs(this.panel.second);
    if (!second || second.length === 0) {
      return { error: EMPTY_ROW.second };
    }
    return { first, second };
  }

  /**
   * The edit request. A row still on its "Current: …" chips is left out, so
   * the statement's own argument is written back byte for byte; a re-picked
   * row ships its picks, faces synthesized against the session boundary.
   */
  private buildEditRequest(): IntersectionCurveEditOptions | { error: string } {
    const first = this.rowInputs(this.panel.first) ?? undefined;
    const second = this.rowInputs(this.panel.second) ?? undefined;
    for (const row of ROWS) {
      const inputs = row === 'first' ? first : second;
      if (inputs && inputs.length === 0) {
        return { error: EMPTY_ROW[row] };
      }
    }
    const picksFaces = [first, second].some(inputs => inputs?.some(input => input.kind === 'face'));
    return {
      first,
      second,
      expectedStatement: this.session.expectedStatement,
      before: picksFaces ? this.session.boundary ?? undefined : undefined,
    };
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
      return sub?.type === 'face' ? [{ kind: 'face', shapeId: pick.entity.shapeId, index: sub.index }] : [];
    });
  }

  /**
   * The curve the two rows describe, once both hold something the preview
   * can address. An engine refusal the server marks as worth saying — the
   * sides do not cross, a face on both — shows in the dialog.
   */
  private async fetchGhost(signal: AbortSignal): Promise<GhostSolid[] | null> {
    const first = this.ghostRow('first');
    const second = this.ghostRow('second');
    if (!first || !second) {
      return null;
    }
    const result = await fetchFeatureGhostResult(
      { feature: 'intersection-curve', first, second },
      featureGhostScope(this.editTarget),
      signal,
    );
    if (result.notice && !signal.aborted && this.armed) {
      this.panel.setMessage(result.notice);
    }
    return result.solids;
  }

  /**
   * A row's picks on the preview wire. A kept row stands as what the engine
   * resolved its operands to — a statement by call site (a `plane()`
   * among them), a face selection as its faces; null while that is not
   * known or an operand has no such form (an expression).
   */
  private ghostRow(row: IntersectionRow): GhostOperandRef[] | null {
    const held = this.panel.slot(row).picks();
    if (!('keep' in held)) {
      const refs = held.picks.flatMap((pick): GhostOperandRef[] => {
        if (pick.kind === 'object') {
          const loc = pick.row.sourceLocation;
          return loc ? [{ kind: 'statement', filePath: loc.filePath, line: loc.line }] : [];
        }
        const sub = pick.entity.sub;
        return sub?.type === 'face' ? [{ kind: 'face', shapeId: pick.entity.shapeId, index: sub.index }] : [];
      });
      return refs.length > 0 ? refs : null;
    }
    const kept = this.sources?.[row];
    if (!kept || kept.length === 0) {
      return null;
    }
    const refs: GhostOperandRef[] = [];
    for (const ref of kept) {
      if (ref.kind === 'sketch') {
        refs.push({ kind: 'statement', filePath: ref.filePath, line: ref.line });
      } else if (ref.kind === 'entities' && ref.entities.length > 0 && ref.entities.every(e => e.sub.type === 'face')) {
        refs.push(...ref.entities.map((e): GhostOperandRef => ({ kind: 'face', shapeId: e.shapeId, index: e.sub.index })));
      } else {
        return null;
      }
    }
    return refs;
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
    const sources: EditSources = result.ok && result.feature === 'intersection-curve'
      ? { first: result.first, second: result.second }
      : { first: [], second: [] };
    this.sources = sources;
    for (const row of ROWS) {
      const slot = this.panel.slot(row);
      const texts = row === 'first' ? parsed.firstTexts : parsed.secondTexts;
      if ('keep' in slot.picks()) {
        slot.seedKeep(texts, sources[row]);
      } else {
        slot.setKeepRefs(sources[row]);
      }
    }
    this.refreshHighlight();
    // The kept rows' preview reads the sources, which resolve after the
    // dialog opened — re-kick it.
    this.runner.schedulePreview();
  }

  // -------------------------------------------------------------------------
  // Viewport
  // -------------------------------------------------------------------------

  /** Hand both rows the scene; answers whether a face the user picked was dropped. */
  private setRowScenes(opts: { dropEntities: boolean }): boolean {
    const first = this.panel.first.setScene(this.sceneObjects, opts);
    const second = this.panel.second.setScene(this.sceneObjects, opts);
    return first || second;
  }

  /** Both rows are surface rows: the viewer offers faces, and only faces. */
  private syncChannels(): void {
    if (!this.armed) {
      return;
    }
    applyPickChannels(this.viewer, this.panel.armedSlot.channels());
  }

  /**
   * Light up both rows' picks — a face as itself, a surface whole, a kept
   * argument as what it resolved to — with `preview`, the faces a hovered
   * menu item would add.
   */
  private refreshHighlight(preview: SelectedEntity[] = []): void {
    if (!this.armed) {
      return;
    }
    const entities: SelectedEntity[] = [];
    const wireIds: string[] = [];
    const shapeIds: string[] = [];
    for (const row of ROWS) {
      const lit = this.panel.slot(row).highlight();
      entities.push(...lit.entities);
      wireIds.push(...lit.wireIds);
      shapeIds.push(...lit.shapeIds);
    }
    const all = mergeUniqueEntities(entities, preview);
    if (all.length === 0 && wireIds.length === 0 && shapeIds.length === 0) {
      this.viewer.clearHighlight();
      return;
    }
    this.viewer.highlightEntities(all, wireIds, shapeIds);
  }

  private syncLauncher(): void {
    this.launcher.setActive(this.armed);
    this.launcher.setDisabled(!this.available);
    this.hooks.onActiveChange?.();
  }
}
