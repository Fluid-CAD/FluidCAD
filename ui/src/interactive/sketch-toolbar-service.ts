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
import { insertGeometry, getScopeVariables, applySketchOp } from '../api';
import { isTopLevel } from '../helpers/scene-utils';
import { SceneObjectRender, PlaneData } from '../types';
import { Viewer } from '../viewer';
import { TrimPickService } from './trim-pick-service';
import { TrimDialog } from './trim-dialog';
import { SketchOpService } from './sketch-op-service';
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

  private viewer: Viewer;
  private container: HTMLElement;
  private trimService: TrimPickService;
  private trimDialog: TrimDialog;
  private opServices: Partial<Record<ToolId, SketchOpService>> = {};
  private toolbar: SketchToolbar;
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

  constructor(container: HTMLElement, viewer: Viewer, trimService: TrimPickService, navbar: Navbar) {
    this.viewer = viewer;
    this.container = container;
    this.trimService = trimService;

    const sketchGroup = navbar.addGroup('sketch', { visible: false, exclusive: true });
    this.toolbar = new SketchToolbar(
      sketchGroup,
      (toolId) => this.handleToolSelect(toolId),
      (visible) => navbar.setGroupVisible('sketch', visible),
    );

    this.shortcuts = new ShortcutManager();
    this.shortcuts.register('n', () => this.lookAlongSketchNormal());

    this.bezierHandles = new BezierHandlesOverlay(viewer.sceneContext);

    const opSelection = () => [...(this.activeHoverSelectHandler?.selectedIds ?? [])];
    const opClear = () => this.activeHoverSelectHandler?.resetSelection();
    const opVars = () => this.fetchScopeVariables();
    const opDone = () => this.handleToolSelect(null);
    const opService = (config: ConstructorParameters<typeof SketchOpService>[1]) =>
      new SketchOpService(container, config, opSelection, opClear, opVars, opDone);
    this.opServices = {
      fillet: opService({
        feature: 'fillet', title: 'Fillet', pickHint: 'Pick sketch edges to fillet',
        value: { label: 'Radius', defaultValue: '2', sign: 'positive' },
      }),
      offset: opService({
        feature: 'offset', title: 'Offset', pickHint: 'Pick sketch edges to offset',
        value: { label: 'Distance', defaultValue: '2', sign: 'nonzero' },
      }),
      subtract: opService({
        feature: 'subtract', title: 'Subtract', pickHint: 'Pick the base geometry’s edges',
        slotted: true,
      }),
    };
    for (const service of Object.values(this.opServices)) {
      service.onVisibilityChange = (open) => this.onOpDialogToggle?.(open);
    }

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

      this.bezierHandles.activate();
      this.bezierHandles.update(sceneObjects, lastRoot.id, plane);

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
      } else if (!this.toolbar.activeTool) {
        this.activateDragHandler();
      }
    } else {
      if (this.activeDrawingTool) {
        this.activeDrawingTool.deactivate();
        this.activeDrawingTool = null;
      }
      for (const service of Object.values(this.opServices)) {
        if (service.isActive) {
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
      this.deactivateDragHandler();
      this.bezierHandles.deactivate();
      this.activeSketchInfo = null;
      this.toolbar.hide();
      this.shortcuts.disable();
    }
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
      newVariable?: { name: string; initializer: string },
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
    this.activeHoverSelectHandler.onSelectionChange = () => this.activeOpService()?.refresh();
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
      this.opMessageToast.className = 'absolute top-[116px] left-1/2 -translate-x-1/2 z-[1003] max-w-[440px] '
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
