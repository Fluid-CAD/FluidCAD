import { Box3, Vector3 } from 'three';
import { applySection, setSectionOptions, type MeasurePose, type RepeatPlaneRef } from '../../api';
import { toggleEntity } from '../../helpers/entities';
import { SectionController } from '../../scene/section-controller';
import { sceneGeometryBounds } from '../../scene/scene-geometry-bounds';
import type { StandardPlaneId } from '../../scene/standard-planes';
import type { SceneObjectRender, SubSelection } from '../../types';
import type { SelectedEntity, Viewer } from '../../viewer';
import {
  PLANE_UNAVAILABLE_MESSAGE, collectPlaneOptions, PlaneOption, planeOptionForShape, planeQuadShapeIds,
} from '../create-feature/plane-bases';
import { collectSketchProfiles } from '../create-feature/sketch-profiles';
import { SketchUISuspender } from '../create-feature/sketch-suspender';
import { SolidPickSelection } from '../solid-pick';
import { viewportChrome } from '../../ui/viewport-chrome';
import { InterferenceOverlay } from './interference-overlay';
import { SectionArrow } from './section-arrow';
import { closeSectionMenu, showSectionMenu } from './section-menu';
import { SectionPanel } from './section-panel';
import { collectSectionRows, sectionSpecOf, type SectionRow } from './section-rows';

export type SectionViewHooks = {
  /** The dialog is opening — close every other feature dialog. */
  onEnter?: () => void;
  /** The dialog armed or disarmed — lets the Sketch button owner re-check. */
  onActiveChange?: () => void;
  onSuspendSketchUI?: () => void;
  onResumeSketchUI?: () => void;
  /** The file the scene renders (the statement's home), or null with nothing open. */
  filePath: () => string | null;
  /** Whether this host can write source at all (the browser viewer cannot). */
  canEdit: () => boolean;
  /** Assembly files: the instance ids on screen, and each one's live pose. */
  instanceIds?: () => string[];
  poseOf?: (instanceId: string) => MeasurePose | null;
};

/** Hatch lines per scene diagonal — a drawing's density at any model size. */
const HATCH_LINES_PER_DIAGONAL = 90;

/**
 * The live section view: the viewport's section button opens a menu of the
 * scene's saved `section()` statements; picking one clips the scene at its
 * plane through the shared {@link SectionController} (coplanar-exempt
 * clipping, per-body stencil caps in distinct colours, hatched), draws the
 * bodies' shared volumes red ({@link InterferenceOverlay}), and shows an
 * arrow on the plane ({@link SectionArrow}) that slides it forward and back
 * — live while dragging, written into the statement's `offset` on release.
 *
 * "New section view…" opens a small dialog: a name, the plane slot (an
 * origin plane, a `plane()` feature, or a picked planar face — the mirror
 * dialog's picker) and Flip. Apply writes `section('<name>', <plane>)` at
 * the end of the file and activates the view once the render lands.
 *
 * The view re-applies itself after every change to the geometry tree (a
 * render, a mesh rebuild, a hidden shape, a moved instance) and stands down
 * in sketch mode, which owns the clip there.
 */
export class SectionViewService {
  private readonly controller = new SectionController();
  private readonly overlay: InterferenceOverlay;
  private readonly arrow: SectionArrow;
  private readonly panel: SectionPanel;
  private readonly solidPick: SolidPickSelection;
  private readonly sketchUI: SketchUISuspender;

  private rows: SectionRow[] = [];
  private sceneObjects: SceneObjectRender[] = [];
  private planes: PlaneOption[] = [];
  private sceneSketchActive = false;
  /** The active view's key, or null for the uncut scene. */
  private activeKey: string | null = null;
  /** The offset the arrow is dragging (or committed and not yet rendered); null follows the statement. */
  private liveOffset: number | null = null;
  /** The offset at gesture start — the revert target. */
  private dragStart: number | null = null;
  /** A view written by the dialog: activate it when its row arrives. */
  private pendingActivateName: string | null = null;
  private refreshQueued = false;
  private overlayTimer: ReturnType<typeof setTimeout> | null = null;

  private armed = false;
  private planeFaceEntity: SelectedEntity | null = null;
  private applying = false;

