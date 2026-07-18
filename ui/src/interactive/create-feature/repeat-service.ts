import {
  applyRepeat, ApplyFeatureResponse, RepeatApplyOptions, RepeatDirectionRef, RepeatPlaneRef,
  RevolveAxisRef,
} from '../../api';
import { sameEntity } from '../../helpers/entities';
import { SceneObjectRender, SubSelection } from '../../types';
import { SelectedEntity, Viewer } from '../../viewer';
import { StandardPlaneId } from '../../scene/standard-planes';
import { Navbar } from '../../ui/navbar';
import { ICON_IMG_FALLBACK } from '../../ui/object-icons';
import { RepeatDirection, RepeatPanel } from './repeat-panel';
import { collectRepeatTargets, RepeatTargetOption, resolveRepeatTargetRow } from './repeat-targets';
import {
  AxisOption, axisLineShapeIds, axisOptionsSignature, collectAxisOptions, labelWithAxisNames,
  resolveAxisByShapeId,
} from './axis-options';
import {
  collectPlaneOptions, labelWithPlaneNames, PlaneOption, planeOptionsSignature, resolvePlaneByShapeId,
} from './plane-bases';
import { collectSketchProfiles, sourceChip } from './sketch-profiles';

const BTN_BASE = 'btn btn-ghost btn-sm h-auto flex-col gap-0.5 px-2 py-1 text-base-content/60';
const BTN_ACTIVE = 'btn btn-soft btn-primary btn-sm h-auto flex-col gap-0.5 px-2 py-1';
/** Small muted caption under the toolbar icon. */
const BTN_LABEL = 'text-[10px] leading-none text-base-content/50';

const PREVIEW_DEBOUNCE_MS = 250;

/** What the seeding hook hands over when the dialog arms. */
export type RepeatEnterSeed = {
  /** The neutral-mode selection (faces/edges) at activation. */
  seed: SelectedEntity[];
  /** The neutral-mode pending plane quad (a clicked plane feature), if any. */
  pendingPlaneShapeId: string | null;
};

/**
 * The Repeat dialog on the create rails: replay one or more timeline
 * features linearly, circularly, mirrored across a plane, or rotated. The
 * features are picked ONLY in the timeline (each row click toggles a
 * numbered chip); the axis comes from the X/Y/Z quick buttons, an axis
 * statement (its dashed line in 3D or its timeline row), or a picked solid
 * edge; the mirror plane from an origin-plane quad, a plane feature (its
 * quad or timeline row), or a picked face. Arming with a selection already
 * highlighted seeds the dialog: one edge opens the Linear type with the edge
 * as the axis, one face (or a pending plane) the Mirror type with it as the
 * plane. Apply writes `repeat('<kind>', …)` — the re-render is the preview,
 * editor undo the rollback. No live geometry preview in this version.
 */
export class RepeatFeatureService {
  private panel: RepeatPanel;
  private button: HTMLButtonElement;
  /** daisyUI tooltip wrapper around {@link button}. */
  private buttonWrap: HTMLElement;
  private armed = false;
  private available = false;
  private applying = false;
  private targetOptions: RepeatTargetOption[] = [];
  /** The chosen targets, in pick order — the repeat's argument order. */
  private targets: RepeatTargetOption[] = [];
  private axes: AxisOption[] = [];
  private planes: PlaneOption[] = [];
  private sceneObjects: SceneObjectRender[] = [];
  private sceneSketchActive = false;
  private suspendedSketchUI = false;
  /** Per-direction picked axis edges (the axis slots' `edge` mode). */
  private axisEdgeEntities = new Map<RepeatDirection, SelectedEntity | null>([[1, null], [2, null]]);
  /** The picked mirror face (the plane slot's `face` mode), or null. */
  private planeFaceEntity: SelectedEntity | null = null;
  private labelSignature = '';
  private previewTimer: number | null = null;
  private previewAbort: AbortController | null = null;
  private previewSeq = 0;

