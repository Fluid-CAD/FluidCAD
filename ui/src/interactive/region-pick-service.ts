import { ICON_WAND } from '../ui/icons';
import { RegionPickMode } from './region-pick-mode';
import { insertPoint, setPickPoints, addPick, removePick } from '../api';
import { SceneObjectRender, PlaneData } from '../types';
import { Viewer } from '../viewer';

const EXTRUDABLE_TYPES = ['extrude', 'cut', 'cut-symmetric', 'revolve', 'sweep', 'wrap'];

export class RegionPickService {
  private viewer: Viewer;
  private triggerBtn: HTMLDivElement;
  private activeBar: HTMLDivElement;
  private _state: 'idle' | 'icon-visible' | 'picking-active' = 'idle';
  private lastInfo: { extrudeObj: SceneObjectRender & { sourceLocation?: any }; sketchObj: SceneObjectRender } | null = null;
  private activeMode: RegionPickMode | null = null;
  private activeSourceLine: number | null = null;

  constructor(container: HTMLElement, viewer: Viewer) {
    this.viewer = viewer;

    this.triggerBtn = document.createElement('div');
    this.triggerBtn.id = 'fluidcad-region-pick-trigger';
    this.triggerBtn.className = 'absolute top-4 left-1/2 -translate-x-1/2 z-[999] pointer-events-auto hidden';
    this.triggerBtn.innerHTML = `
      <button class="flex items-center gap-3 panel-bg border border-base-content/10 rounded-lg px-6 py-3 text-base-content/70 text-sm leading-none select-none cursor-pointer hover:border-base-content/20 transition-colors">
        <span class="[&>svg]:size-5">${ICON_WAND}</span>
        <span>Pick Regions</span>
      </button>
    `;
    container.appendChild(this.triggerBtn);

    this.activeBar = document.createElement('div');
    this.activeBar.id = 'fluidcad-region-pick-active';
    this.activeBar.className = 'absolute top-4 left-1/2 -translate-x-1/2 z-[999] pointer-events-auto hidden';
    this.activeBar.innerHTML = `
      <div class="flex items-center gap-3 panel-bg border border-base-content/10 rounded-lg px-6 py-3 text-base-content/70 text-sm leading-none select-none">
        <span>Region Picking Mode</span>
        <div class="h-4 w-px bg-base-content/10"></div>
        <button class="text-base-content/60 hover:text-base-content transition-colors cursor-pointer" id="exit-region-pick">Exit</button>
      </div>
    `;
    container.appendChild(this.activeBar);

    this.triggerBtn.querySelector('button')!.addEventListener('click', () => {
      this.enter();
    });
    this.activeBar.querySelector('#exit-region-pick')!.addEventListener('click', () => {
      this.exit();
    });
  }

  get state(): 'idle' | 'icon-visible' | 'picking-active' {
    return this._state;
  }

  update(sceneObjects: SceneObjectRender[]): void {
    const triggerInfo = this.hasRegionPickingTrigger(sceneObjects);

    const hasPlane = (triggerInfo.extrudeObj as any)?.object?.pickPlane || triggerInfo.sketchObj?.object?.plane;
    if (!triggerInfo.hasTrigger || !triggerInfo.extrudeObj?.sourceLocation || !hasPlane) {
      this.reset();
      return;
    }

    this.lastInfo = { extrudeObj: triggerInfo.extrudeObj, sketchObj: triggerInfo.sketchObj };
    const hasPicking = (triggerInfo.extrudeObj as any).object?.picking;

    if (this._state === 'picking-active') {
      if (hasPicking) {
        const srcLine = this.lastInfo.extrudeObj.sourceLocation.line;
        if (this.activeMode && this.activeSourceLine === srcLine) {
          return;
        }
        this.activateInteractive(this.lastInfo);
      }
      return;
    }

    this._state = 'icon-visible';
    this.triggerBtn.classList.remove('hidden');
    this.activeBar.classList.add('hidden');
  }

  enter(): void {
    if (!this.lastInfo) {
      return;
    }

    const hasPicking = (this.lastInfo.extrudeObj as any).object?.picking;

    if (!hasPicking) {
      addPick((this.lastInfo.extrudeObj as any).sourceLocation);
      this._state = 'picking-active';
      this.triggerBtn.classList.add('hidden');
      this.activeBar.classList.remove('hidden');
      this.viewer.isRegionPicking = true;
      this.viewer.toggleSketchMode(false);
      return;
    }

    this.activateInteractive(this.lastInfo);
    this._state = 'picking-active';
    this.triggerBtn.classList.add('hidden');
    this.activeBar.classList.remove('hidden');
    this.viewer.isRegionPicking = true;
    this.viewer.toggleSketchMode(false);
    this.viewer.rebuildSceneMesh();
  }

  exit(): void {
    this.deactivateHandler();
    this.viewer.isRegionPicking = false;
    this.viewer.toggleSketchMode(true);
    this.viewer.rebuildSceneMesh();

    const extrudeObj = this.lastInfo?.extrudeObj as any;
    const isPicking = extrudeObj?.object?.picking;
    const pickPoints = extrudeObj?.object?.pickPoints as [number, number][] | undefined;
    if (isPicking && (!pickPoints || pickPoints.length === 0) && extrudeObj?.sourceLocation) {
      removePick(extrudeObj.sourceLocation);
    }

    if (this.lastInfo) {
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
    this.lastInfo = null;
    this.viewer.isRegionPicking = false;
    this.viewer.toggleSketchMode(true);
  }

  private activateInteractive(info: { extrudeObj: any; sketchObj: any }): void {
    this.deactivateHandler();

    const plane: PlaneData = info.extrudeObj.object?.pickPlane ?? info.sketchObj.object.plane;
    const sourceLocation = info.extrudeObj.sourceLocation;

    this.activeMode = new RegionPickMode(
      this.viewer.sceneContext,
      plane,
      (point2d) => {
        insertPoint(point2d, sourceLocation);
      },
      (finalPoints) => {
        setPickPoints(finalPoints, sourceLocation);
      },
      (_shapeId) => {},
    );
    this.activeSourceLine = sourceLocation.line;
    this.activeMode.activate();
  }

  private deactivateHandler(): void {
    if (this.activeMode) {
      this.activeMode.deactivate();
      this.activeMode = null;
      this.activeSourceLine = null;
    }
  }

  private hasRegionPickingTrigger(sceneObjects: SceneObjectRender[]): {
    hasTrigger: boolean;
    extrudeObj?: SceneObjectRender & { sourceLocation?: any };
    sketchObj?: SceneObjectRender;
  } {
    const SKIP_TYPES = ['plane', 'axis'];
    let lastObj: SceneObjectRender | undefined;
    for (let i = sceneObjects.length - 1; i >= 0; i--) {
      const obj = sceneObjects[i] as any;
      if (!obj.parentId && !SKIP_TYPES.includes(obj.type)) {
        lastObj = obj;
        break;
      }
    }

    if (!lastObj) {
      return { hasTrigger: false };
    }

    const obj = lastObj as any;
    if (!EXTRUDABLE_TYPES.includes(obj.type) || obj.object?.trigger !== 'region-picking' || obj.object?.thin) {
      return { hasTrigger: false };
    }

    const idx = sceneObjects.indexOf(lastObj);
    let sketchObj: SceneObjectRender | undefined;
    for (let j = idx - 1; j >= 0; j--) {
      if (sceneObjects[j].type === 'sketch' && sceneObjects[j].parentId === obj.parentId) {
        sketchObj = sceneObjects[j];
        break;
      }
    }
    return { hasTrigger: true, extrudeObj: lastObj, sketchObj };
  }
}