  constructor(
    private readonly container: HTMLElement,
    private readonly viewer: Viewer,
    private readonly hooks: SectionViewHooks,
  ) {
    this.sketchUI = new SketchUISuspender(viewer, hooks);
    this.solidPick = new SolidPickSelection(viewer);
    this.overlay = new InterferenceOverlay({
      instanceIds: () => hooks.instanceIds?.() ?? [],
      poseOf: (id) => hooks.poseOf?.(id) ?? null,
    });
    this.arrow = new SectionArrow(viewer, container, {
      onDrag: (delta) => this.handleArrowDrag(delta),
      onCommit: (delta) => this.handleArrowCommit(delta),
      onCancel: () => this.handleArrowCancel(),
      currentOffset: () => this.currentOffset(),
      onCommitAbsolute: (offset) => this.commitOffset(offset),
    });
    this.panel = new SectionPanel(container);
    this.panel.onApply = () => {
      void this.apply();
    };
    this.panel.onExit = () => this.exit();
    this.panel.onChange = () => this.panel.setMessage(null);
    this.panel.onPlaneModeChange = () => {
      this.planeFaceEntity = null;
      this.refreshHighlight();
    };
    viewer.setSectionButtonHandler((anchor) => this.openMenu(anchor));
    // Synchronously, not on the next frame: a render swaps fresh, unclipped
    // meshes into the root, and the render loop (still running after an
    // arrow drag) would draw them whole once before a deferred re-apply.
    viewer.subscribeSceneMesh(() => this.refresh());
    // Another feature dialog opening takes the corner: this one steps aside.
    viewportChrome.subscribeDialogs((openIds) => {
      if (this.armed && [...openIds].some(id => id !== SectionPanel.ID)) {
        this.exit({ resume: 'lazy' });
      }
    });
  }

  // -------------------------------------------------------------------------
  // Scene data
  // -------------------------------------------------------------------------

  /** Every render: the rows to list, the planes the dialog offers, and the re-apply. */
  handleSceneRendered(result: SceneObjectRender[], sceneKind: 'part' | 'assembly'): void {
    this.sceneObjects = result;
    this.sceneSketchActive = sceneKind === 'part' && collectSketchProfiles(result)[0]?.kind === 'active';
    this.rows = collectSectionRows(result);
    this.planes = collectPlaneOptions(result);
    if (this.armed) {
      this.panel.setOptions(this.planes);
      this.refreshHighlight();
    }
    if (this.pendingActivateName !== null) {
      const written = [...this.rows].reverse().find(r => r.name === this.pendingActivateName);
      if (written) {
        this.pendingActivateName = null;
        this.activeKey = written.key;
        this.liveOffset = null;
      }
    }
    if (this.activeKey !== null && !this.rows.some(r => r.key === this.activeKey)) {
      // The statement is gone (deleted, or the file changed): show the scene uncut.
      this.activeKey = null;
    }
    // The statement carries the committed offset now; the live override is stale.
    if (!this.arrow.isDragging) {
      this.liveOffset = null;
    }
    // The mesh listener re-applies the clip; the overlay is re-asked here,
    // once per render, since the bodies may have changed.
    this.scheduleOverlayRefresh(0);
  }

  /** An assembly instance moved (a drag, a mate drive): the cut follows now, the overlay soon after. */
  handleInstancesMoved(): void {
    if (this.activeKey === null) {
      return;
    }
    this.scheduleRefresh();
    this.scheduleOverlayRefresh(400);
  }

  // -------------------------------------------------------------------------
  // The menu and activation
  // -------------------------------------------------------------------------

  get isActive(): boolean {
    return this.activeKey !== null;
  }

  openMenu(anchor: HTMLElement): void {
    showSectionMenu(this.container, anchor, {
      entries: this.rows.map(r => ({ key: r.key, label: r.name, disabledReason: r.error })),
      activeKey: this.activeKey,
      onSelect: (key) => this.activate(key),
      onNew: () => this.enter(),
      canCreate: this.hooks.canEdit() && this.hooks.filePath() !== null,
    });
  }

  /** Show the view with `key`, or the uncut scene with null. */
  activate(key: string | null): void {
    if (key !== null && !this.rows.some(r => r.key === key && r.error === null)) {
      return;
    }
    if (this.activeKey === key) {
      return;
    }
    this.activeKey = key;
    this.liveOffset = null;
    this.dragStart = null;
    if (key === null) {
      this.overlay.clear();
      this.refresh();
      return;
    }
    this.refresh();
    this.scheduleOverlayRefresh(0);
  }

  // -------------------------------------------------------------------------
  // Applying the cut
  // -------------------------------------------------------------------------

  private scheduleRefresh(): void {
    if (this.refreshQueued) {
      return;
    }
    this.refreshQueued = true;
    requestAnimationFrame(() => {
      this.refreshQueued = false;
      this.refresh();
    });
  }

  private activeRow(): SectionRow | null {
    return this.activeKey === null ? null : this.rows.find(r => r.key === this.activeKey) ?? null;
  }

  private currentOffset(): number {
    const row = this.activeRow();
    return this.liveOffset ?? row?.offset ?? 0;
  }

