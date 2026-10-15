import fs from 'fs';
import http from 'http';
import path from 'path';
import express from 'express';
import { FluidCadServer, sceneStopFields, sceneUnitFields } from './fluidcad-server/index.ts';
import type { SceneRenderedData } from './fluidcad-server/index.ts';
import { createServerCore } from './server-core.ts';
import { createHostGuard, createHostGuardVerifyClient } from './host-guard.ts';
import { createParamsRouter } from './routes/params.ts';
import { createPropertyEditsRouter } from './routes/property-edits.ts';
import { createPropertiesRouter } from './routes/properties.ts';
import { createHitTestRouter } from './routes/hit-test.ts';
import { createMeasureRouter } from './routes/measure.ts';
import { createResolveSelectionRouter } from './routes/resolve-selection.ts';
import { createValidateRouter } from './routes/validate.ts';
import { createInterfereRouter } from './routes/interfere.ts';
import { createTimelineRouter } from './routes/timeline.ts';
import { createSketchEditsRouter } from './routes/sketch-edits.ts';
import { createApplyFeatureRouter } from './routes/apply-feature/index.ts';
import { createExportRouter } from './routes/export.ts';
import { createScreenshotRouter } from './routes/screenshot.ts';
import { createPreferencesRouter } from './routes/preferences.ts';
import { loadPreferences } from './preferences.ts';
import { createHealthRouter } from './routes/health.ts';
import { createSceneRouter } from './routes/scene.ts';
import { createEditorRouter, DirtyBufferState } from './routes/editor.ts';
import { createRenderRouter, type RenderOutcome } from './routes/render.ts';
import { createLintRouter } from './routes/lint.ts';
import { createPackRouter } from './routes/pack.ts';
import { createPackagesRouter } from './routes/packages.ts';
import { createHubRouter } from './routes/hub.ts';
import { createHostActionsRouter } from './routes/host-actions.ts';
import { HubReleases } from './hub/hub-releases.ts';
import { PackageInstaller } from './packages/package-installer.ts';
import { PackageEditGuard } from './packages/package-edit-guard.ts';
import { PackagePins } from './packages/package-pins.ts';
import { PackageRoots } from './packages/package-roots.ts';
import { createShareRouter } from './routes/share.ts';
import { createPartCatalogRouter } from './routes/part-catalog.ts';
import { createFeatureCatalogRouter } from './routes/feature-catalog.ts';
import { FeatureCatalog } from './feature-catalog/catalog.ts';
import { createInstancePoseRouter } from './routes/instance-pose.ts';
import { createSectionRouter } from './routes/section.ts';
import { createAssemblyMateRouter } from './routes/assembly-mate.ts';
import { createAssemblyConnectorRouter } from './routes/assembly-connector.ts';
import { createAssemblyReplicateRouter } from './routes/assembly-replicate.ts';
import { createTextRouter } from './routes/text.ts';
import { createFeatureGhostRouter } from './routes/feature-ghost/index.ts';
import { createFilesRouter } from './routes/files.ts';
import { createEngineTypesRouter } from './routes/engine-types.ts';
import { createWorkspaceStateRouter } from './routes/workspace-state.ts';
import { createUnitRouter } from './routes/unit.ts';
import { createWorkspaceWatcher, type WorkspaceWatcher } from './files/workspace-watcher.ts';
import { RenderInputChanges } from './files/render-input-changes.ts';
import { FeatureEditDispatcher } from './edit-dispatch.ts';
import { HostRegistry } from './host-registry.ts';
import { attachEditorHostTransport, broadcastEditorCapabilities } from './editor-host-transport.ts';
import { normalizePath } from './normalize-path.ts';
import {
  PROJECT_CONFIG_FILENAME,
  readProjectConfig,
  describeEnginePinMismatch,
  describeProjectUnitProblem,
  describeProjectPackageProblem,
  describeProjectDependenciesProblem,
  type LengthUnit,
} from './project-config.ts';
import { PageWriteLedger } from './files/page-write-ledger.ts';
import type { CompileError, SerializedAssembly } from './ws-protocol.ts';
import { detectKind } from './file-kind.ts';
import type { FluidScriptKind } from './file-kind.ts';
import { writeInstanceFile, deleteInstanceFile } from './instance-file.ts';
import { addInstance, removeInstance } from './global-registry.ts';
import { extractErrorSourceLocation, describeOcException, KernelTraps } from '../../lib/dist/index.js';
import { EngineHealth } from './engine-health.ts';
import { createEngineRouter } from './routes/engine.ts';
import { setMaxWorkers } from '../../lib/dist/oc/init.js';

