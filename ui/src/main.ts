import { Viewer } from './viewer';
import { ShapePropertiesModal } from './ui/shape-properties-modal';
import { SelectionInfoOverlay } from './ui/selection-info-overlay';
import { TimelinePanel } from './ui/timeline-panel';
import { ExportDialog } from './ui/export-dialog';
import { ICON_SCISSORS, ICON_FILE_IMPORT, ICON_COPY, ICON_WAND } from './ui/icons';
import { PointPickMode, HighlightInfo } from './interactive/point-pick-mode';
import { RegionPickMode } from './interactive/region-pick-mode';
import { BezierDrawMode } from './interactive/bezier-draw-mode';
import { captureScreenshot } from './screenshot';
import { Mesh, Object3D } from 'three';
import { SnapManager } from './snapping/snap-manager';
import { SnapController } from './snapping/snap-controller';
import { SceneObjectRender, PlaneData } from './types';
import { onThemeChange } from './scene/theme-colors';

const container = document.getElementById('fluidcad-viewer') || document.body;

// Load persisted theme preference from the server and apply it.
// The default dark theme is set in index.html, so there's no flash of unstyled content.
fetch('/api/preferences')
  .then((res) => res.ok ? res.json() : null)
  .then((prefs) => {
    if (prefs?.theme) {
      document.documentElement.setAttribute('data-theme', prefs.theme);
    }
  })
  .catch(() => {
    // Use default theme
  });

/** Check if a scene object is "top-level": either root or a direct child of a Part container. */
function isTopLevel(obj: SceneObjectRender, sceneObjects: SceneObjectRender[]): boolean {
  if (!obj.parentId) {
    return true;
  }
  const parent = sceneObjects.find(o => o.id === obj.parentId);
  return parent?.type === 'part';
}

// ---------------------------------------------------------------------------
// Loading overlay — shown until the server kernel finishes initializing
// ---------------------------------------------------------------------------

const loadingOverlay = document.createElement('div');
loadingOverlay.id = 'fluidcad-loading';
loadingOverlay.className = 'absolute top-4 left-1/2 -translate-x-1/2 z-[1000] pointer-events-none';
loadingOverlay.innerHTML = `
  <div class="flex items-center gap-3 panel-bg border border-base-content/10 rounded-lg px-6 py-3 text-base-content/70 text-sm leading-none select-none">
    <span class="loading loading-spinner loading-sm"></span>
    <span class="loading-text">Loading FluidCAD...</span>
  </div>
`;
container.appendChild(loadingOverlay);

const loadingText = loadingOverlay.querySelector('.loading-text')!;

function showLoading(text: string) {
  loadingText.textContent = text;
  loadingOverlay.classList.remove('hidden');
}

function hideLoading() {
  loadingOverlay.classList.add('hidden');
}

const viewer = new Viewer('fluidcad-viewer');

// Rebuild scene meshes when the theme changes so face/edge colors update
onThemeChange(() => viewer.rebuildSceneMesh());

const shapePropertiesModal = new ShapePropertiesModal(container);
const selectionInfoOverlay = new SelectionInfoOverlay(container);
const exportDialog = new ExportDialog(container, viewer.sceneContext);
const timelinePanel = new TimelinePanel(
  container,
  (shapeId) => viewer.highlightShape(shapeId),
  (shapeIds) => exportDialog.show(shapeIds),
  (shapeId, visible) => viewer.setShapeVisibility(shapeId, visible),
  (shapeId) => viewer.isShapeHidden(shapeId),
  (shapeId, opacity) => viewer.setShapeTransparency(shapeId, opacity),
  (shapeId) => viewer.getShapeTransparency(shapeId),
);

shapePropertiesModal.setOpenHandler(() => {
  viewer.clearHighlight();
  selectionInfoOverlay.hide();
});

shapePropertiesModal.setCentroidHandler((centroid) => {
  if (centroid) {
    viewer.showCentroid(centroid);
  } else {
    viewer.clearCentroid();
  }
});