  /** Apply (or clear) the cut for the current state — idempotent, cheap to call often. */
  private refresh(): void {
    const row = this.activeRow();
    const root = this.viewer.geometryRoot;
    const ctx = this.viewer.sceneContext;
    if (!row || !root || this.viewer.isSketchMode) {
      this.controller.clear();
      this.viewer.overlayClipPlanes = null;
      this.arrow.hide();
      this.viewer.setSectionButtonActive(this.activeKey !== null && !this.viewer.isSketchMode);
      ctx.requestRender();
      return;
    }
    const bounds = sceneGeometryBounds(ctx.scene, this.viewer.getAssemblyController()?.getContainer() ?? null);
    const diagonal = bounds && !bounds.isEmpty() ? bounds.getSize(new Vector3()).length() : 100;
    const spec = sectionSpecOf(row, this.currentOffset());
    this.controller.apply(root, spec, {
      distinctColors: true,
      hatch: true,
      hatchSpacing: diagonal / HATCH_LINES_PER_DIAGONAL,
    });
    const plane = this.controller.clipPlane;
    this.viewer.overlayClipPlanes = plane ? [plane] : null;
    this.placeArrow(row, bounds);
    this.viewer.setSectionButtonActive(true);
    ctx.requestRender();
  }

  /** The arrow sits where the cut plane crosses the middle of the model, pointing along +offset. */
  private placeArrow(row: SectionRow, bounds: Box3 | null): void {
    const normal = new Vector3(...row.normal).normalize();
    const point = new Vector3(...row.origin).addScaledVector(normal, this.currentOffset());
    const center = bounds && !bounds.isEmpty() ? bounds.getCenter(new Vector3()) : point.clone();
    const onPlane = center.clone().addScaledVector(normal, -center.clone().sub(point).dot(normal));
    this.arrow.show(onPlane, normal);
  }

  private scheduleOverlayRefresh(delayMs: number): void {
    if (this.overlayTimer !== null) {
      clearTimeout(this.overlayTimer);
    }
    if (this.activeKey === null) {
      this.overlay.clear();
      return;
    }
    this.overlayTimer = setTimeout(() => {
      this.overlayTimer = null;
      void this.refreshOverlay();
    }, delayMs);
  }

  private async refreshOverlay(): Promise<void> {
    if (this.activeKey === null) {
      return;
    }
    const changed = await this.overlay.refresh(this.viewer.geometryRoot);
    if (changed && this.activeKey !== null) {
      // The red bodies are new children of the root: the caps must see them.
      this.refresh();
    }
  }

  // -------------------------------------------------------------------------
  // The arrow
  // -------------------------------------------------------------------------

  private handleArrowDrag(delta: number): void {
    if (this.dragStart === null) {
      this.dragStart = this.currentOffset();
    }
    this.liveOffset = this.dragStart + delta;
    this.scheduleRefresh();
  }

  private handleArrowCommit(delta: number): void {
    const start = this.dragStart ?? this.currentOffset();
    this.dragStart = null;
    void this.commitOffset(start + delta);
  }

  private handleArrowCancel(): void {
    if (this.dragStart !== null) {
      this.liveOffset = this.dragStart;
    }
    this.dragStart = null;
    this.liveOffset = null;
    this.refresh();
  }

  /** Write `offset` into the active statement; the render that follows carries it. */
  private async commitOffset(offset: number): Promise<void> {
    const row = this.activeRow();
    if (!row) {
      return;
    }
    const rounded = Math.round(offset * 1e4) / 1e4;
    this.liveOffset = rounded;
    this.refresh();
    if (!row.sourceLocation || !this.hooks.canEdit()) {
      // A read-only host keeps the live offset for the session.
      return;
    }
    const result = await setSectionOptions(row.sourceLocation, rounded, row.flip);
    if (!result.success) {
      console.warn(`Section offset not written: ${result.reason ?? 'unknown reason'}`);
      this.liveOffset = null;
      this.refresh();
    }
  }

  // -------------------------------------------------------------------------
  // The dialog
  // -------------------------------------------------------------------------

  get isPicking(): boolean {
    return this.armed;
  }

  /** The dialog's one slot takes faces, plane quads and the origin planes. */
  get isPlanePicking(): boolean {
    return this.armed;
  }

  get sketchUISuspended(): boolean {
    return this.sketchUI.suspended;
  }

  enter(): void {
    if (this.armed) {
      return;
    }
    closeSectionMenu();
    this.hooks.onEnter?.();
    this.armed = true;
    this.planeFaceEntity = null;
    if (this.sceneSketchActive) {
      this.sketchUI.suspend();
    }
    this.hooks.onActiveChange?.();
    this.panel.show(this.suggestName());
    this.panel.setOptions(this.planes);
    this.syncViewport();
    this.refreshHighlight();
  }