// Load-bearing for every sourceLocation the engine reports: user modules run
// through vite's SSR wrapper, whose transform shifts raw stack lines (+3) and
// mangles columns unless Node applies the inline sourcemaps. Launchers pass
// --enable-source-maps, but this must not depend on how the process was
// forked — a launcher that forgets the flag silently mis-targets every
// call-site-addressed edit (breakpoints, apply-feature, dimensions).
process.setSourceMapsEnabled(true);

const PORT = parseInt(process.env.FLUIDCAD_SERVER_PORT || '3100', 10);
// Loopback only: the server has no authentication, so the network boundary
// is the security boundary (host-guard.ts). Set FLUIDCAD_SERVER_HOST to
// expose it deliberately, which also lifts the Host header check.
const HOST = process.env.FLUIDCAD_SERVER_HOST || '127.0.0.1';
const WORKSPACE_PATH = normalizePath(process.env.FLUIDCAD_WORKSPACE_PATH || '');
const UI_DIST = path.resolve(import.meta.dirname, '../../ui/dist');

function readPackageVersion(): string {
  try {
    const pkgPath = path.resolve(import.meta.dirname, '../../package.json');
    const raw = fs.readFileSync(pkgPath, 'utf8');
    const parsed = JSON.parse(raw);
    if (typeof parsed.version === 'string') {
      return parsed.version;
    }
  } catch {
    // Fall through to unknown.
  }
  return '0.0.0';
}

const PACKAGE_VERSION = readPackageVersion();
const STARTED_AT = new Date().toISOString();
// Read once at startup: the pin describes the project, and a project doesn't
// change which engine it was authored against while its server is running.
const PROJECT_CONFIG = readProjectConfig(WORKSPACE_PATH);
// What an error replay reports as the scene's unit when no render of that
// file has succeeded yet: the project unit, which is what a file without its
// own `unit()` statement resolves to anyway. Read live, not from the startup
// snapshot: the unit chip can rewrite fluidcad.json while the server runs.
const projectUnitNow = (): LengthUnit => readProjectConfig(WORKSPACE_PATH).unit ?? 'mm';


// ---------------------------------------------------------------------------
// Editor hosts — IPC and the in-page Monaco host
// ---------------------------------------------------------------------------

/** Returns true when a host process received the message (IPC connected). */
function sendToExtension(msg: any): boolean {
  if (process.send) {
    process.send(msg);
    return true;
  }
  return false;
}

/**
 * Host-directed messages go through here, not `sendToExtension`: the in-page
 * editor is a host too, and the routers must not care which one is listening.
 * Lifecycle messages (`ready`, `scene-rendered`, `export-complete`, …) keep
 * using `sendToExtension` directly — the page already gets those over the UI
 * socket, and duplicating them would be a second render, not a second reader.
 */
const hosts = new HostRegistry(sendToExtension);

// ---------------------------------------------------------------------------
// Express app
// ---------------------------------------------------------------------------

const fluidCadServer = new FluidCadServer();

// Installed packages are read-only (K8): no host message edits one of their
// files. A refused send throws, and the error handler below answers the
// route's request with the sentence.
const packageEdits = new PackageEditGuard(() => WORKSPACE_PATH || null, () => fluidCadServer.getCurrentFileName() || null);
const sendToHost = packageEdits.guardSend((msg: any): boolean => hosts.send(msg));
const dirtyBufferState = new DirtyBufferState();

const app = express();
app.use(createHostGuard(HOST));
app.use(express.json({ limit: '50mb' }));

// ---------------------------------------------------------------------------
// HTTP + WebSocket server (set up early so routes can reference its helpers)
// ---------------------------------------------------------------------------

const httpServer = http.createServer(app);
const core = createServerCore(httpServer, { verifyClient: createHostGuardVerifyClient(HOST) });
const broadcastToUI = core.broadcastToUI;
const requestScreenshot = core.requestScreenshot;
const getLastCameraState = core.getLastCameraState;

// The workspace's custom features: the `*.feature.js` modules' builders. The
// toolbar lists them, and every transform and synthesis probe follows a
// file's imports through it, so their calls bind, repeat and move like the
// built-ins'.
const featureCatalog = new FeatureCatalog({
  workspacePath: WORKSPACE_PATH,
  scan: (absPath) => fluidCadServer.scanFeaturesInFile(absPath),
  hasLiveBuffer: (absPath) => fluidCadServer.hasLiveBuffer(absPath),
});

// Whether the engine can still be trusted: a trap of the OpenCascade kernel
// (most likely a custom feature's raw OpenCascade code) may have corrupted
// its heap. Every page hears of it and is offered the restart this host
// supports; a trapped row whose feature reaches raw OpenCascade says so.
const engineHealth = new EngineHealth({
  broadcast: (msg) => broadcastToUI(msg),
  feature: (type) => featureCatalog.disclosure(type),
});
engineHealth.watch(KernelTraps);

