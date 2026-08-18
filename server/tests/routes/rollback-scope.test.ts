// The one-click timeline rollback is part-scoped: the UI sends
// `scope: 'part'` and the server answers with `rollbackScopePartId` when the
// target row lives inside a part. The raw index-only form keeps the global
// prefix semantics edit-session boundaries and MCP depend on, so the route
// must forward the scope verbatim and reject anything it doesn't know.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import http from 'http';
import { createTimelineRouter } from '../../src/routes/timeline.ts';
import type { FluidCadServer, SceneRenderedData } from '../../src/fluidcad-server.ts';

let server: http.Server;
let baseUrl: string;
/** The args the stubbed engine saw on the last /rollback call. */
let lastCall: { index: number; scope?: 'part' } | null = null;
/** Injected into the next response — simulates a part-scoped derivation. */
let scopePartId: string | undefined;
let uiMessages: any[] = [];

function renderData(): SceneRenderedData {
  return {
    absPath: '/ws/part.fluid.js',
    sceneKind: 'part',
    result: [],
    rollbackStop: 3,
    ...(scopePartId ? { rollbackScopePartId: scopePartId } : {}),
    objectErrors: [],
  };
}

describe('part-scoped rollback route', () => {
  beforeAll(async () => {
    const engine = {
      rollbackFromUI: async (index: number, scope?: 'part') => {
        lastCall = { index, scope };
        return renderData();
      },
    } as unknown as FluidCadServer;

    const app = express();
    app.use(express.json());
    app.use('/api', createTimelineRouter(engine, () => {}, (msg) => uiMessages.push(msg)));

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

  async function post(body: unknown) {
    return fetch(`${baseUrl}/api/rollback`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  it("forwards scope: 'part' to the engine and the part id to the UI", async () => {
    lastCall = null;
    uiMessages = [];
    scopePartId = 'part-42';

    const res = await post({ index: 3, scope: 'part' });

    expect(res.status).toBe(200);
    expect(lastCall).toEqual({ index: 3, scope: 'part' });
    const scene = uiMessages.find(m => m.type === 'scene-rendered');
    expect(scene.rollbackScopePartId).toBe('part-42');
    expect(scene.rollbackStop).toBe(3);
  });

  it('keeps index-only requests global — no scope forwarded, no part id emitted', async () => {
    lastCall = null;
    uiMessages = [];
    scopePartId = undefined;

    const res = await post({ index: 3 });

    expect(res.status).toBe(200);
    expect(lastCall).toEqual({ index: 3, scope: undefined });
    const scene = uiMessages.find(m => m.type === 'scene-rendered');
    expect('rollbackScopePartId' in scene).toBe(false);
  });

  it('rejects an unknown scope', async () => {
    lastCall = null;

    const res = await post({ index: 3, scope: 'assembly' });

    expect(res.status).toBe(400);
    expect(lastCall).toBeNull();
  });
});
