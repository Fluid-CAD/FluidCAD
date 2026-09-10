import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import http from 'http';
import { FluidCadServer } from '../../src/fluidcad-server.ts';
import { createInterfereRouter, InterfereRequests } from '../../src/routes/interfere.ts';

let server: http.Server;
let baseUrl: string;
let lastRequest: unknown = null;

const BODY_A = { shapeId: 'sh-1', sceneObjectId: 'obj-2', sceneObjectName: 'extrude', part: 'base', instanceId: 'inst-1' };
const BODY_B = { shapeId: 'sh-1', sceneObjectId: 'obj-2', sceneObjectName: 'extrude', part: 'base', instanceId: 'inst-2' };
const CLASH = { a: BODY_A, b: BODY_B, volume: 2000 };
const IDENTITY_Q = { x: 0, y: 0, z: 0, w: 1 };

function cleanReport(overrides: Record<string, unknown> = {}) {
  return {
    ok: true, bodies: 2, units: 2, checked: 0, rejectedByBounds: 1,
    clashes: [], intraPart: [], failed: [], tolerance: 1, unit: 'mm',
    ...overrides,
  };
}

/**
 * The engine is stubbed with a checker keyed on the request: the route's
 * body validation and status mapping are under test, not the kernel
 * (lib/tests/validation/scene-interference.test.ts covers that).
 */
function stubEngine(opts: { checker?: boolean } = {}): FluidCadServer {
  const engine = new FluidCadServer();
  engine._setSceneForTesting('/ws/motor-mount.assembly.js', { unit: 'mm' });
  const manager: Record<string, unknown> = { getSceneUnit: () => 'mm' };
  if (opts.checker !== false) {
    manager.interfere = (_scene: unknown, request: { instanceIds?: string[]; shapeIds?: string[]; tolerance?: number; poses?: unknown[] }) => {
      lastRequest = request;
      if (request.instanceIds?.includes('nope')) {
        return { kind: 'refused', code: 'unknown-instance', reason: 'No instance "nope" in the assembly (instance ids come from get_scene_summary).' };
      }
      if (request.shapeIds?.includes('missing')) {
        return { kind: 'refused', code: 'unknown-shape', reason: 'No rendered shape "missing" in the scene (shape ids come from list_shapes or get_scene_summary).' };
      }
      if (request.shapeIds?.includes('part-file')) {
        return { kind: 'refused', code: 'not-an-assembly', reason: 'instanceIds need an assembly file; this scene is a part.' };
      }
      if (request.shapeIds?.length === 1) {
        return { kind: 'report', report: cleanReport({ ok: false, bodies: 1, units: 1, rejectedByBounds: 0, inconclusive: 'only one rendered solid; interference needs at least two bodies' }) };
      }
      if (request.poses || (request.tolerance !== undefined && request.tolerance > 2000)) {
        return { kind: 'report', report: cleanReport({ checked: 1, rejectedByBounds: 0, tolerance: request.tolerance ?? 1 }) };
      }
      return { kind: 'report', report: cleanReport({ ok: false, checked: 1, rejectedByBounds: 0, clashes: [CLASH] }) };
    };
  }
  engine.setSceneManager(manager as any);
  return engine;
}

async function post(url: string, body: unknown): Promise<{ status: number; body: any }> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

async function listen(app: express.Express): Promise<{ server: http.Server; url: string }> {
  const created = http.createServer(app);
  await new Promise<void>((resolve) => {
    created.listen(0, '127.0.0.1', () => resolve());
  });
  const addr = created.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  return { server: created, url: `http://127.0.0.1:${port}` };
}

