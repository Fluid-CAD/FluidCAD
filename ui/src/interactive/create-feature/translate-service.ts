import { Vector3 } from 'three';
import {
  applyTranslate, applyTranslateEdit, FeatureEditTarget, featureGhostScope, fetchFeatureSources, fetchTranslateGhost,
  GhostSolid, ParsedFeatureStatement, SourceSlotRef, TranslateApplyOptions, TranslateEditOptions,
  TranslateEditTargetRef, TranslateGhostRequest, Translation, ValueExpr,
} from '../../api';
import { SceneObjectRender, SubSelection } from '../../types';
import { SelectedEntity, Viewer } from '../../viewer';
import { Navbar } from '../../ui/navbar';
import { VariableInfo } from '../../ui/expression-core';
import { iconUrl } from '../../ui/icon-url';
import { roundToUnitDecimals } from '../../units/units';
import { sceneUnit } from '../../units/scene-unit';
import { EditSession, EditSessionInfo } from '../edit-session';
import { SolidPickSelection } from '../solid-pick';
import type { GizmoAxisTypingContext } from '../gizmo/transform-gizmo';
import type { GizmoExpressionCommit } from '../gizmo/gizmo-value-input';
import { TranslatePanel } from './translate-panel';
import { TranslateGizmo } from './translate-gizmo';
import {
  distanceValue, ghostDistance, isAtRest, TRANSLATE_AXES, TranslateAxis, TranslationStamp,
} from './translate-distances';
import { FeatureButton } from './feature-button';
import { FeatureGhostOverlay } from './feature-ghost';
import { ApplyRunner } from './apply-runner';
import { SketchUISuspender } from './sketch-suspender';
import { refreshScopeVariables } from './option-relabeler';
import { collectSolidTargets, solidTargetForRow, solidTargetForShapeId, SolidTargetOption } from './solid-targets';
import { collectSketchProfiles, sourceChip } from './sketch-profiles';

