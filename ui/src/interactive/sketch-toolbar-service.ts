import { SketchToolbar } from '../ui/sketch-toolbar';
import { SketchTool, ToolId } from './sketch-tool';
import { LineTool } from './tools/line-tool';
import { CircleTool } from './tools/circle-tool';
import { CenterArcTool } from './tools/center-arc-tool';
import { ThreePointArcTool } from './tools/three-point-arc-tool';
import { RectTool } from './tools/rect-tool';
import { RoundedRectTool } from './tools/rounded-rect-tool';
import { SlotTool } from './tools/slot-tool';
import { PolylineTool } from './tools/polyline';
import { BezierTool } from './tools/bezier-tool';
import { PolygonTool } from './tools/polygon-tool';
import { TextTool } from './tools/text-tool';
import { DragMoveHandler } from './drag-move-handler';
import { SketchHoverSelectHandler } from './sketch-hover-select-handler';
import { BezierHandlesOverlay } from './bezier-handles-overlay';
import { SnapManager } from '../snapping/snap-manager';
import { SnapController } from '../snapping/snap-controller';
import {
  insertGeometry, getScopeVariables, applySketchOp, gotoSource, FeatureEditTarget, ParsedFeatureStatement,
} from '../api';
import { isTopLevel } from '../helpers/scene-utils';
import { SceneObjectRender, PlaneData } from '../types';
import { Viewer } from '../viewer';
import { TrimPickService } from './trim-pick-service';
import { TrimDialog } from './trim-dialog';
import { ProjectionPickService } from './projection-pick-service';
import { SketchOpService, SketchOpSelection, SketchPickDescription } from './sketch-op-service';
import { ConstraintToolbarService } from './constraint-toolbar';
import { VariableInfo } from '../ui/expression-input';
import { ShortcutManager } from '../ui/shortcut-manager';
import { Navbar } from '../ui/navbar';

export class SketchToolbarService {
  /**
   * The 2D op dialogs (fillet, offset) occupy the sketch dialog's docked
   * spot — main.ts wires this to suspend the sketch dialog while one is open
   * and restore it when it closes.
   */
  onOpDialogToggle?: (open: boolean) => void;

  /**
   * Fires when a sketch becomes active or inactive (the sketch toolbar shows
   * or hides). main.ts uses it to collapse the create-feature buttons into the
   * Finish Sketch popup while a sketch is being edited.
   */
  onActiveChange?: (active: boolean) => void;

  private viewer: Viewer;
  private container: HTMLElement;
  private trimService: TrimPickService;
  private trimDialog: TrimDialog;
  /**
   * The Project tool's dialog. It lives outside this service (main.ts routes
   * its 3D picks) because arming it suspends sketch editing — the picks are
   * solid edges and faces, not sketch geometry.
   */
  private projectionService: ProjectionPickService;
  private opServices: Partial<Record<ToolId, SketchOpService>> = {};
  private toolbar: SketchToolbar;
  /** The floating segment-conversion mini bar below the main toolbar. */
  private constraintToolbar: ConstraintToolbarService;
  private activeSketchInfo: {
    sketchObj: SceneObjectRender;
    plane: PlaneData;
    sourceLocation: { filePath: string; line: number; column: number };
  } | null = null;
  private activeDrawingTool: SketchTool | null = null;
  private activeDragHandler: DragMoveHandler | null = null;
  private activeHoverSelectHandler: SketchHoverSelectHandler | null = null;
  private bezierHandles: BezierHandlesOverlay;
  private shortcuts: ShortcutManager;
  private opMessageToast: HTMLDivElement | null = null;
  private opMessageTimer: number | null = null;
  // Snap options, owned here; the sketch dialog's toggles write them via the
  // setters below (session-only state, deliberately not persisted).
  private snapToVertices = true;
  private snapToGrid = true;
  /** Last-reported sketch-active state, so {@link onActiveChange} fires on edges only. */
  private lastActive = false;
  /**
   * Keep the sketch toolbar shown while a create-feature dialog launched from
   * this sketch is open. The dialog suspends sketch editing so the free 3D
   * view can be picked, which would normally hide the bar — pinning leaves the
   * sketch tools in place until the feature is applied (see {@link update}).
   */
  private keepToolbar = false;

