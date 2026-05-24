import crypto from 'crypto';
import fs from 'fs';
import http from 'http';
import path from 'path';
import express from 'express';
import { WebSocketServer, WebSocket } from 'ws';
import { FluidCadServer } from './fluidcad-server.ts';
import { createPropertiesRouter } from './routes/properties.ts';
import { createActionsRouter } from './routes/actions.ts';
import { createExportRouter } from './routes/export.ts';
import { createScreenshotRouter } from './routes/screenshot.ts';
import { createPreferencesRouter } from './routes/preferences.ts';
import { createHealthRouter } from './routes/health.ts';
import { createSceneRouter } from './routes/scene.ts';
import { createEditorRouter, DirtyBufferState } from './routes/editor.ts';
import { createRenderRouter, type RenderOutcome } from './routes/render.ts';
import { createLintRouter } from './routes/lint.ts';
import { normalizePath } from './normalize-path.ts';
import { writeInstanceFile, deleteInstanceFile } from './instance-file.ts';
import { addInstance, removeInstance } from './global-registry.ts';
import type { CameraStateMessage, CompileError, ServerToUIMessage } from './ws-protocol.ts';
import { extractSourceLocation } from '../../lib/dist/index.js';

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

app.use('/api', createHealthRouter({
  version: PACKAGE_VERSION,
  workspacePath: WORKSPACE_PATH,
  startedAt: STARTED_AT,
}));
app.use('/api', createPropertiesRouter(fluidCadServer));
app.use('/api', createActionsRouter(fluidCadServer, sendToExtension, broadcastToUI, WORKSPACE_PATH));
app.use('/api', createExportRouter(fluidCadServer, WORKSPACE_PATH));
app.use('/api', createScreenshotRouter(requestScreenshot));
app.use('/api', createPreferencesRouter());
app.use('/api', createSceneRouter(fluidCadServer, () => lastCameraState));
app.use('/api', createEditorRouter(dirtyBufferState));
app.use('/api', createRenderRouter((fileName, code) => runLiveRender(fileName, code)));
app.use('/api', createLintRouter());

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
// HTTP + WebSocket server
// ---------------------------------------------------------------------------

const httpServer = http.createServer(app);
const wss = new WebSocketServer({ server: httpServer });
const uiClients = new Set<WebSocket>();
let lastSceneMessage: string | null = null;
let initCompleteMessage: string | null = null;
let lastCameraState: CameraStateMessage | null = null;

function broadcastToUI(msg: ServerToUIMessage) {
  const data = JSON.stringify(msg);
  if (msg.type === 'scene-rendered') {
    lastSceneMessage = data;
  }
  if (msg.type === 'init-complete') {
    initCompleteMessage = data;
  }
  for (const client of uiClients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(data);
    }
  }
}

// ---------------------------------------------------------------------------
// Screenshot request/response coordination
// ---------------------------------------------------------------------------

const SCREENSHOT_TIMEOUT_MS = 10_000;
const pendingScreenshots = new Map<string, {
  resolve: (data: Buffer) => void;
  reject: (err: Error) => void;
}>();

function requestScreenshot(options: Record<string, unknown>): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    if (uiClients.size === 0) {
      reject(new Error('No UI client connected.'));
      return;
    }

    const requestId = crypto.randomUUID();

    const timeout = setTimeout(() => {
      pendingScreenshots.delete(requestId);
      reject(new Error('Screenshot request timed out.'));
    }, SCREENSHOT_TIMEOUT_MS);

    pendingScreenshots.set(requestId, {
      resolve(data) {
        clearTimeout(timeout);
        pendingScreenshots.delete(requestId);
        resolve(data);
      },
      reject(err) {
        clearTimeout(timeout);
        pendingScreenshots.delete(requestId);
        reject(err);
      },
    });

    broadcastToUI({ type: 'take-screenshot', requestId, options });
  });
}

function handleUIMessage(raw: string): void {
  let msg: any;
  try {
    msg = JSON.parse(raw);
  } catch {
    return;
  }

  if (msg.type === 'screenshot-result' && msg.requestId) {
    const pending = pendingScreenshots.get(msg.requestId);
    if (!pending) { return; }

    if (msg.success && msg.data) {
      pending.resolve(Buffer.from(msg.data, 'base64'));
    } else {
      pending.reject(new Error(msg.error || 'Screenshot failed.'));
    }
    return;
  }

  if (msg.type === 'camera-state') {
    // Trust UI structure — we own both ends. Just shape-check arrays.
    if (
      Array.isArray(msg.position) && msg.position.length === 3 &&
      Array.isArray(msg.target) && msg.target.length === 3 &&
      Array.isArray(msg.up) && msg.up.length === 3
    ) {
      lastCameraState = {
        type: 'camera-state',
        position: msg.position,
        target: msg.target,
        up: msg.up,
        projection: msg.projection === 'perspective' ? 'perspective' : 'orthographic',
      };
    }
  }
}

// ---------------------------------------------------------------------------
// WebSocket connections
// ---------------------------------------------------------------------------

wss.on('connection', (ws) => {
  uiClients.add(ws);

  // Replay init-complete and last scene to newly connected UI client
  if (initCompleteMessage) {
    ws.send(initCompleteMessage);
  }
  if (lastSceneMessage) {
    ws.send(lastSceneMessage);
  }

  ws.on('message', (data) => {
    handleUIMessage(String(data));
  });

  ws.on('close', () => {
    uiClients.delete(ws);
  });
});

// ---------------------------------------------------------------------------
// IPC message handling — extension host → server
// ---------------------------------------------------------------------------

let currentFile: string | null = null;
let renderVersion = 0;
const lastSceneByFile = new Map<string, { result: any[]; rollbackStop: number }>();

function emitSuccess(version: number, absPath: string, result: any[], rollbackStop: number, breakpointHit?: boolean, params?: any[]) {
  lastSceneByFile.set(absPath, { result, rollbackStop });
  fluidCadServer.setCompileError(null);
  sendToExtension({
    type: 'scene-rendered',
    absPath,
    result,
    rollbackStop,
  });
  broadcastToUI({
    type: 'scene-rendered',
    result,
    absPath,
    rollbackStop,
    breakpointHit,
    params,
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
  fluidCadServer.setCompileError(compileError);
  sendToExtension({
    type: 'scene-rendered',
    absPath: key,
    result,
    rollbackStop,
    compileError,
  });
  broadcastToUI({
    type: 'scene-rendered',
    result,
    absPath: key,
    rollbackStop,
    compileError,
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
    emitSuccess(myVersion, data.absPath, data.result, data.rollbackStop, data.breakpointHit, data.params);
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
            emitSuccess(myVersion, data.absPath, data.result, data.rollbackStop, data.breakpointHit, data.params);
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
          emitSuccess(myVersion, data.absPath, data.result, data.rollbackStop);
        }
        break;
      }

      case 'import-file': {
        try {
          await fluidCadServer.importFile(msg.workspacePath, msg.fileName, msg.data);
          sendToExtension({ type: 'import-complete', success: true });
        } catch (err: any) {
          sendToExtension({ type: 'error', message: err.stack || err.message || String(err) });
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
