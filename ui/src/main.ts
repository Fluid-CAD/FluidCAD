import { Viewer } from './viewer';
import { HttpEngineClient } from './http-engine-client';
import { ShapePropertiesModal } from './ui/shape-properties-modal';
import { SelectionInfoOverlay } from './ui/selection-info-overlay';
import { TimelinePanel } from './ui/timeline-panel';
import { PartsPanel } from './ui/parts-panel';
import { JointsPanel } from './ui/joints-panel';
import { DofStatus } from './ui/dof-status';
import { DragReadout } from './ui/drag-readout';
import { ParamsPanel } from './ui/params-panel';
import { ParamEditorDialog } from './ui/param-editor-dialog';
import { ExportDialog } from './ui/export-dialog';
import { BreakpointIndicator } from './ui/breakpoint-indicator';
import { ErrorBanner } from './ui/error-banner';
import { LoadingOverlay } from './ui/loading-overlay';
import { FileImporter } from './ui/file-importer';
import { TopBar } from './ui/top-bar';
import { Navbar } from './ui/navbar';
import { AssemblyToolbar } from './ui/assembly-toolbar';
import { InsertPartDialog } from './ui/insert-part/insert-part-dialog';
import { EditParamsDialog } from './ui/edit-params-dialog';
import { HistoryToolbar } from './ui/history-toolbar';
import { ICON_IMG_FALLBACK } from './ui/object-icons';
import { TOOLBAR_BTN_BASE, TOOLBAR_BTN_ICON, TOOLBAR_BTN_LABEL } from './ui/toolbar-styles';
import { SelectionContextMenu } from './interactive/selection-menu';
import { TrimPickService } from './interactive/trim-pick-service';
import { RegionPickService } from './interactive/region-pick-service';
import { ProjectionPickService } from './interactive/projection-pick-service';
import { SketchToolbarService } from './interactive/sketch-toolbar-service';
import { ModifyPickService } from './interactive/modify-pick/modify-pick-service';
import { ExtrudeFeatureService } from './interactive/create-feature/extrude-service';
import { RibFeatureService } from './interactive/create-feature/rib-service';
import { RevolveFeatureService } from './interactive/create-feature/revolve-service';
import { SweepFeatureService } from './interactive/create-feature/sweep-service';
import { LoftFeatureService } from './interactive/create-feature/loft-service';
import { WrapFeatureService } from './interactive/create-feature/wrap-service';
import { HelixFeatureService } from './interactive/create-feature/helix-service';
import { RepeatFeatureService } from './interactive/create-feature/repeat-service';
import { CopyFeatureService } from './interactive/create-feature/copy-service';
import { MirrorFeatureService } from './interactive/create-feature/mirror-service';
import { RotateFeatureService } from './interactive/create-feature/rotate-service';
import { ConnectorFeatureService } from './interactive/create-feature/connector-service';
import { BooleanFeatureService } from './interactive/create-feature/boolean-service';
import { PlaneFeatureService } from './interactive/create-feature/plane-service';
import { isPlaneStatementRow } from './interactive/create-feature/plane-bases';
import { FinishSketchMenu } from './interactive/create-feature/finish-sketch-menu';
import { PartToolButton } from './interactive/create-feature/part-tool';
import { ActivePartTracker } from './interactive/active-part-tracker';
import { SolidPickSelection } from './interactive/solid-pick';
import { MeasureController } from './ui/measure/measure-controller';
import { captureScreenshot, captureScreenshotMulti } from './screenshot';
import { RenderedInstance, SerializedAssembly } from './types';
import { onThemeChange } from './scene/theme-colors';
import { loadPreferences, gotoSource, parseFeatureAt, addBreakpoint, removeFeature, applyInstancePose, getInstancePoseExpressions, getScopeVariables, setActivePartProvider } from './api';
import { setActivePartLocationProvider } from './helpers/scene-utils';
import { AssemblyGizmoDriver } from './interactive/gizmo/assembly-gizmo-driver';
import { AssemblyMateService } from './interactive/assembly-mate/mate-service';
import { ConnectorPropsEditor } from './interactive/assembly-mate/connector-props-editor';
import { TextEditService } from './interactive/create-feature/text-edit-service';
import type { ConnectorData, SceneObjectRender } from './types';
import { applyPreferences } from './scene/viewer-settings';
import { installVSCodeKeyboardBridge } from './keyboard-bridge';

installVSCodeKeyboardBridge();

const container = document.getElementById('fluidcad-viewer') || document.body;

let pendingShowBuildTimings = false;

const loadingOverlay = new LoadingOverlay(container);
const engineClient = new HttpEngineClient();
const viewer = new Viewer('fluidcad-viewer', engineClient);

onThemeChange(() => viewer.rebuildSceneMesh());

loadPreferences().then((prefs) => {
  if (prefs) {
    // The server pre-applies the saved theme when it serves index.html;
    // re-setting the same value would still fire the theme MutationObserver
    // and trigger a needless full scene re-mesh.
    if (document.documentElement.getAttribute('data-theme') !== prefs.theme) {
      document.documentElement.setAttribute('data-theme', prefs.theme);
    }
    applyPreferences(prefs);
    pendingShowBuildTimings = !!prefs.showBuildTimings;
    if (currentRail?.kind === 'part') {
      currentRail.timeline.setShowBuildTimings(pendingShowBuildTimings);
    }
    measureController.applyPreferences(prefs);
  }
});

// ---------------------------------------------------------------------------
// UI components
// ---------------------------------------------------------------------------

const shapePropertiesModal = new ShapePropertiesModal(container, engineClient);
// The properties panel's whole-solid picker (single mode) — the copy dialog
// shares the component in multiple mode for its targets slot.
const propertiesSolidPick = new SolidPickSelection(viewer);
const selectionInfoOverlay = new SelectionInfoOverlay(container, engineClient);
const measureController = new MeasureController(
  container, engineClient, viewer,
  (handlers) => new SelectionContextMenu(container, 'fluidcad-measure-select-menu', handlers),
);
const exportDialog = new ExportDialog(container, engineClient, viewer.sceneContext);
// ---------------------------------------------------------------------------
// Left-rail abstraction. The same DOM container hosts either the part-design
// rail (TimelinePanel, History+Shapes) or the assembly rail
// (PartsPanel + JointsPanel + DofStatus). `ensureRailFor(kind)` swaps them
// when the current scene's `sceneKind` changes.
// ---------------------------------------------------------------------------

type LeftRail =
  | { kind: 'part'; timeline: TimelinePanel }
  | { kind: 'assembly'; parts: PartsPanel; joints: JointsPanel; dof: DofStatus; dragReadout: DragReadout; instanceVisibility: Map<string, boolean> };

let currentRail: LeftRail | null = null;

const fileImporter = new FileImporter(container, {
  showLoading: (text) => loadingOverlay.show(text),
  hideLoading: () => loadingOverlay.hide(),
});

// Always the live part-rail TimelinePanel — rebuilt (and re-wired) whenever
// the rail flips back from assembly to part mode.
let timelinePanel: TimelinePanel;

// The timeline's active part — one part is ALWAYS active while the scene
// contains any (last part by default; a part-row click re-points it, no
// rollback). Producer-less creates (pick-less sketch, standard plane/helix)
// land inside its callback body instead of at top level. Every apply-feature
// payload carries its location through the provider below.
const activePartTracker = new ActivePartTracker();
setActivePartProvider(() => activePartTracker.location);
// The scene-utils scope helpers (findActiveObject & co.) read the same
// tracker: the "active" feature is the active part's last child, so the
// viewer, sketch toolbar, timeline and pick services all follow the part a
// timeline click chose instead of whatever part the file happens to end in.
setActivePartLocationProvider(() => activePartTracker.location);

function disposeRail(): void {
  if (!currentRail) return;
  if (currentRail.kind === 'part') {
    currentRail.timeline.dispose();
  } else if (currentRail.kind === 'assembly') {
    currentRail.parts.dispose();
    currentRail.joints.dispose();
    currentRail.dof.hide();
    currentRail.dragReadout.dispose();
  }
  currentRail = null;
}