  constructor(
    container: HTMLElement,
    viewer: Viewer,
    trimService: TrimPickService,
    projectionService: ProjectionPickService,
    navbar: Navbar,
  ) {
    this.viewer = viewer;
    this.container = container;
    this.trimService = trimService;
    this.projectionService = projectionService;
    // An applied projection resumes lazily (its re-render is on the way); the
    // disarm below then finds the dialog already closed. A cancel arrives
    // without options and closes through the toolbar's own immediate exit.
    this.projectionService.onDone = (opts) => {
      if (opts) {
        this.projectionService.exit(opts);
      }
      this.handleToolSelect(null);
    };
    this.projectionService.onVisibilityChange = (open) => this.onOpDialogToggle?.(open);

    const sketchGroup = navbar.addGroup('sketch', { visible: false, exclusive: true });
    this.toolbar = new SketchToolbar(
      sketchGroup,
      (toolId) => this.handleToolSelect(toolId),
      (visible) => navbar.setGroupVisible('sketch', visible),
    );

    this.shortcuts = new ShortcutManager();
    this.shortcuts.register('n', () => this.lookAlongSketchNormal());

    this.bezierHandles = new BezierHandlesOverlay(viewer.sceneContext);

    const opSelection: SketchOpSelection = {
      ids: () => [...(this.activeHoverSelectHandler?.selectedIds ?? [])],
      describe: (shapeId) => this.describeOpPick(shapeId),
      clear: () => this.activeHoverSelectHandler?.resetSelection(),
      deselect: (shapeId) => this.activeHoverSelectHandler?.deselectShape(shapeId),
    };
    const opVars = () => this.fetchScopeVariables();
    const opDone = () => this.handleToolSelect(null);
    const opService = (config: ConstructorParameters<typeof SketchOpService>[1]) =>
      new SketchOpService(container, config, opSelection, opVars, opDone);
    this.opServices = {
      fillet: opService({
        feature: 'fillet', title: 'Fillet', pickHint: 'Pick sketch edges to fillet',
        value: { label: 'Radius', defaultValue: '2', sign: 'positive' },
      }),
      offset: opService({
        feature: 'offset', title: 'Offset', pickHint: 'Pick sketch edges to offset',
        value: { label: 'Distance', defaultValue: '2', sign: 'nonzero' },
        toggles: [
          {
            key: 'removeOriginal',
            label: 'Remove original',
            title: 'Keep only the offset — the geometry it was made from is removed',
          },
          {
            key: 'close',
            label: 'Close ends',
            title: 'Cap an open offset back onto its original profile with two straight edges, '
              + 'making a closed loop (no-op on already-closed profiles)',
          },
        ],
      }),
      subtract: opService({
        feature: 'subtract', title: 'Subtract', pickHint: 'Pick the base geometry’s edges',
        slotted: true,
      }),
    };
    for (const service of Object.values(this.opServices)) {
      service.onVisibilityChange = (open) => this.onOpDialogToggle?.(open);
    }

    this.constraintToolbar = new ConstraintToolbarService(container, (message) => this.showOpMessage(message));

    this.trimDialog = new TrimDialog(container, () => this.handleToolSelect(null));
    this.trimDialog.onModeChange = (mode) => this.trimService.setMode(mode);
    this.trimDialog.onVisibilityChange = (open) => this.onOpDialogToggle?.(open);
    this.trimService.onRegionMessage = (message) => this.showOpMessage(message);
  }

  get hasActiveDrawingTool(): boolean {
    return this.activeDrawingTool !== null;
  }

