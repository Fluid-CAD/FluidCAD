import { Viewer } from './viewer';
import { ShapePropertiesModal } from './ui/shape-properties-modal';
import { SelectionInfoOverlay } from './ui/selection-info-overlay';
import { TimelinePanel } from './ui/timeline-panel';
import { PartsPanel } from './ui/parts-panel';
import { JointsPanel } from './ui/joints-panel';
import { DofStatus } from './ui/dof-status';
import { ExportDialog } from './ui/export-dialog';
import { BreakpointIndicator } from './ui/breakpoint-indicator';
import { ErrorBanner } from './ui/error-banner';
import { LoadingOverlay } from './ui/loading-overlay';
import { FileImporter } from './ui/file-importer';
import { TrimPickService } from './interactive/trim-pick-service';
import { RegionPickService } from './interactive/region-pick-service';
import { SketchToolbarService } from './interactive/sketch-toolbar-service';
import { captureScreenshot, captureScreenshotMulti } from './screenshot';
import { RenderedInstance, SerializedAssembly } from './types';
import { onThemeChange } from './scene/theme-colors';
import { loadPreferences, gotoSource } from './api';
import { applyPreferences } from './scene/viewer-settings';
import { installVSCodeKeyboardBridge } from './keyboard-bridge';

installVSCodeKeyboardBridge();

const container = document.getElementById('fluidcad-viewer') || document.body;

let pendingShowBuildTimings = false;

const loadingOverlay = new LoadingOverlay(container);
const viewer = new Viewer('fluidcad-viewer');

onThemeChange(() => viewer.rebuildSceneMesh());

loadPreferences().then((prefs) => {
  if (prefs) {
    document.documentElement.setAttribute('data-theme', prefs.theme);
    applyPreferences(prefs);
    pendingShowBuildTimings = !!prefs.showBuildTimings;
    if (currentRail?.kind === 'part') {
      currentRail.timeline.setShowBuildTimings(pendingShowBuildTimings);
    }
  }
});

// ---------------------------------------------------------------------------
// UI components
// ---------------------------------------------------------------------------

const shapePropertiesModal = new ShapePropertiesModal(container);
const selectionInfoOverlay = new SelectionInfoOverlay(container);
const exportDialog = new ExportDialog(container, viewer.sceneContext);
// ---------------------------------------------------------------------------
// Left-rail abstraction. The same DOM container hosts either the part-design
// rail (TimelinePanel, History+Shapes) or the assembly rail
// (PartsPanel + JointsPanel + DofStatus). `ensureRailFor(kind)` swaps them
// when the current scene's `sceneKind` changes.
// ---------------------------------------------------------------------------

type LeftRail =
  | { kind: 'part'; timeline: TimelinePanel }
  | { kind: 'assembly'; parts: PartsPanel; joints: JointsPanel; dof: DofStatus; instanceVisibility: Map<string, boolean> };

let currentRail: LeftRail | null = null;

function disposeRail(): void {
  if (!currentRail) return;
  if (currentRail.kind === 'part') {
    currentRail.timeline.dispose();
  } else if (currentRail.kind === 'assembly') {
    currentRail.parts.dispose();
    currentRail.joints.dispose();
    currentRail.dof.hide();
  }
  currentRail = null;
}

function buildPartRail(): LeftRail {
  const timeline = new TimelinePanel(
    container,
    (shapeId) => viewer.highlightShape(shapeId),
    (shapeIds) => exportDialog.show(shapeIds),
    (shapeId, visible) => viewer.setShapeVisibility(shapeId, visible),
    (shapeId) => viewer.isShapeHidden(shapeId),
    (shapeId, opacity) => viewer.setShapeTransparency(shapeId, opacity),
    (shapeId) => viewer.getShapeTransparency(shapeId),
    () => viewer.resetAllTransparency(),
  );
  timeline.setShowBuildTimings(pendingShowBuildTimings);
  return { kind: 'part', timeline };
}