// Every router that writes source dispatches through this one instance: the
// ack that settles a dispatch arrives at /code/apply-feature, so a router with
// its own registry would never hear about its own edits.
const editDispatcher = new FeatureEditDispatcher(fluidCadServer, sendToHost, { callees: featureCatalog, packages: packageEdits });

app.use('/api', createHealthRouter({
  version: PACKAGE_VERSION,
  workspacePath: WORKSPACE_PATH,
  startedAt: STARTED_AT,
  enginePin: PROJECT_CONFIG.engine,
  unit: PROJECT_CONFIG.unit,
  readUnit: projectUnitNow,
}));
app.use('/api', createPropertiesRouter(fluidCadServer));
app.use('/api', createParamsRouter(fluidCadServer, sendToHost, broadcastToUI, editDispatcher, core.awaitLatestSceneApplied, WORKSPACE_PATH));
app.use('/api', createPropertyEditsRouter(fluidCadServer, editDispatcher, WORKSPACE_PATH));
app.use('/api', createHitTestRouter(fluidCadServer));
app.use('/api', createMeasureRouter(fluidCadServer));
app.use('/api', createResolveSelectionRouter(fluidCadServer, featureCatalog));
app.use('/api', createValidateRouter(fluidCadServer));
app.use('/api', createInterfereRouter(fluidCadServer));
app.use('/api', createTimelineRouter(fluidCadServer, sendToHost, broadcastToUI, {
  dispatcher: editDispatcher, workspacePath: WORKSPACE_PATH, callees: featureCatalog,
}));
app.use('/api', createSketchEditsRouter(fluidCadServer, sendToHost, WORKSPACE_PATH, editDispatcher));
app.use('/api', createApplyFeatureRouter(fluidCadServer, sendToHost, {
  dispatcher: editDispatcher, callees: featureCatalog, catalog: featureCatalog,
}));
app.use('/api', createExportRouter(fluidCadServer, WORKSPACE_PATH));
app.use('/api', createShareRouter(fluidCadServer, WORKSPACE_PATH, PACKAGE_VERSION));
app.use('/api', createScreenshotRouter(
  requestScreenshot,
  request => fluidCadServer.resolveSelection(request),
  () => fluidCadServer.getSceneTargetIds(),
));
app.use('/api', createPreferencesRouter((prefs) => setMaxWorkers(prefs.maxWorkers)));
app.use('/api', createSceneRouter(fluidCadServer, getLastCameraState));
app.use('/api', createEditorRouter(dirtyBufferState, editDispatcher));
app.use('/api', createRenderRouter((fileName, code, keepCurrent, changes) => runLiveRender(fileName, code, keepCurrent, changes), core.awaitLatestSceneApplied));
app.use('/api', createLintRouter());
app.use('/api', createTextRouter(fluidCadServer));
app.use('/api', createFeatureGhostRouter(fluidCadServer, { catalog: featureCatalog }));
app.use('/api', createFilesRouter({
  workspacePath: WORKSPACE_PATH,
  openFile: (absPath) => processFile(absPath),
  closeFile: (absPath) => closeFile(absPath),
  onWrite: (absPath, content) => pageWrites.record(absPath, content),
}));
app.use('/api', createEngineTypesRouter(PACKAGE_VERSION));
app.use('/api', createEngineRouter(engineHealth, {
  exit: (code) => {
    cleanupDiscovery();
    process.exit(code);
  },
}));
app.use('/api', createWorkspaceStateRouter(WORKSPACE_PATH));
app.use('/api', createUnitRouter({
  workspacePath: WORKSPACE_PATH,
  fluidCadServer,
  sendToExtension: sendToHost,
  broadcastToUI,
}));
app.use('/api', createPackRouter(fluidCadServer, WORKSPACE_PATH, PACKAGE_VERSION));
app.use('/api', createPackagesRouter({ workspacePath: WORKSPACE_PATH, releases: new HubReleases({ engineVersion: PACKAGE_VERSION }) }));
app.use('/api', createHubRouter({ workspacePath: WORKSPACE_PATH, engineVersion: PACKAGE_VERSION }));
app.use('/api', createHostActionsRouter({ send: sendToHost, hasHost: () => hosts.effectiveCapabilities() !== null }));
app.use('/api', createPartCatalogRouter(fluidCadServer, WORKSPACE_PATH, editDispatcher));
app.use('/api', createFeatureCatalogRouter(featureCatalog, WORKSPACE_PATH));
app.use('/api', createInstancePoseRouter(fluidCadServer, editDispatcher, WORKSPACE_PATH));
app.use('/api', createSectionRouter(fluidCadServer, editDispatcher));
app.use('/api', createAssemblyMateRouter(fluidCadServer, editDispatcher, featureCatalog));
app.use('/api', createAssemblyReplicateRouter(fluidCadServer, editDispatcher));
app.use('/api', createAssemblyConnectorRouter(fluidCadServer, editDispatcher));
app.use('/api', PackageEditGuard.errorHandler());

