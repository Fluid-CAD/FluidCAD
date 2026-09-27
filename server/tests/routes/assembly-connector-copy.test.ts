import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import express from 'express';
import http from 'http';
import { createAssemblyConnectorRouter } from '../../src/routes/assembly-connector.ts';
import { createApplyFeatureRouter } from '../../src/routes/apply-feature/index.ts';
import { FeatureEditDispatcher } from '../../src/edit-dispatch.ts';

// The assembly Copy dialog's endpoint: wire validation, the current-file
// and file-kind gates, the preview answering the statement the transform
// would write, and the ack round-trip through the shared dispatcher.
let server: http.Server;
let baseUrl: string;

let relayed: any[];
let currentCode: string | null;
let currentFileName: string;

const FILE = '/ws/rack.assembly.js';

const RACK = [
  `import { insert, mate, connector } from 'fluidcad/core';`,
  ``,
  `const card = insert(cardPart);`,
  `const bay = connector('bay', [0, 0, 20]);`,
  `const pivot = connector('pivot', [100, 0, 0]);`,
  `mate('slider', bay, card.connectors.edge);`,
  ``,
].join('\n');

const fakeServer = {
  getCurrentCode: () => currentCode,
  getCurrentFileName: () => currentFileName,
  getParamDefinitions: () => [],
};

const CREATE = {
  kind: 'linear',
  targets: [{ kind: 'connector', connectorLine: 4, connectorName: 'bay' }],
  directions: [{ axis: { kind: 'standard', axis: 'x' }, count: 4, value: 50 }],
  spacingMode: 'offset',
};

async function post(body: unknown): Promise<{ status: number; body: any }> {
  const res = await fetch(`${baseUrl}/api/assembly-connector-copy`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

async function postRoundTrip(code: string, spec: unknown): Promise<{ status: number; body: any }> {
  const res = await fetch(`${baseUrl}/api/code/apply-feature`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code, spec }),
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

describe('assembly-connector-copy route', () => {
  beforeAll(async () => {
    const sendFn = (msg: any) => {
      relayed.push(msg);
      return true;
    };
    const dispatcher = new FeatureEditDispatcher(fakeServer as any, sendFn, { ackTimeoutMs: 300 });
    const app = express();
    app.use(express.json());
    app.use('/api', createAssemblyConnectorRouter(fakeServer as any, dispatcher));
    app.use('/api', createApplyFeatureRouter(fakeServer as any, sendFn, { dispatcher }));
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
    currentCode = RACK;
    currentFileName = FILE;
  });

  it('rejects a malformed body before anything is relayed', async () => {
    expect((await post({ filePath: FILE })).status).toBe(400);
    expect((await post({ filePath: FILE, create: CREATE, remove: { sourceLine: 7 } })).status).toBe(400);
    expect((await post({ filePath: FILE, create: { ...CREATE, kind: 'mirror' } })).status).toBe(400);
    const slotTarget = await post({
      filePath: FILE,
      create: { ...CREATE, targets: [{ kind: 'connector', connectorLine: 4, connectorName: 'bay', slot: 1 }] },
    });
    expect(slotTarget.status).toBe(400);
    expect(slotTarget.body.error).toMatch(/not copied again/);
    expect(relayed).toEqual([]);
  });

  it('refuses a part file and another assembly file', async () => {
    currentFileName = '/ws/flange.part.js';
    const part = await post({ filePath: FILE, create: CREATE });
    expect(part.status).toBe(422);
    expect(part.body.reason).toMatch(/open a \*\.assembly\.js file/);

    currentFileName = '/ws/other.assembly.js';
    const other = await post({ filePath: FILE, create: CREATE });
    expect(other.status).toBe(422);
    expect(other.body.reason).toMatch(/belongs to rack\.assembly\.js/);
    expect(relayed).toEqual([]);
  });

  it('previews the statement the transform would write, relaying nothing', async () => {
    const preview = await post({ filePath: FILE, create: CREATE, preview: true });
    expect(preview.status).toBe(200);
    expect(preview.body).toEqual({ success: true, preview: `copy('linear', 'x', { count: 4, offset: 50 }, bay)` });

    const stale = await post({
      filePath: FILE,
      create: { ...CREATE, targets: [{ kind: 'connector', connectorLine: 3, connectorName: 'bay' }] },
      preview: true,
    });
    expect(stale.status).toBe(422);
    expect(stale.body.reason).toMatch(/not a connector\(\)/);
    expect(relayed).toEqual([]);
  });

  it('dispatches the create and settles it through the host round trip', async () => {
    const applied = post({ filePath: FILE, create: CREATE, newVariables: [] });
    const msg = await untilRelayed();
    expect(msg.spec.assemblyConnectorCopy).toEqual({ create: CREATE });
    const roundTrip = await postRoundTrip(RACK, msg.spec);
    expect(roundTrip.body.error).toBeUndefined();
    expect(roundTrip.body.newCode).toContain(`copy('linear', 'x', { count: 4, offset: 50 }, bay);`);
    expect(roundTrip.body.newCode).toContain(`import { copy, insert, mate, connector } from 'fluidcad/core';`);
    const { status, body } = await applied;
    expect(status).toBe(200);
    expect(body).toMatchObject({ success: true });
  });

  it('refuses a removal whose line holds no copy() before anything is relayed', async () => {
    const refused = await post({ filePath: FILE, remove: { sourceLine: 4 } });
    expect(refused.status).toBe(422);
    expect(relayed).toEqual([]);
  });

  it('dispatches a removal through the delete sweep', async () => {
    const code = `${RACK}copy('linear', 'x', { count: 4, offset: 50 }, bay);\nmate('slider', bay.instance(2), card.connectors.top);\n`;
    currentCode = code;
    const applied = post({ filePath: FILE, remove: { sourceLine: 7 } });
    const msg = await untilRelayed();
    const roundTrip = await postRoundTrip(code, msg.spec);
    expect(roundTrip.body.error).toBeUndefined();
    expect(roundTrip.body.newCode).toBe(RACK);
    expect((await applied).status).toBe(200);
  });
});
