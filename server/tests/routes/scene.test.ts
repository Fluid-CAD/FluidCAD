import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import http from 'http';
import { setupOC, render } from '../../../lib/tests/setup.ts';
import sketch from '../../../lib/core/sketch.ts';
import extrude from '../../../lib/core/extrude.ts';
import { rect } from '../../../lib/core/2d/index.ts';
import { FluidCadServer } from '../../src/fluidcad-server.ts';
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
      rect(100, 50);
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
});
