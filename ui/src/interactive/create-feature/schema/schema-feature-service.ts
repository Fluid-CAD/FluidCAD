import {
  applyCustomFeature, applyCustomFeatureEdit, featureGhostScope, fetchConnectorAnchors, fetchFeatureGhostResult, fetchFeatureSources,
  getFaceProperties, type CustomFeatureApplyOptions, type FaceProperties, type FeaturePickedSurface, type CustomFeatureEditOptions, type CustomGhostRequest, type CustomPickInput,
  type FeatureEditTarget, type FeatureListValue, type FeatureScalarValue, type GhostCustomRef, type GhostSolid, type NewVariable,
  type ParsedFeatureStatement, type ScopeTargetRef, type ValueExpr,
} from '../../../api';
import type { StandardAxisId } from '../../../scene/standard-axes';
import type { StandardPlaneId } from '../../../scene/standard-planes';
import type { SceneObjectRender, SourceLocation, SubSelection } from '../../../types';
import type { Navbar } from '../../../ui/navbar';
import type { Viewer } from '../../../viewer';
import { EditSession } from '../../edit-session';
import type {
  ConnectorPickDetail, FeatureDialogExit, FeatureDialogService, FeatureEditInfo, ParsedFeatureKind,
} from '../../feature-dialog-registry';
import { ConnectorPickMenu } from '../../assembly-mate/connector-pick-menu';
import { AnchorSuggestions } from '../anchor-suggestions';
import { ApplyRunner } from '../apply-runner';
import { ConnectorGhostOverlay } from '../connector-ghost';
import { ConnectorOptions } from '../connector-options';
import { FeatureButton, type FeatureLauncher } from '../feature-button';
import { FeatureGhostOverlay } from '../feature-ghost';
import { refreshScopeVariables } from '../option-relabeler';
import { enclosingPartLocOf, scopePartLocation, ScopeTargetList } from '../scope-targets';
import { collectSketchProfiles } from '../sketch-profiles';
import { SketchUISuspender } from '../sketch-suspender';
import { FeatureSchema } from './feature-schema';
import { PreviewPreference } from './preview-preference';
import { SchemaFeaturePanel } from './schema-feature-panel';
import {
  NO_CHANNELS, PickHighlight, SCOPE_CHANNELS, type PickOutcome, type PickerScene, type SchemaPicker,
} from './schema-pickers';

type ParsedCustomFeature = Extract<ParsedFeatureStatement, { feature: 'custom' }>;

