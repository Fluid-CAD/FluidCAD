import { ICON_WAND } from '../ui/icons';
import { RegionPickMode } from './region-pick-mode';
import { addRegion, removeRegion, setRegions } from '../api';
import { activeScopeObjects } from '../helpers/scene-utils';
import { SceneObjectRender, PlaneData } from '../types';
import { Viewer } from '../viewer';
import { Navbar } from '../ui/navbar';

const EXTRUDABLE_TYPES = ['extrude', 'cut', 'cut-symmetric', 'revolve', 'sweep', 'wrap'];

/** One region of the source sketch as the kernel reports it while picking. */
type RegionEntry = { key: string; index: number; selected: boolean };

/**
 * The region-picking fields an extrude/cut/revolve/sweep/wrap object carries
 * (`SceneObjectRender.object`).
 */
type RegionPickPayload = {
  /** The statement carries a `.region(...)` chain. */
  regionPicking?: true;
  /** The keys written in source — strings, or ordinal positions. */
  regionKeys?: (string | number)[];
  /** Every region of the sketch, `selected` when a key resolved to it. */
  regions?: RegionEntry[];
  trigger?: string;
  pickPlane?: PlaneData;
  thin?: unknown;
};

/** The keys of the selected regions in index order. */
function selectedRegionKeys(payload: RegionPickPayload | undefined): string[] {
  const regions = payload?.regions ?? [];
  return regions
    .filter(region => region.selected)
    .sort((a, b) => a.index - b.index)
    .map(region => region.key);
}

export class RegionPickService {
  private viewer: Viewer;
  private triggerBtn: HTMLDivElement;
  private activeBar: HTMLDivElement;
  private _state: 'idle' | 'icon-visible' | 'picking-active' = 'idle';
  private lastInfo: { extrudeObj: SceneObjectRender & { sourceLocation?: any }; sketchObj: SceneObjectRender } | null = null;
  private activeMode: RegionPickMode | null = null;
  private activeSourceLine: number | null = null;

  constructor(viewer: Viewer, private navbar: Navbar) {
    this.viewer = viewer;

    // Trailing toolbar group: the "Pick Regions" prompt and the active-mode
    // status render at the end of the navbar (see Navbar anchor: 'end').
    const host = navbar.addGroup('region', { anchor: 'end', visible: false });

    this.triggerBtn = document.createElement('div');
    this.triggerBtn.id = 'fluidcad-region-pick-trigger';
    this.triggerBtn.className = 'flex items-center hidden';
    this.triggerBtn.innerHTML = `
      <button class="btn btn-sm btn-outline btn-primary border-dashed gap-1.5 text-xs font-normal">
        <span class="[&>svg]:size-4">${ICON_WAND}</span>
        <span>Pick Regions</span>
      </button>
    `;
    host.appendChild(this.triggerBtn);

    this.activeBar = document.createElement('div');
    this.activeBar.id = 'fluidcad-region-pick-active';
    this.activeBar.className = 'flex items-center gap-2 text-xs select-none hidden';
    this.activeBar.innerHTML = `
      <span class="[&>svg]:size-4 text-primary">${ICON_WAND}</span>
      <span class="text-primary font-medium">Region Picking Mode</span>
      <div class="h-4 w-px bg-base-content/15"></div>
      <button class="btn btn-ghost btn-xs" id="exit-region-pick">Exit</button>
    `;
    host.appendChild(this.activeBar);

    this.triggerBtn.querySelector('button')!.addEventListener('click', () => {
      this.enter();
    });
    this.activeBar.querySelector('#exit-region-pick')!.addEventListener('click', () => {
      this.exit();
    });
  }

  /** Show the trailing group only while a bar (prompt or active status) is visible. */
  private syncGroup(): void {
    const hasBar =
      !this.triggerBtn.classList.contains('hidden') ||
      !this.activeBar.classList.contains('hidden');
    this.navbar.setGroupVisible('region', hasBar);
  }

  get state(): 'idle' | 'icon-visible' | 'picking-active' {
    return this._state;
  }

  update(sceneObjects: SceneObjectRender[]): void {
    this.updateImpl(sceneObjects);
    this.syncGroup();
  }

  private updateImpl(sceneObjects: SceneObjectRender[]): void {
    const triggerInfo = this.hasRegionPickingTrigger(sceneObjects);

    const hasPlane = this.payloadOf(triggerInfo.extrudeObj)?.pickPlane || triggerInfo.sketchObj?.object?.plane;
    if (!triggerInfo.hasTrigger || !triggerInfo.extrudeObj?.sourceLocation || !hasPlane) {
      this.reset();
      return;
    }

    this.lastInfo = { extrudeObj: triggerInfo.extrudeObj, sketchObj: triggerInfo.sketchObj };
    const hasPicking = this.payloadOf(triggerInfo.extrudeObj)?.regionPicking === true;

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

    const hasPicking = this.payloadOf(this.lastInfo.extrudeObj)?.regionPicking === true;

    if (!hasPicking) {
      addRegion(this.lastInfo.extrudeObj.sourceLocation);
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

    const extrudeObj = this.lastInfo?.extrudeObj;
    const payload = this.payloadOf(extrudeObj);
    const isPicking = payload?.regionPicking === true;
    const regionKeys = payload?.regionKeys;
    if (isPicking && (!regionKeys || regionKeys.length === 0) && extrudeObj?.sourceLocation) {
      removeRegion(extrudeObj.sourceLocation);
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
    this.syncGroup();
  }

  reset(): void {
    this.deactivateHandler();
    this._state = 'idle';
    this.triggerBtn.classList.add('hidden');
    this.activeBar.classList.add('hidden');
    this.lastInfo = null;
    // Re-enable sketch mode only when this service disabled it. reset() runs
    // on every rollback render — unconditionally re-enabling would stomp a
    // dialog's own sketch suspension (an edit session's rolled-back view).
    if (this.viewer.isRegionPicking) {
      this.viewer.isRegionPicking = false;
      this.viewer.toggleSketchMode(true);
    }
    this.syncGroup();
  }

  private payloadOf(extrudeObj: SceneObjectRender | undefined): RegionPickPayload | undefined {
    return extrudeObj?.object as RegionPickPayload | undefined;
  }

  /**
   * The selected keys of the statement as last rendered. Read at click time:
   * the mode outlives re-renders of the same line, and each render refreshes
   * `lastInfo` with the kernel's current selection.
   */
  private currentSelectedKeys(): string[] {
    return selectedRegionKeys(this.payloadOf(this.lastInfo?.extrudeObj));
  }

  private activateInteractive(info: { extrudeObj: SceneObjectRender & { sourceLocation?: any }; sketchObj: any }): void {
    this.deactivateHandler();

    const sourceLocation = info.extrudeObj.sourceLocation;

    this.activeMode = new RegionPickMode(
      this.viewer.sceneContext,
      (key) => {
        const keys = this.currentSelectedKeys();
        if (!keys.includes(key)) {
          keys.push(key);
        }
        setRegions(keys, sourceLocation);
      },
      (key) => {
        const keys = this.currentSelectedKeys().filter(k => k !== key);
        setRegions(keys, sourceLocation);
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
    const scope = activeScopeObjects(sceneObjects);
    for (let i = scope.length - 1; i >= 0; i--) {
      if (!SKIP_TYPES.includes(scope[i].type as string)) {
        lastObj = scope[i];
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
