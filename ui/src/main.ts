import { Viewer } from './viewer';
import { ShapePropertiesModal } from './ui/shape-properties-modal';
import { SelectionInfoOverlay } from './ui/selection-info-overlay';
import { TimelinePanel } from './ui/timeline-panel';
import { ExportDialog } from './ui/export-dialog';
import { ICON_SCISSORS, ICON_FILE_IMPORT, ICON_COPY } from './ui/icons';
import { PointPickMode, HighlightInfo } from './interactive/point-pick-mode';
import { RegionPickMode } from './interactive/region-pick-mode';
import { Mesh, Object3D } from 'three';
import { SnapManager } from './snapping/snap-manager';
import { SceneObjectRender, PlaneData } from './types';

const container = document.getElementById('fluidcad-viewer') || document.body;

// ---------------------------------------------------------------------------
// Loading overlay — shown until the server kernel finishes initializing
// ---------------------------------------------------------------------------

const loadingOverlay = document.createElement('div');
loadingOverlay.id = 'fluidcad-loading';
loadingOverlay.className = 'absolute top-4 left-1/2 -translate-x-1/2 z-[1000] pointer-events-none';
loadingOverlay.innerHTML = `
  <div class="flex items-center gap-3 glass-dark border border-white/10 rounded-lg px-6 py-3 text-base-content/70 text-sm leading-none select-none">
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
const shapePropertiesModal = new ShapePropertiesModal(container);
const selectionInfoOverlay = new SelectionInfoOverlay(container);
const exportDialog = new ExportDialog(container);
const timelinePanel = new TimelinePanel(container, (shapeId) => {
  viewer.highlightShape(shapeId);
}, (shapeIds) => {
  exportDialog.show(shapeIds);
});

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
  <div class="flex items-center gap-3 glass-dark border border-white/10 rounded-lg px-6 py-3 text-base-content/70 text-sm leading-none select-none">
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
    if (!sceneObjects[i].parentId) {
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
  // Only activate pick mode if the last root-level object is a sketch
  // (i.e., the sketch is still the active/open feature)
  let lastRoot: SceneObjectRender | null = null;
  for (let i = sceneObjects.length - 1; i >= 0; i--) {
    if (!sceneObjects[i].parentId) {
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

const regionPickIndicator = document.createElement('div');
regionPickIndicator.id = 'fluidcad-region-pick-indicator';
regionPickIndicator.className = 'absolute top-4 left-1/2 -translate-x-1/2 z-[999] pointer-events-none hidden';
regionPickIndicator.innerHTML = `
  <div class="flex items-center gap-3 glass-dark border border-white/10 rounded-lg px-6 py-3 text-base-content/70 text-sm leading-none select-none">
    <span>Region Picking Mode</span>
  </div>
`;
container.appendChild(regionPickIndicator);

let activeRegionPickMode: RegionPickMode | null = null;
let activeRegionPickSourceLine: number | null = null;

function isRegionPickingScene(sceneObjects: SceneObjectRender[]): {
  active: boolean;
  extrudeObj?: SceneObjectRender & { sourceLocation?: any };
  sketchObj?: SceneObjectRender;
} {
  // Find the last root-level object
  for (let i = sceneObjects.length - 1; i >= 0; i--) {
    const obj = sceneObjects[i] as any;
    if (!obj.parentId && (obj.type === 'extrude' || obj.type === 'cut' || obj.type === 'cut-symmetric' || obj.type === 'revolve') && obj.object?.picking) {
      // Found an extrude/cut with picking=true. Find the sketch before it.
      let sketchObj: SceneObjectRender | undefined;
      for (let j = i - 1; j >= 0; j--) {
        if (!sceneObjects[j].parentId && sceneObjects[j].type === 'sketch') {
          sketchObj = sceneObjects[j];
          break;
        }
      }
      return { active: true, extrudeObj: obj, sketchObj };
    }
  }
  return { active: false };
}

function updateRegionPickMode(sceneObjects: SceneObjectRender[]) {
  const pickInfo = isRegionPickingScene(sceneObjects);

  if (!pickInfo.active || !pickInfo.extrudeObj?.sourceLocation || !pickInfo.sketchObj?.object?.plane) {
    deactivateRegionPickMode();
    return;
  }

  const srcLine = pickInfo.extrudeObj.sourceLocation.line;

  // Already in region pick mode for this same extrude call — just re-render
  if (activeRegionPickMode && activeRegionPickSourceLine === srcLine) {
    return;
  }

  // Activate new region pick mode
  deactivateRegionPickMode();

  const plane: PlaneData = pickInfo.sketchObj.object.plane;
  const sourceLocation = pickInfo.extrudeObj.sourceLocation;

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
  activeRegionPickSourceLine = srcLine;
  activeRegionPickMode.activate();
  regionPickIndicator.classList.remove('hidden');
}

function deactivateRegionPickMode() {
  if (activeRegionPickMode) {
    activeRegionPickMode.deactivate();
    activeRegionPickMode = null;
    activeRegionPickSourceLine = null;
  }
  regionPickIndicator.classList.add('hidden');
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
importToast.className = 'absolute bottom-16 left-6 z-[100] glass-dark border border-white/10 rounded-lg px-4 py-3 text-sm text-base-content/80 hidden';
container.appendChild(importToast);

let importToastTimer: ReturnType<typeof setTimeout> | null = null;

function showImportToast(message: string, loadCmd?: string) {
  if (loadCmd) {
    importToast.innerHTML = `
      <div class="flex items-center gap-2">
        <span>${message} <code class="bg-white/10 px-1.5 py-0.5 rounded text-base-content/90">${loadCmd}</code></span>
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
        const regionPicking = isRegionPickingScene(msg.result);
        viewer.isRegionPicking = regionPicking.active;
        viewer.toggleSketchMode(!regionPicking.active);
        viewer.updateView(msg.result, isRollback);
        if (msg.absPath) {
          viewer.setFileName(msg.absPath);
        }
        updatePointPickMode(msg.result);
        updateRegionPickMode(msg.result);
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
    }
  });

  ws.addEventListener('close', () => {
    setTimeout(connectWebSocket, 1000);
  });
}

connectWebSocket();
