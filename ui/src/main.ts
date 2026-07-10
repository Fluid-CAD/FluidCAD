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
import { TopBar } from './ui/top-bar';
import { Navbar } from './ui/navbar';
import { ICON_FILE_IMPORT } from './ui/icons';
import { TrimPickService } from './interactive/trim-pick-service';
import { RegionPickService } from './interactive/region-pick-service';
import { SketchToolbarService } from './interactive/sketch-toolbar-service';
import { ModifyPickService } from './interactive/modify-pick-service';
import { ExtrudeFeatureService } from './interactive/create-feature/extrude-service';
import { SweepFeatureService } from './interactive/create-feature/sweep-service';
import { LoftFeatureService } from './interactive/create-feature/loft-service';
import { MeasureController } from './ui/measure/measure-controller';
import { captureScreenshot, captureScreenshotMulti } from './screenshot';
import { onThemeChange } from './scene/theme-colors';
import { loadPreferences, gotoSource, parseFeatureAt } from './api';
import type { SceneObjectRender } from './types';
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
    measureController.applyPreferences(prefs);
  }
});

// ---------------------------------------------------------------------------
// UI components
// ---------------------------------------------------------------------------

const shapePropertiesModal = new ShapePropertiesModal(container);
const selectionInfoOverlay = new SelectionInfoOverlay(container);
const measureController = new MeasureController(container, viewer);
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
);

// Top application bar (logo, feature-tree toggle, file name) and the secondary
// tool bar below it (host for conditionally-visible tool groups).
const topBar = new TopBar(container, {
  onToggleTree: () => timelinePanel.togglePanel(),
});
const navbar = new Navbar(container);

// Import group — always visible for now.
const importGroup = navbar.addGroup('import');
const importBtn = document.createElement('button');
importBtn.className = 'btn btn-ghost btn-sm gap-1.5 text-base-content/70 hover:text-base-content';
importBtn.title = 'Import file';
importBtn.innerHTML = `<span class="[&>svg]:size-4">${ICON_FILE_IMPORT}</span><span class="text-sm font-normal">Import</span>`;
importBtn.addEventListener('click', () => fileImporter.openPicker());
importGroup.appendChild(importBtn);

const paramsPanel = new ParamsPanel(viewer.settingsPanelHost);

viewer.setParamsToggleHandler(() => {
  paramsPanel.toggle();
  viewer.setParamsButtonActive(paramsPanel.isVisible);
});

const trimService = new TrimPickService(viewer, navbar);
const regionService = new RegionPickService(viewer, navbar);
// Registered before the sketch toolbar so the create group renders ahead of
// the sketch tools; its `immune` flag keeps it visible in sketch mode, where
// extruding the active sketch is the primary flow.
const extrudeService = new ExtrudeFeatureService(container, viewer, navbar, {
  onEnter: () => {
    modifyService.exit();
    sweepService.exit();
    loftService.exit();
    measureController.clearSelection();
    viewer.clearHighlight();
    selectionInfoOverlay.hide();
  },
});
const sweepService = new SweepFeatureService(container, viewer, navbar, {
  onEnter: () => {
    modifyService.exit();
    extrudeService.exit();
    loftService.exit();
    measureController.clearSelection();
    viewer.clearHighlight();
    selectionInfoOverlay.hide();
  },
  onSuspendSketchUI: () => sketchService.update([]),
  onResumeSketchUI: () => sketchService.update(viewer.currentSceneObjects),
});
const loftService = new LoftFeatureService(container, viewer, navbar, {
  onEnter: () => {
    modifyService.exit();
    extrudeService.exit();
    sweepService.exit();
    measureController.clearSelection();
    viewer.clearHighlight();
    selectionInfoOverlay.hide();
  },
  onSuspendSketchUI: () => sketchService.update([]),
  onResumeSketchUI: () => sketchService.update(viewer.currentSceneObjects),
});
// An armed create dialog takes sketch rows clicked in the timeline as its
// profile/path instead of the default rollback-preview.
timelinePanel.onFeatureIntercept = (obj) =>
  extrudeService.handleTimelinePick(obj) || sweepService.handleTimelinePick(obj)
  || loftService.handleTimelinePick(obj);