  /** The op service (fillet, offset) of the currently armed toolbar tool. */
  private activeOpService(): SketchOpService | undefined {
    const tool = this.toolbar.activeTool;
    return tool ? this.opServices[tool] : undefined;
  }

  /** The toolbar tool of an op dialog rewriting a statement in place, if any. */
  private editingOpTool(): ToolId | null {
    for (const [tool, service] of Object.entries(this.opServices)) {
      if (service.isEditing) {
        return tool as ToolId;
      }
    }
    return null;
  }

  /**
   * Open the offset dialog over the `offset()` statement at `target`
   * (timeline double-click). The gesture's breakpoint pauses the build just
   * BEFORE that statement — the sketch on its way in is the one the offset's
   * arguments see, without its result — and the render that brings it back
   * re-arms the toolbar and the picking handlers (see {@link update}).
   */
  enterOffsetEdit(
    target: FeatureEditTarget,
    parsed: Extract<ParsedFeatureStatement, { feature: 'offset' }>,
    expectedStatement: string,
  ): void {
    const service = this.opServices.offset;
    if (!service) {
      return;
    }
    // Disarming leaves an armed tool cleanly — except when the dialog is
    // already editing: that path would cancel it, clearing the breakpoint the
    // new double-click just placed. Its own re-entry closes it instead.
    if (!service.isEditing) {
      this.handleToolSelect(null);
    }
    this.toolbar.setActiveTool('offset');
    service.enterEdit(target, parsed, expectedStatement);
    if (this.activeSketchInfo) {
      service.noteSketchActive();
      this.activateDragHandler();
    }
  }

  /** The sketch dialog's snap-to-vertices toggle; live tools follow along. */
  setSnapToVertices(checked: boolean): void {
    this.snapToVertices = checked;
    if (this.activeDrawingTool) {
      this.activeDrawingTool['snapController'].snapToVertices = checked;
    }
    if (this.activeDragHandler) {
      this.activeDragHandler['snapController'].snapToVertices = checked;
    }
  }

  /** The sketch dialog's snap-to-grid toggle; live tools follow along. */
  setSnapToGrid(checked: boolean): void {
    this.snapToGrid = checked;
    if (this.activeDrawingTool) {
      this.activeDrawingTool['snapController'].snapToGrid = checked;
    }
    if (this.activeDragHandler) {
      this.activeDragHandler['snapController'].snapToGrid = checked;
    }
  }

  /**
   * Pin (or release) the sketch toolbar while a create-feature dialog launched
   * from this sketch is open. main.ts derives this from the dialogs' own
   * suspend state and pushes it in before feeding the suspended (empty) scene.
   */
  setKeepToolbar(keep: boolean): void {
    this.keepToolbar = keep;
  }

