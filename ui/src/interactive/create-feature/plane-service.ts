import { applyPlane, PlaneApplyOptions, PlaneBaseRef } from '../../api';
import { sameEntity } from '../../helpers/entities';
import { SceneObjectRender, SubSelection } from '../../types';
import { SelectedEntity, Viewer } from '../../viewer';
import { StandardPlaneId } from '../../scene/standard-planes';
import { Navbar } from '../../ui/navbar';
import { PlanePanel } from './plane-panel';
import { FeatureButton } from './feature-button';
import { ApplyRunner } from './apply-runner';
import { SketchUISuspender } from './sketch-suspender';
import { OptionRelabeler, refreshScopeVariables } from './option-relabeler';
import {
  collectPlaneOptions, labelWithPlaneNames, PlaneOption, planeOptionsSignature, resolvePlaneRow,
} from './plane-bases';
import {
  collectWireSources, labelWithSketchNames, optionsSignature, resolveWireByShapeId, SketchProfileOption,
  sketchWireShapeIds, sourceChip,
} from './sketch-profiles';

/** One base in the dialog's list — the chip order is the argument order. */
type PlaneBaseItem =
  | { kind: 'standard'; plane: StandardPlaneId }
  | { kind: 'plane'; option: PlaneOption }
  /** A helix statement as the edge-type base (its wire is the edge). */
  | { kind: 'wire'; option: SketchProfileOption }
  | { kind: 'pick'; entity: SelectedEntity };

/**
 * The Plane dialog on the create rails: a construction plane offset from one
 * base, midway between two bases, or normal to an edge at a position along
 * it. Bases collect into one loft-style chip list, filled entirely from the
 * scene: faces are picked in the 3D view while the dialog is armed (edges
 * only for the edge type — a helix's wire counts and lands as the named
 * helix source; clicking a picked entity removes it), the standard
 * origin planes are shown in the viewport as pick targets (the
 * sketch-on-plane mechanism), and existing plane features come from timeline
 * clicks. Arming with a selection already highlighted seeds the dialog: one
 * edge opens the edge type, one face the offset type, two faces the mid
 * type — each with the selection as base(s). Apply writes `plane(…)` — the
 * re-render is the preview, editor undo the rollback.
 */
export class PlaneFeatureService {
  private panel: PlanePanel;
  private button: FeatureButton;
  private armed = false;
  private planes: PlaneOption[] = [];
  /** The helixes the edge type can reference as its base wire. */
  private wires: SketchProfileOption[] = [];
  private sceneObjects: SceneObjectRender[] = [];
  private bases: PlaneBaseItem[] = [];
  private sceneSketchActive = false;
  private sketchUI: SketchUISuspender;
  private runner: ApplyRunner<PlaneApplyOptions>;
  private relabeler: OptionRelabeler<PlaneOption[]>;
  private wireRelabeler: OptionRelabeler<SketchProfileOption[]>;

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
    this.button = new FeatureButton(group, {
      icon: '/icons/plane.png',
      label: 'Plane',
      tip: 'Create a construction plane',
      ariaLabel: 'Create a construction plane',
      // Ahead of the Extrude button; the Sketch button prepends later, so the
      // group reads Sketch, Plane, Extrude, …
      prepend: true,
    });
    this.button.onClick = () => {
      if (this.armed) {
        this.exit();
      } else {
        this.enter();
      }
    };
    // A plane can be made from standard planes alone, so the button is
    // always offered (the sketch slot votes the group visible in any scene).
    this.navbar.setGroupVisible('create', true, 'plane');
    this.sketchUI = new SketchUISuspender(viewer, hooks);

    this.panel = new PlanePanel(container);
    this.panel.onApply = () => void this.runner.apply();
    this.panel.onExit = () => this.exit();
    this.panel.onChange = () => {
      this.panel.setMessage(null);
      this.runner.schedulePreview();
    };
    this.panel.onTypeChange = () => this.handleTypeChange();
    this.panel.onRemoveBase = (index) => {
      this.bases.splice(index, 1);
      this.panel.setMessage(null);
      this.refresh();
      this.runner.schedulePreview();
    };

