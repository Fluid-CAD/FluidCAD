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
  `});`,
].join('\n');

let server: http.Server;
let baseUrl: string;
let relayed: any[];
let delivered: boolean;

let currentCode = CODE;

const fakeFluidCadServer = {
  getCurrentFileName: () => '/ws/m.fluid.js',
  getCurrentCode: () => currentCode,
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
    currentCode = CODE;
    // Undelivered = no host attached = the dispatcher's immediate success,
    // so tests don't wait out the ack timeout.
    delivered = false;
  });

  it('rejects malformed bodies without relaying', async () => {
    expect((await post({})).status).toBe(400);
    expect((await post({ sketchLine: 4, geometry: [], constraints: [] })).status).toBe(400);
    expect((await post({
      sketchLine: 4,
      geometry: [{ kind: 'square', text: 'circle([0, 0], 4)' }],
      constraints: [],
    })).status).toBe(400);
    expect((await post({
      sketchLine: 4,
      geometry: [],
      constraints: [{ kind: 'coincident', targets: [{ line: 5, newIndex: 0 }, { line: 5 }] }],
    })).status).toBe(400);
    expect(relayed).toHaveLength(0);
  });

  it('accepts reference and copy-instance targets (a snap onto projected/copied geometry)', async () => {
    // A drawing tool that starts on a projected circle's center addresses
    // the bare project() statement by its producer callee + .ref(i) — the
    // entity-only type list used to 400 it as an invalid body.
    currentCode = [
      `import { sketch, line, project, copy } from "fluidcad/core";`,
      ``,
      `sketch('xy', () => {`,
      `  project(sel);`,
      `  const a = line([0, 0], [100, 0]);`,
      `  copy(a).linear(2, [0, 20]);`,
      `});`,
    ].join('\n');
    const reference = await post({
      sketchLine: 3,
      geometry: [{ kind: 'line', text: 'line([5, 7], [40, 30])' }],
      constraints: [{
        kind: 'coincident',
        targets: [
          { newIndex: 0, role: 'start' },
          { line: 4, role: 'center', featureType: 'project', refIndex: null },
        ],
      }],
    });
    expect(reference.status).toBe(200);
    expect(reference.body.success).toBe(true);
    const refTargets = relayed[0].spec.sketchEmission.constraints[0].targets;
    expect(refTargets[1]).toEqual({ line: 4, role: 'center', featureType: 'project', refIndex: null });

    const instance = await post({
      sketchLine: 3,
      geometry: [{ kind: 'line', text: 'line([100, 20], [140, 30])' }],
      constraints: [{
        kind: 'coincident',
        targets: [
          { newIndex: 0, role: 'start' },
          { line: 6, role: 'end', featureType: 'copy', instanceIndex: 1 },
        ],
      }],
    });
    expect(instance.status).toBe(200);
    const copyTargets = relayed[1].spec.sketchEmission.constraints[0].targets;
    expect(copyTargets[1]).toEqual({ line: 6, role: 'end', featureType: 'copy', instanceIndex: 1 });

    // Reference/instance addressing needs a statement line, and a reference
    // featureType must be a producer callee.
    expect((await post({
      sketchLine: 3,
      geometry: [{ kind: 'line', text: 'line([0, 0], [1, 1])' }],
      constraints: [{ kind: 'coincident', targets: [{ newIndex: 0, role: 'start' }, { newIndex: 0, role: 'end', refIndex: null }] }],
    })).status).toBe(400);
    expect((await post({
      sketchLine: 3,
      geometry: [{ kind: 'line', text: 'line([0, 0], [1, 1])' }],
      constraints: [{ kind: 'coincident', targets: [{ newIndex: 0, role: 'start' }, { line: 4, role: 'center', featureType: 'circle', refIndex: null }] }],
    })).status).toBe(400);
    expect(relayed).toHaveLength(2);
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

  it('carries removals through and preflights them (constraint-native fillet)', async () => {
    const { status, body } = await post({
      sketchLine: 4,
      geometry: [{ kind: 'line', text: 'line([100, 0], [100, 50])' }],
      constraints: [],
      removals: [{ line: 6 }],
    });
    expect(status).toBe(200);
    expect(body.success).toBe(true);
    expect(relayed[0].spec.sketchEmission.removals).toEqual([{ line: 6 }]);

    // A removal the preflight refuses (an entity statement) is an honest 422.
    const refused = await post({
      sketchLine: 4,
      geometry: [{ kind: 'line', text: 'line([100, 0], [100, 50])' }],
      constraints: [],
      removals: [{ line: 5 }],
    });
    expect(refused.status).toBe(422);
    expect(refused.body.reason).toContain('not a constraint statement');

    // Malformed removals reject without relaying.
    relayed = [];
    const malformed = await post({
      sketchLine: 4,
      geometry: [{ kind: 'line', text: 'line([100, 0], [100, 50])' }],
      constraints: [],
      removals: [{ line: 'six' }],
    });
    expect(malformed.status).toBe(400);
    expect(relayed).toHaveLength(0);
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
