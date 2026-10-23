import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import http from 'http';
import { setupOC, render } from '../../../lib/tests/setup.ts';
import sketch from '../../../lib/core/sketch.ts';
import extrude from '../../../lib/core/extrude.ts';
import part from '../../../lib/core/part.ts';
import { circle } from '../../../lib/core/2d/index.ts';
import { FluidCadServer } from '../../src/fluidcad-server/index.ts';
import { createSceneRouter } from '../../src/routes/scene.ts';

const FIXTURE_FILE = '/tmp/fluidcad-scene-test.fluid.js';

let server: http.Server;
let baseUrl: string;
let fluidCadServer: FluidCadServer;

describe('scene routes', () => {
  setupOC();

  beforeAll(async () => {
    fluidCadServer = new FluidCadServer();

    const app = express();
    app.use('/api', createSceneRouter(fluidCadServer));

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

  function buildFixtureScene() {
    sketch('xy', () => {
      circle([0, 0], 100);
    });
    extrude(30);
    const rendered = render();
    fluidCadServer._setSceneForTesting(FIXTURE_FILE, rendered, /*rollbackStop*/ 1);
  }

  it('GET /api/scene/summary returns schemaVersion 1 with the rendered objects', async () => {
    buildFixtureScene();

    const res = await fetch(`${baseUrl}/api/scene/summary`);
    expect(res.status).toBe(200);
    const body = await res.json() as any;

    expect(body.schemaVersion).toBe(1);
    expect(body.file).toBe(FIXTURE_FILE);
    // A fixture without unit() is an mm document — the summary says so.
    expect(body.unit).toBe('mm');
    expect(body.rollbackStop).toBe(1);
    expect(body.compileError).toBeNull();
    expect(Array.isArray(body.objects)).toBe(true);
    expect(body.objects.length).toBeGreaterThanOrEqual(2);

    const kinds = body.objects.map((o: any) => o.kind);
    expect(kinds).toContain('sketch');
    expect(kinds).toContain('extrude');

    for (const obj of body.objects) {
      expect(typeof obj.id).toBe('string');
      expect(typeof obj.index).toBe('number');
      expect(Array.isArray(obj.shapeIds)).toBe(true);
      // params is serialized and sanitized — no functions or class instances slip through.
      const serialized = JSON.stringify(obj);
      expect(serialized).not.toMatch(/\[object Object\]/);
    }
  });

  it('GET /api/scene/shapes returns a flat shape list with owning ids', async () => {
    buildFixtureScene();

    const res = await fetch(`${baseUrl}/api/scene/shapes`);
    expect(res.status).toBe(200);
    const body = await res.json() as any;

    expect(Array.isArray(body.shapes)).toBe(true);
    expect(body.shapes.length).toBeGreaterThan(0);
    for (const shape of body.shapes) {
      expect(typeof shape.shapeId).toBe('string');
      expect(typeof shape.type).toBe('string');
      expect(typeof shape.sceneObjectId).toBe('string');
    }
  });

  it('labels every drawn shape the way the Shapes panel does, with its part, lineage key and hasCustomName', async () => {
    part('Bracket', () => {
      sketch('xy', () => {
        circle([0, 0], 20);
      });
      extrude(10).name('Base');
    });
    sketch('xy', () => {
      circle([100, 0], 5);
    });
    extrude(4);
    fluidCadServer._setSceneForTesting(FIXTURE_FILE, render(), /*rollbackStop*/ -1);

    const summary = await (await fetch(`${baseUrl}/api/scene/summary`)).json() as any;
    const rows = summary.objects as any[];
    const bracket = rows.find((o) => o.kind === 'part');
    const base = rows.find((o) => o.name === 'Base');
    const top = rows.find((o) => o.kind === 'extrude' && o.containerId === null);
    // `name` is the display label; `hasCustomName` says it came from .name() / part('…').
    expect(bracket.hasCustomName).toBe(true);
    expect(base.hasCustomName).toBe(true);
    expect(top.name).toBe('Extrude 1');
    expect(top.hasCustomName).toBeUndefined();

    // Per part and per type, the panel's "<Type> <n>"; solids carry their lineage key.
    const baseSolid = base.shapes.find((s: any) => s.type === 'solid');
    expect(baseSolid).toMatchObject({ label: 'Solid 1', part: 'Bracket', lineageKey: 'name:Base:1' });
    const topSolid = top.shapes.find((s: any) => s.type === 'solid');
    expect(topSolid).toMatchObject({ label: 'Solid 1', part: null });
    expect(typeof topSolid.lineageKey).toBe('string');
    expect(topSolid.lineageKey).not.toBe(baseSolid.lineageKey);
    for (const row of rows) {
      expect(row.shapes.map((s: any) => s.shapeId)).toEqual(row.shapeIds);
      for (const shape of row.shapes) {
        // A meta shape has no row in the panel and no label here; a drawn one always has both.
        expect(shape.label === undefined).toBe(shape.isMetaShape === true);
        expect(shape.part === undefined).toBe(shape.isMetaShape === true);
      }
    }

    // list_shapes reports the same labels, keyed by the owning row.
    const list = await (await fetch(`${baseUrl}/api/scene/shapes`)).json() as any;
    const listed = (list.shapes as any[]).find((s) => s.shapeId === baseSolid.shapeId);
    expect(listed).toMatchObject({ label: 'Solid 1', part: 'Bracket', lineageKey: 'name:Base:1', sceneObjectId: base.id });
  });

  it('GET /api/scene/compile-error returns null when there is no cached error', async () => {
    buildFixtureScene();
    fluidCadServer.setCompileError(null);

    const res = await fetch(`${baseUrl}/api/scene/compile-error`);
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.compileError).toBeNull();
  });

  it('GET /api/scene/compile-error returns the cached error when set', async () => {
    fluidCadServer.setCompileError({
      message: 'boom',
      filePath: FIXTURE_FILE,
      sourceLocation: { filePath: FIXTURE_FILE, line: 4, column: 2 },
    });

    const res = await fetch(`${baseUrl}/api/scene/compile-error`);
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.compileError).toBeTruthy();
    expect(body.compileError.message).toBe('boom');
    expect(body.compileError.sourceLocation?.line).toBe(4);
  });

  it('GET /api/scene/summary returns 404 before any file has been processed', async () => {
    const fresh = new FluidCadServer();
    const freshApp = express();
    freshApp.use('/api', createSceneRouter(fresh));
    const freshServer = http.createServer(freshApp);
    await new Promise<void>((resolve) => freshServer.listen(0, '127.0.0.1', () => resolve()));
    const addr = freshServer.address();
    const port = typeof addr === 'object' && addr ? addr.port : 0;
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/scene/summary`);
      expect(res.status).toBe(404);
    } finally {
      await new Promise<void>((resolve) => freshServer.close(() => resolve()));
    }
  });

  it('GET /api/scene/summary lists the project parameters under globalParams when a catalog is wired', async () => {
    buildFixtureScene();
    const rows = [
      { name: 'wall', label: 'Wall thickness', value: 3, file: 'project.params.js' },
      { name: 'innerWidth', label: 'innerWidth', value: 114, file: 'project.params.js' },
    ];
    const app = express();
    app.use('/api', createSceneRouter(fluidCadServer, () => null, async () => rows));
    const srv = http.createServer(app);
    await new Promise<void>((resolve) => srv.listen(0, '127.0.0.1', () => resolve()));
    const addr = srv.address();
    const port = typeof addr === 'object' && addr ? addr.port : 0;
    try {
      const body = await (await fetch(`http://127.0.0.1:${port}/api/scene/summary`)).json() as any;
      expect(body.schemaVersion).toBe(1);
      expect(body.globalParams).toEqual(rows);
      // The summary of this file's router (no catalog) carries no block at all.
      const plain = await (await fetch(`${baseUrl}/api/scene/summary`)).json() as any;
      expect(plain.globalParams).toBeUndefined();
    } finally {
      await new Promise<void>((resolve) => srv.close(() => resolve()));
    }
  });

  it('GET /api/scene/summary keeps the feature tree when the catalog scan fails', async () => {
    buildFixtureScene();
    const app = express();
    app.use('/api', createSceneRouter(fluidCadServer, () => null, async () => { throw new Error('scan failed'); }));
    const srv = http.createServer(app);
    await new Promise<void>((resolve) => srv.listen(0, '127.0.0.1', () => resolve()));
    const addr = srv.address();
    const port = typeof addr === 'object' && addr ? addr.port : 0;
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/scene/summary`);
      expect(res.status).toBe(200);
      const body = await res.json() as any;
      expect(body.objects.length).toBeGreaterThanOrEqual(2);
      expect(body.globalParams).toEqual([]);
    } finally {
      await new Promise<void>((resolve) => srv.close(() => resolve()));
    }
  });
});