  update(sceneObjects: SceneObjectRender[]): void {
    let lastRoot: SceneObjectRender | null = null;
    for (let i = sceneObjects.length - 1; i >= 0; i--) {
      if (isTopLevel(sceneObjects[i], sceneObjects)) {
        lastRoot = sceneObjects[i];
        break;
      }
    }

    if (lastRoot?.type === 'sketch' && lastRoot.id && lastRoot.object?.plane && lastRoot.sourceLocation) {
      const plane: PlaneData = lastRoot.object.plane;
      const prevSketchId = this.activeSketchInfo?.sketchObj.id;
      this.activeSketchInfo = {
        sketchObj: lastRoot,
        plane,
        sourceLocation: lastRoot.sourceLocation,
      };

      if (!this.toolbar.isVisible) {
        this.toolbar.show();
        this.shortcuts.enable();
      }
      this.constraintToolbar.show();

      this.bezierHandles.activate();
      this.bezierHandles.update(sceneObjects, lastRoot.id, plane);

      // The sketch an edit dialog was opened over has arrived: re-arm its
      // toolbar button (the bar's own hide() dropped it while the breakpoint
      // render was in flight) so the picking handlers below come back with it.
      const editingTool = this.editingOpTool();
      if (editingTool) {
        this.opServices[editingTool]!.noteSketchActive();
        this.toolbar.setActiveTool(editingTool);
      }

      if (this.activeDrawingTool) {
        if (prevSketchId !== lastRoot.id) {
          this.handleToolSelect(this.toolbar.activeTool);
        } else {
          this.activeDrawingTool.updatePlane(plane);
          this.activeDrawingTool.onSceneUpdate(sceneObjects, lastRoot.id);
          if (lastRoot.object?.currentPosition) {
            this.activeDrawingTool.updateCurrentPosition(lastRoot.object.currentPosition);
          }
        }
      } else if (this.activeDragHandler) {
        this.activeDragHandler.updatePlane(plane);
        const snapManager = SnapManager.fromSceneObjects(sceneObjects, lastRoot.id, plane, this.viewer.sceneContext);
        const snapCtrl = new SnapController(snapManager, plane);
        snapCtrl.snapToVertices = this.snapToVertices;
        snapCtrl.snapToGrid = this.snapToGrid;
        this.activeDragHandler.updateSnapController(snapCtrl);
        this.activeDragHandler.updateSceneData(sceneObjects, lastRoot.id);
        if (this.activeHoverSelectHandler) {
          this.activeHoverSelectHandler.updatePlane(plane);
          this.activeHoverSelectHandler.updateSceneData(sceneObjects, lastRoot.id);
        }
        // A re-render may have pruned selected edges — keep the preview honest.
        this.activeOpService()?.refresh();
      } else if (!this.toolbar.activeTool || this.activeOpService()) {
        // The op dialogs pick with the drag/hover handlers — an armed one
        // (or one that just regained its sketch) gets them back.
        this.activateDragHandler();
      }

      // After the handlers have digested the new scene (ids change every
      // render): replay a pending post-convert re-selection and refresh the
      // mini bar's options. No selection exists while a drawing tool is armed.
      this.constraintToolbar.sketchUpdated(
        sceneObjects,
        lastRoot.id,
        this.activeDrawingTool ? null : this.activeHoverSelectHandler,
      );
    } else {
      if (this.activeDrawingTool) {
        this.activeDrawingTool.deactivate();
        this.activeDrawingTool = null;
      }
      for (const service of Object.values(this.opServices)) {
        // An edit dialog opens before its sketch renders — the double-click's
        // breakpoint edit is still in flight — so the sketch-less scene it
        // opened over must not fold it away. Once that sketch has arrived,
        // losing it again closes the dialog like any other.
        if (service.isActive && !service.isAwaitingSketch) {
          service.exit();
          this.toolbar.setActiveTool(null);
        }
      }
      if (this.trimDialog.isActive) {
        // The sketch closed under the tool — no code edits, just fold the
        // dialog; the trim service resets through its own scene update.
        this.trimDialog.hide();
        this.trimService.pendingActivation = false;
        this.toolbar.setActiveTool(null);
      }
      if (this.projectionService.isPicking) {
        // The sketch it was projecting into is gone — or another dialog took
        // the viewport. Either way the caller owns the view now, so sketch
        // editing comes back lazily instead of forcing a render here.
        this.projectionService.exit({ resume: 'lazy' });
        this.toolbar.setActiveTool(null);
      }
      this.deactivateDragHandler();
      this.bezierHandles.deactivate();
      this.constraintToolbar.hide();
      this.activeSketchInfo = null;
      if (this.keepToolbar) {
        // A create-feature dialog launched from this sketch has suspended
        // editing to pick in the free 3D view — keep (or restore, when a
        // switch between dialogs briefly dropped it) the bar on the sketch
        // tools until the feature is applied. keepToolbar is only set while
        // one of those dialogs is armed-and-suspended, which only happens
        // from an active sketch, so re-showing here can't be spurious. Drop
        // any armed tool so none looks active while the dialog owns the view.
        if (!this.toolbar.isVisible) {
          this.toolbar.show();
          this.shortcuts.enable();
        }
        this.toolbar.setActiveTool(null);
      } else {
        this.toolbar.hide();
        this.shortcuts.disable();
      }
    }

    const active = this.activeSketchInfo !== null || this.keepToolbar;
    if (active !== this.lastActive) {
      this.lastActive = active;
      this.onActiveChange?.(active);
    }
  }

