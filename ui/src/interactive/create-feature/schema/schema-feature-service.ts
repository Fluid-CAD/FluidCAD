import {
  applyCustomFeature, applyCustomFeatureEdit, fetchFeatureSources,
  type CustomFeatureApplyOptions, type CustomFeatureEditOptions, type CustomPickInput, type FeatureEditTarget,
  type FeatureScalarValue, type NewVariable, type ParsedFeatureStatement, type ScopeTargetRef, type ValueExpr,
} from '../../../api';
import type { StandardAxisId } from '../../../scene/standard-axes';
import type { StandardPlaneId } from '../../../scene/standard-planes';
import type { SceneObjectRender, SourceLocation, SubSelection } from '../../../types';
import type { Navbar } from '../../../ui/navbar';
import type { Viewer } from '../../../viewer';
import { EditSession } from '../../edit-session';
import type {
  FeatureDialogExit, FeatureDialogService, FeatureEditInfo, ParsedFeatureKind,
} from '../../feature-dialog-registry';
import { ApplyRunner } from '../apply-runner';
import { FeatureButton } from '../feature-button';
import { refreshScopeVariables } from '../option-relabeler';
import { enclosingPartLocOf, scopePartLocation, ScopeTargetList } from '../scope-targets';
import { collectSketchProfiles } from '../sketch-profiles';
import { SketchUISuspender } from '../sketch-suspender';
import { FeatureSchema } from './feature-schema';
import { SchemaFeaturePanel } from './schema-feature-panel';
import {
  NO_CHANNELS, PickHighlight, SCOPE_CHANNELS, type PickOutcome, type PickerScene, type SchemaPicker,
} from './schema-pickers';

type ParsedCustomFeature = Extract<ParsedFeatureStatement, { feature: 'custom' }>;

type CreateRequest = Omit<CustomFeatureApplyOptions, 'preview' | 'signal'>;
type EditRequest = Omit<CustomFeatureEditOptions, 'preview' | 'signal'>;

/** The hooks every part-mode dialog takes from the page. */
export type SchemaFeatureHooks = {
  onEnter?: () => void;
  /** Armed or disarmed — the Sketch button owner re-checks. */
  onActiveChange?: () => void;
  onSuspendSketchUI?: () => void;
  onResumeSketchUI?: () => void;
};

/**
 * The dialog of one custom feature, built from its metadata: a toolbar
 * button in the feature's group, the schema dialog, and the create and
 * timeline-edit flows every built-in dialog has — registered with the page's
 * {@link FeatureDialogRegistry} like them.
 *
 * Picks route to the armed slot (the viewer offers only what that slot
 * takes); timeline rows route to the slot that takes their kind, whichever
 * is armed. Apply writes the builder's call through the feature's call
 * shape — the values the user set, the picks, the operation and its scope —
 * and an edit rewrites only what the user changed. The re-render is the
 * preview, editor undo the rollback.
 */
export class SchemaFeatureService implements FeatureDialogService {
  readonly id: string;
  readonly editRowTypes: readonly string[];
  readonly parsedFeatures: readonly ParsedFeatureKind[] = ['custom'];
  readonly blocksSketchButton = true;
  readonly pinsSketchToolbar: boolean;
  readonly toolbarButton: FeatureButton | null;

  private readonly panel: SchemaFeaturePanel;
  private readonly button: FeatureButton;
  private readonly sketchUI: SketchUISuspender;
  private readonly runner: ApplyRunner<CreateRequest | EditRequest>;
  private readonly scope = new ScopeTargetList();
  private armed = false;
  private sceneObjects: SceneObjectRender[];
  private sceneSketchActive = false;
  /** Statement being edited in place (timeline double-click or Edit feature), or null. */
  private editTarget: FeatureEditTarget | null = null;
  /** The statement the edit opened over. */
  private parsed: ParsedCustomFeature | null = null;
  /** View-state half of edit mode: pre-statement rollback + boundary. */
  private readonly session = new EditSession();
  /** The edited statement's sources arrived (or can't). */
  private sourcesLoaded = false;
  /** A full render arrived mid-session — re-picked shape ids died. */
  private editSceneStale = false;
  /** The scope row was changed in this edit. */
  private scopeTouched = false;