  exit(opts: { resume?: 'immediate' | 'lazy' } = {}): void {
    if (!this.armed) {
      return;
    }
    this.armed = false;
    this.planeFaceEntity = null;
    this.solidPick.set([]);
    this.viewer.clearHighlight();
    this.viewer.pickFilter = 'all';
    this.viewer.hideStandardPlanes();
    this.hooks.onActiveChange?.();
    this.panel.hide();
    this.sketchUI.resume((opts.resume ?? 'immediate') === 'immediate');
  }

  /** "A-A", "B-B", … — the first letter pair no view uses yet. */
  private suggestName(): string {
    const taken = new Set(this.rows.map(r => r.name));
    for (let i = 0; i < 26; i++) {
      const letter = String.fromCharCode(65 + i);
      const name = `${letter}-${letter}`;
      if (!taken.has(name)) {
        return name;
      }
    }
    return `Section ${this.rows.length + 1}`;
  }

  handleClick(shapeId: string | null, sub: SubSelection): void {
    if (!this.armed || !shapeId || !sub || sub.type !== 'face') {
      return;
    }
    this.planeFaceEntity = toggleEntity(this.planeFaceEntity, { shapeId, sub });
    this.panel.setPlaneFaceChip(this.planeFaceEntity ? 'Picked face' : null);
    this.panel.setMessage(null);
    this.refreshHighlight();
  }

  /** A plane feature's quad was clicked while the dialog is armed. */
  handlePlanePick(shapeId: string): void {
    if (!this.armed) {
      return;
    }
    const option = planeOptionForShape(shapeId, this.sceneObjects, this.planes);
    if (!option) {
      this.panel.setMessage(PLANE_UNAVAILABLE_MESSAGE);
      return;
    }
    this.planeFaceEntity = null;
    this.panel.selectPlane(option);
    this.panel.setMessage(null);
    this.refreshHighlight();
  }

  private readonly onStandardPlanePick = (plane: StandardPlaneId): void => {
    if (!this.armed) {
      return;
    }
    this.planeFaceEntity = null;
    this.panel.selectStandardPlane(plane);
    this.panel.setMessage(null);
    this.refreshHighlight();
  };

  private syncViewport(): void {
    if (!this.armed) {
      return;
    }
    this.viewer.pickSketchWires = false;
    this.viewer.pickAxes = false;
    this.viewer.pickPlanes = true;
    this.viewer.pickFilter = 'face';
    this.viewer.showStandardPlanes(this.onStandardPlanePick);
  }

  private refreshHighlight(): void {
    if (!this.armed) {
      return;
    }
    const entities: SelectedEntity[] = [];
    const planeQuadIds: string[] = [];
    const selection = this.panel.planeSelection();
    if (selection?.kind === 'plane') {
      planeQuadIds.push(...planeQuadShapeIds(selection.option, this.sceneObjects));
    } else if (selection?.kind === 'face' && this.planeFaceEntity) {
      entities.push(this.planeFaceEntity);
    }
    this.solidPick.set([]);
    this.solidPick.refreshHighlight({ entities, planeQuadIds });
  }

  /** The plane slot's request field, or the message blocking it. */
  private planeRef(): RepeatPlaneRef | { error: string } {
    const selection = this.panel.planeSelection();
    if (!selection || selection.kind === 'keep') {
      return { error: 'Pick the plane or face to cut at.' };
    }
    if (selection.kind === 'standard') {
      return { kind: 'standard', plane: selection.plane };
    }
    if (selection.kind === 'plane') {
      const { filePath, line, column } = selection.option;
      return { kind: 'plane', filePath, line, column };
    }
    if (!this.planeFaceEntity) {
      return { error: 'Pick the face to cut at.' };
    }
    return { kind: 'face', entity: this.planeFaceEntity };
  }

  private async apply(): Promise<void> {
    if (!this.armed || this.applying) {
      return;
    }
    const filePath = this.hooks.filePath();
    if (!filePath) {
      this.panel.setMessage('Open a model file first.');
      return;
    }
    const { name, flip } = this.panel.values();
    if (name === '') {
      this.panel.setMessage('Give the section view a name.');
      return;
    }
    const plane = this.planeRef();
    if ('error' in plane) {
      this.panel.setMessage(plane.error);
      return;
    }
    this.applying = true;
    this.panel.setApplyEnabled(false);
    try {
      const response = await applySection({ name, plane, offset: 0, flip, filePath });
      if (!response.success) {
        this.panel.setMessage(response.reason ?? 'The section view could not be written.');
        return;
      }
      this.pendingActivateName = name;
      this.exit({ resume: 'lazy' });
    } finally {
      this.applying = false;
      this.panel.setApplyEnabled(true);
    }
  }
}