  /**
   * Chip content for a picked sketch shape: its owning entity's timeline name
   * and the source line of the statement that drew it (the chip's jump badge).
   */
  private describeOpPick(shapeId: string): SketchPickDescription {
    const owner = this.viewer.currentSceneObjects.find(obj =>
      obj.sceneShapes?.some(shape => shape.shapeId === shapeId));
    const location = owner?.sourceLocation;
    return {
      label: owner?.name || 'Edge',
      line: location?.line,
      goTo: location ? () => gotoSource(location) : undefined,
    };
  }

  private async fetchScopeVariables(): Promise<VariableInfo[]> {
    if (!this.activeSketchInfo) {
      return [];
    }
    return getScopeVariables(this.activeSketchInfo.sourceLocation.line);
  }

  private createTool(toolId: ToolId, plane: PlaneData, sceneObjects: SceneObjectRender[], sketchId: string): SketchTool | null {
    const snapManager = SnapManager.fromSceneObjects(sceneObjects, sketchId, plane, this.viewer.sceneContext);
    const snapCtrl = new SnapController(snapManager, plane);
    snapCtrl.snapToVertices = this.snapToVertices;
    snapCtrl.snapToGrid = this.snapToGrid;

    const doInsertGeometry = (
      statement: string,
      newVariable?: { name: string; initializer: string } | { name: string; initializer: string }[],
    ) => {
      if (!this.activeSketchInfo) {
        return;
      }
      insertGeometry(statement, this.activeSketchInfo.sourceLocation, newVariable);
    };

    const fetchVars = () => this.fetchScopeVariables();

    switch (toolId) {
      case 'line': {
        const tool = new LineTool(this.viewer.sceneContext, plane, snapCtrl, doInsertGeometry, this.container, fetchVars);
        tool.onSceneUpdate(sceneObjects, sketchId);
        return tool;
      }
      case 'circle':
        return new CircleTool(this.viewer.sceneContext, plane, snapCtrl, doInsertGeometry, this.container, fetchVars);
      case 'polygon':
        return new PolygonTool(this.viewer.sceneContext, plane, snapCtrl, doInsertGeometry, this.container, fetchVars);
      case 'arc2':
        return new CenterArcTool(this.viewer.sceneContext, plane, snapCtrl, doInsertGeometry, this.container, fetchVars);
      case 'arc3': {
        const tool = new ThreePointArcTool(this.viewer.sceneContext, plane, snapCtrl, doInsertGeometry, this.container, fetchVars);
        tool.onSceneUpdate(sceneObjects, sketchId);
        return tool;
      }
      case 'polyline': {
        const tool = new PolylineTool(this.viewer.sceneContext, plane, snapCtrl, doInsertGeometry, this.container, fetchVars);
        tool.onSceneUpdate(sceneObjects, sketchId);
        return tool;
      }
      case 'bezier': {
        const tool = new BezierTool(this.viewer.sceneContext, plane, snapCtrl, doInsertGeometry, this.container, fetchVars);
        tool.onSceneUpdate(sceneObjects, sketchId);
        return tool;
      }
      case 'rect':
        return new RectTool(this.viewer.sceneContext, plane, snapCtrl, doInsertGeometry, this.container, fetchVars, this.toolbar.rectCenteredChecked);
      case 'rounded-rect':
        return new RoundedRectTool(this.viewer.sceneContext, plane, snapCtrl, doInsertGeometry, this.container, fetchVars, this.toolbar.rectCenteredChecked);
      case 'slot':
        return new SlotTool(this.viewer.sceneContext, plane, snapCtrl, doInsertGeometry, this.container, fetchVars);
      case 'text':
        return new TextTool(this.viewer.sceneContext, plane, snapCtrl, doInsertGeometry, this.container,
          () => this.handleToolSelect(null));
      default:
        return null;
    }
  }

