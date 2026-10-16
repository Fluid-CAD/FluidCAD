// The timeline rename (`/code/set-feature-name`): an empty name keeps the
// current one (D4), a name another statement of the file holds is refused
// with the clash (D3) in the `{ newCode, error }` shape every code route
// answers refusals in, and a statement may keep its own name.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import express from 'express';
import http from 'node:http';
import { createSketchEditsRouter } from '../../src/routes/sketch-edits.ts';
import { FeatureEditDispatcher } from '../../src/edit-dispatch.ts';

const CODE = [
  `import { sketch, ellipse, extrude, fillet, part } from 'fluidcad/core'`,
  ``,
  `sketch('xy', () => { ellipse(100, 50) }).name('Sketch 1')`,
  `const e = extrude(30).name('Boss')`,
  `fillet(2, e.endEdges())`,
  `export const lid = part('Lid', () => {})`,
  ``,
].join('\n');

let server: http.Server;
let base: string;

async function rename(sourceLine: number, name: string | null) {
  const response = await fetch(`${base}/code/set-feature-name`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code: CODE, sourceLine, name }),
  });
  return { status: response.status, body: await response.json() };
}

describe('POST /code/set-feature-name', () => {
  beforeAll(async () => {
    const backend = { getCurrentCode: () => CODE, getCurrentFileName: () => '/ws/model.fluid.js' } as any;
    const send = () => false;
    const app = express();
    app.use(express.json());
    app.use(createSketchEditsRouter(backend, send, '/ws', new FeatureEditDispatcher(backend, send)));
    server = http.createServer(app);
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    base = `http://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}`;
  });
  afterAll(async () => {
    if (server?.listening) {
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });

  it('keeps the current name on an empty or null rename', async () => {
    for (const name of ['', '   ', null]) {
      const { status, body } = await rename(4, name);
      expect(status).toBe(200);
      expect(body).toEqual({ newCode: CODE });
    }
  });

  it('refuses a name another statement already holds, naming it', async () => {
    const chain = await rename(5, 'Boss');
    expect(chain.status).toBe(200);
    expect(chain.body).toEqual({ newCode: CODE, error: `'Boss' is already the name of the extrude at line 4` });

    const partName = await rename(5, ' Lid ');
    expect(partName.body).toEqual({ newCode: CODE, error: `'Lid' is already the name of the part at line 6` });
  });

  it('lets a statement keep its own name and renames to a free one', async () => {
    const same = await rename(4, 'Boss');
    expect(same.body).toEqual({ newCode: CODE });

    const fresh = await rename(5, 'Rim');
    expect(fresh.body.error).toBeUndefined();
    expect(fresh.body.newCode).toContain(`fillet(2, e.endEdges()).name('Rim')`);
  });
});
