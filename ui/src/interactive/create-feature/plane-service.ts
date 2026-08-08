import {
  applyPlane, applyPlaneEdit, fetchFeatureGhost, fetchFeatureSources, FeatureEditTarget,
  GhostPlaneBaseRef, GhostSolid, ParsedFeatureStatement, ParsedPlaneBase, PlaneApplyOptions,
  PlaneBaseRef, PlaneEditBaseRef, PlaneEditOptions, SketchSourceRef, SourceSlotRef,
} from '../../api';
import { sameEntity } from '../../helpers/entities';
import { SceneObjectRender, SubSelection } from '../../types';
import { SelectedEntity, Viewer } from '../../viewer';
import { StandardPlaneId } from '../../scene/standard-planes';
import { Navbar } from '../../ui/navbar';
import { EditSession, EditSessionInfo } from '../edit-session';
import { PlanePanel, PlaneValues } from './plane-panel';
import { FeatureButton } from './feature-button';
import { FeatureGhostOverlay } from './feature-ghost';
import { ApplyRunner } from './apply-runner';
import { SketchUISuspender } from './sketch-suspender';
import { OptionRelabeler, refreshScopeVariables } from './option-relabeler';
import {
  collectPlaneOptions, labelWithPlaneNames, PlaneOption, planeOptionForLocation, planeOptionForShape,
  planeOptionsSignature, planeQuadShapeIds, resolvePlaneRow,
} from './plane-bases';
import {
  collectWireSources, isSingleEdgeWire, keepChip, labelWithSketchNames, optionsSignature,
  resolveWireByShapeId, resolveWireRow, SketchProfileOption, sketchWireShapeIds, sourceChip,
} from './sketch-profiles';

/** One base in the dialog's list — the chip order is the argument order. */
type PlaneBaseItem =
  | { kind: 'standard'; plane: StandardPlaneId }
  | { kind: 'plane'; option: PlaneOption }
  /**
   * A single-curve sketch or a helix as the edge-type base — the statement
   * draws one edge, so the plane can be built from the source itself.
   */
  | { kind: 'wire'; option: SketchProfileOption }
  | { kind: 'pick'; entity: SelectedEntity }
  /**
   * Edit mode only: a base kept by its position in the statement, preserved
   * verbatim. `reads` is what its expression reads as — which dialog types
   * can keep it — and a keep that resolved to a statement carries that
   * statement's location (`loc`): it converts into its plane/helix option at
   * the rollback boundary, so the chip shows the statement's own label and a
   * re-pick toggles it like create mode.
   */
  | {
    kind: 'keep';
    sourceIndex: number;
    label: string;
    reads: ParsedPlaneBase['kind'];
    loc?: SketchSourceRef;
  };

/**
 * The Plane dialog on the create rails: a construction plane offset from one
 * base, midway between two bases, or normal to an edge at a position along
 * it. Bases collect into one loft-style chip list, filled entirely from the
 * scene: faces are picked in the 3D view while the dialog is armed (edges
 * only for the edge type — a helix's wire counts and lands as the named
 * helix source; clicking a picked entity removes it), the standard
 * origin planes are shown in the viewport as pick targets (the
 * sketch-on-plane mechanism), and existing plane features are picked on
 * their rendered quads or from timeline clicks. Arming with a selection already highlighted seeds the dialog: one
 * edge opens the edge type, one face the offset type, two faces the mid
 * type — each with the selection as base(s). Apply writes `plane(…)` — the
 * re-render is the preview, editor undo the rollback.
 *
 * A timeline double-click opens the same dialog over an existing statement
 * (see {@link enterEdit}), where the bases start as kept chips and Apply
 * rewrites the statement in place.
 */