  private activateDragHandler(): void {
    if (this.activeDragHandler || !this.activeSketchInfo) {
      return;
    }
    const snapManager = SnapManager.fromSceneObjects(this.viewer.currentSceneObjects, this.activeSketchInfo.sketchObj.id!, this.activeSketchInfo.plane, this.viewer.sceneContext);
    const snapCtrl = new SnapController(snapManager, this.activeSketchInfo.plane);
    snapCtrl.snapToVertices = this.snapToVertices;
    snapCtrl.snapToGrid = this.snapToGrid;
    this.activeDragHandler = new DragMoveHandler(
      this.viewer.sceneContext,
      this.activeSketchInfo.plane,
      snapCtrl,
      this.container,
      () => this.fetchScopeVariables(),
      () => this.activeSketchInfo?.sourceLocation.line ?? null,
    );
    this.activeDragHandler.updateSceneData(this.viewer.currentSceneObjects, this.activeSketchInfo.sketchObj.id!);
    this.activeDragHandler.activate();

    this.activeHoverSelectHandler = new SketchHoverSelectHandler(
      this.viewer.sceneContext,
      this.activeSketchInfo.plane,
      () => this.activeDragHandler?.isResizing ?? false,
    );
    this.activeHoverSelectHandler.onSelectionChange = () => {
      this.activeOpService()?.refresh();
      this.constraintToolbar.selectionChanged(this.activeHoverSelectHandler);
    };
    this.activeHoverSelectHandler.updateSceneData(this.viewer.currentSceneObjects, this.activeSketchInfo.sketchObj.id!);
    this.activeHoverSelectHandler.activate();
  }

  private deactivateDragHandler(): void {
    if (this.activeHoverSelectHandler) {
      this.activeHoverSelectHandler.deactivate();
      this.activeHoverSelectHandler = null;
    }
    if (this.activeDragHandler) {
      this.activeDragHandler.deactivate();
      this.activeDragHandler = null;
    }
  }

  private handleToolSelect(toolId: ToolId | null): void {
    // While a create-feature dialog has the toolbar pinned, sketch editing is
    // suspended and there is no active sketch — the tools are shown but inert.
    if (this.keepToolbar && !this.activeSketchInfo) {
      return;
    }
    if (!toolId && this.activeDrawingTool?.handleEscape?.()) {
      return;
    }

    // Fuse and common are one-shot: they have nothing to configure (no value,
    // dense pick list), so the button applies to the current selection
    // directly instead of opening a dialog. The tool is never armed.
    if (toolId === 'fuse' || toolId === 'common') {
      void this.applyInstantOp(toolId);
      return;
    }

    // Trim with edges already selected is the same one-shot: emit
    // `trim(<selectors>)` for the picked edges. Without a selection it stays
    // the classic point-based trim mode.
    if (toolId === 'trim' && (this.activeHoverSelectHandler?.selectedIds.size ?? 0) > 0) {
      void this.applyInstantOp('trim');
      return;
    }

    if (this.activeDrawingTool) {
      this.activeDrawingTool.deactivate();
      this.activeDrawingTool = null;
    }

    if (this.toolbar.activeTool === 'trim' && toolId !== 'trim') {
      this.exitTrimFromToolbar();
    }
    if (this.toolbar.activeTool === 'project' && toolId !== 'project') {
      this.projectionService.exit();
    }
    const previousOp = this.toolbar.activeTool ? this.opServices[this.toolbar.activeTool] : undefined;
    if (previousOp && this.toolbar.activeTool !== toolId) {
      previousOp.exit();
    }

    this.toolbar.setActiveTool(toolId);

    if (!toolId || !this.activeSketchInfo) {
      if (!toolId && this.activeSketchInfo) {
        this.activateDragHandler();
      }
      return;
    }

    // The op dialogs (fillet, offset) keep the drag/hover handlers active —
    // picking IS the input.
    const opService = this.opServices[toolId];
    if (opService) {
      this.activateDragHandler();
      opService.enter();
      return;
    }

    this.deactivateDragHandler();

    if (toolId === 'trim') {
      this.enterTrimFromToolbar();
      return;
    }

    // Project picks solid edges and faces, so it leaves sketch editing (the
    // camera unlocks from the sketch normal) while keeping this sketch as the
    // statement's destination.
    if (toolId === 'project') {
      this.projectionService.enter(this.activeSketchInfo.sourceLocation);
      return;
    }

    const tool = this.createTool(toolId, this.activeSketchInfo.plane, this.viewer.currentSceneObjects, this.activeSketchInfo.sketchObj.id!);
    if (!tool) {
      return;
    }

    if (this.activeSketchInfo.sketchObj.object?.currentPosition) {
      tool.updateCurrentPosition(this.activeSketchInfo.sketchObj.object.currentPosition);
    }

    tool.activate();
    this.activeDrawingTool = tool;
  }

