import { applyPlane, ApplyFeatureResponse, PlaneApplyOptions, PlaneBaseRef } from '../../api';
import { sameEntity } from '../../helpers/entities';
import { SceneObjectRender, SubSelection } from '../../types';
import { SelectedEntity, Viewer } from '../../viewer';
import { StandardPlaneId } from '../../scene/standard-planes';
import { Navbar } from '../../ui/navbar';
import { ICON_IMG_FALLBACK } from '../../ui/object-icons';
import { PlanePanel } from './plane-panel';
import {
  collectPlaneOptions, labelWithPlaneNames, PlaneOption, planeOptionsSignature, resolvePlaneRow,
} from './plane-bases';
import { collectSketchProfiles } from './sketch-profiles';

const BTN_BASE = 'btn btn-ghost btn-square btn-sm text-base-content/60';
const BTN_ACTIVE = 'btn btn-soft btn-primary btn-square btn-sm';

const PREVIEW_DEBOUNCE_MS = 250;

/** One base in the dialog's list — the chip order is the argument order. */
type PlaneBaseItem =
  | { kind: 'standard'; plane: StandardPlaneId }
  | { kind: 'plane'; option: PlaneOption }
  | { kind: 'pick'; entity: SelectedEntity };

/**
 * The Plane dialog on the create rails: a construction plane offset from one
 * base, midway between two bases, or normal to an edge at a position along
 * it. Bases collect into one loft-style chip list, filled entirely from the
 * scene: faces are picked in the 3D view while the dialog is armed (edges
 * only for the edge type; clicking a picked entity removes it), the standard
 * origin planes are shown in the viewport as pick targets (the
 * sketch-on-plane mechanism), and existing plane features come from timeline
 * clicks. Arming with a selection already highlighted seeds the dialog: one
 * edge opens the edge type, one face the offset type, two faces the mid
 * type — each with the selection as base(s). Apply writes `plane(…)` — the
 * re-render is the preview, editor undo the rollback.
 */
export class PlaneFeatureService {
  private panel: PlanePanel;
  private button: HTMLButtonElement;
  private armed = false;
  private applying = false;
  private planes: PlaneOption[] = [];
  private bases: PlaneBaseItem[] = [];
  private sceneSketchActive = false;
  private suspendedSketchUI = false;
  private labelSignature = '';

  private previewTimer: number | null = null;
  private previewAbort: AbortController | null = null;
  private previewSeq = 0;

  constructor(
    container: HTMLElement,
    private viewer: Viewer,
    private navbar: Navbar,
    private hooks: {
      /** May return the current neutral selection — it seeds the dialog. */
      onEnter?: () => SelectedEntity[] | void;
      /** Armed or disarmed — lets the Sketch button owner re-check `isActive`. */
      onActiveChange?: () => void;
      onSuspendSketchUI?: () => void;
      onResumeSketchUI?: () => void;
    } = {},
  ) {
    const group = navbar.getGroup('create') ?? navbar.addGroup('create', { visible: false, immune: true });
    this.button = document.createElement('button');
    this.button.className = BTN_BASE;
    this.button.title = 'Create a construction plane';
    this.button.innerHTML = `<img src="/icons/plane.png" ${ICON_IMG_FALLBACK} class="w-4 h-4 object-contain" alt="" />`;
    this.button.addEventListener('click', () => {
      if (this.armed) {
        this.exit();
      } else {
        this.enter();
      }
    });
    // Ahead of the Extrude button; the Sketch button prepends later, so the
    // group reads Sketch, Plane, Extrude, …
    group.prepend(this.button);
    // A plane can be made from standard planes alone, so the button is
    // always offered (the sketch slot votes the group visible in any scene).
    this.navbar.setGroupVisible('create', true, 'plane');

    this.panel = new PlanePanel(container);
    this.panel.onApply = () => this.apply();
    this.panel.onExit = () => this.exit();
    this.panel.onChange = () => {
      this.panel.setMessage(null);
      this.schedulePreview();
    };
    this.panel.onTypeChange = () => this.handleTypeChange();
    this.panel.onRemoveBase = (index) => {
      this.bases.splice(index, 1);
      this.panel.setMessage(null);
      this.refresh();
      this.schedulePreview();
    };
  }

  get isActive(): boolean {
    return this.armed;
  }

  /** Picks are live the whole time armed — the viewer routes clicks here. */
  get isPicking(): boolean {
    return this.armed;
  }