    this.runner = new ApplyRunner({
      panel: this.panel,
      isArmed: () => this.armed,
      build: () => this.buildRequest(),
      send: (request, extras) => applyPlane({ ...request, ...extras }),
      onApplied: () => this.exit({ resume: 'lazy' }),
      failMessage: () => 'Could not apply the plane.',
    });
    this.relabeler = new OptionRelabeler({
      sign: planeOptionsSignature,
      load: labelWithPlaneNames,
      isArmed: () => this.armed,
      apply: (planes) => {
        this.planes = planes;
        // Chips referencing a relabeled plane pick up the new name.
        this.bases = this.bases.map(base => {
          if (base.kind !== 'plane') {
            return base;
          }
          const match = planes.find(o =>
            o.filePath === base.option.filePath && o.line === base.option.line);
          return match ? { kind: 'plane', option: match } : base;
        });
        this.refresh();
      },
    });
    this.wireRelabeler = new OptionRelabeler({
      sign: optionsSignature,
      load: labelWithSketchNames,
      isArmed: () => this.armed,
      apply: (wires) => {
        this.wires = wires;
        this.bases = this.bases.map(base => {
          if (base.kind !== 'wire') {
            return base;
          }
          const match = wires.find(o =>
            o.filePath === base.option.filePath && o.line === base.option.line);
          return match ? { kind: 'wire', option: match } : base;
        });
        this.refresh();
      },
    });
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
    return this.sketchUI.suspended;
  }

  update(sceneObjects: SceneObjectRender[]): void {
    this.sceneObjects = sceneObjects;
    this.planes = collectPlaneOptions(sceneObjects);
    const wireSources = collectWireSources(sceneObjects);
    this.wires = wireSources.filter(o => o.feature === 'helix');
    this.sceneSketchActive = wireSources[0]?.kind === 'active';
    if (!this.armed) {
      return;
    }
    // A render can put a sketch back in front (live editing) — the armed
    // dialog keeps the free 3D view.
    if (this.sceneSketchActive) {
      this.sketchUI.suspend();
    }
    // Shape ids changed with the render — picked bases are stale; plane and
    // wire bases re-match against the fresh options by source line.
    this.bases = this.bases.filter(base => {
      if (base.kind === 'pick') {
        return false;
      }
      if (base.kind === 'plane') {
        return this.planes.some(o =>
          o.filePath === base.option.filePath && o.line === base.option.line);
      }
      if (base.kind === 'wire') {
        return this.wires.some(o =>
          o.filePath === base.option.filePath && o.line === base.option.line);
      }
      return true;
    });
    void this.relabeler.refresh(this.planes);
    void this.wireRelabeler.refresh(this.wires);
    this.syncViewport();
    this.refresh();
    this.runner.schedulePreview();
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
      this.sketchUI.suspend();
    }
    this.syncButton();
    void this.refreshScopeVariables();
    this.panel.show();
    this.seedFromSelection(seed);
    void this.relabeler.refresh(this.planes);
    this.syncViewport();
    this.refresh();
    this.runner.schedulePreview();
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
      // A helix edge seeds as the named helix source, like a live pick.
      this.bases = [this.wireBaseForEdge(edges[0]) ?? { kind: 'pick', entity: edges[0] }];
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
    this.runner.cancelPreview();
    this.bases = [];
    this.viewer.clearHighlight();
    this.viewer.hideStandardPlanes();
    this.viewer.pickFilter = 'all';
    this.panel.hide();
    this.sketchUI.resume((opts.resume ?? 'immediate') === 'immediate');
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
      this.runner.schedulePreview();
      return;
    }
    // A helix's wire renders as a regular edge — clicking it selects the
    // helix as the named base (`plane(spring, …)`), not a raw edge pick.
    const wire = sub.type === 'edge' ? this.wireBaseForEdge(entity) : null;
    if (wire) {
      const picked = this.bases.findIndex(b => b.kind === 'wire'
        && b.option.filePath === wire.option.filePath && b.option.line === wire.option.line);
      if (picked >= 0) {
        this.bases.splice(picked, 1);
        this.refresh();
        this.runner.schedulePreview();
        return;
      }
      this.addBase(wire);
      return;
    }
    this.addBase({ kind: 'pick', entity });
  }

  /** The picked edge's owning helix as a wire base, when it is offered. */
  private wireBaseForEdge(entity: SelectedEntity): PlaneBaseItem & { kind: 'wire' } | null {
    const owner = resolveWireByShapeId(entity.shapeId, this.sceneObjects);
    if (owner?.type !== 'helix' || !owner.sourceLocation) {
      return null;
    }
    const loc = owner.sourceLocation;
    const option = this.wires.find(o => o.filePath === loc.filePath && o.line === loc.line);
    return option ? { kind: 'wire', option } : null;
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
    // A helix row is an edge source — it lands in the edge type's base slot.
    if (obj.type === 'helix' && obj.sourceLocation) {
      if (this.panel.planeType !== 'edge') {
        this.panel.setMessage('A helix is an edge source — switch to "From edge" to use it.');
        return true;
      }
      const loc = obj.sourceLocation;
      const option = this.wires.find(o => o.filePath === loc.filePath && o.line === loc.line);
      if (!option) {
        this.panel.setMessage('That helix was already consumed — only helixes still rendered in the scene can be used.');
        return true;
      }
      this.panel.setMessage(null);
      this.addBase({ kind: 'wire', option });
      return true;
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
    this.runner.schedulePreview();
  }

  /** The type changed: trim the base list to what the new type can take. */
  private handleTypeChange(): void {
    const type = this.panel.planeType;
    if (type === 'edge') {
      // Only an edge source survives into the edge form: a picked edge or a
      // helix.
      this.bases = this.bases
        .filter(b => (b.kind === 'pick' && b.entity.sub.type === 'edge') || b.kind === 'wire')
        .slice(0, 1);
    } else {
      // Edge picks and helixes belong to the edge form only.
      this.bases = this.bases
        .filter(b => b.kind !== 'wire' && (b.kind !== 'pick' || b.entity.sub.type === 'face'))
        .slice(0, this.panel.capacity);
    }
    this.syncViewport();
    this.refresh();
    this.runner.schedulePreview();
  }

  /**
   * Push the variables in scope at the end of the file (plane statements
   * append there) to the dialog's expression fields. A response landing
   * after the dialog closed is dropped.
   */
  private async refreshScopeVariables(): Promise<void> {
    await refreshScopeVariables(null, this.panel, () => this.armed);
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
      if (base.kind === 'wire') {
        const { filePath, line, column } = base.option;
        return { kind: 'wire', filePath, line, column };
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
    this.panel.setBases(this.bases.map(base =>
      base.kind === 'plane' || base.kind === 'wire'
        ? sourceChip(base.option)
        : { label: baseLabel(base) }));
    const type = this.panel.planeType;
    if (this.bases.length >= this.panel.capacity) {
      this.panel.setHint(null);
    } else if (type === 'edge') {
      this.panel.setHint('Pick an edge or a helix');
    } else {
      this.panel.setHint(this.bases.length === 0 && type === 'mid'
        ? 'Pick two faces or planes'
        : 'Pick a face or plane');
    }
    const picked = this.bases.flatMap(b => (b.kind === 'pick' ? [b.entity] : []));
    const wireIds = this.bases.flatMap(b =>
      b.kind === 'wire' ? sketchWireShapeIds(b.option, this.sceneObjects) : []);
    if (picked.length > 0 || wireIds.length > 0) {
      this.viewer.highlightEntities(picked, wireIds);
    } else {
      this.viewer.clearHighlight();
    }
  }

  private syncButton(): void {
    this.button.setActive(this.armed);
    // Every armed flip lands here — the Sketch button disables while a
    // create dialog is up.
    this.hooks.onActiveChange?.();
  }
}

function baseKey(base: PlaneBaseItem): string {
  if (base.kind === 'standard') {
    return `standard:${base.plane}`;
  }
  if (base.kind === 'plane') {
    return `plane:${base.option.filePath}:${base.option.line}`;
  }
  if (base.kind === 'wire') {
    return `wire:${base.option.filePath}:${base.option.line}`;
  }
  return `pick:${base.entity.shapeId}:${base.entity.sub.type}:${base.entity.sub.index}`;
}

function baseLabel(base: PlaneBaseItem): string {
  if (base.kind === 'standard') {
    return `${base.plane.toUpperCase()} plane`;
  }
  if (base.kind === 'plane' || base.kind === 'wire') {
    return base.option.label;
  }
  return base.entity.sub.type === 'face' ? 'Picked face' : 'Picked edge';
}
