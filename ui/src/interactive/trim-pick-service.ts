import { ICON_SCISSORS } from '../ui/icons';
import { PointPickMode, HighlightInfo } from './point-pick-mode';
import { SnapManager } from '../snapping/snap-manager';
import { insertPoint, addPick, removePick } from '../api';
import { isTopLevel } from '../helpers/scene-utils';
import { SceneObjectRender, PlaneData } from '../types';
import { Viewer } from '../viewer';
import { Mesh, Object3D } from 'three';

const HIGHLIGHT_COLOR = 0xffc578;
const VERTEX_MATCH_EPSILON_SQ = 1e-4;

export class TrimPickService {
  private viewer: Viewer;
  private triggerBtn: HTMLDivElement;
  private activeBar: HTMLDivElement;
  private _state: 'idle' | 'icon-visible' | 'picking-active' = 'idle';
  private _lastPickInfo: { trimObj: SceneObjectRender & { sourceLocation?: any }; sketchObj: SceneObjectRender } | null = null;
  private lastSceneObjects: SceneObjectRender[] | null = null;
  private activePointPickMode: PointPickMode | null = null;
  private activePickSourceLine: number | null = null;
  private _pendingActivation = false;
  private highlightedVertexDots: { mesh: Mesh; originalMaterial: any }[] = [];

  constructor(container: HTMLElement, viewer: Viewer) {
    this.viewer = viewer;

    this.triggerBtn = document.createElement('div');
    this.triggerBtn.id = 'fluidcad-trim-pick-trigger';
    this.triggerBtn.className = 'absolute top-4 left-1/2 -translate-x-1/2 z-[999] pointer-events-auto hidden';
    this.triggerBtn.innerHTML = `
      <button class="flex items-center gap-3 panel-bg border border-base-content/10 rounded-lg px-6 py-3 text-base-content/70 text-sm leading-none select-none cursor-pointer hover:border-base-content/20 transition-colors">
        <span class="[&>svg]:size-5">${ICON_SCISSORS}</span>
        <span>Interactive Trimming</span>
      </button>
    `;
    container.appendChild(this.triggerBtn);

    this.activeBar = document.createElement('div');
    this.activeBar.id = 'fluidcad-trim-pick-active';
    this.activeBar.className = 'absolute top-4 left-1/2 -translate-x-1/2 z-[999] pointer-events-auto hidden';
    this.activeBar.innerHTML = `
      <div class="flex items-center gap-3 panel-bg border border-base-content/10 rounded-lg px-6 py-3 text-base-content/70 text-sm leading-none select-none">
        <span class="[&>svg]:size-5">${ICON_SCISSORS}</span>
        <span>Trimming Mode</span>
        <div class="h-4 w-px bg-base-content/10"></div>
        <button class="text-base-content/60 hover:text-base-content transition-colors cursor-pointer" id="exit-trim-pick">Exit</button>
      </div>
    `;
    container.appendChild(this.activeBar);

    this.triggerBtn.querySelector('button')!.addEventListener('click', () => {
      this.enter();
    });
    this.activeBar.querySelector('#exit-trim-pick')!.addEventListener('click', () => {
      this.exit();
    });
  }

  get state(): 'idle' | 'icon-visible' | 'picking-active' {
    return this._state;
  }

  get lastPickInfo(): { trimObj: SceneObjectRender & { sourceLocation?: any }; sketchObj: SceneObjectRender } | null {
    return this._lastPickInfo;
  }

  get pendingActivation(): boolean {
    return this._pendingActivation;
  }

  set pendingActivation(value: boolean) {
    this._pendingActivation = value;
  }

  update(sceneObjects: SceneObjectRender[]): void {
    const triggerInfo = this.hasTrimPickingTrigger(sceneObjects);

    if (!triggerInfo.hasTrigger) {
      if (!this._pendingActivation) {
        this.reset();
      }
      return;
    }

    this._lastPickInfo = { trimObj: triggerInfo.trimObj!, sketchObj: triggerInfo.sketchObj! };
    this.lastSceneObjects = sceneObjects;
    const hasPicking = (triggerInfo.trimObj as any).object?.picking;

    if (this._pendingActivation) {
      this._pendingActivation = false;
      this.enter();
      this.activeBar.classList.add('hidden');
      this.triggerBtn.classList.add('hidden');
      return;
    }

    if (this._state === 'picking-active') {
      if (hasPicking) {
        const srcLine = this._lastPickInfo.trimObj.sourceLocation!.line;
        if (this.activePointPickMode && this.activePickSourceLine === srcLine) {
          this.activePointPickMode.updateEdges(sceneObjects, triggerInfo.sketchObj!.id!);
          return;
        }
        this.activateInteractive(this._lastPickInfo, sceneObjects);
      }
      return;
    }

    this._state = 'icon-visible';
    this.triggerBtn.classList.remove('hidden');
    this.activeBar.classList.add('hidden');
  }

  enter(): void {
    if (!this._lastPickInfo) {
      return;
    }

    const hasPicking = (this._lastPickInfo.trimObj as any).object?.picking;

    if (!hasPicking) {
      addPick((this._lastPickInfo.trimObj as any).sourceLocation);
      this._state = 'picking-active';
      this.triggerBtn.classList.add('hidden');
      this.activeBar.classList.remove('hidden');
      this.viewer.isTrimming = true;
      return;
    }

    if (this.lastSceneObjects) {
      this.activateInteractive(this._lastPickInfo, this.lastSceneObjects);
    }
    this._state = 'picking-active';
    this.triggerBtn.classList.add('hidden');
    this.activeBar.classList.remove('hidden');
    this.viewer.isTrimming = true;
  }

