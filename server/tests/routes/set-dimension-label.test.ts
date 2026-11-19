import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import express from 'express';
import http from 'http';
import { createApplyFeatureRouter } from '../../src/routes/apply-feature/index.ts';

// The dimension label route: a dimension dragged in the sketcher (or the
// timeline's "Reset label position") rewrites the statement's chained
// `.labelAt(u, v)`. Shallow validation, a preflight against the server's
// copy of the file, then the apply-feature-edit round trip.

const CODE = [
  `import { sketch, line } from "fluidcad/core";`,
  `import { distance, horizontal } from "fluidcad/constraints";`,
  ``,
  `sketch('xy', () => {`,
  `  const a = line([0, 0], [100, 0]);`,
  `  horizontal(a);`,
  `  distance(a.start(), a.end(), 100);`,
  `});`,
].join('\n');

const DISTANCE_LINE = 7;
const HORIZONTAL_LINE = 6;

let server: http.Server;
let baseUrl: string;
let relayed: any[];

const fakeFluidCadServer = {
  getCurrentFileName: () => '/ws/m.fluid.js',
  getCurrentCode: () => CODE,
} as any;

async function post(body: unknown): Promise<{ status: number; body: any }> {
  const res = await fetch(`${baseUrl}/api/sketch/set-dimension-label`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

describe('/api/sketch/set-dimension-label', () => {
  beforeAll(async () => {
    // Undelivered = no host attached = the dispatcher's immediate success,
    // so tests don't wait out the ack timeout.
    const sendToExtension = (msg: any) => {
      relayed.push(msg);
      return false;
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
  });

  it('rejects malformed bodies without relaying', async () => {
    const bad = [
      {},
      { line: DISTANCE_LINE },
      { line: '7', position: [1, 2] },
      { line: 0, position: [1, 2] },
      { line: 7.5, position: [1, 2] },
      { line: DISTANCE_LINE, position: [1] },
      { line: DISTANCE_LINE, position: [1, '2'] },
      { line: DISTANCE_LINE, position: [1, 2, 3] },
      { line: DISTANCE_LINE, position: 'left' },
      { line: DISTANCE_LINE, position: [1, 2], kind: 'horizontal' },
      { line: DISTANCE_LINE, position: [1, 2], kind: 7 },
      { line: DISTANCE_LINE, position: [1, 2], filePath: 7 },
    ];
    for (const body of bad) {
      expect((await post(body)).status).toBe(400);
    }
    expect(relayed).toHaveLength(0);
  });

  it('relays a placement as a dimensionLabel sub-spec on the current file', async () => {
    const { status, body } = await post({ line: DISTANCE_LINE, kind: 'distance', position: [4, -12] });
    expect(status).toBe(200);
    expect(body.success).toBe(true);
    expect(relayed).toHaveLength(1);
    expect(relayed[0].type).toBe('apply-feature-edit');
    expect(relayed[0].spec.filePath).toBe('/ws/m.fluid.js');
    expect(relayed[0].spec.dimensionLabel).toEqual({ line: DISTANCE_LINE, kind: 'distance', position: [4, -12] });
  });

  it('relays a reset as a null position', async () => {
    const { status } = await post({ line: DISTANCE_LINE, position: null });
    expect(status).toBe(200);
    expect(relayed[0].spec.dimensionLabel).toEqual({ line: DISTANCE_LINE, position: null });
  });

  it('refuses a line that is not a dimension before anything is sent', async () => {
    const { status, body } = await post({ line: HORIZONTAL_LINE, position: [4, -12] });
    expect(status).toBe(422);
    expect(body.success).toBe(false);
    expect(body.reason).toContain('not a dimension statement');
    expect(relayed).toHaveLength(0);
  });

  it('refuses when the statement is not the dimension the drag saw', async () => {
    const { status, body } = await post({ line: DISTANCE_LINE, kind: 'radius', position: [4, -12] });
    expect(status).toBe(422);
    expect(body.reason).toContain('distance() statement, not radius()');
    expect(relayed).toHaveLength(0);
  });
});