viewer.setSelectionHandler((shapeId, sub) => {
  if (shapeId) {
    if (shapePropertiesModal.isOpen) {
      viewer.highlightShape(shapeId);
    } else if (sub?.type === 'face') {
      viewer.highlightFace(shapeId, sub.index);
    } else if (sub?.type === 'edge') {
      viewer.highlightEdge(shapeId, sub.index);
    } else {
      viewer.clearHighlight();
    }
  } else {
    viewer.clearHighlight();
  }
  shapePropertiesModal.setSelectedShape(shapeId);
  if (shapeId !== null && sub !== null) {
    if (sub.type === 'face') {
      selectionInfoOverlay.showForFace(shapeId, sub.index);
    } else {
      selectionInfoOverlay.showForEdge(shapeId, sub.index);
    }
  } else {
    selectionInfoOverlay.hide();
  }
});

// ---------------------------------------------------------------------------
// Interactive point-pick mode (for trim and future features)
// ---------------------------------------------------------------------------

const trimIndicator = document.createElement('div');
trimIndicator.id = 'fluidcad-trim-indicator';
trimIndicator.className = 'absolute top-4 left-1/2 -translate-x-1/2 z-[999] pointer-events-none hidden';
trimIndicator.innerHTML = `
  <div class="flex items-center gap-3 panel-bg border border-base-content/10 rounded-lg px-6 py-3 text-base-content/70 text-sm leading-none select-none">
    <span class="[&>svg]:size-5">${ICON_SCISSORS}</span>
    <span>Trimming Mode</span>
  </div>
`;
container.appendChild(trimIndicator);

let activePointPickMode: PointPickMode | null = null;
let activePickSourceLine: number | null = null;

function isTrimmingScene(sceneObjects: SceneObjectRender[]): boolean {
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
      return (sceneObjects[i] as any).type === 'trim2d';
    }
  }
  return false;
}

function updatePointPickMode(sceneObjects: SceneObjectRender[]) {
  // Only activate pick mode if the last top-level object is a sketch
  // (i.e., the sketch is still the active/open feature)
  let lastRoot: SceneObjectRender | null = null;
  for (let i = sceneObjects.length - 1; i >= 0; i--) {
    if (isTopLevel(sceneObjects[i], sceneObjects)) {
      lastRoot = sceneObjects[i];
      break;
    }
  }

  const sketchObj = lastRoot?.type === 'sketch' ? lastRoot : null;

  if (!sketchObj || !sketchObj.id || !sketchObj.object?.plane) {
    deactivatePickMode();
    return;
  }

  // Find the last child of this sketch
  let lastChild: (SceneObjectRender & { type?: string; sourceLocation?: any }) | null = null;
  for (let i = sceneObjects.length - 1; i >= 0; i--) {
    if (sceneObjects[i].parentId === sketchObj.id) {
      lastChild = sceneObjects[i] as any;
      break;
    }
  }

  if (!lastChild || (lastChild as any).type !== 'trim2d' || !lastChild.sourceLocation) {
    deactivatePickMode();
    return;
  }

  const srcLine = lastChild.sourceLocation.line;

  // Already in pick mode for this same trim call — rebuild edge index
  // so newly inserted features become highlightable
  if (activePointPickMode && activePickSourceLine === srcLine) {
    activePointPickMode.updateEdges(sceneObjects, sketchObj.id);
    return;
  }

  // Activate new pick mode
  deactivatePickMode();

  const plane: PlaneData = sketchObj.object.plane;
  const sourceLocation = lastChild.sourceLocation;

  const snapManager = SnapManager.fromSceneObjects(sceneObjects, sketchObj.id, plane);

  activePointPickMode = new PointPickMode(
    viewer.sceneContext,
    plane,
    snapManager,
    sceneObjects,
    sketchObj.id,
    (point2d) => {
      fetch('/api/insert-point', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ point: point2d, sourceLocation }),
      });
    },
    (info: HighlightInfo) => {
      viewer.clearHighlight();
      clearVertexHighlights();
      if (info) {
        viewer.highlightShape(info.shapeId);
        highlightVerticesAt(info.endpoints);
      }
    },
  );
  activePickSourceLine = srcLine;
  activePointPickMode.activate();
  trimIndicator.classList.remove('hidden');
}

