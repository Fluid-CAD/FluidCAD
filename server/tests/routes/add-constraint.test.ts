import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import express from 'express';
import http from 'http';
import { createApplyFeatureRouter } from '../../src/routes/apply-feature.ts';

// The solved-sketch toolbar constraint route (sketch-rewrite P4): shallow
// shape validation, then the apply-feature-edit dispatcher round trip. The
// variadic kinds (equal/parallel/H-V points) take any number of targets —
// the route must not cap them at the positional three-slot limit.

const CODE = [
  `import { sketch, line } from "fluidcad/core";`,
  ``,
  `sketch('xy', () => {`,
  `  const a = line([0, 0], [100, 0]);`,
  `  const b = line([100, 0], [100, 50]);`,
  `  const c = line([100, 50], [0, 50]);`,
  `  const d = line([0, 50], [0, 0]);`,
  `});`,
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
  const res = await fetch(`${baseUrl}/api/sketch/add-constraint`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

describe('/api/sketch/add-constraint', () => {
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
    expect((await post({ sketchLine: 3, kind: 'equal', targets: [] })).status).toBe(400);
    expect((await post({
      sketchLine: 3, kind: 'equal',
      targets: [{ line: 4, role: 'corner' }, { line: 5 }],
    })).status).toBe(400);
    expect(relayed).toHaveLength(0);
  });

  it('accepts a variadic equal across more than three targets', async () => {
    const { status, body } = await post({
      sketchLine: 3,
      kind: 'equal',
      targets: [
        { line: 4, featureType: 'line' },
        { line: 5, featureType: 'line' },
        { line: 6, featureType: 'line' },
        { line: 7, featureType: 'line' },
      ],
    });
    expect(status).toBe(200);
    expect(body.success).toBe(true);
    expect(relayed).toHaveLength(1);
    expect(relayed[0].type).toBe('apply-feature-edit');
    expect(relayed[0].spec.sketchConstraint.kind).toBe('equal');
    expect(relayed[0].spec.sketchConstraint.targets).toHaveLength(4);
  });

  it('still caps positional kinds at three targets', async () => {
    const { status } = await post({
      sketchLine: 3,
      kind: 'coincident',
      targets: [
        { line: 4, role: 'start' }, { line: 5, role: 'end' },
        { line: 6, role: 'start' }, { line: 7, role: 'end' },
      ],
    });
    expect(status).toBe(400);
    expect(relayed).toHaveLength(0);
  });

  it('lets the transform refuse a below-minimum variadic with an honest 422', async () => {
    const { status, body } = await post({
      sketchLine: 3,
      kind: 'equal',
      targets: [{ line: 4, featureType: 'line' }],
    });
    expect(status).toBe(422);
    expect(body.reason).toContain('two or more targets');
    expect(relayed).toHaveLength(0);
  });
});
