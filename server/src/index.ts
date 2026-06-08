import fs from 'fs';
import http from 'http';
import path from 'path';
import express from 'express';
import { FluidCadServer } from './fluidcad-server.ts';
import { createServerCore } from './server-core.ts';
import { createPropertiesRouter } from './routes/properties.ts';
import { createParamsRouter } from './routes/params.ts';
import { createHitTestRouter } from './routes/hit-test.ts';
import { createTimelineRouter } from './routes/timeline.ts';
import { createSketchEditsRouter } from './routes/sketch-edits.ts';
import { createExportRouter } from './routes/export.ts';
import { createScreenshotRouter } from './routes/screenshot.ts';
import { createPreferencesRouter } from './routes/preferences.ts';
import { createHealthRouter } from './routes/health.ts';
import { createSceneRouter } from './routes/scene.ts';
import { createEditorRouter, DirtyBufferState } from './routes/editor.ts';
import { createRenderRouter, type RenderOutcome } from './routes/render.ts';
import { createLintRouter } from './routes/lint.ts';
import { createPackRouter } from './routes/pack.ts';
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

function sendToExtension(msg: any) {
  if (process.send) {
    process.send(msg);
  }
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

app.use('/api', createHealthRouter({
  version: PACKAGE_VERSION,
  workspacePath: WORKSPACE_PATH,
  startedAt: STARTED_AT,
}));
app.use('/api', createPropertiesRouter(fluidCadServer));
app.use('/api', createParamsRouter(fluidCadServer, sendToExtension, broadcastToUI));
app.use('/api', createHitTestRouter(fluidCadServer));
app.use('/api', createTimelineRouter(fluidCadServer, sendToExtension, broadcastToUI));
app.use('/api', createSketchEditsRouter(fluidCadServer, sendToExtension, WORKSPACE_PATH));
app.use('/api', createExportRouter(fluidCadServer, WORKSPACE_PATH));
app.use('/api', createScreenshotRouter(requestScreenshot));
app.use('/api', createPreferencesRouter());
app.use('/api', createSceneRouter(fluidCadServer, getLastCameraState));
app.use('/api', createEditorRouter(dirtyBufferState));
app.use('/api', createRenderRouter((fileName, code) => runLiveRender(fileName, code)));
app.use('/api', createLintRouter());
app.use('/api', createPackRouter(fluidCadServer, WORKSPACE_PATH, PACKAGE_VERSION, getLastCameraState));

// Static files — serve UI build, with SPA fallback
app.use(express.static(UI_DIST, {
  setHeaders(res, filePath) {
    if (path.extname(filePath) === '.html') {
      res.setHeader('Cache-Control', 'no-cache');
    }
  },
}));
app.get('*splat', (_req, res) => {
  res.setHeader('Cache-Control', 'no-cache');
  res.sendFile(path.join(UI_DIST, 'index.html'));
});

// ---------------------------------------------------------------------------
// IPC message handling — extension host → server
// ---------------------------------------------------------------------------

let currentFile: string | null = null;
let renderVersion = 0;
const lastSceneByFile = new Map<string, { result: any[]; rollbackStop: number; sceneKind: FluidScriptKind; assembly?: SerializedAssembly }>();

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
async function runLiveRender(fileName: string, code: string): Promise<RenderOutcome> {
  const startedAt = Date.now();
  const myVersion = ++renderVersion;
  broadcastToUI({ type: 'render-version', version: myVersion, state: 'start' });
  if (fileName !== currentFile) {
    broadcastToUI({ type: 'processing-file' });
    currentFile = fileName;
  }
  try {
    const data = await fluidCadServer.updateLiveCode(fileName, code);
    if (myVersion !== renderVersion) {
      return { state: 'superseded', version: myVersion, durationMs: Date.now() - startedAt };
    }
    if (!data) {
      return { state: 'no-scene-manager', version: myVersion, durationMs: Date.now() - startedAt };
    }
    emitSuccess(myVersion, data.absPath, data.sceneKind, data.result, data.rollbackStop, data.breakpointHit, data.assembly, data.params);
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
        await runLiveRender(msg.fileName, msg.code);
        break;
      }

      case 'rollback': {
        const myVersion = ++renderVersion;
        broadcastToUI({ type: 'render-version', version: myVersion, state: 'start' });
        const data = await fluidCadServer.rollback(msg.fileName, msg.index);
        if (myVersion !== renderVersion) { return; }
        if (data) {
          emitSuccess(myVersion, data.absPath, data.sceneKind, data.result, data.rollbackStop, undefined, data.assembly);
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
