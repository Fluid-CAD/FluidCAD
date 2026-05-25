import { Viewer } from './viewer';
import { ShapePropertiesModal } from './ui/shape-properties-modal';
import { SelectionInfoOverlay } from './ui/selection-info-overlay';
import { TimelinePanel } from './ui/timeline-panel';
import { ParamsPanel } from './ui/params-panel';
import { ExportDialog } from './ui/export-dialog';
import { BreakpointIndicator } from './ui/breakpoint-indicator';
import { ErrorBanner } from './ui/error-banner';
import { LoadingOverlay } from './ui/loading-overlay';
import { FileImporter } from './ui/file-importer';
import { TrimPickService } from './interactive/trim-pick-service';
import { RegionPickService } from './interactive/region-pick-service';
import { SketchToolbarService } from './interactive/sketch-toolbar-service';
import { captureScreenshot, captureScreenshotMulti } from './screenshot';
import { onThemeChange } from './scene/theme-colors';
import { loadPreferences, gotoSource } from './api';
import { applyPreferences } from './scene/viewer-settings';
import { installVSCodeKeyboardBridge } from './keyboard-bridge';

installVSCodeKeyboardBridge();

const container = document.getElementById('fluidcad-viewer') || document.body;

const loadingOverlay = new LoadingOverlay(container);
const viewer = new Viewer('fluidcad-viewer');

onThemeChange(() => viewer.rebuildSceneMesh());

loadPreferences().then((prefs) => {
  if (prefs) {
    document.documentElement.setAttribute('data-theme', prefs.theme);
    applyPreferences(prefs);
    timelinePanel.setShowBuildTimings(!!prefs.showBuildTimings);
  }
});

// ---------------------------------------------------------------------------
// UI components
// ---------------------------------------------------------------------------

const shapePropertiesModal = new ShapePropertiesModal(container);
const selectionInfoOverlay = new SelectionInfoOverlay(container);
const exportDialog = new ExportDialog(container, viewer.sceneContext);

const fileImporter = new FileImporter(container, {
  showLoading: (text) => loadingOverlay.show(text),
  hideLoading: () => loadingOverlay.hide(),
});

const timelinePanel = new TimelinePanel(
  container,
  (shapeId) => viewer.highlightShape(shapeId),
  (shapeIds) => exportDialog.show(shapeIds),
  (shapeId, visible) => viewer.setShapeVisibility(shapeId, visible),
  (shapeId) => viewer.isShapeHidden(shapeId),
  (shapeId, opacity) => viewer.setShapeTransparency(shapeId, opacity),
  (shapeId) => viewer.getShapeTransparency(shapeId),
  () => viewer.resetAllTransparency(),
  () => fileImporter.openPicker(),
);

const paramsPanel = new ParamsPanel(viewer.settingsPanelHost);

viewer.setParamsToggleHandler(() => {
  paramsPanel.toggle();
  viewer.setParamsButtonActive(paramsPanel.isVisible);
});

const trimService = new TrimPickService(container, viewer);
const regionService = new RegionPickService(container, viewer);
const sketchService = new SketchToolbarService(container, viewer, trimService, timelinePanel);

const breakpointIndicator = new BreakpointIndicator(container, () => {
  if (regionService.state === 'picking-active') {
    regionService.exit();
  }
  if (trimService.state === 'picking-active') {
    trimService.exit();
  }
});
const errorBanner = new ErrorBanner(container, (loc) => {
  gotoSource(loc);
});

// ---------------------------------------------------------------------------
// Selection handling
// ---------------------------------------------------------------------------

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
// Screenshot handling
// ---------------------------------------------------------------------------

