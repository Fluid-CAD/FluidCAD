import fs from 'fs';
import http from 'http';
import path from 'path';
import express from 'express';
import { FluidCadServer, sceneUnitFields } from './fluidcad-server.ts';
import type { SceneRenderedData } from './fluidcad-server.ts';
import { createServerCore } from './server-core.ts';
import { createPropertiesRouter } from './routes/properties.ts';
import { createParamsRouter } from './routes/params.ts';
import { createHitTestRouter } from './routes/hit-test.ts';
import { createMeasureRouter } from './routes/measure.ts';
import { createTimelineRouter } from './routes/timeline.ts';
import { createSketchEditsRouter } from './routes/sketch-edits.ts';
import { createApplyFeatureRouter } from './routes/apply-feature.ts';
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
import { createPartCatalogRouter } from './routes/part-catalog.ts';
import { createInstancePoseRouter } from './routes/instance-pose.ts';
import { createAssemblyMateRouter } from './routes/assembly-mate.ts';
import { createAssemblyConnectorRouter } from './routes/assembly-connector.ts';
import { createTextRouter } from './routes/text.ts';
import { createFeatureGhostRouter } from './routes/feature-ghost.ts';
import { createFilesRouter } from './routes/files.ts';
import { createEngineTypesRouter } from './routes/engine-types.ts';
import { createWorkspaceStateRouter } from './routes/workspace-state.ts';
import { createUnitRouter } from './routes/unit.ts';
import { createWorkspaceWatcher, type WorkspaceWatcher } from './files/workspace-watcher.ts';
import { FeatureEditDispatcher } from './edit-dispatch.ts';
import { HostRegistry } from './host-registry.ts';
import { attachEditorHostTransport, broadcastEditorCapabilities } from './editor-host-transport.ts';
import { normalizePath } from './normalize-path.ts';
import {
  readProjectConfig,
  describeEnginePinMismatch,
  describeProjectUnitProblem,
  type LengthUnit,
} from './project-config.ts';
import { PageWriteLedger } from './files/page-write-ledger.ts';
import type { CompileError, SerializedAssembly } from './ws-protocol.ts';
import { detectKind } from './file-kind.ts';
import type { FluidScriptKind } from './file-kind.ts';
import { writeInstanceFile, deleteInstanceFile } from './instance-file.ts';
import { addInstance, removeInstance } from './global-registry.ts';
import { extractSourceLocation, describeOcException } from '../../lib/dist/index.js';

// Load-bearing for every sourceLocation the engine reports: user modules run
// through vite's SSR wrapper, whose transform shifts raw stack lines (+3) and
// mangles columns unless Node applies the inline sourcemaps. Launchers pass
// --enable-source-maps, but this must not depend on how the process was
// forked — a launcher that forgets the flag silently mis-targets every
// call-site-addressed edit (breakpoints, apply-feature, dimensions).
process.setSourceMapsEnabled(true);

const PORT = parseInt(process.env.FLUIDCAD_SERVER_PORT || '3100', 10);
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
// Editor hosts — IPC (VS Code, Neovim) and the in-page Monaco host
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
const sendToHost = (msg: any): boolean => hosts.send(msg);

// ---------------------------------------------------------------------------
// Express app
// ---------------------------------------------------------------------------

const fluidCadServer = new FluidCadServer();
const dirtyBufferState = new DirtyBufferState();

const app = express();
app.use(express.json({ limit: '50mb' }));

// ---------------------------------------------------------------------------
// HTTP + WebSocket server (set up early so routes can reference its helpers)
// ---------------------------------------------------------------------------

const httpServer = http.createServer(app);
const core = createServerCore(httpServer);
const broadcastToUI = core.broadcastToUI;
const requestScreenshot = core.requestScreenshot;
const getLastCameraState = core.getLastCameraState;

// Every router that writes source dispatches through this one instance: the
// ack that settles a dispatch arrives at /code/apply-feature, so a router with
// its own registry would never hear about its own edits.
const editDispatcher = new FeatureEditDispatcher(fluidCadServer, sendToHost);