function buildAssemblyRail(): LeftRail {
  const visibility = new Map<string, boolean>();
  let joints!: JointsPanel;
  const parts = new PartsPanel(
    container,
    (id) => {
      joints.setSelected(null);
      viewer.highlightInstance(id);
    },
    (id, visible) => {
      visibility.set(id, visible);
      viewer.setInstanceVisibility(id, visible);
    },
    (id) => {
      const inst = findInstance(id);
      if (inst?.sourceLocation) {
        gotoSource(inst.sourceLocation);
      }
    },
    (id) => {
      const inst = findInstance(id);
      if (!inst?.sourceLocation) return;
      updateInsertChain(inst.sourceLocation, { ground: true });
    },
    (id, newName) => {
      const inst = findInstance(id);
      if (!inst?.sourceLocation) return;
      updateInsertChain(inst.sourceLocation, {
        name: newName,
        defaultName: defaultNameFor(inst),
      });
    },
    (_id) => {
      console.warn('Delete instance not implemented yet');
    },
  );
  joints = new JointsPanel(
    parts.getJointsHost(),
    (mateId) => {
      parts.setSelected(null);
      const mate = findMate(mateId);
      if (!mate) return;
      viewer.highlightMate(mate);
    },
    (id) => {
      const mate = findMate(id);
      if (mate?.sourceLocation) {
        gotoSource(mate.sourceLocation);
      }
    },
    (_id) => { /* phase 06+ */ },
    (_id) => { /* phase 06+ */ },
  );
  const dof = new DofStatus(container, (_mateId) => { /* phase 05+ */ });
  dof.show();
  return { kind: 'assembly', parts, joints, dof, instanceVisibility: visibility };
}

function ensureRailFor(kind: 'part' | 'assembly'): LeftRail {
  if (currentRail?.kind === kind) {
    return currentRail;
  }
  disposeRail();
  currentRail = kind === 'assembly' ? buildAssemblyRail() : buildPartRail();
  return currentRail;
}

let lastAssemblyPayload: SerializedAssembly | null = null;
let lastFailedMateIds = new Set<string>();

function findInstance(instanceId: string) {
  return lastAssemblyPayload?.instances.find(i => i.instanceId === instanceId);
}

function findMate(mateId: string) {
  return lastAssemblyPayload?.mates.find(m => m.mateId === mateId);
}

function instanceHasMate(instanceId: string): boolean {
  if (!lastAssemblyPayload) return false;
  for (const m of lastAssemblyPayload.mates) {
    if (m.connectorA.instanceId === instanceId || m.connectorB.instanceId === instanceId) {
      return true;
    }
  }
  return false;
}

function defaultNameFor(inst: { partName: string; instanceId: string }): string {
  return inst.partName;
}

async function updateInsertChain(
  sourceLocation: { filePath: string; line: number },
  edit: {
    ground?: boolean;
    name?: string | null;
    defaultName?: string;
    translate?: [number, number, number] | null;
  },
): Promise<void> {
  try {
    await fetch('/api/update-insert-chain', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sourceLocation, edit }),
    });
  } catch (err) {
    console.error('Update insert chain failed:', err);
  }
}

function applyAssemblyToRail(rail: LeftRail & { kind: 'assembly' }, assembly: SerializedAssembly, absPath: string): void {
  lastAssemblyPayload = assembly;
  for (const id of [...rail.instanceVisibility.keys()]) {
    if (!assembly.instances.find(i => i.instanceId === id)) {
      rail.instanceVisibility.delete(id);
    }
  }
  for (const id of [...lastFailedMateIds]) {
    if (!assembly.mates.find(m => m.mateId === id)) {
      lastFailedMateIds.delete(id);
    }
  }
  const rendered: RenderedInstance[] = assembly.instances.map(i => ({
    ...i,
    visible: rail.instanceVisibility.get(i.instanceId) ?? true,
  }));
  rail.parts.update(rendered, absPath);
  rail.joints.update(matesWithStatus(assembly.mates, lastFailedMateIds), rendered);
}

function matesWithStatus(
  mates: SerializedAssembly['mates'],
  failed: Set<string>,
): SerializedAssembly['mates'] {
  if (failed.size === 0) {
    return mates;
  }
  return mates.map(m =>
    failed.has(m.mateId) ? { ...m, status: 'inconsistent' as const } : m,
  );
}

// Start in part mode — the first scene-rendered will switch to assembly if needed.
const initialRail = buildPartRail();
currentRail = initialRail;

const trimService = new TrimPickService(container, viewer);
const regionService = new RegionPickService(container, viewer);
const sketchService = new SketchToolbarService(container, viewer, trimService, initialRail.timeline);

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

