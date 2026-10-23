// The Edit-parameters dialog's Configuration select: POST api/update-insert-params
// carries `configuration` (a row name, or null for the literals) next to its
// value diff, and the statement's string argument is rewritten through the
// same acked edit round trip the values ride.

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

describe('POST api/update-insert-params with a configuration', () => {
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
      `const base = insert(frame, 'Wide', { Depth: 1000 });`,
      `const arm = insert(link);`,
      ``,
    ].join('\n');
  });

  it('writes the name and the value diff in one edit', async () => {
    const result = await actAsEditor(post('/update-insert-params', {
      filePath: FILE, sourceLine: 3, set: { Length: 300 }, configuration: 'Long',
    }));
    expect(result).toEqual({ status: 200, body: { success: true } });
    expect(relayed[0].spec.insertParams).toEqual({ line: 3, set: { Length: 300 }, configuration: 'Long' });
    expect(buffer).toContain(`const arm = insert(link, 'Long', { Length: 300 });`);
  });

  it('a name alone is a valid request; null clears it', async () => {
    let result = await actAsEditor(post('/update-insert-params', { filePath: FILE, sourceLine: 3, set: {}, configuration: 'Long' }));
    expect(result.status).toBe(200);
    expect(buffer).toContain(`const arm = insert(link, 'Long');`);
    result = await actAsEditor(post('/update-insert-params', { filePath: FILE, sourceLine: 2, set: {}, configuration: null }));
    expect(result.status).toBe(200);
    expect(buffer).toContain(`const base = insert(frame, { Depth: 1000 });`);
  });

  it('400s an empty or blank name, and a body with nothing to change', async () => {
    for (const body of [
      { filePath: FILE, sourceLine: 3, set: {}, configuration: '' },
      { filePath: FILE, sourceLine: 3, set: {}, configuration: 7 },
      { filePath: FILE, sourceLine: 3, set: {} },
    ]) {
      expect((await post('/update-insert-params', body)).status).toBe(400);
    }
    expect(relayed).toEqual([]);
  });

  it('422s a computed second argument before the editor is touched', async () => {
    buffer = buffer.replace(`insert(link)`, `insert(link, choice)`);
    const result = await post('/update-insert-params', { filePath: FILE, sourceLine: 3, set: {}, configuration: 'Long' });
    expect(result.status).toBe(422);
    expect(result.body.reason).toContain('non-literal second argument');
    expect(relayed).toEqual([]);
  });
});