export class PlaneFeatureService {
  private panel: PlanePanel;
  private button: FeatureButton;
  private armed = false;
  private planes: PlaneOption[] = [];
  /** The single-curve sketches and helixes the edge type can use as its base. */
  private wires: SketchProfileOption[] = [];
  private sceneObjects: SceneObjectRender[] = [];
  private bases: PlaneBaseItem[] = [];
  private sceneSketchActive = false;
  private sketchUI: SketchUISuspender;
  /** Statement being edited in place (timeline double-click), or null. */
  private editTarget: FeatureEditTarget | null = null;
  /** View-state half of edit mode: pre-statement rollback + boundary. */
  private session = new EditSession();
  private runner: ApplyRunner<PlaneApplyOptions | PlaneEditOptions>;
  private relabeler: OptionRelabeler<PlaneOption[]>;
  private wireRelabeler: OptionRelabeler<SketchProfileOption[]>;
  /** The translucent quad the current values would put in the scene. */
  private ghost: FeatureGhostOverlay;
  /**
   * Edit mode: what the edited statement's own bases currently name, by
   * argument index — how a kept chip written as a selector (`plane(select(face
   * (…)), 10)`) still gets a ghost. Null until the boundary resolves it.
   */
  private sourceBases: SourceSlotRef[] | null = null;

  constructor(
    container: HTMLElement,
    private viewer: Viewer,
    private navbar: Navbar,
    private hooks: {
      /**
       * Returns the current neutral selection and/or the pending plane
       * quad's shape id — they seed the dialog. (A plane pick is never a
       * {@link SelectedEntity}, so the plane rides its own field.)
       */
      onEnter?: () => { entities?: SelectedEntity[]; planeShapeId?: string | null };
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
    this.ghost = new FeatureGhostOverlay(viewer);

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
      build: () => this.editTarget ? this.buildEditRequest() : this.buildRequest(),
      send: (request, extras) => this.editTarget
        ? applyPlaneEdit(this.editTarget, { ...(request as PlaneEditOptions), ...extras })
        : applyPlane({ ...(request as PlaneApplyOptions), ...extras }),
      onApplied: () => this.exit(this.editTarget ? { editEnd: 'apply' } : { resume: 'lazy' }),
      failMessage: () => this.editTarget ? 'Could not apply the edit.' : 'Could not apply the plane.',
      // The statement preview's geometric twin: the quad the values describe,
      // drawn in the viewport. Same debounce, same abort scope.
      ghost: {
        fetch: (_request, signal) => this.fetchGhost(signal),
        apply: (solids) => {
          if (solids) {
            this.ghost.set(solids, 'plane');
          } else {
            this.ghost.clear();
          }
        },
      },
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
          const match = planeOptionForLocation(planes, base.option);
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
          const match = this.wireOptionForLocation(base.option);
          return match ? { kind: 'wire', option: match } : base;
        });
        this.refresh();
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

  /** The toolbar button, mirrored into the Finish Sketch grid during sketch mode. */
  get toolbarButton(): FeatureButton {
    return this.button;
  }

  /** Picks are live the whole time armed — the viewer routes clicks here. */
  get isPicking(): boolean {
    return this.armed;
  }

  /** Plane-quad clicks route here — the offset and mid types take planes. */
  get isPlanePicking(): boolean {
    return this.armed && this.panel.planeType !== 'edge';
  }

  /** True while the armed dialog has suspended sketch editing. */
  get sketchUISuspended(): boolean {
    return this.sketchUI.suspended;
  }