/** What the seeding hook hands over when the dialog arms. */
export type TranslateEnterSeed = {
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
type TranslateTargetChoice =
  | { kind: 'option'; option: SolidTargetOption }
  | { kind: 'keep'; sourceIndex: number; label: string; loc?: { filePath: string; line: number; column: number } };

/** One ghost answer: the moved bodies, and the distances the server stamped them at. */
type TranslateGhost = { solids: GhostSolid[]; stamp: TranslationStamp };

/** A gizmo gesture in flight: the distances it started from, and how far it has gone. */
type DragState = { start: Vector3; delta: Vector3 };

/** Below this a distance moved nothing along its axis. */
const MOVED_EPSILON = 1e-9;

/** No axis moved: a ghost there would lie exactly on the solids it moves. */
function atRest(translation: Vector3): boolean {
  return TRANSLATE_AXES.every(axis => Math.abs(translation.getComponent(axis)) <= MOVED_EPSILON);
}

const AT_REST_MESSAGE = 'Drag the gizmo, or enter a distance to move the solids by.';

/**
 * The Translate dialog on the create rails — the rotate's straight-line
 * sibling: move one or more solids along the world axes, or leave moved
 * copies behind. The solids are picked in the viewport — any face or edge
 * click selects the owning solid whole (the shared {@link SolidPickSelection}
 * idiom) — or by their timeline rows; arming with a selection already
 * highlighted seeds them. The distances come from the X, Y and Z fields or
 * from the assembly's transform gizmo, which stands at the center of the
 * picked solids, carried by the distances so far: a drag slides the
 * translucent ghost of the moved bodies live and writes the moved distances
 * on release, a click on an arrow types that axis' distance. Apply writes
 * `translate(<x>, <y>, <z>, …)` — the re-render is the preview, editor undo
 * the rollback.
 */
export class TranslateFeatureService {
  private panel: TranslatePanel;
  private button: FeatureButton;
  private armed = false;
  private available = false;
  private targetOptions: SolidTargetOption[] = [];
  /** The chosen targets, in pick order — the translate's argument order. */
  private targets: TranslateTargetChoice[] = [];
  private sceneSketchActive = false;
  private sketchUI: SketchUISuspender;
  /** The shared whole-solid highlight (the target chips' viewport echo). */
  private solidPick: SolidPickSelection;
  /** Statement being edited in place (timeline double-click), or null. */
  private editTarget: FeatureEditTarget | null = null;
  /** The parsed statement the edit dialog opened over (keep-slot texts). */
  private editStatement: Extract<ParsedFeatureStatement, { feature: 'translate' }> | null = null;
  /** View-state half of edit mode: pre-statement rollback + boundary. */
  private session = new EditSession();
  /** A full render arrived mid-session — the statement's sources re-fetch. */
  private editSceneStale = false;
  /**
   * The moved solids the edited statement names, by call site, for the keep
   * chips the parse couldn't address. Null until the query lands (or when it
   * can't answer).
   */
  private sourceTargets: SourceSlotRef[] | null = null;
  private runner: ApplyRunner<TranslateApplyOptions | TranslateEditOptions, TranslateGhost>;
  /** The translucent moved bodies the current translate would place. */
  private ghost: FeatureGhostOverlay;
  /** The distances the drawn ghost was stamped at, or null while none is drawn. */
  private ghostAt: Vector3 | null = null;
  /** The server's reading of the last ghost's distances — see {@link distanceValue}. */
  private stamp: TranslationStamp | null = null;
  /** The variables in scope where the statement lands — the gizmo input's and the arithmetic's. */
  private variables: VariableInfo[] = [];
  private gizmo: TranslateGizmo;
  /** The center of the target solids as they stand — where a zero translation puts the gizmo. */
  private anchor: Vector3 | null = null;
  private drag: DragState | null = null;

  constructor(
    container: HTMLElement,
    private viewer: Viewer,
    private navbar: Navbar,
    private hooks: {
      /** May return the current selection state — it seeds the dialog. */
      onEnter?: () => TranslateEnterSeed | void;
      /** Armed or disarmed — lets the Sketch button owner re-check `isActive`. */
      onActiveChange?: () => void;
      onSuspendSketchUI?: () => void;
      onResumeSketchUI?: () => void;
    } = {},
  ) {
    // Translate joins the transform group beside Mirror and Rotate: the tools
    // that reposition or reflect existing bodies. The group shows while any
    // of them votes visible, and hides while the sketch toolbar owns the bar.
    const group = navbar.getGroup('transform') ?? navbar.addGroup('transform', { visible: false });
    this.button = new FeatureButton(group, {
      icon: iconUrl('translate'),
      label: 'Translate',
      tip: 'Translate solids',
      ariaLabel: 'Translate solids along the world axes',
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
    this.gizmo = new TranslateGizmo(viewer, container, {
      onDragStart: () => this.handleDragStart(),
      onDrag: (delta) => this.handleDrag(delta),
      onCommit: (delta) => this.handleDragCommit(delta),
      onCancel: () => this.handleDragCancel(),
      typingContext: (axis) => this.typingContext(axis),
      onCommitDistance: (axis, commit) => this.commitTypedDistance(axis, commit),
      variables: () => this.variables,
    });

    this.panel = new TranslatePanel(container);
    this.panel.onApply = () => void this.runner.apply();
    this.panel.onExit = () => this.exit();
    this.panel.onChange = () => this.distancesChanged();
    this.panel.onRemoveTarget = (index) => {
      this.targets.splice(index, 1);
      this.panel.setMessage(null);
      this.refresh();
      this.runner.schedulePreview();
    };

    this.runner = new ApplyRunner({
      panel: this.panel,
      session: this.session,
      isArmed: () => this.armed,
      build: () => this.editTarget ? this.buildEditRequest() : this.buildRequest(),
      send: (request, extras) => {
        // At rest there is nothing to write yet — but the ghost still fetches
        // the bodies, so the first drag already slides them.
        if (extras.preview && isAtRest(request.translation)) {
          return Promise.resolve({ success: true });
        }
        return this.editTarget
          ? applyTranslateEdit(this.editTarget, { ...(request as TranslateEditOptions), ...extras })
          : applyTranslate({ ...(request as TranslateApplyOptions), ...extras });
      },
      validateApply: () => {
        const values = this.panel.values();
        return 'error' in values || !isAtRest(values.translation) ? null : { error: AT_REST_MESSAGE };
      },
      onApplied: () => this.exit(this.editTarget ? { editEnd: 'apply' } : { resume: 'lazy' }),
      failMessage: () => this.editTarget ? 'Could not apply the edit.' : 'Could not apply the translate.',
      ghost: {
        fetch: (_request, signal) => this.fetchGhost(signal),
        apply: (drawn) => this.drawGhost(drawn),
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

  /** The armed dialog owns viewport face/edge clicks — each picks a whole solid. */
  get isPicking(): boolean {
    return this.armed;
  }

  /** True while armed picking has suspended sketch editing. */
  get sketchUISuspended(): boolean {
    return this.sketchUI.suspended;
  }

  /**
   * Every render lands here. An open edit session owns the view: it keeps
   * the viewport rolled back to just before the edited statement, and at
   * that boundary the target options rebuild from the pre-statement scene —
   * exactly the solids the translate's arguments can reference.
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
      // Mid-flight to the boundary — whatever the ghost and the gizmo stood
      // on is already gone from the view.
      this.clearGhost();
      this.anchor = null;
      this.syncGizmo();
      if (!isRollback) {
        this.editSceneStale = true;
      }
      return;
    }
    // At the boundary: rebuild options from the pre-statement scene.
    this.clearGhost();
    this.stamp = null;
    this.targetOptions = collectSolidTargets(sceneObjects);
    if (this.editSceneStale) {
      // A scene rebuild may have moved what the kept chips name — re-fetch
      // the statement's own sources.
      this.editSceneStale = false;
      this.sourceTargets = null;
    }
    // Picked targets re-match by source line. A keep that resolved to a
    // solid statement becomes that statement's option — proper label,
    // create-mode toggling; unresolved keeps stay text-addressed verbatim.
    this.targets = this.targets.flatMap((target): TranslateTargetChoice[] => {
      if (target.kind === 'keep') {
        const match = target.loc && this.targetOptions.find(o =>
          o.filePath === target.loc!.filePath && o.line === target.loc!.line);
        return match ? [{ kind: 'option', option: match }] : [target];
      }
      const match = this.targetOptions.find(o =>
        o.filePath === target.option.filePath && o.line === target.option.line);
      return match ? [{ kind: 'option', option: match }] : [];
    });
    if (!this.sourceTargets) {
      void this.loadEditSources();
    }
    this.syncViewport();
    this.refresh();
    this.runner.schedulePreview();
  }

  update(sceneObjects: SceneObjectRender[]): void {
    this.targetOptions = collectSolidTargets(sceneObjects);
    this.sceneSketchActive = collectSketchProfiles(sceneObjects)[0]?.kind === 'active';
    this.available = this.targetOptions.length > 0;
    this.navbar.setGroupVisible('transform', this.available, 'translate');
    this.button.setVisible(this.available);
    this.syncButton();
    if (!this.armed) {
      return;
    }
    if (!this.available) {
      this.exit({ resume: 'lazy' });
      return;
    }
    // The geometry under the ghost just changed, and so may the values its
    // distances name — drop both now and let the debounce redraw them.
    this.clearGhost();
    this.stamp = null;
    // A render can put a sketch back in front (live editing) — the armed
    // dialog keeps the free 3D view.
    if (this.sceneSketchActive) {
      this.sketchUI.suspend();
    }
    // Chosen targets re-match against the fresh options by source line.
    this.targets = this.targets.flatMap((target): TranslateTargetChoice[] => {
      if (target.kind === 'keep') {
        return [target];
      }
      const match = this.targetOptions.find(o =>
        o.filePath === target.option.filePath && o.line === target.option.line);
      return match ? [{ kind: 'option', option: match }] : [];
    });
    this.syncViewport();
    this.refresh();
    this.runner.schedulePreview();
  }

  /**
   * Open the dialog over an existing translate statement (timeline
   * double-click). The session rolls the viewport back to just before the
   * statement — the world its arguments see, where the solids it moves stand
   * unmoved and pickable. The distances and the copy flag prefill the form;
   * the targets slot starts on one kept chip per statement target, toggled
   * and re-picked like create mode. Apply rewrites the statement in place.
   */
  enterEdit(
    target: FeatureEditTarget,
    parsed: Extract<ParsedFeatureStatement, { feature: 'translate' }>,
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
    this.sourceTargets = null;
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
    this.panel.showEdit({ mode: parsed.copy ? 'copy' : 'move', translation: parsed.translation });
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
    // Composing a translate means looking at the whole scene, not down the
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
    this.syncViewport();
    this.refresh();
    this.runner.schedulePreview();
  }

  /**
   * Arm the dialog around whatever was already selected: every selected
   * face/edge resolves to its owning solid, and the distinct solids open as
   * the initial target chips.
   */
  private seedFromSelection({ seed }: TranslateEnterSeed): void {
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
  exit(opts: { resume?: 'immediate' | 'lazy'; editEnd?: 'apply' | 'cancel' | 'continue' | 'handoff' | 'gone' } = {}): void {
    if (!this.armed) {
      return;
    }
    const hadSession = this.session.active;
    this.session.end(opts.editEnd ?? 'cancel');
    if (hadSession) {
      opts = { ...opts, resume: 'lazy' };
    }
    this.armed = false;
    // Disarmed first: taking the gizmo down cancels a gesture in flight,
    // whose callback must find nothing left to re-sync.
    this.gizmo.hide();
    this.drag = null;
    this.anchor = null;
    this.editTarget = null;
    this.editStatement = null;
    this.editSceneStale = false;
    this.sourceTargets = null;
    this.stamp = null;
    this.variables = [];
    this.targets = [];
    this.solidPick.set([]);
    this.runner.cancelPreview();
    this.clearGhost();
    this.viewer.clearHighlight();
    this.viewer.pickFilter = 'all';
    this.syncButton();
    this.panel.hide();
    this.sketchUI.resume((opts.resume ?? 'immediate') === 'immediate');
  }

  /**
   * Routes viewer clicks while the dialog is armed: any face or edge click
   * selects the owning solid whole (clicking one of its faces again clears
   * it back). Empty-space clicks keep the selection; the gizmo's own
   * gestures never reach here.
   */
  handleClick(shapeId: string | null, sub: SubSelection): void {
    if (!this.armed || !shapeId || !sub) {
      return;
    }
    if (sub.type !== 'face' && sub.type !== 'edge') {
      return;
    }
    const option = solidTargetForShapeId(shapeId, this.targetOptions);
    if (!option) {
      this.panel.setMessage('That shape cannot be translated — pick a solid.');
      return;
    }
    this.toggleTarget(option);
  }

  /**
   * A timeline row was clicked while the dialog is armed: a solid row
   * toggles it in the targets list. Every row is consumed so the default
   * rollback can't close the dialog mid-flow.
   */
  handleTimelinePick(obj: SceneObjectRender): boolean {
    if (!this.armed) {
      return false;
    }
    const option = solidTargetForRow(obj, this.targetOptions);
    if (!option) {
      this.panel.setMessage('That row has no solid to translate — pick a solid-producing feature.');
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
    this.panel.setMessage(null);
    this.refresh();
    this.runner.schedulePreview();
  }

  private async refreshScopeVariables(): Promise<void> {
    const line = this.editTarget?.line ?? null;
    await refreshScopeVariables(line, {
      setScopeVariables: (variables) => {
        this.variables = variables;
        this.panel.setScopeVariables(variables);
        // A name the arithmetic couldn't read before may read now.
        this.syncGizmo();
        this.syncGhost();
      },
    }, () => this.armed && (this.editTarget?.line ?? null) === line);
  }

  /**
   * The edited statement's own sources, resolved against the pre-statement
   * scene: what its kept chips actually name. Only the ghost and the gizmo
   * read them — the apply rewrites a keep verbatim — so a query that can't
   * answer costs a preview, never a correct statement.
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
    this.sourceTargets = result.ok && result.feature === 'translate' ? result.targets : [];
    // `enterEdit` already scheduled its preview — re-kick now that the
    // statement's own sources are known, and re-anchor the gizmo on them.
    this.refreshAnchor();
    this.runner.schedulePreview();
  }

  // -------------------------------------------------------------------------
  // Distances: fields, gizmo, ghost
  // -------------------------------------------------------------------------

  /** The form changed (typing, a tab, a gizmo commit): re-place everything and re-preview. */
  private distancesChanged(): void {
    this.panel.setMessage(null);
    this.syncGhost();
    this.syncGizmo();
    this.runner.schedulePreview();
  }

  /**
   * The distances the dialog stands for right now, as a vector: mid-gesture
   * where the drag has carried them, otherwise the fields read through
   * {@link distanceValue}. Null while any of the three can't be read.
   */
  private liveTranslation(): Vector3 | null {
    return this.drag ? this.drag.start.clone().add(this.drag.delta) : this.fieldTranslation();
  }

  private fieldTranslation(): Vector3 | null {
    const values: number[] = [];
    for (const axis of TRANSLATE_AXES) {
      const read = this.panel.distanceRead(axis);
      const value = read && distanceValue(read, axis, this.variables, this.stamp);
      if (value === null) {
        return null;
      }
      values.push(value);
    }
    return new Vector3(values[0], values[1], values[2]);
  }

  /**
   * Stand the gizmo where the moved solids land — their center, carried by
   * the distances. Down while there is no solid to stand on, or no number
   * the distances can be read as.
   */
  private syncGizmo(): void {
    const live = this.armed && this.anchor ? this.liveTranslation() : null;
    if (!live) {
      this.gizmo.hide();
      return;
    }
    this.gizmo.place(live.add(this.anchor!));
  }

  /**
   * Slide the drawn ghost from the distances it was stamped at to the live
   * ones — exact, a translation being rigid — so a drag or a typed number
   * moves it at once, ahead of the debounced refetch. At rest the stamp lies
   * exactly on the solids it moves, and there is nothing to show.
   */
  private syncGhost(): void {
    if (!this.ghostAt) {
      return;
    }
    const live = this.liveTranslation();
    this.ghost.place(live && !atRest(live) ? live.sub(this.ghostAt) : null);
  }

  private drawGhost(drawn: TranslateGhost | null): void {
    if (!drawn) {
      this.clearGhost();
      return;
    }
    this.ghost.set(drawn.solids, 'add');
    this.ghostAt = new Vector3(...drawn.stamp.values);
    this.stamp = drawn.stamp;
    this.syncGhost();
    // The server may have read a distance the client's arithmetic couldn't.
    this.syncGizmo();
  }

  private clearGhost(): void {
    this.ghost.clear();
    this.ghostAt = null;
  }

  /** Re-center the gizmo's base on the solids being moved, as they stand. */
  private refreshAnchor(): void {
    const locations = this.targetLocations() ?? [];
    const shapeIds = this.targetOptions
      .filter(o => locations.some(loc => loc.filePath === o.filePath && loc.line === o.line))
      .flatMap(o => o.shapeIds);
    this.anchor = this.viewer.shapeBounds(shapeIds)?.getCenter(new Vector3()) ?? null;
    this.syncGizmo();
  }

  private handleDragStart(): boolean {
    const start = this.fieldTranslation();
    if (!start) {
      this.panel.setMessage('Fix the distances first — the gizmo moves on from them.');
      return false;
    }
    this.drag = { start, delta: new Vector3() };
    return true;
  }

  private handleDrag(delta: Vector3): void {
    if (!this.drag) {
      return;
    }
    this.drag.delta.copy(delta);
    this.syncGhost();
    this.syncGizmo();
  }

  /**
   * The gesture landed: every axis it moved along takes its new distance,
   * rounded to the document unit's precision; an axis it left alone keeps its
   * text — an expression included. A length typed into the input without a
   * drag (the click-to-type fallback) moves on from the fields as they stand.
   */
  private handleDragCommit(delta: Vector3): void {
    const start = this.drag?.start ?? this.fieldTranslation();
    this.drag = null;
    if (start) {
      for (const axis of TRANSLATE_AXES) {
        const moved = delta.getComponent(axis);
        if (Math.abs(moved) > MOVED_EPSILON) {
          this.panel.setDistance(axis, roundToUnitDecimals(start.getComponent(axis) + moved, sceneUnit.current));
        }
      }
    }
    this.distancesChanged();
  }

  private handleDragCancel(): void {
    this.drag = null;
    if (this.armed) {
      this.syncGhost();
      this.syncGizmo();
    }
  }

  /**
   * A clicked arrow's input opens on that axis' distance, seeded with the
   * field's own expression when it holds one rather than a number.
   */
  private typingContext(axis: TranslateAxis): GizmoAxisTypingContext | null {
    const live = this.fieldTranslation();
    if (!live) {
      return null;
    }
    const read = this.panel.distanceRead(axis);
    return {
      value: live.getComponent(axis),
      sourceExpression: typeof read?.value === 'string' ? Promise.resolve(read.value) : undefined,
    };
  }

  /**
   * A distance typed into the gizmo's input lands in its field, declaration
   * and all. The input opened on the field's own text: committed back
   * unchanged, it keeps the declaration the field carries — a `gap = 20`
   * not yet written stays declared.
   */
  private commitTypedDistance(axis: TranslateAxis, commit: GizmoExpressionCommit): void {
    const read = this.panel.distanceRead(axis);
    const newVariable = commit.newVariable
      ?? (read?.value === commit.expression ? read.newVariable : undefined);
    this.panel.setDistanceCommitted(axis, commit.expression, newVariable);
    this.distancesChanged();
  }

  // -------------------------------------------------------------------------
  // Live geometry ("ghost") and the requests
  // -------------------------------------------------------------------------

  /**
   * The live geometry for the current form state: each target solid's own
   * body, stamped under the translation the apply itself would produce — at
   * rest too, so the first drag has bodies to slide. Both dialogs hand the
   * server explicit refs, so the endpoint never has to know which mode asked.
   */
  private async fetchGhost(signal: AbortSignal): Promise<TranslateGhost | null> {
    const targets = this.targetLocations();
    const translation = this.ghostTranslation();
    if (!targets || !translation) {
      return null;
    }
    const request: TranslateGhostRequest = {
      feature: 'translate',
      targets,
      translation,
      exclude: this.editTarget
        ? { filePath: this.editTarget.filePath, line: this.editTarget.line }
        : undefined,
    };
    const result = await fetchTranslateGhost(request, featureGhostScope(this.editTarget), signal);
    return result && { solids: result.solids, stamp: { exprs: translation, values: result.translation } };
  }

  /** The distance fields as the ghost reads them (see {@link ghostDistance}); null while one can't travel. */
  private ghostTranslation(): Translation | null {
    const values: ValueExpr[] = [];
    for (const axis of TRANSLATE_AXES) {
      const read = this.panel.distanceRead(axis);
      const value = read && ghostDistance(read, this.variables);
      if (value === null) {
        return null;
      }
      values.push(value);
    }
    return values as Translation;
  }

  /**
   * The solids being moved, by call site. A kept chip travels as the
   * statement its expression named, or — for one the parse couldn't address
   * — as whatever the sources query resolved that argument to. A target
   * neither could place means none at all: a translate missing one of its
   * bodies is a different translate, not a partial one.
   *
   * An implicit translate (no target arguments at all) moves every object
   * active at its own line, which in an edit session's rolled-back scene is
   * exactly the statements the targets slot is offering.
   */
  private targetLocations(): { filePath: string; line: number }[] | null {
    if (this.targets.length === 0) {
      if (!this.editTarget || (this.editStatement?.targetTexts.length ?? 0) > 0) {
        return null;
      }
      const implicit = this.targetOptions.map(o => ({ filePath: o.filePath, line: o.line }));
      return implicit.length > 0 ? implicit : null;
    }
    const refs: { filePath: string; line: number }[] = [];
    for (const target of this.targets) {
      const slot = target.kind === 'keep' ? this.sourceTargets?.[target.sourceIndex] : undefined;
      const loc = target.kind === 'option'
        ? target.option
        : target.loc ?? (slot?.kind === 'sketch' ? slot : null);
      if (!loc) {
        return null;
      }
      refs.push({ filePath: loc.filePath, line: loc.line });
    }
    return refs;
  }

  private buildRequest(): TranslateApplyOptions | { error: string } {
    const values = this.panel.values();
    if ('error' in values) {
      return values;
    }
    if (this.targets.length === 0) {
      return { error: 'Pick the solids to translate in the viewport first.' };
    }
    // Create mode never carries keep entries — every chip is a picked solid.
    const targets = this.targets.flatMap(t => t.kind === 'option'
      ? [{ filePath: t.option.filePath, line: t.option.line, column: t.option.column }]
      : []);
    return {
      targets,
      translation: values.translation,
      copy: values.mode === 'copy',
      newVariables: values.newVariables,
    };
  }

  /**
   * The edit-mode apply payload: the target list mixes kept statement
   * targets with re-picked solids (an untouched implicit translate keeps
   * moving every active object). No pick needs synthesizing, so no boundary
   * rides along.
   */
  private buildEditRequest(): TranslateEditOptions | { error: string } {
    const values = this.panel.values();
    if ('error' in values) {
      return values;
    }
    // An originally implicit translate stays implicit while the targets slot
    // is untouched; explicit targets can be re-picked but never all removed.
    let targets: TranslateEditTargetRef[] | undefined;
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
      return { error: 'Pick the solids to translate in the viewport first.' };
    }
    return {
      translation: values.translation,
      copy: values.mode === 'copy',
      targets,
      newVariables: values.newVariables,
      expectedStatement: this.session.expectedStatement,
    };
  }

  // -------------------------------------------------------------------------
  // Viewport reflection
  // -------------------------------------------------------------------------

  /** Face and edge clicks pick whole solids; nothing else is a pick target here. */
  private syncViewport(): void {
    if (!this.armed) {
      return;
    }
    this.viewer.pickSketchWires = false;
    this.viewer.pickAxes = false;
    this.viewer.pickPlanes = false;
    this.viewer.pickFilter = 'all';
  }

  /** Repaint the target chips, their viewport highlight, and the gizmo's base. */
  private refresh(): void {
    if (!this.armed) {
      return;
    }
    this.panel.setTargets(this.targets.map(target => target.kind === 'keep'
      ? { label: `Current: ${target.label}`, removable: true }
      : sourceChip(target.option, { removable: true })));
    this.solidPick.set(this.targets.flatMap(t => t.kind === 'option' ? t.option.shapeIds : []));
    this.solidPick.refreshHighlight();
    this.refreshAnchor();
  }

  private syncButton(): void {
    this.button.setActive(this.armed);
    // Every armed flip lands here — the Sketch button disables while a
    // create dialog is up.
    this.hooks.onActiveChange?.();
  }
}
