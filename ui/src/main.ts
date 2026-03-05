import { Viewer } from './viewer';
import { ShapePropertiesModal } from './ui/shape-properties-modal';
import { FaceInfoOverlay } from './ui/face-info-overlay';

const container = document.getElementById('fluidcad-viewer') || document.body;
const viewer = new Viewer('fluidcad-viewer');
const shapePropertiesModal = new ShapePropertiesModal(container);
const faceInfoOverlay = new FaceInfoOverlay(container);

shapePropertiesModal.setCentroidHandler((centroid) => {
  if (centroid) {
    viewer.showCentroid(centroid);
  } else {
    viewer.clearCentroid();
  }
});

viewer.setSelectionHandler((shapeId, faceIndex) => {
  if (shapeId) {
    if (shapePropertiesModal.isOpen || faceIndex === null) {
      viewer.highlightShape(shapeId);
    } else {
      viewer.highlightFace(shapeId, faceIndex);
    }
  } else {
    viewer.clearHighlight();
  }
  shapePropertiesModal.setSelectedShape(shapeId);
  if (shapeId !== null && faceIndex !== null) {
    faceInfoOverlay.showForFace(shapeId, faceIndex);
  } else {
    faceInfoOverlay.hide();
  }
});

function connectWebSocket() {
  const wsUrl = `ws://${window.location.host}`;
  const ws = new WebSocket(wsUrl);

  ws.addEventListener('message', (event) => {
    const msg = JSON.parse(event.data);

    switch (msg.type) {
      case 'scene-rendered': {
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
        faceInfoOverlay.hide();
        break;
      case 'show-shape-properties':
        shapePropertiesModal.show(msg.shapeId);
        break;
    }
  });

  ws.addEventListener('close', () => {
    setTimeout(connectWebSocket, 1000);
  });
}

connectWebSocket();