  constructor(
    container: HTMLElement,
    private viewer: Viewer,
    private navbar: Navbar,
    private hooks: {
      /** May return the current selection state — it seeds the dialog. */
      onEnter?: () => RepeatEnterSeed | void;
      /** Armed or disarmed — lets the Sketch button owner re-check `isActive`. */
      onActiveChange?: () => void;
      onSuspendSketchUI?: () => void;
      onResumeSketchUI?: () => void;
    } = {},
  ) {
    // Repeat rides its own group, registered after the create and modify
    // rails so its button renders last — the navbar draws the separator
    // before it whenever a visible group precedes. `immune` keeps it
    // reachable while the sketch toolbar owns the bar, like the create rail.
    const group = navbar.addGroup('repeat', { visible: false, immune: true });
    this.button = document.createElement('button');
    this.button.className = BTN_BASE;
    this.button.setAttribute('aria-label', 'Repeat features along an axis, around an axis, or mirrored');
    this.button.innerHTML = `<img src="/icons/copy-linear.png" ${ICON_IMG_FALLBACK} class="w-8 h-8 object-contain" alt="" /><span class="${BTN_LABEL}">Repeat</span>`;
    this.button.addEventListener('click', () => {
      if (this.armed) {
        this.exit();
      } else {
        this.enter();
      }
    });
    this.buttonWrap = document.createElement('span');
    this.buttonWrap.className = 'tooltip tooltip-bottom';
    this.buttonWrap.dataset.tip = 'Repeat features';
    this.buttonWrap.appendChild(this.button);
    group.appendChild(this.buttonWrap);

    this.panel = new RepeatPanel(container);
    this.panel.onApply = () => this.apply();
    this.panel.onExit = () => this.exit();
    this.panel.onChange = () => {
      this.panel.setMessage(null);
      this.refreshHighlight();
      this.schedulePreview();
    };
    this.panel.onTypeChange = () => {
      this.syncViewport();
      this.refreshHighlight();
    };
    this.panel.onRemoveTarget = (index) => {
      this.targets.splice(index, 1);
      this.panel.setMessage(null);
      this.refresh();
      this.schedulePreview();
    };
    this.panel.onAxisModeChange = (direction) => {
      // The slot left edge mode (✕, a standard/axis choice) — the entity
      // would otherwise silently ride along into the next edge state.
      this.axisEdgeEntities.set(direction, null);
      this.refreshHighlight();
    };
    this.panel.onPlaneModeChange = () => {
      this.planeFaceEntity = null;
      this.refreshHighlight();
    };
    this.panel.onArmedSlotChange = () => this.syncViewport();
  }

  get isActive(): boolean {
    return this.armed;
  }

  /**
   * The armed dialog owns viewport clicks; which picks are actually live
   * follows the kind type ({@link syncViewport}) — the viewer routes edge,
   * face, axis and plane-quad clicks here.
   */
  get isPicking(): boolean {
    return this.armed;
  }

  /** Axis-line and edge clicks route here (an armed axis slot). */
  get isAxisPicking(): boolean {
    return this.armed && (this.panel.armedSlot === 'axis1' || this.panel.armedSlot === 'axis2');
  }

  /** Plane-quad and face clicks route here (the armed plane slot). */
  get isPlanePicking(): boolean {
    return this.armed && this.panel.armedSlot === 'plane';
  }

  /** True while armed picking has suspended sketch editing. */
  get sketchUISuspended(): boolean {
    return this.suspendedSketchUI;
  }

  update(sceneObjects: SceneObjectRender[]): void {
    this.sceneObjects = sceneObjects;
    this.targetOptions = collectRepeatTargets(sceneObjects);
    this.axes = collectAxisOptions(sceneObjects);
    this.planes = collectPlaneOptions(sceneObjects);
    this.sceneSketchActive = collectSketchProfiles(sceneObjects)[0]?.kind === 'active';
    this.available = this.targetOptions.length > 0;
    this.navbar.setGroupVisible('repeat', this.available);
    this.syncButton();
    if (!this.armed) {
      return;
    }
    if (!this.available) {
      this.exit({ resume: 'lazy' });
      return;
    }
    // A render can put a sketch back in front (live editing) — the armed
    // dialog keeps the free 3D view.
    if (this.sceneSketchActive) {
      this.suspendSketchUI();
    }
    // Chosen targets re-match against the fresh options by source line;
    // shape ids changed with the render, so picked entities are stale and
    // drop back to their pick prompts.
    this.targets = this.targets.flatMap(target => {
      const match = this.targetOptions.find(o =>
        o.filePath === target.filePath && o.line === target.line);
      return match ? [match] : [];
    });
    for (const direction of [1, 2] as const) {
      if (this.axisEdgeEntities.get(direction)) {
        this.axisEdgeEntities.set(direction, null);
        this.panel.setAxisEdgeChip(direction, null);
      }
    }
    if (this.planeFaceEntity) {
      this.planeFaceEntity = null;
      this.panel.setPlaneFaceChip(null);
    }
    this.panel.setOptions(this.axes, this.planes);
    this.refreshLabels();
    this.syncViewport();
    this.refresh();
    this.schedulePreview();
  }

