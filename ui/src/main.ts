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
import { ICON_IMG_FALLBACK } from './ui/object-icons';
import { TrimPickService } from './interactive/trim-pick-service';
import { RegionPickService } from './interactive/region-pick-service';
import { ProjectionPickService } from './interactive/projection-pick-service';
import { SketchToolbarService } from './interactive/sketch-toolbar-service';
import { ModifyPickService } from './interactive/modify-pick/modify-pick-service';
import { ExtrudeFeatureService } from './interactive/create-feature/extrude-service';
import { RevolveFeatureService } from './interactive/create-feature/revolve-service';
import { SweepFeatureService } from './interactive/create-feature/sweep-service';
import { LoftFeatureService } from './interactive/create-feature/loft-service';
import { WrapFeatureService } from './interactive/create-feature/wrap-service';
import { HelixFeatureService } from './interactive/create-feature/helix-service';
import { RepeatFeatureService } from './interactive/create-feature/repeat-service';
import { CopyFeatureService } from './interactive/create-feature/copy-service';
import { BooleanFeatureService } from './interactive/create-feature/boolean-service';
import { PlaneFeatureService } from './interactive/create-feature/plane-service';
import { FinishSketchMenu } from './interactive/create-feature/finish-sketch-menu';
import { SolidPickSelection } from './interactive/solid-pick';
import { MeasureController } from './ui/measure/measure-controller';
import { captureScreenshot, captureScreenshotMulti } from './screenshot';
import { onThemeChange } from './scene/theme-colors';
import { loadPreferences, gotoSource, parseFeatureAt } from './api';
import { TextEditService } from './interactive/create-feature/text-edit-service';
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
// The properties panel's whole-solid picker (single mode) — the copy dialog
// shares the component in multiple mode for its targets slot.
const propertiesSolidPick = new SolidPickSelection(viewer);
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
importBtn.className = 'btn btn-ghost btn-sm h-auto flex-col gap-0.5 px-2 py-1 shrink-0 text-base-content/60';
importBtn.setAttribute('aria-label', 'Import file');
importBtn.innerHTML =
  `<img src="/icons/load.png" ${ICON_IMG_FALLBACK} class="w-8 h-8 object-contain shrink-0" alt="" />`
  + `<span class="text-[10px] leading-none text-base-content/50">Import</span>`;
importBtn.addEventListener('click', () => fileImporter.openPicker());
const importBtnWrap = document.createElement('span');
importBtnWrap.className = 'tooltip tooltip-bottom shrink-0';
importBtnWrap.dataset.tip = 'Import file';
importBtnWrap.appendChild(importBtn);
importGroup.appendChild(importBtnWrap);

