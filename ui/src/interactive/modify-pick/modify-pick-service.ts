import {
  applyFeature, applyValueFeatureEdit, clearBreakpoints, expandBucket, fetchFeatureGhost,
  fetchFeatureSources, parseFeatureAt, removeFeature, ApplyFeatureResponse, FeatureEditTarget,
  NewVariable, ParsedFeatureStatement, SelectionGroupKind, ShellJoinType, SketchSourceRef,
  ValueExpr,
} from '../../api';
import { mergeUniqueEntities } from '../../helpers/entities';
import { findActiveObject } from '../../helpers/scene-utils';
import { collectPlaneOptions, planeOptionForLocation, PlaneOption, resolvePlaneByShapeId } from '../create-feature/plane-bases';
import { SketchStartPanel } from '../create-feature/sketch-panel';
import { FeatureGhostOverlay } from '../create-feature/feature-ghost';
import { FeatureButton } from '../create-feature/feature-button';
import { SketchUISuspender } from '../create-feature/sketch-suspender';
import { refreshScopeVariables } from '../create-feature/option-relabeler';
import { EditSession, EditSessionInfo } from '../edit-session';
import { PickSelection } from '../pick-selection';
import { SelectionContextMenu } from '../selection-menu';
import { StandardPlaneId } from '../../scene/standard-planes';
import { SceneObjectRender, SubSelection } from '../../types';
import { SelectedEntity, Viewer } from '../../viewer';
import { Navbar } from '../../ui/navbar';
import { ChamferKind, FEATURES, FEATURE_ORDER, ModifyFeatureKind } from './feature-config';
import { ModifyPanel } from './modify-panel';
import { TeachTooltip } from './teach-tooltip';

export type { ModifyFeatureKind } from './feature-config';

const PREVIEW_DEBOUNCE_MS = 250;

/** Second-value seed when the angle chamfer arms without a remembered angle. */
const DEFAULT_CHAMFER_ANGLE = 45;

/**
 * A live sketch dialog. `tracking` shows the picked target as a chip and
 * leaves the service otherwise neutral; with it false the pick mode is
 * re-armed after the chip's ✕ and the next pick retargets the tracked sketch
 * statement instead of creating a new one. The other two fields say what the
 * dialog's close button is allowed to undo.
 */
type SketchSession = {
  tracking: boolean;
  label: string;
  /**
   * This dialog WROTE the sketch statement, so Cancel undoes it by deleting
   * the statement. False for a session that merely adopted a sketch already
   * in the code (a timeline edit, a page reload, a sketch entered by editing
   * code): there is nothing to undo, so its close button just closes.
   */
  created: boolean;
  /**
   * A timeline double-click opened this session, placing a `breakpoint();`
   * after the sketch to roll the build back to it — a user close clears it,
   * exactly as {@link EditSession.end} does for every other edit dialog. False
   * for the openings that place none, which must never strip breakpoints the
   * user set themselves.
   */
  breakpoint: boolean;
  /**
   * The sketch is consumed by a later feature (in the full model it was hidden
   * — its shapes removed — or marked `.reusable()`). Captured when the
   * double-click edit opens, from the full-model row before the breakpoint
   * truncates it. Only meaningful with {@link breakpoint}: a consumed sketch
   * being edited finishes by removing the breakpoint (the downstream feature
   * re-applies), not by turning it into a new 3D feature.
   */
  consumed: boolean;
};

/**
 * Select→apply-feature pick mode: the `modify` toolbar group (Sketch / Fillet
 * / Chamfer / Shell) arms a pick mode over edges and faces (for fillet and
 * chamfer a face selection means "all edges of that face" — the features
 * explode faces at build time; shell and sketch pick faces only); picks
 * accumulate as a highlighted selection; right-click offers the multi-select
 * menu (tangent chain — a `.withTangents()` selector —, classified bucket,
 * same-type / equal-measure edges, occluded picks); the expression
 * row shows the synthesized code before Apply and is editable, with verified
 * alternatives in a dropdown; hovering shows the teach-mode attribution
 * tooltip. Apply asks the server to write the feature call into the source
 * file — the re-render is the preview and editor undo is the rollback.
 *
 * Sketch deviates deliberately: it runs a DIALOG (the same PanelShell
 * design as the create dialogs) with a single face/plane slot and no Apply —
 * picking IS the action. The first pick (a face, one of the origin planes
 * xy/xz/yz shown as viewport targets, or a `plane(…)` feature quad via the
 * viewer's opt-in `pickPlanes` channel) writes the sketch statement —
 * `sketch(<selector> | '<plane>' | <planeVar>, () => {})` — and the incoming
 * render enters the sketch; a face already highlighted on entry (or a plane
 * quad picked in neutral mode) is consumed as that pick. The dialog then
 * stays docked for the whole session of the sketch it started, its chip
 * showing the target. The chip's ✕ *suspends* sketch editing (free 3D
 * camera, grid restored, sketch UI released via the hooks) and re-arms the
 * pick — the next pick MOVES the statement's target argument in place (the
 * body survives); Escape cancels the re-pick back into the sketch view. The
 * session closes when the scene stops ending in the sketch (consumed by a
 * feature, deleted, rolled back), when another dialog takes over, or via the
 * Sketch button / Escape; when the dialog wrote the sketch itself, its Cancel
 * button goes further and deletes that statement from the code outright.
 * The dialog is scene-derived like
 * the rest of sketch mode: a render whose scene ends in a sketch with no
 * session ADOPTS it (page reloads, sketches entered by editing code, and the
 * timeline double-click that breakpoints a sketch row — sketch has no edit
 * dialog of its own), with
 * the chip label parsed from the statement's target argument — except a
 * sketch whose dialog the user dismissed, which stays closed. An adopted
 * sketch is one the dialog did not write, so closing it leaves the statement
 * alone; the double-click's breakpoint goes with the dialog. The button lives in the create group and is always
 * offered — in an empty scene the planes are the only targets, and the first
 * sketch starts here; while an extrude/sweep/loft dialog is up the button
 * disables instead of hiding.
 */
export class ModifyPickService {
  private feature: ModifyFeatureKind | null = null;
  private selection = new PickSelection();
  /**
   * Faces exist to sketch on — armed sketch mode offers them alongside the
   * origin planes; without solids the planes are the only targets.
   */
  private sketchAvailable = false;
  /** The `plane(…)` features rendered in the scene — armed sketch mode picks their quads. */
  private planes: PlaneOption[] = [];
  /**
   * A plane quad picked in neutral mode (quads are pickable there too),
   * held highlighted until the Sketch button consumes it — arming sketch
   * with a pending plane applies immediately, like a pre-highlighted face.
   */
  private pendingPlaneShapeId: string | null = null;
  /** An extrude/sweep/loft dialog is up — the Sketch button disables. */
  private createDialogActive = false;
  /**
   * The sketch dialog session, alive from the first successful pick (or the
   * adoption of a sketch already in the scene) until the scene stops ending
   * in that sketch, or the dialog is closed. Null with `feature === 'sketch'`
   * is the initial pick — a fresh arming whose first pick creates the sketch.
   */
  private sketchSession: SketchSession | null = null;
  /**
   * A sketch session a create dialog displaced — the dialog stepped aside so
   * extrude/sweep/… could take the stage. Consumed when the create dialog
   * deactivates: the sketch dialog comes back tracking if the scene still
   * ends in its sketch, with what its close button may undo intact. Dropped
   * when the sketch stops being the scene's tail or another flow starts.
   * User closes never set it.
   */
  private displacedSketch: SketchSession | null = null;
  /**
   * Source key (`file:line:col`) of a trailing sketch whose dialog the user
   * dismissed — adoption skips it, so a closed dialog stays closed across
   * the renders every drawn entity triggers. Reset when the scene stops
   * ending in a sketch.
   */
  private dismissedSketchKey: string | null = null;
  /**
   * Source key of a sketch a timeline double-click just asked to edit — the
   * adoption that click's breakpoint render triggers claims it and owns the
   * breakpoint. Cleared only once claimed: the rollback renders the gesture's
   * own clicks produce arrive as empty scenes and must not invalidate it.
   */
  private pendingSketchEditKey: string | null = null;
  /**
   * Whether {@link pendingSketchEditKey}'s sketch is consumed downstream —
   * captured from the full-model row at double-click time (see
   * {@link noteSketchEditRequest}), since the breakpoint render then truncates
   * to the sketch and loses that signal. The adopting session copies it.
   */
  private pendingSketchEditConsumed = false;
  /** The scene ends with an unconsumed sketch (scene-derived sketch mode). */
  private sceneSketchActive = false;
  /** Sketch editing is suspended while the sketch-on-face pick is armed. */
  private sketchUI: SketchUISuspender;
  /** Statement being edited in place (timeline double-click), or null. */
  private editTarget: FeatureEditTarget | null = null;
  /** The statement's own selector args — the override-detection baseline. */
  private editArgsText: string | null = null;
  /** View-state half of edit mode: pre-statement rollback + boundary. */
  private session = new EditSession();
  /** Seeded pick set's signature — an unchanged selection applies verbatim. */
  private seedSignature: string | null = null;
  /** A full render arrived mid-session — seeds re-fetch at the next boundary. */
  private editSceneStale = false;