  enter(): void {
    if (this.armed) {
      return;
    }
    const seeded = this.hooks.onEnter?.();
    this.armed = true;
    this.targets = [];
    this.axisEdgeEntities.set(1, null);
    this.axisEdgeEntities.set(2, null);
    this.planeFaceEntity = null;
    // Composing a repeat means looking at the whole scene, not down the
    // active sketch plane — leave sketch editing right away (resumed on
    // cancel; an apply's re-render takes over).
    if (this.sceneSketchActive) {
      this.suspendSketchUI();
    }
    this.syncButton();
    this.panel.show();
    if (seeded) {
      this.seedFromSelection(seeded);
    }
    this.panel.setOptions(this.axes, this.planes);
    this.refreshLabels();
    this.syncViewport();
    this.refresh();
    this.schedulePreview();
  }

  /**
   * Arm the dialog around whatever was already selected: a pending plane or
   * a single face opens the Mirror type with it as the plane; a single edge
   * opens the Linear type with it as the axis. Any other selection starts on
   * the Linear type blank.
   */
  private seedFromSelection({ seed, pendingPlaneShapeId }: RepeatEnterSeed): void {
    if (pendingPlaneShapeId) {
      const plane = resolvePlaneByShapeId(pendingPlaneShapeId, this.sceneObjects);
      const option = plane?.sourceLocation
        ? this.planes.find(o =>
          o.filePath === plane.sourceLocation!.filePath && o.line === plane.sourceLocation!.line)
        : undefined;
      if (option) {
        this.panel.setType('mirror');
        this.panel.selectPlane(option);
        return;
      }
    }
    const faces = seed.filter(e => e.sub.type === 'face');
    const edges = seed.filter(e => e.sub.type === 'edge');
    if (seed.length === 1 && edges.length === 1) {
      this.axisEdgeEntities.set(1, edges[0]);
      this.panel.setAxisEdgeChip(1, 'Picked edge');
      this.panel.armSlot('axis1');
      return;
    }
    if (seed.length === 1 && faces.length === 1) {
      this.panel.setType('mirror');
      this.planeFaceEntity = faces[0];
      this.panel.setPlaneFaceChip('Picked face');
      this.panel.armSlot('plane');
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
    this.targets = [];
    this.axisEdgeEntities.set(1, null);
    this.axisEdgeEntities.set(2, null);
    this.planeFaceEntity = null;
    this.cancelPreview();
    this.viewer.clearHighlight();
    this.viewer.hideStandardPlanes();
    this.viewer.pickFilter = 'all';
    this.viewer.pickAxes = false;
    // pickPlanes is left alone: syncButton's onActiveChange runs the modify
    // service's neutral-mode restore, which owns that channel.
    this.syncButton();
    this.panel.hide();
    this.resumeSketchUI((opts.resume ?? 'immediate') === 'immediate');
  }

  /**
   * Routes viewer clicks while the dialog is armed — the pick channels
   * follow the armed slot, so only its picks arrive. An armed axis slot: a
   * solid edge sets that direction's axis to the edge (clicking it again
   * clears it back), an axis line sets it to that statement. The armed plane
   * slot: a face sets the mirror plane to that face (clicking it again
   * clears it back). Empty-space clicks keep the selection.
   */
  handleClick(shapeId: string | null, sub: SubSelection): void {
    if (!this.armed || !shapeId || !sub) {
      return;
    }
    if (sub.type === 'axis') {
      if (!this.isAxisPicking) {
        return;
      }
      const axis = resolveAxisByShapeId(shapeId, this.sceneObjects);
      const option = axis?.sourceLocation
        ? this.axes.find(o => o.filePath === axis.sourceLocation!.filePath && o.line === axis.sourceLocation!.line)
        : undefined;
      if (!option) {
        this.panel.setMessage('That axis was already consumed — only axes still shown in the scene can be picked.');
        return;
      }
      this.axisEdgeEntities.set(this.panel.armedAxis, null);
      this.panel.selectAxis(option);
      this.panel.setMessage(null);
      this.refreshHighlight();
      this.schedulePreview();
      return;
    }
    if (sub.type === 'edge' && this.isAxisPicking) {
      // The pick lands in the armed direction's slot; re-clicking that
      // direction's edge clears it back.
      const direction = this.panel.armedAxis;
      const entity: SelectedEntity = { shapeId, sub };
      const current = this.axisEdgeEntities.get(direction);
      const next = current && sameEntity(current, entity) ? null : entity;
      this.axisEdgeEntities.set(direction, next);
      this.panel.setAxisEdgeChip(direction, next ? 'Picked edge' : null);
      this.panel.setMessage(null);
      this.refreshHighlight();
      this.schedulePreview();
      return;
    }
    if (sub.type === 'face' && this.isPlanePicking) {
      const entity: SelectedEntity = { shapeId, sub };
      this.planeFaceEntity = this.planeFaceEntity && sameEntity(this.planeFaceEntity, entity) ? null : entity;
      this.panel.setPlaneFaceChip(this.planeFaceEntity ? 'Picked face' : null);
      this.panel.setMessage(null);
      this.refreshHighlight();
      this.schedulePreview();
    }
  }

  /** A plane feature's quad was clicked while the Mirror type is up. */
  handlePlanePick(shapeId: string): void {
    if (!this.isPlanePicking) {
      return;
    }
    const plane = resolvePlaneByShapeId(shapeId, this.sceneObjects);
    const option = plane?.sourceLocation
      ? this.planes.find(o =>
        o.filePath === plane.sourceLocation!.filePath && o.line === plane.sourceLocation!.line)
      : undefined;
    if (!option) {
      this.panel.setMessage('That plane cannot be referenced — only plane() features can mirror.');
      return;
    }
    this.planeFaceEntity = null;
    this.panel.selectPlane(option);
    this.panel.setMessage(null);
    this.refreshHighlight();
    this.schedulePreview();
  }

  /** A shown origin plane was clicked while the Mirror type is up. */
  private readonly onStandardPlanePick = (plane: StandardPlaneId): void => {
    if (!this.isPlanePicking) {
      return;
    }
    this.planeFaceEntity = null;
    this.panel.selectStandardPlane(plane);
    this.panel.setMessage(null);
    this.refreshHighlight();
    this.schedulePreview();
  };

  /**
   * A timeline row was clicked while the dialog is armed: a feature row
   * toggles it in the targets list; axis and plane rows land in their input
   * slots when the current type takes them. Every row is consumed so the
   * default rollback can't close the dialog mid-flow.
   */
  handleTimelinePick(obj: SceneObjectRender): boolean {
    if (!this.armed) {
      return false;
    }
    if (obj.type === 'axis' && obj.sourceLocation) {
      if (!this.panel.usesAxis) {
        this.panel.setMessage('An axis fits the Linear, Circular and Rotate types — a mirror takes a plane.');
        return true;
      }
      const loc = obj.sourceLocation;
      const option = this.axes.find(o => o.filePath === loc.filePath && o.line === loc.line);
      if (!option) {
        this.panel.setMessage('That axis was already consumed — only axes still shown in the scene can be picked.');
        return true;
      }
      this.axisEdgeEntities.set(this.panel.armedAxis, null);
      this.panel.selectAxis(option);
      this.panel.setMessage(null);
      this.refreshHighlight();
      this.schedulePreview();
      return true;
    }
    if (obj.type === 'plane' && obj.sourceLocation) {
      if (this.panel.usesAxis) {
        this.panel.setMessage('A plane fits the Mirror type — this type takes an axis.');
        return true;
      }
      const loc = obj.sourceLocation;
      const option = this.planes.find(o => o.filePath === loc.filePath && o.line === loc.line);
      if (!option) {
        this.panel.setMessage('That plane cannot be referenced — only plane() features can mirror.');
        return true;
      }
      this.planeFaceEntity = null;
      this.panel.selectPlane(option);
      this.panel.setMessage(null);
      this.refreshHighlight();
      this.schedulePreview();
      return true;
    }
    const target = resolveRepeatTargetRow(obj, this.sceneObjects);
    if (!target) {
      this.panel.setMessage('That row cannot be repeated — pick a feature like an extrude, cut or fillet.');
      return true;
    }
    const loc = target.sourceLocation!;
    const option = this.targetOptions.find(o => o.filePath === loc.filePath && o.line === loc.line);
    if (!option) {
      this.panel.setMessage('That feature is not available to repeat.');
      return true;
    }
    const existing = this.targets.findIndex(t => t.filePath === option.filePath && t.line === option.line);
    if (existing >= 0) {
      this.targets.splice(existing, 1);
    } else {
      this.targets.push(option);
    }
    // The pick landed in the Features slot — it takes the armed border.
    this.panel.armSlot('targets');
    this.panel.setMessage(null);
    this.refresh();
    this.schedulePreview();
    return true;
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
      const result = await applyRepeat(request);
      if (result.success) {
        // The editor round-trip re-renders the scene; that render is the
        // preview and editor undo is the rollback.
        this.exit({ resume: 'lazy' });
      } else {
        this.panel.setMessage(result.reason ?? 'Could not apply the repeat.');
      }
    } finally {
      this.applying = false;
      this.panel.setApplyEnabled(true);
    }
  }

