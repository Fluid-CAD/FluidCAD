import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import http from 'http';
import { WebSocket } from 'ws';
import { createServerCore } from '../src/server-core.ts';
import type { ServerCore, ServerCoreOptions } from '../src/server-core.ts';
import { MeshesRoute } from '../src/routes/meshes.ts';
import { MeshLedger } from '../src/scene-meshes/mesh-ledger.ts';
import { MeshStore } from '../src/scene-meshes/mesh-store.ts';
import { SceneMeshes } from '../src/scene-meshes/scene-meshes.ts';

// Unchanged parts don't move bytes (generators S6b, P5). Every rendered
// shape names its mesh payload by `meshKey`; a page that keeps a mesh cache
// says so in its hello and is then sent, for a payload this connection was
// sent recently, the shape with `meshRef` in place of meshes, vertices and
// faceVertices. Every other receiver — an older page, the MCP's socket, a
// host that doesn't serve the fallback — gets whole scenes. A page that
// misses a key asks POST /api/meshes, answered from the newest scenes.

const tick = (ms = 30) => new Promise((resolve) => setTimeout(resolve, ms));

/** A shape whose payload weighs 9 + 9 + 3 + 3 + 1 = 25 numbers. */
function shape(key: string, extra: Record<string, unknown> = {}): any {
  const n = key.charCodeAt(0);
  return {
    shapeId: `shape-${key}`,
    meshKey: key,
    shapeType: 'solid',
    role: 'body',
    meshes: [{ label: 'solid-faces', vertices: [n, 0, 0, 0, n, 0, 0, 0, n], normals: [0, 0, 1, 0, 0, 1, 0, 0, 1], indices: [0, 1, 2] }],
    vertices: [n, 1, 2],
    faceVertices: [[0]],
    ...extra,
  };
}
const WEIGHT = 25;

function scene(...rows: any[][]): any {
  return {
    type: 'scene-rendered',
    result: rows.map((shapes, i) => ({ id: `row-${i}`, type: 'extrude', sceneShapes: shapes })),
    absPath: '/ws/shop.assembly.js',
    sceneKind: 'assembly',
    rollbackStop: -1,
  };
}

type Page = { ws: WebSocket; received: any[]; raw: string[]; send(msg: unknown): void; scenes(): any[] };

let httpServer: http.Server;
let core: ServerCore;
let base: string;
let wsUrl: string;
let pages: Page[];

async function start(options: ServerCoreOptions = { meshRefs: true }): Promise<void> {
  const app = express();
  // As index.ts reads bodies.
  app.use(express.json({ limit: '50mb' }));
  httpServer = http.createServer(app);
  core = createServerCore(httpServer, options);
  app.use('/api', MeshesRoute.router(core.meshes));
  await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', () => resolve()));
  const addr = httpServer.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  base = `http://127.0.0.1:${port}`;
  wsUrl = `ws://127.0.0.1:${port}`;
}

/** A client: `hello` sent as the page sends it, or nothing (the MCP's socket). */
async function connect(hello?: Record<string, unknown>): Promise<Page> {
  const ws = new WebSocket(wsUrl);
  const page: Page = {
    ws, received: [], raw: [],
    send: (msg) => ws.send(JSON.stringify(msg)),
    scenes: () => page.received.filter((m) => m.type === 'scene-rendered'),
  };
  pages.push(page);
  ws.on('message', (raw) => {
    page.raw.push(String(raw));
    page.received.push(JSON.parse(String(raw)));
  });
  await new Promise<void>((resolve, reject) => {
    ws.once('open', () => resolve());
    ws.once('error', reject);
  });
  if (hello) {
    page.send({ type: 'ui-hello', sceneAcks: true, ...hello });
  }
  await tick();
  return page;
}

const withCache = (capacity = 1_000_000) => ({ meshCache: { capacity } });

async function broadcast(msg: any): Promise<number> {
  const bytes = core.broadcastToUI(msg);
  await tick();
  return bytes;
}

/** The shapes of a received scene, row by row. */
function shapesOf(msg: any): any[] {
  return msg.result.flatMap((row: any) => [...(row.sceneShapes ?? []), ...(row.hiddenShapes ?? [])]);
}

