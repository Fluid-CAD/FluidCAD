import { BezierDrawMode } from './bezier-draw-mode';
import { SnapManager } from '../snapping/snap-manager';
import { SnapController } from '../snapping/snap-controller';
import { insertPoint, setPickPoints } from '../api';
import { isTopLevel } from '../helpers/scene-utils';
import { SceneObjectRender, PlaneData } from '../types';
import { Viewer } from '../viewer';

export class BezierDrawService {
  private viewer: Viewer;
  private indicator: HTMLDivElement;
  private activeMode: BezierDrawMode | null = null;
  private activeSourceLine: number | null = null;

  constructor(container: HTMLElement, viewer: Viewer) {
    this.viewer = viewer;

    this.indicator = document.createElement('div');
    this.indicator.id = 'fluidcad-bezier-indicator';
    this.indicator.className = 'absolute top-4 left-1/2 -translate-x-1/2 z-[999] pointer-events-auto hidden';
    this.indicator.innerHTML = `
      <div class="flex items-center gap-3 panel-bg border border-base-content/10 rounded-lg px-6 py-3 text-base-content/70 text-sm leading-none select-none">
        <span>Bezier Drawing Mode</span>
        <div class="h-4 w-px bg-base-content/10"></div>
        <label class="flex items-center gap-1.5 cursor-pointer">
          <input type="checkbox" class="checkbox checkbox-xs checkbox-primary" data-snap="vertex" checked />
          <span class="text-xs">Snap to vertices</span>
        </label>
        <label class="flex items-center gap-1.5 cursor-pointer">
          <input type="checkbox" class="checkbox checkbox-xs checkbox-primary" data-snap="grid" checked />
          <span class="text-xs">Snap to grid</span>
        </label>
      </div>
    `;
    container.appendChild(this.indicator);

    this.indicator.querySelector<HTMLInputElement>('[data-snap="vertex"]')!.addEventListener('change', (e) => {
      if (this.activeMode) {
        this.activeMode.snapController.snapToVertices = (e.target as HTMLInputElement).checked;
      }
    });
    this.indicator.querySelector<HTMLInputElement>('[data-snap="grid"]')!.addEventListener('change', (e) => {
      if (this.activeMode) {
        this.activeMode.snapController.snapToGrid = (e.target as HTMLInputElement).checked;
      }
    });
  }

  isBezierDrawingScene(sceneObjects: SceneObjectRender[]): boolean {
    let lastRoot: SceneObjectRender | null = null;
    for (let i = sceneObjects.length - 1; i >= 0; i--) {
      if (isTopLevel(sceneObjects[i], sceneObjects)) {
        lastRoot = sceneObjects[i];
        break;
      }
    }
    if (!lastRoot || lastRoot.type !== 'sketch' || !lastRoot.id) {
      return false;
    }
    for (let i = sceneObjects.length - 1; i >= 0; i--) {
      if (sceneObjects[i].parentId === lastRoot.id) {
        return (sceneObjects[i] as any).type === 'bezier';
      }
    }
    return false;
  }

  update(sceneObjects: SceneObjectRender[]): void {
    let lastRoot: SceneObjectRender | null = null;
    for (let i = sceneObjects.length - 1; i >= 0; i--) {
      if (isTopLevel(sceneObjects[i], sceneObjects)) {
        lastRoot = sceneObjects[i];
        break;
      }
    }

    const sketchObj = lastRoot?.type === 'sketch' ? lastRoot : null;

    if (!sketchObj || !sketchObj.id || !sketchObj.object?.plane) {
      this.deactivate();
      return;
    }

    let lastChild: (SceneObjectRender & { type?: string; sourceLocation?: any }) | null = null;
    for (let i = sceneObjects.length - 1; i >= 0; i--) {
      if (sceneObjects[i].parentId === sketchObj.id) {
        lastChild = sceneObjects[i] as any;
        break;
      }
    }

    if (!lastChild || (lastChild as any).type !== 'bezier' || !lastChild.sourceLocation) {
      this.deactivate();
      return;
    }

    const srcLine = lastChild.sourceLocation.line;
    const plane: PlaneData = sketchObj.object.plane;
    const existingPoles = this.getBezierPoles(sceneObjects, sketchObj.id);
    const snapManager = SnapManager.fromSceneObjects(sceneObjects, sketchObj.id, plane);

    if (this.activeMode && this.activeSourceLine === srcLine) {
      this.activeMode.updateExistingPoles(existingPoles);
      this.activeMode.snapController.updateSnapManager(snapManager);
      return;
    }

    this.deactivate();

    const sourceLocation = lastChild.sourceLocation;
    const snapController = new SnapController(snapManager, plane);

    const vertexCb = this.indicator.querySelector<HTMLInputElement>('[data-snap="vertex"]');
    const gridCb = this.indicator.querySelector<HTMLInputElement>('[data-snap="grid"]');
    if (vertexCb) {
      snapController.snapToVertices = vertexCb.checked;
    }
    if (gridCb) {
      snapController.snapToGrid = gridCb.checked;
    }

    this.activeMode = new BezierDrawMode(
      this.viewer.sceneContext,
      plane,
      snapController,
      existingPoles,
      (point2d) => {
        insertPoint(point2d, sourceLocation);
      },
      (points) => {
        setPickPoints(points, sourceLocation);
      },
    );
    this.activeSourceLine = srcLine;
    this.activeMode.activate();
    this.indicator.classList.remove('hidden');
  }

  deactivate(): void {
    if (this.activeMode) {
      this.activeMode.deactivate();
      this.activeMode = null;
      this.activeSourceLine = null;
    }
    this.indicator.classList.add('hidden');
  }

  private getBezierPoles(sceneObjects: SceneObjectRender[], sketchId: string): [number, number][] {
    for (let i = sceneObjects.length - 1; i >= 0; i--) {
      const obj = sceneObjects[i] as any;
      if (obj.parentId === sketchId && obj.type === 'bezier') {
        const startPt = obj.object?.startPoint as [number, number] | undefined;
        const resolved = obj.object?.resolvedPoints as [number, number][] | undefined;
        if (startPt) {
          return [startPt, ...(resolved || [])];
        }
        return [];
      }
    }
    return [];
  }
}
