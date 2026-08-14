import fs from 'fs';
import http from 'http';
import path from 'path';
import express from 'express';
import { FluidCadServer } from './fluidcad-server.ts';
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
import { createTextRouter } from './routes/text.ts';
import { createFeatureGhostRouter } from './routes/feature-ghost.ts';
import { FeatureEditDispatcher } from './edit-dispatch.ts';
import { normalizePath } from './normalize-path.ts';
import type { CompileError, SerializedAssembly } from './ws-protocol.ts';
import { detectKind } from './file-kind.ts';
import type { FluidScriptKind } from './file-kind.ts';
import { writeInstanceFile, deleteInstanceFile } from './instance-file.ts';
import { addInstance, removeInstance } from './global-registry.ts';
import { extractSourceLocation, describeOcException } from '../../lib/dist/index.js';

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


// ---------------------------------------------------------------------------
// IPC helpers — communication with extension host process
// ---------------------------------------------------------------------------

/** Returns true when a host process received the message (IPC connected). */
function sendToExtension(msg: any): boolean {
  if (process.send) {
    process.send(msg);
    return true;
  }
  return false;
}

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
const editDispatcher = new FeatureEditDispatcher(fluidCadServer, sendToExtension);

app.use('/api', createHealthRouter({
  version: PACKAGE_VERSION,
  workspacePath: WORKSPACE_PATH,
  startedAt: STARTED_AT,
}));
app.use('/api', createPropertiesRouter(fluidCadServer));
app.use('/api', createParamsRouter(fluidCadServer, sendToExtension, broadcastToUI, editDispatcher));
app.use('/api', createHitTestRouter(fluidCadServer));
app.use('/api', createMeasureRouter(fluidCadServer));
app.use('/api', createTimelineRouter(fluidCadServer, sendToExtension, broadcastToUI));
app.use('/api', createSketchEditsRouter(fluidCadServer, sendToExtension, WORKSPACE_PATH));
app.use('/api', createApplyFeatureRouter(fluidCadServer, sendToExtension, { dispatcher: editDispatcher }));
app.use('/api', createExportRouter(fluidCadServer, WORKSPACE_PATH));
app.use('/api', createScreenshotRouter(requestScreenshot));
app.use('/api', createPreferencesRouter());
app.use('/api', createSceneRouter(fluidCadServer, getLastCameraState));
app.use('/api', createEditorRouter(dirtyBufferState, editDispatcher));
app.use('/api', createRenderRouter((fileName, code) => runLiveRender(fileName, code)));
app.use('/api', createLintRouter());
app.use('/api', createTextRouter(fluidCadServer));
app.use('/api', createFeatureGhostRouter(fluidCadServer));
app.use('/api', createPackRouter(fluidCadServer, WORKSPACE_PATH, PACKAGE_VERSION, getLastCameraState));
app.use('/api', createPartCatalogRouter(fluidCadServer, WORKSPACE_PATH, editDispatcher));
app.use('/api', createInstancePoseRouter(fluidCadServer, editDispatcher));
app.use('/api', createAssemblyMateRouter(fluidCadServer, editDispatcher));

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
const lastSceneByFile = new Map<string, { result: any[]; rollbackStop: number; sceneKind: FluidScriptKind; assembly?: SerializedAssembly }>();

// What the attached editor host offers, from its `editor-hello`. Stays null
// when no host ever announces itself (standalone serve, hub) — the UI then
// keeps its editor-history controls hidden.
let editorCapabilities: { undoRedo: boolean } | null = null;

// The hello usually lands before the first UI connection (the extension forks
// the server, then opens the webview), so late-joining clients get a replay.
core.setConnectionHandler((_sessionId, ws) => {
  if (editorCapabilities) {
    ws.send(JSON.stringify({ type: 'editor-capabilities', ...editorCapabilities }));
  }
});

function emitSuccess(
  version: number,
  absPath: string,
  sceneKind: FluidScriptKind,
  result: any[],
  rollbackStop: number,
  breakpointHit?: boolean,
  assembly?: SerializedAssembly,
  params?: any[],
) {
  lastSceneByFile.set(absPath, { result, rollbackStop, sceneKind, assembly });
  fluidCadServer.setCompileError(null);
  sendToExtension({
    type: 'scene-rendered',
    absPath,
    sceneKind,
    result,
    rollbackStop,
    ...(assembly ? { assembly } : {}),
  });
  broadcastToUI({
    type: 'scene-rendered',
    result,
    absPath,
    sceneKind,
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
  const assembly = prev?.assembly;
  fluidCadServer.setCompileError(compileError);
  sendToExtension({
    type: 'scene-rendered',
    absPath: key,
    sceneKind,
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
    rollbackStop,
    compileError,
    ...(assembly ? { assembly } : {}),
  });
  broadcastToUI({ type: 'render-version', version, state: 'error', absPath: key });
  return compileError;
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
      return { state: 'no-scene-manager', version: myVersion, durationMs: Date.now() - startedAt };
    }
    emitSuccess(myVersion, data.absPath, data.sceneKind, data.result, data.rollbackStop, data.breakpointHit, data.assembly, data.params);
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

async function handleExtensionMessage(msg: any) {
  try {
    switch (msg.type) {
      case 'process-file': {
        const myVersion = ++renderVersion;
        broadcastToUI({ type: 'render-version', version: myVersion, state: 'start' });
        broadcastToUI({ type: 'processing-file' });
        currentFile = msg.filePath;
        try {
          const data = await fluidCadServer.processFile(msg.filePath);
          if (myVersion !== renderVersion) { return; }
          if (data) {
            emitSuccess(myVersion, data.absPath, data.sceneKind, data.result, data.rollbackStop, data.breakpointHit, data.assembly, data.params);
          }
        } catch (err) {
          if (myVersion !== renderVersion) { return; }
          emitCompileError(myVersion, msg.filePath, err);
        }
        break;
      }

      case 'live-update': {
        await runLiveRender(msg.fileName, msg.code, msg.keepCurrent === true);
        break;
      }

      case 'rollback': {
        const myVersion = ++renderVersion;
        broadcastToUI({ type: 'render-version', version: myVersion, state: 'start' });
        const data = await fluidCadServer.rollback(msg.fileName, msg.index);
        if (myVersion !== renderVersion) { return; }
        if (data) {
          emitSuccess(myVersion, data.absPath, data.sceneKind, data.result, data.rollbackStop, data.breakpointHit, data.assembly);
        }
        break;
      }

      case 'import-file': {
        try {
          await fluidCadServer.importFile(msg.workspacePath, msg.fileName, msg.data);
          sendToExtension({ type: 'import-complete', success: true });
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
        editorCapabilities = { undoRedo: msg.capabilities?.undoRedo === true };
        broadcastToUI({ type: 'editor-capabilities', ...editorCapabilities });
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
  console.log(`FluidCAD server listening on ${url}`);

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