// Double-clicking an editable feature row (the enter-breakpoint gesture)
// also opens that feature's dialog prefilled from its statement.
timelinePanel.onFeatureEdit = (obj) => {
  void openFeatureEditor(obj);
};

/** Timeline `type` → the dialog that edits it (cut is extrude's remove op). */
const EDITABLE_ROW_TYPES = new Set(['extrude', 'cut', 'sweep', 'loft', 'shell', 'fillet', 'chamfer']);

/**
 * Parse the double-clicked row's statement and open the matching dialog in
 * edit mode. Statements the dialogs can't faithfully represent (variable
 * dimensions, unrecognized chains) surface the parse refusal as a toast and
 * leave the plain breakpoint behavior in place.
 */
async function openFeatureEditor(obj: SceneObjectRender): Promise<void> {
  if (!obj.type || !EDITABLE_ROW_TYPES.has(obj.type) || !obj.sourceLocation) {
    return;
  }
  const target = obj.sourceLocation;
  const result = await parseFeatureAt(target);
  if (result.ok === false) {
    showEditRefusal(result.reason);
    return;
  }
  const parsed = result.parsed;
  if (parsed.feature === 'extrude') {
    extrudeService.enterEdit(target, parsed);
  } else if (parsed.feature === 'sweep') {
    sweepService.enterEdit(target, parsed);
  } else if (parsed.feature === 'loft') {
    loftService.enterEdit(target, parsed);
  } else {
    modifyService.enterEdit(target, parsed);
  }
}

// Transient toast for edit-dialog refusals — there is no dialog to carry the
// message yet when the double-clicked statement can't be edited.
let editRefusalToast: HTMLDivElement | null = null;
let editRefusalTimer: number | null = null;

function showEditRefusal(reason: string): void {
  if (!editRefusalToast) {
    editRefusalToast = document.createElement('div');
    editRefusalToast.className = 'absolute top-[116px] left-1/2 -translate-x-1/2 z-[1003] max-w-[440px] '
      + 'bg-base-100 border border-base-300 text-base-content rounded-lg px-3 py-2 text-xs leading-snug shadow-md';
    container.appendChild(editRefusalToast);
  }
  editRefusalToast.textContent = `Can't edit this feature in a dialog: ${reason}`;
  editRefusalToast.classList.remove('hidden');
  if (editRefusalTimer !== null) {
    window.clearTimeout(editRefusalTimer);
  }
  editRefusalTimer = window.setTimeout(() => {
    editRefusalTimer = null;
    editRefusalToast?.classList.add('hidden');
  }, 5000);
}
const sketchService = new SketchToolbarService(container, viewer, trimService, navbar);
const modifyService = new ModifyPickService(container, viewer, navbar, {
  // Hand the current highlight over as the tool's initial input: whatever the
  // user already clicked (measure owns that selection) seeds the pick set.
  onEnter: () => {
    extrudeService.exit();
    sweepService.exit();
    loftService.exit();
    const seed = [...measureController.selection];
    measureController.clearSelection();
    selectionInfoOverlay.hide();
    return seed;
  },
  // Sketch-on-face armed from inside a sketch: the sketch toolbar and tools
  // release input while faces are picked, and return if the pick is cancelled.
  onSuspendSketchUI: () => sketchService.update([]),
  onResumeSketchUI: () => sketchService.update(viewer.currentSceneObjects),
});

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
  measureController.clearSelection();
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

// An armed modify mode (fillet/chamfer) owns hover (teach-mode tooltip) and
// right-click (tangent-chain selection).
viewer.setHoverHandler((shapeId, sub, clientX, clientY) => {
  if (modifyService.isActive) {
    modifyService.handleHover(shapeId, sub, clientX, clientY);
  }
});

