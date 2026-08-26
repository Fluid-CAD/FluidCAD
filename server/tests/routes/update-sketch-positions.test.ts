import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import express from 'express';
import http from 'http';
import { createSketchEditsRouter } from '../../src/routes/sketch-edits.ts';
import { FeatureEditDispatcher } from '../../src/edit-dispatch.ts';

// The solved-sketch batch write-back route (sketch-rewrite P4): preflight
// dry-run against the server's code copy refuses drift with a 422 before any
// IPC, then the editor's edit-ack settles the request — no fire-and-forget.

const CODE = [
  `import { sketch, line } from "fluidcad/core";`,
  ``,
  `sketch('xy', () => {`,
  `  const a = line([0, 0], [10, 0]);`,
  `});`,
].join('\n');

let server: http.Server;
let baseUrl: string;
let dispatcher: FeatureEditDispatcher;
let relayed: any[];
let delivered: boolean;

const fakeFluidCadServer = {
  getCurrentFileName: () => '/ws/m.fluid.js',
  getCurrentCode: () => CODE,
} as any;

async function post(body: unknown): Promise<{ status: number; body: any }> {
  const res = await fetch(`${baseUrl}/api/update-sketch-positions`, {
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

describe('/api/update-sketch-positions', () => {
  beforeAll(async () => {
    const sendToExtension = (msg: any) => {
      relayed.push(msg);
      return delivered;
    };
    dispatcher = new FeatureEditDispatcher(fakeFluidCadServer, sendToExtension, { ackTimeoutMs: 300 });
    const app = express();
    app.use(express.json());
    app.use('/api', createSketchEditsRouter(fakeFluidCadServer, sendToExtension, '/ws', dispatcher));
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
    delivered = true;
  });

  it('rejects malformed bodies without relaying', async () => {
    expect((await post({})).status).toBe(400);
    expect((await post({ edits: [] })).status).toBe(400);
    expect((await post({ edits: [{ sourceLine: 'x' }] })).status).toBe(400);
    expect((await post({ edits: [{ sourceLine: 4, points: [{ pointIndex: 0 }] }] })).status).toBe(400);
    expect(relayed).toEqual([]);
  });

  it('preflight-refuses drift with 422 before any IPC', async () => {
    const { status, body } = await post({
      edits: [{ sourceLine: 4, points: [{ pointIndex: 0, position: [1, 1], expected: [99, 0] }] }],
    });
    expect(status).toBe(422);
    expect(body.reason).toContain('changed since this drag started');
    expect(relayed).toEqual([]);
  });

  it('relays a clean batch with an editId and answers on the ack', async () => {
    const pending = post({
      edits: [{ sourceLine: 4, points: [{ pointIndex: 0, position: [1, 1], expected: [0, 0] }] }],
    });
    const msg = await untilRelayed();
    expect(msg.type).toBe('update-sketch-positions');
    expect(typeof msg.editId).toBe('string');
    expect(msg.edits).toEqual([
      { sourceLine: 4, points: [{ pointIndex: 0, position: [1, 1], expected: [0, 0] }] },
    ]);
    dispatcher.settle(msg.editId, undefined);
    const { status, body } = await pending;
    expect(status).toBe(200);
    expect(body.success).toBe(true);
  });

  it('answers 422 when the editor acks an error', async () => {
    const pending = post({
      edits: [{ sourceLine: 4, points: [{ pointIndex: 0, position: [1, 1] }] }],
    });
    const msg = await untilRelayed();
    dispatcher.settle(msg.editId, 'line 4 changed since this drag started');
    const { status, body } = await pending;
    expect(status).toBe(422);
    expect(body.reason).toContain('changed since this drag started');
  });

  it('answers 504 when the editor never acks', async () => {
    const { status } = await post({
      edits: [{ sourceLine: 4, points: [{ pointIndex: 0, position: [1, 1] }] }],
    });
    expect(status).toBe(504);
  });

  it('answers 503 with no editor attached', async () => {
    delivered = false;
    const { status, body } = await post({
      edits: [{ sourceLine: 4, points: [{ pointIndex: 0, position: [1, 1] }] }],
    });
    expect(status).toBe(503);
    expect(body.reason).toContain('no editor');
  });
});