  /** True while the armed dialog has suspended sketch editing. */
  get sketchUISuspended(): boolean {
    return this.suspendedSketchUI;
  }

  update(sceneObjects: SceneObjectRender[]): void {
    this.planes = collectPlaneOptions(sceneObjects);
    this.sceneSketchActive = collectSketchProfiles(sceneObjects)[0]?.kind === 'active';
    if (!this.armed) {
      return;
    }
    // A render can put a sketch back in front (live editing) — the armed
    // dialog keeps the free 3D view.
    if (this.sceneSketchActive) {
      this.suspendSketchUI();
    }
    // Shape ids changed with the render — picked bases are stale; plane
    // bases re-match against the fresh options by source line.
    this.bases = this.bases.filter(base => {
      if (base.kind === 'pick') {
        return false;
      }
      if (base.kind === 'plane') {
        return this.planes.some(o =>
          o.filePath === base.option.filePath && o.line === base.option.line);
      }
      return true;
    });
    this.refreshPlaneLabels();
    this.syncViewport();
    this.refresh();
    this.schedulePreview();
  }

  enter(): void {
    if (this.armed) {
      return;
    }
    const seeded = this.hooks.onEnter?.();
    const seed = Array.isArray(seeded) ? seeded : [];
    this.armed = true;
    this.bases = [];
    // Composing a plane means looking at the whole scene, not down the
    // active sketch plane — leave sketch editing right away (resumed on
    // cancel; an apply's re-render takes over).
    if (this.sceneSketchActive) {
      this.suspendSketchUI();
    }
    this.syncButton();
    this.panel.show();
    this.seedFromSelection(seed);
    this.refreshPlaneLabels();
    this.syncViewport();
    this.refresh();
    this.schedulePreview();
  }

  /**
   * Arm the dialog around whatever was already selected: one edge opens the
   * edge type on it, one face the offset type, two faces the mid type. Any
   * other selection starts blank.
   */
  private seedFromSelection(seed: SelectedEntity[]): void {
    const faces = seed.filter(e => e.sub.type === 'face');
    const edges = seed.filter(e => e.sub.type === 'edge');
    if (seed.length === 1 && edges.length === 1) {
      this.panel.setType('edge');
      this.bases = [{ kind: 'pick', entity: edges[0] }];
      return;
    }
    if (seed.length === 1 && faces.length === 1) {
      this.bases = [{ kind: 'pick', entity: faces[0] }];
      return;
    }
    if (seed.length === 2 && faces.length === 2) {
      this.panel.setType('mid');
      this.bases = faces.map(entity => ({ kind: 'pick', entity }));
    }
  }

  /**
   * `resume: 'lazy'` re-enables sketch editing without forcing the mode
   * transition — for apply-success and scene-driven exits. User cancels
   * default to `'immediate'`.
   */
  exit(opts: { resume?: 'immediate' | 'lazy' } = {}): void {
    if (!this.armed) {
      return;
    }
    this.armed = false;
    this.syncButton();
    this.cancelPreview();
    this.bases = [];
    this.viewer.clearHighlight();
    this.viewer.hideStandardPlanes();
    this.viewer.pickFilter = 'all';
    this.panel.hide();
    this.resumeSketchUI((opts.resume ?? 'immediate') === 'immediate');
  }

  /**
   * Routes viewer clicks while armed: a pick joins the base list — faces for
   * the offset/mid types, edges for the edge type (the pick filter already
   * narrows what the viewer returns); clicking an entity that is already a
   * base removes it; empty-space clicks keep the bases.
   */
  handleClick(shapeId: string | null, sub: SubSelection): void {
    if (!this.armed || !shapeId || !sub || (sub.type !== 'face' && sub.type !== 'edge')) {
      return;
    }
    this.panel.setMessage(null);
    const wanted = this.panel.planeType === 'edge' ? 'edge' : 'face';
    if (sub.type !== wanted) {
      this.panel.setMessage(wanted === 'edge'
        ? 'A from-edge plane needs an edge — pick an edge.'
        : 'This plane type takes faces — switch to "From edge" to use an edge.');
      return;
    }
    const entity: SelectedEntity = { shapeId, sub };
    const existing = this.bases.findIndex(b => b.kind === 'pick' && sameEntity(b.entity, entity));
    if (existing >= 0) {
      this.bases.splice(existing, 1);
      this.refresh();
      this.schedulePreview();
      return;
    }
    this.addBase({ kind: 'pick', entity });
  }

