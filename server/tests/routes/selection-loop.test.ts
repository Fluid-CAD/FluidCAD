import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import http from 'http';
import { setupOC, render } from '../../../lib/tests/setup.ts';
import { surface, TopologySheets } from '../../../lib/tests/helpers/topology-surfaces.ts';
import { getSceneManager } from '../../../lib/scene-manager.ts';
import sketch from '../../../lib/core/sketch.ts';
import extrude from '../../../lib/core/extrude.ts';
import { testRect } from '../../../lib/tests/helpers/profiles.ts';
import type { SceneObject } from '../../../lib/common/scene-object.ts';
import { FluidCadServer } from '../../src/fluidcad-server/index.ts';
import { createApplyFeatureRouter } from '../../src/routes/apply-feature/index.ts';

const FIXTURE_FILE = '/tmp/fluidcad-selection-loop.fluid.js';

let server: http.Server;
let baseUrl: string;
let fluidCadServer: FluidCadServer;

async function postTo(path: string, body: unknown): Promise<{ status: number; body: any }> {
  const res = await fetch(`${baseUrl}/api${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

/**
 * The selection queries behind the viewport's loop gestures, over a real
 * render: the double-click asks /selection/expand-loop whether an edge is
 * on a surface's rim, and the right-click menu lists `loop` groups.
 */
describe('loop selection routes', () => {
  setupOC();

  beforeAll(async () => {
    fluidCadServer = new FluidCadServer();
    fluidCadServer.setSceneManager(getSceneManager() as any);

    const app = express();
    app.use(express.json());
    app.use('/api', createApplyFeatureRouter(fluidCadServer, () => true, { preflight: false }));
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

  /** A plate with a square hole as a surface, beside a 20 × 20 × 10 block; returns the sheet's and the block's shape ids. */
  function stage(): { sheet: string; block: string } {
    const s = surface(() => [TopologySheets.plateWithSquareHole(30, 10)]) as unknown as SceneObject;
    sketch('xy', () => {
      testRect(20, 20, { at: [100, 0] });
    });
    const block = extrude(10) as unknown as SceneObject;
    fluidCadServer._setSceneForTesting(FIXTURE_FILE, render(), -1);
    return { sheet: s.getShapes()[0].id, block: block.getShapes()[0].id };
  }

  it('expand-loop answers a rim edge with its rim loop', async () => {
    const { sheet } = stage();
    const { status, body } = await postTo('/selection/expand-loop', { entity: { shapeId: sheet, sub: { type: 'edge', index: 0 } } });
    expect(status).toBe(200);
    expect(body.rim).toBe(true);
    expect(body.members).toHaveLength(4);
    expect(body.members).toContainEqual({ shapeId: sheet, sub: { type: 'edge', index: 0 } });
  });

  it('expand-loop answers a solid edge as no rim edge, so the gesture takes its bucket', async () => {
    const { block } = stage();
    const { status, body } = await postTo('/selection/expand-loop', { entity: { shapeId: block, sub: { type: 'edge', index: 0 } } });
    expect(status).toBe(200);
    expect(body).toEqual({ rim: false, members: [] });
  });

  it('expand-loop refuses a pick that names nothing, and a malformed one', async () => {
    stage();
    const stale = await postTo('/selection/expand-loop', { entity: { shapeId: 'nope', sub: { type: 'edge', index: 0 } } });
    expect(stale.status).toBe(422);
    expect(stale.body.error).toContain('does not resolve');
    const malformed = await postTo('/selection/expand-loop', { entity: { shapeId: 'x' } });
    expect(malformed.status).toBe(400);
  });

  it('groups lists the loop groups of a rim edge and of a solid edge', async () => {
    const { sheet, block } = stage();
    const onRim = await postTo('/selection/groups', { entity: { shapeId: sheet, sub: { type: 'edge', index: 0 } } });
    expect(onRim.status).toBe(200);
    const rimLoops = onRim.body.groups.filter((g: any) => g.kind === 'loop');
    expect(rimLoops.map((g: any) => [g.label, g.members.length])).toEqual([['Boundary Loop', 4]]);

    const onBlock = await postTo('/selection/groups', { entity: { shapeId: block, sub: { type: 'edge', index: 0 } } });
    const faceLoops = onBlock.body.groups.filter((g: any) => g.kind === 'loop');
    expect(faceLoops.map((g: any) => [g.label, g.members.length])).toEqual([
      ['Outer Loop of Planar Face 1', 4],
      ['Outer Loop of Planar Face 2', 4],
    ]);
  });
});