async function lookup(body: unknown): Promise<{ status: number; body: any }> {
  const res = await fetch(`${base}/api/meshes`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

describe('mesh references on the scene wire', () => {
  beforeEach(() => {
    pages = [];
  });

  afterEach(async () => {
    for (const page of pages) {
      page.ws.close();
    }
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
  });

  it('sends a page with a mesh cache a meshRef for every payload it was sent, the rest whole', async () => {
    await start();
    const page = await connect(withCache());
    await broadcast(scene([shape('A'), shape('B')]));
    expect(shapesOf(page.scenes()[0])).toEqual([shape('A'), shape('B')]);

    const fullBytes = JSON.stringify({ ...scene([shape('A'), shape('C')]), sceneVersion: 2 }).length;
    const bytes = await broadcast(scene([shape('A'), shape('C')]));
    const [a, c] = shapesOf(page.scenes()[1]);
    // A: every field but the payload's, named by its key.
    expect(a).toEqual({ shapeId: 'shape-A', shapeType: 'solid', role: 'body', meshRef: 'A' });
    expect(c).toEqual(shape('C'));
    expect(bytes).toBe(Buffer.byteLength(page.raw.at(-1)!));
    expect(bytes).toBeLessThan(fullBytes);
    // Everything else about the message is as broadcast.
    expect({ ...page.scenes()[1], result: null }).toEqual({ ...scene(), sceneVersion: 2, result: null });
  });

  it('sends a payload once per message: the same key again in that message is a reference', async () => {
    await start();
    const page = await connect(withCache());
    const msg = scene([shape('D')], []);
    msg.result[1].hiddenShapes = [shape('D', { shapeId: 'shape-D2' })];
    await broadcast(msg);
    const [first, second] = shapesOf(page.scenes()[0]);
    expect(first).toEqual(shape('D'));
    expect(second).toEqual({ shapeId: 'shape-D2', shapeType: 'solid', role: 'body', meshRef: 'D' });
  });

  it('sends whole scenes to a page without a mesh cache and to a client that never says hello', async () => {
    await start();
    const older = await connect({});
    const socket = await connect();
    const page = await connect(withCache());
    await broadcast(scene([shape('A')]));
    await broadcast(scene([shape('A'), shape('B')]));
    const whole = JSON.stringify({ ...scene([shape('A'), shape('B')]), sceneVersion: 2 });
    expect(older.raw.at(-1)).toBe(whole);
    expect(socket.raw.at(-1)).toBe(whole);
    // The page with a cache, meanwhile, was sent A by reference.
    expect(shapesOf(page.scenes()[1])[0]).toEqual({ shapeId: 'shape-A', shapeType: 'solid', role: 'body', meshRef: 'A' });
    // No ledger is kept for a page whose hello announced no cache.
    const clients = [...core.uiClients];
    expect(clients.filter((client) => client.meshRefs)).toHaveLength(1);
    expect(clients.filter((client) => client.meshLedger === null)).toHaveLength(1);
  });

  it('sends whole scenes everywhere when the host does not serve the fallback', async () => {
    await start({});
    const page = await connect(withCache());
    await broadcast(scene([shape('A')]));
    await broadcast(scene([shape('A')]));
    expect(shapesOf(page.scenes()[1])).toEqual([shape('A')]);
    expect([...core.uiClients][0].meshLedger).toBeNull();
  });

  it('replays the newest scene whole to a page that connects, and counts its payloads held after the hello', async () => {
    await start();
    await broadcast(scene([shape('A'), shape('B')]));
    const page = await connect(withCache());
    expect(page.scenes()).toHaveLength(1);
    expect(shapesOf(page.scenes()[0])).toEqual([shape('A'), shape('B')]);

    await broadcast(scene([shape('A'), shape('C')]));
    expect(shapesOf(page.scenes()[1]).map((s) => s.meshRef ?? 'whole')).toEqual(['A', 'whole']);
  });

  it('bounds each connection by half the capacity its page announced, least recently sent first', async () => {
    await start();
    // Room for two payloads on the server's side.
    const page = await connect(withCache(4 * WEIGHT));
    const ledger = [...core.uiClients][0].meshLedger!;
    expect(ledger.maxWeight).toBe(2 * WEIGHT);

    await broadcast(scene([shape('A')]));
    await broadcast(scene([shape('B')]));
    await broadcast(scene([shape('C')]));
    // A went out of the ledger with C: sent whole again; C by reference.
    await broadcast(scene([shape('A'), shape('C')]));
    expect(shapesOf(page.scenes()[3]).map((s) => s.meshRef ?? 'whole')).toEqual(['whole', 'C']);
    expect(ledger.size).toBe(2);
    expect(ledger.totalWeight).toBe(2 * WEIGHT);

    // The ledger goes with the connection.
    page.ws.close();
    await tick();
    expect(core.uiClients.size).toBe(0);
  });

  it('answers the fallback from the newest scenes, the missing keys named', async () => {
    await start();
    await connect(withCache());
    await broadcast(scene([shape('A'), shape('B')]));
    await broadcast(scene([shape('A'), shape('C')]));
    const answer = await lookup({ keys: ['C', 'A', 'B', 'Z', 'C'] });
    expect(answer.status).toBe(200);
    expect(answer.body.meshes).toEqual({
      C: SceneMeshes.payloadOf(shape('C')),
      A: SceneMeshes.payloadOf(shape('A')),
      // B is only in the older scene, still kept.
      B: SceneMeshes.payloadOf(shape('B')),
    });
    expect(answer.body.missing).toEqual(['Z']);

    // Past the scenes it keeps, the oldest scene's keys are missing.
    for (let i = 0; i < MeshStore.MAX_SCENES; i++) {
      await broadcast(scene([shape('E')]));
    }
    expect((await lookup({ keys: ['B', 'E'] })).body).toEqual({ meshes: { E: SceneMeshes.payloadOf(shape('E')) }, missing: ['B'] });
  });

  it('refuses a fallback request that is not a list of keys', async () => {
    await start();
    expect((await lookup({})).status).toBe(400);
    expect((await lookup({ keys: 'A' })).status).toBe(400);
    expect((await lookup({ keys: ['A', 7] })).status).toBe(400);
    expect((await lookup({ keys: ['x'.repeat(129)] })).status).toBe(400);
    expect((await lookup({ keys: Array.from({ length: MeshStore.MAX_LOOKUP + 1 }, (_, i) => `k${i}`) })).body.error)
      .toBe(`At most ${MeshStore.MAX_LOOKUP} keys per request.`);
    expect((await lookup({ keys: [] })).body).toEqual({ meshes: {}, missing: [] });
  });
});

describe('MeshLedger', () => {
  it('keeps the most recently sent keys within its weight, a key sent again the newest', () => {
    const ledger = new MeshLedger(30);
    ledger.note('a', 10);
    ledger.note('b', 10);
    ledger.note('c', 10);
    ledger.note('a', 10);
    ledger.note('d', 10);
    expect(['a', 'b', 'c', 'd'].filter((key) => ledger.holds(key))).toEqual(['a', 'c', 'd']);
    expect(ledger.totalWeight).toBe(30);
  });

  it('keeps at most MAX_ENTRIES keys, whatever their weight', () => {
    const ledger = new MeshLedger(Number.MAX_SAFE_INTEGER);
    for (let i = 0; i <= MeshLedger.MAX_ENTRIES; i++) {
      ledger.note(`k${i}`, 0);
    }
    expect(ledger.size).toBe(MeshLedger.MAX_ENTRIES);
    expect(ledger.holds('k0')).toBe(false);
    expect(ledger.holds(`k${MeshLedger.MAX_ENTRIES}`)).toBe(true);
  });

  it('reads the capacity a hello announces, and takes half of it for a page', () => {
    expect(MeshLedger.announcedCapacity({ capacity: 1000 })).toBe(1000);
    for (const bad of [undefined, null, true, {}, { capacity: 0 }, { capacity: -1 }, { capacity: 'big' }, { capacity: Infinity }]) {
      expect(MeshLedger.announcedCapacity(bad)).toBeNull();
    }
    expect(MeshLedger.forPage(1000).maxWeight).toBe(500);
    expect(MeshLedger.forPage(1e12).maxWeight).toBe(MeshLedger.DEFAULT_CAPACITY);
  });

  it('hands what it holds, oldest first, to the ledger that replaces it', () => {
    const before = new MeshLedger();
    before.note('a', 10);
    before.note('b', 10);
    const after = new MeshLedger(10);
    before.transferTo(after);
    expect(after.holds('a')).toBe(false);
    expect(after.holds('b')).toBe(true);
  });
});

describe('MeshStore', () => {
  const entry = (key: string, weight: number) => ({ key, shape: shape(key), weight });

  it('keeps the newest scene whole, older ones while they fit', () => {
    const store = new MeshStore();
    store.noteScene([entry('A', MeshStore.MAX_OLDER_WEIGHT)]);
    store.noteScene([entry('B', 1)]);
    store.noteScene([entry('C', MeshStore.MAX_OLDER_WEIGHT * 2)]);
    // C alone is past the older-scene budget, yet kept; B fits beside it, A no longer does.
    expect(store.lookup(['A', 'B', 'C']).missing).toEqual(['A']);
    expect(store.stats()).toEqual({ scenes: 2, keys: 2, weight: MeshStore.MAX_OLDER_WEIGHT * 2 + 1 });
  });
});