  constructor(
    container: HTMLElement,
    private readonly viewer: Viewer,
    private readonly navbar: Navbar,
    readonly schema: FeatureSchema,
    iconSrc: string,
    private readonly hooks: SchemaFeatureHooks = {},
  ) {
    this.id = SchemaFeatureService.dialogId(schema.id);
    this.editRowTypes = [schema.id];
    this.sceneObjects = viewer.currentSceneObjects ?? [];
    // A feature that takes a sketch can finish one: the sketch toolbar stays
    // up while it is armed from an active sketch, as for Extrude.
    this.pinsSketchToolbar = schema.pickerNames.some(name => (schema.param(name) as { picker: string }).picker === 'sketch');

    const groupKey = schema.meta.group === 'modify' ? 'modify' : 'create';
    const group = navbar.getGroup(groupKey)
      ?? navbar.addGroup(groupKey, groupKey === 'create' ? { visible: false, immune: true } : { visible: false });
    const tip = schema.meta.description ? `${schema.label} — ${schema.meta.description}` : schema.label;
    this.button = new FeatureButton(group, {
      icon: iconSrc,
      label: schema.label,
      tip,
      ariaLabel: tip,
      datasetTool: `feature:${schema.id}`,
    });
    this.button.onClick = () => {
      if (this.armed) {
        this.exit();
      } else {
        this.enter();
      }
    };
    // Create-group buttons leave the bar while a sketch is up; the modify
    // group hides wholesale then.
    this.toolbarButton = groupKey === 'create' ? this.button : null;
    if (groupKey === 'create') {
      navbar.setGroupVisible('create', true, this.id);
    }
    this.sketchUI = new SketchUISuspender(viewer, hooks);

    this.panel = new SchemaFeaturePanel(container, schema, iconSrc);
    this.panel.onApply = () => void this.runner.apply();
    this.panel.onExit = () => this.exit();
    this.panel.onChange = () => {
      this.panel.setMessage(null);
      this.refreshHighlight();
      this.runner.schedulePreview();
    };
    this.panel.onArmedSlotChange = () => this.syncViewport();
    this.panel.onOperationChange = () => {
      if (this.panel.operation === 'new' && !this.scope.isEmpty) {
        this.scope.clear();
        this.scopeTouched = true;
        this.refreshScope();
      }
    };
    this.panel.onScopeRemove = (index) => {
      this.scope.removeAt(index);
      this.scopeTouched = true;
      this.refreshScope();
      this.runner.schedulePreview();
    };
    for (const picker of this.panel.pickers.values()) {
      picker.onChange = () => {
        this.panel.setMessage(null);
        this.refreshHighlight();
        this.runner.schedulePreview();
      };
    }

    this.runner = new ApplyRunner<CreateRequest | EditRequest>({
      panel: this.panel,
      isArmed: () => this.armed,
      build: () => this.editTarget ? this.buildEditRequest() : this.buildRequest(),
      send: (request, extras) => this.editTarget
        ? applyCustomFeatureEdit(this.editTarget, { ...(request as EditRequest), ...extras })
        : applyCustomFeature({ ...(request as CreateRequest), ...extras }),
      onApplied: () => this.exit(this.editTarget ? { editEnd: 'apply' } : { resume: 'lazy' }),
      failMessage: () => this.editTarget ? 'Could not apply the edit.' : `Could not apply the ${schema.label.toLowerCase()}.`,
    });
  }

  /** The registry id of a feature's dialog. */
  static dialogId(featureId: string): string {
    return `feature:${featureId}`;
  }

  get isActive(): boolean {
    return this.armed;
  }

  get isEditing(): boolean {
    return this.editTarget !== null;
  }

  /** The armed dialog owns viewport clicks; which ones arrive follows the armed slot. */
  get isPicking(): boolean {
    return this.armed;
  }

  get sketchUISuspended(): boolean {
    return this.sketchUI.suspended;
  }

