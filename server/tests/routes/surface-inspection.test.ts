import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import http from 'http';
import { setupOC, render } from '../../../lib/tests/setup.ts';
import { useLoadedBodies, loadShapes } from '../../../lib/tests/helpers/loaded-bodies.ts';
import { TestSheets } from '../../../lib/tests/helpers/sheets.ts';
import { TestCurves } from '../../../lib/tests/helpers/curves.ts';
import { getSceneManager } from '../../../lib/scene-manager.ts';
import sketch from '../../../lib/core/sketch.ts';
import extrude from '../../../lib/core/extrude.ts';
import { circle } from '../../../lib/core/2d/index.ts';
import { FluidCadServer } from '../../src/fluidcad-server/index.ts';
import { createSceneRouter } from '../../src/routes/scene.ts';
import { createPropertiesRouter } from '../../src/routes/properties.ts';

const FIXTURE_FILE = '/tmp/fluidcad-surface-inspection.fluid.js';

let server: http.Server;
let baseUrl: string;
let fluidCadServer: FluidCadServer;

/**
 * The inspection routes an agent reads a scene through — the shape list, the
 * summary and the property routes — list a surface and a curve beside a
 * solid, each with its kind, and measure them as what they are.
 */
describe('surface and curve inspection routes', () => {
  setupOC();
  useLoadedBodies();

  beforeAll(async () => {
    fluidCadServer = new FluidCadServer();
    fluidCadServer.setSceneManager(getSceneManager() as any);

    const app = express();
    app.use('/api', createSceneRouter(fluidCadServer));
    app.use('/api', createPropertiesRouter(fluidCadServer, { loadGlobalMaterials: async () => ({}) }));
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

  /** A Ø20 × 10 cylinder at x = 100, a loaded 10 × 10 plate and a loaded three-edge curve (20 + 5π long). */
  function stage(): void {
    sketch('xy', () => {
      circle([100, 0], 20);
    });
    extrude(10);
    loadShapes([TestSheets.plate(10, 10), TestCurves.threeEdges()]);
    fluidCadServer._setSceneForTesting(FIXTURE_FILE, render(), -1);
  }

  async function shapes(): Promise<any[]> {
    const res = await fetch(`${baseUrl}/api/scene/shapes`);
    expect(res.status).toBe(200);
    return ((await res.json()) as any).shapes;
  }

  it('the shape list gives each body and curve its kind and size', async () => {
    stage();
    const listed = await shapes();

    const surface = listed.find(s => s.type === 'surface');
    expect(surface).toMatchObject({ kind: 'surface', label: 'Surface 1' });
    expect(surface.area).toBeCloseTo(100, 6);
    expect(surface.length).toBeUndefined();

    const curve = listed.find(s => s.kind === 'curve' && !s.isMetaShape && s.type === 'wire');
    expect(curve.length).toBeCloseTo(20 + 5 * Math.PI, 6);
    expect(curve.area).toBeUndefined();

    const solid = listed.find(s => s.type === 'solid');
    expect(solid.kind).toBe('solid');
    expect(solid.area).toBeCloseTo(2 * Math.PI * 100 + 2 * Math.PI * 10 * 10, 3);
  });

  it('the summary lists a surface and a curve with their kind', async () => {
    stage();
    const summary = await (await fetch(`${baseUrl}/api/scene/summary`)).json() as any;
    const load = summary.objects.find((o: any) => o.kind === 'load');
    expect(load.shapes.map((s: any) => [s.type, s.kind])).toEqual([['surface', 'surface'], ['wire', 'curve']]);
  });

  it('shape properties measure a surface by area, a curve by length, a solid by volume', async () => {
    stage();
    const listed = await shapes();
    const read = async (shapeId: string) => (await fetch(`${baseUrl}/api/shape-properties?shapeId=${shapeId}`)).json() as Promise<any>;

    const surface = await read(listed.find(s => s.kind === 'surface').shapeId);
    expect(surface).toMatchObject({ kind: 'surface', unit: 'mm' });
    expect(surface.volumeMm3).toBeUndefined();
    expect(surface.surfaceAreaMm2).toBeCloseTo(100, 6);
    expect(surface.centroid.x).toBeCloseTo(5, 6);
    expect(surface.boundingBox.max.y).toBeCloseTo(10, 6);

    const curve = await read(listed.find(s => s.kind === 'curve' && s.type === 'wire').shapeId);
    expect(curve.kind).toBe('curve');
    expect(curve.length).toBeCloseTo(20 + 5 * Math.PI, 6);

    const solid = await read(listed.find(s => s.kind === 'solid').shapeId);
    expect(solid.kind).toBe('solid');
    expect(solid.volumeMm3).toBeCloseTo(Math.PI * 100 * 10, 3);
  });

  it('face and edge properties read a surface face, a rim edge and a curve edge with its endpoints', async () => {
    stage();
    const listed = await shapes();
    const surfaceId = listed.find(s => s.kind === 'surface').shapeId;
    const curveId = listed.find(s => s.kind === 'curve' && s.type === 'wire').shapeId;

    const face = await (await fetch(`${baseUrl}/api/face-properties?shapeId=${surfaceId}&faceIndex=0`)).json() as any;
    expect(face).toMatchObject({ surfaceType: 'plane', unit: 'mm' });
    expect(face.areaMm2).toBeCloseTo(100, 6);

    const rim = await (await fetch(`${baseUrl}/api/edge-properties?shapeId=${surfaceId}&edgeIndex=0`)).json() as any;
    expect(rim.curveType).toBe('line');
    expect(rim.length).toBeCloseTo(10, 6);

    const res = await fetch(`${baseUrl}/api/edge-properties?shapeId=${curveId}&edgeIndex=2`);
    expect(res.status).toBe(200);
    const last = await res.json() as any;
    expect(last.curveType).toBe('line');
    expect(last.length).toBeCloseTo(10, 6);
    const ends = [last.start, last.end].map((p: any) => [p.x, p.y, p.z].map(v => Math.round(v * 1e6) / 1e6 + 0));
    expect(ends).toEqual(expect.arrayContaining([[20, 0, 0], [20, -10, 0]]));

    const missing = await fetch(`${baseUrl}/api/edge-properties?shapeId=${curveId}&edgeIndex=3`);
    expect(missing.status).toBe(404);
  });
});
