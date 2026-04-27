import crypto from 'crypto';
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
import { normalizePath } from './normalize-path.ts';
import type { CompileError, ServerToUIMessage } from './ws-protocol.ts';
import { extractSourceLocation } from '../../lib/dist/index.js';

const PORT = parseInt(process.env.FLUIDCAD_SERVER_PORT || '3100', 10);
const WORKSPACE_PATH = normalizePath(process.env.FLUIDCAD_WORKSPACE_PATH || '');
const UI_DIST = path.resolve(import.meta.dirname, '../../ui/dist');

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

const app = express();
app.use(express.json({ limit: '50mb' }));

app.use('/api', createPropertiesRouter(fluidCadServer));
app.use('/api', createActionsRouter(fluidCadServer, sendToExtension, broadcastToUI, WORKSPACE_PATH));
app.use('/api', createExportRouter(fluidCadServer));
app.use('/api', createScreenshotRouter(requestScreenshot));
app.use('/api', createPreferencesRouter());

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

function emitSuccess(absPath: string, result: any[], rollbackStop: number, breakpointHit?: boolean) {
  lastSceneByFile.set(absPath, { result, rollbackStop });
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
  });
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

function emitCompileError(filePath: string, err: any) {
  const compileError = buildCompileError(filePath, err);
  const key = compileError.filePath ?? normalizePath(filePath).replace('virtual:live-render:', '');
  const prev = lastSceneByFile.get(key);
  const result = prev?.result ?? [];
  const rollbackStop = prev?.rollbackStop ?? -1;
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
}

async function handleExtensionMessage(msg: any) {
  try {
    switch (msg.type) {
      case 'process-file': {
        const myVersion = ++renderVersion;
        broadcastToUI({ type: 'processing-file' });
        currentFile = msg.filePath;
        try {
          const data = await fluidCadServer.processFile(msg.filePath);
          if (myVersion !== renderVersion) { return; }
          if (data) {
            emitSuccess(data.absPath, data.result, data.rollbackStop, data.breakpointHit);
          }
        } catch (err) {
          if (myVersion !== renderVersion) { return; }
          emitCompileError(msg.filePath, err);
        }
        break;
      }

      case 'live-update': {
        const myVersion = ++renderVersion;
        if (msg.fileName !== currentFile) {
          broadcastToUI({ type: 'processing-file' });
          currentFile = msg.fileName;
        }
        try {
          const data = await fluidCadServer.updateLiveCode(msg.fileName, msg.code);
          if (myVersion !== renderVersion) { return; }
          if (data) {
            emitSuccess(data.absPath, data.result, data.rollbackStop, data.breakpointHit);
          }
        } catch (err) {
          if (myVersion !== renderVersion) { return; }
          emitCompileError(msg.fileName, err);
        }
        break;
      }

      case 'rollback': {
        const myVersion = ++renderVersion;
        const data = await fluidCadServer.rollback(msg.fileName, msg.index);
        if (myVersion !== renderVersion) { return; }
        if (data) {
          emitSuccess(data.absPath, data.result, data.rollbackStop);
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
