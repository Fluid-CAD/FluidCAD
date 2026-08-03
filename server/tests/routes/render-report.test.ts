// The scene-mutating routes used to answer a bare `{ success: true }`. A
// render that completes with a feature left broken is not a success anyone
// can act on, so both routes now report `state` + `objectErrors` — the same
// two fields POST /api/render carries.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import http from 'http';
import { createParamsRouter } from '../../src/routes/params.ts';
import { createTimelineRouter } from '../../src/routes/timeline.ts';
import type { FluidCadServer, ObjectBuildError, SceneRenderedData } from '../../src/fluidcad-server.ts';

const BUILD_ERROR: ObjectBuildError = {
  index: 2,
  id: 'obj-3',
  name: 'Rim fillet',
  uniqueKind: 'fillet-1',
  message: 'Failed to fillet edges',
  sourceLocation: { filePath: '/ws/part.fluid.js', line: 7, column: 1 },
};

let server: http.Server;
let baseUrl: string;
/** What the stubbed engine hands back for the next recompute/rollback. */
let objectErrors: ObjectBuildError[] = [];

function renderData(): SceneRenderedData {
  return {
    absPath: '/ws/part.fluid.js',
    result: [],
    rollbackStop: 0,
    objectErrors,
  };
}

describe('render reporting on scene-mutating routes', () => {
  beforeAll(async () => {
    const engine = {
      recomputeCurrentFile: async () => renderData(),
      rollbackFromUI: async () => renderData(),
    } as unknown as FluidCadServer;

    const app = express();
    app.use(express.json());
    app.use('/api', createParamsRouter(engine, () => {}, () => {}));
    app.use('/api', createTimelineRouter(engine, () => {}, () => {}));

    server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const addr = server.address();
    baseUrl = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
  });

  afterAll(async () => {
    if (server) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  async function post(route: string, body: unknown = {}) {
    const res = await fetch(`${baseUrl}${route}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    expect(res.status).toBe(200);
    return await res.json() as any;
  }

  it('reports rendered when every feature built', async () => {
    objectErrors = [];

    expect(await post('/api/recompute')).toEqual({
      success: true,
      state: 'rendered',
      objectErrors: [],
    });
    expect(await post('/api/rollback', { index: 1 })).toEqual({
      success: true,
      state: 'rendered',
      objectErrors: [],
    });
  });

  it('reports build-error with the failed features', async () => {
    objectErrors = [BUILD_ERROR];

    for (const [route, body] of [['/api/recompute', {}], ['/api/rollback', { index: 1 }]] as const) {
      const json = await post(route, body);
      expect(json.state).toBe('build-error');
      expect(json.objectErrors).toEqual([BUILD_ERROR]);
    }
  });
});