function buildPartRail(): Extract<LeftRail, { kind: 'part' }> {
  const timeline = new TimelinePanel(
    container,
    engineClient,
    (shapeId) => viewer.highlightShape(shapeId),
    (shapeIds) => exportDialog.show(shapeIds),
    (shapeId, visible) => viewer.setShapeVisibility(shapeId, visible),
    (shapeId) => viewer.isShapeHidden(shapeId),
    (shapeId, opacity) => viewer.setShapeTransparency(shapeId, opacity),
    (shapeId) => viewer.getShapeTransparency(shapeId),
    () => viewer.resetAllTransparency(),
  );
  timeline.setShowBuildTimings(pendingShowBuildTimings);
  timelinePanel = timeline;
  wireTimelinePanel(timeline);
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
    (id, grounded) => {
      const inst = findInstance(id);
      // Occurrence-owned instances' statements live in the sub-assembly's
      // file — the panel hides these actions, this is the backstop.
      if (!inst?.sourceLocation || inst.owner) return;
      updateInsertChain(inst.sourceLocation, { ground: grounded });
    },
    (id, newName) => {
      const inst = findInstance(id);
      if (!inst?.sourceLocation || inst.owner) return;
      updateInsertChain(inst.sourceLocation, {
        name: newName,
        defaultName: defaultNameFor(inst),
      });
    },
    (id) => {
      const inst = findInstance(id);
      if (!inst?.sourceLocation || inst.owner) return;
      // Drops the whole `insert(...)` statement, its `const` binding included.
      // Mates that still reference the binding are left for the user — the
      // next render reports them, same as the timeline's Remove.
      removeFeature(inst.sourceLocation);
    },
    // Occurrence header actions — the occurrence's own `insert(subAsm())`
    // chain lives in the OPEN file, so the same statement edits instances
    // use apply verbatim.
    {
      onShowInSource: (id) => {
        const occ = findOccurrence(id);
        if (occ?.sourceLocation) {
          gotoSource(occ.sourceLocation);
        }
      },
      onSetGround: (id, grounded) => {
        const occ = findOccurrence(id);
        if (!occ?.sourceLocation) return;
        updateInsertChain(occ.sourceLocation, { ground: grounded });
      },
      onRename: (id, newName) => {
        const occ = findOccurrence(id);
        if (!occ?.sourceLocation) return;
        updateInsertChain(occ.sourceLocation, {
          name: newName,
          defaultName: occ.assemblyName,
        });
      },
      onDelete: (id) => {
        const occ = findOccurrence(id);
        if (!occ?.sourceLocation) return;
        removeFeature(occ.sourceLocation);
      },
    },
    // Edit parameters — instance rows read control metadata off their part
    // template, occurrence headers carry their own; both merge into the
    // insert() statement's second argument.
    (kind, id) => {
      if (kind === 'instance') {
        const inst = findInstance(id);
        if (!inst?.sourceLocation || inst.owner) return;
        const defs = lastPartTemplates.get(inst.partId)?.params;
        if (!Array.isArray(defs) || defs.length === 0) return;
        editParamsDialog.show({
          title: `${inst.name} — parameters`,
          subtitle: inst.partName,
          defs,
          currentValues: inst.paramValues ?? {},
          filePath: inst.sourceLocation.filePath,
          line: inst.sourceLocation.line,
        });
      } else {
        const occ = findOccurrence(id);
        if (!occ?.sourceLocation || !occ.params?.length) return;
        editParamsDialog.show({
          title: `${occ.name} — parameters`,
          subtitle: occ.assemblyName,
          defs: occ.params,
          currentValues: occ.paramValues ?? {},
          filePath: occ.sourceLocation.filePath,
          line: occ.sourceLocation.line,
        });
      }
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
    (id) => {
      const mate = findMate(id);
      // Owned mates' statements live in the sub-assembly's file — the panel
      // hides Edit for these, this is the backstop.
      if (!mate?.sourceLocation || mate.owner) return;
      assemblyMateService.beginEdit(mate);
    },
    (_id) => { /* phase 06+ */ },
    (id) => {
      const mate = findMate(id);
      // Owned mates' statements live in the sub-assembly's file — the panel
      // hides Delete for these, this is the backstop.
      if (!mate?.sourceLocation || mate.owner) return;
      // Drops the whole `mate(...)` statement.
      removeFeature(mate.sourceLocation);
    },
  );
  const dof = new DofStatus(container, (_mateId) => { /* phase 05+ */ });
  dof.show();
  const dragReadout = new DragReadout(container);
  return { kind: 'assembly', parts, joints, dof, dragReadout, instanceVisibility: visibility };
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
/** partId → template serialize payload ({ name, params, paramValues }) of the last assembly render. */
const lastPartTemplates = new Map<string, any>();

function findInstance(instanceId: string) {
  return lastAssemblyPayload?.instances.find(i => i.instanceId === instanceId);
}

function findOccurrence(occurrenceId: string) {
  return lastAssemblyPayload?.occurrences?.find(o => o.occurrenceId === occurrenceId);
}

function findMate(mateId: string) {
  return lastAssemblyPayload?.mates.find(m => m.mateId === mateId);
}

function instanceHasMate(instanceId: string): boolean {
  if (!lastAssemblyPayload) return false;
  for (const m of lastAssemblyPayload.mates) {
    const aId = m.connectorA?.instanceId ?? m.geometryA?.instanceId;
    const bId = m.connectorB?.instanceId ?? m.geometryB?.instanceId;
    if (aId === instanceId || bId === instanceId) {
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

function applyAssemblyToRail(rail: LeftRail & { kind: 'assembly' }, assembly: SerializedAssembly): void {
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
  rail.parts.update(rendered, assembly.occurrences ?? []);
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

// Top application bar (logo, feature-tree toggle, file name) and the secondary
// tool bar below it (host for conditionally-visible tool groups).
const topBar = new TopBar(container, {
  onToggleTree: () => {
    if (currentRail?.kind === 'part') {
      timelinePanel.togglePanel();
    } else if (currentRail?.kind === 'assembly') {
      currentRail.parts.togglePanel();
    }
  },
});
const navbar = new Navbar(container);

// Undo/Redo — registered first so the group leads the bar, ahead of every
// other tool. The buttons step the attached editor's native undo stack
// (each UI-applied operation is one editor edit); the group appears once the
// editor host announces the capability over the WebSocket and never shows on
// an editor-less server. The file targeted is whatever the last render came
// from — the same file every other toolbar action edits.
let currentSceneAbsPath: string | null = null;
const runEditorHistory = (action: 'undo' | 'redo') => {
  const editor = engineClient.editor;
  if (!editor || !currentSceneAbsPath) {
    return;
  }
  editor[action](currentSceneAbsPath).then((result) => {
    if (!result.success) {
      console.warn(`${action} failed:`, result.reason);
    }
  });
};
const historyToolbar = new HistoryToolbar(navbar, {
  onUndo: () => runEditorHistory('undo'),
  onRedo: () => runEditorHistory('redo'),
});

// Import group — always visible for now.
const importGroup = navbar.addGroup('import');
const importBtn = document.createElement('button');
importBtn.className = TOOLBAR_BTN_BASE;
importBtn.setAttribute('aria-label', 'Import file');
importBtn.innerHTML =
  `<img src="/icons/load.png" ${ICON_IMG_FALLBACK} class="${TOOLBAR_BTN_ICON}" alt="" />`
  + `<span class="${TOOLBAR_BTN_LABEL}">Import</span>`;
importBtn.addEventListener('click', () => fileImporter.openPicker());
const importBtnWrap = document.createElement('span');
importBtnWrap.className = 'tooltip tooltip-bottom shrink-0';
importBtnWrap.dataset.tip = 'Import file';
importBtnWrap.appendChild(importBtn);
importGroup.appendChild(importBtnWrap);

// Assembly workbench groups (Insert / Translate / mates), shown instead of
// the part-design tools whenever the scene kind is assembly (navbar.setMode
// in the scene-rendered handler). Insert opens the part-catalog browser;
// the rest are placeholders for now.
const insertPartDialog = new InsertPartDialog(container);
// Parts-panel "Edit parameters…" — merges changed values into an inserted
// instance's/occurrence's insert() statement.
const editParamsDialog = new EditParamsDialog(container);
// The Insert dialog reuses `currentSceneAbsPath` (declared with the history
// toolbar above) to exclude the open assembly from inserting into itself.
new AssemblyToolbar(navbar, {
  onInsert: () => insertPartDialog.show(currentSceneAbsPath),
  // The service is constructed later (it needs the gizmo driver); toolbar
  // clicks only ever fire after startup completes.
  onMate: (type) => assemblyMateService.enter(type),
});

const paramsPanel = new ParamsPanel(viewer.settingsPanelHost, engineClient, new ParamEditorDialog(container));

viewer.setParamsToggleHandler(() => {
  paramsPanel.toggle();
  viewer.setParamsButtonActive(paramsPanel.isVisible);
});

const trimService = new TrimPickService(viewer);
const regionService = new RegionPickService(viewer, navbar);
// The Project sketch tool. Like trim it is armed from the sketch toolbar, but
// its picks are solid edges and faces in the free 3D view, so the routing
// below hands it viewport clicks while it is armed.
const projectionService = new ProjectionPickService(container, viewer);
// While a create-feature dialog launched from the Finish Sketch menu is open,
// keep the sketch toolbar pinned in place — the bar stays on the sketch tools
// until the feature is applied — even though the dialog suspends sketch editing
// so the free 3D view can be picked. Derived from the dialogs' own suspend
// state: these services suspend only when armed from an active sketch, so a
// suspended-and-still-armed one means the finishing flow is live. On apply the
// service disarms (isActive false) before it resumes, so this reads false at
// that point and the bar hands off to the 3D toolbar; on cancel it resumes the
// sketch. (The modify service's sketch-on-face / New Sketch flow keeps the
// plain hooks — starting a new sketch does drop the bar.)
const syncKeepToolbar = () => sketchService.setKeepToolbar(
  (extrudeService.isActive && extrudeService.sketchUISuspended)
  || (ribService.isActive && ribService.sketchUISuspended)
  || (revolveService.isActive && revolveService.sketchUISuspended)
  || (sweepService.isActive && sweepService.sketchUISuspended)
  || (loftService.isActive && loftService.sketchUISuspended)
  || (wrapService.isActive && wrapService.sketchUISuspended)
  || (planeService.isActive && planeService.sketchUISuspended)
  || (connectorService.isActive && connectorService.sketchUISuspended),
);
// The Sketch button (create group) stays visible while a create dialog is
// up — it disables instead. Recomputed on every dialog arm/disarm, alongside
// the toolbar pin (this fires after a dialog disarms, clearing the pin on apply).
const syncSketchButtonBlocked = () => {
  modifyService.setCreateDialogActive(
    extrudeService.isActive || ribService.isActive || revolveService.isActive
    || sweepService.isActive || loftService.isActive || wrapService.isActive
    || helixService.isActive || repeatService.isActive || copyService.isActive
    || mirrorService.isActive || rotateService.isActive || connectorService.isActive
    || booleanService.isActive || planeService.isActive,
  );
  syncKeepToolbar();
};
// The create dialogs' shared sketch-UI suspend/resume: recompute the pin first
// (so it is set before the suspended empty scene would hide the bar), then
// hide/restore the live sketch editing.
const suspendSketchForFeature = () => {
  syncKeepToolbar();
  sketchService.update([]);
};
const resumeSketchForFeature = () => {
  syncKeepToolbar();
  sketchService.update(viewer.currentSceneObjects);
};
// Registered before the sketch toolbar so the create group renders ahead of
// the sketch tools; its `immune` flag keeps it visible in sketch mode, where
// extruding the active sketch is the primary flow.
const extrudeService = new ExtrudeFeatureService(container, viewer, navbar, {
  onEnter: () => {
    projectionService.exit({ resume: 'lazy' });
    // Stash a live sketch session before exit() drops it — the dialog comes
    // back when this create dialog exits with the sketch still active.
    modifyService.displaceSketchSession();
    modifyService.exit();
    ribService.exit();
    revolveService.exit();
    helixService.exit();
    sweepService.exit();
    loftService.exit();
    wrapService.exit();
    repeatService.exit();
    copyService.exit();
    mirrorService.exit();
    rotateService.exit();
    booleanService.exit();
    connectorService.exit();
    planeService.exit();
    textEditService.exit();
    measureController.clearSelection();
    viewer.clearHighlight();
    selectionInfoOverlay.hide();
  },
  onActiveChange: syncSketchButtonBlocked,
  onSuspendSketchUI: suspendSketchForFeature,
  onResumeSketchUI: resumeSketchForFeature,
});
// Constructed right after Extrude so its button lands between Extrude and
// Sweep in the create group.
const revolveService = new RevolveFeatureService(container, viewer, navbar, {
  onEnter: () => {
    projectionService.exit({ resume: 'lazy' });
    modifyService.displaceSketchSession();
    modifyService.exit();
    extrudeService.exit();
    ribService.exit();
    helixService.exit();
    sweepService.exit();
    loftService.exit();
    wrapService.exit();
    repeatService.exit();
    copyService.exit();
    mirrorService.exit();
    rotateService.exit();
    booleanService.exit();
    connectorService.exit();
    planeService.exit();
    textEditService.exit();
    measureController.clearSelection();
    viewer.clearHighlight();
    selectionInfoOverlay.hide();
  },
  onActiveChange: syncSketchButtonBlocked,
  onSuspendSketchUI: suspendSketchForFeature,
  onResumeSketchUI: resumeSketchForFeature,
});
const sweepService = new SweepFeatureService(container, viewer, navbar, {
  onEnter: () => {
    projectionService.exit({ resume: 'lazy' });
    modifyService.displaceSketchSession();
    modifyService.exit();
    extrudeService.exit();
    ribService.exit();
    revolveService.exit();
    helixService.exit();
    loftService.exit();
    wrapService.exit();
    repeatService.exit();
    copyService.exit();
    mirrorService.exit();
    rotateService.exit();
    booleanService.exit();
    connectorService.exit();
    planeService.exit();
    textEditService.exit();
    measureController.clearSelection();
    viewer.clearHighlight();
    selectionInfoOverlay.hide();
  },
  onActiveChange: syncSketchButtonBlocked,
  onSuspendSketchUI: suspendSketchForFeature,
  onResumeSketchUI: resumeSketchForFeature,
});
const loftService = new LoftFeatureService(container, viewer, navbar, {
  onEnter: () => {
    projectionService.exit({ resume: 'lazy' });
    modifyService.displaceSketchSession();
    modifyService.exit();
    extrudeService.exit();
    ribService.exit();
    revolveService.exit();
    helixService.exit();
    sweepService.exit();
    wrapService.exit();
    repeatService.exit();
    copyService.exit();
    mirrorService.exit();
    rotateService.exit();
    booleanService.exit();
    connectorService.exit();
    planeService.exit();
    textEditService.exit();
    measureController.clearSelection();
    viewer.clearHighlight();
    selectionInfoOverlay.hide();
  },
  onActiveChange: syncSketchButtonBlocked,
  onSuspendSketchUI: suspendSketchForFeature,
  onResumeSketchUI: resumeSketchForFeature,
});
// Constructed after Loft so its button lands at the end of the create group.
const wrapService = new WrapFeatureService(container, viewer, navbar, {
  onEnter: () => {
    projectionService.exit({ resume: 'lazy' });
    modifyService.displaceSketchSession();
    modifyService.exit();
    extrudeService.exit();
    ribService.exit();
    revolveService.exit();
    helixService.exit();
    sweepService.exit();
    loftService.exit();
    repeatService.exit();
    copyService.exit();
    mirrorService.exit();
    rotateService.exit();
    booleanService.exit();
    connectorService.exit();
    planeService.exit();
    textEditService.exit();
    measureController.clearSelection();
    viewer.clearHighlight();
    selectionInfoOverlay.hide();
  },
  onActiveChange: syncSketchButtonBlocked,
  onSuspendSketchUI: suspendSketchForFeature,
  onResumeSketchUI: resumeSketchForFeature,
});
// Constructed after Wrap so its Helix button lands at the end of the create
// feature row (Extrude, Revolve, Sweep, Loft, Wrap, Helix).
const helixService = new HelixFeatureService(container, viewer, navbar, {
  onEnter: () => {
    projectionService.exit({ resume: 'lazy' });
    modifyService.displaceSketchSession();
    modifyService.exit();
    extrudeService.exit();
    ribService.exit();
    revolveService.exit();
    sweepService.exit();
    loftService.exit();
    wrapService.exit();
    repeatService.exit();
    copyService.exit();
    mirrorService.exit();
    rotateService.exit();
    booleanService.exit();
    connectorService.exit();
    planeService.exit();
    textEditService.exit();
    measureController.clearSelection();
    viewer.clearHighlight();
    selectionInfoOverlay.hide();
  },
  onActiveChange: syncSketchButtonBlocked,
  onSuspendSketchUI: suspendSketchForFeature,
  onResumeSketchUI: resumeSketchForFeature,
});
// Constructed after Helix so its Rib button lands at the end of the create
// feature row (Extrude, Revolve, Sweep, Loft, Wrap, Helix, Rib).
const ribService = new RibFeatureService(container, viewer, navbar, {
  onEnter: () => {
    projectionService.exit({ resume: 'lazy' });
    modifyService.displaceSketchSession();
    modifyService.exit();
    extrudeService.exit();
    revolveService.exit();
    helixService.exit();
    sweepService.exit();
    loftService.exit();
    wrapService.exit();
    repeatService.exit();
    copyService.exit();
    mirrorService.exit();
    rotateService.exit();
    booleanService.exit();
    connectorService.exit();
    planeService.exit();
    textEditService.exit();
    measureController.clearSelection();
    viewer.clearHighlight();
    selectionInfoOverlay.hide();
  },
  onActiveChange: syncSketchButtonBlocked,
  onSuspendSketchUI: suspendSketchForFeature,
  onResumeSketchUI: resumeSketchForFeature,
});
// Constructed after the other create services: its button prepends ahead of
// Extrude, and the Sketch button (modify service) prepends ahead of it —
// the group reads Sketch, Plane, Extrude, Sweep, Loft.
const planeService = new PlaneFeatureService(container, viewer, navbar, {
  // The current highlight seeds the dialog (one edge → edge type, one face →
  // offset, two faces → mid, a selected plane quad → offset on that plane),
  // like the modify tools.
  onEnter: () => {
    // The neutral-mode pending plane (a clicked quad, held for the Sketch
    // button) — captured before the exits below clear it.
    const pendingPlane = modifyService.pendingPlane;
    projectionService.exit({ resume: 'lazy' });
    modifyService.displaceSketchSession();
    modifyService.exit();
    extrudeService.exit();
    ribService.exit();
    revolveService.exit();
    helixService.exit();
    sweepService.exit();
    loftService.exit();
    wrapService.exit();
    repeatService.exit();
    copyService.exit();
    mirrorService.exit();
    rotateService.exit();
    booleanService.exit();
    connectorService.exit();
    const entities = [...measureController.selection];
    textEditService.exit();
    measureController.clearSelection();
    viewer.clearHighlight();
    selectionInfoOverlay.hide();
    // Pending plane and measure selection are mutually exclusive (each click
    // kind clears the other), so at most one of the two seeds is non-empty.
    return { entities, planeShapeId: pendingPlane };
  },
  onActiveChange: syncSketchButtonBlocked,
  onSuspendSketchUI: suspendSketchForFeature,
  onResumeSketchUI: resumeSketchForFeature,
});
// The text edit dialog (timeline double-click on a text row). Pick-less:
// it never takes viewer or timeline picks, so it sits outside the create
// group and the intercept chain.
const textEditService = new TextEditService(container, viewer, {
  onEnter: () => {
    projectionService.exit({ resume: 'lazy' });
    modifyService.exit();
    extrudeService.exit();
    ribService.exit();
    revolveService.exit();
    helixService.exit();
    sweepService.exit();
    loftService.exit();
    wrapService.exit();
    repeatService.exit();
    copyService.exit();
    mirrorService.exit();
    rotateService.exit();
    booleanService.exit();
    connectorService.exit();
    planeService.exit();
    measureController.clearSelection();
    viewer.clearHighlight();
    selectionInfoOverlay.hide();
  },
  onSuspendSketchUI: suspendSketchForFeature,
  onResumeSketchUI: resumeSketchForFeature,
});
// Applied to every part-rail TimelinePanel — the rail rebuilds the panel when
// the scene kind flips back from assembly, and the hooks must ride along.
function wireTimelinePanel(panel: TimelinePanel): void {
  // An armed create dialog takes sketch (or plane) rows clicked in the
  // timeline as its input instead of the default rollback-preview.
  panel.onFeatureIntercept = (obj) =>
    extrudeService.handleTimelinePick(obj) || ribService.handleTimelinePick(obj)
    || revolveService.handleTimelinePick(obj)
    || sweepService.handleTimelinePick(obj) || wrapService.handleTimelinePick(obj)
    || loftService.handleTimelinePick(obj) || helixService.handleTimelinePick(obj)
    || repeatService.handleTimelinePick(obj) || copyService.handleTimelinePick(obj)
    || mirrorService.handleTimelinePick(obj) || rotateService.handleTimelinePick(obj)
    || booleanService.handleTimelinePick(obj) || planeService.handleTimelinePick(obj);
  // Part rows don't navigate: a click makes that part the active part — new
  // statements land inside its callback body instead of at top level, and
  // the view re-derives its mode from the new scope (a part ending in a
  // sketch enters sketch editing). One part is always active while the
  // scene has any (tracker invariant), so re-clicking the active row is a
  // no-op rather than a toggle.
  panel.onPartActivate = (obj) => {
    if (activePartTracker.isActive(obj)) {
      return;
    }
    activePartTracker.activate(obj);
    refreshActivePartScope();
  };
  panel.isPartRowActive = (obj) => activePartTracker.isActive(obj);
  // Double-clicking an editable feature row (the enter-breakpoint gesture)
  // also opens that feature's dialog prefilled from its statement.
  panel.onFeatureEdit = (obj, index) => {
    void openFeatureEditor(obj, index);
  };
  // Rows with an edit dialog keep the double-click gesture even while the
  // trailing sketch is active — the dialog suspends the sketch UI itself. A
  // plane row only qualifies when it is a plane() statement's own: the plane a
  // sketch builds for itself opens that sketch, and sketch rows stay blocked
  // while another sketch is being edited. (A workspace kernel new enough to
  // flag its internal objects leaves that row out of the timeline entirely.)
  panel.isFeatureEditable = (obj) =>
    obj.type != null && EDITABLE_ROW_TYPES.has(obj.type) && obj.sourceLocation != null
    && (obj.type !== 'plane' || isPlaneStatementRow(obj, viewer.currentSceneObjects))
    // The in-sketch mirror shares `type: 'mirror'` with the 3D forms but has
    // no edit dialog yet — the parse would misread its axis as a plane.
    && obj.uniqueType !== 'mirror-shape-2d'
    // The in-sketch rotate shares `type: 'rotate'` the same way — its leading
    // angle would be misread as the 3D form's axis.
    && obj.uniqueType !== 'rotate-shape-2d';
  // A 2D offset row's edit pauses the build BEFORE its statement (see
  // openFeatureEditor), so its double-click defers the generic breakpoint.
  panel.managesOwnBreakpoint = (obj) =>
    (obj.type != null && PAUSE_BEFORE_ROW_TYPES.has(obj.type)) || isCopy2DRow(obj);
}

/** Rows whose edit dialog pauses the build before its own statement. */
const PAUSE_BEFORE_ROW_TYPES = new Set(['offset', 'slot', 'fillet2d']);

/**
 * A copy statement parses identically in 2D and 3D — the row's unique type
 * tells them apart. The 2D one lives inside a sketch body and follows the
 * offset edit's pause-before contract.
 */
function isCopy2DRow(obj: SceneObjectRender): boolean {
  return obj.uniqueType === 'copy-linear-2d' || obj.uniqueType === 'copy-circular-2d';
}


/**
 * Timeline `type` → the dialog that edits it (cut is extrude's remove op;
 * the repeat kinds map to their scene feature types — mirror and rotate
 * rows carry the mirror/matrix feature's type, and a raw-matrix repeat
 * surfaces its parse refusal as the toast).
 */
const EDITABLE_ROW_TYPES = new Set([
  'extrude', 'cut', 'rib', 'revolve', 'sweep', 'wrap', 'loft', 'helix', 'shell', 'fillet', 'chamfer', 'text',
  'repeat-linear', 'repeat-circular', 'repeat-matrix', 'mirror', 'rotate',
  'copy-linear', 'copy-circular',
  'fuse', 'subtract', 'common',
  'plane',
  // A connector row sits inside its part() body; its dialog re-opens over the
  // statement with the frame the row itself carries.
  'connector',
  // 2D: an offset/slot/fillet/projection row sits under its sketch, and its
  // dialog re-opens over it. (A from-dimensions slot statement parse-refuses
  // with a drag-to-edit hint — only the from-edge form has a dialog.)
  'offset',
  'slot',
  'fillet2d',
  'projection',
]);

/**
 * Each sketch's consumed state (`!visible || reusable`) from the last COMPLETE
 * build, keyed by source location. Read when a double-click opens a sketch for
 * editing to decide the Finish Sketch button's behavior — the timeline's own
 * row can't be trusted at that moment, because the gesture's first click rolls
 * the build back to the sketch, which drops its geometry out of scope and
 * flips an unconsumed sketch to `visible: false`. The full-build snapshot is
 * stable across that rollback.
 */
const sketchConsumedByKey = new Map<string, boolean>();

function sketchLocKey(loc: { filePath: string; line: number; column: number }): string {
  return `${loc.filePath}:${loc.line}:${loc.column}`;
}

/**
 * Parse the double-clicked row's statement and open the matching dialog in
 * edit mode. The row index and its exact statement text ride along: the
 * edit session rolls the viewport back to just before that row (the world
 * the statement's arguments see, where its sources can be re-picked) and
 * the text guards the apply against code that drifted mid-session.
 * Statements the dialogs can't faithfully represent (variable dimensions,
 * unrecognized chains) surface the parse refusal as a toast and leave the
 * plain breakpoint behavior in place.
 */
async function openFeatureEditor(obj: SceneObjectRender, index: number): Promise<void> {
  if (obj.type === 'sketch' && obj.sourceLocation) {
    enterSketchEdit(obj.sourceLocation);
    return;
  }
  if (!obj.type || !EDITABLE_ROW_TYPES.has(obj.type) || !obj.sourceLocation) {
    return;
  }
  const target = obj.sourceLocation;
  // A pause-before row (offset, slot, 2D copy) deferred the double-click's
  // breakpoint so the parse above reads the unshifted buffer; every outcome
  // except that row's own dialog owes the gesture its classic
  // after-the-statement pause.
  const deferredBreakpoint = (obj.type != null && PAUSE_BEFORE_ROW_TYPES.has(obj.type))
    || isCopy2DRow(obj);
  const result = await parseFeatureAt(target);
  if (result.ok === false) {
    if (deferredBreakpoint) {
      addBreakpoint(target);
    }
    showEditRefusal(result.reason);
    return;
  }
  if (deferredBreakpoint && result.parsed.feature !== 'offset' && result.parsed.feature !== 'slot'
    && result.parsed.feature !== 'fillet' && !(result.parsed.feature === 'copy' && isCopy2DRow(obj))) {
    addBreakpoint(target);
  }
  if (result.parsed.feature === 'sketch') {
    // The row's line holds a sketch(), not the feature the row's type
    // suggested: a statement can register objects of another type at its own
    // call site — `sketch('xy', …)` builds itself a plane. The statement is
    // what the dialogs edit, so it opens as the sketch it is (the breakpoint
    // the gesture placed already landed after it).
    enterSketchEdit(target);
    return;
  }
  const info = { index, type: obj.type, expectedStatement: result.statement };
  const parsed = result.parsed;
  if (parsed.feature === 'extrude') {
    extrudeService.enterEdit(target, parsed, info);
  } else if (parsed.feature === 'rib') {
    ribService.enterEdit(target, parsed, info);
  } else if (parsed.feature === 'revolve') {
    revolveService.enterEdit(target, parsed, info);
  } else if (parsed.feature === 'sweep') {
    sweepService.enterEdit(target, parsed, info);
  } else if (parsed.feature === 'wrap') {
    wrapService.enterEdit(target, parsed, info);
  } else if (parsed.feature === 'loft') {
    loftService.enterEdit(target, parsed, info);
  } else if (parsed.feature === 'helix') {
    helixService.enterEdit(target, parsed, info);
  } else if (parsed.feature === 'text') {
    textEditService.enterEdit(target, parsed, info);
  } else if (parsed.feature === 'repeat') {
    repeatService.enterEdit(target, parsed, info);
  } else if (parsed.feature === 'copy') {
    if (isCopy2DRow(obj)) {
      // A 2D copy lives inside a sketch body and edits on the sketch rails —
      // the offset edit's pause-before contract, its originals visible and
      // re-pickable in the paused sketch.
      closeFeatureDialogs();
      pauseBeforeSketchStatement(obj, index);
      sketchService.enterCopyEdit(target, parsed, result.statement);
    } else {
      copyService.enterEdit(target, parsed, info);
    }
  } else if (parsed.feature === 'mirror') {
    // Only 3D `mirror()` rows reach here — isFeatureEditable filters the
    // in-sketch form (mirror-shape-2d) out, and `repeat('mirror', …)` rows
    // parse as feature 'repeat' above.
    mirrorService.enterEdit(target, parsed, info);
  } else if (parsed.feature === 'rotate') {
    // Only 3D `rotate()` rows reach here — isFeatureEditable filters the
    // in-sketch form (rotate-shape-2d) out, and `repeat('rotate', …)` rows
    // parse as feature 'repeat' above.
    rotateService.enterEdit(target, parsed, info);
  } else if (parsed.feature === 'boolean') {
    booleanService.enterEdit(target, parsed, info);
  } else if (parsed.feature === 'plane') {
    planeService.enterEdit(target, parsed, info);
  } else if (parsed.feature === 'connector') {
    // The row carries the connector's built frame — the dialog's live gizmo
    // recovers the anchor it stands on from it, so the rotation and offset
    // fields preview even before the source is re-picked. A connector whose
    // build failed serializes only its name; the dialog opens ghost-less.
    const data = obj.object as ConnectorData | undefined;
    const frame = data?.origin && data.xDirection && data.yDirection && data.normal ? data : null;
    connectorService.enterEdit(target, parsed, info, frame);
  } else if (parsed.feature === 'offset') {
    const parentSketch = viewer.currentSceneObjects.find(o =>
      o.id != null && o.id === obj.parentId && o.type === 'sketch');
    if (parentSketch) {
      // A 2D op lives inside a sketch body: pausing the build just BEFORE its
      // statement puts the sketch its arguments see on screen — the offset's
      // result absent, a removed original visible and re-pickable — the 2D
      // counterpart of EditSession's pre-statement rollback.
      closeFeatureDialogs();
      pauseBeforeSketchStatement(obj, index);
      sketchService.enterOffsetEdit(target, parsed, result.statement, { insideSketch: true });
    } else {
      // A top-level (face-target) offset edits on the modify rails like
      // fillet/shell — real 3D face re-picking against the pre-statement
      // rollback. The gesture owes the classic after-the-statement pause the
      // timeline deferred for offset rows.
      addBreakpoint(target);
      modifyService.enterEdit(target, parsed, info);
    }
  } else if (parsed.feature === 'slot') {
    // Same pause-before contract as the offset edit: the slot's consumed
    // source edge is visible and re-pickable in the paused sketch.
    closeFeatureDialogs();
    pauseBeforeSketchStatement(obj, index);
    sketchService.enterSlotEdit(target, parsed, result.statement);
  } else if (parsed.feature === 'fillet' && obj.type === 'fillet2d') {
    // A fillet statement parses identically in 2D and 3D — the row's type
    // tells them apart. The 2D one follows the offset's pause-before
    // contract: the paused sketch shows the corners before their arcs.
    closeFeatureDialogs();
    pauseBeforeSketchStatement(obj, index);
    sketchService.enterFilletEdit(target, parsed, result.statement);
  } else if (parsed.feature === 'project') {
    // A projection lives inside a sketch body but reads the 3D scene before
    // it: its edit session rolls the viewport back to just before its row
    // (the fillet/chamfer edit pattern) — the projected edges absent, the
    // statement's sources highlighted and re-pickable in the free 3D view.
    // keepProjection: an already-editing projection dialog must not be
    // cancelled here (that would clear the breakpoint the double-click just
    // placed) — its own re-entry closes it.
    closeFeatureDialogs({ keepProjection: true });
    sketchService.enterProjectionEdit(target, parsed, info);
  } else {
    // What's left of the parse union: the shell/fillet/chamfer dialog's.
    modifyService.enterEdit(target, parsed, info);
  }
}

/**
 * Pause the build just before a sketch-body statement: the breakpoint goes
 * after the previous statement in the same sketch, so the paused sketch shows
 * what that statement's arguments see. The statement itself shifts down with
 * the inserted `breakpoint();` line — the apply route re-locates it by its
 * captured text (see resolveEditedStatementLine, server side). With no
 * previous sibling the pause degrades to the classic after-the-statement spot.
 */
function pauseBeforeSketchStatement(obj: SceneObjectRender, index: number): void {
  const objects = viewer.currentSceneObjects;
  const line = obj.sourceLocation!.line;
  for (let i = index - 1; i >= 0; i--) {
    const prev = objects[i];
    // A same-line sibling is the statement's own argument registering under
    // its call site — the select a `project(b.endFaces())` spawns — and a
    // breakpoint after it would land after the statement itself.
    if (prev?.parentId != null && prev.parentId === obj.parentId && prev.sourceLocation
      && prev.sourceLocation.line < line) {
      addBreakpoint(prev.sourceLocation);
      return;
    }
  }
  addBreakpoint(obj.sourceLocation!);
}

/**
 * Close the create-feature dialogs. A 2D op dialog docks in the same spot and
 * owns the viewport the same way, so opening one has to clear them — but not
 * the sketch dialog, which it only suspends (`onOpDialogToggle`) and hands
 * back when it closes. A modify pick armed over the old scene retires itself
 * once the render that brings the sketch in arrives.
 */
function closeFeatureDialogs(opts: { keepProjection?: boolean } = {}): void {
  if (!opts.keepProjection) {
    projectionService.exit({ resume: 'lazy' });
  }
  extrudeService.exit();
  ribService.exit();
  revolveService.exit();
  helixService.exit();
  sweepService.exit();
  loftService.exit();
  wrapService.exit();
  repeatService.exit();
  copyService.exit();
  mirrorService.exit();
  rotateService.exit();
  booleanService.exit();
  connectorService.exit();
  planeService.exit();
  textEditService.exit();
  measureController.clearSelection();
  viewer.clearHighlight();
  selectionInfoOverlay.hide();
}

/**
 * Open a sketch statement for editing. Sketch has no edit dialog of its own:
 * the double-click's breakpoint truncates the build at the sketch, and the
 * sketch dialog adopts the render that ends in it. Flag that adoption as the
 * edit it is, so the dialog owns the breakpoint and its close leaves the
 * statement alone. Whether a later feature consumes the sketch (Finish Sketch
 * just removes the breakpoint) or not (offer the grid) comes from the last
 * complete build's snapshot, not the row — the gesture's own rollback has
 * already flipped its `visible` by dropping its geometry out of scope.
 */
function enterSketchEdit(loc: { filePath: string; line: number; column: number }): void {
  const row = viewer.currentSceneObjects.find(o =>
    o.type === 'sketch' && o.sourceLocation && sketchLocKey(o.sourceLocation) === sketchLocKey(loc));
  const consumed = sketchConsumedByKey.get(sketchLocKey(loc))
    ?? (row?.visible === false || row?.reusable === true);
  modifyService.noteSketchEditRequest(loc, consumed);
}

// Transient toast for edit-dialog refusals — there is no dialog to carry the
// message yet when the double-clicked statement can't be edited.
let editRefusalToast: HTMLDivElement | null = null;
let editRefusalTimer: number | null = null;

function showEditRefusal(reason: string): void {
  showActionToast(`Can't edit this feature in a dialog: ${reason}`);
}

/** The same transient toast for one-shot tool refusals (the Part button). */
function showActionToast(message: string): void {
  if (!editRefusalToast) {
    editRefusalToast = document.createElement('div');
    // Below the constraint mini bar (top-[106px]) so refusals don't cover it.
    editRefusalToast.className = 'absolute top-[152px] left-1/2 -translate-x-1/2 z-[1003] max-w-[440px] '
      + 'bg-base-100 border border-base-300 text-base-content rounded-lg px-3 py-2 text-xs leading-snug shadow-md';
    container.appendChild(editRefusalToast);
  }
  editRefusalToast.textContent = message;
  editRefusalToast.classList.remove('hidden');
  if (editRefusalTimer !== null) {
    window.clearTimeout(editRefusalTimer);
  }
  editRefusalTimer = window.setTimeout(() => {
    editRefusalTimer = null;
    editRefusalToast?.classList.add('hidden');
  }, 5000);
}
const sketchService = new SketchToolbarService(container, viewer, trimService, projectionService, navbar);
const modifyService = new ModifyPickService(container, viewer, navbar, {
  // Hand the current highlight over as the tool's initial input: whatever the
  // user already clicked (measure owns that selection) seeds the pick set.
  onEnter: () => {
    projectionService.exit({ resume: 'lazy' });
    extrudeService.exit();
    ribService.exit();
    revolveService.exit();
    helixService.exit();
    sweepService.exit();
    loftService.exit();
    repeatService.exit();
    copyService.exit();
    mirrorService.exit();
    rotateService.exit();
    booleanService.exit();
    connectorService.exit();
    planeService.exit();
    textEditService.exit();
    const seed = [...measureController.selection];
    measureController.clearSelection();
    selectionInfoOverlay.hide();
    return seed;
  },
  // Sketch-on-face armed from inside a sketch: the sketch toolbar and tools
  // release input while faces are picked, and return if the pick is cancelled.
  onSuspendSketchUI: suspendSketchForFeature,
  onResumeSketchUI: resumeSketchForFeature,
  // Snap options live in the sketch dialog; the toolbar service owns the
  // state and pushes changes into the live tools' snap controllers.
  onSnapVerticesChange: (checked) => sketchService.setSnapToVertices(checked),
  onSnapGridChange: (checked) => sketchService.setSnapToGrid(checked),
});
// The dialogs dock at top-[196px] right-4: the sketch dialog steps aside
// while a 2D op dialog (fillet, offset) is open and returns when it closes.
sketchService.onOpDialogToggle = (open) => modifyService.setSketchPanelSuspended(open);
// The Part tool appends an empty part() statement — constructed after the
// modify service so its button prepends ahead of Sketch. The fresh part
// becomes the active part on the render that carries it, so the next
// sketch/plane lands inside its callback body.
const partTool = new PartToolButton(navbar, {
  onCreated: () => activePartTracker.activateLastOnNextRender(),
  onRefused: (reason) => showActionToast(reason),
});
// Constructed after the modify service so its solo navbar group registers
// after every other tool group — the Repeat button renders last, behind the
// separator the navbar draws between visible groups.
const repeatService = new RepeatFeatureService(container, viewer, navbar, {
  // The current selection state seeds the dialog: a pending plane or one
  // face opens the Mirror type with it as the plane, one edge the Linear type
  // with it as the axis. Captured before the exits below clear it.
  onEnter: () => {
    projectionService.exit({ resume: 'lazy' });
    modifyService.displaceSketchSession();
    const pendingPlaneShapeId = modifyService.pendingPlane;
    modifyService.exit();
    extrudeService.exit();
    ribService.exit();
    revolveService.exit();
    helixService.exit();
    sweepService.exit();
    loftService.exit();
    wrapService.exit();
    copyService.exit();
    mirrorService.exit();
    rotateService.exit();
    booleanService.exit();
    connectorService.exit();
    planeService.exit();
    const seed = [...measureController.selection];
    textEditService.exit();
    measureController.clearSelection();
    modifyService.clearPendingPlane();
    viewer.clearHighlight();
    selectionInfoOverlay.hide();
    return { seed, pendingPlaneShapeId };
  },
  onActiveChange: syncSketchButtonBlocked,
  onSuspendSketchUI: suspendSketchForFeature,
  onResumeSketchUI: resumeSketchForFeature,
});
// Constructed after the repeat service so the two solid-level replay buttons
// sit together at the end of the bar (…, Repeat, Copy).
const copyService = new CopyFeatureService(container, viewer, navbar, {
  // The current selection seeds the dialog: every selected face/edge
  // resolves to its owning solid, opening as a target chip. Captured before
  // the exits below clear it.
  onEnter: () => {
    projectionService.exit({ resume: 'lazy' });
    modifyService.displaceSketchSession();
    modifyService.exit();
    extrudeService.exit();
    ribService.exit();
    revolveService.exit();
    helixService.exit();
    sweepService.exit();
    loftService.exit();
    wrapService.exit();
    repeatService.exit();
    mirrorService.exit();
    rotateService.exit();
    booleanService.exit();
    connectorService.exit();
    planeService.exit();
    const seed = [...measureController.selection];
    textEditService.exit();
    measureController.clearSelection();
    modifyService.clearPendingPlane();
    viewer.clearHighlight();
    selectionInfoOverlay.hide();
    return { seed };
  },
  onActiveChange: syncSketchButtonBlocked,
  onSuspendSketchUI: suspendSketchForFeature,
  onResumeSketchUI: resumeSketchForFeature,
});
// Constructed after the copy service so the transform group registers next
// (…, Repeat, Copy, | separator |, Mirror) — the first of the transform
// tools; siblings join it ahead of the boolean group.
const mirrorService = new MirrorFeatureService(container, viewer, navbar, {
  // The current selection state seeds the dialog: every selected face/edge
  // resolves to its owning solid, opening as a target chip, and a pending
  // plane fills the plane slot. Captured before the exits below clear it.
  onEnter: () => {
    projectionService.exit({ resume: 'lazy' });
    modifyService.displaceSketchSession();
    const pendingPlaneShapeId = modifyService.pendingPlane;
    modifyService.exit();
    extrudeService.exit();
    ribService.exit();
    revolveService.exit();
    helixService.exit();
    sweepService.exit();
    loftService.exit();
    wrapService.exit();
    repeatService.exit();
    copyService.exit();
    rotateService.exit();
    booleanService.exit();
    connectorService.exit();
    planeService.exit();
    const seed = [...measureController.selection];
    textEditService.exit();
    measureController.clearSelection();
    modifyService.clearPendingPlane();
    viewer.clearHighlight();
    selectionInfoOverlay.hide();
    return { seed, pendingPlaneShapeId };
  },
  onActiveChange: syncSketchButtonBlocked,
  onSuspendSketchUI: suspendSketchForFeature,
  onResumeSketchUI: resumeSketchForFeature,
});
// Constructed after the mirror service so the two transform tools sit
// together in one group (…, Repeat, Copy, | Mirror, Rotate).
const rotateService = new RotateFeatureService(container, viewer, navbar, {
  // The current selection seeds the dialog: every selected face/edge
  // resolves to its owning solid, opening as a target chip. Captured before
  // the exits below clear it.
  onEnter: () => {
    projectionService.exit({ resume: 'lazy' });
    modifyService.displaceSketchSession();
    modifyService.exit();
    extrudeService.exit();
    ribService.exit();
    revolveService.exit();
    helixService.exit();
    sweepService.exit();
    loftService.exit();
    wrapService.exit();
    repeatService.exit();
    copyService.exit();
    mirrorService.exit();
    booleanService.exit();
    connectorService.exit();
    planeService.exit();
    const seed = [...measureController.selection];
    textEditService.exit();
    measureController.clearSelection();
    modifyService.clearPendingPlane();
    viewer.clearHighlight();
    selectionInfoOverlay.hide();
    return { seed };
  },
  onActiveChange: syncSketchButtonBlocked,
  onSuspendSketchUI: suspendSketchForFeature,
  onResumeSketchUI: resumeSketchForFeature,
});
// Constructed after the transform services so its own navbar group registers
// after theirs (…, | Mirror, Rotate, | separator |, Boolean).
const booleanService = new BooleanFeatureService(container, viewer, navbar, {
  // The current selection seeds the dialog: every selected face/edge
  // resolves to its owning solid, opening as a target chip. Captured before
  // the exits below clear it.
  onEnter: () => {
    projectionService.exit({ resume: 'lazy' });
    modifyService.displaceSketchSession();
    modifyService.exit();
    extrudeService.exit();
    ribService.exit();
    revolveService.exit();
    helixService.exit();
    sweepService.exit();
    loftService.exit();
    wrapService.exit();
    repeatService.exit();
    copyService.exit();
    mirrorService.exit();
    rotateService.exit();
    connectorService.exit();
    planeService.exit();
    const seed = [...measureController.selection];
    textEditService.exit();
    measureController.clearSelection();
    modifyService.clearPendingPlane();
    viewer.clearHighlight();
    selectionInfoOverlay.hide();
    return { seed };
  },
  onActiveChange: syncSketchButtonBlocked,
  onSuspendSketchUI: suspendSketchForFeature,
  onResumeSketchUI: resumeSketchForFeature,
});

// The Offset button's group renders right after the boolean group — navbar
// groups sit in registration order, so it mounts here.
modifyService.mountOffsetButton();

// Constructed after every other part-mode tool — the connector is assembly
// prep rather than modelling, so its group registers last and the Connector
// button sits at the very end of the bar (…, | Boolean, | Offset, | Connector).
const connectorService = new ConnectorFeatureService(container, viewer, navbar, {
  onEnter: () => {
    projectionService.exit({ resume: 'lazy' });
    modifyService.displaceSketchSession();
    modifyService.exit();
    extrudeService.exit();
    ribService.exit();
    revolveService.exit();
    helixService.exit();
    sweepService.exit();
    loftService.exit();
    wrapService.exit();
    repeatService.exit();
    copyService.exit();
    mirrorService.exit();
    rotateService.exit();
    booleanService.exit();
    planeService.exit();
    textEditService.exit();
    measureController.clearSelection();
    modifyService.clearPendingPlane();
    viewer.clearHighlight();
    selectionInfoOverlay.hide();
  },
  onActiveChange: syncSketchButtonBlocked,
  onSuspendSketchUI: suspendSketchForFeature,
  onResumeSketchUI: resumeSketchForFeature,
});

// While a sketch is active, the create-feature buttons collapse into a single
// "Finish Sketch" button whose popup grid mirrors them and delegates clicks
// straight back to them. Constructed after every create service so its button
// prepends ahead of theirs; only the mirrored buttons hide, so Shell (a modify
// tool that also lives in the create group) stays reachable alongside it.
const finishSketchMenu = new FinishSketchMenu(navbar.getGroup('create')!, [
  { button: extrudeService.toolbarButton },
  { button: ribService.toolbarButton },
  { button: revolveService.toolbarButton },
  { button: sweepService.toolbarButton },
  { button: loftService.toolbarButton },
  { button: wrapService.toolbarButton },
  { button: planeService.toolbarButton },
  {
    button: modifyService.sketchButton,
    label: 'New Sketch',
    reflectActive: false,
    onClick: () => modifyService.startNewSketch(),
  },
  // New Part finishes the sketch implicitly: the appended part() statement
  // takes the tip of the timeline, so the sketch is no longer active.
  {
    button: partTool.button,
    label: 'New Part',
    reflectActive: false,
  },
]);
sketchService.onActiveChange = (active) => finishSketchMenu.setConsolidated(active);
// Editing a consumed sketch (double-click → breakpoint): finishing removes the
// breakpoint so the downstream feature re-applies with the edits, rather than
// turning the sketch into a new feature.
finishSketchMenu.onResume = () => modifyService.finishSketchEdit();

const breakpointIndicator = new BreakpointIndicator(container, () => {
  if (regionService.state === 'picking-active') {
    regionService.exit();
  }
  if (trimService.state === 'picking-active') {
    trimService.exit();
  }
  // Continue leaves the paused build: open edit sessions end WITHOUT their
  // cancel-restore rollback — the full render Continue triggers supersedes
  // it, and a session re-assert would fight the view the user asked for.
  for (const service of [modifyService, extrudeService, ribService, revolveService, sweepService, wrapService, loftService, helixService, repeatService, copyService, mirrorService, rotateService, booleanService, planeService, connectorService]) {
    if (service.isEditing) {
      service.exit({ editEnd: 'continue' });
    }
  }
  if (textEditService.isActive) {
    textEditService.exit('continue');
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
  // Occurrence-owned instances' sourceLocations point into the sub-assembly's
  // own file, and their pose there is local to the occurrence frame — never
  // write this view's world pose there. Live-only, like mated bodies.
  if (inst.owner) {
    return;
  }
  updateInsertChain(inst.sourceLocation, {
    translate: [position.x, position.y, position.z],
  });
});

viewer.setDragValueHandler((readout) => {
  if (currentRail?.kind !== 'assembly') return;
  currentRail.dragReadout.update(readout);
});

// The assembly transform gizmo: click a non-locked part to attach the triad,
// drag/typed commits rewrite the insert() chain via /api/instance-pose.
const assemblyGizmo = new AssemblyGizmoDriver({
  viewer,
  container,
  findInstance,
  instanceHasMate,
  applyInstancePose,
  getPoseExpressions: getInstancePoseExpressions,
  fetchScopeVariables: (sourceLine) => getScopeVariables(sourceLine),
  flashError: (message) => {
    if (currentRail?.kind === 'assembly') {
      currentRail.dragReadout.flashError(message);
    }
  },
});

// The mate dialog: a toolbar mate button opens it armed for connector
// picking; apply writes the mate() statement via /api/assembly-mate.
const assemblyMateService = new AssemblyMateService(container, viewer, {
  getAssembly: () => lastAssemblyPayload,
  onEnter: () => {
    // The dialog owns the viewport: dismiss the transform gizmo and any
    // face/edge selection so picks read unambiguously as connector picks.
    assemblyGizmo.handleSelection(null);
    viewer.clearHighlight();
    viewer.clearInstanceHighlight();
    selectionInfoOverlay.hide();
  },
  onExit: () => connectorPropsEditor.close(),
  // The pen on a picked chip: the connector's own property editor, docked
  // beside the mate dialog, editing the connector() statement in its part
  // file.
  onEditConnector: (state) => void connectorPropsEditor.open(state),
});
const connectorPropsEditor = new ConnectorPropsEditor(container, viewer, {
  onRenamed: (slot, newName) => assemblyMateService.noteConnectorRenamed(slot, newName),
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

function formatMateLabel(mate: SerializedAssembly['mates'][number]): string {
  if (mate.geometryA && mate.geometryB) {
    const a = mate.geometryA;
    const b = mate.geometryB;
    return `${mate.type} — ${a.instanceId}.${a.exposeName} ↔ ${b.instanceId}.${b.exposeName}`;
  }
  const a = mate.connectorA;
  const b = mate.connectorB;
  return `${mate.type} — ${a?.instanceId}.${a?.connectorId} ↔ ${b?.instanceId}.${b?.connectorId}`;
}

// An armed modify mode (fillet/chamfer) owns hover (teach-mode tooltip) and
// right-click (tangent-chain selection).
viewer.setHoverHandler((shapeId, sub, clientX, clientY) => {
  if (modifyService.isActive) {
    modifyService.handleHover(shapeId, sub, clientX, clientY);
  } else if (connectorService.isActive) {
    // The armed connector tool floats its anchor suggestion at the hovered
    // face/edge — the gizmo nearest the cursor.
    connectorService.handleHover(shapeId, sub, clientX, clientY);
  }
});

// A dialog only owns the viewport while it consumes picks. Edit sessions
// own picking like create mode (their slots re-pick against the rolled-back
// scene) — except extrude, whose profile comes from dropdown/timeline/wire
// clicks only; its face clicks are consumed (in both modes) only while the
// dialog's direction is "Up to face".
const createDialogPicking = () =>
  (extrudeService.isActive && !extrudeService.isEditing)
  || extrudeService.isFacePicking
  || ribService.isPicking
  || revolveService.isAxisPicking
  || (sweepService.isActive && !sweepService.isEditing)
  || sweepService.isEdgePicking
  || wrapService.isFacePicking
  || loftService.isFacePicking
  || helixService.isPicking
  || repeatService.isPicking
  || copyService.isPicking
  || mirrorService.isPicking
  || rotateService.isPicking
  || connectorService.isPicking
  || booleanService.isPicking
  || planeService.isPicking
  || projectionService.isPicking;

viewer.setContextMenuHandler((shapeId, sub, clientX, clientY) => {
  if (modifyService.isActive) {
    modifyService.handleContextMenu(shapeId, sub, clientX, clientY);
  } else if (sweepService.isEdgePicking) {
    sweepService.handleContextMenu(shapeId, sub, clientX, clientY);
  } else if (projectionService.isPicking) {
    // The armed Project tool filters its picks through the same menu as the
    // modify tools — right-click an edge for its tangent chain or bucket.
    projectionService.handleContextMenu(shapeId, sub, clientX, clientY);
  } else if (!createDialogPicking() && !shapePropertiesModal.isOpen) {
    // Neutral mode: the multi-select menu accumulates a measure selection,
    // which seeds the modify tools when one arms.
    measureController.handleContextMenu(shapeId, sub, clientX, clientY);
  }
});

viewer.setDoubleClickHandler((shapeId, sub) => {
  if (modifyService.isActive) {
    modifyService.handleDoubleClick(shapeId, sub);
  } else if (sweepService.isEdgePicking) {
    sweepService.handleDoubleClick(shapeId, sub);
  }
});

viewer.setSelectionHandler((shapeId, sub, instanceId, modifiers) => {
  // Assembly mode: instance-aware viewport selection drives the parts/joints
  // panels; the part-design pick services and measure tool aren't active here.
  if (currentRail?.kind === 'assembly') {
    // The armed mate dialog owns every viewport click: connector picks fill
    // its slots; nothing below (gizmo attach, face highlight) may run.
    if (assemblyMateService.isPicking) {
      assemblyMateService.handleClick(shapeId, sub, instanceId);
      return;
    }
    if (shapeId) {
      if (sub?.type === 'face') {
        viewer.highlightFace(shapeId, sub.index, instanceId);
      } else if (sub?.type === 'edge') {
        viewer.highlightEdge(shapeId, sub.index, instanceId);
      } else {
        viewer.clearHighlight();
      }
      // One click on a part attaches the transform gizmo at its origin
      // (non-locked instances only; the driver decides).
      assemblyGizmo.handleSelection(instanceId);
    } else if (instanceId) {
      // Instance-only selection: a plain click on a draggable part. The
      // assembly controller claims every pointerdown on those, so no face
      // pick ever arrives — the id alone attaches the gizmo.
      assemblyGizmo.handleSelection(instanceId);
    } else {
      // Click in empty 3D space — clear face/edge selection AND the
      // parts/joints panel-driven instance tint so the user has a clean
      // way to deselect a row.
      viewer.clearHighlight();
      viewer.clearInstanceHighlight();
      currentRail.parts.setSelected(null);
      currentRail.joints.setSelected(null);
      assemblyGizmo.handleSelection(null);
    }
    shapePropertiesModal.setSelectedShape(shapeId);
    if (shapeId !== null && sub !== null && (sub.type === 'face' || sub.type === 'edge')) {
      if (sub.type === 'face') {
        selectionInfoOverlay.showForFace(shapeId, sub.index);
      } else {
        selectionInfoOverlay.showForEdge(shapeId, sub.index);
      }
    } else {
      selectionInfoOverlay.hide();
    }
    return;
  }
  // The armed Project sketch tool owns every viewport click: each edge or
  // face pick toggles into the set of sources its sketch projects.
  if (projectionService.isPicking) {
    projectionService.handleClick(shapeId, sub);
    return;
  }
  // A sketch-wire pick exists only while a create dialog is armed (the
  // dialogs enable viewer.pickSketchWires) — it selects that sketch as the
  // dialog's input and never reaches the measure selection.
  if (sub?.type === 'sketch') {
    if (shapeId) {
      const consumed = extrudeService.handleSketchPick(shapeId)
        || ribService.handleSketchPick(shapeId)
        || revolveService.handleSketchPick(shapeId)
        || sweepService.handleSketchPick(shapeId)
        || wrapService.handleSketchPick(shapeId)
        || loftService.handleSketchPick(shapeId)
        // The plane dialog's From-edge type takes a single-curve sketch as
        // the edge its plane is normal to.
        || planeService.handleSketchPick(shapeId);
      if (consumed) {
        return;
      }
    }
    return;
  }
  // An axis-line pick exists only while the revolve or repeat dialog is
  // armed (they enable viewer.pickAxes) — it selects that axis statement.
  if (sub?.type === 'axis') {
    if (repeatService.isAxisPicking) {
      repeatService.handleClick(shapeId, sub);
    } else if (copyService.isAxisPicking) {
      copyService.handleClick(shapeId, sub);
    } else if (rotateService.isAxisPicking) {
      rotateService.handleClick(shapeId, sub);
    } else if (helixService.isAxisPicking) {
      helixService.handleClick(shapeId, sub);
    } else {
      revolveService.handleClick(shapeId, sub);
    }
    return;
  }
  // A plane-quad pick exists while the sketch mode is armed (sketch on that
  // plane right away), while the repeat dialog's Mirror type is up (the quad
  // is the mirror plane), while the plane dialog's offset/mid types are up
  // (the quad is a base), or in neutral mode (hold it as the pending sketch
  // plane — the Sketch button consumes it). Never part of the measure set.
  if (sub?.type === 'plane') {
    if (shapeId) {
      if (repeatService.isPlanePicking) {
        repeatService.handlePlanePick(shapeId);
        return;
      }
      if (mirrorService.isPlanePicking) {
        mirrorService.handlePlanePick(shapeId);
        return;
      }
      if (planeService.isPlanePicking) {
        planeService.handlePlanePick(shapeId);
        return;
      }
      if (!modifyService.isActive) {
        measureController.clearSelection();
        selectionInfoOverlay.hide();
      }
      modifyService.handlePlanePick(shapeId);
    }
    return;
  }
  // Any other click drops a neutral-mode pending plane.
  modifyService.clearPendingPlane();
  // An armed modify mode (fillet/chamfer/shell) owns clicks outright, edit
  // sessions included — re-picking is the point of the rolled-back view.
  if (modifyService.isActive) {
    modifyService.handleClick(shapeId, sub);
    return;
  }
  // The sweep dialog's live path picking owns edge clicks the same way.
  if (sweepService.isEdgePicking) {
    sweepService.handleClick(shapeId, sub);
    return;
  }
  // The armed revolve dialog owns edge clicks — the pick is the axis edge.
  if (revolveService.isAxisPicking) {
    revolveService.handleClick(shapeId, sub);
    return;
  }
  // The extrude dialog owns face clicks while its direction is "Up to face"
  // — the pick is the extrusion's target face.
  if (extrudeService.isFacePicking) {
    extrudeService.handleClick(shapeId, sub);
    return;
  }
  // The armed wrap dialog owns face clicks — the pick is the target face.
  if (wrapService.isFacePicking) {
    wrapService.handleClick(shapeId, sub);
    return;
  }
  // The armed loft dialog owns face clicks — each pick is one profile.
  if (loftService.isFacePicking) {
    loftService.handleClick(shapeId, sub);
    return;
  }
  // The armed helix dialog owns edge clicks (axis mode) and face clicks (face
  // mode) — the pick is the helix's source.
  if (helixService.isPicking) {
    helixService.handleClick(shapeId, sub);
    return;
  }
  // The armed repeat dialog owns clicks — an edge is the repeat axis, a
  // face (Mirror type) the mirror plane.
  if (repeatService.isPicking) {
    repeatService.handleClick(shapeId, sub);
    return;
  }
  // The armed copy dialog owns clicks — a face or edge selects its whole
  // solid as a target, or (axis slot armed) an edge is the copy axis.
  if (copyService.isPicking) {
    copyService.handleClick(shapeId, sub);
    return;
  }
  // The armed mirror dialog owns clicks — a face or edge selects its whole
  // solid as a target, or (plane slot armed) a face is the mirror plane.
  if (mirrorService.isPicking) {
    mirrorService.handleClick(shapeId, sub);
    return;
  }
  // The armed rotate dialog owns clicks — a face or edge selects its whole
  // solid as a target, or (axis slot armed) an edge is the rotation axis.
  if (rotateService.isPicking) {
    rotateService.handleClick(shapeId, sub);
    return;
  }
  // The armed connector tool owns clicks — a face or edge locks its floated
  // anchor suggestion into the dialog's source slot.
  if (connectorService.isPicking) {
    connectorService.handleClick(shapeId, sub);
    return;
  }
  // The armed boolean dialog owns clicks — a face or edge selects its whole
  // solid into the armed target slot.
  if (booleanService.isPicking) {
    booleanService.handleClick(shapeId, sub);
    return;
  }
  // The armed rib dialog owns clicks — a face or edge selects its whole
  // solid into the scope slot.
  if (ribService.isPicking) {
    ribService.handleClick(shapeId, sub);
    return;
  }
  // The armed plane dialog owns clicks while a base slot is in pick mode.
  if (planeService.isPicking) {
    planeService.handleClick(shapeId, sub);
    return;
  }

  if (shapePropertiesModal.isOpen) {
    measureController.clearSelection();
    // The shared whole-solid picker: any face or edge click selects (and
    // highlights) the owning shape whole — the copy dialog's targets slot
    // rides the same component in multiple mode.
    propertiesSolidPick.handleClick(shapeId);
    shapePropertiesModal.setSelectedShape(propertiesSolidPick.first);
    selectionInfoOverlay.hide();
    return;
  }

  // The measure controller owns the selection set (plain click replaces,
  // ctrl/shift-click accumulates, right-click menu merges groups) and the
  // matching viewer highlights; onSelectionChanged reflects every change
  // into the info overlay and the properties modal.
  measureController.handleClick(shapeId, sub, modifiers.additive);
});

measureController.onSelectionChanged = (selection) => {
  // The Offset toolbar button shows exactly while a face is highlighted.
  modifyService.noteNeutralSelection(selection);
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
};

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

/**
 * The scope-sensitive service cascade every scene render runs (and a
 * timeline part-row click replays — see {@link refreshActivePartScope}):
 * the trim/region pick triggers, the sketch toolbar, and each dialog
 * service's own scene handling, in the order the services expect.
 */
function runSceneServices(result: SceneObjectRender[], renderStop: number, isRollback: boolean): void {
  if (isRollback) {
    trimService.reset();
    regionService.reset();
    sketchService.update([]);
  } else {
    trimService.update(result);
    regionService.update(result);
    // While a pick mode has sketch editing suspended, the sketch
    // toolbar must not re-take the bar on incoming renders. An open
    // projection EDIT counts too (its session owns the rolled-back
    // view); the create-armed Project tool does not — its sketch
    // staying in the scene is what keeps it armed.
    const sketchSuspended = modifyService.sketchUISuspended
      || sweepService.sketchUISuspended || wrapService.sketchUISuspended
      || loftService.sketchUISuspended || repeatService.sketchUISuspended
      || copyService.sketchUISuspended || mirrorService.sketchUISuspended
      || rotateService.sketchUISuspended || booleanService.sketchUISuspended
      || planeService.sketchUISuspended || extrudeService.sketchUISuspended
      || ribService.sketchUISuspended
      || revolveService.sketchUISuspended || helixService.sketchUISuspended
      || projectionService.isEditing
      || textEditService.isActive;
    sketchService.update(sketchSuspended ? [] : result);
  }
  // The edit-capable services see every render: an open edit session
  // keeps the view rolled back to just before its statement and
  // rebuilds options/seeds at that boundary; without one this is the
  // plain update (empty list on rollbacks, as before).
  modifyService.handleSceneRendered(result, renderStop, isRollback);
  // The projection service sees every render: an open edit session
  // keeps the view rolled back to just before its statement and
  // re-seeds its sources there; without one, a (non-rollback) render
  // drops an armed tool's now-unaddressable picks.
  projectionService.handleSceneRendered(result, renderStop, isRollback);
  // Once the modify service has (re)adopted the active sketch for this
  // render, the Finish Sketch button knows whether it should offer the
  // grid or just remove the breakpoint (editing a consumed sketch).
  finishSketchMenu.setResumeMode(modifyService.isEditingConsumedSketch);
  extrudeService.handleSceneRendered(result, renderStop, isRollback);
  ribService.handleSceneRendered(result, renderStop, isRollback);
  revolveService.handleSceneRendered(result, renderStop, isRollback);
  sweepService.handleSceneRendered(result, renderStop, isRollback);
  wrapService.handleSceneRendered(result, renderStop, isRollback);
  loftService.handleSceneRendered(result, renderStop, isRollback);
  helixService.handleSceneRendered(result, renderStop, isRollback);
  repeatService.handleSceneRendered(result, renderStop, isRollback);
  copyService.handleSceneRendered(result, renderStop, isRollback);
  mirrorService.handleSceneRendered(result, renderStop, isRollback);
  rotateService.handleSceneRendered(result, renderStop, isRollback);
  connectorService.handleSceneRendered(result, renderStop, isRollback);
  booleanService.handleSceneRendered(result, renderStop, isRollback);
  planeService.handleSceneRendered(result, renderStop, isRollback);
  textEditService.handleSceneRendered(result, renderStop, isRollback);
}

/**
 * The last part-scene render, kept so a timeline part-row click can replay
 * it: activation changes the active scope without a new render arriving.
 * Cleared on assembly renders (their rail has no part rows to click).
 */
let lastPartRender: { result: SceneObjectRender[]; isRollback: boolean; rollbackStop?: number } | null = null;

/**
 * A part-row click repointed the active part: re-run the render cascade's
 * scope-derived pieces against the current scene so the view reacts now —
 * a newly active part ending in a sketch enters sketch editing (camera,
 * ghosting, toolbar, sketch dialog); anything else leaves it. Safe by
 * construction: this is the exact sequence a real render runs, and every
 * service already handles the scene's active sketch appearing or vanishing
 * between renders. Rolled-back views are left alone — their mode derives
 * from the rollback stop, not the active scope, and the next full render
 * re-derives everything.
 */
function refreshActivePartScope(): void {
  if (!lastPartRender || lastPartRender.isRollback) {
    return;
  }
  const { result, rollbackStop } = lastPartRender;
  viewer.isTrimming = trimService.state === 'picking-active';
  viewer.isDrawing = sketchService.hasActiveDrawingTool;
  viewer.updateView(result, false, rollbackStop);
  runSceneServices(result, rollbackStop ?? result.length - 1, false);
}

function connectWebSocket() {
  // Protocol-relative: plain ws:// is blocked from an https page.
  const wsUrl = `${window.location.protocol === 'https:' ? 'wss' : 'ws'}://${window.location.host}`;
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
        // Re-resolve the active part BEFORE the viewer or any service reads
        // this render — the scope helpers (findActiveObject & co.) consult the
        // tracker, so a stale activation would derive the sketch-mode entry
        // (and the timeline highlight) from the wrong part. Assembly scenes
        // have no parts timeline — a stale activation must not survive the
        // flip.
        if (sceneKind === 'part') {
          activePartTracker.sync(msg.result);
        } else {
          activePartTracker.clear();
        }
        viewer.isTrimming = !isRollback && trimService.state === 'picking-active';
        viewer.isDrawing = !isRollback && sketchService.hasActiveDrawingTool;
        if (sceneKind === 'assembly') {
          const assembly: SerializedAssembly = msg.assembly ?? { instances: [], mates: [] };
          // Template serialize payloads (name, params, paramValues) keyed by
          // partId — the Edit-parameters dialog reads control metadata here.
          lastPartTemplates.clear();
          for (const o of msg.result as SceneObjectRender[]) {
            if (o.type === 'part') {
              lastPartTemplates.set(o.id, o.object);
            }
          }
          viewer.updateAssemblyView(msg.result, assembly);
          lastPartRender = null;
        } else {
          lastPartRender = { result: msg.result, isRollback, rollbackStop: msg.rollbackStop };
          viewer.updateView(msg.result, isRollback, msg.rollbackStop);
          // Snapshot every sketch's consumed state from complete builds only —
          // rollbacks (and breakpoint truncations) make a tip sketch look
          // unconsumed. The Finish Sketch edit flow reads this snapshot.
          if (!isRollback && msg.breakpointHit !== true) {
            sketchConsumedByKey.clear();
            for (const o of msg.result as SceneObjectRender[]) {
              if (o.type === 'sketch' && o.sourceLocation) {
                sketchConsumedByKey.set(sketchLocKey(o.sourceLocation), o.visible === false || o.reusable === true);
              }
            }
          }
        }
        measureController.onSceneRendered();
        if (msg.absPath) {
          topBar.setFileName(msg.absPath);
          currentSceneAbsPath = msg.absPath;
        }
        const renderStop = msg.rollbackStop ?? msg.result.length - 1;
        runSceneServices(msg.result, renderStop, isRollback);
        // Swap the toolbar to the matching workbench alongside the left rail —
        // part-design groups hide and the assembly groups show (or back).
        navbar.setMode(sceneKind);
        const rail = ensureRailFor(sceneKind);
        if (rail.kind === 'part') {
          rail.timeline.update(msg.result, renderStop);
          assemblyGizmo.handleModeExit();
        } else {
          const raw = msg.assembly;
          const assembly: SerializedAssembly = {
            instances: raw?.instances ?? [],
            mates: raw?.mates ?? [],
            occurrences: raw?.occurrences ?? [],
          };
          applyAssemblyToRail(rail, assembly);
          // Instance groups were just rebuilt/re-posed — re-anchor the
          // gizmo (or dismiss it if its instance is gone or now locked).
          assemblyGizmo.handleSceneRendered();
        }
        // The mate dialog re-resolves its picks against the re-minted scene
        // ids (or closes, when the render switched to a part scene).
        assemblyMateService.handleSceneRendered(sceneKind);
        if (msg.params !== undefined) {
          paramsPanel.update(msg.params);
          // Reachable from the first render on, params or not — an empty panel
          // is where the model's first parameter gets added.
          viewer.setParamsButtonVisible(true);
        }
        errorBanner.update(msg.result, msg.compileError ?? null);
        // Only update the breakpoint indicator when the server sends an
        // authoritative value. Rollback responses don't re-run the module but
        // carry the last full render's state (so a refresh whose replayed
        // scene is a rollback still restores the indicator); compile-error
        // responses omit the flag and the last known state persists.
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
      case 'editor-capabilities':
        historyToolbar.setAvailable(msg.undoRedo === true);
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