  /**
   * Every render lands here. An open edit session owns the view: it keeps the
   * viewport rolled back to just before the edited statement, and at that
   * boundary the base options rebuild from the pre-statement scene — exactly
   * the planes and helixes the statement's own bases can reference.
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
      this.ghost.clear();
      return;
    }
    this.ghost.clear();
    this.collectOptions(sceneObjects);
    this.remapBases();
    if (!this.sourceBases) {
      void this.loadEditSources();
    }
    void this.relabeler.refresh(this.planes);
    void this.wireRelabeler.refresh(this.wires);
    this.refresh();
    this.runner.schedulePreview();
  }

  update(sceneObjects: SceneObjectRender[]): void {
    this.collectOptions(sceneObjects);
    if (!this.armed) {
      return;
    }
    // The geometry under the ghost just changed — drop it now and let the
    // debounce redraw it. Correctness over the flicker.
    this.ghost.clear();
    // A render can put a sketch back in front (live editing) — the armed
    // dialog keeps the free 3D view.
    if (this.sceneSketchActive) {
      this.sketchUI.suspend();
    }
    this.remapBases();
    void this.relabeler.refresh(this.planes);
    void this.wireRelabeler.refresh(this.wires);
    this.refresh();
    this.runner.schedulePreview();
  }

  /** The scene-derived option lists behind the base slot. */
  private collectOptions(sceneObjects: SceneObjectRender[]): void {
    this.sceneObjects = sceneObjects;
    this.planes = collectPlaneOptions(sceneObjects);
    const wireSources = collectWireSources(sceneObjects);
    // A from-edge plane addresses the whole statement, so only sources that
    // draw exactly one edge qualify — every helix, and the sketches holding a
    // single curve.
    this.wires = wireSources.filter(o => isSingleEdgeWire(o, sceneObjects));
    this.sceneSketchActive = wireSources[0]?.kind === 'active';
  }

  /**
   * Re-address the base list against the freshly collected options: shape ids
   * changed with the render, so picked bases are stale and drop; plane and
   * wire bases re-match by source line; and a kept base (edit mode) that
   * resolved to a statement becomes that statement's option — proper label,
   * create-mode toggling. Unresolved keeps stay text-addressed verbatim.
   */
  private remapBases(): void {
    this.bases = this.bases.flatMap((base): PlaneBaseItem[] => {
      if (base.kind === 'pick') {
        return [];
      }
      if (base.kind === 'plane') {
        const match = planeOptionForLocation(this.planes, base.option);
        return match ? [{ kind: 'plane', option: match }] : [];
      }
      if (base.kind === 'wire') {
        const match = this.wireOptionForLocation(base.option);
        return match ? [{ kind: 'wire', option: match }] : [];
      }
      if (base.kind === 'keep' && base.loc) {
        const plane = planeOptionForLocation(this.planes, base.loc);
        if (plane) {
          return [{ kind: 'plane', option: plane }];
        }
        const wire = this.wireOptionForLocation(base.loc);
        if (wire) {
          return [{ kind: 'wire', option: wire }];
        }
      }
      return [base];
    });
  }

  /** The offered helix wire at a source location, if it is still offered. */
  private wireOptionForLocation(loc: { filePath: string; line: number }): SketchProfileOption | undefined {
    return this.wires.find(o => o.filePath === loc.filePath && o.line === loc.line);
  }

  /**
   * Open the dialog over an existing plane statement (timeline double-click).
   * The session rolls the viewport back to just before the statement — the
   * world its bases see, where the geometry they name is visible and
   * pickable. The type is the form the statement reads as; its bases seed as
   * kept chips (a standard origin plane seeds as that plane, so it toggles
   * like a fresh pick), re-picked and re-typed like create mode. Apply
   * rewrites the statement in place.
   */
  enterEdit(
    target: FeatureEditTarget,
    parsed: Extract<ParsedFeatureStatement, { feature: 'plane' }>,
    info: Omit<EditSessionInfo, 'target'>,
  ): void {
    if (this.armed) {
      this.exit();
    }
    this.hooks.onEnter?.();
    this.armed = true;
    this.editTarget = target;
    this.bases = parsed.bases.map((base, sourceIndex): PlaneBaseItem => base.standard !== null
      ? { kind: 'standard', plane: base.standard }
      : {
        kind: 'keep',
        sourceIndex,
        label: base.text,
        reads: base.kind,
        loc: base.ref ? { filePath: target.filePath, ...base.ref } : undefined,
      });
    this.sourceBases = null;
    this.syncButton();
    this.sketchUI.suspend();
    this.session.begin({ ...info, target });
    void this.loadEditSources();
    void this.refreshScopeVariables();
    this.panel.showEdit(parsed);
    this.refresh();
    this.runner.schedulePreview();
  }