  private buttons = new Map<ModifyFeatureKind, FeatureButton>();
  /** The last render's modify-group visibility — offset re-derives on highlight changes. */
  private modifyVisible = false;
  /** The neutral-mode selection holds a face — the Offset button's gate. */
  private neutralFaceHighlighted = false;
  private sketchPanel: SketchStartPanel;
  private panel: ModifyPanel;
  /** The rendered selection chip rows — chip index to pick members. */
  private chipRows: { label: string; members: SelectedEntity[] }[] = [];
  private applying = false;
  /** The chamfer type while a chamfer dialog is up; every arming starts equal. */
  private chamferKind: ChamferKind = 'equal';
  /**
   * Second values entered per two-value kind within THIS arming — a distance
   * makes a bad angle when the kind dropdown switches mid-session. Cleared on
   * every enter, so nothing carries over to the next operation.
   */
  private chamferValue2 = new Map<'distances' | 'angle', string>();

  private previewTimer: number | null = null;
  private previewAbort: AbortController | null = null;
  private previewSeq = 0;

  /**
   * The live geometry preview, on its own debounce channel. It can't ride the
   * statement-text one above: that preview only re-runs when the PICKS change
   * (the selector args don't depend on the radius), while the ghost has to
   * follow every keystroke in the value fields as well.
   */
  private ghost: FeatureGhostOverlay;
  private ghostTimer: number | null = null;
  private ghostAbort: AbortController | null = null;
  private ghostSeq = 0;

  private tooltip: TeachTooltip;
  private selectionMenu: SelectionContextMenu;

  constructor(
    container: HTMLElement,
    private viewer: Viewer,
    private navbar: Navbar,
    private hooks: {
      onEnter?: () => SelectedEntity[] | void;
      /** Sketch-on-face armed while a sketch is edited — release the sketch UI. */
      onSuspendSketchUI?: () => void;
      /** The suspension ended without an apply — restore the sketch UI. */
      onResumeSketchUI?: () => void;
      /** The sketch dialog's snap-to-vertices toggle changed. */
      onSnapVerticesChange?: (checked: boolean) => void;
      /** The sketch dialog's snap-to-grid toggle changed. */
      onSnapGridChange?: (checked: boolean) => void;
      /** The sketch dialog's auto-constraints toggle changed. */
      onAutoConstraintsChange?: (checked: boolean) => void;
    } = {},
  ) {
    this.sketchUI = new SketchUISuspender(viewer, hooks);
    this.ghost = new FeatureGhostOverlay(viewer);
    const group = navbar.addGroup('modify', { visible: false });
    const createHost = navbar.getGroup('create') ?? navbar.addGroup('create', { visible: false, immune: true });
    for (const kind of FEATURE_ORDER) {
      if (kind === 'offset') {
        // Offset mounts later ({@link mountOffsetButton}) — its group sits
        // after the boolean group, which doesn't exist yet at this point.
        continue;
      }
      const config = FEATURES[kind];
      const button = new FeatureButton(
        // Sketch sits ahead of the Extrude button, so the create group reads
        // Sketch first. Shell sits with the create tools, between Loft and
        // Wrap: it keeps the modify group's activation condition, so it hides
        // itself (see update()) rather than riding that group's visibility —
        // hidden until the first render reports a solid, matching the modify
        // group's own `visible: false` start.
        kind === 'sketch' || kind === 'shell' ? createHost : group,
        {
          icon: `/icons/${kind}.png`,
          label: config.label,
          tip: config.buttonTitle,
          ariaLabel: config.buttonTitle,
          prepend: kind === 'sketch',
          ...(kind === 'shell'
            ? { insertBefore: createHost.querySelector('[data-tool="wrap"]'), hidden: true }
            : {}),
        },
      );
      button.onClick = () => {
        if (this.feature === kind) {
          this.exit();
        } else {
          this.enter(kind);
        }
      };
      this.buttons.set(kind, button);
    }

    this.sketchPanel = new SketchStartPanel(container);
    this.sketchPanel.onClear = () => this.handleSketchClear();
    this.sketchPanel.onCancel = () => this.handleSketchCancel();
    this.sketchPanel.onEscape = () => this.handleSketchEscape();
    this.sketchPanel.onSectionViewToggle = (enabled) => this.viewer.setSectionViewEnabled(enabled);
    this.sketchPanel.onLockCameraToggle = (enabled) => this.viewer.setSketchCameraLockEnabled(enabled);
    this.sketchPanel.onSnapVerticesToggle = (checked) => hooks.onSnapVerticesChange?.(checked);
    this.sketchPanel.onSnapGridToggle = (checked) => hooks.onSnapGridChange?.(checked);
    this.sketchPanel.onAutoConstraintsToggle = (checked) => hooks.onAutoConstraintsChange?.(checked);
    this.viewer.setSectionViewControl({
      setVisible: (visible) => this.sketchPanel.setSectionViewVisible(visible),
      setActive: (active) => this.sketchPanel.setSectionViewActive(active),
    });

    this.panel = new ModifyPanel(container);
    this.panel.onApply = () => this.apply();
    this.panel.onExit = () => this.exit();
    this.panel.onRemoveChip = (index) => {
      const row = this.chipRows[index];
      if (row) {
        this.toggleEntity(row.members[0]);
      }
    };
    // Hovering a chip shows just that chip's entities so the row can be told
    // apart from its siblings; leaving restores the full selection.
    this.panel.onChipHover = (index) => {
      const members = index !== null ? this.chipRows[index]?.members : undefined;
      if (members) {
        this.viewer.highlightEntities(members);
      } else {
        this.previewSelection(null);
      }
    };
    // The value controls leave the selector args alone, so none of them
    // re-synthesize the statement — but every one of them changes the geometry
    // the ghost draws.
    this.panel.onValueInput = () => {
      this.syncExprPrefix();
      this.scheduleGhost();
    };
    this.panel.onValue2Input = () => {
      if (this.feature === 'chamfer' && this.chamferKind !== 'equal') {
        this.chamferValue2.set(this.chamferKind, this.panel.value2Text);
      }
      this.syncExprPrefix();
      this.scheduleGhost();
    };
    this.panel.onChamferTypeChange = () => {
      if (this.feature !== 'chamfer') {
        return;
      }
      this.applyChamferControls(this.panel.chamferType);
      this.syncExprPrefix();
      this.scheduleGhost();
    };
    this.panel.onJoinChange = () => this.syncExprSuffix();
    this.panel.expression.onSubmit = () => this.apply();

    // Teach-mode tooltip: follows the hovered edge/face while the mode is armed.
    this.tooltip = new TeachTooltip(container, {
      isActive: () => this.feature !== null,
      isSuppressed: () => this.selectionMenu.isOpen,
      boundary: () => this.session.boundary ?? undefined,
    });

    // Right-click menu: multi-select groups + sibling buckets ("Select other").
    this.selectionMenu = new SelectionContextMenu(container, 'fluidcad-modify-pick-menu', {
      kinds: ['tangent', 'classified', 'same-type', 'equal', 'sibling'],
      onSelectGroup: (kind, seed, members) => this.applyGroup(kind, seed, members),
      onPreview: (members) => this.previewSelection(members),
      boundary: () => this.session.boundary ?? undefined,
    });

    document.addEventListener('keydown', (e) => {
      if (!this.feature) {
        return;
      }
      if (e.key === 'Escape') {
        // An open selection menu consumes Escape itself (capture phase).
        e.preventDefault();
        if (this.panel.expression.closeMenuIfOpen()) {
          return;
        }
        if (this.feature === 'sketch') {
          this.handleSketchEscape();
          return;
        }
        this.exit();
      } else if (e.key === 'Enter'
        && this.feature !== 'sketch'
        && !this.panel.ownsFocus(document.activeElement)) {
        e.preventDefault();
        this.apply();
      }
    });

    // Neutral mode picks plane quads from the start (the pending sketch plane).
    this.syncPlanePicking();
  }

  get isActive(): boolean {
    return this.feature !== null;
  }

  /** The Sketch (start-a-new-sketch) button, mirrored into the Finish Sketch grid. */
  get sketchButton(): FeatureButton {
    return this.buttons.get('sketch')!;
  }

  /**
   * Start a brand-new sketch in one gesture — the Finish Sketch grid's New
   * Sketch. The Sketch toolbar button is a toggle: while a sketch is being
   * edited, its first press only closes that sketch's dialog, so plain
   * delegation would take two clicks. Here we drop any tracked session first,
   * then arm the new-sketch pick, so a single click always starts a new sketch.
   */
  startNewSketch(): void {
    if (this.sketchSession?.tracking) {
      this.closeSketchDialog();
    }
    this.enterSketch();
  }

  /** An edit session is open (the viewport shows the pre-statement rollback). */
  get isEditing(): boolean {
    return this.editTarget !== null;
  }

  /** True while the armed sketch-on-face pick has suspended sketch editing. */
  get sketchUISuspended(): boolean {
    return this.sketchUI.suspended;
  }

