import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import express from 'express';
import http from 'http';
import { createApplyFeatureRouter } from '../../src/routes/apply-feature.ts';

// The solved-sketch drawing-tool emission route (sketch-rewrite P5):
// preflights against the server's code copy for a fast honest 422 AND the
// geometry line report (the polyline chain references its previous segment
// by line), then rides the apply-feature-edit ack round trip.

const CODE = [
  `import { sketch, line } from "fluidcad/core";`,
  `import { horizontal } from "fluidcad/constraints";`,
  ``,
  `sketch('xy', () => {`,
  `  const a = line([0, 0], [100, 0]);`,
  `  horizontal(a);`,
  `}, true);`,
].join('\n');

let server: http.Server;
let baseUrl: string;
let relayed: any[];
let delivered: boolean;

const fakeFluidCadServer = {
  getCurrentFileName: () => '/ws/m.fluid.js',
  getCurrentCode: () => CODE,
} as any;

async function post(body: unknown): Promise<{ status: number; body: any }> {
  const res = await fetch(`${baseUrl}/api/sketch/insert-solved`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

describe('/api/sketch/insert-solved', () => {
  beforeAll(async () => {
    const sendToExtension = (msg: any) => {
      relayed.push(msg);
      return delivered;
    };
    const app = express();
    app.use(express.json());
    app.use('/api', createApplyFeatureRouter(fakeFluidCadServer, sendToExtension, { ackTimeoutMs: 300 }));
    server = http.createServer(app);
    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', () => resolve());
    });
    const addr = server.address();
    const port = typeof addr === 'object' && addr ? addr.port : 0;
    baseUrl = `http://127.0.0.1:${port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  beforeEach(() => {
    relayed = [];
    // Undelivered = no host attached = the dispatcher's immediate success,
    // so tests don't wait out the ack timeout.
    delivered = false;
  });

  it('rejects malformed bodies without relaying', async () => {
    expect((await post({})).status).toBe(400);
    expect((await post({ sketchLine: 4, geometry: [], constraints: [] })).status).toBe(400);
    expect((await post({
      sketchLine: 4,
      geometry: [{ kind: 'rect', text: 'rect(4, 4)' }],
      constraints: [],
    })).status).toBe(400);
    expect((await post({
      sketchLine: 4,
      geometry: [],
      constraints: [{ kind: 'coincident', targets: [{ line: 5, newIndex: 0 }, { line: 5 }] }],
    })).status).toBe(400);
    expect(relayed).toHaveLength(0);
  });

  it('preflights a bad emission to a 422 without relaying', async () => {
    const { status, body } = await post({
      sketchLine: 4,
      geometry: [{ kind: 'line', text: 'circle([0, 0], 4)' }],
      constraints: [],
    });
    expect(status).toBe(422);
    expect(body.reason).toContain('invalid line statement text');
    expect(relayed).toHaveLength(0);
  });

  it('relays a sketchEmission spec and reports the geometry lines and names', async () => {
    const { status, body } = await post({
      sketchLine: 4,
      geometry: [{ kind: 'line', text: 'line([100, 0], [100, 50])' }],
      constraints: [{
        kind: 'coincident',
        targets: [
          { newIndex: 0, role: 'start' },
          { line: 5, role: 'end', featureType: 'line' },
        ],
      }],
    });
    expect(status).toBe(200);
    expect(body.success).toBe(true);
    // The new line lands after the existing entity, before horizontal(a).
    expect(body.geometryLines).toEqual([6]);
    expect(body.names).toEqual(['l1']);
    expect(relayed).toHaveLength(1);
    expect(relayed[0].type).toBe('apply-feature-edit');
    expect(relayed[0].spec.sketchEmission.geometry[0].text).toBe('line([100, 0], [100, 50])');
    expect(relayed[0].spec.sketchEmission.constraints[0].kind).toBe('coincident');
  });

  it('carries the guide flag and newVariables through', async () => {
    const { status, body } = await post({
      sketchLine: 4,
      geometry: [{ kind: 'circle', text: 'circle([10, 10], d)', guide: true }],
      constraints: [],
      newVariables: [{ name: 'd', initializer: '20' }],
    });
    expect(status).toBe(200);
    expect(body.success).toBe(true);
    expect(relayed[0].spec.sketchEmission.geometry[0].guide).toBe(true);
    expect(relayed[0].spec.sketchEmission.newVariables).toEqual([{ name: 'd', initializer: '20' }]);
  });
});
