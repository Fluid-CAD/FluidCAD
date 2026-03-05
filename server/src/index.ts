import http from 'http';
import fs from 'fs';
import path from 'path';
import { WebSocketServer, WebSocket } from 'ws';
import { FluidCadServer } from './fluidcad-server.ts';
import type { ServerToUIMessage } from './ws-protocol.ts';
import { getMaterials } from '../../lib/common/materials.ts';

const PORT = parseInt(process.env.FLUIDCAD_SERVER_PORT || '3100', 10);
const WORKSPACE_PATH = process.env.FLUIDCAD_WORKSPACE_PATH || '';
const UI_DIST = path.resolve(import.meta.dirname, '../../ui/dist');

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

// ---------------------------------------------------------------------------
// IPC helpers — communication with extension host process
// ---------------------------------------------------------------------------

function sendToExtension(msg: any) {
  if (process.send) {
    process.send(msg);
  }
}

// ---------------------------------------------------------------------------
// HTTP server — serves UI static files
// ---------------------------------------------------------------------------

const httpServer = http.createServer((req, res) => {
  const url = new URL(req.url!, `http://localhost`);

  if (url.pathname === '/api/materials') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(getMaterials()));
    return;
  }

  if (url.pathname === '/api/shape-properties') {
    const shapeId = url.searchParams.get('shapeId') || '';
    const props = fluidCadServer.getShapeProperties(shapeId);
    if (!props) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Shape not found' }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(props));
    return;
  }

  let filePath = path.join(UI_DIST, req.url === '/' ? 'index.html' : req.url!);

  // Prevent directory traversal
  if (!filePath.startsWith(UI_DIST)) {
    res.writeHead(403);
    res.end();
    return;
  }

  if (!fs.existsSync(filePath)) {
    // SPA fallback
    filePath = path.join(UI_DIST, 'index.html');
  }

  const ext = path.extname(filePath);
  const contentType = MIME_TYPES[ext] || 'application/octet-stream';

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(500);
      res.end('Internal Server Error');
      return;
    }
    const headers: Record<string, string> = { 'Content-Type': contentType };
    if (ext === '.html') {
      headers['Cache-Control'] = 'no-cache';
    }
    res.writeHead(200, headers);
    res.end(data);
  });
});

// ---------------------------------------------------------------------------
// WebSocket server — UI clients only
// ---------------------------------------------------------------------------

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
// FluidCAD server + IPC message handling
// ---------------------------------------------------------------------------

const fluidCadServer = new FluidCadServer();

async function handleExtensionMessage(msg: any) {
  try {
    switch (msg.type) {
      case 'process-file': {
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
  }).catch((err: any) => {
    sendToExtension({ type: 'init-complete', success: false, error: err.stack || err.message || String(err) });
  });
});