  /**
   * Every render lands here. An open edit session owns the view: the session
   * keeps the viewport rolled back to just before the edited statement and
   * heals index drift; at the boundary the seeds/highlights refresh. Without
   * a session this is the plain create-mode update (empty list on rollbacks,
   * matching the old main.ts wiring).
   */
  handleSceneRendered(sceneObjects: SceneObjectRender[], stop: number, isRollback: boolean): void {
    const state = this.session.onSceneRendered(sceneObjects, stop, isRollback);
    if (state === 'inactive') {
      this.update(isRollback ? [] : sceneObjects);
      return;
    }
    if (!this.feature) {
      // The dialog closed but the session lingered (defensive) — drop it.
      this.session.end('gone');
      return;
    }
    if (state === 'gone') {
      this.panel.setMessage(null);
      this.exit({ editEnd: 'gone' });
      return;
    }
    if (state === 'waiting') {
      // The view has moved off the boundary — whatever the ghost is drawing
      // sits over geometry that is no longer there.
      this.cancelGhost();
      this.ghost.clear();
      if (!isRollback) {
        // A full render rebuilt the scene: every seeded shape id died. The
        // re-asserting rollback is in flight; re-seed when it lands.
        this.editSceneStale = true;
      }
      return;
    }
    // At the boundary: the meshes were just rebuilt (updateView ran first), so
    // the drawn bands are stale. Correctness over the debounce-long gap before
    // `refresh()` repopulates them.
    this.cancelGhost();
    this.ghost.clear();
    this.tooltip.clearCache();
    this.tooltip.hide();
    this.selectionMenu.hide();
    if (this.editSceneStale) {
      this.editSceneStale = false;
      if (this.picksDirty()) {
        // The re-picked selection can't survive a scene rebuild — old shape
        // ids resolve nowhere. Reset to the statement's own selection.
        this.selection.clear();
        this.seedSignature = null;
        this.panel.setMessage('The code changed — the re-picked selection was reset.');
      }
      void this.loadEditSources();
    }
    this.previewSelection(null);
    this.refresh();
  }

  /**
   * Scene re-rendered: recompute toolbar visibility and drop the now-stale
   * selection while keeping the mode armed. The modify group needs solids
   * and no active sketch; the Sketch button (create group) is always offered
   * — its mode picks a face (starting a new sketch from inside one is a
   * supported flow) or one of the origin planes, which need no scene at all.
   */
  update(sceneObjects: SceneObjectRender[]): void {
    const hasSolid = sceneObjects.some(o =>
      o.sceneShapes?.some(s => s.shapeType === 'solid' && !s.isMetaShape && !s.isGuide));
    const active = findActiveObject(sceneObjects);
    const sketchMode = active?.type === 'sketch';
    // Fillet/Chamfer/Shell need a solid to pick on, and stay out of the way
    // while a sketch is being edited. A blank document is the exception: it
    // shows the whole toolbar (see {@link Viewer.sceneIsEmpty}) and can't be
    // in sketch mode anyway — an active sketch is scene content.
    const modifyVisible = (hasSolid || this.viewer.sceneIsEmpty) && !sketchMode;

    this.tooltip.clearCache();
    this.tooltip.hide();
    this.selectionMenu.hide();
    // Shape ids die with every render, so the bands the ghost drew name
    // nothing now; an armed dialog's `refresh()` below re-asks for them.
    this.cancelGhost();
    this.ghost.clear();
    this.sceneSketchActive = sketchMode;
    this.sketchAvailable = hasSolid;
    this.planes = collectPlaneOptions(sceneObjects);
    // Shape ids die with every render — a pending plane can't survive one.
    this.pendingPlaneShapeId = null;
    // The sketch dialog session lives and dies with the scene: it stays only
    // while the scene still ends in the sketch it tracks. Anything else —
    // the sketch consumed by a feature, deleted, rolled back — closes it
    // (the render that brought us here already shows the right view).
    if (this.sketchSession && !sketchMode) {
      this.closeSketchSession('lazy');
    }
    if (!sketchMode) {
      // A displaced session's sketch is gone too (consumed by the apply that
      // closed the create dialog, deleted, rolled back) — nothing to restore,
      // and a dismissal has nothing left to suppress. A pending edit request
      // deliberately SURVIVES: rollback renders arrive as an empty scene
      // (handleSceneRendered), and the double-click's own first click is a
      // rollback — clearing here would drop the flag before the breakpoint
      // render it was set for. It is consumed by the adoption instead.
      this.displacedSketch = null;
      this.dismissedSketchKey = null;
    } else if (active) {
      this.adoptActiveSketch(active);
    }
    this.navbar.setGroupVisible('modify', modifyVisible);
    // Shell rides the create group, so it can't inherit that visibility.
    this.buttons.get('shell')!.setVisible(modifyVisible);
    // Offset needs a face to work on: hidden until one is highlighted (or
    // its own mode is armed — the button must stay togglable while up). A
    // render kills every highlight (measure drops its selection without
    // notifying), so the face gate resets with it.
    this.modifyVisible = modifyVisible;
    this.neutralFaceHighlighted = false;
    this.syncOffsetButton();
    this.navbar.setGroupVisible('create', true, 'sketch');
    this.syncButtons();
    if (this.feature) {
      // Sketch stays armed regardless of the scene — the origin planes are
      // always available targets; the pick features need their solids.
      if (this.feature !== 'sketch' && !modifyVisible) {
        // Scene-driven exit: the update that brought us here already rendered
        // the right view, so any sketch-UI resume stays lazy.
        this.exit({ resume: 'lazy' });
        return;
      }
      if (this.feature === 'sketch') {
        // Re-size the plane targets to the re-rendered scene.
        this.viewer.showStandardPlanes(this.onPlanePick);
      }
      // Shape ids may have changed; the viewer already cleared highlights.
      this.selection.clear();
      this.refresh();
    }
  }

  /**
   * Open the dialog over an existing fillet/chamfer/shell statement
   * (timeline double-click). The session rolls the viewport back to just
   * before the statement — the world its arguments see — where the current
   * selection seeds as removable picks and re-picking is live exactly like
   * create mode. Apply rewrites the statement in place; an untouched
   * selection keeps its argument text verbatim.
   */
  enterEdit(
    target: FeatureEditTarget,
    parsed: Extract<ParsedFeatureStatement, { feature: 'shell' | 'fillet' | 'chamfer' | 'offset' }>,
    info: Omit<EditSessionInfo, 'target'>,
  ): void {
    // A sketch dialog in any state steps aside; its sketch stays. Lazy —
    // the session's rollback render is already on its way. The edit flow
    // supersedes any pending create-dialog restore.
    this.closeSketchSession('lazy');
    this.displacedSketch = null;
    this.hooks.onEnter?.();
    this.feature = parsed.feature;
    this.editTarget = target;
    this.editArgsText = parsed.argsText;
    this.selection.clear();
    this.seedSignature = null;
    this.editSceneStale = false;
    this.chamferValue2.clear();
    this.cancelPreview();
    this.viewer.clearHover();
    this.viewer.clearHighlight();
    this.viewer.hideStandardPlanes();

    const config = FEATURES[parsed.feature];
    this.viewer.pickFilter = config.pickFilter;
    this.pendingPlaneShapeId = null;
    this.syncPlanePicking();
    // The session owns the view: free 3D camera over the rolled-back scene.
    this.sketchUI.suspend();
    this.session.begin({ ...info, target });
    void this.loadEditSources();

    this.panel.setTitle(parsed.feature, `Edit ${config.label.toLowerCase()}`);
    this.panel.configureValue(config.valueLabel!, config.valueSign);
    this.panel.valueField.setValue(parsed.value);
    if (parsed.feature === 'chamfer') {
      const kind: ChamferKind = parsed.distance2 === null ? 'equal'
        : parsed.isAngle ? 'angle' : 'distances';
      this.applyChamferControls(kind, parsed.distance2);
    } else {
      this.panel.setChamferControls(null);
    }
    void this.refreshScopeVariables();
    if (parsed.feature === 'shell') {
      this.panel.joinValue = parsed.joinType;
      this.panel.setJoinVisible(true);
    } else {
      this.panel.setJoinVisible(false);
    }
    this.syncExprSuffix();
    this.panel.expression.show(parsed.argsText, []);
    this.syncExprPrefix();
    this.panel.setVisible(true);
    this.panel.setMessage(null);
    this.refresh();
    this.syncButtons();
  }

  /**
   * Seed the pick set with the statement's current selection, resolved by
   * the server onto the pre-statement solids. Unresolvable selections
   * (clones, exotic selectors) leave the set empty — new picks then REPLACE
   * the statement's args instead of extending them. A re-picked (dirty)
   * selection is never clobbered by a re-seed.
   */
  private async loadEditSources(): Promise<void> {
    const boundary = this.session.boundary;
    if (!boundary) {
      return;
    }
    const result = await fetchFeatureSources(boundary);
    if (!this.editTarget || this.session.boundary?.index !== boundary.index || this.picksDirty()) {
      return;
    }
    if (result.ok
      && (result.feature === 'shell' || result.feature === 'fillet' || result.feature === 'chamfer'
        || result.feature === 'offset')
      && result.selection.kind === 'entities') {
      this.selection.entities = result.selection.entities.map(e => ({ shapeId: e.shapeId, sub: e.sub }));
      this.selection.chains = [];
      this.seedSignature = this.selection.signature();
    } else {
      this.selection.clear();
      this.seedSignature = null;
    }
    this.previewSelection(null);
    this.refresh();
  }

  private async refreshScopeVariables(): Promise<void> {
    const line = this.editTarget?.line ?? null;
    await refreshScopeVariables(
      line,
      {
        setScopeVariables: (variables) => {
          this.panel.valueField.setVariables(variables);
          this.panel.value2Field.setVariables(variables);
        },
      },
      () => this.feature !== null && this.feature !== 'sketch' && (this.editTarget?.line ?? null) === line,
    );
  }

  /**
   * True when the selection no longer matches the seeded one — Apply then
   * sends the picks for synthesis instead of keeping the args verbatim.
   */
  private picksDirty(): boolean {
    if (!this.editTarget) {
      return false;
    }
    if (this.seedSignature === null) {
      return this.selection.entities.length > 0;
    }
    return this.selection.signature() !== this.seedSignature || this.selection.chains.length > 0;
  }