const paramsPanel = new ParamsPanel(viewer.settingsPanelHost);

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
// The Sketch button (create group) stays visible while a create dialog is
// up — it disables instead. Recomputed on every dialog arm/disarm.
const syncSketchButtonBlocked = () => modifyService.setCreateDialogActive(
  extrudeService.isActive || revolveService.isActive || sweepService.isActive
  || loftService.isActive || wrapService.isActive || helixService.isActive
  || repeatService.isActive || copyService.isActive || booleanService.isActive
  || planeService.isActive,
);
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
    revolveService.exit();
    helixService.exit();
    sweepService.exit();
    loftService.exit();
    wrapService.exit();
    repeatService.exit();
    copyService.exit();
    booleanService.exit();
    planeService.exit();
    textEditService.exit();
    measureController.clearSelection();
    viewer.clearHighlight();
    selectionInfoOverlay.hide();
  },
  onActiveChange: syncSketchButtonBlocked,
  onSuspendSketchUI: () => sketchService.update([]),
  onResumeSketchUI: () => sketchService.update(viewer.currentSceneObjects),
});
// Constructed right after Extrude so its button lands between Extrude and
// Sweep in the create group.
const revolveService = new RevolveFeatureService(container, viewer, navbar, {
  onEnter: () => {
    projectionService.exit({ resume: 'lazy' });
    modifyService.displaceSketchSession();
    modifyService.exit();
    extrudeService.exit();
    helixService.exit();
    sweepService.exit();
    loftService.exit();
    wrapService.exit();
    repeatService.exit();
    copyService.exit();
    booleanService.exit();
    planeService.exit();
    textEditService.exit();
    measureController.clearSelection();
    viewer.clearHighlight();
    selectionInfoOverlay.hide();
  },
  onActiveChange: syncSketchButtonBlocked,
  onSuspendSketchUI: () => sketchService.update([]),
  onResumeSketchUI: () => sketchService.update(viewer.currentSceneObjects),
});
const sweepService = new SweepFeatureService(container, viewer, navbar, {
  onEnter: () => {
    projectionService.exit({ resume: 'lazy' });
    modifyService.displaceSketchSession();
    modifyService.exit();
    extrudeService.exit();
    revolveService.exit();
    helixService.exit();
    loftService.exit();
    wrapService.exit();
    repeatService.exit();
    copyService.exit();
    booleanService.exit();
    planeService.exit();
    textEditService.exit();
    measureController.clearSelection();
    viewer.clearHighlight();
    selectionInfoOverlay.hide();
  },
  onActiveChange: syncSketchButtonBlocked,
  onSuspendSketchUI: () => sketchService.update([]),
  onResumeSketchUI: () => sketchService.update(viewer.currentSceneObjects),
});
const loftService = new LoftFeatureService(container, viewer, navbar, {
  onEnter: () => {
    projectionService.exit({ resume: 'lazy' });
    modifyService.displaceSketchSession();
    modifyService.exit();
    extrudeService.exit();
    revolveService.exit();
    helixService.exit();
    sweepService.exit();
    wrapService.exit();
    repeatService.exit();
    copyService.exit();
    booleanService.exit();
    planeService.exit();
    textEditService.exit();
    measureController.clearSelection();
    viewer.clearHighlight();
    selectionInfoOverlay.hide();
  },
  onActiveChange: syncSketchButtonBlocked,
  onSuspendSketchUI: () => sketchService.update([]),
  onResumeSketchUI: () => sketchService.update(viewer.currentSceneObjects),
});
// Constructed after Loft so its button lands at the end of the create group.
const wrapService = new WrapFeatureService(container, viewer, navbar, {
  onEnter: () => {
    projectionService.exit({ resume: 'lazy' });
    modifyService.displaceSketchSession();
    modifyService.exit();
    extrudeService.exit();
    revolveService.exit();
    helixService.exit();
    sweepService.exit();
    loftService.exit();
    repeatService.exit();
    copyService.exit();
    booleanService.exit();
    planeService.exit();
    textEditService.exit();
    measureController.clearSelection();
    viewer.clearHighlight();
    selectionInfoOverlay.hide();
  },
  onActiveChange: syncSketchButtonBlocked,
  onSuspendSketchUI: () => sketchService.update([]),
  onResumeSketchUI: () => sketchService.update(viewer.currentSceneObjects),
});
// Constructed after Wrap so its Helix button lands at the end of the create
// feature row (Extrude, Revolve, Sweep, Loft, Wrap, Helix).
const helixService = new HelixFeatureService(container, viewer, navbar, {
  onEnter: () => {
    projectionService.exit({ resume: 'lazy' });
    modifyService.displaceSketchSession();
    modifyService.exit();
    extrudeService.exit();
    revolveService.exit();
    sweepService.exit();
    loftService.exit();
    wrapService.exit();
    repeatService.exit();
    copyService.exit();
    booleanService.exit();
    planeService.exit();
    textEditService.exit();
    measureController.clearSelection();
    viewer.clearHighlight();
    selectionInfoOverlay.hide();
  },
  onActiveChange: syncSketchButtonBlocked,
  onSuspendSketchUI: () => sketchService.update([]),
  onResumeSketchUI: () => sketchService.update(viewer.currentSceneObjects),
});
// Constructed after the other create services: its button prepends ahead of
// Extrude, and the Sketch button (modify service) prepends ahead of it —
// the group reads Sketch, Plane, Extrude, Sweep, Loft.
const planeService = new PlaneFeatureService(container, viewer, navbar, {
  // The current highlight seeds the dialog (one edge → edge type, one face →
  // offset, two faces → mid), like the modify tools.
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
    booleanService.exit();
    const seed = [...measureController.selection];
    textEditService.exit();
    measureController.clearSelection();
    viewer.clearHighlight();
    selectionInfoOverlay.hide();
    return seed;
  },
  onActiveChange: syncSketchButtonBlocked,
  onSuspendSketchUI: () => sketchService.update([]),
  onResumeSketchUI: () => sketchService.update(viewer.currentSceneObjects),
});
// The text edit dialog (timeline double-click on a text row). Pick-less:
// it never takes viewer or timeline picks, so it sits outside the create
// group and the intercept chain.
const textEditService = new TextEditService(container, viewer, {
  onEnter: () => {
    projectionService.exit({ resume: 'lazy' });
    modifyService.exit();
    extrudeService.exit();
    revolveService.exit();
    helixService.exit();
    sweepService.exit();
    loftService.exit();
    wrapService.exit();
    repeatService.exit();
    copyService.exit();
    booleanService.exit();
    planeService.exit();
    measureController.clearSelection();
    viewer.clearHighlight();
    selectionInfoOverlay.hide();
  },
  onSuspendSketchUI: () => sketchService.update([]),
  onResumeSketchUI: () => sketchService.update(viewer.currentSceneObjects),
});
// An armed create dialog takes sketch (or plane) rows clicked in the
// timeline as its input instead of the default rollback-preview.
timelinePanel.onFeatureIntercept = (obj) =>
  extrudeService.handleTimelinePick(obj) || revolveService.handleTimelinePick(obj)
  || sweepService.handleTimelinePick(obj) || wrapService.handleTimelinePick(obj)
  || loftService.handleTimelinePick(obj) || helixService.handleTimelinePick(obj)
  || repeatService.handleTimelinePick(obj) || copyService.handleTimelinePick(obj)
  || booleanService.handleTimelinePick(obj) || planeService.handleTimelinePick(obj);