type CreateRequest = Omit<CustomFeatureApplyOptions, 'preview' | 'signal'>;
/** One ghost answer: the bodies to draw (null for none), and the values the feature fixed from its picks — null when the ghost didn't build, so nothing is known. */
type SchemaGhost = { solids: GhostSolid[] | null; derived: Record<string, FeatureScalarValue> | null };
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
 * The dialog of one custom feature, built from its metadata: the control it
 * opens from (its own toolbar button in the feature's group, or a launcher
 * the page hands it — a cell of the custom features menu), the schema
 * dialog, and the create and timeline-edit flows every built-in dialog has —
 * registered with the page's {@link FeatureDialogRegistry} like them.
 *
 * Picks route to the armed slot (the viewer offers only what that slot
 * takes); timeline rows route to the slot that takes their kind, whichever
 * is armed. Apply writes the builder's call through the feature's call
 * shape — the values the user set, the picks, the operation and its scope —
 * and an edit rewrites only what the user changed. The re-render is the
 * preview, editor undo the rollback.
 *
 * While the dialog previews, the feature's ghost draws in the viewport —
 * built by the engine from the same values and picks. The feature's metadata
 * chooses how: behind a Preview toggle that starts off (a preview runs the
 * feature's code on every change) unless the user turned it on for this
 * feature before (`ghost: 'toggle'`, the default), always with no toggle
 * (`ghost: 'always'`), or not at all (`ghost: false`). Off, the engine is
 * never asked for a ghost. One that takes longer to build than a preview may
 * (5 s) times out: the dialog says so and asks again only when the toggle is
 * turned off and on (or Try again is pressed, with no toggle), or the
 * feature's code is saved.
 */
export class SchemaFeatureService implements FeatureDialogService {
  readonly id: string;
  readonly editRowTypes: readonly string[];
  readonly parsedFeatures: readonly ParsedFeatureKind[] = ['custom'];
  readonly blocksSketchButton = true;
  readonly pinsSketchToolbar: boolean;
  readonly toolbarButton: FeatureButton | null;

  private readonly panel: SchemaFeaturePanel;
  private readonly launcher: FeatureLauncher;
  /** Its own button sits in the create group, which it votes visible. */
  private readonly votesCreateGroup: boolean;
  private readonly sketchUI: SketchUISuspender;
  private readonly runner: ApplyRunner<CreateRequest | EditRequest, SchemaGhost>;
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
  /** The live geometry ("ghost"); null for a feature whose metadata draws none. */
  private readonly ghost: FeatureGhostOverlay | null;
  /** The Preview toggle is on: the ghost is asked for. */
  private previewOn = false;
  /** Why the ghost timed out (it built slower than a preview may), or null while it runs. */
  private ghostPaused: string | null = null;
  /** The anchor suggestions a hovered face or edge floats — for a feature with an anchor value. */
  private readonly suggestions: AnchorSuggestions | null;
  private readonly connectorGhost: ConnectorGhostOverlay | null;
  /** "Which connector?" when several gizmos sit under the cursor — for a feature with a connector value. */
  private readonly pickMenu: ConnectorPickMenu | null;
  /** Picked faces' surfaces as the engine classified them, by shape id and face index — null while asked. */
  private readonly faceSurfaces = new Map<string, FeaturePickedSurface | null>();

  constructor(
    container: HTMLElement,
    private readonly viewer: Viewer,
    private readonly navbar: Navbar,
    readonly schema: FeatureSchema,
    iconSrc: string,
    private readonly hooks: SchemaFeatureHooks = {},
    /** Where the dialog opens from; absent — its own button in its metadata's group. */
    launcher?: FeatureLauncher,
  ) {
    this.id = SchemaFeatureService.dialogId(schema.id);
    this.editRowTypes = [schema.id];
    this.sceneObjects = viewer.currentSceneObjects ?? [];
    // A feature that takes a sketch can finish one: the sketch toolbar stays
    // up while it is armed from an active sketch, as for Extrude.
    this.pinsSketchToolbar = schema.pickerNames.some(name => (schema.param(name) as { picker: string }).picker === 'sketch');

    if (launcher) {
      this.launcher = launcher;
      this.toolbarButton = null;
      this.votesCreateGroup = false;
    } else {
      const groupKey = schema.meta.group === 'modify' ? 'modify' : 'create';
      const group = navbar.getGroup(groupKey)
        ?? navbar.addGroup(groupKey, groupKey === 'create' ? { visible: false, immune: true } : { visible: false });
      const button = new FeatureButton(group, {
        icon: iconSrc,
        label: schema.label,
        tip: schema.tip,
        ariaLabel: schema.tip,
        datasetTool: `feature:${schema.id}`,
      });
      this.launcher = button;
      // Create-group buttons leave the bar while a sketch is up; the modify
      // group hides wholesale then.
      this.toolbarButton = groupKey === 'create' ? button : null;
      this.votesCreateGroup = groupKey === 'create';
      if (this.votesCreateGroup) {
        navbar.setGroupVisible('create', true, this.id);
      }
    }
    this.launcher.onClick = () => {
      if (this.armed) {
        this.exit();
      } else {
        this.enter();
      }
    };
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
    this.panel.onPreviewToggle = (on) => {
      this.previewOn = on;
      PreviewPreference.write(schema.id, on);
      this.resumeGhost();
      this.runner.schedulePreview();
    };
    this.panel.onPreviewRetry = () => {
      this.resumeGhost();
      this.runner.schedulePreview();
    };
    for (const picker of this.panel.pickers.values()) {
      picker.onChange = () => {
        this.panel.setMessage(null);
        this.panel.syncVisibility();
        this.refreshHighlight();
        this.runner.schedulePreview();
      };
    }
    this.panel.faceSurface = face => this.faceSurface(face);

    const pickers = [...this.panel.pickers.values()];
    this.pickMenu = pickers.some(p => p.takesConnectors) ? new ConnectorPickMenu(container) : null;
    if (pickers.some(p => p.takes('anchor'))) {
      this.connectorGhost = new ConnectorGhostOverlay(viewer);
      // A custom feature takes the bare anchor wherever it is — never a
      // connector made behind the user's back — so it asks as a hole does.
      this.suggestions = new AnchorSuggestions(viewer, this.connectorGhost, {
        purpose: 'hole',
        isTaken: (key, index) => this.anchorPicker()?.holdsAnchor(key, index) ?? false,
        offers: (anchor) => this.anchorPicker()?.offersAnchor(anchor) ?? false,
        request: fetchConnectorAnchors,
      });
      this.suggestions.onLock = (locked) => {
        const picker = this.anchorPicker();
        if (picker) {
          this.land(picker, picker.takeAnchor(locked));
        }
      };
      this.suggestions.onRefuse = (reason) => this.panel.setMessage(reason ?? 'That face or edge takes no anchor.');
    } else {
      this.connectorGhost = null;
      this.suggestions = null;
    }

    this.ghost = schema.meta.ghost ? new FeatureGhostOverlay(viewer) : null;
    this.runner = new ApplyRunner<CreateRequest | EditRequest, SchemaGhost>({
      panel: this.panel,
      isArmed: () => this.armed,
      build: purpose => this.editTarget ? this.buildEditRequest(purpose === 'apply') : this.buildRequest(purpose === 'apply'),
      send: (request, extras) => this.editTarget
        ? applyCustomFeatureEdit(this.editTarget, { ...(request as EditRequest), ...extras })
        : applyCustomFeature({ ...(request as CreateRequest), ...extras }),
      onApplied: () => this.exit(this.editTarget ? { editEnd: 'apply' } : { resume: 'lazy' }),
      failMessage: () => this.editTarget ? 'Could not apply the edit.' : `Could not apply the ${schema.label.toLowerCase()}.`,
      // The statement preview's geometric twin, under the same debounce and
      // abort scope: drawn only once the statement previewed cleanly.
      ...(this.ghost ? {
        ghost: {
          fetch: (_request: CreateRequest | EditRequest, signal: AbortSignal) => this.fetchGhost(signal),
          apply: (ghost: SchemaGhost | null) => this.drawGhost(ghost),
        },
      } : {}),
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
    this.restorePreview();
    this.resumeGhost();
    if (this.sceneSketchActive) {
      this.sketchUI.suspend();
    }
    this.syncButton();
    this.applyScene({ dropEntities: true });
    void this.refreshScopeVariables();
    this.panel.show();
    this.panel.setMessage(null);
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
    this.restorePreview();
    this.resumeGhost();
    this.scope.seedKeeps(parsed, target.filePath);
    this.syncButton();
    this.sketchUI.suspend();
    this.session.begin({ ...info, target });
    void this.loadEditSources();
    void this.refreshScopeVariables();
    this.panel.showEdit({
      values: parsed.values as Record<string, FeatureScalarValue | FeatureListValue>,
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
    // The overlay is a compiledMesh sibling, so no render tears it down —
    // every way out of the dialog (apply, cancel, scene-driven) lands here.
    this.resumeGhost();
    this.viewer.clearHighlight();
    this.viewer.setSelectedStandardAxes([]);
    this.viewer.hideStandardAxes();
    this.viewer.hideStandardPlanes();
    this.viewer.pickFilter = 'all';
    this.viewer.pickSketchWires = false;
    this.viewer.pickAxes = false;
    this.releaseLocationChannels();
    // pickPlanes is left alone: syncButton's onActiveChange runs the modify
    // service's neutral-mode restore, which owns that channel.
    this.syncButton();
    this.panel.hide();
    this.sketchUI.resume((opts.resume ?? 'immediate') === 'immediate');
  }

  /**
   * The feature's module was saved with its metadata unchanged, so the
   * dialog stayed open — but what it previews was built with the old code.
   * Ask again: the engine loads the saved code for the next ghost. A ghost
   * that timed out runs again too, since what made it slow may be gone.
   */
  codeChanged(): void {
    if (!this.armed) {
      return;
    }
    if (this.ghostPaused !== null) {
      this.resumeGhost();
    }
    this.runner.schedulePreview();
  }

  /** A module was saved and the dialog stayed: the images its rows show may be new files. */
  assetsChanged(): void {
    this.panel.refreshImages();
  }

  /** Take the dialog and its button (or menu cell) off the page — its feature changed or left the catalog. */
  destroy(): void {
    this.exit({ resume: 'lazy' });
    this.ghost?.dispose();
    this.suggestions?.dispose();
    if (this.votesCreateGroup) {
      this.navbar.setGroupVisible('create', false, this.id);
    }
    this.launcher.remove();
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
      // Mid-flight to the boundary — whatever the ghost was drawn against is
      // already gone from the view.
      this.ghost?.clear();
      if (!isRollback) {
        this.editSceneStale = true;
      }
      return;
    }
    // At the boundary: the scene under the ghost was rebuilt.
    this.ghost?.clear();
    this.suggestions?.clear();
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
    // The geometry under the ghost just changed — drop it now and let the
    // debounce redraw it. Anchor answers name the old render's shapes.
    this.ghost?.clear();
    this.suggestions?.clear();
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

  /**
   * A face, edge or vertex click: the armed slot's — an anchor value's face
   * or edge locks the suggestion the cursor floats — or the armed scope
   * row's solid.
   */
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
      if (picker.clickKind(sub) === 'anchor') {
        this.suggestions?.handleClick(shapeId, sub);
        return true;
      }
      this.land(picker, picker.takeClick(shapeId, sub));
    }
    return true;
  }

  /** The cursor rests on a face or edge: an armed anchor value floats its nearest anchor there. */
  handleHover(shapeId: string | null, sub: SubSelection, clientX: number, clientY: number): boolean {
    if (!this.armed || !this.anchorPicker() || this.panel.armedSlot === 'scope') {
      return false;
    }
    this.suggestions?.handleHover(shapeId, sub, clientX, clientY);
    return true;
  }

  /**
   * A connector gizmo clicked: the armed value takes it when it takes
   * connectors — a connector value, or an axis value, which reads it as its
   * Z axis — else the first shown value that does. Several gizmos under the
   * cursor ask which first.
   */
  handleConnectorPick(connectorId: string | null, pick: ConnectorPickDetail): boolean {
    if (!this.armed) {
      return false;
    }
    const armed = this.panel.armedPicker;
    const picker = armed?.takesConnectors ? armed : [...this.panel.pickers.values()].find(p => p.visible && p.takesConnectors);
    if (!picker || !connectorId) {
      return true;
    }
    this.pickMenu?.close();
    const candidates = pick?.connectorCandidates;
    if (this.pickMenu && candidates && candidates.length > 1 && pick.clientX !== undefined && pick.clientY !== undefined) {
      this.pickMenu.show(pick.clientX, pick.clientY, candidates.map(candidate => ({
        label: this.connectorLabel(candidate.connectorId),
        onHover: () => this.viewer.setHoveredConnector(candidate.connectorId),
        onPick: () => this.land(picker, picker.takeConnector(candidate.connectorId)),
      })), () => this.viewer.setHoveredConnector(null));
      return true;
    }
    this.land(picker, picker.takeConnector(connectorId));
    return true;
  }

  /** How code names a connector: `bolt`, `bolt.instance(2)`. */
  private connectorLabel(connectorId: string): string {
    return ConnectorOptions.forId(connectorId, ConnectorOptions.collect(this.sceneObjects))?.label ?? connectorId;
  }

  /** The armed value, when it takes anchors. */
  private anchorPicker(): SchemaPicker | null {
    const picker = this.armed ? this.panel.armedPicker : null;
    return picker?.takes('anchor') ? picker : null;
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
      ...[...this.panel.pickers.values()].filter(p => p !== armed && p.visible),
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
    if (!picker || !picker.takes('axis')) {
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
    if (!picker || !picker.takes('plane')) {
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
    this.panel.syncVisibility();
    this.refreshHighlight();
    this.runner.schedulePreview();
  }

  /**
   * A picked face's surface, for a `visibleWhen` that names a picked value:
   * known once the engine has answered — until then undefined, and the rows
   * sync again when it does.
   */
  private faceSurface(face: { shapeId: string; index: number }): FeaturePickedSurface | undefined {
    const key = `${face.shapeId}#${face.index}`;
    const known = this.faceSurfaces.get(key);
    if (known !== undefined) {
      return known ?? undefined;
    }
    this.faceSurfaces.set(key, null);
    void getFaceProperties(face.shapeId, face.index)
      .then(props => SchemaFeatureService.pickedSurface(props), () => 'other' as const)
      .then(surface => {
        this.faceSurfaces.set(key, surface);
        this.panel.syncVisibility();
      });
    return undefined;
  }

  /** The engine's face classification in a `visibleWhen`'s words: a plane (round or not) is planar. */
  private static pickedSurface(props: FaceProperties | null): FeaturePickedSurface {
    switch (props?.surfaceType) {
      case 'plane':
      case 'circle':
        return 'planar';
      case 'cylinder':
      case 'cone':
      case 'sphere':
      case 'torus':
        return props.surfaceType;
      default:
        return 'other';
    }
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
  private buildRequest(reveal: boolean): CreateRequest | { error: string } {
    const values = this.collectValues(false, reveal);
    if ('error' in values) {
      return values;
    }
    const picks = this.collectPicks(reveal);
    if ('error' in picks) {
      return picks;
    }
    // The operation travels whatever it is; the engine writes the
    // feature's default without a chain.
    const operation = this.panel.operation;
    return {
      id: this.schema.id,
      values: values.values,
      picks: picks.picks,
      ...(operation ? { operation } : {}),
      ...(operation !== 'new' && !this.scope.isEmpty ? { scope: this.scope.createRefs() } : {}),
      ...(values.newVariables ? { newVariables: values.newVariables } : {}),
    };
  }

  /**
   * The edit request: only what changed. A value the user didn't touch, a
   * pick still on the statement's own elements, an unchanged operation or
   * scope is left out, so the statement keeps its own text there.
   */
  private buildEditRequest(reveal: boolean): EditRequest | { error: string } {
    const values = this.collectValues(true, reveal);
    if ('error' in values) {
      return values;
    }
    const picks = this.collectPicks(reveal);
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
   * leaves an untouched row's value to the builder's default — the one the
   * row shows — and refuses a required one never filled in; an edit keeps
   * the statement's own, and a cleared row (an empty choice) drops its value
   * when the builder has something to fall back on. A select of several is
   * never empty in that sense: with none chosen it writes an empty list.
   */
  private collectValues(editing: boolean, reveal: boolean): {
    values: Record<string, ValueExpr | boolean | string | FeatureListValue | null>;
    newVariables?: NewVariable[];
  } | { error: string } {
    const values: Record<string, ValueExpr | boolean | string | FeatureListValue | null> = {};
    const newVariables: NewVariable[] = [];
    for (const [name, field] of this.panel.fields) {
      if (!field.visible) {
        continue;
      }
      const missing = `${this.schema.param(name).label} is required.`;
      if (field.isDerived) {
        // The engine fixes the value from the picks: the statement never
        // writes it — an edit drops the value it wrote, when the builder can
        // do without it (else the engine ignores it, with a warning).
        if (editing && this.parsed && name in this.parsed.values && !this.schema.required(name)) {
          values[name] = null;
        }
        continue;
      }
      if (!field.dirty) {
        if (!editing && this.schema.required(name)) {
          this.blockedAt(name, reveal);
          return { error: missing };
        }
        continue;
      }
      const read = field.read();
      if ('error' in read) {
        this.blockedAt(name, reveal);
        return read;
      }
      if ('empty' in read) {
        if (this.schema.required(name)) {
          this.blockedAt(name, reveal);
          return { error: missing };
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

  /**
   * The value `name` blocks the request. On Apply its row comes into view —
   * its tab shown, its section unfolded — so the message names a row the
   * user can see; a preview's request leaves the dialog where it is.
   */
  private blockedAt(name: string, reveal: boolean): void {
    if (reveal) {
      this.panel.reveal(name);
    }
  }

  /** The picked values to write, or the message blocking the apply. */
  private collectPicks(reveal: boolean): { picks: Record<string, CustomPickInput[]> } | { error: string } {
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
        this.blockedAt(name, reveal);
        return request;
      }
      picks[name] = request;
    }
    return { picks };
  }

  // -------------------------------------------------------------------------
  // Live geometry ("ghost")
  // -------------------------------------------------------------------------

  /**
   * The ghost of the form as it stands: the values the rows hold (a new
   * variable by its value), every pick as the ghost addresses it, the
   * operation — in edit mode against the scene before the statement. Null
   * when there is nothing to draw: a row that doesn't read, a pick the
   * ghost can't address. In edit mode a hidden row's value or pick is the
   * statement's own, which it keeps, so it travels too.
   */
  private ghostRequest(): CustomGhostRequest | null {
    const editing = this.editTarget !== null;
    const values: Record<string, ValueExpr | boolean | string | FeatureListValue> = {};
    for (const [name, field] of this.panel.fields) {
      if ((!field.visible && !editing) || field.isDerived) {
        continue;
      }
      const read = field.read();
      if ('error' in read) {
        return null;
      }
      if ('empty' in read) {
        continue;
      }
      values[name] = read.newVariable ? read.newVariable.initializer : read.value;
    }
    const refs: Record<string, GhostCustomRef[]> = {};
    for (const [name, picker] of this.panel.pickers) {
      if (!picker.visible && !editing) {
        continue;
      }
      const picked = picker.ghostRefs();
      if (picked === null) {
        return null;
      }
      if (picked) {
        refs[name] = picked;
      }
    }
    return {
      feature: 'custom',
      id: this.schema.id,
      values,
      refs,
      operation: this.panel.operation,
      ...(this.editTarget ? { exclude: { filePath: this.editTarget.filePath, line: this.editTarget.line } } : {}),
    };
  }

  /**
   * The bodies the form would build, or null to clear. With the preview
   * off (its toggle off), none, and the engine is never asked. After a time-out, none:
   * a build that slow would lag every change. A ghost that comes back timed
   * out stops the dialog's preview.
   */
  private async fetchGhost(signal: AbortSignal): Promise<SchemaGhost | null> {
    if (!this.previewOn || this.ghostPaused !== null) {
      return null;
    }
    const request = this.ghostRequest();
    if (!request) {
      return null;
    }
    const result = await fetchFeatureGhostResult(request, featureGhostScope(this.editTarget), signal);
    if (result.paused && !signal.aborted && this.armed) {
      this.ghostPaused = result.paused;
      this.panel.setPreviewPaused(result.paused);
    }
    // A ghost that built knows what the feature fixed (nothing, when it
    // says nothing); one that didn't leaves the rows as they were.
    return { solids: result.solids, derived: result.solids ? result.derived ?? {} : null };
  }

  /**
   * Draw the ghost in the operation's colour — red for what a remove cuts —
   * or clear it; and lock the rows the feature fixed from its picks on the
   * values it fixed, letting the others go. Nothing to draw lets every row go.
   */
  private drawGhost(ghost: SchemaGhost | null): void {
    if (ghost?.derived) {
      this.panel.setDerived(ghost.derived);
    } else if (!ghost) {
      this.panel.setDerived({});
    }
    if (!this.ghost) {
      return;
    }
    if (ghost?.solids) {
      this.ghost.set(ghost.solids, this.panel.operation === 'remove' ? 'remove' : 'add');
    } else {
      this.ghost.clear();
    }
  }

  /**
   * Whether the dialog previews: always for a feature whose metadata says so,
   * else the Preview toggle as the user left it for this feature — off unless
   * they turned it on.
   */
  private restorePreview(): void {
    const mode = this.schema.previewMode;
    this.previewOn = mode === 'always' || (mode === 'toggle' && PreviewPreference.read(this.schema.id));
    this.panel.setPreviewOn(this.previewOn);
  }

  /** A fresh dialog (or none): no ghost drawn, previews running again. */
  private resumeGhost(): void {
    this.ghostPaused = null;
    this.panel.setPreviewPaused(null);
    this.ghost?.clear();
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
    if (dropped) {
      this.panel.syncVisibility();
    }
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
      // A kept selection's faces are known now: a `visibleWhen` may read them.
      this.panel.syncVisibility();
    }
    this.refreshHighlight();
    // The kept picks' ghost refs read these sources, which land after
    // enterEdit already scheduled its preview — ask again now they're known.
    this.runner.schedulePreview();
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
    this.viewer.setConnectorPicking(channels.connectors);
    this.viewer.setVertexPickScope(null);
    this.viewer.pickVertices = channels.vertices;
    // Another value may take other anchors: what was asked for the last one doesn't hold.
    this.suggestions?.setEnabled(false);
    this.suggestions?.setEnabled(channels.anchors);
    if (!channels.connectors) {
      this.pickMenu?.close();
    }
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

  /** Hand the connector, vertex and anchor channels back: the dialog no longer picks. */
  private releaseLocationChannels(): void {
    this.suggestions?.setEnabled(false);
    this.connectorGhost?.clear();
    this.pickMenu?.close();
    this.viewer.setConnectorPicking(false);
    this.viewer.pickVertices = false;
    this.viewer.setVertexPickScope(null);
    this.viewer.setPickedConnectors([]);
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
    this.viewer.setPickedConnectors(highlight.connectorIds);
    if (highlight.isEmpty) {
      this.viewer.clearHighlight();
    } else {
      this.viewer.highlightEntities(highlight.entities, highlight.wireIds, highlight.solidIds, highlight.planeQuadIds);
    }
  }

  private syncButton(): void {
    this.launcher.setActive(this.armed);
    // Every armed flip lands here — the Sketch button disables while a
    // create dialog is up.
    this.hooks.onActiveChange?.();
  }
}
