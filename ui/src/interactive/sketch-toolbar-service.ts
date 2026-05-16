import { SketchToolbar } from '../ui/sketch-toolbar';
import { SketchTool, ToolId } from './sketch-tool';
import { LineTool } from './tools/line-tool';
import { CircleTool } from './tools/circle-tool';
import { CenterArcTool } from './tools/center-arc-tool';
import { ThreePointArcTool } from './tools/three-point-arc-tool';
import { TangentArcTool } from './tools/tangent-arc-tool';
import { RectTool } from './tools/rect-tool';
import { RoundedRectTool } from './tools/rounded-rect-tool';
import { SlotTool } from './tools/slot-tool';
import { PolylineTool } from './tools/polyline';
import { BezierTool } from './tools/bezier-tool';
import { PolygonTool } from './tools/polygon-tool';
import { DragMoveHandler } from './drag-move-handler';
import { SketchHoverSelectHandler } from './sketch-hover-select-handler';
import { BezierHandlesOverlay } from './bezier-handles-overlay';
import { SnapManager } from '../snapping/snap-manager';
import { SnapController } from '../snapping/snap-controller';
import { insertGeometry, getScopeVariables, removePick } from '../api';
import { isTopLevel } from '../helpers/scene-utils';
import { SceneObjectRender, PlaneData } from '../types';
import { Viewer } from '../viewer';
import { TrimPickService } from './trim-pick-service';
import { VariableInfo } from '../ui/expression-input';
import { TimelinePanel } from '../ui/timeline-panel';
import { ShortcutManager } from '../ui/shortcut-manager';

export class SketchToolbarService {
  private viewer: Viewer;
  private container: HTMLElement;
  private trimService: TrimPickService;
  private timelinePanel: TimelinePanel;
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

  constructor(container: HTMLElement, viewer: Viewer, trimService: TrimPickService, timelinePanel: TimelinePanel) {
    this.viewer = viewer;
    this.container = container;
    this.trimService = trimService;
    this.timelinePanel = timelinePanel;

    this.toolbar = new SketchToolbar(timelinePanel.toolbarHost, (toolId) => {
      this.handleToolSelect(toolId);
    });

    this.shortcuts = new ShortcutManager();
    this.shortcuts.register('n', () => this.lookAlongSketchNormal());

    this.bezierHandles = new BezierHandlesOverlay(viewer.sceneContext);

    this.toolbar.onSnapVerticesChange = (checked: boolean) => {
      if (this.activeDrawingTool) {
        this.activeDrawingTool['snapController'].snapToVertices = checked;
      }
      if (this.activeDragHandler) {
        this.activeDragHandler['snapController'].snapToVertices = checked;
      }
    };
    this.toolbar.onSnapGridChange = (checked: boolean) => {
      if (this.activeDrawingTool) {
        this.activeDrawingTool['snapController'].snapToGrid = checked;
      }
      if (this.activeDragHandler) {
        this.activeDragHandler['snapController'].snapToGrid = checked;
      }
    };
  }

