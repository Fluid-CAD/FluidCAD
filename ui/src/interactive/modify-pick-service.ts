import {
  applyFeature, applyValueFeatureEdit, expandBucket, explainSelection, fetchFeatureSources, parseFeatureAt,
  removeFeature, ApplyFeatureChain, ApplyFeatureResponse, FeatureEditTarget, ParsedFeatureStatement,
  SelectionGroupKind, ShellJoinType, SketchSourceRef,
} from '../api';
import { entityKey, mergeUniqueEntities, sameEntity, selectionChipRows } from '../helpers/entities';
import { isTopLevel } from '../helpers/scene-utils';
import { collectPlaneOptions, PlaneOption, resolvePlaneByShapeId } from './create-feature/plane-bases';
import { SketchStartPanel } from './create-feature/sketch-panel';
import { EditSession, EditSessionInfo } from './edit-session';
import { PickSlot } from './pick-slot';
import { SelectionContextMenu } from './selection-menu';
import { StandardPlaneId } from '../scene/standard-planes';
import { SceneObjectRender, SubSelection } from '../types';
import { SelectedEntity, Viewer } from '../viewer';
import { Navbar } from '../ui/navbar';
import { ICON_IMG_FALLBACK } from '../ui/object-icons';

export type ModifyFeatureKind = 'sketch' | 'fillet' | 'chamfer' | 'shell';

type FeatureConfig = {
  label: string;
  buttonTitle: string;
  /** Value-row label; null hides the row (the feature has no numeric parameter). */
  valueLabel: string | null;
  defaultValue: number | null;
  /** What `pickAt()` may return while the mode is armed. */
  pickFilter: 'all' | 'face';
  /** Positive-only value, or any nonzero (shell hollows inward with a negative). */
  valueSign: 'positive' | 'nonzero' | null;
  /** Show the join-type dropdown (shell's arc/intersection/tangent). */
  joinRow: boolean;
  /** Static text after the editable args in the expression row. */
  exprSuffix: string;
};

/**
 * Toolbar order — Sketch first, then Fillet, Chamfer, Shell. Sketch renders
 * in the create group (shared with Extrude, immune to the sketch-toolbar
 * takeover); the rest form the modify group.
 */
const FEATURE_ORDER: ModifyFeatureKind[] = ['sketch', 'fillet', 'chamfer', 'shell'];

const FEATURES: Record<ModifyFeatureKind, FeatureConfig> = {
  // Sketch never enters the shared value/expression bar — only its label,
  // buttonTitle and pickFilter are live; it runs the dialog flow instead.
  sketch: {
    label: 'Sketch', buttonTitle: 'Sketch on a face or a plane', valueLabel: null, defaultValue: null,
    pickFilter: 'face', valueSign: null, joinRow: false, exprSuffix: ')',
  },
  fillet: {
    label: 'Fillet', buttonTitle: 'Fillet edges', valueLabel: 'Radius', defaultValue: 1,
    pickFilter: 'all', valueSign: 'positive', joinRow: false, exprSuffix: ')',
  },
  chamfer: {
    label: 'Chamfer', buttonTitle: 'Chamfer edges', valueLabel: 'Distance', defaultValue: 1,
    pickFilter: 'all', valueSign: 'positive', joinRow: false, exprSuffix: ')',
  },
  shell: {
    label: 'Shell', buttonTitle: 'Shell', valueLabel: 'Thickness', defaultValue: -2,
    pickFilter: 'face', valueSign: 'nonzero', joinRow: true, exprSuffix: ')',
  },
};

/**
 * Same artwork the timeline shows for the feature (`/icons/<type>.png`). The
 * toolbar buttons render it at 32px (`w-8 h-8`); the dialog title keeps the
 * smaller default that sits proportionally beside its `text-sm` heading.
 */
function featureIconImg(kind: ModifyFeatureKind, sizeClass = 'w-4 h-4'): string {
  return `<img src="/icons/${kind}.png" ${ICON_IMG_FALLBACK} class="${sizeClass} object-contain" alt="" />`;
}

const BTN_BASE = 'btn btn-ghost btn-sm h-auto flex-col gap-0.5 px-2 py-1 text-base-content/60';
const BTN_ACTIVE = 'btn btn-soft btn-primary btn-sm h-auto flex-col gap-0.5 px-2 py-1';
/** Small muted caption under the toolbar icon. */
const BTN_LABEL = 'text-[10px] leading-none text-base-content/50';

const PREVIEW_DEBOUNCE_MS = 250;
const TOOLTIP_DEBOUNCE_MS = 200;

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
 * Sketch button / Escape; its Cancel button goes further and deletes the
 * sketch statement from the code outright. The dialog is scene-derived like
 * the rest of sketch mode: a render whose scene ends in a sketch with no
 * session ADOPTS it (page reloads, sketches entered by editing code), with
 * the chip label parsed from the statement's target argument — except a
 * sketch whose dialog the user dismissed, which stays closed. The button lives in the create group and is always
 * offered — in an empty scene the planes are the only targets, and the first
 * sketch starts here; while an extrude/sweep/loft dialog is up the button
 * disables instead of hiding.
 */
