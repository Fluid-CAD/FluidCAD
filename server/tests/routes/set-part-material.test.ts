// The part row menu's "Set material…" goes through the acked edit
// dispatcher like set-sketch-closed: the route validates the body, hands the
// host a `partMaterial` spec, and answers with the host's real outcome so
// the panel can refresh its mass properties only once the edit landed.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import express from 'express';
import http from 'http';
import { createTimelineRouter } from '../../src/routes/timeline.ts';
import { FeatureEditDispatcher } from '../../src/edit-dispatch.ts';
import { applyFeatureEdit } from '../../src/apply-feature-edit/index.ts';
import type { FluidCadServer } from '../../src/fluidcad-server/index.ts';

const CODE = `import { part, extrude } from 'fluidcad/core'\n\nexport const a = part('A', () => {\n  extrude(5)\n}).name('Bracket')\n`;

let server: http.Server;
let baseUrl: string;
let relayed: any[];
let delivered: boolean;
let dispatcher: FeatureEditDispatcher;

const fakeServer = {
  getCurrentCode: () => CODE,
  getCurrentFileName: () => '/ws/m.fluid.js',
} as unknown as FluidCadServer;

async function post(body: unknown): Promise<{ status: number; body: any }> {
  const res = await fetch(`${baseUrl}/api/set-part-material`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

async function untilRelayed(): Promise<any> {
  for (let i = 0; i < 100; i++) {
    if (relayed.length > 0) {
      return relayed[0];
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('nothing was relayed to the extension');
}

describe('POST /api/set-part-material', () => {
  beforeAll(async () => {
    dispatcher = new FeatureEditDispatcher(
      fakeServer,
      (msg) => {
        relayed.push(msg);
        return delivered;
      },
      { ackTimeoutMs: 300 },
    );
    const app = express();
    app.use(express.json());
    app.use('/api', createTimelineRouter(fakeServer, () => {}, () => {}, { dispatcher }));
    server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const addr = server.address();
    baseUrl = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  beforeEach(() => {
    relayed = [];
    delivered = true;
  });

  it('rejects a malformed body', async () => {
    expect((await post({})).status).toBe(400);
    expect((await post({ sourceLocation: { filePath: '/ws/m.fluid.js', line: 3 } })).status).toBe(400);
    expect((await post({ sourceLocation: { filePath: '/ws/m.fluid.js', line: 3 }, material: '' })).status).toBe(400);
    expect((await post({ sourceLocation: { filePath: '/ws/m.fluid.js', line: 3 }, material: 7 })).status).toBe(400);
    expect(relayed).toEqual([]);
  });

  it('dispatches a partMaterial spec and answers once the host acks it', async () => {
    const pending = post({ sourceLocation: { filePath: '/ws/m.fluid.js', line: 3 }, material: 'fluidcad-steel-1020' });
    const msg = await untilRelayed();
    expect(msg.type).toBe('apply-feature-edit');
    expect(msg.spec.partMaterial).toEqual({ sourceLine: 3, material: 'fluidcad-steel-1020' });
    expect(msg.spec.filePath).toBe('/ws/m.fluid.js');
    expect(typeof msg.spec.editId).toBe('string');

    // The host applies the spec against its buffer and settles the ack.
    const applied = await applyFeatureEdit(CODE, msg.spec);
    expect(applied.newCode).toContain(`.name('Bracket').material('fluidcad-steel-1020')`);
    dispatcher.settle(msg.spec.editId, applied.error);

    const { status, body } = await pending;
    expect(status).toBe(200);
    expect(body).toEqual({ success: true });
  });

  it('null removes the chain, riding the same round trip', async () => {
    const pending = post({ sourceLocation: { filePath: '/ws/m.fluid.js', line: 3 }, material: null });
    const msg = await untilRelayed();
    expect(msg.spec.partMaterial).toEqual({ sourceLine: 3, material: null });
    dispatcher.settle(msg.spec.editId, undefined);
    expect((await pending).status).toBe(200);
  });

  it('reports a host that never acks as a timeout, not success', async () => {
    const { status, body } = await post({ sourceLocation: { filePath: '/ws/m.fluid.js', line: 3 }, material: 'fluidcad-pla' });
    expect(status).toBe(504);
    expect(body.success).toBe(false);
  });

  it('keeps the legacy immediate success when no host is attached', async () => {
    delivered = false;
    const { status, body } = await post({ sourceLocation: { filePath: '/ws/m.fluid.js', line: 3 }, material: 'fluidcad-pla' });
    expect(status).toBe(200);
    expect(body).toEqual({ success: true });
  });
});