function deactivatePickMode() {
  if (activePointPickMode) {
    activePointPickMode.deactivate();
    activePointPickMode = null;
    activePickSourceLine = null;
  }
  clearVertexHighlights();
  trimIndicator.classList.add('hidden');
}

const HIGHLIGHT_COLOR = 0xffc578;
const VERTEX_MATCH_EPSILON_SQ = 1e-4;
const highlightedVertexDots: { mesh: Mesh; originalMaterial: any }[] = [];

function highlightVerticesAt(endpoints: [number, number, number][]) {
  clearVertexHighlights();
  if (endpoints.length === 0) {
    return;
  }

  viewer.sceneContext.scene.traverse((obj: Object3D) => {
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
        highlightedVertexDots.push({ mesh: dot, originalMaterial });
        break;
      }
    }
  });

  viewer.sceneContext.requestRender();
}

function clearVertexHighlights() {
  for (const { mesh, originalMaterial } of highlightedVertexDots) {
    (mesh.material as any).dispose();
    mesh.material = originalMaterial;
  }
  if (highlightedVertexDots.length > 0) {
    highlightedVertexDots.length = 0;
    viewer.sceneContext.requestRender();
  }
}

// ---------------------------------------------------------------------------
// Interactive region-pick mode (for extrude .pick())
// ---------------------------------------------------------------------------

// Magic wand trigger button — shown when last element has trigger='region-picking'
const regionPickTriggerBtn = document.createElement('div');
regionPickTriggerBtn.id = 'fluidcad-region-pick-trigger';
regionPickTriggerBtn.className = 'absolute top-4 left-1/2 -translate-x-1/2 z-[999] pointer-events-auto hidden';
regionPickTriggerBtn.innerHTML = `
  <button class="flex items-center gap-3 panel-bg border border-base-content/10 rounded-lg px-6 py-3 text-base-content/70 text-sm leading-none select-none cursor-pointer hover:border-base-content/20 transition-colors">
    <span class="[&>svg]:size-5">${ICON_WAND}</span>
    <span>Pick Regions</span>
  </button>
`;
container.appendChild(regionPickTriggerBtn);

// Active picking bar with exit button — shown when in picking mode
const regionPickActiveBar = document.createElement('div');
regionPickActiveBar.id = 'fluidcad-region-pick-active';
regionPickActiveBar.className = 'absolute top-4 left-1/2 -translate-x-1/2 z-[999] pointer-events-auto hidden';
regionPickActiveBar.innerHTML = `
  <div class="flex items-center gap-3 panel-bg border border-base-content/10 rounded-lg px-6 py-3 text-base-content/70 text-sm leading-none select-none">
    <span>Region Picking Mode</span>
    <div class="h-4 w-px bg-base-content/10"></div>
    <button class="text-base-content/60 hover:text-base-content transition-colors cursor-pointer" id="exit-region-pick">Exit</button>
  </div>
`;
container.appendChild(regionPickActiveBar);

let regionPickState: 'idle' | 'icon-visible' | 'picking-active' = 'idle';
let lastRegionPickInfo: { extrudeObj: SceneObjectRender & { sourceLocation?: any }; sketchObj: SceneObjectRender } | null = null;
let activeRegionPickMode: RegionPickMode | null = null;
let activeRegionPickSourceLine: number | null = null;

const EXTRUDABLE_TYPES = ['extrude', 'cut', 'cut-symmetric', 'revolve', 'sweep'];