  /** A shown origin plane was clicked — it joins the base list. */
  private readonly onStandardPlanePick = (plane: StandardPlaneId): void => {
    if (!this.armed || this.panel.planeType === 'edge') {
      return;
    }
    this.panel.setMessage(null);
    this.addBase({ kind: 'standard', plane });
  };

  /**
   * A timeline row was clicked while the dialog is armed: a plane row joins
   * the base list. Consumed on any plane row so the default rollback can't
   * close the dialog mid-flow.
   */
  handleTimelinePick(obj: SceneObjectRender): boolean {
    if (!this.armed) {
      return false;
    }
    const plane = resolvePlaneRow(obj);
    if (!plane) {
      return false;
    }
    if (this.panel.planeType === 'edge') {
      this.panel.setMessage('A from-edge plane takes a picked edge, not a plane.');
      return true;
    }
    const loc = plane.sourceLocation!;
    const option = this.planes.find(o => o.filePath === loc.filePath && o.line === loc.line);
    if (!option) {
      this.panel.setMessage('That plane is not available as a base.');
      return true;
    }
    this.panel.setMessage(null);
    this.addBase({ kind: 'plane', option });
    return true;
  }

  /**
   * Add a base respecting the type's capacity: single-base types replace
   * their base, a mid plane collects two (the same base twice is refused —
   * the mid of a base and itself is degenerate).
   */
  private addBase(item: PlaneBaseItem): void {
    if (this.bases.some(b => baseKey(b) === baseKey(item))) {
      this.panel.setMessage('That base is already in the list.');
      return;
    }
    if (this.bases.length >= this.panel.capacity) {
      if (this.panel.capacity === 1) {
        this.bases = [item];
      } else {
        this.panel.setMessage('A mid plane takes two bases — remove one first.');
        return;
      }
    } else {
      this.bases.push(item);
    }
    this.refresh();
    this.schedulePreview();
  }

  /** The type changed: trim the base list to what the new type can take. */
  private handleTypeChange(): void {
    const type = this.panel.planeType;
    if (type === 'edge') {
      // Only a picked edge survives into the edge form.
      this.bases = this.bases
        .filter(b => b.kind === 'pick' && b.entity.sub.type === 'edge')
        .slice(0, 1);
    } else {
      // Edge picks belong to the edge form only.
      this.bases = this.bases
        .filter(b => b.kind !== 'pick' || b.entity.sub.type === 'face')
        .slice(0, this.panel.capacity);
    }
    this.syncViewport();
    this.refresh();
    this.schedulePreview();
  }

  private async apply(): Promise<void> {
    if (!this.armed || this.applying) {
      return;
    }
    const request = this.buildRequest();
    if ('error' in request) {
      this.panel.setMessage(request.error);
      return;
    }
    this.applying = true;
    this.panel.setApplyEnabled(false);
    try {
      const result = await applyPlane(request);
      if (result.success) {
        // The editor round-trip re-renders the scene; that render is the
        // preview and editor undo is the rollback.
        this.exit({ resume: 'lazy' });
      } else {
        this.panel.setMessage(result.reason ?? 'Could not apply the plane.');
      }
    } finally {
      this.applying = false;
      this.panel.setApplyEnabled(true);
    }
  }

  /** The request for the current form state, or the message blocking it. */
  private buildRequest(): PlaneApplyOptions | { error: string } {
    const values = this.panel.values();
    if ('error' in values) {
      return values;
    }
    if (this.bases.length < this.panel.capacity) {
      if (values.type === 'edge') {
        return { error: 'Pick the edge first.' };
      }
      return {
        error: values.type === 'mid'
          ? 'A mid plane needs two bases — pick faces or planes.'
          : 'Choose a base for the plane first.',
      };
    }
    const bases: PlaneBaseRef[] = this.bases.map(base => {
      if (base.kind === 'standard') {
        return { kind: 'standard', plane: base.plane };
      }
      if (base.kind === 'plane') {
        const { filePath, line, column } = base.option;
        return { kind: 'plane', filePath, line, column };
      }
      return { kind: 'pick', entity: base.entity };
    });
    return { ...values, bases };
  }

  // -------------------------------------------------------------------------
  // Viewport reflection + sketch-editing suspension
  // -------------------------------------------------------------------------