export class ModifyPickService {
  private feature: ModifyFeatureKind | null = null;
  private entities: SelectedEntity[] = [];
  private chains: { seed: SelectedEntity; members: SelectedEntity[] }[] = [];
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
   * The sketch dialog session, alive from the first successful pick until
   * the scene stops ending in that sketch (or the dialog is closed). While
   * `tracking` the chip shows `label` and the service is otherwise neutral;
   * with `tracking` false the pick mode is re-armed after the chip's ✕ and
   * the next pick retargets the active sketch statement instead of creating
   * a new one. Null with `feature === 'sketch'` is the initial pick — a
   * fresh arming whose first pick creates the sketch.
   */
  private sketchSession: { tracking: boolean; label: string } | null = null;
  /**
   * The label of a sketch session a create dialog displaced — the dialog
   * stepped aside so extrude/sweep/… could take the stage. Consumed when the
   * create dialog deactivates: the sketch dialog comes back tracking if the
   * scene still ends in its sketch. Dropped when the sketch stops being the
   * scene's tail or another flow starts. User closes never set it.
   */
  private displacedSketchLabel: string | null = null;
  /**
   * Source key (`file:line:col`) of a trailing sketch whose dialog the user
   * dismissed — adoption skips it, so a closed dialog stays closed across
   * the renders every drawn entity triggers. Reset when the scene stops
   * ending in a sketch.
   */
  private dismissedSketchKey: string | null = null;
  /** The scene ends with an unconsumed sketch (scene-derived sketch mode). */
  private sceneSketchActive = false;
  /** Sketch editing is suspended while the sketch-on-face pick is armed. */
  private suspendedSketchUI = false;
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

  private buttons = new Map<ModifyFeatureKind, HTMLButtonElement>();
  private sketchPanel: SketchStartPanel;
  private activeBar: HTMLDivElement;
  private titleIcon: HTMLElement;
  private titleText: HTMLElement;
  private valueWrap: HTMLElement;
  private valueLabel: HTMLElement;
  private valueInput: HTMLInputElement;
  private joinWrap: HTMLElement;
  private joinSelect: HTMLSelectElement;
  private selectionSlot: PickSlot;
  /** The rendered selection chip rows — chip index to pick members. */
  private chipRows: { label: string; members: SelectedEntity[] }[] = [];
  private applyBtn: HTMLButtonElement;
  private message: HTMLDivElement;
  private applying = false;
  /** Last entered value per feature — a fillet radius makes a bad shell thickness. */
  private valueByFeature = new Map<ModifyFeatureKind, string>();
  /** Last chosen shell join type — restored the next time shell arms. */
  private lastJoinType: ShellJoinType = 'arc';

  private exprRow: HTMLDivElement;
  private exprPrefix: HTMLElement;
  private exprInput: HTMLInputElement;
  private exprSuffix: HTMLElement;
  private altBtn: HTMLButtonElement;
  private altMenu: HTMLDivElement;
  private synthesizedArgs: string | null = null;
  private alternatives: string[] = [];
  private previewTimer: number | null = null;
  private previewAbort: AbortController | null = null;
  private previewSeq = 0;

  private tooltip: HTMLDivElement;
  private tooltipTimer: number | null = null;
  private tooltipAbort: AbortController | null = null;
  private tooltipCache = new Map<string, string>();

  private selectionMenu: SelectionContextMenu;

