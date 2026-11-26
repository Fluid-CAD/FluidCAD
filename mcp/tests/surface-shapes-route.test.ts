// list_shapes and get_shape_properties on a scene holding a surface and a
// curve beside a solid, end to end: the MCP tools call the real /api routes,
// which read a real FluidCadServer holding a real kernel render.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import http from 'http';
import express from 'express';
import { setupOC, render } from '../../lib/tests/setup.js';
import { useLoadedBodies, loadShapes } from '../../lib/tests/helpers/loaded-bodies.js';
import { TestSheets } from '../../lib/tests/helpers/sheets.js';
import { TestCurves } from '../../lib/tests/helpers/curves.js';
import { getSceneManager } from '../../lib/scene-manager.js';
import sketch from '../../lib/core/sketch.js';
import extrude from '../../lib/core/extrude.js';
import { testRect } from '../../lib/tests/helpers/profiles.js';
import { FluidCadServer } from '../../server/src/fluidcad-server/index.ts';
import { createSceneRouter } from '../../server/src/routes/scene.ts';
import { createPropertiesRouter } from '../../server/src/routes/properties.ts';
import { registryFilePath } from '../src/discovery.ts';
import { getShapeProperties, listShapes } from '../src/tools/inspection.ts';

const WORKSPACE = '/tmp/ws-surface-shapes-route';

let fakeHome: string;
let homeSpy: ReturnType<typeof vi.spyOn>;
let httpServer: http.Server | null = null;

async function startEngine(scene: unknown): Promise<void> {
  const engine = new FluidCadServer();
  engine.setSceneManager(getSceneManager() as any);
  engine._setSceneForTesting('/ws/surfaces.fluid.js', scene);

  const app = express();
  app.use('/api', createSceneRouter(engine));
  app.use('/api', createPropertiesRouter(engine, { loadGlobalMaterials: async () => ({}) }));
  httpServer = http.createServer(app);
  await new Promise<void>((resolve) => httpServer!.listen(0, '127.0.0.1', () => resolve()));
  const port = (httpServer.address() as { port: number }).port;

  fs.mkdirSync(path.dirname(registryFilePath()), { recursive: true });
  fs.writeFileSync(registryFilePath(), JSON.stringify({
    schemaVersion: 1,
    instances: [{ workspacePath: WORKSPACE, port, pid: process.pid, version: '0.0.53', startedAt: 'x' }],
  }));
}

describe('list_shapes over surfaces and curves', () => {
  setupOC();
  useLoadedBodies();

  beforeEach(() => {
    fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'fluidcad-surface-shapes-'));
    homeSpy = vi.spyOn(os, 'homedir').mockReturnValue(fakeHome);
  });

  afterEach(async () => {
    homeSpy.mockRestore();
    fs.rmSync(fakeHome, { recursive: true, force: true });
    if (httpServer) {
      await new Promise<void>((resolve) => httpServer!.close(() => resolve()));
      httpServer = null;
    }
  });

  it('lists a surface with its kind and area, and get_shape_properties measures it without a volume', async () => {
    sketch('xy', () => {
      testRect(20, 20, { at: [50, 0] });
    });
    extrude(10);
    loadShapes([TestSheets.plate(10, 10), TestCurves.threeEdges()]);
    await startEngine(render());

    const listed = await listShapes({});
    expect(listed.ok).toBe(true);
    const shapes = (listed as { ok: true; data: { shapes: any[] } }).data.shapes;

    const surface = shapes.find((s) => s.kind === 'surface');
    expect(surface).toMatchObject({ type: 'surface', label: 'Surface 1' });
    expect(surface.area).toBeCloseTo(100, 6);
    const curve = shapes.find((s) => s.kind === 'curve' && !s.isMetaShape);
    expect(curve.length).toBeCloseTo(20 + 5 * Math.PI, 6);
    const solid = shapes.find((s) => s.kind === 'solid');
    expect(solid.area).toBeCloseTo(1600, 3);

    const props = await getShapeProperties({ shapeId: surface.shapeId });
    expect(props.ok).toBe(true);
    const data = (props as { ok: true; data: any }).data;
    expect(data).toMatchObject({ kind: 'surface', unit: 'mm' });
    expect(data.surfaceAreaMm2).toBeCloseTo(100, 6);
    expect(data.volumeMm3).toBeUndefined();
  });
});