function hasRegionPickingTrigger(sceneObjects: SceneObjectRender[]): {
  hasTrigger: boolean;
  extrudeObj?: SceneObjectRender & { sourceLocation?: any };
  sketchObj?: SceneObjectRender;
} {
  // The trigger only applies when the LAST element in the tree is an extrudable with trigger
  // Find the last top-level element (skip planes/axes which are construction helpers)
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
  if (!EXTRUDABLE_TYPES.includes(obj.type) || obj.object?.trigger !== 'region-picking') {
    return { hasTrigger: false };
  }

  // Find the sketch before it (same parent scope)
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

function activateRegionPickModeInteractive(info: { extrudeObj: any; sketchObj: any }) {
  deactivateRegionPickModeHandler();

  const plane: PlaneData = info.extrudeObj.object?.pickPlane ?? info.sketchObj.object.plane;
  const sourceLocation = info.extrudeObj.sourceLocation;

  activeRegionPickMode = new RegionPickMode(
    viewer.sceneContext,
    plane,
    (point2d) => {
      fetch('/api/insert-point', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ point: point2d, sourceLocation }),
      });
    },
    (finalPoints) => {
      fetch('/api/set-pick-points', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ points: finalPoints, sourceLocation }),
      });
    },
    (_shapeId) => {
      // Highlight is handled directly by RegionPickMode via material changes
    },
  );
  activeRegionPickSourceLine = sourceLocation.line;
  activeRegionPickMode.activate();
}

function enterRegionPickMode() {
  if (!lastRegionPickInfo) {
    return;
  }

  const hasPicking = (lastRegionPickInfo.extrudeObj as any).object?.picking;

  if (!hasPicking) {
    // Need to add .pick() to the code first — send request to extension
    fetch('/api/add-pick', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sourceLocation: (lastRegionPickInfo.extrudeObj as any).sourceLocation,
      }),
    });
    // Transition to picking-active optimistically; the scene will re-render
    // when .pick() is added, and updateRegionPickMode will activate the handler
    regionPickState = 'picking-active';
    regionPickTriggerBtn.classList.add('hidden');
    regionPickActiveBar.classList.remove('hidden');
    viewer.isRegionPicking = true;
    viewer.toggleSketchMode(false);
    return;
  }

  // .pick() already exists — activate interactive mode directly
  activateRegionPickModeInteractive(lastRegionPickInfo);
  regionPickState = 'picking-active';
  regionPickTriggerBtn.classList.add('hidden');
  regionPickActiveBar.classList.remove('hidden');
  viewer.isRegionPicking = true;
  viewer.toggleSketchMode(false);
  viewer.rebuildSceneMesh();
}

function exitRegionPickMode() {
  deactivateRegionPickModeHandler();
  viewer.isRegionPicking = false;
  viewer.toggleSketchMode(true);
  viewer.rebuildSceneMesh();

  if (lastRegionPickInfo) {
    // Transition back to icon-visible
    regionPickState = 'icon-visible';
    regionPickActiveBar.classList.add('hidden');
    regionPickTriggerBtn.classList.remove('hidden');
  } else {
    regionPickState = 'idle';
    regionPickActiveBar.classList.add('hidden');
    regionPickTriggerBtn.classList.add('hidden');
  }
}

function deactivateRegionPickModeHandler() {
  if (activeRegionPickMode) {
    activeRegionPickMode.deactivate();
    activeRegionPickMode = null;
    activeRegionPickSourceLine = null;
  }
}

function resetRegionPickMode() {
  deactivateRegionPickModeHandler();
  regionPickState = 'idle';
  regionPickTriggerBtn.classList.add('hidden');
  regionPickActiveBar.classList.add('hidden');
  lastRegionPickInfo = null;
  viewer.isRegionPicking = false;
  viewer.toggleSketchMode(true);
}