  enter(feature: ModifyFeatureKind): void {
    if (feature === 'sketch') {
      this.enterSketch();
      return;
    }
    // Arming a pick feature closes a sketch dialog in any state outright —
    // a pending create-dialog restore included.
    this.closeSketchSession();
    this.displacedSketch = null;
    const wasActive = this.feature !== null;
    // Arming a create tool from an edit dialog abandons the session; the
    // view stays where it is — the tool picks in whatever state is shown.
    this.session.end('continue');
    this.editTarget = null;
    this.editArgsText = null;
    this.seedSignature = null;
    this.editSceneStale = false;
    // Only the sketch flows run suspended; switching away restores first.
    if (this.sketchUI.suspended) {
      this.sketchUI.resume(true);
    }
    this.feature = feature;
    const config = FEATURES[feature];
    // The hook hands over whatever was highlighted before the mode armed
    // (and clears that owner's selection) — those picks become the tool's
    // initial input. Switching between features keeps the in-mode selection.
    const seed = this.hooks.onEnter?.();
    if (!wasActive) {
      this.selection.entities = Array.isArray(seed) ? [...seed] : [];
      this.selection.chains = [];
    }
    // Face-only features can't use edge picks carried over from measure or a
    // previous mode; chains losing a member go with them.
    if (config.pickFilter === 'face') {
      this.selection.restrictToFaces();
    }
    this.viewer.clearHover();
    this.viewer.pickFilter = config.pickFilter;
    // The pick features never show or pick planes — only the sketch dialog
    // (and neutral mode) keeps `plane(…)` quads pickable.
    this.syncPlanePicking();
    this.pendingPlaneShapeId = null;
    this.viewer.hideStandardPlanes();

    this.panel.setTitle(feature, config.label);
    this.panel.configureValue(config.valueLabel!, config.valueSign);
    // Every arming starts from the feature's defaults — the value, chamfer
    // type and join type never carry over from a previous operation or edit.
    this.panel.valueField.setValue(String(config.defaultValue));
    this.chamferValue2.clear();
    if (feature === 'chamfer') {
      this.applyChamferControls('equal');
    } else {
      this.panel.setChamferControls(null);
    }
    void this.refreshScopeVariables();
    if (config.joinRow) {
      this.panel.joinValue = 'arc';
      this.panel.setJoinVisible(true);
    } else {
      this.panel.setJoinVisible(false);
    }
    this.syncExprSuffix();
    this.panel.setVisible(true);
    this.panel.setMessage(null);
    this.refresh();
    this.viewer.highlightEntities(this.selection.entities);
  }

  /**
   * The Sketch button. A dialog already tracking a sketch toggles closed;
   * otherwise the pick mode arms with the dialog in its prompt state, and a
   * face highlighted beforehand (or a plane quad picked in neutral mode) is
   * consumed as the pick — the sketch starts right away, chip filled.
   */
  private enterSketch(): void {
    // A fresh sketch flow (or a toggle-close) supersedes a pending restore.
    this.displacedSketch = null;
    if (this.sketchSession?.tracking) {
      this.closeSketchDialog();
      return;
    }
    if (this.feature === 'sketch') {
      return;
    }
    // Arming from an edit dialog abandons the session; the view stays put.
    this.session.end('continue');
    this.editTarget = null;
    this.editArgsText = null;
    this.seedSignature = null;
    this.editSceneStale = false;
    if (this.feature !== null) {
      // Tear the armed pick feature's bar down; its selection seeds nothing
      // (a sketch takes exactly one face and picks it fresh).
      this.feature = null;
      this.cancelPreview();
      this.cancelGhost();
      this.ghost.clear();
      this.panel.expression.hide();
      this.tooltip.hide();
      this.selectionMenu.hide();
      this.panel.setVisible(false);
      this.panel.setMessage(null);
    }
    const seed = this.hooks.onEnter?.();
    const faces = (Array.isArray(seed) ? seed : []).filter(e => e.sub.type === 'face');
    this.selection.clear();
    this.viewer.clearHighlight();
    this.enterSketchPicking();
    // A face already highlighted on entry applies immediately — the classic
    // one-click sketch start.
    if (faces.length === 1) {
      this.selection.entities = [faces[0]];
      this.viewer.highlightEntities(this.selection.entities);
      void this.applySketchTarget({ kind: 'face', entity: faces[0] });
      return;
    }
    // A plane picked in neutral mode seeds the same immediate apply.
    if (this.pendingPlaneShapeId) {
      const shapeId = this.pendingPlaneShapeId;
      this.pendingPlaneShapeId = null;
      this.handlePlanePick(shapeId);
    }
  }

  /**
   * Arm the sketch pick mode with the dialog in its prompt state — the
   * fresh arming and the after-✕ re-pick share this. Arming from inside a
   * sketch (a new sketch from sketch mode, or the re-pick) suspends sketch
   * editing: the camera and grid leave the sketch view so faces and planes
   * can be picked in free 3D.
   */
  private enterSketchPicking(): void {
    this.feature = 'sketch';
    // A fresh arming has no session yet, so it dresses as the create flow it
    // is; the after-✕ re-pick keeps the mode of the session it belongs to.
    this.syncSketchPanelMode();
    this.viewer.clearHover();
    this.viewer.pickFilter = 'face';
    this.syncPlanePicking();
    if (this.sceneSketchActive) {
      this.sketchUI.suspend();
    }
    this.viewer.showStandardPlanes(this.onPlanePick);
    this.sketchPanel.show();
    this.refresh();
  }

  /**
   * Leave the armed sketch pick mode without closing the dialog (a pick
   * landed, or Escape cancelled a re-pick back into tracking). `resume`
   * follows the exit() contract — 'lazy' when a render is on its way.
   */
  private exitSketchPicking(resume: 'immediate' | 'lazy'): void {
    this.feature = null;
    this.viewer.pickFilter = 'all';
    this.syncPlanePicking();
    this.viewer.hideStandardPlanes();
    this.selection.clear();
    this.tooltip.hide();
    this.selectionMenu.hide();
    this.viewer.clearHighlight();
    this.syncButtons();
    this.sketchUI.resume(resume === 'immediate');
  }

  /**
   * Close the sketch dialog outright: leave an armed pick mode, drop the
   * session, resume a suspended sketch view. Safe to call when closed.
   */
  private closeSketchSession(resume: 'immediate' | 'lazy' = 'immediate'): void {
    const hadDialog = this.sketchSession !== null || this.feature === 'sketch';
    this.sketchSession = null;
    if (this.feature === 'sketch') {
      this.exitSketchPicking(resume);
    } else {
      this.sketchUI.resume(resume === 'immediate');
      this.syncButtons();
    }
    if (hadDialog) {
      this.sketchPanel.hide();
    }
  }

  /**
   * The chip's ✕: leave the sketch-mode view (free camera, grid restored)
   * and re-arm picking — the next pick MOVES the tracked sketch statement
   * onto the new face/plane instead of creating another sketch.
   */
  private handleSketchClear(): void {
    if (!this.sketchSession?.tracking) {
      return;
    }
    this.sketchSession.tracking = false;
    this.enterSketchPicking();
  }

  /**
   * The close button. A dialog that CREATED its sketch cancels it: the
   * statement is deleted — the editor round-trip re-renders without it, and
   * that render restores the default view. A dialog that adopted a sketch
   * already in the code (a timeline edit, a reload) has nothing to undo, so
   * it only exits and the sketch stays. Before the first pick there is no
   * statement either way, so Cancel just closes, like Escape.
   */
  private handleSketchCancel(): void {
    const created = this.sketchSession?.created ?? false;
    const loc = this.sketchSession ? this.activeSketchLoc() : null;
    if (created && loc) {
      removeFeature(loc);
      // The removal's re-render is already on its way.
      this.closeSketchDialog('lazy');
      return;
    }
    this.closeSketchDialog();
  }

  /** Escape during a re-pick restores the sketch view; otherwise it closes. */
  private handleSketchEscape(): void {
    if (this.feature === 'sketch' && this.sketchSession) {
      this.sketchSession.tracking = true;
      this.sketchPanel.setTarget(this.sketchSession.label);
      this.sketchPanel.setMessage(null);
      this.exitSketchPicking('immediate');
      return;
    }
    this.closeSketchDialog();
  }

  /**
   * A user close of the sketch dialog (its close button, Escape, the Sketch
   * button toggling it shut): drop the session, keep it dismissed so the next
   * render doesn't re-adopt it, and clear the breakpoint the timeline
   * double-click that opened it placed — the cleanup {@link EditSession.end}
   * does for every other edit dialog, so the model rebuilds to its tip.
   * Handoffs to another dialog and scene-driven closes use
   * {@link closeSketchSession} instead: any breakpoint there is someone
   * else's, or already gone.
   */
  private closeSketchDialog(resume: 'immediate' | 'lazy' = 'immediate'): void {
    const ownsBreakpoint = this.sketchSession?.breakpoint ?? false;
    this.markSketchDismissed();
    // Clearing rebuilds to the tip, so that render carries the sketch-UI resume.
    this.closeSketchSession(ownsBreakpoint ? 'lazy' : resume);
    if (ownsBreakpoint) {
      clearBreakpoints();
    }
  }