  /** The dialog's panel, for the tests to drive. */
  get dialogPanel(): SchemaFeaturePanel {
    return this.panel;
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  enter(): void {
    if (this.armed) {
      return;
    }
    this.session.end('continue');
    this.hooks.onEnter?.();
    this.armed = true;
    this.editTarget = null;
    this.parsed = null;
    this.scope.clear();
    this.scopeTouched = false;
    if (this.sceneSketchActive) {
      this.sketchUI.suspend();
    }
    this.syncButton();
    this.applyScene({ dropEntities: true });
    void this.refreshScopeVariables();
    this.panel.show();
    this.panel.setMessage(this.unpickableMessage());
    this.syncViewport();
    this.refreshScope();
    this.runner.schedulePreview();
  }

  /**
   * Open over an existing statement of this feature (a timeline double-click
   * or the row's Edit feature). The session rolls the viewport back to just
   * before the statement — the world its arguments see — and every value
   * opens on the statement's own: typed-in values in their rows, picks as
   * kept chips, the operation and its scope. Apply rewrites what changed.
   */
  enterEdit(target: FeatureEditTarget, parsed: ParsedFeatureStatement, info: FeatureEditInfo): void {
    if (parsed.feature !== 'custom' || parsed.id !== this.schema.id) {
      return;
    }
    if (this.armed) {
      this.exit();
    }
    this.hooks.onEnter?.();
    this.armed = true;
    this.editTarget = target;
    this.parsed = parsed;
    this.sourcesLoaded = false;
    this.editSceneStale = false;
    this.scopeTouched = false;
    this.scope.seedKeeps(parsed, target.filePath);
    this.syncButton();
    this.sketchUI.suspend();
    this.session.begin({ ...info, target });
    void this.loadEditSources();
    void this.refreshScopeVariables();
    this.panel.showEdit({
      values: parsed.values as Record<string, FeatureScalarValue>,
      operation: parsed.operation,
      seedPicks: (picker) => picker.seedKeeps(parsed.picks[picker.name], target.filePath),
    });
    this.panel.setMessage(null);
    this.syncViewport();
    this.refreshScope();
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
    this.editSceneStale = false;
    this.scope.clear();
    this.runner.cancelPreview();
    this.viewer.clearHighlight();
    this.viewer.setSelectedStandardAxes([]);
    this.viewer.hideStandardAxes();
    this.viewer.hideStandardPlanes();
    this.viewer.pickFilter = 'all';
    this.viewer.pickSketchWires = false;
    this.viewer.pickAxes = false;
    // pickPlanes is left alone: syncButton's onActiveChange runs the modify
    // service's neutral-mode restore, which owns that channel.
    this.syncButton();
    this.panel.hide();
    this.sketchUI.resume((opts.resume ?? 'immediate') === 'immediate');
  }

  /** Take the dialog and its button off the page — its feature changed or left the catalog. */
  destroy(): void {
    this.exit({ resume: 'lazy' });
    this.navbar.setGroupVisible('create', false, this.id);
    this.button.remove();
    this.panel.destroy();
  }

  /**
   * Every render lands here. An open edit session keeps the viewport rolled
   * back to just before the edited statement and re-resolves the picks at
   * that boundary; without one, the statements re-match and raw face and
   * edge picks drop, since their ids died with the render.
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
    this.sceneObjects = sceneObjects;
    const stale = this.editSceneStale;
    this.editSceneStale = false;
    const dropped = this.applyScene({ dropEntities: stale });
    if (stale) {
      this.sourcesLoaded = false;
      if (dropped) {
        this.panel.setMessage('The code changed — the re-picked geometry was reset.');
      }
    }
    if (!this.sourcesLoaded) {
      void this.loadEditSources();
    }
    this.syncViewport();
    this.refreshScope();
    this.runner.schedulePreview();
  }

  update(sceneObjects: SceneObjectRender[]): void {
    this.sceneObjects = sceneObjects;
    this.sceneSketchActive = collectSketchProfiles(sceneObjects)[0]?.kind === 'active';
    this.syncButton();
    if (!this.armed) {
      return;
    }
    // A render can put a sketch back in front (live editing) — the armed
    // dialog keeps the free 3D view.
    if (this.sceneSketchActive) {
      this.sketchUI.suspend();
    }
    this.applyScene({ dropEntities: true });
    this.syncViewport();
    this.refreshScope();
    this.runner.schedulePreview();
  }

  // -------------------------------------------------------------------------
  // Pick channels
  // -------------------------------------------------------------------------

  /** A face or edge click: the armed slot's, or the armed scope row's solid. */
  handleClick(shapeId: string | null, sub: SubSelection): boolean {
    if (!this.armed) {
      return false;
    }
    if (!shapeId || !sub) {
      return true;
    }
    if (this.panel.armedSlot === 'scope') {
      const option = this.scope.optionForShapeId(shapeId);
      if (!option) {
        this.panel.setMessage('That shape cannot scope the operation — pick a solid of this part.');
        return true;
      }
      this.scope.toggle(option);
      this.scopeChanged();
      return true;
    }
    const picker = this.panel.armedPicker;
    if (picker) {
      this.land(picker, picker.takeClick(shapeId, sub));
    }
    return true;
  }

  /**
   * A timeline row: the armed slot takes it when it takes that kind of row,
   * else the first value that does (a sketch row goes to the sketch value
   * whichever slot is armed), else the scope row a solid. Every row is
   * consumed while the dialog is armed, so a click can't roll the view back
   * under it.
   */
  handleTimelinePick(obj: SceneObjectRender): boolean {
    if (!this.armed) {
      return false;
    }
    const armed = this.panel.armedPicker;
    const order = [
      ...(armed ? [armed] : []),
      ...[...this.panel.pickers.values()].filter(p => p !== armed && p.visible && p.offered),
    ];
    for (const picker of order) {
      const outcome = picker.takeRow(obj);
      if (outcome !== 'ignored') {
        this.land(picker, outcome);
        return true;
      }
    }
    if (this.panel.scopeSlot?.visible) {
      const option = this.scope.optionForRow(obj);
      if (option) {
        this.scope.toggle(option);
        this.panel.armSlot('scope');
        this.scopeChanged();
        return true;
      }
    }
    this.panel.setMessage(`${obj.name ?? 'That row'} is not something ${this.schema.label} takes.`);
    return true;
  }

  /** A sketch wire clicked: the armed sketch value takes its sketch. */
  handleSketchPick(shapeId: string): boolean {
    const picker = this.armed ? this.panel.armedPicker : null;
    if (!picker) {
      return false;
    }
    const outcome = picker.takeSketchWire(shapeId);
    if (outcome === 'ignored') {
      return false;
    }
    this.land(picker, outcome);
    return true;
  }

  /** An `axis()` line clicked while an axis value is armed. */
  handleAxisPick(shapeId: string | null): boolean {
    const picker = this.armed ? this.panel.armedPicker : null;
    if (!picker || picker.kind !== 'axis') {
      return false;
    }
    if (shapeId) {
      this.land(picker, picker.takeAxisLine(shapeId));
    }
    return true;
  }

  /** A `plane()` quad clicked while a plane value is armed. */
  handlePlanePick(shapeId: string): boolean {
    const picker = this.armed ? this.panel.armedPicker : null;
    if (!picker || picker.kind !== 'plane') {
      return false;
    }
    this.land(picker, picker.takePlaneQuad(shapeId));
    return true;
  }

  /** A shown world axis or origin plane clicked. */
  private readonly onStandardPick = (name: StandardAxisId | StandardPlaneId): void => {
    const picker = this.armed ? this.panel.armedPicker : null;
    if (picker) {
      this.land(picker, picker.takeStandard(name));
    }
  };

  /** What a picker answered: the pick lands (and a filled single value hands the armed state on), or its refusal shows. */
  private land(picker: SchemaPicker, outcome: PickOutcome): void {
    if (outcome === 'ignored') {
      return;
    }
    if (outcome !== 'taken') {
      this.panel.setMessage(outcome.message);
      return;
    }
    this.panel.setMessage(null);
    if (this.panel.armedSlot !== picker.name) {
      this.panel.armSlot(picker.name);
    }
    if (!picker.isList && !picker.isEmpty) {
      this.panel.advanceFrom(picker.name);
    }
    this.refreshHighlight();
    this.runner.schedulePreview();
  }

  private scopeChanged(): void {
    this.scopeTouched = true;
    this.panel.setMessage(null);
    this.refreshScope();
    this.runner.schedulePreview();
  }

  // -------------------------------------------------------------------------
  // Requests
  // -------------------------------------------------------------------------

  /** The create request for the current form, or the message blocking it. */
  private buildRequest(): CreateRequest | { error: string } {
    const unpickable = this.unpickableMessage();
    if (unpickable) {
      return { error: unpickable };
    }
    const values = this.collectValues(false);
    if ('error' in values) {
      return values;
    }
    const picks = this.collectPicks();
    if ('error' in picks) {
      return picks;
    }
    const operation = this.panel.operation;
    return {
      id: this.schema.id,
      values: values.values,
      picks: picks.picks,
      ...(operation && operation !== 'add' ? { operation } : {}),
      ...(operation !== 'new' && !this.scope.isEmpty ? { scope: this.scope.createRefs() } : {}),
      ...(values.newVariables ? { newVariables: values.newVariables } : {}),
    };
  }

  /**
   * The edit request: only what changed. A value the user didn't touch, a
   * pick still on the statement's own elements, an unchanged operation or
   * scope is left out, so the statement keeps its own text there.
   */
  private buildEditRequest(): EditRequest | { error: string } {
    const values = this.collectValues(true);
    if ('error' in values) {
      return values;
    }
    const picks = this.collectPicks();
    if ('error' in picks) {
      return picks;
    }
    const operation = this.panel.operation;
    const parsed = this.parsed!;
    let scope: ScopeTargetRef[] | undefined;
    if (operation === 'new') {
      // A separate body has no boolean to narrow: its scope goes.
      scope = parsed.scopeTexts.length > 0 ? [] : undefined;
    } else if (this.scopeTouched) {
      scope = this.scope.editRefs();
    }
    const repicked = [...this.panel.pickers.values()].some(p => p.visible && p.touched && p.hasPickedGeometry);
    return {
      id: this.schema.id,
      values: values.values,
      picks: picks.picks,
      ...(operation && operation !== parsed.operation ? { operation } : {}),
      ...(scope !== undefined ? { scope } : {}),
      ...(values.newVariables ? { newVariables: values.newVariables } : {}),
      expectedStatement: this.session.expectedStatement,
      before: repicked ? this.session.boundary ?? undefined : undefined,
    };
  }

  /**
   * The typed-in values to write: the shown rows the user changed. A create
   * leaves an untouched row's value to the builder's default (and refuses a
   * required one never filled in); an edit keeps the statement's own, and a
   * cleared row drops its value when the builder has something to fall back on.
   */
  private collectValues(editing: boolean): {
    values: Record<string, ValueExpr | boolean | string | null>;
    newVariables?: NewVariable[];
  } | { error: string } {
    const values: Record<string, ValueExpr | boolean | string | null> = {};
    const newVariables: NewVariable[] = [];
    for (const [name, field] of this.panel.fields) {
      if (!field.visible) {
        continue;
      }
      const label = this.schema.param(name).label;
      if (!field.dirty) {
        if (!editing && this.schema.required(name)) {
          return { error: `Enter ${label}.` };
        }
        continue;
      }
      const read = field.read();
      if ('error' in read) {
        return read;
      }
      if ('empty' in read) {
        if (this.schema.required(name)) {
          return { error: `Enter ${label}.` };
        }
        if (editing) {
          values[name] = null;
        }
        continue;
      }
      values[name] = read.value;
      if (read.newVariable && !newVariables.some(v => v.name === read.newVariable!.name)) {
        newVariables.push(read.newVariable);
      }
    }
    return newVariables.length > 0 ? { values, newVariables } : { values };
  }

  /** The picked values to write, or the message blocking the apply. */
  private collectPicks(): { picks: Record<string, CustomPickInput[]> } | { error: string } {
    const picks: Record<string, CustomPickInput[]> = {};
    for (const [name, picker] of this.panel.pickers) {
      if (!picker.visible) {
        continue;
      }
      const request = picker.request();
      if (request === undefined) {
        continue;
      }
      if ('error' in request) {
        return request;
      }
      picks[name] = request;
    }
    return { picks };
  }

  /** A required value the dialog cannot pick yet, as the message the dialog shows. */
  private unpickableMessage(): string | null {
    const labels = this.schema.unpickableRequired();
    if (labels.length === 0) {
      return null;
    }
    return `${labels.join(', ')} can't be picked in the dialog yet — write the ${this.schema.label.toLowerCase()} statement in the code.`;
  }

  // -------------------------------------------------------------------------
  // Scene and viewport
  // -------------------------------------------------------------------------

  /**
   * Hand the current scene to every pick slot and the scope list: the part
   * a statement written now lands in decides which solids and features it
   * can reference — the edited statement's own part, or (a create) the
   * active part. Answers whether a pick was dropped.
   */
  private applyScene(opts: { dropEntities: boolean }): boolean {
    const objects = this.sceneObjects;
    const partLoc: SourceLocation | null = this.editTarget
      ? enclosingPartLocOf(this.editTarget, objects)
      : scopePartLocation(null, objects);
    const scene: PickerScene = { objects, partLoc };
    let dropped = false;
    for (const picker of this.panel.pickers.values()) {
      dropped = picker.setScene(scene, opts) || dropped;
    }
    this.scope.setScene(objects, partLoc, { resolveKeeps: this.editTarget !== null });
    return dropped;
  }

  /** The edited statement's own sources, for the kept chips' highlight. */
  private async loadEditSources(): Promise<void> {
    const boundary = this.session.boundary;
    if (!boundary) {
      return;
    }
    this.sourcesLoaded = true;
    const result = await fetchFeatureSources(boundary);
    if (!this.editTarget || this.session.boundary?.index !== boundary.index) {
      return;
    }
    if (result.ok && result.feature === 'custom' && result.id === this.schema.id) {
      for (const picker of this.panel.pickers.values()) {
        picker.setSources(result.slots[picker.name]);
      }
    }
    this.refreshHighlight();
  }

  private async refreshScopeVariables(): Promise<void> {
    const line = this.editTarget?.line ?? null;
    await refreshScopeVariables(line, this.panel,
      () => this.armed && (this.editTarget?.line ?? null) === line);
  }

  /**
   * The viewer offers what the armed slot takes, so the slot's border says
   * where the next click lands: faces, edges, sketch wires, axis lines and
   * the world axes, plane quads and the origin planes — or whole solids for
   * the scope row.
   */
  private syncViewport(): void {
    if (!this.armed) {
      return;
    }
    const armed = this.panel.armedSlot;
    const channels = armed === 'scope' ? SCOPE_CHANNELS : this.panel.armedPicker?.channels() ?? NO_CHANNELS;
    this.viewer.pickFilter = channels.pickFilter;
    this.viewer.pickSketchWires = channels.sketchWires;
    this.viewer.pickAxes = channels.axes;
    this.viewer.pickPlanes = channels.planes;
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

  /** Repaint the scope chips, then the highlight. */
  private refreshScope(): void {
    this.panel.scopeSlot?.setChips(this.scope.chips());
    this.refreshHighlight();
  }

  /** Light up every value's picks and the scope's solids in one pass. */
  private refreshHighlight(): void {
    if (!this.armed) {
      return;
    }
    const highlight = new PickHighlight();
    for (const picker of this.panel.pickers.values()) {
      if (picker.visible) {
        picker.highlight(highlight);
      }
    }
    if (this.panel.scopeSlot?.visible) {
      highlight.solidIds.push(...this.scope.shapeIds());
    }
    this.viewer.setSelectedStandardAxes(highlight.standardAxes);
    if (highlight.isEmpty) {
      this.viewer.clearHighlight();
    } else {
      this.viewer.highlightEntities(highlight.entities, highlight.wireIds, highlight.solidIds, highlight.planeQuadIds);
    }
  }

  private syncButton(): void {
    this.button.setActive(this.armed);
    // Every armed flip lands here — the Sketch button disables while a
    // create dialog is up.
    this.hooks.onActiveChange?.();
  }
}