function updateRegionPickMode(sceneObjects: SceneObjectRender[]) {
  const triggerInfo = hasRegionPickingTrigger(sceneObjects);

  const hasPlane = (triggerInfo.extrudeObj as any)?.object?.pickPlane || triggerInfo.sketchObj?.object?.plane;
  if (!triggerInfo.hasTrigger || !triggerInfo.extrudeObj?.sourceLocation || !hasPlane) {
    resetRegionPickMode();
    return;
  }

  lastRegionPickInfo = { extrudeObj: triggerInfo.extrudeObj, sketchObj: triggerInfo.sketchObj };
  const hasPicking = (triggerInfo.extrudeObj as any).object?.picking;

  if (regionPickState === 'picking-active') {
    // Already actively picking — activate/keep the interactive handler if meta shapes exist
    if (hasPicking) {
      const srcLine = lastRegionPickInfo.extrudeObj.sourceLocation.line;
      if (activeRegionPickMode && activeRegionPickSourceLine === srcLine) {
        return; // Same source line, no change needed
      }
      activateRegionPickModeInteractive(lastRegionPickInfo);
    }
    // If not picking yet, the add-pick request is still in flight — wait for next render
    return;
  }

  // Show the wand icon — user must click it to enter picking mode
  regionPickState = 'icon-visible';
  regionPickTriggerBtn.classList.remove('hidden');
  regionPickActiveBar.classList.add('hidden');
}

// Wire up click handlers
regionPickTriggerBtn.querySelector('button')!.addEventListener('click', () => {
  enterRegionPickMode();
});

regionPickActiveBar.querySelector('#exit-region-pick')!.addEventListener('click', () => {
  exitRegionPickMode();
});

// ---------------------------------------------------------------------------
// Interactive bezier drawing mode
// ---------------------------------------------------------------------------

const bezierIndicator = document.createElement('div');
bezierIndicator.id = 'fluidcad-bezier-indicator';
bezierIndicator.className = 'absolute top-4 left-1/2 -translate-x-1/2 z-[999] pointer-events-auto hidden';
bezierIndicator.innerHTML = `
  <div class="flex items-center gap-3 panel-bg border border-base-content/10 rounded-lg px-6 py-3 text-base-content/70 text-sm leading-none select-none">
    <span>Bezier Drawing Mode</span>
    <div class="h-4 w-px bg-base-content/10"></div>
    <label class="flex items-center gap-1.5 cursor-pointer">
      <input type="checkbox" class="checkbox checkbox-xs checkbox-primary" data-snap="vertex" checked />
      <span class="text-xs">Vertices</span>
    </label>
    <label class="flex items-center gap-1.5 cursor-pointer">
      <input type="checkbox" class="checkbox checkbox-xs checkbox-primary" data-snap="grid" checked />
      <span class="text-xs">Grid</span>
    </label>
  </div>
`;
container.appendChild(bezierIndicator);

bezierIndicator.querySelector<HTMLInputElement>('[data-snap="vertex"]')!.addEventListener('change', (e) => {
  if (activeBezierDrawMode) {
    activeBezierDrawMode.snapController.snapToVertices = (e.target as HTMLInputElement).checked;
  }
});
bezierIndicator.querySelector<HTMLInputElement>('[data-snap="grid"]')!.addEventListener('change', (e) => {
  if (activeBezierDrawMode) {
    activeBezierDrawMode.snapController.snapToGrid = (e.target as HTMLInputElement).checked;
  }
});

let activeBezierDrawMode: BezierDrawMode | null = null;
let activeBezierSourceLine: number | null = null;

