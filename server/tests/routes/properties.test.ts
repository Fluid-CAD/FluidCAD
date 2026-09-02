import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import http from 'http';
import { FluidCadServer } from '../../src/fluidcad-server.ts';
import { createPropertiesRouter } from '../../src/routes/properties.ts';
import { createMeasureRouter } from '../../src/routes/measure.ts';

let server: http.Server;
let baseUrl: string;
let lastMeasureRefs: unknown[] = [];

/**
 * The property and measure routes answer in the document's unit and say
 * which one: every response carries `unit` beside the engine's (historically
 * mm-named) fields. The engine is stubbed — what's under test is the routes'
 * merge, not the kernel's numbers.
 */
describe('properties + measure routes — unit field', () => {
  beforeAll(async () => {
    const engine = {
      getSceneUnit: () => 'in',
      getShapeProperties: (shapeId: string) =>
        shapeId === 'sh-1' ? { volumeMm3: 12, surfaceAreaMm2: 34, centroid: { x: 0, y: 0, z: 0 } } : null,
      getFaceProperties: () => ({ surfaceType: 'plane', areaMm2: 5 }),
      getEdgeProperties: () => ({ curveType: 'line', length: 7 }),
      measure: (refs: unknown[]) => {
        lastMeasureRefs = refs;
        return { entities: [], primary: 'totalArea', primaryLabel: 'Area', totalArea: 5 };
      },
    } as unknown as FluidCadServer;

    const app = express();
    app.use(express.json());
    app.use('/api', createPropertiesRouter(engine));
    app.use('/api', createMeasureRouter(engine));
    server = http.createServer(app);
    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', () => resolve());
    });
    const addr = server.address();
    const port = typeof addr === 'object' && addr ? addr.port : 0;
    baseUrl = `http://127.0.0.1:${port}`;
  });

  afterAll(async () => {
    if (server) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('shape/face/edge properties carry the document unit beside the mm-named fields', async () => {
    const shape = await (await fetch(`${baseUrl}/api/shape-properties?shapeId=sh-1`)).json() as any;
    expect(shape).toEqual({ volumeMm3: 12, surfaceAreaMm2: 34, centroid: { x: 0, y: 0, z: 0 }, unit: 'in' });

    const face = await (await fetch(`${baseUrl}/api/face-properties?shapeId=sh-1&faceIndex=0`)).json() as any;
    expect(face).toEqual({ surfaceType: 'plane', areaMm2: 5, unit: 'in' });

    const edge = await (await fetch(`${baseUrl}/api/edge-properties?shapeId=sh-1&edgeIndex=0`)).json() as any;
    expect(edge).toEqual({ curveType: 'line', length: 7, unit: 'in' });
  });

  it('a missing shape is still a 404 without a unit', async () => {
    const res = await fetch(`${baseUrl}/api/shape-properties?shapeId=nope`);
    expect(res.status).toBe(404);
    expect(((await res.json()) as any).unit).toBeUndefined();
  });

  it('POST /api/measure carries the document unit', async () => {
    const res = await fetch(`${baseUrl}/api/measure`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ entities: [{ shapeId: 'sh-1', kind: 'face', index: 0 }] }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.unit).toBe('in');
    expect(body.primary).toBe('totalArea');
  });

  it('POST /api/measure forwards assembly instance ids and poses untouched', async () => {
    const pose = { position: { x: 1, y: 2, z: 3 }, quaternion: { x: 0, y: 0, z: 0.7071, w: 0.7071 } };
    const entities = [
      { shapeId: 'sh-1', kind: 'face', index: 0, instanceId: 'inst-0' },
      { shapeId: 'sh-1', kind: 'face', index: 0, instanceId: 'inst-1', pose },
    ];
    const res = await fetch(`${baseUrl}/api/measure`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ entities }),
    });
    expect(res.status).toBe(200);
    expect(lastMeasureRefs).toEqual(entities);
  });

  it('POST /api/measure rejects a malformed instance id or pose', async () => {
    const post = (entities: unknown) => fetch(`${baseUrl}/api/measure`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ entities }),
    });
    expect((await post([{ shapeId: 'sh-1', kind: 'face', index: 0, instanceId: '' }])).status).toBe(400);
    expect((await post([{ shapeId: 'sh-1', kind: 'face', index: 0, instanceId: 7 }])).status).toBe(400);
    const zeroQuat = { position: { x: 0, y: 0, z: 0 }, quaternion: { x: 0, y: 0, z: 0, w: 0 } };
    expect((await post([{ shapeId: 'sh-1', kind: 'face', index: 0, instanceId: 'inst-0', pose: zeroQuat }])).status).toBe(400);
    const nanPos = { position: { x: 'a', y: 0, z: 0 }, quaternion: { x: 0, y: 0, z: 0, w: 1 } };
    expect((await post([{ shapeId: 'sh-1', kind: 'face', index: 0, instanceId: 'inst-0', pose: nanPos }])).status).toBe(400);
    const noQuat = { position: { x: 0, y: 0, z: 0 } };
    expect((await post([{ shapeId: 'sh-1', kind: 'face', index: 0, instanceId: 'inst-0', pose: noQuat }])).status).toBe(400);
  });
});

describe('FluidCadServer.getSceneUnit()', () => {
  it('is mm before any scene exists', () => {
    expect(new FluidCadServer().getSceneUnit()).toBe('mm');
  });

  it('reads the current scene\'s unit, and mm for an engine whose scenes have none', () => {
    const fluidCadServer = new FluidCadServer();
    fluidCadServer._setSceneForTesting('/ws/inch.part.js', { unit: 'in' });
    expect(fluidCadServer.getSceneUnit()).toBe('in');
    fluidCadServer._setSceneForTesting('/ws/old.part.js', {});
    expect(fluidCadServer.getSceneUnit()).toBe('mm');
  });
});