describe('POST /api/interfere', () => {
  beforeAll(async () => {
    const app = express();
    app.use(express.json());
    app.use('/api', createInterfereRouter(stubEngine()));
    const listening = await listen(app);
    server = listening.server;
    baseUrl = listening.url;
  });

  afterAll(async () => {
    if (server) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('a clash is a 200 with ok false and the pair listed with both instance ids', async () => {
    const { status, body } = await post(`${baseUrl}/api/interfere`, {});
    expect(status).toBe(200);
    expect(body.ok).toBe(false);
    expect(body.checked).toBe(1);
    expect(body.clashes).toEqual([CLASH]);
    expect(body.intraPart).toEqual([]);
    expect(body.failed).toEqual([]);
    expect(body.tolerance).toBe(1);
    expect(body.unit).toBe('mm');
    expect(lastRequest).toEqual({});
  });

  it('an inconclusive check is a 200 with ok false and the reason', async () => {
    const { status, body } = await post(`${baseUrl}/api/interfere`, { shapeIds: ['sh-1'] });
    expect(status).toBe(200);
    expect(body.ok).toBe(false);
    expect(body.inconclusive).toContain('only one');
    expect(lastRequest).toEqual({ shapeIds: ['sh-1'] });
  });

  it('tolerance and poses pass through, and a clear pair is ok true', async () => {
    const tolerant = await post(`${baseUrl}/api/interfere`, { tolerance: 2500 });
    expect(tolerant.status).toBe(200);
    expect(tolerant.body).toMatchObject({ ok: true, clashes: [], tolerance: 2500 });
    expect(lastRequest).toEqual({ tolerance: 2500 });

    const pose = { instanceId: 'inst-2', position: { x: 40, y: 0, z: 0 }, quaternion: IDENTITY_Q };
    const posed = await post(`${baseUrl}/api/interfere`, { instanceIds: ['inst-1', 'inst-2'], poses: [{ ...pose, extra: 1 }] });
    expect(posed.status).toBe(200);
    expect(posed.body.ok).toBe(true);
    expect(lastRequest).toEqual({ instanceIds: ['inst-1', 'inst-2'], poses: [pose] });
  });

  it('an empty body and no body both mean the whole scene', async () => {
    const res = await fetch(`${baseUrl}/api/interfere`, { method: 'POST' });
    expect(res.status).toBe(200);
    expect(lastRequest).toEqual({});
  });

  it('validates the id lists, tolerance and poses before reaching the engine', async () => {
    lastRequest = null;
    expect((await post(`${baseUrl}/api/interfere`, { shapeIds: [] })).status).toBe(400);
    expect((await post(`${baseUrl}/api/interfere`, { instanceIds: 'inst-1' })).status).toBe(400);
    const emptyEntry = await post(`${baseUrl}/api/interfere`, { instanceIds: ['inst-1', ''] });
    expect(emptyEntry.status).toBe(400);
    expect(emptyEntry.body.error).toContain('instanceIds');
    const negative = await post(`${baseUrl}/api/interfere`, { tolerance: -1 });
    expect(negative.status).toBe(400);
    expect(negative.body.error).toContain('tolerance');
    const nanTolerance = await post(`${baseUrl}/api/interfere`, { tolerance: 'big' });
    expect(nanTolerance.status).toBe(400);
    const noInstance = await post(`${baseUrl}/api/interfere`, { poses: [{ position: { x: 0, y: 0, z: 0 }, quaternion: IDENTITY_Q }] });
    expect(noInstance.status).toBe(400);
    expect(noInstance.body.error).toContain('instanceId');
    const zeroQuaternion = await post(`${baseUrl}/api/interfere`, { poses: [{ instanceId: 'inst-1', position: { x: 0, y: 0, z: 0 }, quaternion: { x: 0, y: 0, z: 0, w: 0 } }] });
    expect(zeroQuaternion.status).toBe(400);
    expect(zeroQuaternion.body.error).toContain('quaternion');
    expect((await post(`${baseUrl}/api/interfere`, [1])).status).toBe(400);
    expect(lastRequest).toBeNull();
  });

  it('an unknown shape, an unknown instance and a part file scoped by instance are 404s naming the problem', async () => {
    const shape = await post(`${baseUrl}/api/interfere`, { shapeIds: ['sh-1', 'missing'] });
    expect(shape.status).toBe(404);
    expect(shape.body).toMatchObject({ code: 'unknown-shape' });
    expect(shape.body.error).toContain('"missing"');

    const instance = await post(`${baseUrl}/api/interfere`, { instanceIds: ['nope'] });
    expect(instance.status).toBe(404);
    expect(instance.body).toMatchObject({ code: 'unknown-instance' });

    const partFile = await post(`${baseUrl}/api/interfere`, { shapeIds: ['sh-1', 'part-file'] });
    expect(partFile.status).toBe(404);
    expect(partFile.body).toMatchObject({ code: 'not-an-assembly' });
  });
});

describe('POST /api/interfere — engine availability', () => {
  it('no rendered scene is a 404', async () => {
    const engine = new FluidCadServer();
    engine.setSceneManager({ getSceneUnit: () => 'mm', interfere: () => ({ kind: 'report', report: {} }) } as any);
    const app = express();
    app.use(express.json());
    app.use('/api', createInterfereRouter(engine));
    const listening = await listen(app);
    try {
      const { status, body } = await post(`${listening.url}/api/interfere`, {});
      expect(status).toBe(404);
      expect(body.code).toBe('no-scene');
    } finally {
      await new Promise<void>((resolve) => listening.server.close(() => resolve()));
    }
  });

  it('an engine that predates the checker is a 501', async () => {
    const app = express();
    app.use(express.json());
    app.use('/api', createInterfereRouter(stubEngine({ checker: false })));
    const listening = await listen(app);
    try {
      const { status, body } = await post(`${listening.url}/api/interfere`, {});
      expect(status).toBe(501);
      expect(body.code).toBe('unsupported');
      expect(body.error).toContain('predates');
    } finally {
      await new Promise<void>((resolve) => listening.server.close(() => resolve()));
    }
  });
});

describe('InterfereRequests', () => {
  it('maps refusal codes to statuses', () => {
    expect(InterfereRequests.statusFor('no-scene')).toBe(404);
    expect(InterfereRequests.statusFor('unknown-shape')).toBe(404);
    expect(InterfereRequests.statusFor('unknown-instance')).toBe(404);
    expect(InterfereRequests.statusFor('not-an-assembly')).toBe(404);
    expect(InterfereRequests.statusFor('unsupported')).toBe(501);
    expect(InterfereRequests.statusFor('something-else')).toBe(422);
  });

  it('drops unset fields and unknown pose keys from the request it builds', () => {
    expect(InterfereRequests.asRequest(undefined)).toEqual({});
    expect(InterfereRequests.asRequest({ shapeIds: ['a'], extra: 1 })).toEqual({ shapeIds: ['a'] });
    expect(InterfereRequests.asRequest({ instanceIds: ['i'], tolerance: 0 })).toEqual({ instanceIds: ['i'], tolerance: 0 });
    const pose = { instanceId: 'i', position: { x: 1, y: 2, z: 3 }, quaternion: IDENTITY_Q };
    expect(InterfereRequests.asRequest({ poses: [{ ...pose, live: true }] })).toEqual({ poses: [pose] });
  });
});