  get hasActiveDrawingTool(): boolean {
    return this.activeDrawingTool !== null;
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
        this.timelinePanel.slideOut();
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
        const snapManager = SnapManager.fromSceneObjects(sceneObjects, lastRoot.id, plane);
        const snapCtrl = new SnapController(snapManager, plane);
        snapCtrl.snapToVertices = this.toolbar.snapVerticesChecked;
        snapCtrl.snapToGrid = this.toolbar.snapGridChecked;
        this.activeDragHandler.updateSnapController(snapCtrl);
        this.activeDragHandler.updateSceneData(sceneObjects, lastRoot.id);
        if (this.activeHoverSelectHandler) {
          this.activeHoverSelectHandler.updatePlane(plane);
          this.activeHoverSelectHandler.updateSceneData(sceneObjects, lastRoot.id);
        }
      } else if (!this.toolbar.activeTool) {
        this.activateDragHandler();
      }
    } else {
      if (this.activeDrawingTool) {
        this.activeDrawingTool.deactivate();
        this.activeDrawingTool = null;
      }
      this.deactivateDragHandler();
      this.bezierHandles.deactivate();
      this.activeSketchInfo = null;
      this.toolbar.hide();
      this.shortcuts.disable();
      this.timelinePanel.slideIn();
    }
  }

  private async fetchScopeVariables(): Promise<VariableInfo[]> {
    if (!this.activeSketchInfo) {
      return [];
    }
    return getScopeVariables(this.activeSketchInfo.sourceLocation.line);
  }

  private createTool(toolId: ToolId, plane: PlaneData, sceneObjects: SceneObjectRender[], sketchId: string): SketchTool | null {
    const snapManager = SnapManager.fromSceneObjects(sceneObjects, sketchId, plane);
    const snapCtrl = new SnapController(snapManager, plane);
    snapCtrl.snapToVertices = this.toolbar.snapVerticesChecked;
    snapCtrl.snapToGrid = this.toolbar.snapGridChecked;

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
      case 'arc3':
        return new ThreePointArcTool(this.viewer.sceneContext, plane, snapCtrl, doInsertGeometry, this.container, fetchVars);
      case 'tarc': {
        const tool = new TangentArcTool(this.viewer.sceneContext, plane, snapCtrl, doInsertGeometry, this.container, fetchVars);
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
        return new RectTool(this.viewer.sceneContext, plane, snapCtrl, doInsertGeometry, this.container, fetchVars);
      case 'rounded-rect':
        return new RoundedRectTool(this.viewer.sceneContext, plane, snapCtrl, doInsertGeometry, this.container, fetchVars);
      case 'slot':
        return new SlotTool(this.viewer.sceneContext, plane, snapCtrl, doInsertGeometry, this.container, fetchVars);
      default:
        return null;
    }
  }

  private activateDragHandler(): void {
    if (this.activeDragHandler || !this.activeSketchInfo) {
      return;
    }
    const snapManager = SnapManager.fromSceneObjects(this.viewer.currentSceneObjects, this.activeSketchInfo.sketchObj.id!, this.activeSketchInfo.plane);
    const snapCtrl = new SnapController(snapManager, this.activeSketchInfo.plane);
    snapCtrl.snapToVertices = this.toolbar.snapVerticesChecked;
    snapCtrl.snapToGrid = this.toolbar.snapGridChecked;
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

    if (this.activeDrawingTool) {
      this.activeDrawingTool.deactivate();
      this.activeDrawingTool = null;
    }

    if (this.toolbar.activeTool === 'trim' && toolId !== 'trim') {
      this.exitTrimFromToolbar();
    }

    this.toolbar.setActiveTool(toolId);

    if (!toolId || !this.activeSketchInfo) {
      if (!toolId && this.activeSketchInfo) {
        this.activateDragHandler();
      }
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

  private enterTrimFromToolbar(): void {
    if (!this.activeSketchInfo) {
      return;
    }

    if (this.trimService.lastPickInfo) {
      this.trimService.enter();
      this.trimService.hideBars();
      return;
    }

    this.trimService.pendingActivation = true;
    insertGeometry('trim()', this.activeSketchInfo.sourceLocation);
  }

  private exitTrimFromToolbar(): void {
    this.trimService.pendingActivation = false;
    if (this.trimService.state === 'picking-active') {
      this.trimService.exit();
    }
    if (this.trimService.lastPickInfo) {
      const trimObj = this.trimService.lastPickInfo.trimObj as any;
      const isPicking = trimObj?.object?.picking;
      const pickPoints = trimObj?.object?.pickPoints as [number, number][] | undefined;
      if (isPicking && (!pickPoints || pickPoints.length === 0) && trimObj?.sourceLocation) {
        removePick(trimObj.sourceLocation);
      }
    }
    this.trimService.reset();
  }

  private lookAlongSketchNormal(): void {
    if (this.activeSketchInfo) {
      this.viewer.lookAlongSketchNormal(this.activeSketchInfo.plane);
    }
  }
}