// Double-clicking an editable feature row (the enter-breakpoint gesture)
// also opens that feature's dialog prefilled from its statement.
timelinePanel.onFeatureEdit = (obj, index) => {
  void openFeatureEditor(obj, index);
};
// Rows with an edit dialog keep the double-click gesture even while the
// trailing sketch is active — the dialog suspends the sketch UI itself.
timelinePanel.isFeatureEditable = (obj) =>
  obj.type != null && EDITABLE_ROW_TYPES.has(obj.type) && obj.sourceLocation != null;

/**
 * Timeline `type` → the dialog that edits it (cut is extrude's remove op;
 * the repeat kinds map to their scene feature types — mirror and rotate
 * rows carry the mirror/matrix feature's type, and a raw-matrix repeat
 * surfaces its parse refusal as the toast).
 */
const EDITABLE_ROW_TYPES = new Set([
  'extrude', 'cut', 'revolve', 'sweep', 'wrap', 'loft', 'helix', 'shell', 'fillet', 'chamfer', 'text',
  'repeat-linear', 'repeat-circular', 'repeat-matrix', 'mirror',
  'copy-linear', 'copy-circular',
  'fuse', 'subtract', 'common',
]);

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
    // Sketch has no edit dialog of its own: the double-click's breakpoint
    // truncates the build at the sketch, and the sketch dialog adopts the
    // render that ends in it. Flag that adoption as the edit it is, so the
    // dialog owns the breakpoint and its close leaves the statement alone.
    modifyService.noteSketchEditRequest(obj.sourceLocation);
    return;
  }
  if (!obj.type || !EDITABLE_ROW_TYPES.has(obj.type) || !obj.sourceLocation) {
    return;
  }
  const target = obj.sourceLocation;
  const result = await parseFeatureAt(target);
  if (result.ok === false) {
    showEditRefusal(result.reason);
    return;
  }
  const info = { index, type: obj.type, expectedStatement: result.statement };
  const parsed = result.parsed;
  if (parsed.feature === 'extrude') {
    extrudeService.enterEdit(target, parsed, info);
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
    copyService.enterEdit(target, parsed, info);
  } else if (parsed.feature === 'boolean') {
    booleanService.enterEdit(target, parsed, info);
  } else if (parsed.feature !== 'sketch') {
    // Sketch rows aren't in EDITABLE_ROW_TYPES — the guard only narrows the
    // parse union down to the shell/fillet/chamfer dialog's statements.
    modifyService.enterEdit(target, parsed, info);
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
const sketchService = new SketchToolbarService(container, viewer, trimService, projectionService, navbar);
const modifyService = new ModifyPickService(container, viewer, navbar, {
  // Hand the current highlight over as the tool's initial input: whatever the
  // user already clicked (measure owns that selection) seeds the pick set.
  onEnter: () => {
    projectionService.exit({ resume: 'lazy' });
    extrudeService.exit();
    revolveService.exit();
    helixService.exit();
    sweepService.exit();
    loftService.exit();
    repeatService.exit();
    copyService.exit();
    booleanService.exit();
    planeService.exit();
    textEditService.exit();
    const seed = [...measureController.selection];
    measureController.clearSelection();
    selectionInfoOverlay.hide();
    return seed;
  },
  // Sketch-on-face armed from inside a sketch: the sketch toolbar and tools
  // release input while faces are picked, and return if the pick is cancelled.
  onSuspendSketchUI: () => sketchService.update([]),
  onResumeSketchUI: () => sketchService.update(viewer.currentSceneObjects),
  // Snap options live in the sketch dialog; the toolbar service owns the
  // state and pushes changes into the live tools' snap controllers.
  onSnapVerticesChange: (checked) => sketchService.setSnapToVertices(checked),
  onSnapGridChange: (checked) => sketchService.setSnapToGrid(checked),
});
// The dialogs dock at top-[196px] right-4: the sketch dialog steps aside
// while a 2D op dialog (fillet, offset) is open and returns when it closes.
sketchService.onOpDialogToggle = (open) => modifyService.setSketchPanelSuspended(open);
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
    revolveService.exit();
    helixService.exit();
    sweepService.exit();
    loftService.exit();
    wrapService.exit();
    copyService.exit();
    booleanService.exit();
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
  onSuspendSketchUI: () => sketchService.update([]),
  onResumeSketchUI: () => sketchService.update(viewer.currentSceneObjects),
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
    revolveService.exit();
    helixService.exit();
    sweepService.exit();
    loftService.exit();
    wrapService.exit();
    repeatService.exit();
    booleanService.exit();
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
  onSuspendSketchUI: () => sketchService.update([]),
  onResumeSketchUI: () => sketchService.update(viewer.currentSceneObjects),
});
// Constructed after the copy service so its own navbar group registers last
// (…, Repeat, Copy, | separator |, Boolean).
const booleanService = new BooleanFeatureService(container, viewer, navbar, {
  // The current selection seeds the dialog: every selected face/edge
  // resolves to its owning solid, opening as a target chip. Captured before
  // the exits below clear it.
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
  onSuspendSketchUI: () => sketchService.update([]),
  onResumeSketchUI: () => sketchService.update(viewer.currentSceneObjects),
});