  constructor(
    private container: HTMLElement,
    private viewer: Viewer,
    private navbar: Navbar,
    private hooks: {
      onEnter?: () => SelectedEntity[] | void;
      /** Sketch-on-face armed while a sketch is edited — release the sketch UI. */
      onSuspendSketchUI?: () => void;
      /** The suspension ended without an apply — restore the sketch UI. */
      onResumeSketchUI?: () => void;
    } = {},
  ) {
    const group = navbar.addGroup('modify', { visible: false });
    const createHost = navbar.getGroup('create') ?? navbar.addGroup('create', { visible: false, immune: true });
    for (const kind of FEATURE_ORDER) {
      const btn = document.createElement('button');
      btn.className = BTN_BASE;
      btn.setAttribute('aria-label', FEATURES[kind].buttonTitle);
      btn.innerHTML = `${featureIconImg(kind, 'w-8 h-8')}<span class="${BTN_LABEL}">${FEATURES[kind].label}</span>`;
      btn.addEventListener('click', () => {
        if (this.feature === kind) {
          this.exit();
        } else {
          this.enter(kind);
        }
      });
      const wrap = document.createElement('span');
      wrap.className = 'tooltip tooltip-bottom';
      wrap.dataset.tip = FEATURES[kind].buttonTitle;
      wrap.appendChild(btn);
      if (kind === 'sketch') {
        // Ahead of the Extrude button, so the create group reads Sketch first.
        createHost.prepend(wrap);
      } else {
        group.appendChild(wrap);
      }
      this.buttons.set(kind, btn);
    }

    this.sketchPanel = new SketchStartPanel(container);
    this.sketchPanel.onClear = () => this.handleSketchClear();
    this.sketchPanel.onCancel = () => this.handleSketchCancel();
    this.sketchPanel.onEscape = () => this.handleSketchEscape();

    this.activeBar = document.createElement('div');
    this.activeBar.id = 'fluidcad-modify-pick-active';
    // top-[276px] matches the create-feature dialog: below the settings/
    // fit-to-view button stack (top-[196px]); right-7 aligns its right edge
    // with that button column.
    this.activeBar.className = 'absolute top-[276px] right-7 z-[999] pointer-events-auto hidden';
    this.activeBar.innerHTML = `
      <div class="flex flex-col items-end gap-1.5">
        <div class="flex flex-col items-stretch gap-3.5 w-60 bg-base-100 border border-base-300 text-base-content rounded-lg px-4 py-4 text-xs select-none shadow-md">
          <div class="flex items-center gap-2.5">
            <span class="flex items-center [&>svg]:size-4" data-role="icon"></span>
            <span data-role="title" class="font-medium text-sm">Fillet</span>
          </div>
          <div data-role="selection-slot"></div>
          <label data-role="value-wrap" class="flex flex-col gap-1.5">
            <span class="text-base-content/70" data-role="value-label">Radius</span>
            <input data-role="value" type="number" step="0.5"
              class="input input-sm input-bordered w-full text-xs" />
          </label>
          <label data-role="join-wrap" class="flex flex-col gap-1.5 hidden">
            <span class="text-base-content/70">Join type</span>
            <select data-role="join" class="select select-sm select-bordered w-full text-xs">
              <option value="arc">Arc</option>
              <option value="intersection">Intersection</option>
              <option value="tangent">Tangent</option>
            </select>
          </label>
          <div class="flex items-center gap-2 pt-1">
            <button data-role="apply" class="btn btn-primary btn-sm flex-1">Apply</button>
            <button data-role="exit" class="btn btn-ghost btn-sm">Exit</button>
          </div>
        </div>
        <div data-role="expr-row"
          class="hidden relative items-center gap-1 bg-base-100 border border-base-300 rounded-lg pl-2.5 pr-1 py-1.5 text-xs shadow-md">
          <span data-role="expr-prefix" class="font-mono text-base-content/50 select-none whitespace-nowrap"></span>
          <input data-role="expr" type="text" spellcheck="false" autocomplete="off"
            class="font-mono w-[320px] bg-transparent text-base-content outline-none" />
          <span data-role="expr-suffix" class="font-mono text-base-content/50 select-none whitespace-pre">)</span>
          <button data-role="alts" title="Alternative selectors"
            class="hidden text-base-content/50 hover:text-base-content px-1 cursor-pointer transition-colors">▾</button>
          <div data-role="alts-menu"
            class="hidden absolute top-full right-0 mt-1 z-[1000] min-w-full bg-base-100 border border-base-300 rounded-lg shadow-lg py-1"></div>
        </div>
        <div data-role="message" class="hidden max-w-[380px] bg-error text-error-content rounded-lg px-3 py-2 text-xs leading-snug shadow-md"></div>
      </div>
    `;
    container.appendChild(this.activeBar);

    this.titleIcon = this.activeBar.querySelector('[data-role="icon"]')!;
    this.titleText = this.activeBar.querySelector('[data-role="title"]')!;
    this.valueWrap = this.activeBar.querySelector('[data-role="value-wrap"]')!;
    this.valueLabel = this.activeBar.querySelector('[data-role="value-label"]')!;
    this.valueInput = this.activeBar.querySelector('[data-role="value"]')!;
    this.joinWrap = this.activeBar.querySelector('[data-role="join-wrap"]')!;
    this.joinSelect = this.activeBar.querySelector('[data-role="join"]')!;
    this.selectionSlot = new PickSlot(
      this.activeBar.querySelector('[data-role="selection-slot"]')!,
      { label: 'Selection', multiple: true },
    );
    // Picking is live the whole time a mode is armed — the slot always wears
    // the pick-target styling.
    this.selectionSlot.setArmed(true);
    this.selectionSlot.onRemove = (index) => {
      const row = this.chipRows[index];
      if (row) {
        this.toggleEntity(row.members[0]);
      }
    };
    // Hovering a chip shows just that chip's entities so the row can be told
    // apart from its siblings; leaving restores the full selection.
    this.selectionSlot.onChipHover = (index) => {
      const members = index !== null ? this.chipRows[index]?.members : undefined;
      if (members) {
        this.viewer.highlightEntities(members);
      } else {
        this.previewSelection(null);
      }
    };
    this.applyBtn = this.activeBar.querySelector('[data-role="apply"]')!;
    this.message = this.activeBar.querySelector('[data-role="message"]')!;
    this.exprRow = this.activeBar.querySelector('[data-role="expr-row"]')!;
    this.exprPrefix = this.activeBar.querySelector('[data-role="expr-prefix"]')!;
    this.exprInput = this.activeBar.querySelector('[data-role="expr"]')!;
    this.exprSuffix = this.activeBar.querySelector('[data-role="expr-suffix"]')!;
    this.altBtn = this.activeBar.querySelector('[data-role="alts"]')!;
    this.altMenu = this.activeBar.querySelector('[data-role="alts-menu"]')!;

    this.applyBtn.addEventListener('click', () => this.apply());
    this.activeBar.querySelector('[data-role="exit"]')!.addEventListener('click', () => this.exit());
    this.valueInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        this.apply();
      }
      e.stopPropagation();
    });
    this.valueInput.addEventListener('input', () => {
      if (this.feature) {
        this.valueByFeature.set(this.feature, this.valueInput.value);
      }
      this.syncExprPrefix();
    });
    this.joinSelect.addEventListener('change', () => {
      if (this.feature === 'shell') {
        this.lastJoinType = this.joinSelect.value as ShellJoinType;
      }
      this.syncExprSuffix();
    });
    this.exprInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        this.apply();
      }
      e.stopPropagation();
    });
    this.altBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this.altMenu.classList.toggle('hidden');
    });

    // Teach-mode tooltip: follows the hovered edge/face while the mode is armed.
    this.tooltip = document.createElement('div');
    this.tooltip.id = 'fluidcad-modify-pick-tooltip';
    this.tooltip.className = 'hidden absolute z-[1001] pointer-events-none max-w-[420px] '
      + 'bg-base-100/95 border border-base-300 rounded px-2 py-1 font-mono text-[11px] text-base-content shadow-md';
    container.appendChild(this.tooltip);

    // Right-click menu: multi-select groups + sibling buckets ("Select other").
    this.selectionMenu = new SelectionContextMenu(container, 'fluidcad-modify-pick-menu', {
      kinds: ['tangent', 'classified', 'same-type', 'equal', 'sibling'],
      onSelectGroup: (kind, seed, members) => this.applyGroup(kind, seed, members),
      onPreview: (members) => this.previewSelection(members),
      boundary: () => this.session.boundary ?? undefined,
    });

    document.addEventListener('click', (e) => {
      if (!this.altMenu.classList.contains('hidden')
        && !this.altMenu.contains(e.target as Node) && e.target !== this.altBtn) {
        this.altMenu.classList.add('hidden');
      }
    });

    document.addEventListener('keydown', (e) => {
      if (!this.feature) {
        return;
      }
      if (e.key === 'Escape') {
        // An open selection menu consumes Escape itself (capture phase).
        e.preventDefault();
        if (!this.altMenu.classList.contains('hidden')) {
          this.altMenu.classList.add('hidden');
          return;
        }
        if (this.feature === 'sketch') {
          this.handleSketchEscape();
          return;
        }
        this.exit();
      } else if (e.key === 'Enter'
        && this.feature !== 'sketch'
        && document.activeElement !== this.valueInput
        && document.activeElement !== this.exprInput) {
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

  /** An edit session is open (the viewport shows the pre-statement rollback). */
  get isEditing(): boolean {
    return this.editTarget !== null;
  }

  /** True while the armed sketch-on-face pick has suspended sketch editing. */
  get sketchUISuspended(): boolean {
    return this.suspendedSketchUI;
  }

  /**
   * Scene re-rendered: recompute toolbar visibility and drop the now-stale
   * selection while keeping the mode armed. The modify group needs solids
   * and no active sketch; the Sketch button (create group) is always offered
   * — its mode picks a face (starting a new sketch from inside one is a
   * supported flow) or one of the origin planes, which need no scene at all.
   */
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
      this.setMessage(null);
      this.exit({ editEnd: 'gone' });
      return;
    }
    if (state === 'waiting') {
      if (!isRollback) {
        // A full render rebuilt the scene: every seeded shape id died. The
        // re-asserting rollback is in flight; re-seed when it lands.
        this.editSceneStale = true;
      }
      return;
    }
    // At the boundary: the meshes were just rebuilt (updateView ran first).
    this.tooltipCache.clear();
    this.hideTooltip();
    this.selectionMenu.hide();
    if (this.editSceneStale) {
      this.editSceneStale = false;
      if (this.picksDirty()) {
        // The re-picked selection can't survive a scene rebuild — old shape
        // ids resolve nowhere. Reset to the statement's own selection.
        this.entities = [];
        this.chains = [];
        this.seedSignature = null;
        this.setMessage('The code changed — the re-picked selection was reset.');
      }
      void this.loadEditSources();
    }
    this.previewSelection(null);
    this.refresh();
  }

  update(sceneObjects: SceneObjectRender[]): void {
    const hasSolid = sceneObjects.some(o =>
      o.sceneShapes?.some(s => s.shapeType === 'solid' && !s.isMetaShape && !s.isGuide));
    const active = this.findActiveObject(sceneObjects);
    const sketchMode = active?.type === 'sketch';
    const modifyVisible = hasSolid && !sketchMode;

    this.tooltipCache.clear();
    this.hideTooltip();
    this.selectionMenu.hide();
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
      // and a dismissal has nothing left to suppress.
      this.displacedSketchLabel = null;
      this.dismissedSketchKey = null;
    } else if (active) {
      this.adoptActiveSketch(active);
    }
    this.navbar.setGroupVisible('modify', modifyVisible);
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
      this.entities = [];
      this.chains = [];
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
    parsed: Extract<ParsedFeatureStatement, { feature: 'shell' | 'fillet' | 'chamfer' }>,
    info: Omit<EditSessionInfo, 'target'>,
  ): void {
    // A sketch dialog in any state steps aside; its sketch stays. Lazy —
    // the session's rollback render is already on its way. The edit flow
    // supersedes any pending create-dialog restore.
    this.closeSketchSession('lazy');
    this.displacedSketchLabel = null;
    this.hooks.onEnter?.();
    this.feature = parsed.feature;
    this.editTarget = target;
    this.editArgsText = parsed.argsText;
    this.entities = [];
    this.chains = [];
    this.seedSignature = null;
    this.editSceneStale = false;
    this.cancelPreview();
    this.viewer.clearHover();
    this.viewer.clearHighlight();
    this.viewer.hideStandardPlanes();

    const config = FEATURES[parsed.feature];
    this.viewer.pickFilter = config.pickFilter;
    this.pendingPlaneShapeId = null;
    this.syncPlanePicking();
    // The session owns the view: free 3D camera over the rolled-back scene.
    this.suspendSketchUI();
    this.session.begin({ ...info, target });
    void this.loadEditSources();

    this.titleIcon.innerHTML = featureIconImg(parsed.feature);
    this.titleText.textContent = `Edit ${config.label.toLowerCase()}`;
    this.selectionSlot.setMultiple(true);
    this.valueWrap.classList.remove('hidden');
    this.valueLabel.textContent = config.valueLabel!;
    if (config.valueSign === 'positive') {
      this.valueInput.min = '0.05';
    } else {
      this.valueInput.removeAttribute('min');
    }
    this.valueInput.value = String(parsed.value);
    if (parsed.feature === 'shell') {
      this.joinSelect.value = parsed.joinType;
      this.joinWrap.classList.remove('hidden');
    } else {
      this.joinWrap.classList.add('hidden');
    }
    this.syncExprSuffix();
    this.synthesizedArgs = parsed.argsText;
    this.alternatives = [];
    this.exprInput.value = parsed.argsText;
    this.syncExprPrefix();
    this.renderAlternatives();
    this.exprRow.classList.remove('hidden');
    this.exprRow.classList.add('flex');
    this.activeBar.classList.remove('hidden');
    this.setMessage(null);
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
      && (result.feature === 'shell' || result.feature === 'fillet' || result.feature === 'chamfer')
      && result.selection.kind === 'entities') {
      this.entities = result.selection.entities.map(e => ({ shapeId: e.shapeId, sub: e.sub }));
      this.chains = [];
      this.seedSignature = this.selectionSignature();
    } else {
      this.entities = [];
      this.chains = [];
      this.seedSignature = null;
    }
    this.previewSelection(null);
    this.refresh();
  }

  /** Sorted signature of the current pick set, for dirty detection. */
  private selectionSignature(): string {
    return this.entities.map(entityKey).sort().join('|');
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
      return this.entities.length > 0;
    }
    return this.selectionSignature() !== this.seedSignature || this.chains.length > 0;
  }

  enter(feature: ModifyFeatureKind): void {
    if (feature === 'sketch') {
      this.enterSketch();
      return;
    }
    // Arming a pick feature closes a sketch dialog in any state outright —
    // a pending create-dialog restore included.
    this.closeSketchSession();
    this.displacedSketchLabel = null;
    const wasActive = this.feature !== null;
    // Arming a create tool from an edit dialog abandons the session; the
    // view stays where it is — the tool picks in whatever state is shown.
    this.session.end('continue');
    this.editTarget = null;
    this.editArgsText = null;
    this.seedSignature = null;
    this.editSceneStale = false;
    // Only the sketch flows run suspended; switching away restores first.
    if (this.suspendedSketchUI) {
      this.resumeSketchUI(true);
    }
    this.feature = feature;
    const config = FEATURES[feature];
    // The hook hands over whatever was highlighted before the mode armed
    // (and clears that owner's selection) — those picks become the tool's
    // initial input. Switching between features keeps the in-mode selection.
    const seed = this.hooks.onEnter?.();
    if (!wasActive) {
      this.entities = Array.isArray(seed) ? [...seed] : [];
      this.chains = [];
    }
    // Face-only features can't use edge picks carried over from measure or a
    // previous mode; chains losing a member go with them.
    if (config.pickFilter === 'face') {
      const faces = this.entities.filter(e => e.sub.type === 'face');
      if (faces.length !== this.entities.length) {
        const faceKeys = new Set(faces.map(entityKey));
        this.chains = this.chains.filter(c => c.members.every(m => faceKeys.has(entityKey(m))));
        this.entities = faces;
      }
    }
    this.viewer.clearHover();
    this.viewer.pickFilter = config.pickFilter;
    // The pick features never show or pick planes — only the sketch dialog
    // (and neutral mode) keeps `plane(…)` quads pickable.
    this.syncPlanePicking();
    this.pendingPlaneShapeId = null;
    this.viewer.hideStandardPlanes();

    this.titleIcon.innerHTML = featureIconImg(feature);
    this.titleText.textContent = `${config.label} mode`;
    this.selectionSlot.setMultiple(true);
    this.valueWrap.classList.remove('hidden');
    this.valueLabel.textContent = config.valueLabel!;
    if (config.valueSign === 'positive') {
      this.valueInput.min = '0.05';
    } else {
      this.valueInput.removeAttribute('min');
    }
    this.valueInput.value = this.valueByFeature.get(feature) ?? String(config.defaultValue);
    if (config.joinRow) {
      this.joinSelect.value = this.lastJoinType;
      this.joinWrap.classList.remove('hidden');
    } else {
      this.joinWrap.classList.add('hidden');
    }
    this.syncExprSuffix();
    this.activeBar.classList.remove('hidden');
    this.setMessage(null);
    this.refresh();
    this.viewer.highlightEntities(this.entities);
  }

  /**
   * The Sketch button. A dialog already tracking a sketch toggles closed;
   * otherwise the pick mode arms with the dialog in its prompt state, and a
   * face highlighted beforehand (or a plane quad picked in neutral mode) is
   * consumed as the pick — the sketch starts right away, chip filled.
   */
  private enterSketch(): void {
    // A fresh sketch flow (or a toggle-close) supersedes a pending restore.
    this.displacedSketchLabel = null;
    if (this.sketchSession?.tracking) {
      this.markSketchDismissed();
      this.closeSketchSession();
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
      this.hideExpression();
      this.hideTooltip();
      this.selectionMenu.hide();
      this.activeBar.classList.add('hidden');
      this.setMessage(null);
    }
    const seed = this.hooks.onEnter?.();
    const faces = (Array.isArray(seed) ? seed : []).filter(e => e.sub.type === 'face');
    this.entities = [];
    this.chains = [];
    this.viewer.clearHighlight();
    this.enterSketchPicking();
    // A face already highlighted on entry applies immediately — the classic
    // one-click sketch start.
    if (faces.length === 1) {
      this.entities = [faces[0]];
      this.viewer.highlightEntities(this.entities);
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
    this.viewer.clearHover();
    this.viewer.pickFilter = 'face';
    this.syncPlanePicking();
    if (this.sceneSketchActive) {
      this.suspendSketchUI();
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
    this.entities = [];
    this.chains = [];
    this.hideTooltip();
    this.selectionMenu.hide();
    this.viewer.clearHighlight();
    this.syncButtons();
    this.resumeSketchUI(resume === 'immediate');
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
      this.resumeSketchUI(resume === 'immediate');
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
   * The Cancel button: delete the sketch statement the dialog created —
   * the editor round-trip re-renders without it, and that render restores
   * the default view — and close the dialog. Before the first pick there is
   * no statement yet, so Cancel just closes, like Escape.
   */
  private handleSketchCancel(): void {
    const loc = this.sketchSession ? this.activeSketchLoc() : null;
    this.markSketchDismissed();
    if (loc) {
      removeFeature(loc);
      this.closeSketchSession('lazy');
      return;
    }
    this.closeSketchSession();
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
    this.markSketchDismissed();
    this.closeSketchSession();
  }

  /**
   * The scene ends in a sketch but no dialog session exists — a page reload,
   * or a sketch entered by editing code directly. Adopt it: the dialog is
   * scene-derived like the rest of sketch mode (dimming, camera, toolbar).
   * The target chip starts generic and refines asynchronously from the
   * statement's parsed target argument. A dismissed dialog stays closed for
   * that sketch, and an armed feature or open create dialog takes precedence.
   */
  private adoptActiveSketch(sketch: SceneObjectRender): void {
    if (this.sketchSession || this.feature !== null || this.createDialogActive) {
      return;
    }
    const loc = sketch.sourceLocation;
    if (!loc) {
      return;
    }
    if (ModifyPickService.sketchKey(loc) === this.dismissedSketchKey) {
      return;
    }
    this.dismissedSketchKey = null;
    this.sketchSession = { tracking: true, label: 'Sketch target' };
    this.sketchPanel.setTarget(this.sketchSession.label);
    this.sketchPanel.setMessage(null);
    this.sketchPanel.show();
    void this.refreshAdoptedLabel({ filePath: loc.filePath, line: loc.line, column: loc.column });
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
    const active = this.findActiveObject(this.viewer.currentSceneObjects);
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
    const repick = this.sketchSession !== null && !this.sketchSession.tracking;
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
        this.sketchSession = { tracking: true, label };
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
    this.entities = [];
    this.chains = [];
    this.cancelPreview();
    this.hideExpression();
    this.hideTooltip();
    this.selectionMenu.hide();
    this.viewer.clearHighlight();
    this.activeBar.classList.add('hidden');
    this.setMessage(null);
    this.syncButtons();
    this.resumeSketchUI((opts.resume ?? 'immediate') === 'immediate');
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
      ? this.planes.find(o => o.filePath === plane.sourceLocation!.filePath && o.line === plane.sourceLocation!.line)
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
      this.displacedSketchLabel = this.sketchSession.label;
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
    const label = this.displacedSketchLabel;
    this.displacedSketchLabel = null;
    if (label === null || !this.sceneSketchActive
      || this.feature !== null || this.sketchSession !== null) {
      return;
    }
    this.sketchSession = { tracking: true, label };
    this.sketchPanel.setTarget(label);
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

  private suspendSketchUI(): void {
    if (this.suspendedSketchUI) {
      return;
    }
    this.suspendedSketchUI = true;
    this.viewer.suspendSketchEditing();
    this.hooks.onSuspendSketchUI?.();
  }

  private resumeSketchUI(immediate: boolean): void {
    if (!this.suspendedSketchUI) {
      return;
    }
    this.suspendedSketchUI = false;
    this.viewer.resumeSketchEditing(immediate);
    if (immediate) {
      this.hooks.onResumeSketchUI?.();
    }
  }

  /**
   * Routes viewer clicks while the mode is armed. Plain clicks accumulate
   * (fillet is inherently multi-pick); clicking a selected entity deselects
   * it (a chain member deselects its whole chain); clicking empty space keeps
   * the selection (misclicks shouldn't wipe it).
   */
  handleClick(shapeId: string | null, sub: SubSelection): void {
    if (!this.feature || !shapeId || !sub || sub.type === 'sketch' || sub.type === 'axis' || sub.type === 'plane') {
      return;
    }
    this.selectionMenu.hide();
    const entity: SelectedEntity = { shapeId, sub };
    if (this.feature === 'sketch') {
      // The single pick IS the apply: the click replaces the selection and
      // starts (or moves) the sketch.
      this.entities = [entity];
      this.chains = [];
      this.viewer.highlightEntities(this.entities);
      void this.applySketchTarget({ kind: 'face', entity });
      return;
    }
    this.setMessage(null);
    this.toggleEntity(entity);
  }

  /** Toggle a plain pick; a chain member toggles its whole chain off. */
  private toggleEntity(entity: SelectedEntity): void {
    const chain = this.chains.find(c => c.members.some(m => sameEntity(m, entity)));
    if (chain) {
      const memberKeys = new Set(chain.members.map(entityKey));
      this.entities = this.entities.filter(e => !memberKeys.has(entityKey(e)));
      this.chains = this.chains.filter(c => c !== chain);
    } else {
      const existing = this.entities.findIndex(e => sameEntity(e, entity));
      if (existing >= 0) {
        this.entities = this.entities.filter((_, i) => i !== existing);
      } else {
        this.entities = [...this.entities, entity];
      }
    }
    if (this.entities.length > 0) {
      this.viewer.highlightEntities(this.entities);
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
    if (!this.feature || !shapeId || !sub || sub.type === 'sketch' || sub.type === 'axis' || sub.type === 'plane') {
      return;
    }
    if (this.feature === 'sketch') {
      // The single-pick sketch has no bucket expansion — the first click
      // already applied.
      return;
    }
    this.selectionMenu.hide();
    this.hideTooltip();

    const entity: SelectedEntity = { shapeId, sub };
    const result = await expandBucket(entity, this.session.boundary ?? undefined);
    if (!this.feature) {
      return;
    }
    if ('error' in result) {
      this.setMessage(result.error);
      return;
    }
    this.setMessage(null);
    this.mergeEntities(result.members.map(m => ({ shapeId: m.shapeId, sub: m.sub })));
  }

  /** Merge group members into the selection as plain picks. */
  private mergeEntities(members: SelectedEntity[]): void {
    const merged = mergeUniqueEntities(this.entities, members);
    if (merged.length === this.entities.length) {
      return;
    }
    this.entities = merged;
    this.viewer.highlightEntities(this.entities);
    this.refresh();
  }

  /** Teach-mode tooltip: hover → attribution expression, debounced + cached. */
  handleHover(shapeId: string | null, sub: SubSelection, clientX: number, clientY: number): void {
    if (!this.feature) {
      return;
    }
    if (this.tooltipTimer !== null) {
      window.clearTimeout(this.tooltipTimer);
      this.tooltipTimer = null;
    }
    if (!shapeId || !sub || sub.type === 'sketch' || sub.type === 'axis' || sub.type === 'plane') {
      this.hideTooltip();
      return;
    }
    if (this.selectionMenu.isOpen) {
      return;
    }

    const entity: SelectedEntity = { shapeId, sub };
    const key = entityKey(entity);
    const cached = this.tooltipCache.get(key);
    if (cached !== undefined) {
      this.showTooltip(cached, clientX, clientY);
      return;
    }

    this.tooltipTimer = window.setTimeout(async () => {
      this.tooltipTimer = null;
      this.tooltipAbort?.abort();
      const abort = new AbortController();
      this.tooltipAbort = abort;
      try {
        const result = await explainSelection([entity], abort.signal, this.session.boundary ?? undefined);
        if (abort.signal.aborted || !this.feature) {
          return;
        }
        const pick = result?.picks?.[0];
        const text = pick?.expression
          ?? pick?.error
          ?? (pick && !pick.attributed
            ? 'no classified origin — a geometric select() will be synthesized'
            : null);
        if (text) {
          this.tooltipCache.set(key, text);
          this.showTooltip(text, clientX, clientY);
        }
      } catch {
        // Aborted or unreachable — no tooltip.
      }
    }, TOOLTIP_DEBOUNCE_MS);
  }

  /** Right-click on an edge/face: the multi-select menu for that pick. */
  handleContextMenu(shapeId: string | null, sub: SubSelection, clientX: number, clientY: number): void {
    if (!this.feature || this.feature === 'sketch') {
      return;
    }
    this.selectionMenu.hide();
    if (!shapeId || !sub || sub.type === 'sketch' || sub.type === 'axis' || sub.type === 'plane') {
      return;
    }
    this.hideTooltip();
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
      this.addChain(seed, members);
    } else {
      this.setMessage(null);
      this.mergeEntities(members);
    }
  }

  /** Menu-hover preview: show the selection as the hovered click would leave it. */
  private previewSelection(members: SelectedEntity[] | null): void {
    if (!this.feature) {
      return;
    }
    const shown = members ? mergeUniqueEntities(this.entities, members) : this.entities;
    if (shown.length > 0) {
      this.viewer.highlightEntities(shown);
    } else {
      this.viewer.clearHighlight();
    }
  }

  private addChain(seed: SelectedEntity, members: SelectedEntity[]): void {
    this.setMessage(null);
    // The chain owns its members: drop overlapping plain picks and chains.
    const memberKeys = new Set(members.map(entityKey));
    this.chains = this.chains.filter(c => !c.members.some(m => memberKeys.has(entityKey(m))));
    this.entities = [
      ...this.entities.filter(e => !memberKeys.has(entityKey(e))),
      ...members,
    ];
    this.chains.push({ seed, members });
    this.viewer.highlightEntities(this.entities);
    this.refresh();
  }

  private async apply(): Promise<void> {
    if (!this.feature || this.feature === 'sketch' || this.applying) {
      return;
    }
    const config = FEATURES[this.feature];
    // Create mode needs picks; an edit whose seeded selection was emptied
    // out has nothing to synthesize either (an untouched empty seed is fine
    // — the statement's own args stay verbatim).
    if (this.entities.length === 0 && (!this.editTarget || this.picksDirty())) {
      this.setMessage(config.pickFilter === 'face'
        ? 'Pick a face first.'
        : 'Pick at least one edge or face first.');
      return;
    }
    let value: number | null = null;
    if (config.valueLabel !== null) {
      value = parseFloat(this.valueInput.value);
      const invalid = !Number.isFinite(value)
        || (config.valueSign === 'positive' ? value <= 0 : value === 0);
      if (invalid) {
        this.setMessage(config.valueSign === 'nonzero'
          ? `Enter a nonzero ${config.valueLabel.toLowerCase()} (negative hollows inward).`
          : `Enter a positive ${config.valueLabel.toLowerCase()}.`);
        return;
      }
    }

    if (this.editTarget) {
      // In-place statement edit. A re-picked (dirty) selection rides as
      // picks for synthesis against the pre-statement boundary; otherwise
      // the selector args stay verbatim unless the expression row was
      // edited away from its baseline (the statement's own text, or the
      // last synthesized preview when picks are dirty).
      const dirty = this.picksDirty();
      const baseline = dirty ? this.synthesizedArgs : this.editArgsText;
      const editedArgs = this.exprInput.value.trim();
      const selectorOverride = editedArgs !== '' && editedArgs !== baseline
        ? editedArgs
        : undefined;
      this.applying = true;
      this.applyBtn.disabled = true;
      try {
        const result = await applyValueFeatureEdit(
          this.feature as 'shell' | 'fillet' | 'chamfer',
          this.editTarget,
          {
            value: value!,
            selectorOverride,
            joinType: this.shellJoinType() ?? undefined,
            expectedStatement: this.session.expectedStatement,
            before: dirty ? this.session.boundary ?? undefined : undefined,
            entities: dirty ? this.entities : undefined,
            chains: dirty ? this.apiChains() : undefined,
          },
        );
        if (result.success) {
          this.exit({ editEnd: 'apply' });
        } else {
          this.setMessage(result.reason ?? 'Could not apply the edit.');
        }
      } finally {
        this.applying = false;
        this.applyBtn.disabled = false;
      }
      return;
    }

    const edited = this.exprInput.value.trim();
    const selectorOverride = this.synthesizedArgs !== null && edited !== '' && edited !== this.synthesizedArgs
      ? edited
      : undefined;

    this.applying = true;
    this.applyBtn.disabled = true;
    try {
      const result = await applyFeature(this.feature, value, this.entities, {
        chains: this.apiChains(),
        selectorOverride,
        joinType: this.shellJoinType() ?? undefined,
      });
      if (result.success) {
        // The editor round-trip re-renders the scene; that render is the
        // preview and editor undo is the rollback. A suspended sketch UI
        // resumes lazily — the incoming render enters the new sketch.
        this.exit({ resume: 'lazy' });
      } else {
        this.setMessage(result.reason ?? 'Could not apply the feature.');
      }
    } finally {
      this.applying = false;
      this.applyBtn.disabled = false;
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
    this.chipRows = selectionChipRows(this.entities, this.chains);
    this.selectionSlot.setChips(this.chipRows.map((row, index) => ({
      label: row.label,
      badge: String(index + 1),
      removable: true,
    })));
    // Empty selection: prompt for the first pick; face-only features ask for
    // a face, the rest an edge.
    if (this.chipRows.length === 0) {
      this.selectionSlot.setPrompt(`Pick ${config.pickFilter === 'face' ? 'faces' : 'edges'}`);
    } else {
      this.selectionSlot.setPrompt(null);
    }
    this.syncButtons();
    this.schedulePreview();
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
      if (!this.picksDirty() || this.entities.length === 0) {
        return;
      }
    } else if (this.entities.length === 0) {
      this.hideExpression();
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
    let previewValue: number | null = null;
    if (config.valueLabel !== null) {
      const value = parseFloat(this.valueInput.value);
      const valid = Number.isFinite(value)
        && (config.valueSign === 'positive' ? value > 0 : value !== 0);
      previewValue = valid ? value : config.defaultValue!;
    }

    let result: ApplyFeatureResponse;
    try {
      result = this.editTarget
        ? await applyValueFeatureEdit(this.feature as 'shell' | 'fillet' | 'chamfer', this.editTarget, {
          value: previewValue!,
          joinType: this.shellJoinType() ?? undefined,
          expectedStatement: this.session.expectedStatement,
          before: this.session.boundary ?? undefined,
          entities: this.entities,
          chains: this.apiChains(),
          preview: true,
          signal: abort.signal,
        })
        : await applyFeature(this.feature, previewValue, this.entities, {
          chains: this.apiChains(),
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
      this.synthesizedArgs = result.args;
      this.alternatives = result.alternatives ?? [];
      this.exprInput.value = result.args;
      this.syncExprPrefix();
      this.renderAlternatives();
      this.exprRow.classList.remove('hidden');
      this.exprRow.classList.add('flex');
      this.setMessage(null);
    } else if (this.editTarget) {
      // Keep the expression row (it still shows a valid baseline) and
      // surface the refusal — an unsynthesizable pick, a drifted statement.
      this.setMessage(result.reason ?? 'Could not synthesize a selector.');
    } else {
      this.hideExpression();
      this.setMessage(result.reason ?? 'Could not synthesize a selector.');
    }
  }

  private renderAlternatives(): void {
    if (this.alternatives.length === 0) {
      this.altBtn.classList.add('hidden');
      this.altMenu.classList.add('hidden');
      return;
    }
    this.altBtn.classList.remove('hidden');
    this.altMenu.replaceChildren(...this.alternatives.map(args => {
      const item = document.createElement('button');
      item.className = 'block w-full text-left px-3 py-1.5 font-mono text-[11px] hover:bg-base-200 cursor-pointer whitespace-nowrap';
      item.textContent = args;
      item.addEventListener('click', () => {
        this.exprInput.value = args;
        this.altMenu.classList.add('hidden');
      });
      return item;
    }));
  }

  private syncExprPrefix(): void {
    if (!this.feature) {
      return;
    }
    const config = FEATURES[this.feature];
    if (config.valueLabel === null) {
      this.exprPrefix.textContent = `${this.feature}(`;
      return;
    }
    const value = this.valueInput.value.trim() || String(config.defaultValue);
    this.exprPrefix.textContent = `${this.feature}(${value}, `;
  }

  /** The join dropdown's value while a shell dialog is up, or null. */
  private shellJoinType(): ShellJoinType | null {
    if (this.feature !== 'shell') {
      return null;
    }
    return this.joinSelect.value as ShellJoinType;
  }

  /** A non-default shell join shows as a `.join()` chain after the args. */
  private syncExprSuffix(): void {
    if (!this.feature) {
      return;
    }
    const join = this.shellJoinType();
    this.exprSuffix.textContent = join && join !== 'arc'
      ? `${FEATURES[this.feature].exprSuffix}.join('${join}')`
      : FEATURES[this.feature].exprSuffix;
  }

  private hideExpression(): void {
    this.exprRow.classList.add('hidden');
    this.exprRow.classList.remove('flex');
    this.altMenu.classList.add('hidden');
    this.synthesizedArgs = null;
    this.alternatives = [];
    this.exprInput.value = '';
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

  private apiChains(): ApplyFeatureChain[] {
    return this.chains.map(c => ({ seed: c.seed, members: c.members }));
  }

  // -------------------------------------------------------------------------
  // Tooltip / context-menu plumbing
  // -------------------------------------------------------------------------

  private showTooltip(text: string, clientX: number, clientY: number): void {
    const rect = this.container.getBoundingClientRect();
    this.tooltip.textContent = text;
    this.tooltip.style.left = `${clientX - rect.left + 14}px`;
    this.tooltip.style.top = `${clientY - rect.top + 18}px`;
    this.tooltip.classList.remove('hidden');
  }

  private hideTooltip(): void {
    if (this.tooltipTimer !== null) {
      window.clearTimeout(this.tooltipTimer);
      this.tooltipTimer = null;
    }
    this.tooltipAbort?.abort();
    this.tooltipAbort = null;
    this.tooltip.classList.add('hidden');
  }

  private syncButtons(): void {
    for (const [kind, btn] of this.buttons) {
      const active = this.feature === kind
        || (kind === 'sketch' && this.sketchSession !== null);
      btn.className = active ? BTN_ACTIVE : BTN_BASE;
    }
    // The sketch button never hides (it votes its create group visible on
    // every render); it disables while another feature dialog is up — an
    // extrude/sweep/loft dialog, or this service's own fillet/chamfer/shell.
    this.buttons.get('sketch')!.disabled = this.createDialogActive
      || (this.feature !== null && this.feature !== 'sketch');
  }

  private setMessage(text: string | null): void {
    if (text) {
      this.message.textContent = text;
      this.message.classList.remove('hidden');
    } else {
      this.message.textContent = '';
      this.message.classList.add('hidden');
    }
  }

  /** Last root-level (or Part-child) object — mirrors Viewer.findActiveObject. */
  private findActiveObject(objects: SceneObjectRender[]): SceneObjectRender | undefined {
    for (let i = objects.length - 1; i >= 0; i--) {
      if (isTopLevel(objects[i], objects)) {
        return objects[i];
      }
    }
    return undefined;
  }
}