new FileImporter(container, {
  showLoading: (text) => loadingOverlay.show(text),
  hideLoading: () => loadingOverlay.hide(),
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

viewer.setInstanceDragReleaseHandler((instanceId, position) => {
  const inst = findInstance(instanceId);
  if (!inst?.sourceLocation) return;
  // For mate-constrained ungrounded bodies, position is mate-derived and
  // rotation is the meaningful drag dimension. Persisting `.translate(...)`
  // would write the post-solve position into the source while losing the
  // rotation entirely (`.orient()` doesn't exist yet), so on reload the
  // body would snap back to identity orientation at the persisted
  // position — visibly undoing the drag. Until rotation persistence
  // exists, leave such instances at their default in source and let the
  // mate warm-start re-derive the pose from the driver.
  if (!inst.grounded && instanceHasMate(instanceId)) {
    return;
  }
  updateInsertChain(inst.sourceLocation, {
    translate: [position.x, position.y, position.z],
  });
});

viewer.setSolverUpdateHandler((output) => {
  if (currentRail?.kind !== 'assembly') return;
  // Diff the failed set against the previous frame BEFORE replacing it.
  // The joints panel only re-renders when this set changes, and during a
  // drag the solver fires per pointermove (1000+ Hz on modern mice) — a
  // full panel re-render every event pegs the CPU. The DOF readout still
  // updates every frame since it's a single text node.
  const newFailed = new Set(output.failed);
  const failedChanged = failedSetsDiffer(lastFailedMateIds, newFailed);
  lastFailedMateIds = newFailed;
  if (output.result === 'okay') {
    currentRail.dof.update({ result: 'okay', dof: output.dof });
  } else if (output.result === 'inconsistent') {
    const failed = output.failed.map((mateId) => {
      const mate = findMate(mateId);
      return { mateId, label: mate ? formatMateLabel(mate) : mateId };
    });
    currentRail.dof.update({ result: 'inconsistent', dof: output.dof, failed });
  } else {
    // didnt-converge / too-many-unknowns — surface as inconsistent so the
    // user sees the assembly is unhealthy. No mate-specific failure list.
    currentRail.dof.update({ result: 'inconsistent', dof: output.dof, failed: [] });
  }
  if (failedChanged && lastAssemblyPayload) {
    const rendered: RenderedInstance[] = lastAssemblyPayload.instances.map(i => ({
      ...i,
      visible: currentRail!.kind === 'assembly'
        ? currentRail!.instanceVisibility.get(i.instanceId) ?? true
        : true,
    }));
    currentRail.joints.update(
      matesWithStatus(lastAssemblyPayload.mates, lastFailedMateIds),
      rendered,
    );
  }
});

function failedSetsDiffer(a: Set<string>, b: Set<string>): boolean {
  if (a.size !== b.size) return true;
  for (const v of a) if (!b.has(v)) return true;
  return false;
}

function formatMateLabel(mate: { type: string; mateId: string }): string {
  return `${mate.type} (${mate.mateId})`;
}

viewer.setSelectionHandler((shapeId, sub, instanceId) => {
  if (shapeId) {
    if (shapePropertiesModal.isOpen) {
      viewer.highlightShape(shapeId, instanceId);
    } else if (sub?.type === 'face') {
      viewer.highlightFace(shapeId, sub.index, instanceId);
    } else if (sub?.type === 'edge') {
      viewer.highlightEdge(shapeId, sub.index, instanceId);
    } else {
      viewer.clearHighlight();
    }
  } else {
    // Click in empty 3D space — clear face/edge selection AND the
    // parts/joints panel-driven instance tint so the user has a clean
    // way to deselect a row.
    viewer.clearHighlight();
    viewer.clearInstanceHighlight();
    if (currentRail?.kind === 'assembly') {
      currentRail.parts.setSelected(null);
      currentRail.joints.setSelected(null);
    }
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
        const sceneKind: 'part' | 'assembly' = msg.sceneKind === 'assembly' ? 'assembly' : 'part';
        viewer.isTrimming = !isRollback && trimService.state === 'picking-active';
        viewer.isDrawing = !isRollback && sketchService.hasActiveDrawingTool;
        if (sceneKind === 'assembly') {
          const assembly: SerializedAssembly = msg.assembly ?? { instances: [], mates: [] };
          viewer.updateAssemblyView(msg.result, assembly);
        } else {
          viewer.updateView(msg.result, isRollback, msg.rollbackStop);
        }
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
        const rail = ensureRailFor(sceneKind);
        if (rail.kind === 'part') {
          rail.timeline.update(msg.result, msg.rollbackStop ?? msg.result.length - 1, msg.absPath);
        } else {
          const raw = msg.assembly;
          const assembly: SerializedAssembly = {
            instances: raw?.instances ?? [],
            mates: raw?.mates ?? [],
          };
          applyAssemblyToRail(rail, assembly, msg.absPath ?? '');
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