// While a sketch is active, the create-feature buttons collapse into a single
// "Finish Sketch" button whose popup grid mirrors them and delegates clicks
// straight back to them. Constructed after every create service so its button
// prepends ahead of theirs; only the mirrored buttons hide, so Shell (a modify
// tool that also lives in the create group) stays reachable alongside it.
const finishSketchMenu = new FinishSketchMenu(navbar.getGroup('create')!, [
  { button: extrudeService.toolbarButton },
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
]);
sketchService.onActiveChange = (active) => finishSketchMenu.setConsolidated(active);

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
  for (const service of [modifyService, extrudeService, revolveService, sweepService, wrapService, loftService, helixService, repeatService, copyService, booleanService]) {
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

// An armed modify mode (fillet/chamfer) owns hover (teach-mode tooltip) and
// right-click (tangent-chain selection).
viewer.setHoverHandler((shapeId, sub, clientX, clientY) => {
  if (modifyService.isActive) {
    modifyService.handleHover(shapeId, sub, clientX, clientY);
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
  || revolveService.isAxisPicking
  || (sweepService.isActive && !sweepService.isEditing)
  || sweepService.isEdgePicking
  || wrapService.isFacePicking
  || loftService.isFacePicking
  || helixService.isPicking
  || repeatService.isPicking
  || copyService.isPicking
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

viewer.setSelectionHandler((shapeId, sub, modifiers) => {
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
        || revolveService.handleSketchPick(shapeId)
        || sweepService.handleSketchPick(shapeId)
        || wrapService.handleSketchPick(shapeId)
        || loftService.handleSketchPick(shapeId);
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
    } else if (helixService.isAxisPicking) {
      helixService.handleClick(shapeId, sub);
    } else {
      revolveService.handleClick(shapeId, sub);
    }
    return;
  }
  // A plane-quad pick exists while the sketch mode is armed (sketch on that
  // plane right away), while the repeat dialog's Mirror type is up (the quad
  // is the mirror plane), or in neutral mode (hold it as the pending sketch
  // plane — the Sketch button consumes it). Never part of the measure set.
  if (sub?.type === 'plane') {
    if (shapeId) {
      if (repeatService.isPlanePicking) {
        repeatService.handlePlanePick(shapeId);
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
  // The armed boolean dialog owns clicks — a face or edge selects its whole
  // solid into the armed target slot.
  if (booleanService.isPicking) {
    booleanService.handleClick(shapeId, sub);
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
        const renderStop = msg.rollbackStop ?? msg.result.length - 1;
        if (isRollback) {
          trimService.reset();
          regionService.reset();
          sketchService.update([]);
          planeService.update([]);
        } else {
          trimService.update(msg.result);
          regionService.update(msg.result);
          // Shape ids changed with the render — an armed Project tool drops
          // its now-unaddressable picks.
          projectionService.update(msg.result);
          // While a pick mode has sketch editing suspended, the sketch
          // toolbar must not re-take the bar on incoming renders.
          const sketchSuspended = modifyService.sketchUISuspended
            || sweepService.sketchUISuspended || wrapService.sketchUISuspended
            || loftService.sketchUISuspended || repeatService.sketchUISuspended
            || copyService.sketchUISuspended || booleanService.sketchUISuspended
            || planeService.sketchUISuspended || extrudeService.sketchUISuspended
            || revolveService.sketchUISuspended || helixService.sketchUISuspended
            || textEditService.isActive;
          sketchService.update(sketchSuspended ? [] : msg.result);
          planeService.update(msg.result);
        }
        // The edit-capable services see every render: an open edit session
        // keeps the view rolled back to just before its statement and
        // rebuilds options/seeds at that boundary; without one this is the
        // plain update (empty list on rollbacks, as before).
        modifyService.handleSceneRendered(msg.result, renderStop, isRollback);
        extrudeService.handleSceneRendered(msg.result, renderStop, isRollback);
        revolveService.handleSceneRendered(msg.result, renderStop, isRollback);
        sweepService.handleSceneRendered(msg.result, renderStop, isRollback);
        wrapService.handleSceneRendered(msg.result, renderStop, isRollback);
        loftService.handleSceneRendered(msg.result, renderStop, isRollback);
        helixService.handleSceneRendered(msg.result, renderStop, isRollback);
        repeatService.handleSceneRendered(msg.result, renderStop, isRollback);
        copyService.handleSceneRendered(msg.result, renderStop, isRollback);
        booleanService.handleSceneRendered(msg.result, renderStop, isRollback);
        textEditService.handleSceneRendered(msg.result, renderStop, isRollback);
        timelinePanel.update(msg.result, msg.rollbackStop ?? msg.result.length - 1);
        if (msg.params !== undefined) {
          paramsPanel.update(msg.params);
          viewer.setParamsButtonVisible(paramsPanel.hasAnyParams);
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
