// The parameters panel's declaration endpoints, end to end through the shared
// apply-feature-edit round trip: the route validates the request shape, the
// preflight refuses an edit the file cannot take, a delivered edit reaches the
// editor host as a `paramEdit` spec, and the label-keyed override bookkeeping
// only moves once the edit actually landed.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import express from 'express';
import http from 'http';
import { createParamsRouter } from '../../src/routes/params.ts';
import { createApplyFeatureRouter } from '../../src/routes/apply-feature.ts';
import { FeatureEditDispatcher } from '../../src/edit-dispatch.ts';

let server: http.Server;
let baseUrl: string;
let relayed: any[];
/** What sendToExtension reports: true = a host process received the message. */
let delivered: boolean;
/** Override bookkeeping the routes drive after a successful edit. */
let bookkeeping: string[];

const FILE = '/ws/m.fluid.js';

const CODE = [
  `import { param, extrude } from 'fluidcad/core';`,
  ``,
  `const width = param('Width', 100);`,
  ``,
  `extrude(width);`,
  ``,
].join('\n');

const fakeServer = {
  getCurrentCode: () => CODE,
  getCurrentFileName: () => FILE,
  renameParam: (_session: string, from: string, to: string) => {
    bookkeeping.push(`rename ${from} -> ${to}`);
  },
  forgetParam: (_session: string, label: string) => {
    bookkeeping.push(`forget ${label}`);
  },
};