// Static files — serve UI build, with SPA fallback. index.html goes through
// sendIndexHtml so the saved theme is on <html> before the first paint — the
// UI's async /api/preferences fetch lands after render and would flash the
// built-in dark default.
async function sendIndexHtml(res: express.Response): Promise<void> {
  res.setHeader('Cache-Control', 'no-cache');
  try {
    const html = await fs.promises.readFile(path.join(UI_DIST, 'index.html'), 'utf8');
    const theme = (await loadPreferences()).theme.replace(/[^\w-]/g, '') || 'fluidcad-dark';
    res.type('html').send(html.replace('data-theme="fluidcad-dark"', `data-theme="${theme}"`));
  } catch {
    res.sendFile(path.join(UI_DIST, 'index.html'));
  }
}
app.get(['/', '/index.html'], (_req, res) => {
  void sendIndexHtml(res);
});
app.use(express.static(UI_DIST, {
  index: false,
  setHeaders(res, filePath) {
    if (path.extname(filePath) === '.html') {
      res.setHeader('Cache-Control', 'no-cache');
    }
  },
}));
app.get('*splat', (_req, res) => {
  void sendIndexHtml(res);
});

// ---------------------------------------------------------------------------
// IPC message handling — extension host → server
// ---------------------------------------------------------------------------

let currentFile: string | null = null;
let renderVersion = 0;
let workspaceWatcher: WorkspaceWatcher | null = null;

// A file the open model is built from changed on disk — an imported
// `*.feature.js` or helper saved in any editor, `fluidcad.json`, a part file
// an assembly inserts: render the model again, from the same buffer. The
// model file's own edits keep their host's path (see RenderInputChanges).
const renderInputChanges = new RenderInputChanges({
  isRenderBehind: (absPath) => fluidCadServer.isRenderBehind(absPath),
  rerender: async () => {
    const fileName = currentFile;
    if (fileName === null) {
      return;
    }
    const code = fluidCadServer.getLiveBuffer(fileName)
      ?? await fs.promises.readFile(fileName, 'utf8').catch((): null => null);
    if (code !== null) {
      await runLiveRender(fileName, code);
    }
  },
});
/**
 * What the in-page host last put on disk, so the `fluidcad serve` disk
 * watcher's echo of that same save is recognised. The host has already
 * rendered its own edit with the right `keepCurrent` — replaying the echo as
 * a plain live-update would switch the viewport to whichever file it saved
 * (a PART the assembly's mate dialog just wrote a connector into).
 */
const pageWrites = new PageWriteLedger();
const lastSceneByFile = new Map<string, {
  result: any[];
  rollbackStop: number;
  rollbackScopePartId?: string;
  breakpointHit?: boolean;
  timeline?: SceneRenderedData['timeline'];
  sceneKind: FluidScriptKind;
  unit: LengthUnit;
  declaredUnit: LengthUnit | null;
  assembly?: SerializedAssembly;
}>();

attachEditorHostTransport({ core, hosts, dispatcher: editDispatcher, dirtyBufferState, replay: (send) => engineHealth.replay(send) });

function emitSuccess(version: number, data: SceneRenderedData) {
  const { absPath, sceneKind, unit, declaredUnit, result, breakpointHit, assembly, params, properties, objectWarnings } = data;
  lastSceneByFile.set(absPath, { result, ...sceneStopFields(data), sceneKind, unit, declaredUnit, assembly });
  fluidCadServer.setCompileError(null);
  sendToExtension({
    type: 'scene-rendered',
    absPath,
    sceneKind,
    ...sceneUnitFields(data),
    result,
    ...sceneStopFields(data),
    ...(assembly ? { assembly } : {}),
  });
  broadcastToUI({
    type: 'scene-rendered',
    result,
    absPath,
    sceneKind,
    ...sceneUnitFields(data),
    ...sceneStopFields(data),
    breakpointHit,
    params,
    properties,
    objectWarnings,
    ...(assembly ? { assembly } : {}),
  });
  broadcastToUI({ type: 'render-version', version, state: 'end', absPath });
}

