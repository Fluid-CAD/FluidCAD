import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import http from 'http';
import { WebSocket } from 'ws';
import { createServerCore } from '../src/server-core.ts';
import type { ServerCore } from '../src/server-core.ts';

// What a page is told the moment it connects decides whether it shows a
// spinner. `fluidcad serve` on a folder with no parts or assemblies used to
// leave the page on "Loading model…" forever: init had completed, nothing was
// ever going to render, and the page had no way to tell the two apart. Now a
// render in flight is replayed as `processing-file`, and its absence means
// "nothing coming — show the empty scene".

let server: http.Server;
let core: ServerCore;
let wsUrl: string;
let sockets: WebSocket[];

async function connect(): Promise<any[]> {
  const ws = new WebSocket(wsUrl);
  sockets.push(ws);
  const received: any[] = [];
  ws.on('message', (raw) => { received.push(JSON.parse(String(raw))); });
  await new Promise<void>((resolve, reject) => {
    ws.once('open', () => resolve());
    ws.once('error', reject);
  });
  // The replay is sent synchronously on connection; give it one turn to land.
  await new Promise((resolve) => setTimeout(resolve, 50));
  return received;
}

const SCENE = { type: 'scene-rendered', result: [], absPath: '/ws/a.part.js', sceneKind: 'part', rollbackStop: -1 } as any;

describe('server core connect replay', () => {
  beforeEach(async () => {
    sockets = [];
    server = http.createServer();
    core = createServerCore(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const addr = server.address();
    const port = typeof addr === 'object' && addr ? addr.port : 0;
    wsUrl = `ws://127.0.0.1:${port}`;
  });

  afterEach(async () => {
    for (const ws of sockets) {
      ws.close();
    }
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('an initialized workspace with nothing to open replays init-complete and no render', async () => {
    core.broadcastToUI({ type: 'init-complete', success: true });
    const received = await connect();
    expect(received.map((m) => m.type)).toEqual(['init-complete']);
  });

  it('a render in flight is replayed so a late page shows its spinner', async () => {
    core.broadcastToUI({ type: 'init-complete', success: true });
    core.broadcastToUI({ type: 'processing-file' });
    const received = await connect();
    expect(received.map((m) => m.type)).toEqual(['init-complete', 'processing-file']);
  });

  it('a landed render is replayed as the scene, with nothing in flight', async () => {
    core.broadcastToUI({ type: 'init-complete', success: true });
    core.broadcastToUI({ type: 'processing-file' });
    core.broadcastToUI(SCENE);
    const received = await connect();
    expect(received.map((m) => m.type)).toEqual(['init-complete', 'scene-rendered']);
  });

  it('a closed scene is not replayed — the page lands on an empty scene', async () => {
    core.broadcastToUI({ type: 'init-complete', success: true });
    core.broadcastToUI({ type: 'scene-rendered', ...SCENE });
    core.broadcastToUI({ type: 'scene-closed' });
    const received = await connect();
    expect(received.map((m) => m.type)).toEqual(['init-complete']);
  });

  it('a re-render of a shown scene replays the scene, then the in-flight marker', async () => {
    core.broadcastToUI({ type: 'init-complete', success: true });
    core.broadcastToUI(SCENE);
    core.broadcastToUI({ type: 'processing-file' });
    const received = await connect();
    expect(received.map((m) => m.type)).toEqual(['init-complete', 'scene-rendered', 'processing-file']);
  });
});
