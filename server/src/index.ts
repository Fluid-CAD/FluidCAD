import http from 'http';
import path from 'path';
import express from 'express';
import { WebSocketServer, WebSocket } from 'ws';
import { FluidCadServer } from './fluidcad-server.ts';
import { createPropertiesRouter } from './routes/properties.ts';
import { createActionsRouter } from './routes/actions.ts';
import type { ServerToUIMessage } from './ws-protocol.ts';

const PORT = parseInt(process.env.FLUIDCAD_SERVER_PORT || '3100', 10);
const WORKSPACE_PATH = process.env.FLUIDCAD_WORKSPACE_PATH || '';
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

function broadcastToUI(msg: ServerToUIMessage) {
  const data = JSON.stringify(msg);
  if (msg.type === 'scene-rendered') {
    lastSceneMessage = data;
  }
  for (const client of uiClients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(data);
    }
  }
}

wss.on('connection', (ws) => {
  uiClients.add(ws);

  // Replay last scene to newly connected UI client
  if (lastSceneMessage) {
    ws.send(lastSceneMessage);
  }

  ws.on('close', () => {
    uiClients.delete(ws);
  });
});

// ---------------------------------------------------------------------------
// IPC message handling — extension host → server
// ---------------------------------------------------------------------------

let currentFile: string | null = null;

async function handleExtensionMessage(msg: any) {
  try {
    switch (msg.type) {
      case 'process-file': {
        broadcastToUI({ type: 'processing-file' });
        currentFile = msg.filePath;
        const data = await fluidCadServer.processFile(msg.filePath);
        if (data) {
          sendToExtension({
            type: 'scene-rendered',
            absPath: data.absPath,
            result: data.result,
            rollbackStop: data.rollbackStop,
          });
          broadcastToUI({
            type: 'scene-rendered',
            result: data.result,
            absPath: data.absPath,
          });
        }
        break;
      }

      case 'live-update': {
        if (msg.fileName !== currentFile) {
          broadcastToUI({ type: 'processing-file' });
          currentFile = msg.fileName;
        }
        const data = await fluidCadServer.updateLiveCode(msg.fileName, msg.code);
        if (data) {
          sendToExtension({
            type: 'scene-rendered',
            absPath: data.absPath,
            result: data.result,
            rollbackStop: data.rollbackStop,
          });
          broadcastToUI({
            type: 'scene-rendered',
            result: data.result,
            absPath: data.absPath,
          });
        }
        break;
      }

      case 'rollback': {
        const data = await fluidCadServer.rollback(msg.fileName, msg.index);
        if (data) {
          sendToExtension({
            type: 'scene-rendered',
            absPath: data.absPath,
            result: data.result,
            rollbackStop: data.rollbackStop,
          });
          broadcastToUI({
            type: 'scene-rendered',
            result: data.result,
            absPath: data.absPath,
            rollbackStop: data.rollbackStop,
          });
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
