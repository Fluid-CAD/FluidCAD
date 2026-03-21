import { Viewer } from './viewer';
import { ShapePropertiesModal } from './ui/shape-properties-modal';
import { SelectionInfoOverlay } from './ui/selection-info-overlay';

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