  /** One direction's axis request field, or the message blocking it. */
  private axisRef(direction: RepeatDirection, named: boolean): RevolveAxisRef | { error: string } {
    const which = named ? ` for direction ${direction}` : '';
    const selection = this.panel.axisSelection(direction);
    if (!selection) {
      return { error: `Choose the axis to repeat along${which}.` };
    }
    if (selection.kind === 'standard') {
      return { kind: 'standard', axis: selection.axis };
    }
    if (selection.kind === 'axis') {
      const { filePath, line, column } = selection.option;
      return { kind: 'axis', filePath, line, column };
    }
    const entity = this.axisEdgeEntities.get(direction);
    if (!entity) {
      return { error: `Pick the axis edge${which} first.` };
    }
    return { kind: 'edge', entity };
  }

  /** The plane slot's request field, or the message blocking it. */
  private planeRef(): RepeatPlaneRef | { error: string } {
    const selection = this.panel.planeSelection();
    if (!selection) {
      return { error: 'Choose the plane to mirror across.' };
    }
    if (selection.kind === 'standard') {
      return { kind: 'standard', plane: selection.plane };
    }
    if (selection.kind === 'plane') {
      const { filePath, line, column } = selection.option;
      return { kind: 'plane', filePath, line, column };
    }
    if (!this.planeFaceEntity) {
      return { error: 'Pick the mirror face first.' };
    }
    return { kind: 'face', entity: this.planeFaceEntity };
  }