function buildCompileError(filePath: string, err: any): CompileError {
  const message = err?.message || String(err);
  let sourceLocation = extractErrorSourceLocation(err);
  const normalized = normalizePath(filePath).replace('virtual:live-render:', '');
  if (sourceLocation) {
    sourceLocation = {
      filePath: sourceLocation.filePath.replace('virtual:live-render:', ''),
      line: sourceLocation.line,
      column: sourceLocation.column,
    };
  }
  // A render that refused a package import says which, structured: the
  // missing-package banner offers to install it by name and version.
  const packageProblems = fluidCadServer.getPackageProblems();
  return {
    message,
    filePath: normalized,
    sourceLocation: sourceLocation ?? undefined,
    ...(packageProblems.length > 0 ? { packageProblems } : {}),
  };
}

function emitCompileError(version: number, filePath: string, err: any): CompileError {
  const compileError = buildCompileError(filePath, err);
  const key = compileError.filePath ?? normalizePath(filePath).replace('virtual:live-render:', '');
  const prev = lastSceneByFile.get(key);
  const result = prev?.result ?? [];
  const stop = sceneStopFields({ ...prev, rollbackStop: prev?.rollbackStop ?? -1 });
  const sceneKind = prev?.sceneKind ?? detectKind(key) ?? 'part';
  // The replayed scene is the last good one, so it keeps that render's
  // unit; the project unit is not the scene's and is read live.
  const units = {
    unit: prev?.unit ?? projectUnitNow(),
    declaredUnit: prev?.declaredUnit ?? null,
    projectUnit: projectUnitNow(),
  };
  const assembly = prev?.assembly;
  fluidCadServer.setCompileError(compileError);
  sendToExtension({
    type: 'scene-rendered',
    absPath: key,
    sceneKind,
    ...units,
    result,
    ...stop,
    compileError,
    ...(assembly ? { assembly } : {}),
  });
  broadcastToUI({
    type: 'scene-rendered',
    result,
    absPath: key,
    sceneKind,
    ...units,
    ...stop,
    compileError,
    ...(assembly ? { assembly } : {}),
  });
  broadcastToUI({ type: 'render-version', version, state: 'error', absPath: key });
  return compileError;
}

/**
 * Report a render that could not even be attempted, because the workspace has
 * no engine — no `init.js`, so nothing to build the model with.
 *
 * Emitted as a compile error on purpose: the UI already hides its loading
 * overlay, shows the banner, and marks the file for one of those. Returning
 * quietly (which every render path used to do) left the page on "Loading
 * model…" forever with nothing to act on.
 *
 * @returns true when it spoke — i.e. there was no engine.
 */
function emitMissingEngine(version: number, filePath: string): boolean {
  const reason = fluidCadServer.describeMissingEngine();
  if (!reason) {
    return false;
  }
  const key = normalizePath(filePath).replace('virtual:live-render:', '');
  const compileError: CompileError = { message: reason, filePath: key };
  const prev = lastSceneByFile.get(key);
  const sceneKind = prev?.sceneKind ?? detectKind(key) ?? 'part';
  const units = {
    unit: prev?.unit ?? projectUnitNow(),
    declaredUnit: prev?.declaredUnit ?? null,
    projectUnit: projectUnitNow(),
  };
  fluidCadServer.setCompileError(compileError);
  sendToExtension({ type: 'scene-rendered', absPath: key, sceneKind, ...units, result: [], rollbackStop: -1, compileError });
  broadcastToUI({ type: 'scene-rendered', result: [], absPath: key, sceneKind, ...units, rollbackStop: -1, compileError });
  broadcastToUI({ type: 'render-version', version, state: 'error', absPath: key });
  return true;
}

/**
 * Render-orchestration chokepoint shared by the IPC `live-update` handler and
 * the HTTP `/api/render` route. Bumps `renderVersion`, broadcasts the
 * lifecycle pings, runs the dedupable `updateLiveCode`, and emits success /
 * compile-error to the UI + extension. Returns a structured outcome so the
 * HTTP caller (MCP) can hand it straight to the agent. `changes` (MCP only)
 * adds the render's change summary to that outcome; the UI broadcasts never
 * carry it.
 */
