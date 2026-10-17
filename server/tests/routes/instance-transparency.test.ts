// The parts panel's Transparency… commit: POST api/set-instance-transparency
// rewrites the insert() chain's `.transparent(v)` through the acked edit round
// trip — malformed bodies 400, a statement in another file and a refused
// rewrite (an expression argument) 422 before the editor is touched.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import express from 'express';
import http from 'http';
import { createInstancePoseRouter } from '../../src/routes/instance-pose.ts';
import { createApplyFeatureRouter } from '../../src/routes/apply-feature/index.ts';
import { FeatureEditDispatcher } from '../../src/edit-dispatch.ts';

const FILE = '/ws/rig.assembly.js';

let server: http.Server;
let baseUrl: string;
let relayed: any[];
let buffer: string;

const fakeServer = {
  getCurrentCode: () => buffer,
  getCurrentFileName: () => FILE,
  getLiveBuffer: (filePath: string) => (filePath === FILE ? buffer : null),
};

async function post(path: string, body: unknown): Promise<{ status: number; body: any }> {
  const res = await fetch(`${baseUrl}/api${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

/** Play the editor host: apply each relayed spec to the buffer and ack it, until `pending` settles. */
async function actAsEditor(pending: Promise<{ status: number; body: any }>): Promise<{ status: number; body: any }> {
  let done = false;
  const settled = pending.then((value) => {
    done = true;
    return value;
  });
  let handled = 0;
  while (!done) {
    const msg = relayed.filter((m) => m.type === 'apply-feature-edit')[handled];
    if (!msg) {
      await new Promise((resolve) => setTimeout(resolve, 5));
      continue;
    }
    handled++;
    const res = await fetch(`${baseUrl}/api/code/apply-feature`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: buffer, spec: msg.spec }),
    });
    const result = await res.json();
    if (typeof result.newCode === 'string' && !result.error) {
      buffer = result.newCode;
    }
  }
  return settled;
}

describe('POST api/set-instance-transparency', () => {
  beforeAll(async () => {
    const app = express();
    app.use(express.json());
    const send = (msg: any) => {
      relayed.push(msg);
      return true;
    };
    const dispatcher = new FeatureEditDispatcher(fakeServer as any, send, { ackTimeoutMs: 500 });
    app.use('/api', createInstancePoseRouter(fakeServer as any, dispatcher, '/ws'));
    app.use('/api', createApplyFeatureRouter(fakeServer as any, send, { dispatcher }));
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
    buffer = [
      `import { insert } from 'fluidcad/core';`,
      `const base = insert(plate).grounded();`,
      `const arm = insert(link).translate(10, 0, 0);`,
      ``,
    ].join('\n');
  });

  it('writes the value onto the insert() and acks', async () => {
    const result = await actAsEditor(post('/set-instance-transparency', { filePath: FILE, sourceLine: 3, transparency: 0.4 }));
    expect(result).toEqual({ status: 200, body: { success: true } });
    expect(buffer).toContain(`const arm = insert(link).translate(10, 0, 0).transparent(0.4);`);
    expect(buffer).toContain(`const base = insert(plate).grounded();`);
  });

  it('drops the call for null', async () => {
    buffer = buffer.replace('.translate(10, 0, 0);', '.translate(10, 0, 0).transparent(0.4);');
    const result = await actAsEditor(post('/set-instance-transparency', { filePath: FILE, sourceLine: 3, transparency: null }));
    expect(result.status).toBe(200);
    expect(buffer).toContain(`const arm = insert(link).translate(10, 0, 0);`);
  });

  it('400s on a malformed body', async () => {
    for (const body of [
      { filePath: FILE, sourceLine: 3, transparency: 1.5 },
      { filePath: FILE, sourceLine: 3, transparency: '0.5' },
      { filePath: FILE, sourceLine: 0, transparency: 0.5 },
      { filePath: FILE, sourceLine: 3 },
    ]) {
      expect((await post('/set-instance-transparency', body)).status).toBe(400);
    }
    expect(relayed).toEqual([]);
  });

  it('422s for an insert() in another file', async () => {
    const result = await post('/set-instance-transparency', { filePath: '/ws/sub.assembly.js', sourceLine: 3, transparency: 0.4 });
    expect(result.status).toBe(422);
    expect(result.body.reason).toMatch(/lives in sub\.assembly\.js/);
    expect(relayed).toEqual([]);
  });

  it('422s a refused rewrite before the editor is touched', async () => {
    buffer = buffer.replace('.translate(10, 0, 0);', '.translate(10, 0, 0).transparent(glass);');
    const result = await post('/set-instance-transparency', { filePath: FILE, sourceLine: 3, transparency: 0.4 });
    expect(result.status).toBe(422);
    expect(result.body.reason).toMatch(/isn't a plain number/);
    expect(relayed).toEqual([]);
  });
});