  /** The request for the current form state, or the message blocking it. */
  private buildRequest(): RepeatApplyOptions | { error: string } {
    const values = this.panel.values();
    if ('error' in values) {
      return values;
    }
    if (this.targets.length === 0) {
      return { error: 'Pick the features to repeat in the timeline first.' };
    }
    const targets = this.targets.map(({ filePath, line, column }) => ({ filePath, line, column }));
    if (values.kind === 'mirror') {
      const plane = this.planeRef();
      if ('error' in plane) {
        return plane;
      }
      return { kind: 'mirror', targets, plane };
    }
    if (values.kind === 'linear') {
      const active = this.panel.directions;
      const directions: RepeatDirectionRef[] = [];
      for (let i = 0; i < active.length; i++) {
        const axis = this.axisRef(active[i], active.length > 1);
        if ('error' in axis) {
          return axis;
        }
        directions.push({ axis, ...values.directions[i] });
      }
      return {
        kind: 'linear', targets, directions, spacingMode: values.spacingMode,
        centered: values.centered || undefined,
      };
    }
    const axis = this.axisRef(1, false);
    if ('error' in axis) {
      return axis;
    }
    if (values.kind === 'circular') {
      return { kind: 'circular', targets, axis, count: values.count, sweep: values.sweep };
    }
    return { kind: 'rotate', targets, axis, angle: values.angle };
  }