async function runLiveRender(fileName: string, code: string, keepCurrent = false, changes = false): Promise<RenderOutcome> {
  const startedAt = Date.now();
  const myVersion = ++renderVersion;
  broadcastToUI({ type: 'render-version', version: myVersion, state: 'start' });
  // A host-applied cross-file edit (the mate dialog writing a connector()
  // into a PART file while the assembly is viewed) marks its live-update
  // keepCurrent: the updated file folds in as a dependency and the CURRENT
  // file re-renders, instead of the viewport switching to the edited file.
  const dependency = keepCurrent && currentFile !== null && fileName !== currentFile;
  if (!dependency && fileName !== currentFile) {
    broadcastToUI({ type: 'processing-file' });
    currentFile = fileName;
  }
  try {
    const options = changes ? { changes: true } : undefined;
    const data = dependency
      ? await fluidCadServer.updateDependencyCode(fileName, code, options)
      : await fluidCadServer.updateLiveCode(fileName, code, options);
    if (data) {
      await engineHealth.explain(data);
    }
    if (myVersion !== renderVersion) {
      return { state: 'superseded', version: myVersion, durationMs: Date.now() - startedAt };
    }
    if (!data) {
      emitMissingEngine(myVersion, fileName);
      return { state: 'no-scene-manager', version: myVersion, durationMs: Date.now() - startedAt };
    }
    emitSuccess(myVersion, data);
    // The scene is served either way — a feature that fails to build doesn't
    // abort the render, it just leaves its geometry out. But that is NOT a
    // successful render as far as the caller is concerned, so it gets its own
    // state rather than being reported as `rendered`.
    if (data.objectErrors.length > 0) {
      return {
        state: 'build-error',
        version: myVersion,
        absPath: data.absPath,
        durationMs: Date.now() - startedAt,
        objectErrors: data.objectErrors,
        ...(data.changes ? { changes: data.changes } : {}),
      };
    }
    return {
      state: 'rendered',
      version: myVersion,
      absPath: data.absPath,
      durationMs: Date.now() - startedAt,
      ...(data.changes ? { changes: data.changes } : {}),
    };
  } catch (err) {
    engineHealth.noteError(err, KernelTraps);
    if (myVersion !== renderVersion) {
      return { state: 'superseded', version: myVersion, durationMs: Date.now() - startedAt };
    }
    const compileError = emitCompileError(myVersion, fileName, err);
    return {
      state: 'compile-error',
      version: myVersion,
      durationMs: Date.now() - startedAt,
      compileError,
    };
  }
}

/**
 * Render `filePath` from disk as the current model. Shared by the IPC
 * `process-file` message an editor host sends and the `POST /api/files/open`
 * route the in-page host uses — the two hosts must land on identical
 * behaviour, so they land on identical code.
 */
async function processFile(filePath: string): Promise<void> {
  const myVersion = ++renderVersion;
  broadcastToUI({ type: 'render-version', version: myVersion, state: 'start' });
  broadcastToUI({ type: 'processing-file' });
  currentFile = filePath;
  try {
    const data = await fluidCadServer.processFile(filePath);
    if (data) {
      await engineHealth.explain(data);
    }
    if (myVersion !== renderVersion) { return; }
    if (data) {
      emitSuccess(myVersion, data);
      return;
    }
    // No data and no throw: there was nothing to render with. Say so rather
    // than leaving the page on its loading overlay.
    emitMissingEngine(myVersion, filePath);
  } catch (err) {
    engineHealth.noteError(err, KernelTraps);
    if (myVersion !== renderVersion) { return; }
    emitCompileError(myVersion, filePath, err);
  }
}

/**
 * The page closed the tab the scene was rendered from, with no model tab left
 * to take over. The scene goes with it: the server forgets its current file,
 * an in-flight render of it is superseded, and the page (every page — a
 * second browser included) is told to show an empty scene. A close for a
 * file that is NOT the one on screen is stale — the user already moved on to
 * another model — and leaves that scene alone.
 */
function closeFile(absPath: string): void {
  if (currentFile !== null && normalizePath(currentFile) !== normalizePath(absPath)) {
    return;
  }
  renderVersion++;
  currentFile = null;
  fluidCadServer.closeCurrentFile();
  broadcastToUI({ type: 'scene-closed' });
}