  /**
   * A timeline double-click landed on a sketch row. Sketch has no edit dialog
   * of its own: the click's breakpoint truncates the build at the sketch, and
   * the render that follows ends in it — which the dialog adopts, the same
   * path a page reload takes. Flag that adoption as the edit it is, so the
   * dialog wears the edit title and its close clears the breakpoint. An
   * explicit request to edit this sketch also overrides an earlier dismissal,
   * or the dialog the user asked for would never appear.
   *
   * The gesture's OWN first click already rolled the view back to this sketch,
   * so the dialog has usually adopted it before this runs — the breakpoint
   * render then finds a live session and adopts nothing. Upgrade that session
   * in place; the pending key only covers the case where the rollback render
   * hasn't landed yet.
   */
  noteSketchEditRequest(loc: { filePath: string; line: number; column: number }, consumed: boolean): void {
    const key = ModifyPickService.sketchKey(loc);
    this.pendingSketchEditKey = key;
    this.pendingSketchEditConsumed = consumed;
    if (this.dismissedSketchKey === key) {
      this.dismissedSketchKey = null;
    }
    const active = this.activeSketchLoc();
    if (this.sketchSession && active && ModifyPickService.sketchKey(active) === key) {
      this.pendingSketchEditKey = null;
      this.sketchSession.breakpoint = true;
      this.sketchSession.consumed = consumed;
      this.syncSketchPanelMode();
    }
  }

  /** Editing a sketch that a later feature consumes: the Finish Sketch button
   *  removes the breakpoint (the feature re-applies) instead of offering the
   *  grid of new features. */
  get isEditingConsumedSketch(): boolean {
    return this.sketchSession?.breakpoint === true && this.sketchSession.consumed === true;
  }

  /**
   * Finish editing a consumed sketch: close the edit dialog, which clears the
   * breakpoint the double-click placed so the build resumes to its tip and the
   * downstream feature re-applies with the edits. The edits themselves are
   * already in the file — nothing is undone.
   */
  finishSketchEdit(): void {
    this.closeSketchDialog();
  }

  /**
   * The 2D fillet dialog docks in the sketch dialog's spot, so the sketch
   * dialog steps aside while it is open and returns when it closes — the
   * sketch toolbar service drives this through main.ts. The panel keeps its
   * session state either way; if the session ended meanwhile (the sketch was
   * left), lifting the suspension restores nothing.
   */
  setSketchPanelSuspended(suspended: boolean): void {
    this.sketchPanel.setSuspended(suspended);
  }

  /**
   * The scene ends in a sketch but no dialog session exists — a page reload,
   * a sketch entered by editing code directly, or the breakpoint render of a
   * timeline double-click on a sketch row. Adopt it: the dialog is
   * scene-derived like the rest of sketch mode (dimming, camera, toolbar).
   * The target chip starts generic and refines asynchronously from the
   * statement's parsed target argument. An adopted session never created its
   * sketch, so its close button leaves the statement alone. A dismissed
   * dialog stays closed for that sketch, and an armed feature or open create
   * dialog takes precedence.
   */
  private adoptActiveSketch(sketch: SceneObjectRender): void {
    if (this.sketchSession || this.feature !== null || this.createDialogActive) {
      return;
    }
    const loc = sketch.sourceLocation;
    if (!loc) {
      return;
    }
    const key = ModifyPickService.sketchKey(loc);
    if (key === this.dismissedSketchKey) {
      return;
    }
    const fromEdit = key === this.pendingSketchEditKey;
    const consumed = fromEdit && this.pendingSketchEditConsumed;
    this.pendingSketchEditKey = null;
    this.pendingSketchEditConsumed = false;
    this.dismissedSketchKey = null;
    this.sketchSession = { tracking: true, label: 'Sketch target', created: false, breakpoint: fromEdit, consumed };
    this.syncSketchPanelMode();
    this.sketchPanel.setTarget(this.sketchSession.label);
    this.sketchPanel.setMessage(null);
    this.sketchPanel.show();
    void this.refreshAdoptedLabel({ filePath: loc.filePath, line: loc.line, column: loc.column });
  }

  /** Dress the dialog for how its session opened — the close button's meaning. */
  private syncSketchPanelMode(): void {
    const session = this.sketchSession;
    if (!session || session.created) {
      this.sketchPanel.setMode('create');
    } else if (session.breakpoint) {
      this.sketchPanel.setMode('edit');
    } else {
      this.sketchPanel.setMode('adopted');
    }
  }

  /**
   * Refine an adopted session's generic chip from the sketch statement's
   * parsed target argument. Applied only while the session still tracks the
   * same statement; a parse refusal (standalone serve has no live code
   * buffer) keeps the generic label.
   */
  private async refreshAdoptedLabel(loc: SketchSourceRef): Promise<void> {
    const result = await parseFeatureAt(loc);
    const current = this.activeSketchLoc();
    if (!this.sketchSession?.tracking || !current
      || current.filePath !== loc.filePath || current.line !== loc.line) {
      return;
    }
    if (!result.ok || result.parsed.feature !== 'sketch') {
      return;
    }
    const label = ModifyPickService.sketchTargetLabel(result.parsed.targetText);
    this.sketchSession.label = label;
    this.sketchPanel.setTarget(label);
  }

