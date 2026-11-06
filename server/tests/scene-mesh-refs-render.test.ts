import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import express from 'express';
import fs from 'fs';
import http from 'node:http';
import os from 'os';
import path from 'path';
import { WebSocket } from 'ws';
import { FluidCadServer, sceneStopFields, sceneUnitFields } from '../src/fluidcad-server/index.ts';
import type { SceneRenderedData } from '../src/fluidcad-server/render-types.ts';
import { LocalSceneHost } from '../src/host/local-scene-host.ts';
import { createServerCore, type ServerCore } from '../src/server-core.ts';
import { MeshesRoute } from '../src/routes/meshes.ts';

// The mesh references end to end (S6b), over a real engine and the S4
// fixture: an assembly whose crate changes height between two renders. The
// lid's inputs don't change, so the compare keeps it — its shapes keep their
// mesh keys and a page with a mesh cache is sent them by reference; the
// rebuilt base comes whole. Resolved from what the page was sent before,
// the scene equals the whole one an older page gets, and the fallback
// answers the same payloads.

const FIXTURE = path.resolve(__dirname, 'fixtures/generated-workspace');

const shop = (height: number) => [
  `import { assembly, insert } from 'fluidcad/core';`,
  `import { crate } from './assemblies/crate.assembly.js';`,
  ``,
  `export const shop = assembly('shop', () => {`,
  `  insert(crate, { height: ${height} }).name('crate1');`,
  `});`,
  ``,
].join('\n');

async function quietly<T>(fn: () => Promise<T>): Promise<T> {
  const spies = (['log', 'table', 'warn'] as const).map((name) => vi.spyOn(console, name).mockImplementation(() => {}));
  try {
    return await fn();
  } finally {
    for (const spy of spies) {
      spy.mockRestore();
    }
  }
}

const tick = (ms = 50) => new Promise((resolve) => setTimeout(resolve, ms));

type Client = { ws: WebSocket; scenes: any[] };

describe('mesh references over real renders', () => {
  let root: string;
  let host: LocalSceneHost;
  let engine: FluidCadServer;
  let httpServer: http.Server;
  let core: ServerCore;
  let port = 0;
  const clients: Client[] = [];

  async function connect(hello: Record<string, unknown> | null): Promise<Client> {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    const client: Client = { ws, scenes: [] };
    clients.push(client);
    ws.on('message', (raw) => {
      const msg = JSON.parse(String(raw));
      if (msg.type === 'scene-rendered') {
        client.scenes.push(msg);
      }
    });
    await new Promise<void>((resolve, reject) => {
      ws.once('open', () => resolve());
      ws.once('error', reject);
    });
    if (hello) {
      ws.send(JSON.stringify({ type: 'ui-hello', sceneAcks: true, ...hello }));
    }
    await tick();
    return client;
  }

  /** index.ts's emitSuccess, reduced: the render's scene, through the core. */
  async function renderAndBroadcast(code: string): Promise<SceneRenderedData> {
    const file = path.join(root, 'shop.assembly.js').replace(/\\/g, '/');
    const data = (await quietly(() => engine.updateLiveCode(file, code)))!;
    expect(data.result.filter((row: any) => row.hasError)).toEqual([]);
    core.broadcastToUI({
      type: 'scene-rendered',
      result: data.result,
      absPath: data.absPath,
      sceneKind: data.sceneKind,
      ...sceneUnitFields(data),
      ...sceneStopFields(data),
      ...(data.assembly ? { assembly: data.assembly } : {}),
    } as any);
    await tick();
    return data;
  }

  beforeAll(async () => {
    root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'fluidcad-mesh-refs-')).replace(/\\/g, '/');
    fs.cpSync(FIXTURE, root, { recursive: true });
    fs.writeFileSync(path.join(root, 'shop.assembly.js'), shop(20));
    host = new LocalSceneHost();
    engine = new FluidCadServer(host);
    await quietly(() => engine.init(root));
    (engine as any).sceneManager.clearGeneratedTemplates();

    const app = express();
    app.use(express.json({ limit: '50mb' }));
    httpServer = http.createServer(app);
    core = createServerCore(httpServer, { meshRefs: true });
    app.use('/api', MeshesRoute.router(core.meshes));
    await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', () => resolve()));
    port = (httpServer.address() as import('node:net').AddressInfo).port;
  });

  afterAll(async () => {
    for (const client of clients) {
      client.ws.close();
    }
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    await host.server?.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  /** Every shape of a scene, by row. */
  const shapesOf = (msg: any): any[] => msg.result.flatMap((row: any) => row.sceneShapes ?? []);

  it('sends a kept part by reference, and the page resolves the scene an older page gets whole', async () => {
    const page = await connect({ meshCache: { capacity: 10_000_000 } });
    const older = await connect({});
    await renderAndBroadcast(shop(20));
    await renderAndBroadcast(shop(25));

    // What the page holds: every payload it was sent whole, by key.
    const held = new Map<string, any>();
    for (const shape of page.scenes.flatMap(shapesOf)) {
      if (shape.meshKey) {
        held.set(shape.meshKey, { meshes: shape.meshes, vertices: shape.vertices, faceVertices: shape.faceVertices });
      }
    }
    const [, second] = page.scenes;
    const refs = shapesOf(second).filter((shape) => shape.meshRef);
    const whole = shapesOf(second).filter((shape) => shape.meshKey);
    // The lid (kept) by reference — its solid and its connector marks; the base whole.
    expect(refs.length).toBeGreaterThan(0);
    expect(whole.length).toBeGreaterThan(0);
    expect(refs.some((shape) => shape.shapeType === 'solid')).toBe(true);
    for (const shape of refs) {
      expect(held.has(shape.meshRef)).toBe(true);
      expect(shape.meshes).toBeUndefined();
    }

    // Resolved, the page's scene is the older page's, field for field.
    const resolved = JSON.parse(JSON.stringify(second));
    for (const shape of shapesOf(resolved)) {
      if (shape.meshRef) {
        const payload = held.get(shape.meshRef);
        const { meshRef, ...rest } = shape;
        Object.keys(shape).forEach((key) => delete shape[key]);
        Object.assign(shape, rest, { meshKey: meshRef }, payload);
      }
    }
    const normalize = (msg: any) => JSON.parse(JSON.stringify(msg, (key, value) => (value === undefined ? undefined : value)));
    const sortKeys = (value: any): any => Array.isArray(value)
      ? value.map(sortKeys)
      : value && typeof value === 'object'
        ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortKeys(value[key])]))
        : value;
    expect(sortKeys(normalize(resolved))).toEqual(sortKeys(older.scenes[1]));

    // Far fewer bytes on the wire.
    expect(JSON.stringify(second).length).toBeLessThan(JSON.stringify(older.scenes[1]).length);

    // The fallback answers the references with the same payloads.
    const res = await fetch(`http://127.0.0.1:${port}/api/meshes`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ keys: refs.map((shape) => shape.meshRef) }),
    });
    const answer = await res.json();
    expect(answer.missing).toEqual([]);
    for (const shape of refs) {
      expect(normalize(answer.meshes[shape.meshRef])).toEqual(normalize(held.get(shape.meshRef)));
    }
  });
});
