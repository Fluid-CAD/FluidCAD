// screenshot_shape end to end, short of the page: the MCP tool posts to the
// real /api/screenshot router, the router checks the ids against a real
// FluidCadServer holding a real kernel render, and the real server core
// forwards the capture to a connected page over `take-screenshot`. The page
// is a WebSocket client that records what it was asked for and answers with
// a PNG. A hand-written route response is what hid the original bug — the
// tool read a bounding box the shape-properties route never sent — so
// nothing between the tool and the page's message is stubbed here.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import http from 'http';
import express from 'express';
import { WebSocket } from 'ws';
import { setupOC, render } from '../../lib/tests/setup.js';
import { getSceneManager } from '../../lib/scene-manager.js';
import sketch from '../../lib/core/sketch.js';
import extrude from '../../lib/core/extrude.js';
import part from '../../lib/core/part.js';
import plane from '../../lib/core/plane.js';
import insert from '../../lib/core/insert.js';
import { testRect } from '../../lib/tests/helpers/profiles.js';
import { FluidCadServer } from '../../server/src/fluidcad-server/index.ts';
import { createServerCore } from '../../server/src/server-core.ts';
import { createScreenshotRouter } from '../../server/src/routes/screenshot.ts';
import { registryFilePath } from '../src/discovery.ts';
import { screenshotShape } from '../src/tools/screenshot.ts';

const PNG = Buffer.from('89504e470d0a1a0a', 'hex');

let fakeHome: string;
let homeSpy: ReturnType<typeof vi.spyOn>;
let httpServer: http.Server;
let page: WebSocket;
let asked: any[];
let engine: FluidCadServer;

/** A part of two separated solids: a 10 mm cube at the origin and another 50 mm up. */
function twoSolids() {
  sketch('xy', () => { testRect(10, 10); });
  extrude(10);
  sketch(plane('xy', { offset: 50 }), () => { testRect(10, 10); });
  extrude(10);
}

/** The shape ids each rendered row carries, in render order. */
function shapeIdsOf(rows: any[]): string[] {
  return rows.flatMap((r) => ((r.sceneShapes ?? []) as any[]).map((s) => s.shapeId));
}

async function startEngine(fileName: string, scene: unknown): Promise<void> {
  engine = new FluidCadServer();
  engine.setSceneManager(getSceneManager() as any);
  engine._setSceneForTesting(fileName, scene);

  const app = express();
  app.use(express.json());
  httpServer = http.createServer(app);
  const core = createServerCore(httpServer);
  app.use('/api', createScreenshotRouter(
    core.requestScreenshot,
    (request) => engine.resolveSelection(request),
    () => engine.getSceneTargetIds(),
  ));
  await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', () => resolve()));
  const port = (httpServer.address() as { port: number }).port;

  // The page: answers every capture it is asked for.
  page = new WebSocket(`ws://127.0.0.1:${port}`);
  page.on('message', (raw) => {
    const msg = JSON.parse(String(raw));
    if (msg.type !== 'take-screenshot') {
      return;
    }
    asked.push(msg.options);
    page.send(JSON.stringify({ type: 'screenshot-result', requestId: msg.requestId, success: true, data: PNG.toString('base64') }));
  });
  await new Promise<void>((resolve, reject) => {
    page.once('open', () => resolve());
    page.once('error', reject);
  });

  fs.mkdirSync(path.dirname(registryFilePath()), { recursive: true });
  fs.writeFileSync(registryFilePath(), JSON.stringify({
    schemaVersion: 1,
    instances: [{ workspacePath: '/tmp/ws-shape-route', port, pid: process.pid, version: '0.0.46', startedAt: 'x' }],
  }));
}

describe('screenshot_shape through the real route and server core', () => {
  setupOC();

  beforeEach(() => {
    fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'fluidcad-shape-route-'));
    homeSpy = vi.spyOn(os, 'homedir').mockReturnValue(fakeHome);
    asked = [];
  });

  afterEach(async () => {
    homeSpy.mockRestore();
    fs.rmSync(fakeHome, { recursive: true, force: true });
    page?.close();
    if (httpServer) {
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    }
  });

  it('asks the page to frame each solid of a part from iso-ftr, and refuses an id the render does not hold', async () => {
    twoSolids();
    const scene = render();
    const ids = shapeIdsOf(scene.getRenderedObjects() as any[]);
    expect(ids.length).toBeGreaterThanOrEqual(2);
    await startEngine('/ws/two.part.js', scene);

    const [lower, upper] = engine.getShapesList()!.shapes.filter((s) => s.type === 'solid').map((s) => s.shapeId);
    expect(lower).toBeTruthy();
    expect(upper).toBeTruthy();

    const first = await screenshotShape({ shapeId: lower });
    expect(first.ok).toBe(true);
    if (first.ok) {
      expect(Buffer.from(first.data.image.base64, 'base64')).toEqual(PNG);
    }
    const second = await screenshotShape({ shapeId: upper, margin: 1.5, focus: [upper] });
    expect(second.ok).toBe(true);
    expect(asked).toEqual([
      { view: { kind: 'named', name: 'iso-ftr' }, fitTo: { shapes: [lower] } },
      { view: { kind: 'named', name: 'iso-ftr' }, focus: [upper], fitTo: { shapes: [upper], margin: 1.5 } },
    ]);

    const missing = await screenshotShape({ shapeId: 'no-such-shape' });
    expect(missing.ok).toBe(false);
    if (!missing.ok) {
      expect(missing.code).toBe('http-error');
      expect((missing.details as any).statusCode).toBe(404);
      expect(missing.message).toContain('is not a shape or instance id of the current render');
      expect(missing.message).toContain('unknown-shape');
    }
    expect(asked).toHaveLength(2);
  });

  it('accepts an assembly\'s instance ids and its inserted part\'s shape ids', async () => {
    getSceneManager().startScene();
    const bracket = part('bracket', () => { twoSolids(); });
    const scene = getSceneManager().startAssemblyScene();
    insert(bracket);
    insert(bracket).translate(80, 0, 0);
    getSceneManager().renderScene(scene);
    await startEngine('/ws/rig.assembly.js', scene);

    const instances = getSceneManager().getAssemblyData(scene)!.instances.map((i) => i.instanceId);
    expect(instances).toHaveLength(2);
    const solid = engine.getShapesList()!.shapes.find((s) => s.type === 'solid')!.shapeId;

    const byInstance = await screenshotShape({ shapeId: instances[1] });
    expect(byInstance.ok).toBe(true);
    const byShape = await screenshotShape({ shapeId: solid });
    expect(byShape.ok).toBe(true);
    expect(asked.map((o) => o.fitTo)).toEqual([{ shapes: [instances[1]] }, { shapes: [solid] }]);
  });
});
