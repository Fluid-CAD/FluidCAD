import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import express from 'express';
import http from 'http';
import { createConfigurationsRouter } from '../../src/routes/configurations.ts';
import type { FluidCadServer } from '../../src/fluidcad-server/index.ts';

// `GET /api/configurations` answers the current file's table and active row;
// `POST /api/configurations/select` switches the session and re-renders,
// fanning the render out the way `/set-param` does. The engine is stubbed —
// the session semantics are covered in ../configurations-session.test.ts.

let server: http.Server;
let baseUrl: string;
let currentFile: string;
let selected: [string, string][];
let recomputes: number;
let relayed: any[];
let broadcast: any[];

const summary = { active: 'Wide', names: ['Compact', 'Wide'], rows: { Compact: { Width: 500 }, Wide: { Width: 1200 } }, modified: false };

const engine = {
  getCurrentFileName: () => currentFile,
  getConfigurations: (sessionId: string) => ({ ...summary, sessionId }),
  selectConfiguration: (sessionId: string, name: string) => { selected.push([sessionId, name]); },
  recomputeCurrentFile: async () => {
    recomputes++;
    return {
      absPath: currentFile,
      sceneKind: 'assembly',
      unit: 'mm',
      declaredUnit: null,
      projectUnit: 'mm',
      result: [{ name: 'frame' }],
      rollbackStop: 0,
      params: [{ label: 'Width', kind: 'assembly', defaultValue: 700, currentValue: 1200, configuredValue: 1200, controlType: 'number' }],
      configurations: summary,
      objectErrors: [],
      objectWarnings: [],
    };
  },
} as unknown as FluidCadServer;

async function get(path: string) {
  const res = await fetch(`${baseUrl}/api${path}`);
  return { status: res.status, body: await res.json() };
}

async function post(path: string, body: unknown) {
  const res = await fetch(`${baseUrl}/api${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

describe('configuration routes', () => {
  beforeAll(async () => {
    const app = express();
    app.use(express.json());
    app.use('/api', createConfigurationsRouter(engine, (msg) => relayed.push(msg), (msg) => broadcast.push(msg)));
    server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const addr = server.address();
    baseUrl = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  beforeEach(() => {
    currentFile = '/ws/frame.assembly.js';
    selected = [];
    recomputes = 0;
    relayed = [];
    broadcast = [];
  });

  it('GET answers the current file\'s summary', async () => {
    const { status, body } = await get('/configurations');
    expect(status).toBe(200);
    expect(body).toEqual({ ...summary, sessionId: '/ws/frame.assembly.js' });
  });

  it('GET with no scene answers Default and no rows', async () => {
    currentFile = '';
    const { status, body } = await get('/configurations');
    expect(status).toBe(200);
    expect(body).toEqual({ active: 'Default', names: [], rows: {}, modified: false });
  });

  it('select switches the session, re-renders, broadcasts the render with its configurations and answers the summary', async () => {
    const { status, body } = await post('/configurations/select', { name: 'Wide' });
    expect(status).toBe(200);
    expect(body).toEqual({ success: true, configurations: summary });
    expect(selected).toEqual([['/ws/frame.assembly.js', 'Wide']]);
    expect(recomputes).toBe(1);
    expect(broadcast).toHaveLength(1);
    expect(broadcast[0]).toMatchObject({
      type: 'scene-rendered',
      absPath: '/ws/frame.assembly.js',
      sceneKind: 'assembly',
      unit: 'mm',
      configurations: summary,
    });
    expect(broadcast[0].params[0]).toMatchObject({ label: 'Width', currentValue: 1200, configuredValue: 1200 });
    expect(relayed).toHaveLength(1);
    expect(relayed[0]).toMatchObject({ type: 'scene-rendered', absPath: '/ws/frame.assembly.js' });
  });

  it.each([{}, { name: '' }, { name: '   ' }, { name: 3 }])('select refuses %j', async (payload) => {
    const { status, body } = await post('/configurations/select', payload);
    expect(status).toBe(400);
    expect(body.error).toContain('name');
    expect(selected).toEqual([]);
    expect(recomputes).toBe(0);
  });

  it('select with no scene is a 404 and selects nothing', async () => {
    currentFile = '';
    const { status, body } = await post('/configurations/select', { name: 'Wide' });
    expect(status).toBe(404);
    expect(body.error).toBe('No active scene');
    expect(selected).toEqual([]);
  });
});