  exit(): void {
    this.deactivateHandler();
    this.viewer.isTrimming = false;

    const trimObj = this._lastPickInfo?.trimObj as any;
    const isPicking = trimObj?.object?.picking;
    const pickPoints = trimObj?.object?.pickPoints as [number, number][] | undefined;
    if (isPicking && (!pickPoints || pickPoints.length === 0) && trimObj?.sourceLocation) {
      removePick(trimObj.sourceLocation);
    }

    if (this._lastPickInfo) {
      this._state = 'icon-visible';
      this.activeBar.classList.add('hidden');
      this.triggerBtn.classList.remove('hidden');
    } else {
      this._state = 'idle';
      this.activeBar.classList.add('hidden');
      this.triggerBtn.classList.add('hidden');
    }
  }

  reset(): void {
    this.deactivateHandler();
    this._state = 'idle';
    this.triggerBtn.classList.add('hidden');
    this.activeBar.classList.add('hidden');
    this._lastPickInfo = null;
    this.lastSceneObjects = null;
    this.viewer.isTrimming = false;
  }

  hideBars(): void {
    this.activeBar.classList.add('hidden');
    this.triggerBtn.classList.add('hidden');
  }

  private activateInteractive(info: { trimObj: any; sketchObj: any }, sceneObjects: SceneObjectRender[]): void {
    this.deactivateHandler();

    const plane: PlaneData = info.sketchObj.object.plane;
    const sourceLocation = info.trimObj.sourceLocation;
    const sketchId = info.sketchObj.id;

    const snapManager = SnapManager.fromSceneObjects(sceneObjects, sketchId, plane, this.viewer.sceneContext);

    this.activePointPickMode = new PointPickMode(
      this.viewer.sceneContext,
      plane,
      snapManager,
      sceneObjects,
      sketchId,
      (point2d) => {
        insertPoint(point2d, sourceLocation);
      },
      (info: HighlightInfo) => {
        this.viewer.clearHighlight();
        this.clearVertexHighlights();
        if (info) {
          this.viewer.highlightShape(info.shapeId);
          this.highlightVerticesAt(info.endpoints);
        }
      },
    );
    this.activePickSourceLine = sourceLocation.line;
    this.activePointPickMode.activate();
  }

  private deactivateHandler(): void {
    if (this.activePointPickMode) {
      this.activePointPickMode.deactivate();
      this.activePointPickMode = null;
      this.activePickSourceLine = null;
    }
    this.clearVertexHighlights();
  }

  private highlightVerticesAt(endpoints: [number, number, number][]): void {
    this.clearVertexHighlights();
    if (endpoints.length === 0) {
      return;
    }

    this.viewer.sceneContext.scene.traverse((obj: Object3D) => {
      if (!obj.userData.isVertexDot) {
        return;
      }
      const dot = obj.children[0] as Mesh;
      if (!dot || !(dot as any).isMesh) {
        return;
      }
      const pos = obj.position;
      for (const ep of endpoints) {
        const dx = pos.x - ep[0];
        const dy = pos.y - ep[1];
        const dz = pos.z - ep[2];
        if (dx * dx + dy * dy + dz * dz < VERTEX_MATCH_EPSILON_SQ) {
          const originalMaterial = dot.material;
          const cloned = (originalMaterial as any).clone();
          cloned.color.setHex(HIGHLIGHT_COLOR);
          dot.material = cloned;
          this.highlightedVertexDots.push({ mesh: dot, originalMaterial });
          break;
        }
      }
    });

    this.viewer.sceneContext.requestRender();
  }

  private clearVertexHighlights(): void {
    for (const { mesh, originalMaterial } of this.highlightedVertexDots) {
      (mesh.material as any).dispose();
      mesh.material = originalMaterial;
    }
    if (this.highlightedVertexDots.length > 0) {
      this.highlightedVertexDots.length = 0;
      this.viewer.sceneContext.requestRender();
    }
  }

  private hasTrimPickingTrigger(sceneObjects: SceneObjectRender[]): {
    hasTrigger: boolean;
    trimObj?: SceneObjectRender & { sourceLocation?: any };
    sketchObj?: SceneObjectRender;
  } {
    let lastRoot: SceneObjectRender | null = null;
    for (let i = sceneObjects.length - 1; i >= 0; i--) {
      if (isTopLevel(sceneObjects[i], sceneObjects)) {
        lastRoot = sceneObjects[i];
        break;
      }
    }

    if (!lastRoot || lastRoot.type !== 'sketch' || !lastRoot.id || !lastRoot.object?.plane) {
      return { hasTrigger: false };
    }

    let lastChild: SceneObjectRender | null = null;
    for (let i = sceneObjects.length - 1; i >= 0; i--) {
      if (sceneObjects[i].parentId === lastRoot.id) {
        lastChild = sceneObjects[i];
        break;
      }
    }

    const obj = lastChild as any;
    if (!obj || obj.type !== 'trim2d' || obj.object?.trigger !== 'trim-picking' || !obj.sourceLocation) {
      return { hasTrigger: false };
    }

    return { hasTrigger: true, trimObj: lastChild!, sketchObj: lastRoot };
  }
}