async function post(path: string, body: unknown): Promise<{ status: number; body: any }> {
  const res = await fetch(`${baseUrl}/api${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

/** The host's round-trip: run the relayed spec through /code/apply-feature. */
function roundTrip(spec: unknown): Promise<Response> {
  return fetch(`${baseUrl}/api/code/apply-feature`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code: CODE, spec }),
  });
}

/** Answer the next dispatch the way a live editor would, and hand back its code. */
async function actAsEditor(): Promise<string> {
  for (let i = 0; i < 200; i++) {
    const msg = relayed.find((m) => m.type === 'apply-feature-edit');
    if (msg) {
      const res = await roundTrip(msg.spec);
      return (await res.json()).newCode;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('nothing was relayed to the extension');
}

describe('parameter declaration routes', () => {
  beforeAll(async () => {
    const app = express();
    app.use(express.json());
    const send = (msg: any) => {
      relayed.push(msg);
      return delivered;
    };
    // The two routers must share one dispatcher, or the ack the host posts to
    // /code/apply-feature never reaches the request waiting on it.
    const dispatcher = new FeatureEditDispatcher(fakeServer as any, send, { ackTimeoutMs: 500 });
    app.use('/api', createParamsRouter(fakeServer as any, send, () => {}, dispatcher));
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
    delivered = true;
    bookkeeping = [];
  });

  it('reports the variable a parameter binds and what reads it', async () => {
    const res = await fetch(`${baseUrl}/api/params/usage?label=Width&line=3`);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      variable: 'width',
      references: 1,
      referenceLines: [5],
      editable: true,
    });
  });

  it('adds a declaration, naming its variable from the label', async () => {
    const pending = post('/params/add', {
      param: { label: 'Depth', defaultValue: 25, type: 'slider', min: 0, max: 50 },
    });
    const newCode = await actAsEditor();
    const { status, body } = await pending;

    expect(status).toBe(200);
    expect(body.success).toBe(true);
    expect(newCode).toContain(`const depth = param('Depth', 25, 'slider', { min: 0, max: 50 });`);
  });

  it('renames the label, leaves the variable, and moves the override with it', async () => {
    const pending = post('/params/update', {
      label: 'Width',
      line: 3,
      param: { label: 'Overall width', defaultValue: 100, type: 'number' },
    });
    const newCode = await actAsEditor();
    const { body } = await pending;

    expect(body.success).toBe(true);
    expect(newCode).toContain(`const width = param('Overall width', 100);`);
    expect(newCode).toContain('extrude(width);');
    expect(bookkeeping).toEqual(['rename Width -> Overall width']);
  });

  it('leaves the override alone when only the control changed', async () => {
    const pending = post('/params/update', {
      label: 'Width',
      line: 3,
      param: { label: 'Width', defaultValue: 100, type: 'slider', min: 0, max: 500 },
    });
    const newCode = await actAsEditor();
    await pending;

    expect(newCode).toContain(`param('Width', 100, 'slider', { min: 0, max: 500 })`);
    expect(bookkeeping).toEqual([]);
  });

  it('removes a declaration and forgets its override', async () => {
    const pending = post('/params/remove', { label: 'Width', line: 3 });
    const newCode = await actAsEditor();
    const { body } = await pending;

    expect(body.success).toBe(true);
    expect(newCode).not.toContain('param(');
    expect(bookkeeping).toEqual(['forget Width']);
  });

  it('sends the edit to the file that declares the param, not the one on screen', async () => {
    const other = '/ws/shared.fluid.js';
    const pending = post('/params/remove', { label: 'Anywhere', line: 2, filePath: other });
    // The preflight only dry-runs against the current file, so a sibling's
    // declaration goes straight to the host that owns that buffer.
    const msg = await (async () => {
      for (let i = 0; i < 200; i++) {
        const found = relayed.find((m) => m.type === 'apply-feature-edit');
        if (found) {
          return found;
        }
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      throw new Error('nothing was relayed');
    })();
    expect(msg.spec.filePath).toBe(other);
    expect(msg.spec.paramEdit).toMatchObject({ kind: 'remove', expectedLabel: 'Anywhere', line: 2 });

    await fetch(`${baseUrl}/api/code/apply-feature`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        code: `import { param } from 'fluidcad/core';\nconst a = param('Anywhere', 1);\n`,
        spec: msg.spec,
      }),
    });
    expect((await pending).body.success).toBe(true);
  });

  it('reports no usage for a param the rendered file does not declare', async () => {
    const res = await fetch(
      `${baseUrl}/api/params/usage?label=Anywhere&filePath=${encodeURIComponent('/ws/shared.fluid.js')}`,
    );
    // Unreadable from here is not the same as unwritable — the declaration
    // still edits, it just cannot be described.
    expect(await res.json()).toMatchObject({ variable: null, references: 0, editable: true });
  });

  it('refuses an edit the file cannot take, before it reaches the editor', async () => {
    const { status, body } = await post('/params/update', {
      label: 'Gone',
      param: { label: 'Gone', defaultValue: 1, type: 'number' },
    });
    expect(status).toBe(422);
    expect(body.reason).toContain('is the file in sync');
    expect(relayed).toEqual([]);
    expect(bookkeeping).toEqual([]);
  });

  it('leaves the bookkeeping untouched when the editor refuses the edit', async () => {
    // The preflight passes (the label exists) but the host's buffer has moved
    // on, so the round trip is where the refusal comes from.
    const pending = post('/params/remove', { label: 'Width', line: 3 });
    const msg = await (async () => {
      for (let i = 0; i < 200; i++) {
        const found = relayed.find((m) => m.type === 'apply-feature-edit');
        if (found) {
          return found;
        }
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      throw new Error('nothing was relayed');
    })();
    await fetch(`${baseUrl}/api/code/apply-feature`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: `import { extrude } from 'fluidcad/core';\n`, spec: msg.spec }),
    });
    const { status, body } = await pending;

    expect(status).toBe(422);
    expect(body.reason).toContain('is the file in sync');
    expect(bookkeeping).toEqual([]);
  });

  it.each([
    ['/params/add', {}],
    ['/params/add', { param: { label: 'A', defaultValue: 1, type: 'nope' } }],
    ['/params/add', { param: { label: '', defaultValue: 1, type: 'number' } }],
    ['/params/add', { param: { label: 'A', defaultValue: { bad: true }, type: 'number' } }],
    ['/params/update', { param: { label: 'A', defaultValue: 1, type: 'number' } }],
    ['/params/remove', {}],
  ])('rejects a malformed %s body without dispatching', async (path, body) => {
    const result = await post(path, body);
    expect(result.status).toBe(400);
    expect(relayed).toEqual([]);
  });
});
