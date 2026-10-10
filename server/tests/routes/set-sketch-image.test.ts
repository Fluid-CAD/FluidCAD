// The sketch Image dialog's commit goes through the acked edit dispatcher
// like set-sketch-closed: the route validates the record with the lib's
// rules (so a bad edit never reaches the host), hands the host a
// `sketchImage` spec, and answers with the host's real outcome so the
// dialog closes on the re-render that shows the picture from code.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import express from 'express';
import http from 'http';
import { createTimelineRouter } from '../../src/routes/timeline.ts';
import { FeatureEditDispatcher } from '../../src/edit-dispatch.ts';
import { applyFeatureEdit } from '../../src/apply-feature-edit/index.ts';
import type { FluidCadServer } from '../../src/fluidcad-server/index.ts';

const CODE = `import { sketch, line } from 'fluidcad/core'\n\nconst s = sketch('xy', () => {\n  line([0, 0], [10, 0])\n})\n`;

let server: http.Server;
let baseUrl: string;
let relayed: any[];
let dispatcher: FeatureEditDispatcher;

const fakeServer = {
  getCurrentCode: () => CODE,
  getCurrentFileName: () => '/ws/m.fluid.js',
} as unknown as FluidCadServer;

const LOC = { filePath: '/ws/m.fluid.js', line: 3 };

async function post(body: unknown): Promise<{ status: number; body: any }> {
  const res = await fetch(`${baseUrl}/api/set-sketch-image`, {
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

describe('POST /api/set-sketch-image', () => {
  beforeAll(async () => {
    dispatcher = new FeatureEditDispatcher(fakeServer, (msg) => { relayed.push(msg); return true; }, { ackTimeoutMs: 300 });
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
  });

  it('rejects a malformed body with the lib\'s rules', async () => {
    const bad: unknown[] = [
      {},
      { sourceLocation: LOC },
      { sourceLocation: LOC, image: 'a.png' },
      { sourceLocation: LOC, image: { width: 10 } },
      { sourceLocation: LOC, image: { src: '', width: 10 } },
      { sourceLocation: LOC, image: { src: 'a.png' } },
      { sourceLocation: LOC, image: { src: 'a.png', width: 0 } },
      { sourceLocation: LOC, image: { src: 'a.png', height: -1 } },
      { sourceLocation: LOC, image: { src: 'a.png', width: 1, at: [1] } },
      { sourceLocation: LOC, image: { src: 'a.png', width: 1, angle: 'x' } },
      { sourceLocation: LOC, image: { src: 'a.png', width: 1, opacity: 1.5 } },
    ];
    for (const body of bad) {
      expect((await post(body)).status, JSON.stringify(body)).toBe(400);
    }
    expect(relayed).toEqual([]);
  });

  it('dispatches a sketchImage spec and answers once the host acks it', async () => {
    const pending = post({ sourceLocation: LOC, image: { src: 'images/side.png', width: 120, at: [5, 0], opacity: 0.4, extra: 'ignored' } });
    const msg = await untilRelayed();
    expect(msg.type).toBe('apply-feature-edit');
    expect(msg.spec.sketchImage).toEqual({ sourceLine: 3, image: { src: 'images/side.png', width: 120, at: [5, 0], opacity: 0.4 } });
    expect(msg.spec.filePath).toBe('/ws/m.fluid.js');

    const applied = await applyFeatureEdit(CODE, msg.spec);
    expect(applied.newCode).toContain(`}).image('images/side.png', { width: 120, at: [5, 0], opacity: 0.4 })`);
    dispatcher.settle(msg.spec.editId, applied.error);

    const { status, body } = await pending;
    expect(status).toBe(200);
    expect(body).toEqual({ success: true });
  });

  it('null removes the chain, riding the same round trip', async () => {
    const pending = post({ sourceLocation: LOC, image: null });
    const msg = await untilRelayed();
    expect(msg.spec.sketchImage).toEqual({ sourceLine: 3, image: null });
    dispatcher.settle(msg.spec.editId, undefined);
    expect((await pending).status).toBe(200);
  });
});