  enter(): void {
    if (this.armed) {
      return;
    }
    this.session.end('continue');
    const seeded = this.hooks.onEnter?.() ?? {};
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
    this.seedFromSelection(seeded.entities ?? [], seeded.planeShapeId ?? null);
    void this.relabeler.refresh(this.planes);
    this.refresh();
    this.runner.schedulePreview();
  }

  /**
   * Arm the dialog around whatever was already selected: one edge opens the
   * edge type on it, one face the offset type, two faces the mid type, and a
   * selected plane quad (the neutral-mode pending plane) the offset type on
   * that plane. Any other selection starts blank.
   */
  private seedFromSelection(seed: SelectedEntity[], planeShapeId: string | null): void {
    if (planeShapeId) {
      const option = planeOptionForShape(planeShapeId, this.sceneObjects, this.planes);
      this.bases = option ? [{ kind: 'plane', option }] : [];
      return;
    }
    const faces = seed.filter(e => e.sub.type === 'face');
    const edges = seed.filter(e => e.sub.type === 'edge');
    if (seed.length === 1 && edges.length === 1) {
      this.panel.setType('edge');
      // A helix edge seeds as the named helix source, like a live pick.
      this.bases = [this.wireBaseFor(edges[0].shapeId) ?? { kind: 'pick', entity: edges[0] }];
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
   * default to `'immediate'`; ending an edit session always resumes lazily
   * (a render follows every session end).
   */
  exit(opts: { resume?: 'immediate' | 'lazy'; editEnd?: 'apply' | 'cancel' | 'continue' | 'gone' } = {}): void {
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
    this.sourceBases = null;
    this.syncButton();
    this.runner.cancelPreview();
    // The overlay is a compiledMesh sibling, so no render tears it down —
    // every way out of the dialog (apply, cancel, scene-driven) lands here.
    this.ghost.clear();
    this.bases = [];
    this.viewer.clearHighlight();
    this.viewer.hideStandardPlanes();
    this.viewer.pickFilter = 'all';
    this.viewer.pickSketchWires = false;
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
        ? 'A from-edge plane needs an edge — pick an edge or a sketch curve.'
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
    const wire = this.wireBaseFor(shapeId);
    if (wire) {
      this.toggleBase(wire);
      return;
    }
    this.addBase({ kind: 'pick', entity });
  }

  /**
   * A sketch's drawn geometry was clicked — the sketch-wire channel the edge
   * type opens (see {@link syncViewport}). The pick names the sketch, not one
   * of its edges, so it only makes a base where the sketch draws a single
   * curve: the case `plane(<sketch>, …)` resolves to an edge. Returns whether
   * the dialog consumed the click.
   */
  handleSketchPick(shapeId: string): boolean {
    if (!this.armed) {
      return false;
    }
    const source = resolveWireByShapeId(shapeId, this.sceneObjects);
    if (!source?.sourceLocation) {
      return false;
    }
    if (this.panel.planeType !== 'edge') {
      this.panel.setMessage('A sketch curve is an edge source — switch to "From edge" to use it.');
      return true;
    }
    const option = this.wireOptionForLocation(source.sourceLocation);
    if (!option) {
      this.panel.setMessage(source.type === 'helix'
        ? 'That helix was already consumed — only helixes still rendered in the scene can be used.'
        : 'That sketch draws more than one curve — a from-edge plane needs a sketch holding a single curve.');
      return true;
    }
    this.panel.setMessage(null);
    this.toggleBase({ kind: 'wire', option });
    return true;
  }

  /**
   * A plane feature's quad was clicked (the offset and mid types open the
   * viewer's plane-quad channel — see {@link syncViewport}): the plane joins
   * the base list, and clicking a chosen plane's quad removes it.
   */
  handlePlanePick(shapeId: string): void {
    if (!this.isPlanePicking) {
      return;
    }
    const option = planeOptionForShape(shapeId, this.sceneObjects, this.planes);
    if (!option) {
      this.panel.setMessage('That plane cannot be referenced — only plane() features can be a base.');
      return;
    }
    this.panel.setMessage(null);
    this.toggleBase({ kind: 'plane', option });
  }

  /** The picked shape's owning sketch or helix as a wire base, when offered. */
  private wireBaseFor(shapeId: string): PlaneBaseItem & { kind: 'wire' } | null {
    const owner = resolveWireByShapeId(shapeId, this.sceneObjects);
    if (!owner?.sourceLocation) {
      return null;
    }
    const option = this.wireOptionForLocation(owner.sourceLocation);
    return option ? { kind: 'wire', option } : null;
  }

  /** Add a base, or drop it when that same base is already chosen. */
  private toggleBase(item: PlaneBaseItem): void {
    const picked = this.bases.findIndex(b => baseKey(b) === baseKey(item));
    if (picked >= 0) {
      this.bases.splice(picked, 1);
      this.refresh();
      this.runner.schedulePreview();
      return;
    }
    this.addBase(item);
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
    // A helix or single-curve sketch row is an edge source — it lands in the
    // edge type's base slot.
    const wireRow = resolveWireRow(obj, this.sceneObjects);
    if (wireRow?.sourceLocation && (obj.type === 'helix' || this.panel.planeType === 'edge')) {
      const helix = wireRow.type === 'helix';
      if (this.panel.planeType !== 'edge') {
        this.panel.setMessage('A helix is an edge source — switch to "From edge" to use it.');
        return true;
      }
      const option = this.wireOptionForLocation(wireRow.sourceLocation);
      if (!option) {
        this.panel.setMessage(helix
          ? 'That helix was already consumed — only helixes still rendered in the scene can be used.'
          : 'That sketch is consumed or draws more than one curve — a from-edge plane needs a sketch holding a single curve.');
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
    const option = planeOptionForLocation(this.planes, plane.sourceLocation!);
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
      // Only an edge source survives into the edge form: a picked edge, a
      // helix, or a kept base whose expression names an edge.
      this.bases = this.bases
        .filter(b => (b.kind === 'pick' && b.entity.sub.type === 'edge') || b.kind === 'wire'
          || (b.kind === 'keep' && b.reads === 'edge'))
        .slice(0, 1);
    } else {
      // Edge picks, helixes and kept edge expressions belong to the edge form
      // only.
      this.bases = this.bases
        .filter(b => b.kind !== 'wire' && (b.kind !== 'pick' || b.entity.sub.type === 'face')
          && (b.kind !== 'keep' || b.reads !== 'edge'))
        .slice(0, this.panel.capacity);
    }
    this.refresh();
    this.runner.schedulePreview();
  }

  /**
   * Push the variables in scope at the edited statement (edit mode) or at the
   * end of the file (create mode — plane statements append there) to the
   * dialog's expression fields. A response landing after the dialog closed or
   * re-targeted is dropped.
   */
  private async refreshScopeVariables(): Promise<void> {
    const line = this.editTarget?.line ?? null;
    await refreshScopeVariables(line, this.panel,
      () => this.armed && (this.editTarget?.line ?? null) === line);
  }

  /** The form's values, or the message blocking either apply path. */
  private formValues(): PlaneValues {
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
    return values;
  }

  /**
   * The live geometry for the current form state — the quad the statement
   * would put in the scene, drawn where it would land. It runs off the values
   * the statement preview just validated, so all that is left is to address the
   * bases, and that is where the create and edit dialogs converge: both hand
   * the server explicit refs, so the endpoint never has to know which mode
   * asked.
   *
   * A base the ghost can't address means no ghost. In practice that is one
   * case: an edit dialog over a base written as a selector (`plane(select(face
   * (…)), 10)`), whose kept chip names an expression rather than a statement —
   * every other chip is a pick, a statement, or an origin plane, all of which
   * the kernel resolves.
   */
  private async fetchGhost(signal: AbortSignal): Promise<GhostSolid[] | null> {
    const values = this.formValues();
    if ('error' in values) {
      return null;
    }
    const bases: GhostPlaneBaseRef[] = [];
    for (const base of this.bases) {
      const ref = this.ghostBaseRef(base);
      if (!ref) {
        return null;
      }
      bases.push(ref);
    }
    return fetchFeatureGhost({
      feature: 'plane',
      type: values.type,
      bases,
      offset: values.offset,
      rotateX: values.rotateX,
      rotateY: values.rotateY,
      rotateZ: values.rotateZ,
      position: values.position,
    }, signal);
  }

  /** One chosen base in the form the kernel resolves, or null when unaddressable. */
  private ghostBaseRef(base: PlaneBaseItem): GhostPlaneBaseRef | null {
    if (base.kind === 'standard') {
      return { kind: 'standard', plane: base.plane };
    }
    if (base.kind === 'plane') {
      return { kind: 'plane', filePath: base.option.filePath, line: base.option.line };
    }
    if (base.kind === 'wire') {
      return { kind: 'wire', filePath: base.option.filePath, line: base.option.line };
    }
    if (base.kind === 'pick') {
      const { shapeId, sub } = base.entity;
      return sub.type === 'face' || sub.type === 'edge'
        ? { kind: sub.type, shapeId, index: sub.index }
        : null;
    }
    return this.keepBaseRef(base);
  }

  /**
   * A kept base's ref: what the statement's own argument currently names, read
   * off the resolved sources. A keep whose expression is a plain identifier was
   * already remapped to its plane or wire chip at the boundary, so the case
   * that lands here is the selector one — `plane(select(face(…)), 10)` — whose
   * face the sources query maps onto the rolled-back solids. Null while that
   * query is still in flight (its completion re-kicks the preview) or when the
   * argument is an expression it couldn't address.
   */
  private keepBaseRef(base: PlaneBaseItem & { kind: 'keep' }): GhostPlaneBaseRef | null {
    const slot = this.sourceBases?.[base.sourceIndex];
    if (!slot) {
      return null;
    }
    if (slot.kind === 'sketch') {
      // A statement base: an edge-form keep stands on a wire, any other on a
      // plane — the same reading that decides which types can keep it.
      return { kind: base.reads === 'edge' ? 'wire' : 'plane', filePath: slot.filePath, line: slot.line };
    }
    if (slot.kind !== 'entities' || slot.entities.length !== 1) {
      // A plane base is one face or one edge; anything else is an expression
      // the ghost has no single frame for.
      return null;
    }
    const { shapeId, sub } = slot.entities[0];
    return { kind: sub.type, shapeId, index: sub.index };
  }

  /**
   * Resolve what the edited statement's bases currently name, for the ghost's
   * kept chips. A response landing after the dialog closed or moved to another
   * boundary is dropped; a successful one re-kicks the preview, since
   * `enterEdit` scheduled its own before this was known.
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
    this.sourceBases = result.ok && result.feature === 'plane' ? result.bases : [];
    this.runner.schedulePreview();
  }

  /** One chosen base as its request ref (never a keep — see the edit path). */
  private baseRef(base: Exclude<PlaneBaseItem, { kind: 'keep' }>): PlaneBaseRef {
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
  }

  /** The request for the current form state, or the message blocking it. */
  private buildRequest(): PlaneApplyOptions | { error: string } {
    const values = this.formValues();
    if ('error' in values) {
      return values;
    }
    // Create mode never carries keep entries — every chip is a chosen base.
    return {
      ...values,
      bases: this.bases.flatMap(base => base.kind === 'keep' ? [] : [this.baseRef(base)]),
    };
  }

  /**
   * The edit-mode apply payload. Untouched chips ship as verbatim keeps — the
   * transform preserves the statement's own base expressions byte for byte —
   * while re-picked bases ride as their refs; the values always rewrite (the
   * dialog owns every one of them). A boundary rides only when a base was
   * re-picked, the one input synthesized against the rolled-back scene.
   */
  private buildEditRequest(): PlaneEditOptions | { error: string } {
    const values = this.formValues();
    if ('error' in values) {
      return values;
    }
    const bases: PlaneEditBaseRef[] = this.bases.map(base => base.kind === 'keep'
      ? { kind: 'verbatim', sourceIndex: base.sourceIndex }
      : this.baseRef(base));
    return {
      ...values,
      bases,
      expectedStatement: this.session.expectedStatement,
      before: this.bases.some(b => b.kind === 'pick') ? this.session.boundary ?? undefined : undefined,
    };
  }

  // -------------------------------------------------------------------------
  // Viewport reflection + sketch-editing suspension
  // -------------------------------------------------------------------------

  /**
   * Align the viewport with the type and the base list: the origin planes show
   * as pick targets while armed (re-shown on every pass to re-size to the
   * scene) and the pick filter narrows scene picks to faces (offset/mid) or
   * edges (edge type). The edge type also opens the sketch-wire channel, so a
   * bare sketch curve — which renders as a wire, outside the solid-edge bucket
   * — can be picked. The face types open the plane-quad channel instead, so
   * an existing plane() feature can be picked as a base right on its quad.
   *
   * Called from {@link refresh}, so the quads always follow the chips.
   */
  private syncViewport(): void {
    if (!this.armed) {
      return;
    }
    const edgeType = this.panel.planeType === 'edge';
    this.viewer.pickFilter = edgeType ? 'edge' : 'face';
    this.viewer.pickSketchWires = edgeType;
    // No exit reset needed: leaving the dialog runs the modify service's
    // neutral-mode restore (via syncButton's onActiveChange), which owns
    // the plane-quad channel from there.
    this.viewer.pickPlanes = !edgeType;
    // The edge type's only base is a curve, so its quads never help.
    if (edgeType || this.standardBaseFills()) {
      this.viewer.hideStandardPlanes();
    } else {
      this.viewer.showStandardPlanes(this.onStandardPlanePick);
    }
  }

  /**
   * An origin plane is chosen and the base list is full. The quads are pick
   * targets and nothing else — once no further pick can land on one, they only
   * sit across the ghost they were picked for, in the exact place the user is
   * trying to look. Removing the chip (✕) empties the slot and brings them
   * back, which is the only way to swap one origin plane for another.
   *
   * Waiting for the list to be *full* is what keeps a mid plane between two
   * origin planes possible: hiding on the first pick would take the second
   * base's own target off the screen.
   */
  private standardBaseFills(): boolean {
    return this.bases.length >= this.panel.capacity
      && this.bases.some(base => base.kind === 'standard');
  }

  /**
   * Repaint the chips, the hint box, the picked-entity highlights, and the
   * viewport's pick channels — everything that follows from the base list.
   */
  private refresh(): void {
    if (!this.armed) {
      return;
    }
    this.syncViewport();
    this.panel.setBases(this.bases.map(base =>
      base.kind === 'plane' || base.kind === 'wire'
        ? sourceChip(base.option)
        : base.kind === 'keep'
          ? keepChip(base.label)
          : { label: baseLabel(base) }));
    const type = this.panel.planeType;
    if (this.bases.length >= this.panel.capacity) {
      this.panel.setHint(null);
    } else if (type === 'edge') {
      this.panel.setHint('Pick an edge, a sketch curve or a helix');
    } else {
      this.panel.setHint(this.bases.length === 0 && type === 'mid'
        ? 'Pick two faces or planes'
        : 'Pick a face or plane');
    }
    const picked = this.bases.flatMap(b => (b.kind === 'pick' ? [b.entity] : []));
    const wireIds = this.bases.flatMap(b =>
      b.kind === 'wire' ? sketchWireShapeIds(b.option, this.sceneObjects) : []);
    const quadIds = this.bases.flatMap(b =>
      b.kind === 'plane' ? planeQuadShapeIds(b.option, this.sceneObjects) : []);
    if (picked.length > 0 || wireIds.length > 0 || quadIds.length > 0) {
      this.viewer.highlightEntities(picked, wireIds, [], quadIds);
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
  if (base.kind === 'keep') {
    return `keep:${base.sourceIndex}`;
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
  if (base.kind === 'keep') {
    return base.label;
  }
  return base.entity.sub.type === 'face' ? 'Picked face' : 'Picked edge';
}