app.use('/api', createHealthRouter({
  version: PACKAGE_VERSION,
  workspacePath: WORKSPACE_PATH,
  startedAt: STARTED_AT,
  enginePin: PROJECT_CONFIG.engine,
  unit: PROJECT_CONFIG.unit,
  readUnit: projectUnitNow,
}));
app.use('/api', createPropertiesRouter(fluidCadServer));
app.use('/api', createParamsRouter(fluidCadServer, sendToHost, broadcastToUI, editDispatcher));
app.use('/api', createHitTestRouter(fluidCadServer));
app.use('/api', createMeasureRouter(fluidCadServer));
app.use('/api', createTimelineRouter(fluidCadServer, sendToHost, broadcastToUI, { dispatcher: editDispatcher }));
app.use('/api', createSketchEditsRouter(fluidCadServer, sendToHost, WORKSPACE_PATH, editDispatcher));
app.use('/api', createApplyFeatureRouter(fluidCadServer, sendToHost, { dispatcher: editDispatcher }));
app.use('/api', createExportRouter(fluidCadServer, WORKSPACE_PATH));
app.use('/api', createScreenshotRouter(requestScreenshot));
app.use('/api', createPreferencesRouter());
app.use('/api', createSceneRouter(fluidCadServer, getLastCameraState));
app.use('/api', createEditorRouter(dirtyBufferState, editDispatcher));
app.use('/api', createRenderRouter((fileName, code, keepCurrent) => runLiveRender(fileName, code, keepCurrent)));
app.use('/api', createLintRouter());
app.use('/api', createTextRouter(fluidCadServer));
app.use('/api', createFeatureGhostRouter(fluidCadServer));
app.use('/api', createFilesRouter({
  workspacePath: WORKSPACE_PATH,
  openFile: (absPath) => processFile(absPath),
  onWrite: (absPath, content) => pageWrites.record(absPath, content),
}));
app.use('/api', createEngineTypesRouter(PACKAGE_VERSION));
app.use('/api', createWorkspaceStateRouter(WORKSPACE_PATH));
app.use('/api', createUnitRouter({
  workspacePath: WORKSPACE_PATH,
  fluidCadServer,
  sendToExtension: sendToHost,
  broadcastToUI,
}));
app.use('/api', createPackRouter(fluidCadServer, WORKSPACE_PATH, PACKAGE_VERSION, getLastCameraState));
app.use('/api', createPartCatalogRouter(fluidCadServer, WORKSPACE_PATH, editDispatcher));
app.use('/api', createInstancePoseRouter(fluidCadServer, editDispatcher));
app.use('/api', createAssemblyMateRouter(fluidCadServer, editDispatcher));
app.use('/api', createAssemblyConnectorRouter(fluidCadServer, editDispatcher));

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
  sceneKind: FluidScriptKind;
  unit: LengthUnit;
  declaredUnit: LengthUnit | null;
  assembly?: SerializedAssembly;
}>();

attachEditorHostTransport({ core, hosts, dispatcher: editDispatcher, dirtyBufferState });

function emitSuccess(version: number, data: SceneRenderedData) {
  const { absPath, sceneKind, unit, declaredUnit, result, rollbackStop, breakpointHit, assembly, params } = data;
  lastSceneByFile.set(absPath, { result, rollbackStop, sceneKind, unit, declaredUnit, assembly });
  fluidCadServer.setCompileError(null);
  sendToExtension({
    type: 'scene-rendered',
    absPath,
    sceneKind,
    ...sceneUnitFields(data),
    result,
    rollbackStop,
    ...(assembly ? { assembly } : {}),
  });
  broadcastToUI({
    type: 'scene-rendered',
    result,
    absPath,
    sceneKind,
    ...sceneUnitFields(data),
    rollbackStop,
    breakpointHit,
    params,
    ...(assembly ? { assembly } : {}),
  });
  broadcastToUI({ type: 'render-version', version, state: 'end', absPath });
}

function buildCompileError(filePath: string, err: any): CompileError {
  const message = err?.message || String(err);
  const stack = typeof err?.stack === 'string' ? err.stack : '';
  let sourceLocation = stack ? extractSourceLocation(stack) : null;
  const normalized = normalizePath(filePath).replace('virtual:live-render:', '');
  if (sourceLocation) {
    sourceLocation = {
      filePath: sourceLocation.filePath.replace('virtual:live-render:', ''),
      line: sourceLocation.line,
      column: sourceLocation.column,
    };
  }
  return {
    message,
    filePath: normalized,
    sourceLocation: sourceLocation ?? undefined,
  };
}

