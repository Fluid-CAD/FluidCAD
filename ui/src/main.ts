import { Viewer } from './viewer';
import { ShapePropertiesModal } from './ui/shape-properties-modal';
import { SelectionInfoOverlay } from './ui/selection-info-overlay';
import { PointPickMode, HighlightInfo } from './interactive/point-pick-mode';
import { Mesh, Object3D } from 'three';
import { SnapManager } from './snapping/snap-manager';
import { SceneObjectRender, PlaneData } from './types';

const container = document.getElementById('fluidcad-viewer') || document.body;

// ---------------------------------------------------------------------------
// Loading overlay — shown until the server kernel finishes initializing
// ---------------------------------------------------------------------------

const loadingOverlay = document.createElement('div');
loadingOverlay.id = 'fluidcad-loading';
loadingOverlay.innerHTML = `
  <style>
    #fluidcad-loading {
      position: absolute;
      top: 16px;
      left: 50%;
      transform: translateX(-50%);
      z-index: 1000;
      pointer-events: none;
    }
    #fluidcad-loading .loading-pill {
      background: rgba(30, 30, 30, 0.85);
      backdrop-filter: blur(12px);
      -webkit-backdrop-filter: blur(12px);
      border-radius: 8px;
      padding: 12px 24px;
      display: flex;
      align-items: center;
      gap: 12px;
      color: #bbb;
      font: 13px/1 -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      user-select: none;
    }
    #fluidcad-loading .spinner {
      width: 16px;
      height: 16px;
      border: 2px solid rgba(255,255,255,0.15);
      border-top-color: #888;
      border-radius: 50%;
      animation: fc-spin 0.8s linear infinite;
    }
    @keyframes fc-spin {
      to { transform: rotate(360deg); }
    }
    #fluidcad-loading.hidden {
      display: none;
    }
  </style>
  <div class="loading-pill">
    <div class="spinner"></div>
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
trimIndicator.innerHTML = `
  <style>
    #fluidcad-trim-indicator {
      position: absolute;
      top: 16px;
      left: 50%;
      transform: translateX(-50%);
      z-index: 999;
      pointer-events: none;
      display: none;
    }
    #fluidcad-trim-indicator .trim-pill {
      background: rgba(30, 30, 30, 0.85);
      backdrop-filter: blur(12px);
      -webkit-backdrop-filter: blur(12px);
      border-radius: 8px;
      padding: 12px 24px;
      display: flex;
      align-items: center;
      gap: 12px;
      color: #bbb;
      font: 13px/1 -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      user-select: none;
    }
    #fluidcad-trim-indicator .trim-icon {
      font-size: 16px;
      line-height: 1;
    }
  </style>
  <div class="trim-pill">
    <span class="trim-icon">&#9986;</span>
    <span>Trimming Mode</span>
  </div>
`;
container.appendChild(trimIndicator);

let activePointPickMode: PointPickMode | null = null;
let activePickSourceLine: number | null = null;

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

  // Already in pick mode for this same trim call — keep it active
  if (activePointPickMode && activePickSourceLine === srcLine) {
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
  trimIndicator.style.display = 'block';
}

function deactivatePickMode() {
  if (activePointPickMode) {
    activePointPickMode.deactivate();
    activePointPickMode = null;
    activePickSourceLine = null;
  }
  clearVertexHighlights();
  trimIndicator.style.display = 'none';
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
        viewer.toggleSketchMode(true);
        viewer.updateView(msg.result, isRollback);
        if (msg.absPath) {
          viewer.setFileName(msg.absPath);
        }
        updatePointPickMode(msg.result);
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