function isBezierDrawingScene(sceneObjects: SceneObjectRender[]): boolean {
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

/** Extract the bezier's existing poles (start + placed points) from the scene render data. */
function getBezierPoles(
  sceneObjects: SceneObjectRender[],
  sketchId: string,
): [number, number][] {
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

function updateBezierDrawMode(sceneObjects: SceneObjectRender[]) {
  let lastRoot: SceneObjectRender | null = null;
  for (let i = sceneObjects.length - 1; i >= 0; i--) {
    if (isTopLevel(sceneObjects[i], sceneObjects)) {
      lastRoot = sceneObjects[i];
      break;
    }
  }

  const sketchObj = lastRoot?.type === 'sketch' ? lastRoot : null;

  if (!sketchObj || !sketchObj.id || !sketchObj.object?.plane) {
    deactivateBezierDrawMode();
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
    deactivateBezierDrawMode();
    return;
  }

  const srcLine = lastChild.sourceLocation.line;
  const plane: PlaneData = sketchObj.object.plane;
  const existingPoles = getBezierPoles(sceneObjects, sketchObj.id);
  const snapManager = SnapManager.fromSceneObjects(sceneObjects, sketchObj.id, plane);

  // Already in draw mode for this same bezier call — update poles and snap manager
  if (activeBezierDrawMode && activeBezierSourceLine === srcLine) {
    activeBezierDrawMode.updateExistingPoles(existingPoles);
    activeBezierDrawMode.snapController.updateSnapManager(snapManager);
    return;
  }

  deactivateBezierDrawMode();

  const sourceLocation = lastChild.sourceLocation;
  const snapController = new SnapController(snapManager, plane);

  // Sync checkbox state to new controller
  const vertexCb = bezierIndicator.querySelector<HTMLInputElement>('[data-snap="vertex"]');
  const gridCb = bezierIndicator.querySelector<HTMLInputElement>('[data-snap="grid"]');
  if (vertexCb) {
    snapController.snapToVertices = vertexCb.checked;
  }
  if (gridCb) {
    snapController.snapToGrid = gridCb.checked;
  }

  activeBezierDrawMode = new BezierDrawMode(
    viewer.sceneContext,
    plane,
    snapController,
    existingPoles,
    (point2d) => {
      fetch('/api/insert-point', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ point: point2d, sourceLocation }),
      });
    },
    (points) => {
      fetch('/api/set-pick-points', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ points, sourceLocation }),
      });
    },
  );
  activeBezierSourceLine = srcLine;
  activeBezierDrawMode.activate();
  bezierIndicator.classList.remove('hidden');
}

function deactivateBezierDrawMode() {
  if (activeBezierDrawMode) {
    activeBezierDrawMode.deactivate();
    activeBezierDrawMode = null;
    activeBezierSourceLine = null;
  }
  bezierIndicator.classList.add('hidden');
}

// ---------------------------------------------------------------------------
// Import file button
// ---------------------------------------------------------------------------

const importBtn = document.createElement('div');
importBtn.className = 'absolute bottom-6 left-6 z-[100]';
importBtn.innerHTML = `
  <button class="btn btn-ghost btn-square btn-sm text-base-content/60" title="Import File">
    <span class="[&>svg]:size-5">${ICON_FILE_IMPORT}</span>
  </button>
`;
container.appendChild(importBtn);

const importToast = document.createElement('div');
importToast.className = 'absolute bottom-16 left-6 z-[100] panel-bg border border-base-content/10 rounded-lg px-4 py-3 text-sm text-base-content/80 hidden';
container.appendChild(importToast);

let importToastTimer: ReturnType<typeof setTimeout> | null = null;

function showImportToast(message: string, loadCmd?: string) {
  if (loadCmd) {
    importToast.innerHTML = `
      <div class="flex items-center gap-2">
        <span>${message} <code class="bg-base-content/10 px-1.5 py-0.5 rounded text-base-content/90">${loadCmd}</code></span>
        <button class="btn btn-ghost btn-square btn-xs text-base-content/60 import-toast-copy" title="Copy">
          <span class="[&>svg]:size-3.5">${ICON_COPY}</span>
        </button>
      </div>
    `;
    importToast.querySelector('.import-toast-copy')!.addEventListener('click', () => {
      navigator.clipboard.writeText(loadCmd);
      const btn = importToast.querySelector('.import-toast-copy')!;
      btn.setAttribute('title', 'Copied!');
      setTimeout(() => btn.setAttribute('title', 'Copy'), 1500);
    });
  } else {
    importToast.textContent = message;
  }
  importToast.classList.remove('hidden');
  if (importToastTimer) {
    clearTimeout(importToastTimer);
  }
  importToastTimer = setTimeout(() => {
    importToast.classList.add('hidden');
    importToastTimer = null;
  }, 6000);
}