  /**
   * Align the viewport with the type: the origin planes show as pick targets
   * while armed (re-shown on renders to re-size to the scene) — except for
   * the edge type, whose only base is a picked edge — and the pick filter
   * narrows scene picks to faces (offset/mid) or edges (edge type).
   */
  private syncViewport(): void {
    if (!this.armed) {
      return;
    }
    const edgeType = this.panel.planeType === 'edge';
    this.viewer.pickFilter = edgeType ? 'edge' : 'face';
    if (edgeType) {
      this.viewer.hideStandardPlanes();
    } else {
      this.viewer.showStandardPlanes(this.onStandardPlanePick);
    }
  }

  /** Repaint the chips, the hint box, and the picked-entity highlights. */
  private refresh(): void {
    if (!this.armed) {
      return;
    }
    this.panel.setBases(this.bases.map(base => ({ label: baseLabel(base) })));
    const type = this.panel.planeType;
    if (this.bases.length >= this.panel.capacity) {
      this.panel.setHint(null);
    } else if (type === 'edge') {
      this.panel.setHint('Pick an edge in 3D');
    } else {
      this.panel.setHint(this.bases.length === 0 && type === 'mid'
        ? 'Pick two faces or planes in 3D'
        : 'Pick a face or plane in 3D');
    }
    const picked = this.bases.flatMap(b => (b.kind === 'pick' ? [b.entity] : []));
    if (picked.length > 0) {
      this.viewer.highlightEntities(picked);
    } else {
      this.viewer.clearHighlight();
    }
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
   * Async label pass: planes bound to variables show their names in the
   * chips ("top — line 3"). Applied only if the dialog is still armed on the
   * same option set when the lookup lands.
   */
  private async refreshPlaneLabels(): Promise<void> {
    const signature = planeOptionsSignature(this.planes);
    this.labelSignature = signature;
    const labeled = await labelWithPlaneNames(this.planes);
    if (!this.armed || this.labelSignature !== signature) {
      return;
    }
    this.planes = labeled;
    // Chips referencing a relabeled plane pick up the new name.
    this.bases = this.bases.map(base => {
      if (base.kind !== 'plane') {
        return base;
      }
      const match = labeled.find(o =>
        o.filePath === base.option.filePath && o.line === base.option.line);
      return match ? { kind: 'plane', option: match } : base;
    });
    this.refresh();
  }

  private syncButton(): void {
    this.button.className = this.armed ? BTN_ACTIVE : BTN_BASE;
    // Every armed flip lands here — the Sketch button disables while a
    // create dialog is up.
    this.hooks.onActiveChange?.();
  }

  // -------------------------------------------------------------------------
  // Statement preview: debounced server render with truthful variable names.
  // -------------------------------------------------------------------------

  private schedulePreview(): void {
    this.cancelPreview();
    if (!this.armed) {
      return;
    }
    this.previewTimer = window.setTimeout(() => {
      this.previewTimer = null;
      this.runPreview();
    }, PREVIEW_DEBOUNCE_MS);
  }

  private async runPreview(): Promise<void> {
    if (!this.armed || this.applying) {
      return;
    }
    const request = this.buildRequest();
    if ('error' in request) {
      this.panel.setPreview(null);
      return;
    }
    const seq = ++this.previewSeq;
    this.previewAbort?.abort();
    const abort = new AbortController();
    this.previewAbort = abort;

    let result: ApplyFeatureResponse;
    try {
      result = await applyPlane({ ...request, preview: true, signal: abort.signal });
    } catch {
      return; // aborted
    }
    if (seq !== this.previewSeq || !this.armed) {
      return;
    }
    this.panel.setPreview(result.success ? result.preview ?? null : null);
    if (!result.success && result.reason) {
      // Pre-Apply refusals (unsynthesizable pick) surface immediately,
      // like the modify rails.
      this.panel.setMessage(result.reason);
    }
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
}

function baseKey(base: PlaneBaseItem): string {
  if (base.kind === 'standard') {
    return `standard:${base.plane}`;
  }
  if (base.kind === 'plane') {
    return `plane:${base.option.filePath}:${base.option.line}`;
  }
  return `pick:${base.entity.shapeId}:${base.entity.sub.type}:${base.entity.sub.index}`;
}

function baseLabel(base: PlaneBaseItem): string {
  if (base.kind === 'standard') {
    return `${base.plane.toUpperCase()} plane`;
  }
  if (base.kind === 'plane') {
    return base.option.label;
  }
  return base.entity.sub.type === 'face' ? 'Picked face' : 'Picked edge';
}
