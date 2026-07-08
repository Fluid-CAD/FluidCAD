import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import express from 'express';
import http from 'http';
import { createApplyFeatureRouter } from '../../src/routes/apply-feature.ts';

let server: http.Server;
let baseUrl: string;

/** Calls the route forwarded to the fake server / extension relay. */
let synthesizeCalls: { feature: string; value: number | undefined }[];
let relayed: any[];

const fakeSynthesis = {
  ok: true,
  spec: { feature: 'fillet', filePath: '/ws/m.fluid.js', producers: [], parts: [], imports: [] },
  preview: 'fillet(3, e.endEdges())',
  args: 'e.endEdges()',
  alternatives: [],
};

const fakeServer = {
  getCurrentCode: () => null,
  getParamDefinitions: () => [],
  synthesizeApplyFeature: (
    _picks: unknown, feature: string, value: number | undefined,
  ) => {
    synthesizeCalls.push({ feature, value });
    return fakeSynthesis;
  },
};

const PICK = { shapeId: 'shape-1', sub: { type: 'face', index: 0 } };

async function post(body: unknown): Promise<{ status: number; body: any }> {
  const res = await fetch(`${baseUrl}/api/apply-feature`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

describe('apply-feature route validation', () => {
  beforeAll(async () => {
    const app = express();
    app.use(express.json());
    app.use('/api', createApplyFeatureRouter(fakeServer as any, (msg) => relayed.push(msg)));

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

  beforeEach(() => {
    synthesizeCalls = [];
    relayed = [];
  });

  it('rejects an unknown feature', async () => {
    const { status, body } = await post({ feature: 'draft', value: 2, entities: [PICK] });
    expect(status).toBe(400);
    expect(body.error).toContain('"shell" or "sketch"');
  });

  it('rejects a non-positive fillet value', async () => {
    const { status } = await post({ feature: 'fillet', value: -3, entities: [PICK] });
    expect(status).toBe(400);
  });

  it('accepts a negative shell thickness (the hollow-inward idiom)', async () => {
    const { status } = await post({ feature: 'shell', value: -2, entities: [PICK], preview: true });
    expect(status).toBe(200);
    expect(synthesizeCalls).toEqual([{ feature: 'shell', value: -2 }]);
  });

  it('rejects a zero shell thickness', async () => {
    const { status, body } = await post({ feature: 'shell', value: 0, entities: [PICK] });
    expect(status).toBe(400);
    expect(body.error).toContain('nonzero');
  });

  it('accepts sketch without a value and relays the spec to the extension', async () => {
    const { status, body } = await post({ feature: 'sketch', entities: [PICK] });
    expect(status).toBe(200);
    expect(body.success).toBe(true);
    expect(synthesizeCalls).toEqual([{ feature: 'sketch', value: undefined }]);
    expect(relayed).toHaveLength(1);
    expect(relayed[0].type).toBe('apply-feature-edit');
  });

  it('ignores a stray value on sketch instead of validating it', async () => {
    const { status } = await post({ feature: 'sketch', value: -99, entities: [PICK], preview: true });
    expect(status).toBe(200);
    expect(synthesizeCalls).toEqual([{ feature: 'sketch', value: undefined }]);
  });
});