async function handleExtensionMessage(msg: any) {
  try {
    switch (msg.type) {
      case 'process-file': {
        await processFile(msg.filePath);
        break;
      }

      case 'live-update': {
        if (pageWrites.isEcho(msg.fileName, msg.code)) {
          break;
        }
        // An installed package's files never change under an edit (K8): a
        // disk watcher announcing one (`fluidcad serve`'s, as Copy into
        // project or an install renames a tree into `packages/`) is the
        // installer moving it, not a model to switch the scene to.
        if (PackageRoots.isManaged(msg.fileName, WORKSPACE_PATH)) {
          break;
        }
        await runLiveRender(msg.fileName, msg.code, msg.keepCurrent === true);
        break;
      }

      case 'rollback': {
        const myVersion = ++renderVersion;
        broadcastToUI({ type: 'render-version', version: myVersion, state: 'start' });
        const data = await fluidCadServer.rollback(msg.fileName, msg.index);
        if (data) {
          await engineHealth.explain(data);
        }
        if (myVersion !== renderVersion) { return; }
        if (data) {
          emitSuccess(myVersion, data);
        }
        break;
      }

      case 'import-file': {
        try {
          const report = await fluidCadServer.importFile(msg.workspacePath, msg.fileName, msg.data);
          // Older engines return nothing — the payload fields are optional for them.
          sendToExtension({
            type: 'import-complete',
            success: true,
            ...(report ? { solidCount: report.solidCount, sourceUnits: report.sourceUnits } : {}),
          });
        } catch (err: any) {
          sendToExtension({ type: 'error', message: describeOcException(err) });
        }
        break;
      }

      case 'highlight-shape': {
        broadcastToUI({ type: 'highlight-shape', shapeId: msg.shapeId });
        break;
      }

      case 'clear-highlight': {
        broadcastToUI({ type: 'clear-highlight' });
        break;
      }

      case 'show-shape-properties': {
        broadcastToUI({ type: 'show-shape-properties', shapeId: msg.shapeId });
        break;
      }

      case 'editor-dirty-state': {
        if (Array.isArray(msg.dirtyFiles)) {
          const paths = msg.dirtyFiles.filter((p: unknown): p is string => typeof p === 'string');
          dirtyBufferState.setDirtyFiles(paths);
        }
        break;
      }

      case 'editor-hello': {
        hosts.announce('ipc', { undoRedo: msg.capabilities?.undoRedo === true });
        engineHealth.noteEditor(msg.editor);
        broadcastEditorCapabilities(core, hosts);
        break;
      }

      case 'edit-ack': {
        if (typeof msg.editId === 'string') {
          editDispatcher.settle(msg.editId, typeof msg.error === 'string' ? msg.error : undefined);
        }
        break;
      }


      case 'export-scene': {
        try {
          // `assembly` (optionally with live poses) exports the whole
          // assembly; otherwise `shapeIds` picks solids, as the UI's route does.
          let result: { data: string | Uint8Array; fileName: string } | null = null;
          let posesSource: 'live' | 'statement' | undefined;
          if (msg.assembly !== undefined) {
            const outcome = fluidCadServer.exportAssembly(msg.options, msg.assembly.poses);
            if (outcome) {
              if ('reason' in outcome) {
                sendToExtension({ type: 'export-complete', success: false, error: outcome.reason });
                break;
              }
              result = outcome;
              posesSource = outcome.posesSource;
            }
          } else {
            result = fluidCadServer.exportShapes(msg.shapeIds ?? [], msg.options);
          }
          if (result) {
            const data = typeof result.data === 'string'
              ? Buffer.from(result.data, 'utf-8').toString('base64')
              : Buffer.from(result.data).toString('base64');
            sendToExtension({
              type: 'export-complete',
              success: true,
              data,
              fileName: result.fileName,
              ...(posesSource ? { posesSource } : {}),
            });
          } else {
            sendToExtension({ type: 'export-complete', success: false, error: 'No active scene to export.' });
          }
        } catch (err: any) {
          sendToExtension({ type: 'export-complete', success: false, error: err.message || String(err) });
        }
        break;
      }
    }
  } catch (err: any) {
    sendToExtension({
      type: 'error',
      message: err.stack || err.message || String(err),
    });
  }
}