viewer.setContextMenuHandler((shapeId, sub, clientX, clientY) => {
  if (modifyService.isActive) {
    modifyService.handleContextMenu(shapeId, sub, clientX, clientY);
  } else if (sweepService.isEdgePicking) {
    sweepService.handleContextMenu(shapeId, sub, clientX, clientY);
  }
});

viewer.setDoubleClickHandler((shapeId, sub) => {
  if (modifyService.isActive) {
    modifyService.handleDoubleClick(shapeId, sub);
  } else if (sweepService.isEdgePicking) {
    sweepService.handleDoubleClick(shapeId, sub);
  }
});

viewer.setSelectionHandler((shapeId, sub, modifiers) => {
  // A sketch-wire pick exists only while a create dialog is armed (the
  // dialogs enable viewer.pickSketchWires) — it selects that sketch as the
  // dialog's input and never reaches the measure selection.
  if (sub?.type === 'sketch') {
    if (shapeId) {
      const consumed = extrudeService.handleSketchPick(shapeId)
        || sweepService.handleSketchPick(shapeId)
        || loftService.handleSketchPick(shapeId);
      if (consumed) {
        return;
      }
    }
    return;
  }
  // An armed modify mode (fillet/chamfer) owns clicks outright.
  if (modifyService.isActive) {
    modifyService.handleClick(shapeId, sub);
    return;
  }
  // The sweep dialog's live path picking owns edge clicks the same way.
  if (sweepService.isEdgePicking) {
    sweepService.handleClick(shapeId, sub);
    return;
  }
  // The armed loft dialog owns face clicks — each pick is one profile.
  if (loftService.isFacePicking) {
    loftService.handleClick(shapeId, sub);
    return;
  }

  if (shapePropertiesModal.isOpen) {
    measureController.clearSelection();
    if (shapeId) {
      viewer.highlightShape(shapeId);
    } else {
      viewer.clearHighlight();
    }
    shapePropertiesModal.setSelectedShape(shapeId);
    selectionInfoOverlay.hide();
    return;
  }

  // The measure controller owns the selection set (plain click replaces,
  // ctrl/shift-click accumulates) and the matching viewer highlights.
  const selection = measureController.handleClick(shapeId, sub, modifiers.additive);
  if (selection.length === 1) {
    const entity = selection[0];
    shapePropertiesModal.setSelectedShape(entity.shapeId);
    if (entity.sub.type === 'face') {
      selectionInfoOverlay.showForFace(entity.shapeId, entity.sub.index);
    } else {
      selectionInfoOverlay.showForEdge(entity.shapeId, entity.sub.index);
    }
  } else {
    shapePropertiesModal.setSelectedShape(selection.length > 0 ? selection[0].shapeId : null);
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
        measureController.onSceneRendered();
        if (msg.absPath) {
          topBar.setFileName(msg.absPath);
        }
        if (isRollback) {
          trimService.reset();
          regionService.reset();
          sketchService.update([]);
          modifyService.update([]);
          extrudeService.update([]);
          sweepService.update([]);
          loftService.update([]);
        } else {
          trimService.update(msg.result);
          regionService.update(msg.result);
          // While a pick mode has sketch editing suspended, the sketch
          // toolbar must not re-take the bar on incoming renders.
          const sketchSuspended = modifyService.sketchUISuspended
            || sweepService.sketchUISuspended || loftService.sketchUISuspended;
          sketchService.update(sketchSuspended ? [] : msg.result);
          modifyService.update(msg.result);
          extrudeService.update(msg.result);
          sweepService.update(msg.result);
          loftService.update(msg.result);
        }
        timelinePanel.update(msg.result, msg.rollbackStop ?? msg.result.length - 1);
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
        measureController.clearSelection();
        viewer.highlightShape(msg.shapeId);
        shapePropertiesModal.setSelectedShape(msg.shapeId);
        break;
      case 'clear-highlight':
        measureController.clearSelection();
        viewer.clearHighlight();
        shapePropertiesModal.setSelectedShape(null);
        selectionInfoOverlay.hide();
        break;
      case 'show-shape-properties':
        measureController.clearSelection();
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