  /** Chip label for a parsed sketch target argument. */
  private static sketchTargetLabel(targetText: string | null): string {
    if (!targetText) {
      return 'Sketch target';
    }
    const text = targetText.trim();
    const standard = /^['"`](xy|xz|yz)['"`]$/i.exec(text);
    if (standard) {
      return `${standard[1].toUpperCase()} plane`;
    }
    // A bare identifier is a plane bound to a variable — its name IS the
    // label, matching the plane dropdown's relabeling.
    if (/^[A-Za-z_$][\w$]*$/.test(text)) {
      return text;
    }
    return 'Face';
  }

  /** Adoption identity for a sketch statement — shape ids die each render. */
  private static sketchKey(loc: { filePath: string; line: number; column: number }): string {
    return `${loc.filePath}:${loc.line}:${loc.column}`;
  }

  /**
   * Record the trailing sketch as user-dismissed, so incoming renders don't
   * re-adopt the dialog the user just closed.
   */
  private markSketchDismissed(): void {
    const loc = this.activeSketchLoc();
    this.dismissedSketchKey = loc ? ModifyPickService.sketchKey(loc) : null;
  }

  /** The active (trailing) sketch's source location, or null. */
  private activeSketchLoc(): SketchSourceRef | null {
    const active = findActiveObject(this.viewer.currentSceneObjects);
    if (active?.type === 'sketch' && active.sourceLocation) {
      const { filePath, line, column } = active.sourceLocation;
      return { filePath, line, column };
    }
    return null;
  }

  /** Chip label for a picked face: "Face — <owning object's name>". */
  private faceLabel(shapeId: string): string {
    const owner = this.viewer.currentSceneObjects.find(o =>
      o.sceneShapes?.some(s => s.shapeId === shapeId));
    return owner?.name ? `Face — ${owner.name}` : 'Face';
  }

  /**
   * The one-pick sketch apply: create the sketch statement and enter it —
   * or, on the re-pick after ✕, move the tracked statement's target
   * argument in place (the body survives). Success leaves the dialog
   * tracking with the pick as its chip; failure keeps picking armed with
   * the reason shown.
   */
  private async applySketchTarget(target:
    | { kind: 'face'; entity: SelectedEntity }
    | { kind: 'standard'; plane: StandardPlaneId }
    | { kind: 'planeFeature'; option: PlaneOption },
  ): Promise<void> {
    if (this.feature !== 'sketch' || this.applying) {
      return;
    }
    const prev = this.sketchSession;
    const repick = prev !== null && !prev.tracking;
    const retarget = repick ? this.activeSketchLoc() : null;
    if (repick && !retarget) {
      // The tracked statement vanished underneath — nothing to move.
      this.closeSketchSession();
      return;
    }
    const label = target.kind === 'face' ? this.faceLabel(target.entity.shapeId)
      : target.kind === 'standard' ? `${target.plane.toUpperCase()} plane`
        : target.option.label;
    this.applying = true;
    try {
      const result = await applyFeature('sketch', null, target.kind === 'face' ? [target.entity] : [], {
        plane: target.kind === 'standard' ? target.plane : undefined,
        planeRef: target.kind === 'planeFeature'
          ? { filePath: target.option.filePath, line: target.option.line, column: target.option.column }
          : undefined,
        retarget: retarget ?? undefined,
      });
      if (this.feature !== 'sketch') {
        return; // the mode ended while the request was in flight
      }
      if (result.success) {
        // A re-pick MOVES a statement rather than writing one, so the session
        // keeps what it was: the create flow's Cancel still undoes its own
        // sketch, an edit session still exits without touching the code.
        this.sketchSession = {
          tracking: true,
          label,
          created: repick ? prev!.created : true,
          breakpoint: repick ? prev!.breakpoint : false,
          consumed: repick ? prev!.consumed : false,
        };
        this.syncSketchPanelMode();
        this.sketchPanel.setTarget(label);
        this.sketchPanel.setMessage(null);
        // The editor round-trip re-renders the scene; the incoming render
        // enters the (new or moved) sketch — the resume stays lazy.
        this.exitSketchPicking('lazy');
      } else {
        this.sketchPanel.setMessage(result.reason ?? 'Could not start the sketch.');
      }
    } finally {
      this.applying = false;
    }
  }

  /**
   * `resume: 'lazy'` re-enables sketch editing without forcing the mode
   * transition — used when a render is already on its way (an apply went
   * through, or the exit was scene-driven). User cancels default to
   * `'immediate'`, which restores the suspended sketch view right now.
   * Ending an edit session always resumes lazily — every session end is
   * followed by a render (the cancel-restore rollback, an apply's rebuild,
   * Continue's full render).
   */
  exit(opts: { resume?: 'immediate' | 'lazy'; editEnd?: 'apply' | 'cancel' | 'continue' | 'gone' } = {}): void {
    if (this.feature === 'sketch' || (!this.feature && this.sketchSession)) {
      // The sketch flow lives in its dialog — exit means closing it, in the
      // armed-pick state and the tracking state alike. A user close, so the
      // dialog stays dismissed for this sketch.
      this.markSketchDismissed();
      this.closeSketchSession(opts.resume ?? 'immediate');
      return;
    }
    if (!this.feature) {
      return;
    }
    const hadSession = this.session.active;
    this.session.end(opts.editEnd ?? 'cancel');
    this.feature = null;
    this.editTarget = null;
    this.editArgsText = null;
    this.seedSignature = null;
    this.editSceneStale = false;
    if (hadSession) {
      opts = { ...opts, resume: 'lazy' };
    }
    this.viewer.pickFilter = 'all';
    this.syncPlanePicking();
    this.viewer.hideStandardPlanes();
    this.selection.clear();
    this.cancelPreview();
    // The overlay is a `compiledMesh` sibling, so no render tears it down —
    // every way out of the dialog has to drop it explicitly. This one covers
    // apply, cancel, Escape, and the scene-driven exits alike.
    this.cancelGhost();
    this.ghost.clear();
    this.panel.expression.hide();
    this.tooltip.hide();
    this.selectionMenu.hide();
    this.viewer.clearHighlight();
    this.panel.setVisible(false);
    this.panel.setMessage(null);
    this.syncButtons();
    this.sketchUI.resume((opts.resume ?? 'immediate') === 'immediate');
  }

  /** A shown origin plane was clicked while the sketch pick was armed. */
  private readonly onPlanePick = (plane: StandardPlaneId): void => {
    void this.applySketchTarget({ kind: 'standard', plane });
  };

  /**
   * A `plane(…)` quad was clicked (the armed sketch pick and neutral mode
   * both enable `viewer.pickPlanes`). Armed: sketch on that plane feature
   * right away — `sketch(<planeVar>, () => {})`, referencing the statement
   * by call site. Neutral: hold the plane highlighted as the pending sketch
   * plane; the Sketch button consumes it (clicking the quad again releases).
   */
  handlePlanePick(shapeId: string): void {
    if (this.feature !== null && this.feature !== 'sketch') {
      return;
    }
    const plane = resolvePlaneByShapeId(shapeId, this.viewer.currentSceneObjects);
    const option = plane?.sourceLocation
      ? planeOptionForLocation(this.planes, plane.sourceLocation)
      : undefined;
    if (!option) {
      if (this.feature === 'sketch') {
        this.sketchPanel.setMessage('That plane cannot be referenced — only plane() features can be sketched on.');
      }
      return;
    }
    if (this.feature === 'sketch') {
      this.viewer.highlightPlaneQuad(shapeId);
      void this.applySketchTarget({ kind: 'planeFeature', option });
      return;
    }
    // Neutral mode: toggle the pending selection.
    if (this.pendingPlaneShapeId === shapeId) {
      this.pendingPlaneShapeId = null;
      this.viewer.clearHighlight();
      return;
    }
    this.pendingPlaneShapeId = shapeId;
    this.viewer.highlightPlaneQuad(shapeId);
  }

  /** The neutral-mode pending plane quad's shape id, or null (seeds dialogs). */
  get pendingPlane(): string | null {
    return this.pendingPlaneShapeId;
  }

  /** Drop the neutral-mode pending plane (something else was clicked). */
  clearPendingPlane(): void {
    if (this.pendingPlaneShapeId === null) {
      return;
    }
    this.pendingPlaneShapeId = null;
    this.viewer.clearHighlight();
  }

  /**
   * A create dialog (extrude/sweep/loft/…) is opening: the sketch dialog
   * steps aside (its sketch stays; extruding it is the natural next step),
   * remembering a live session so the dialog can come back when the create
   * dialog exits with the sketch still active. The dialogs' onEnter wiring
   * calls this ahead of the generic exit() sweep — by the time
   * setCreateDialogActive(true) fires the session would already be gone.
   */
  displaceSketchSession(): void {
    if (this.sketchSession) {
      this.displacedSketch = { ...this.sketchSession };
    }
    this.closeSketchSession();
  }

  /** An extrude/sweep/loft dialog opened or closed — the Sketch button disables while one is up. */
  setCreateDialogActive(active: boolean): void {
    if (this.createDialogActive === active) {
      return;
    }
    this.createDialogActive = active;
    if (active) {
      this.pendingPlaneShapeId = null;
      // An opening create dialog takes over — the sketch dialog steps aside
      // (usually already displaced via the dialog's onEnter wiring).
      this.displaceSketchSession();
    } else {
      this.restoreDisplacedSketchSession();
    }
    this.syncPlanePicking();
    this.syncButtons();
  }

  /**
   * The create dialog that displaced the sketch dialog is gone — bring the
   * dialog back in its tracking state while the scene still ends in the
   * sketch. An apply that consumed the sketch restores it too (the scene
   * state is still the pre-apply one here), but the incoming render closes
   * the session again via update(). No-op without a displaced session.
   */
  private restoreDisplacedSketchSession(): void {
    const displaced = this.displacedSketch;
    this.displacedSketch = null;
    if (displaced === null || !this.sceneSketchActive
      || this.feature !== null || this.sketchSession !== null) {
      return;
    }
    this.sketchSession = { ...displaced, tracking: true };
    this.syncSketchPanelMode();
    this.sketchPanel.setTarget(displaced.label);
    this.sketchPanel.setMessage(null);
    this.sketchPanel.show();
  }

  /**
   * The viewer's plane-quad channel: live while the sketch mode is armed AND
   * in neutral mode (no feature, no create dialog) — a quad clicked there is
   * held as the pending sketch plane. The pick features (fillet/chamfer/
   * shell) and the create dialogs must never have quads intercept their
   * face/edge clicks.
   */
  private syncPlanePicking(): void {
    this.viewer.pickPlanes = this.feature === 'sketch'
      || (this.feature === null && !this.createDialogActive);
  }

  /**
   * Routes viewer clicks while the mode is armed. Plain clicks accumulate
   * (fillet is inherently multi-pick); clicking a selected entity deselects
   * it (a chain member deselects its whole chain); clicking empty space keeps
   * the selection (misclicks shouldn't wipe it).
   */
  handleClick(shapeId: string | null, sub: SubSelection): void {
    if (!this.feature || !shapeId || !sub || sub.type === 'sketch' || sub.type === 'axis' || sub.type === 'plane' || sub.type === 'connector') {
      return;
    }
    this.selectionMenu.hide();
    const entity: SelectedEntity = { shapeId, sub };
    if (this.feature === 'sketch') {
      // The single pick IS the apply: the click replaces the selection and
      // starts (or moves) the sketch.
      this.selection.entities = [entity];
      this.selection.chains = [];
      this.viewer.highlightEntities(this.selection.entities);
      void this.applySketchTarget({ kind: 'face', entity });
      return;
    }
    this.panel.setMessage(null);
    this.toggleEntity(entity);
  }

  /** Toggle a plain pick; a chain member toggles its whole chain off. */
  private toggleEntity(entity: SelectedEntity): void {
    this.selection.toggle(entity);
    if (this.selection.entities.length > 0) {
      this.viewer.highlightEntities(this.selection.entities);
    } else {
      this.viewer.clearHighlight();
    }
    this.refresh();
  }

  /**
   * Double-click: expand the pick to its whole classified bucket ("the whole
   * top rim"). The gesture's own two single clicks have already toggled the
   * entity; the expansion merges every surviving bucket member as a plain
   * pick, so the seed ends up selected either way.
   */
  async handleDoubleClick(shapeId: string | null, sub: SubSelection): Promise<void> {
    if (!this.feature || !shapeId || !sub || sub.type === 'sketch' || sub.type === 'axis' || sub.type === 'plane' || sub.type === 'connector') {
      return;
    }
    if (this.feature === 'sketch') {
      // The single-pick sketch has no bucket expansion — the first click
      // already applied.
      return;
    }
    this.selectionMenu.hide();
    this.tooltip.hide();

    const entity: SelectedEntity = { shapeId, sub };
    const result = await expandBucket(entity, this.session.boundary ?? undefined);
    if (!this.feature) {
      return;
    }
    if ('error' in result) {
      this.panel.setMessage(result.error);
      return;
    }
    this.panel.setMessage(null);
    this.mergeEntities(result.members.map(m => ({ shapeId: m.shapeId, sub: m.sub })));
  }

  /** Merge group members into the selection as plain picks. */
  private mergeEntities(members: SelectedEntity[]): void {
    if (!this.selection.merge(members)) {
      return;
    }
    this.viewer.highlightEntities(this.selection.entities);
    this.refresh();
  }

  /** Teach-mode tooltip: hover → attribution expression, debounced + cached. */
  handleHover(shapeId: string | null, sub: SubSelection, clientX: number, clientY: number): void {
    this.tooltip.handleHover(shapeId, sub, clientX, clientY);
  }

  /** Right-click on an edge/face: the multi-select menu for that pick. */
  handleContextMenu(shapeId: string | null, sub: SubSelection, clientX: number, clientY: number): void {
    if (!this.feature || this.feature === 'sketch') {
      return;
    }
    this.selectionMenu.hide();
    if (!shapeId || !sub || sub.type === 'sketch' || sub.type === 'axis' || sub.type === 'plane' || sub.type === 'connector') {
      return;
    }
    this.tooltip.hide();
    // The hover tint would otherwise be stashed as an "original" color by the
    // preview highlight and stick around after the preview restores it.
    this.viewer.clearHover();
    void this.selectionMenu.open({ shapeId, sub }, clientX, clientY);
  }

  /** A multi-select menu group was clicked. */
  private applyGroup(kind: SelectionGroupKind, seed: SelectedEntity, members: SelectedEntity[]): void {
    if (!this.feature) {
      return;
    }
    if (kind === 'tangent') {
      // Tangent chains stay chains — they synthesize to `.withTangents()`.
      this.panel.setMessage(null);
      this.selection.addChain(seed, members);
      this.viewer.highlightEntities(this.selection.entities);
      this.refresh();
    } else {
      this.panel.setMessage(null);
      this.mergeEntities(members);
    }
  }

  /** Menu-hover preview: show the selection as the hovered click would leave it. */
  private previewSelection(members: SelectedEntity[] | null): void {
    if (!this.feature) {
      return;
    }
    const shown = members ? mergeUniqueEntities(this.selection.entities, members) : this.selection.entities;
    if (shown.length > 0) {
      this.viewer.highlightEntities(shown);
    } else {
      this.viewer.clearHighlight();
    }
  }

  private async apply(): Promise<void> {
    if (!this.feature || this.feature === 'sketch' || this.applying) {
      return;
    }
    const config = FEATURES[this.feature];
    // Create mode needs picks; an edit whose seeded selection was emptied
    // out has nothing to synthesize either (an untouched empty seed is fine
    // — the statement's own args stay verbatim).
    if (this.selection.isEmpty && (!this.editTarget || this.picksDirty())) {
      this.panel.setMessage(config.pickFilter === 'face'
        ? 'Pick a face first.'
        : 'Pick at least one edge or face first.');
      return;
    }
    let value: ValueExpr | null = null;
    let newVariables: NewVariable[] | undefined;
    if (config.valueLabel !== null) {
      const read = this.panel.valueField.read();
      const invalid = 'error' in read
        || (typeof read.value === 'number'
          && (config.valueSign === 'positive' ? read.value <= 0 : read.value === 0));
      if (invalid) {
        this.panel.setMessage(config.valueSign === 'nonzero'
          ? `Enter a nonzero ${config.valueLabel.toLowerCase()} (${config.negativeHint}).`
          : `Enter a positive ${config.valueLabel.toLowerCase()}.`);
        return;
      }
      value = read.value;
      newVariables = read.newVariable ? [read.newVariable] : undefined;
    }
    let chamfer: { distance2: ValueExpr | null; isAngle: boolean } | undefined;
    if (this.feature === 'chamfer') {
      const read2 = this.readChamferValues();
      if ('error' in read2) {
        this.panel.setMessage(read2.error);
        return;
      }
      chamfer = { distance2: read2.distance2, isAngle: read2.isAngle };
      if (read2.newVariable) {
        newVariables = [...(newVariables ?? []), read2.newVariable];
      }
    }

    if (this.editTarget) {
      // In-place statement edit. A re-picked (dirty) selection rides as
      // picks for synthesis against the pre-statement boundary; otherwise
      // the selector args stay verbatim unless the expression row was
      // edited away from its baseline (the statement's own text, or the
      // last synthesized preview when picks are dirty).
      const dirty = this.picksDirty();
      const baseline = dirty ? this.panel.expression.synthesizedArgs : this.editArgsText;
      const editedArgs = this.panel.expression.value;
      const selectorOverride = editedArgs !== '' && editedArgs !== baseline
        ? editedArgs
        : undefined;
      this.applying = true;
      this.panel.setApplyEnabled(false);
      try {
        const result = await applyValueFeatureEdit(
          this.feature as 'shell' | 'fillet' | 'chamfer' | 'offset',
          this.editTarget,
          {
            value: value!,
            selectorOverride,
            joinType: this.shellJoinType() ?? undefined,
            distance2: chamfer?.distance2,
            isAngle: chamfer?.isAngle,
            newVariables,
            expectedStatement: this.session.expectedStatement,
            before: dirty ? this.session.boundary ?? undefined : undefined,
            entities: dirty ? this.selection.entities : undefined,
            chains: dirty ? this.selection.apiChains() : undefined,
          },
        );
        if (result.success) {
          this.exit({ editEnd: 'apply' });
        } else {
          this.panel.setMessage(result.reason ?? 'Could not apply the edit.');
        }
      } finally {
        this.applying = false;
        this.panel.setApplyEnabled(true);
      }
      return;
    }

    const edited = this.panel.expression.value;
    const synthesized = this.panel.expression.synthesizedArgs;
    const selectorOverride = synthesized !== null && edited !== '' && edited !== synthesized
      ? edited
      : undefined;

    this.applying = true;
    this.panel.setApplyEnabled(false);
    try {
      const result = await applyFeature(this.feature, value, this.selection.entities, {
        chains: this.selection.apiChains(),
        selectorOverride,
        joinType: this.shellJoinType() ?? undefined,
        distance2: chamfer?.distance2,
        isAngle: chamfer?.isAngle,
        newVariables,
      });
      if (result.success) {
        // The editor round-trip re-renders the scene; that render is the
        // preview and editor undo is the rollback. A suspended sketch UI
        // resumes lazily — the incoming render enters the new sketch.
        this.exit({ resume: 'lazy' });
      } else {
        this.panel.setMessage(result.reason ?? 'Could not apply the feature.');
      }
    } finally {
      this.applying = false;
      this.panel.setApplyEnabled(true);
    }
  }

  private refresh(): void {
    if (!this.feature) {
      return;
    }
    if (this.feature === 'sketch') {
      // The sketch dialog's whole armed UI is the prompt; it also offers
      // the origin planes — alone when nothing has faces.
      this.sketchPanel.setPicking(this.sketchAvailable ? 'Pick a face or plane' : 'Pick a plane');
      this.syncButtons();
      return;
    }
    const config = FEATURES[this.feature];
    // Every pick is a removable chip: one per plain pick, a whole tangent
    // chain as a single chip — its ✕ removes the chain like a viewport click
    // on a member would.
    this.chipRows = this.selection.chipRows();
    this.panel.setChips(this.chipRows.map((row, index) => ({
      label: row.label,
      badge: String(index + 1),
      removable: true,
    })));
    // Empty selection: prompt for the first pick; face-only features ask for
    // a face, the rest an edge.
    if (this.chipRows.length === 0) {
      this.panel.setPrompt(`Pick ${config.pickFilter === 'face' ? 'faces' : 'edges'}`);
    } else {
      this.panel.setPrompt(null);
    }
    this.syncButtons();
    this.schedulePreview();
    this.scheduleGhost();
  }

  // -------------------------------------------------------------------------
  // Expression transparency: debounced synthesis preview + alternatives
  // -------------------------------------------------------------------------

  private schedulePreview(): void {
    this.cancelPreview();
    if (!this.feature) {
      return;
    }
    if (this.editTarget) {
      // The expression row holds the statement's own args (or the last
      // synthesis) — nothing to re-synthesize until the picks change.
      if (!this.picksDirty() || this.selection.isEmpty) {
        return;
      }
    } else if (this.selection.isEmpty) {
      this.panel.expression.hide();
      return;
    }
    this.previewTimer = window.setTimeout(() => {
      this.previewTimer = null;
      this.runPreview();
    }, PREVIEW_DEBOUNCE_MS);
  }

  private async runPreview(): Promise<void> {
    if (!this.feature || this.applying) {
      return;
    }
    const seq = ++this.previewSeq;
    this.previewAbort?.abort();
    const abort = new AbortController();
    this.previewAbort = abort;

    // The argument list is independent of the numeric parameter; any valid
    // value satisfies the endpoint (sketch has none at all).
    const config = FEATURES[this.feature];
    let previewValue: ValueExpr | null = null;
    if (config.valueLabel !== null) {
      const read = this.panel.valueField.read();
      const valid = !('error' in read)
        && (typeof read.value !== 'number'
          || (config.valueSign === 'positive' ? read.value > 0 : read.value !== 0));
      previewValue = valid && !('error' in read) ? read.value : config.defaultValue!;
    }
    // The chamfer second value doesn't shape the selector args either, but
    // the request must stay valid — an unparsable field falls back to the
    // kind's default just like the main value does.
    let chamferPreview: { distance2: ValueExpr | null; isAngle: boolean } | undefined;
    if (this.feature === 'chamfer') {
      const read2 = this.readChamferValues();
      chamferPreview = 'error' in read2
        ? {
          distance2: this.chamferKind === 'equal' ? null
            : this.chamferKind === 'angle' ? DEFAULT_CHAMFER_ANGLE : config.defaultValue!,
          isAngle: this.chamferKind === 'angle',
        }
        : { distance2: read2.distance2, isAngle: read2.isAngle };
    }

    let result: ApplyFeatureResponse;
    try {
      result = this.editTarget
        ? await applyValueFeatureEdit(this.feature as 'shell' | 'fillet' | 'chamfer' | 'offset', this.editTarget, {
          value: previewValue!,
          joinType: this.shellJoinType() ?? undefined,
          distance2: chamferPreview?.distance2,
          isAngle: chamferPreview?.isAngle,
          expectedStatement: this.session.expectedStatement,
          before: this.session.boundary ?? undefined,
          entities: this.selection.entities,
          chains: this.selection.apiChains(),
          preview: true,
          signal: abort.signal,
        })
        : await applyFeature(this.feature, previewValue, this.selection.entities, {
          chains: this.selection.apiChains(),
          distance2: chamferPreview?.distance2,
          isAngle: chamferPreview?.isAngle,
          preview: true,
          signal: abort.signal,
        });
    } catch {
      return; // aborted
    }
    if (seq !== this.previewSeq || !this.feature) {
      return;
    }

    if (result.success && typeof result.args === 'string') {
      this.panel.expression.show(result.args, result.alternatives ?? []);
      this.syncExprPrefix();
      this.panel.setMessage(null);
    } else if (this.editTarget) {
      // Keep the expression row (it still shows a valid baseline) and
      // surface the refusal — an unsynthesizable pick, a drifted statement.
      this.panel.setMessage(result.reason ?? 'Could not synthesize a selector.');
    } else {
      this.panel.expression.hide();
      this.panel.setMessage(result.reason ?? 'Could not synthesize a selector.');
    }
  }

  private syncExprPrefix(): void {
    if (!this.feature) {
      return;
    }
    const config = FEATURES[this.feature];
    if (config.valueLabel === null) {
      this.panel.expression.setPrefix(`${this.feature}(`);
      return;
    }
    const value = this.panel.valueText.trim() || String(config.defaultValue);
    if (this.feature === 'chamfer' && this.chamferKind !== 'equal') {
      const second = this.panel.value2Text.trim()
        || String(this.chamferKind === 'angle' ? DEFAULT_CHAMFER_ANGLE : config.defaultValue);
      this.panel.expression.setPrefix(this.chamferKind === 'angle'
        ? `chamfer(${value}, ${second}, true, `
        : `chamfer(${value}, ${second}, `);
      return;
    }
    this.panel.expression.setPrefix(`${this.feature}(${value}, `);
  }

  /** The join dropdown's value while a shell dialog is up, or null. */
  private shellJoinType(): ShellJoinType | null {
    if (this.feature !== 'shell') {
      return null;
    }
    return this.panel.joinValue;
  }

  /**
   * Show the chamfer rows for `kind` and seed the second-value field: the
   * statement's own value on an edit open (`seed`), else the last one entered
   * for that kind within this arming, else the kind's default.
   */
  private applyChamferControls(kind: ChamferKind, seed?: ValueExpr | null): void {
    this.chamferKind = kind;
    this.panel.setChamferControls(kind);
    if (kind === 'equal') {
      return;
    }
    if (seed !== undefined && seed !== null) {
      this.panel.value2Field.setValue(seed);
      return;
    }
    const remembered = this.chamferValue2.get(kind);
    this.panel.value2Field.setValue(remembered !== undefined && remembered.trim() !== ''
      ? remembered
      : String(kind === 'angle' ? DEFAULT_CHAMFER_ANGLE : FEATURES.chamfer.defaultValue));
  }

  /**
   * The chamfer dialog's second-value slot, read and range-checked (a
   * numeric second distance must be positive; a numeric angle inside
   * (0, 90)). Equal-distance mode reads as no second value.
   */
  private readChamferValues():
    | { distance2: ValueExpr | null; isAngle: boolean; newVariable?: NewVariable }
    | { error: string } {
    if (this.feature !== 'chamfer' || this.chamferKind === 'equal') {
      return { distance2: null, isAngle: false };
    }
    const isAngle = this.chamferKind === 'angle';
    const read = this.panel.value2Field.read();
    const invalid = 'error' in read
      || (typeof read.value === 'number'
        && (read.value <= 0 || (isAngle && read.value >= 90)));
    if (invalid || 'error' in read) {
      return {
        error: isAngle
          ? 'Enter an angle between 0 and 90 degrees.'
          : 'Enter a positive second distance.',
      };
    }
    return { distance2: read.value, isAngle, newVariable: read.newVariable };
  }

  /** A non-default shell join shows as a `.join()` chain after the args. */
  private syncExprSuffix(): void {
    if (!this.feature) {
      return;
    }
    const join = this.shellJoinType();
    this.panel.expression.setSuffix(join && join !== 'arc'
      ? `${FEATURES[this.feature].exprSuffix}.join('${join}')`
      : FEATURES[this.feature].exprSuffix);
  }

  private cancelPreview(): void {
    if (this.previewTimer !== null) {
      window.clearTimeout(this.previewTimer);
      this.previewTimer = null;
    }
    this.previewAbort?.abort();
    this.previewAbort = null;
    this.previewSeq++;
  }

  // -------------------------------------------------------------------------
  // Live geometry preview ("ghost"): the bands a fillet/chamfer would lay
  // -------------------------------------------------------------------------

  /**
   * Fillet and chamfer ghost; shell and sketch don't (yet). A shell's ghost
   * would be the whole hollowed body — the same full-model cost the band
   * approach exists to avoid — and sketch has no geometry of its own.
   */
  private ghostFeature(): 'fillet' | 'chamfer' | null {
    return this.feature === 'fillet' || this.feature === 'chamfer' ? this.feature : null;
  }

  private scheduleGhost(): void {
    this.cancelGhost();
    if (!this.ghostFeature() || this.selection.isEmpty) {
      // Nothing picked yet, or a feature with no ghost — drop what's drawn
      // rather than leave a stale band hanging over the model.
      this.ghost.clear();
      return;
    }
    this.ghostTimer = window.setTimeout(() => {
      this.ghostTimer = null;
      void this.runGhost();
    }, PREVIEW_DEBOUNCE_MS);
  }

  private async runGhost(): Promise<void> {
    const feature = this.ghostFeature();
    if (!feature || this.applying) {
      return;
    }
    const seq = ++this.ghostSeq;
    this.ghostAbort?.abort();
    const abort = new AbortController();
    this.ghostAbort = abort;

    // A half-typed value has no ghost, and neither does a bad one — unlike the
    // statement preview, which falls back to the default so the args still
    // synthesize. Here the number IS the geometry: standing in for it would
    // draw a band the user never asked for.
    const read = this.panel.valueField.read();
    if ('error' in read || (typeof read.value === 'number' && read.value <= 0)) {
      this.ghost.clear();
      return;
    }
    const chamfer = this.readChamferValues();
    if ('error' in chamfer) {
      this.ghost.clear();
      return;
    }

    const solids = await fetchFeatureGhost({
      feature,
      value: read.value,
      distance2: feature === 'chamfer' ? chamfer.distance2 : null,
      isAngle: feature === 'chamfer' && chamfer.isAngle,
      edges: this.ghostEdges(),
    }, abort.signal).catch(() => null);

    if (seq !== this.ghostSeq || this.ghostFeature() !== feature) {
      return;
    }
    if (solids) {
      this.ghost.set(solids, 'remove');
    } else {
      this.ghost.clear();
    }
  }

  /**
   * The picks on the ghost wire. A picked FACE travels as a face, not as
   * nothing: fillet and chamfer explode faces into their edges at build time
   * (fillet.ts:63), so the kernel does the same for the ghost. Tangent chains
   * need no special handling — their members are merged into the entity list
   * when the chain is picked.
   */
  private ghostEdges(): { shapeId: string; index: number; kind: 'edge' | 'face' }[] {
    return this.selection.entities.map(entity => ({
      shapeId: entity.shapeId,
      index: entity.sub.index,
      kind: entity.sub.type,
    }));
  }

  private cancelGhost(): void {
    if (this.ghostTimer !== null) {
      window.clearTimeout(this.ghostTimer);
      this.ghostTimer = null;
    }
    this.ghostAbort?.abort();
    this.ghostAbort = null;
    this.ghostSeq++;
  }

  /**
   * Create the Offset button in its own toolbar group. Called from main.ts
   * AFTER the boolean service registers its group — navbar groups render in
   * registration order, and Offset sits right after the boolean tools.
   */
  mountOffsetButton(): void {
    const host = this.navbar.addGroup('offset', { visible: false });
    const config = FEATURES.offset;
    const button = new FeatureButton(host, {
      icon: '/icons/offset.png',
      label: config.label,
      tip: config.buttonTitle,
      ariaLabel: config.buttonTitle,
    });
    button.onClick = () => {
      if (this.feature === 'offset') {
        this.exit();
      } else {
        this.enter('offset');
      }
    };
    this.buttons.set('offset', button);
    this.syncOffsetButton();
  }

  /**
   * The neutral-mode selection changed (measure owns it) — the Offset button
   * shows exactly while a face is highlighted, so the tool is offered where
   * it can act and stays out of the toolbar otherwise.
   */
  noteNeutralSelection(selection: SelectedEntity[]): void {
    this.neutralFaceHighlighted = selection.some(e => e.sub.type === 'face');
    this.syncOffsetButton();
  }

  /** Offset's group shows with the modify tools, gated on a highlighted face (or its own armed mode). */
  private syncOffsetButton(): void {
    this.navbar.setGroupVisible('offset', this.modifyVisible
      && (this.neutralFaceHighlighted || this.feature === 'offset'));
  }

  private syncButtons(): void {
    for (const [kind, btn] of this.buttons) {
      btn.setActive(this.feature === kind
        || (kind === 'sketch' && this.sketchSession !== null));
    }
    // Arming/exiting offset changes its button's visibility gate.
    this.syncOffsetButton();
    // The sketch button never hides (it votes its create group visible on
    // every render); it disables while another feature dialog is up — an
    // extrude/sweep/loft dialog, or this service's own fillet/chamfer/shell.
    this.buttons.get('sketch')!.setDisabled(this.createDialogActive
      || (this.feature !== null && this.feature !== 'sketch'));
  }

}