  // -------------------------------------------------------------------------
  // Viewport reflection + sketch-editing suspension
  // -------------------------------------------------------------------------

  /**
   * The viewer's pick channels follow the panel's armed slot, so the slot
   * border says exactly where the next 3D click lands: an armed axis slot
   * takes solid edges and axis lines; the armed plane slot takes faces,
   * plane quads and the origin planes shown as pick targets; the armed
   * Features slot turns scene picking off — features come from the timeline.
   */
  private syncViewport(): void {
    if (!this.armed) {
      return;
    }
    const axisArmed = this.isAxisPicking;
    const planeArmed = this.isPlanePicking;
    this.viewer.pickSketchWires = false;
    this.viewer.pickAxes = axisArmed;
    this.viewer.pickPlanes = planeArmed;
    this.viewer.pickFilter = axisArmed ? 'edge' : planeArmed ? 'face' : 'none';
    if (planeArmed) {
      this.viewer.showStandardPlanes(this.onStandardPlanePick);
    } else {
      this.viewer.hideStandardPlanes();
    }
  }

  /** Repaint the target chips and the picked-entity highlights. */
  private refresh(): void {
    if (!this.armed) {
      return;
    }
    this.panel.setTargets(this.targets.map(target => sourceChip(target, { removable: true })));
    this.refreshHighlight();
  }

  /**
   * Repaint the viewport selection: the picked axis edge or mirror face, the
   * chosen axis statement's dashed line (tinted whole, like sketch wires),
   * or the chosen plane feature's quad.
   */
  private refreshHighlight(): void {
    if (!this.armed) {
      return;
    }
    const wireIds: string[] = [];
    const entities: SelectedEntity[] = [];
    if (this.panel.usesAxis) {
      for (const direction of this.panel.directions) {
        const selection = this.panel.axisSelection(direction);
        if (selection?.kind === 'axis') {
          wireIds.push(...axisLineShapeIds(selection.option, this.sceneObjects));
        } else if (selection?.kind === 'edge') {
          const entity = this.axisEdgeEntities.get(direction);
          if (entity) {
            entities.push(entity);
          }
        }
      }
    } else {
      const selection = this.panel.planeSelection();
      if (selection?.kind === 'plane') {
        const plane = this.sceneObjects.find(o => o.type === 'plane'
          && o.sourceLocation?.filePath === selection.option.filePath
          && o.sourceLocation?.line === selection.option.line);
        const shapeId = plane?.sceneShapes?.find(s => s.shapeId)?.shapeId;
        if (shapeId) {
          this.viewer.highlightPlaneQuad(shapeId);
          return;
        }
      } else if (selection?.kind === 'face' && this.planeFaceEntity) {
        entities.push(this.planeFaceEntity);
      }
    }
    if (wireIds.length > 0 || entities.length > 0) {
      this.viewer.highlightEntities(entities, wireIds);
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
   * Async label pass: axes and planes bound to variables show their names
   * ("ringAxis — line 5"). Applied only if the dialog is still armed on the
   * same option sets when the lookups land.
   */
  private async refreshLabels(): Promise<void> {
    const signature = `${axisOptionsSignature(this.axes)}#${planeOptionsSignature(this.planes)}`;
    this.labelSignature = signature;
    const [axes, planes] = await Promise.all([
      labelWithAxisNames(this.axes),
      labelWithPlaneNames(this.planes),
    ]);
    if (!this.armed || this.labelSignature !== signature) {
      return;
    }
    this.axes = axes;
    this.planes = planes;
    this.panel.setOptions(axes, planes);
  }

  private syncButton(): void {
    this.button.className = this.armed ? BTN_ACTIVE : BTN_BASE;
    // The solo group's visibility already hides the button (and the
    // navbar-managed separator before it) when nothing is repeatable.
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
      result = await applyRepeat({ ...request, preview: true, signal: abort.signal });
    } catch {
      return; // aborted
    }
    if (seq !== this.previewSeq || !this.armed) {
      return;
    }
    this.panel.setPreview(result.success ? result.preview ?? null : null);
    if (!result.success && result.reason) {
      // Pre-Apply refusals (an unsynthesizable pick, an unsupported target
      // statement) surface immediately.
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