const fileInput = document.createElement('input');
fileInput.type = 'file';
fileInput.accept = '.step,.stp';
fileInput.style.display = 'none';
container.appendChild(fileInput);

importBtn.querySelector('button')!.addEventListener('click', () => {
  fileInput.click();
});

fileInput.addEventListener('change', async () => {
  const file = fileInput.files?.[0];
  if (!file) {
    return;
  }
  fileInput.value = '';

  showLoading('Importing file...');

  try {
    const arrayBuffer = await file.arrayBuffer();
    const bytes = new Uint8Array(arrayBuffer);
    let binary = '';
    for (let i = 0; i < bytes.length; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    const base64 = btoa(binary);

    const res = await fetch('/api/import-file', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fileName: file.name, data: base64 }),
    });

    const result = await res.json();
    if (!res.ok || !result.success) {
      showImportToast(`Import failed: ${result.error || 'Unknown error'}`);
    } else {
      showImportToast('Imported! Use:', `load('${result.fileName}')`);
    }
  } catch (err) {
    showImportToast('Import failed: network error');
  } finally {
    hideLoading();
  }
});

async function handleScreenshotRequest(ws: WebSocket, requestId: string, options: any) {
  try {
    const blob = await captureScreenshot(viewer.sceneContext, options);
    const buffer = await blob.arrayBuffer();
    const bytes = new Uint8Array(buffer);
    let binary = '';
    for (let i = 0; i < bytes.length; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    ws.send(JSON.stringify({
      type: 'screenshot-result',
      requestId,
      success: true,
      data: btoa(binary),
    }));
  } catch (err: any) {
    ws.send(JSON.stringify({
      type: 'screenshot-result',
      requestId,
      success: false,
      error: err.message || String(err),
    }));
  }
}

function connectWebSocket() {
  const wsUrl = `ws://${window.location.host}`;
  const ws = new WebSocket(wsUrl);

  ws.addEventListener('message', (event) => {
    const msg = JSON.parse(event.data);

    switch (msg.type) {
      case 'init-complete':
        showLoading('Loading model...');
        break;
      case 'processing-file':
        showLoading('Loading model...');
        break;
      case 'scene-rendered': {
        hideLoading();
        const isRollback = msg.rollbackStop != null && msg.rollbackStop < msg.result.length - 1;
        viewer.isTrimming = isTrimmingScene(msg.result);
        viewer.isBezierDrawing = isBezierDrawingScene(msg.result);
        viewer.updateView(msg.result, isRollback);
        if (msg.absPath) {
          viewer.setFileName(msg.absPath);
        }
        updatePointPickMode(msg.result);
        updateRegionPickMode(msg.result);
        updateBezierDrawMode(msg.result);
        timelinePanel.update(msg.result, msg.rollbackStop ?? msg.result.length - 1, msg.absPath);
        break;
      }
      case 'highlight-shape':
        viewer.highlightShape(msg.shapeId);
        shapePropertiesModal.setSelectedShape(msg.shapeId);
        break;
      case 'clear-highlight':
        viewer.clearHighlight();
        shapePropertiesModal.setSelectedShape(null);
        selectionInfoOverlay.hide();
        break;
      case 'show-shape-properties':
        viewer.clearHighlight();
        selectionInfoOverlay.hide();
        shapePropertiesModal.show(msg.shapeId);
        break;
      case 'take-screenshot':
        handleScreenshotRequest(ws, msg.requestId, msg.options);
        break;
    }
  });

  ws.addEventListener('close', () => {
    setTimeout(connectWebSocket, 1000);
  });
}

connectWebSocket();
