import {
  applyFeature, applyValueFeatureEdit, expandBucket, explainSelection,
  ApplyFeatureChain, ApplyFeatureResponse, FeatureEditTarget, ParsedFeatureStatement, SelectionGroupKind,
  ShellJoinType,
} from '../api';
import { entityKey, mergeUniqueEntities, sameEntity } from '../helpers/entities';
import { isTopLevel } from '../helpers/scene-utils';
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
  /** Apply on the first pick instead of accumulating toward an Apply click. */
  immediate: boolean;
  /** List each pick as a removable chip row instead of a bare count. */
  selectionList: boolean;
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
  sketch: {
    label: 'Sketch', buttonTitle: 'Sketch on a face or an origin plane', valueLabel: null, defaultValue: null,
    pickFilter: 'face', valueSign: null, immediate: true, selectionList: false, joinRow: false, exprSuffix: ', () => { ... })',
  },
  fillet: {
    label: 'Fillet', buttonTitle: 'Fillet edges', valueLabel: 'Radius', defaultValue: 1,
    pickFilter: 'all', valueSign: 'positive', immediate: false, selectionList: true, joinRow: false, exprSuffix: ')',
  },
  chamfer: {
    label: 'Chamfer', buttonTitle: 'Chamfer edges', valueLabel: 'Distance', defaultValue: 1,
    pickFilter: 'all', valueSign: 'positive', immediate: false, selectionList: true, joinRow: false, exprSuffix: ')',
  },
  shell: {
    label: 'Shell', buttonTitle: 'Shell (pick the faces to open)', valueLabel: 'Thickness', defaultValue: -2,
    pickFilter: 'face', valueSign: 'nonzero', immediate: false, selectionList: false, joinRow: true, exprSuffix: ')',
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

const BTN_BASE = 'btn btn-ghost btn-sm h-auto flex-col gap-0.5 px-2.5 py-1 text-base-content/60';
const BTN_ACTIVE = 'btn btn-soft btn-primary btn-sm h-auto flex-col gap-0.5 px-2.5 py-1';
/** Small muted caption under the toolbar icon. */
const BTN_LABEL = 'text-[10px] leading-none text-base-content/50';

// The selection field. While it awaits its first pick it wears the active
// (primary) outline and prompts "Pick a face/edge"; once populated it settles
// into the neutral fill and shows the selection count.
const COUNT_BOX_BASE = 'flex items-center gap-2 rounded-md px-3 py-2.5 border transition-colors';
const COUNT_BOX_IDLE = 'bg-base-200 border-base-300 text-base-content/70';
const COUNT_BOX_ACTIVE = 'bg-primary/10 border-primary text-primary';

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
 * Sketch deviates deliberately: it takes exactly one face and applies
 * immediately — on entry when a face is already highlighted, otherwise on the
 * first face click — writing `sketch(<selector>, () => {})` and exiting.
 * Arming it also shows the origin planes (xy/xz/yz) in the viewport as pick
 * targets: picking one writes `sketch('<plane>', () => {})` instead. Its
 * button lives in the create group and is always offered — in an empty scene
 * the planes are the only targets, and the first sketch starts here; while an
 * extrude/sweep/loft dialog is up the button disables instead of hiding. The
 * group stays visible in sketch mode: arming sketch there *suspends* sketch
 * editing (free 3D camera, sketch UI released via the hooks) so a face or
 * plane can be picked; cancelling resumes the sketch being edited, applying
 * lets the incoming render enter the new one.
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
  /** An extrude/sweep/loft dialog is up — the Sketch button disables. */
  private createDialogActive = false;
  /** The scene ends with an unconsumed sketch (scene-derived sketch mode). */
  private sceneSketchActive = false;
  /** Sketch editing is suspended while the sketch-on-face pick is armed. */
  private suspendedSketchUI = false;
  /** Statement being edited in place (timeline double-click), or null. */
  private editTarget: FeatureEditTarget | null = null;
  /** The statement's own selector args — the override-detection baseline. */
  private editArgsText: string | null = null;

  private buttons = new Map<ModifyFeatureKind, HTMLButtonElement>();
  private activeBar: HTMLDivElement;
  private titleIcon: HTMLElement;
  private titleText: HTMLElement;
  private valueWrap: HTMLElement;
  private valueLabel: HTMLElement;
  private valueInput: HTMLInputElement;
  private joinWrap: HTMLElement;
  private joinSelect: HTMLSelectElement;
  private countBox: HTMLElement;
  private countText: HTMLElement;
  private chipList: HTMLElement;
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

    this.activeBar = document.createElement('div');
    this.activeBar.id = 'fluidcad-modify-pick-active';
    this.activeBar.className = 'absolute top-[116px] right-[76px] z-[999] pointer-events-auto hidden';
    this.activeBar.innerHTML = `
      <div class="flex flex-col items-end gap-1.5">
        <div class="flex flex-col items-stretch gap-3.5 w-60 bg-base-100 border border-base-300 text-base-content rounded-lg px-4 py-4 text-xs select-none shadow-md">
          <div class="flex items-center gap-2.5">
            <span class="flex items-center [&>svg]:size-4" data-role="icon"></span>
            <span data-role="title" class="font-medium text-sm">Fillet</span>
          </div>
          <div data-role="chip-list" class="flex flex-col gap-1 hidden"></div>
          <div data-role="count-box" class="${COUNT_BOX_BASE} ${COUNT_BOX_ACTIVE}">
            <span data-role="count" class="whitespace-nowrap">Pick an edge</span>
          </div>
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
    this.countBox = this.activeBar.querySelector('[data-role="count-box"]')!;
    this.countText = this.activeBar.querySelector('[data-role="count"]')!;
    this.chipList = this.activeBar.querySelector('[data-role="chip-list"]')!;
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
        this.exit();
      } else if (e.key === 'Enter'
        && document.activeElement !== this.valueInput
        && document.activeElement !== this.exprInput) {
        e.preventDefault();
        this.apply();
      }
    });
  }

  get isActive(): boolean {
    return this.feature !== null;
  }

  /** Edit mode never consumes viewport picks — the viewport stays neutral. */
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
    this.navbar.setGroupVisible('modify', modifyVisible);
    this.navbar.setGroupVisible('create', true, 'sketch');
    this.syncButtons();
    if (this.feature) {
      if (this.editTarget) {
        // Edit mode tracks a statement, not the scene: the dialog rides out
        // renders (including the breakpoint render the double-click placed).
        return;
      }
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
   * (timeline double-click). No picking is involved — the expression row
   * holds the statement's own selector args, editable as free text — and
   * Apply rewrites the statement in place.
   */
  enterEdit(
    target: FeatureEditTarget,
    parsed: Extract<ParsedFeatureStatement, { feature: 'shell' | 'fillet' | 'chamfer' }>,
  ): void {
    if (this.suspendedSketchUI) {
      this.resumeSketchUI(true);
    }
    this.hooks.onEnter?.();
    this.feature = parsed.feature;
    this.editTarget = target;
    this.editArgsText = parsed.argsText;
    this.entities = [];
    this.chains = [];
    this.cancelPreview();
    this.viewer.clearHover();
    this.viewer.clearHighlight();
    this.viewer.pickFilter = 'all';
    this.viewer.hideStandardPlanes();

    const config = FEATURES[parsed.feature];
    this.titleIcon.innerHTML = featureIconImg(parsed.feature);
    this.titleText.textContent = `Edit ${config.label.toLowerCase()}`;
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
    // No selection field: the picks are fixed to the statement's own args.
    this.countBox.classList.add('hidden');
    this.chipList.replaceChildren();
    this.chipList.classList.add('hidden');
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
    this.syncButtons();
  }

  enter(feature: ModifyFeatureKind): void {
    const wasActive = this.feature !== null;
    this.editTarget = null;
    this.editArgsText = null;
    // Only the sketch feature runs suspended; switching away restores first.
    if (this.suspendedSketchUI && feature !== 'sketch') {
      this.resumeSketchUI(true);
    }
    this.feature = feature;
    const config = FEATURES[feature];
    // Arming sketch-on-face from inside a sketch: release the sketch UI so
    // the camera is free and clicks pick faces instead of drawing.
    if (feature === 'sketch' && this.sceneSketchActive) {
      this.suspendSketchUI();
    }
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
    if (config.immediate) {
      // Single-pick mode: more than one carried-over face is ambiguous.
      this.chains = [];
      if (this.entities.length > 1) {
        this.entities = [];
      }
    }
    this.viewer.clearHover();
    this.viewer.pickFilter = config.pickFilter;
    // Sketch offers the origin planes alongside faces (in an empty scene they
    // are the only targets); the other features never show them.
    if (feature === 'sketch') {
      this.viewer.showStandardPlanes(this.onPlanePick);
    } else {
      this.viewer.hideStandardPlanes();
    }

    this.titleIcon.innerHTML = featureIconImg(feature);
    this.titleText.textContent = `${config.label} mode`;
    if (config.valueLabel === null) {
      this.valueWrap.classList.add('hidden');
    } else {
      this.valueWrap.classList.remove('hidden');
      this.valueLabel.textContent = config.valueLabel;
      if (config.valueSign === 'positive') {
        this.valueInput.min = '0.05';
      } else {
        this.valueInput.removeAttribute('min');
      }
      this.valueInput.value = this.valueByFeature.get(feature) ?? String(config.defaultValue);
    }
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

    // Sketch applies immediately when a face was already highlighted on entry.
    if (config.immediate && this.entities.length === 1) {
      this.apply();
    }
  }

  /**
   * `resume: 'lazy'` re-enables sketch editing without forcing the mode
   * transition — used when a render is already on its way (an apply went
   * through, or the exit was scene-driven). User cancels default to
   * `'immediate'`, which restores the suspended sketch view right now.
   */
  exit(opts: { resume?: 'immediate' | 'lazy' } = {}): void {
    if (!this.feature) {
      return;
    }
    this.feature = null;
    this.editTarget = null;
    this.editArgsText = null;
    this.viewer.pickFilter = 'all';
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

  /** A shown origin plane was clicked while the sketch mode was armed. */
  private readonly onPlanePick = (plane: StandardPlaneId): void => {
    void this.applyPlaneSketch(plane);
  };

  /**
   * The pick-less sketch apply: `sketch('<plane>', () => {})` on the picked
   * origin plane, appended at the end of the file — no face selector, no
   * synthesis. The incoming render enters the new sketch.
   */
  private async applyPlaneSketch(plane: StandardPlaneId): Promise<void> {
    if (!this.feature || this.applying) {
      return;
    }
    this.applying = true;
    this.applyBtn.disabled = true;
    try {
      const result = await applyFeature('sketch', null, [], { plane });
      if (result.success) {
        this.exit({ resume: 'lazy' });
      } else {
        this.setMessage(result.reason ?? 'Could not start the sketch.');
      }
    } finally {
      this.applying = false;
      this.applyBtn.disabled = false;
    }
  }

  /** An extrude/sweep/loft dialog opened or closed — the Sketch button disables while one is up. */
  setCreateDialogActive(active: boolean): void {
    if (this.createDialogActive === active) {
      return;
    }
    this.createDialogActive = active;
    this.syncButtons();
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
    if (!this.feature || this.editTarget || !shapeId || !sub || sub.type === 'sketch') {
      return;
    }
    this.selectionMenu.hide();
    this.setMessage(null);
    const entity: SelectedEntity = { shapeId, sub };
    if (FEATURES[this.feature].immediate) {
      // Single-pick immediate mode: the click replaces the selection and applies.
      this.entities = [entity];
      this.chains = [];
      this.viewer.highlightEntities(this.entities);
      this.refresh();
      this.apply();
      return;
    }
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
    if (!this.feature || this.editTarget || !shapeId || !sub || sub.type === 'sketch') {
      return;
    }
    if (FEATURES[this.feature].immediate) {
      // Single-pick mode has no bucket expansion — the first click already applied.
      return;
    }
    this.selectionMenu.hide();
    this.hideTooltip();

    const entity: SelectedEntity = { shapeId, sub };
    const result = await expandBucket(entity);
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
    if (!this.feature || this.editTarget) {
      return;
    }
    if (this.tooltipTimer !== null) {
      window.clearTimeout(this.tooltipTimer);
      this.tooltipTimer = null;
    }
    if (!shapeId || !sub || sub.type === 'sketch') {
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
        const result = await explainSelection([entity], abort.signal);
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
    if (!this.feature || this.editTarget || FEATURES[this.feature].immediate) {
      return;
    }
    this.selectionMenu.hide();
    if (!shapeId || !sub || sub.type === 'sketch') {
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
    if (!this.feature || this.applying) {
      return;
    }
    const config = FEATURES[this.feature];
    if (!this.editTarget && this.entities.length === 0) {
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
      // In-place statement edit: the selector args stay verbatim unless the
      // expression row was edited away from the statement's own text.
      const editedArgs = this.exprInput.value.trim();
      const selectorOverride = editedArgs !== '' && editedArgs !== this.editArgsText
        ? editedArgs
        : undefined;
      this.applying = true;
      this.applyBtn.disabled = true;
      try {
        const result = await applyValueFeatureEdit(
          this.feature as 'shell' | 'fillet' | 'chamfer',
          this.editTarget,
          { value: value!, selectorOverride, joinType: this.shellJoinType() ?? undefined },
        );
        if (result.success) {
          this.exit({ resume: 'lazy' });
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
        if (config.immediate) {
          // The retry path for the single-pick mode: surface the editable
          // expression so the selector can be fixed and re-applied.
          this.schedulePreview();
        }
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
    const config = FEATURES[this.feature];
    const edges = this.entities.filter(e => e.sub.type === 'edge').length;
    const faces = this.entities.length - edges;
    const parts: string[] = [];
    if (edges > 0) {
      parts.push(`${edges} edge${edges === 1 ? '' : 's'}`);
    }
    if (faces > 0) {
      parts.push(`${faces} face${faces === 1 ? '' : 's'}`);
    }
    if (this.chains.length > 0) {
      parts.push(`${this.chains.length} chain${this.chains.length === 1 ? '' : 's'}`);
    }
    // Empty selection field: prompt for the first pick and wear the active
    // (primary) outline; face-only features ask for a face, the rest an edge.
    // Sketch also offers the origin planes — alone when nothing has faces.
    const empty = parts.length === 0;
    if (empty) {
      const noun = this.feature === 'sketch'
        ? (this.sketchAvailable ? 'a face or a plane' : 'a plane')
        : config.pickFilter === 'face' ? 'a face' : 'an edge';
      this.countText.textContent = `Pick ${noun}`;
    } else {
      this.countText.textContent = parts.join(' + ');
    }
    // Listing features swap the count box for the chip rows once picks exist
    // (the loft-panel pattern: the prompt box only prompts).
    const showCount = !config.selectionList || empty;
    this.countBox.className = `${COUNT_BOX_BASE} ${empty ? COUNT_BOX_ACTIVE : COUNT_BOX_IDLE}${showCount ? '' : ' hidden'}`;
    this.renderChipList(config.selectionList);
    this.syncButtons();
    this.schedulePreview();
  }

  /**
   * The removable per-pick rows (fillet/chamfer): one chip per plain pick, a
   * whole tangent chain as a single chip — its ✕ removes the chain like a
   * viewport click on a member would. Hovering a chip shows just that chip's
   * entities so the row can be told apart from its siblings.
   */
  private renderChipList(enabled: boolean): void {
    if (!enabled) {
      this.chipList.replaceChildren();
      this.chipList.classList.add('hidden');
      return;
    }
    const chainOf = new Map<string, { seed: SelectedEntity; members: SelectedEntity[] }>();
    for (const chain of this.chains) {
      for (const member of chain.members) {
        chainOf.set(entityKey(member), chain);
      }
    }
    const seen = new Set<unknown>();
    const rows: { label: string; members: SelectedEntity[] }[] = [];
    for (const entity of this.entities) {
      const chain = chainOf.get(entityKey(entity));
      if (chain) {
        if (!seen.has(chain)) {
          seen.add(chain);
          rows.push({
            label: `Tangent chain (${chain.members.length} edges)`,
            members: chain.members,
          });
        }
      } else {
        rows.push({ label: entity.sub.type === 'face' ? 'Face' : 'Edge', members: [entity] });
      }
    }

    this.chipList.replaceChildren(...rows.map((chip, index) => {
      const row = document.createElement('div');
      row.className = 'flex items-center gap-1.5 rounded-md pl-2 pr-1 py-1 bg-base-200 border border-base-300';
      const badge = document.createElement('span');
      badge.className = 'badge badge-sm badge-primary badge-soft shrink-0';
      badge.textContent = String(index + 1);
      const label = document.createElement('span');
      label.className = 'flex-1 truncate';
      label.textContent = chip.label;
      label.title = chip.label;
      const remove = document.createElement('button');
      remove.className = 'btn btn-ghost btn-xs btn-square text-base-content/50 hover:text-base-content shrink-0 text-[9px]';
      remove.title = 'Remove this selection';
      remove.textContent = '✕';
      remove.addEventListener('click', () => this.toggleEntity(chip.members[0]));
      row.addEventListener('mouseenter', () => this.viewer.highlightEntities(chip.members));
      row.addEventListener('mouseleave', () => this.previewSelection(null));
      row.append(badge, label, remove);
      return row;
    }));
    this.chipList.classList.toggle('hidden', rows.length === 0);
  }

  // -------------------------------------------------------------------------
  // Expression transparency: debounced synthesis preview + alternatives
  // -------------------------------------------------------------------------

  private schedulePreview(): void {
    this.cancelPreview();
    if (!this.feature || this.entities.length === 0) {
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
      result = await applyFeature(this.feature, previewValue, this.entities, {
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
      btn.className = this.feature === kind ? BTN_ACTIVE : BTN_BASE;
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