  /**
   * Apply a one-shot op (fuse/common/trim-selection) to the currently
   * selected edges. Refusals — nothing picked, or the kernel's honest
   * synthesis reasons ("pick edges of at least two geometries…") — surface
   * as a transient toast, since there is no dialog to carry them.
   */
  private async applyInstantOp(feature: 'fuse' | 'common' | 'trim'): Promise<void> {
    const pickFirst = {
      fuse: 'Pick edges of the geometries to fuse first',
      common: 'Pick edges of the geometries to intersect first',
      trim: 'Pick the edges to remove first',
    } as const;
    const ids = [...(this.activeHoverSelectHandler?.selectedIds ?? [])];
    if (ids.length === 0) {
      this.showOpMessage(pickFirst[feature]);
      return;
    }
    const result = await applySketchOp(feature, undefined, ids.map(shapeId => ({ shapeId })));
    if (!result.success) {
      this.showOpMessage(result.reason ?? `Could not apply the ${feature}`);
    }
  }

  /** Transient toast under the navbar (mirrors main.ts's edit-refusal toast). */
  private showOpMessage(message: string): void {
    if (!this.opMessageToast) {
      this.opMessageToast = document.createElement('div');
      // Below the constraint mini bar (top-[106px]) so refusals don't cover it.
      this.opMessageToast.className = 'absolute top-[152px] left-1/2 -translate-x-1/2 z-[1003] max-w-[440px] '
        + 'bg-base-100 border border-base-300 text-base-content rounded-lg px-3 py-2 text-xs leading-snug shadow-md';
      this.container.appendChild(this.opMessageToast);
    }
    this.opMessageToast.textContent = message;
    this.opMessageToast.classList.remove('hidden');
    if (this.opMessageTimer !== null) {
      window.clearTimeout(this.opMessageTimer);
    }
    this.opMessageTimer = window.setTimeout(() => {
      this.opMessageTimer = null;
      this.opMessageToast?.classList.add('hidden');
    }, 4000);
  }

  private enterTrimFromToolbar(): void {
    if (!this.activeSketchInfo) {
      return;
    }

    this.trimDialog.show();
    this.trimService.setMode(this.trimDialog.mode);

    if (this.trimService.lastPickInfo) {
      this.trimService.enter();
      return;
    }

    this.trimService.pendingActivation = true;
    insertGeometry('trim()', this.activeSketchInfo.sourceLocation);
  }

  private exitTrimFromToolbar(): void {
    this.trimDialog.hide();
    this.trimService.pendingActivation = false;
    if (this.trimService.state === 'picking-active') {
      this.trimService.exit();
    }
    this.trimService.reset();
  }

  private lookAlongSketchNormal(): void {
    if (this.activeSketchInfo) {
      this.viewer.lookAlongSketchNormal(this.activeSketchInfo.plane);
    }
  }
}