// Listen for IPC messages from the parent process
process.on('message', (msg: any) => {
  handleExtensionMessage(msg);
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

httpServer.listen(PORT, HOST, () => {
  const url = `http://localhost:${PORT}`;
  // Name the engine that is actually running, not just the port. A project can
  // pin a version (P0-4) and the whole point of the pin is that which kernel
  // built the geometry is worth stating out loud.
  console.log(`FluidCAD engine ${PACKAGE_VERSION} listening on ${url}`);

  // Warned here rather than in `bin/commands/serve.js` so that every host
  // reaches it: the desktop launcher forks this file directly and never runs
  // the CLI, and `serve` pipes our stdout through to the terminal anyway.
  const pinWarning = describeEnginePinMismatch(PROJECT_CONFIG, PACKAGE_VERSION);
  if (pinWarning) {
    console.warn(pinWarning);
  }
  const unitWarning = describeProjectUnitProblem(PROJECT_CONFIG);
  if (unitWarning) {
    console.warn(unitWarning);
  }
  const packageWarning = describeProjectPackageProblem(PROJECT_CONFIG);
  if (packageWarning) {
    console.warn(packageWarning);
  }
  const dependenciesWarning = describeProjectDependenciesProblem(PROJECT_CONFIG);
  if (dependenciesWarning) {
    console.warn(dependenciesWarning);
  }
  for (const warning of PackagePins.describeProblems(WORKSPACE_PATH || null)) {
    console.warn(warning);
  }

  // What an install killed mid-way left in the package roots' scratch
  // (`<root>/.tmp/<pid>-…` of a process that is gone). Housekeeping only.
  try {
    PackageInstaller.sweep(WORKSPACE_PATH || null);
  } catch {
    // An unreadable root sweeps on a later start.
  }

  // Tell the page about edits made outside it. Announcement only — the CLI's
  // watcher still owns re-rendering on an external change, so nothing here
  // changes what an existing host sees.
  if (WORKSPACE_PATH) {
    try {
      workspaceWatcher = createWorkspaceWatcher(WORKSPACE_PATH, (event) => {
        broadcastToUI(event);
        // Feature code saved (a `*.feature.js`, or a module one imports):
        // what was built with the old code rebuilds on the next render — the
        // re-render below — and the next ghost draws the new code.
        fluidCadServer.noteFileChange(event.absPath);
        // A feature module (or a file one imports) changed: the toolbar's
        // catalog is stale. UI-only — editor hosts never see this message.
        if (featureCatalog.noteFileChange(event.absPath)) {
          broadcastToUI({ type: 'features-changed', absPath: event.absPath });
        }
        // The pins may have changed: tsserver's package types follow.
        if (normalizePath(event.absPath) === `${normalizePath(WORKSPACE_PATH)}/${PROJECT_CONFIG_FILENAME}`) {
          fluidCadServer.refreshEditorTypes();
        }
        renderInputChanges.note(event.absPath);
      });
    } catch (err: any) {
      console.warn(`Failed to watch the workspace: ${err?.message ?? err}`);
    }
  }

  // Publish this instance so a standalone MCP process can discover us.
  // Discovery is best-effort: an MCP-less workflow must keep working even if
  // we can't write the file (read-only FS, permissions, …).
  if (WORKSPACE_PATH) {
    try {
      writeInstanceFile({
        schemaVersion: 1,
        port: PORT,
        pid: process.pid,
        workspacePath: WORKSPACE_PATH,
        version: PACKAGE_VERSION,
        startedAt: STARTED_AT,
        unit: PROJECT_CONFIG.unit,
      });
    } catch (err: any) {
      console.warn(`Failed to write instance file: ${err?.message ?? err}`);
    }
    try {
      addInstance({
        workspacePath: WORKSPACE_PATH,
        port: PORT,
        pid: process.pid,
        version: PACKAGE_VERSION,
        startedAt: STARTED_AT,
      });
    } catch (err: any) {
      console.warn(`Failed to update global registry: ${err?.message ?? err}`);
    }
  }

  // Signal ready immediately so the parent can open the viewport
  sendToExtension({ type: 'ready', port: PORT, url });

  // Initialize FluidCAD server in the background. The stored worker count
  // reaches the kernel first: loading it (from the workspace's init.js) fixes
  // how many workers it starts with.
  loadPreferences().then((prefs) => {
    setMaxWorkers(prefs.maxWorkers);
    return fluidCadServer.init(WORKSPACE_PATH);
  }).then(() => {
    // Starting without an engine is legal — the UI and the editor still work —
    // but it is never what someone wants silently, so it lands in the terminal
    // as well as in the page.
    const missingEngine = fluidCadServer.describeMissingEngine();
    if (missingEngine) {
      console.warn(`FluidCAD: ${missingEngine}`);
    }
    sendToExtension({ type: 'init-complete', success: true });
    broadcastToUI({ type: 'init-complete', success: true });
  }).catch((err: any) => {
    const error = err.stack || err.message || String(err);
    sendToExtension({ type: 'init-complete', success: false, error });
    broadcastToUI({ type: 'init-complete', success: false, error });
  });
});

// ---------------------------------------------------------------------------
// Shutdown — clean up the instance file and registry entry
// ---------------------------------------------------------------------------

let cleanedUp = false;
function cleanupDiscovery(): void {
  if (cleanedUp || !WORKSPACE_PATH) {
    return;
  }
  cleanedUp = true;
  workspaceWatcher?.close();
  workspaceWatcher = null;
  renderInputChanges.dispose();
  deleteInstanceFile(WORKSPACE_PATH, process.pid);
  try {
    removeInstance(WORKSPACE_PATH, process.pid);
  } catch {
    // Registry cleanup is best-effort; stale entries are pruned by readers.
  }
}

process.on('exit', cleanupDiscovery);
process.on('SIGINT', () => {
  cleanupDiscovery();
  process.exit(0);
});
process.on('SIGTERM', () => {
  cleanupDiscovery();
  process.exit(0);
});
// Every host that forks the engine (the desktop shell, `fluidcad serve`, the
// editor extensions) holds the IPC channel for the engine's lifetime, so the
// channel closing means the host is gone — crashed, killed, or quit before
// this engine finished starting. Nothing is served to nobody; exit rather
// than linger as an orphan on the port.
if (process.send) {
  process.on('disconnect', () => {
    cleanupDiscovery();
    process.exit(0);
  });
}