function emitCompileError(version: number, filePath: string, err: any): CompileError {
  const compileError = buildCompileError(filePath, err);
  const key = compileError.filePath ?? normalizePath(filePath).replace('virtual:live-render:', '');
  const prev = lastSceneByFile.get(key);
  const result = prev?.result ?? [];
  const rollbackStop = prev?.rollbackStop ?? -1;
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
    rollbackStop,
    compileError,
    ...(assembly ? { assembly } : {}),
  });
  broadcastToUI({
    type: 'scene-rendered',
    result,
    absPath: key,
    sceneKind,
    ...units,
    rollbackStop,
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
 * HTTP caller (MCP) can hand it straight to the agent.
 */
async function runLiveRender(fileName: string, code: string, keepCurrent = false): Promise<RenderOutcome> {
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
    const data = dependency
      ? await fluidCadServer.updateDependencyCode(fileName, code)
      : await fluidCadServer.updateLiveCode(fileName, code);
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
      };
    }
    return {
      state: 'rendered',
      version: myVersion,
      absPath: data.absPath,
      durationMs: Date.now() - startedAt,
    };
  } catch (err) {
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
    if (myVersion !== renderVersion) { return; }
    if (data) {
      emitSuccess(myVersion, data);
      return;
    }
    // No data and no throw: there was nothing to render with. Say so rather
    // than leaving the page on its loading overlay.
    emitMissingEngine(myVersion, filePath);
  } catch (err) {
    if (myVersion !== renderVersion) { return; }
    emitCompileError(myVersion, filePath, err);
  }
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
        await runLiveRender(msg.fileName, msg.code, msg.keepCurrent === true);
        break;
      }

      case 'rollback': {
        const myVersion = ++renderVersion;
        broadcastToUI({ type: 'render-version', version: myVersion, state: 'start' });
        const data = await fluidCadServer.rollback(msg.fileName, msg.index);
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
          const result = fluidCadServer.exportShapes(msg.shapeIds, msg.options);
          if (result) {
            const data = typeof result.data === 'string'
              ? Buffer.from(result.data, 'utf-8').toString('base64')
              : Buffer.from(result.data).toString('base64');
            sendToExtension({
              type: 'export-complete',
              success: true,
              data,
              fileName: result.fileName,
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

// Listen for IPC messages from extension host
process.on('message', (msg: any) => {
  handleExtensionMessage(msg);
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

httpServer.listen(PORT, () => {
  const url = `http://localhost:${PORT}`;
  // Name the engine that is actually running, not just the port. A project can
  // pin a version (P0-4) and the whole point of the pin is that which kernel
  // built the geometry is worth stating out loud.
  console.log(`FluidCAD engine ${PACKAGE_VERSION} listening on ${url}`);

  // Warned here rather than in `bin/commands/serve.js` so that every host
  // reaches it: the extensions fork this file directly and never run the CLI,
  // and `serve` pipes our stdout through to the terminal anyway.
  const pinWarning = describeEnginePinMismatch(PROJECT_CONFIG, PACKAGE_VERSION);
  if (pinWarning) {
    console.warn(pinWarning);
  }
  const unitWarning = describeProjectUnitProblem(PROJECT_CONFIG);
  if (unitWarning) {
    console.warn(unitWarning);
  }

  // Tell the page about edits made outside it. Announcement only — the CLI's
  // watcher still owns re-rendering on an external change, so nothing here
  // changes what an existing host sees.
  if (WORKSPACE_PATH) {
    try {
      workspaceWatcher = createWorkspaceWatcher(WORKSPACE_PATH, (event) => {
        broadcastToUI(event);
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

  // Signal ready immediately so extension can show the webview
  sendToExtension({ type: 'ready', port: PORT, url });

  // Initialize FluidCAD server in the background
  fluidCadServer.init(WORKSPACE_PATH).then(() => {
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