async function handleScreenshotRequest(ws: WebSocket, requestId: string, options: any) {
  try {
    const opts = { ...(options || {}) };
    const multi = !!opts.multi;
    delete opts.multi;
    const blob = multi
      ? await captureScreenshotMulti(viewer.sceneContext, opts)
      : await captureScreenshot(viewer.sceneContext, opts);

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

// ---------------------------------------------------------------------------
// WebSocket connection
// ---------------------------------------------------------------------------

// Push camera state to the server at most ~5 Hz so /api/camera/state and the
// MCP `get_camera_state` tool can answer without a round-trip through the UI.
const CAMERA_STATE_INTERVAL_MS = 200;
let lastCameraStatePush = 0;
let cameraStatePending = false;
let activeWs: WebSocket | null = null;

function pushCameraState(): void {
  if (!activeWs || activeWs.readyState !== WebSocket.OPEN) {
    return;
  }
  const ctx = viewer.sceneContext;
  const cam: any = ctx.camera;
  const tgt = { x: 0, y: 0, z: 0 };
  ctx.cameraControls.getTarget(tgt as any);
  activeWs.send(JSON.stringify({
    type: 'camera-state',
    position: [cam.position.x, cam.position.y, cam.position.z],
    target: [tgt.x, tgt.y, tgt.z],
    up: [cam.up.x, cam.up.y, cam.up.z],
    projection: cam.isOrthographicCamera ? 'orthographic' : 'perspective',
  }));
}

function scheduleCameraStatePush(): void {
  const now = Date.now();
  if (now - lastCameraStatePush >= CAMERA_STATE_INTERVAL_MS) {
    lastCameraStatePush = now;
    pushCameraState();
    return;
  }
  if (cameraStatePending) {
    return;
  }
  cameraStatePending = true;
  const wait = CAMERA_STATE_INTERVAL_MS - (now - lastCameraStatePush);
  setTimeout(() => {
    cameraStatePending = false;
    lastCameraStatePush = Date.now();
    pushCameraState();
  }, Math.max(0, wait));
}

viewer.sceneContext.cameraControls.addEventListener('update', scheduleCameraStatePush);

function connectWebSocket() {
  const wsUrl = `ws://${window.location.host}`;
  const ws = new WebSocket(wsUrl);

  ws.addEventListener('open', () => {
    activeWs = ws;
    pushCameraState();
  });

  ws.addEventListener('message', (event) => {
    const msg = JSON.parse(event.data);

    switch (msg.type) {
      case 'init-complete':
        loadingOverlay.show('Loading model...');
        break;
      case 'processing-file':
        loadingOverlay.show('Loading model...');
        break;
      case 'scene-rendered': {
        loadingOverlay.hide();
        const isRollback = msg.rollbackStop != null && msg.rollbackStop < msg.result.length - 1;
        viewer.isTrimming = !isRollback && trimService.state === 'picking-active';
        viewer.isDrawing = !isRollback && sketchService.hasActiveDrawingTool;
        viewer.updateView(msg.result, isRollback, msg.rollbackStop);
        if (msg.absPath) {
          viewer.setFileName(msg.absPath);
        }
        if (isRollback) {
          trimService.reset();
          regionService.reset();
          sketchService.update([]);
        } else {
          trimService.update(msg.result);
          regionService.update(msg.result);
          sketchService.update(msg.result);
        }
        timelinePanel.update(msg.result, msg.rollbackStop ?? msg.result.length - 1, msg.absPath);
        if (msg.params !== undefined) {
          paramsPanel.update(msg.params);
          viewer.setParamsButtonVisible(paramsPanel.hasAnyParams);
        }
        errorBanner.update(msg.result, msg.compileError ?? null);
        // Only update the breakpoint indicator when the server sends an
        // authoritative value — rollback responses don't re-run the module,
        // so they omit the flag and the last known state should persist.
        if (msg.breakpointHit !== undefined) {
          breakpointIndicator.setActive(msg.breakpointHit);
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
      case 'take-screenshot':
        handleScreenshotRequest(ws, msg.requestId, msg.options);
        break;
    }
  });

  ws.addEventListener('close', () => {
    if (activeWs === ws) {
      activeWs = null;
    }
    errorBanner.update([], null);
    setTimeout(connectWebSocket, 1000);
  });
}

connectWebSocket();
