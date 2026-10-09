import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import express from 'express';
import http from 'http';
import { createAssemblyMateRouter } from '../../src/routes/assembly-mate.ts';
import { createApplyFeatureRouter } from '../../src/routes/apply-feature/index.ts';
import { FeatureEditDispatcher } from '../../src/edit-dispatch.ts';

// The relation dialog's commit endpoint: validation, the preflight refusing
// bad relation specs before the editor is touched, and the ack round-trip
// settling the response with the transform's true outcome.
let server: http.Server;
let baseUrl: string;
let relayed: any[];
let delivered: boolean;
let currentCode: string;
let currentFileName: string;

const ASSEMBLY_CODE = [
  `import { insert, mate } from 'fluidcad/core';`,
  `import { gear } from './gear.part.js';`,
  `import { base } from './base.part.js';`,
  ``,
  `const base1 = insert(base()).grounded();`,
  `const g1 = insert(gear());`,
  `const g2 = insert(gear());`,
  ``,
  `const pinion = mate('revolute', base1.connectors.a1, g1.connectors.bore);`,
  `mate('revolute', base1.connectors.a2, g2.connectors.bore);`,
  ``,
].join('\n');

const fakeServer = {
  getCurrentCode: () => currentCode,
  getCurrentFileName: () => currentFileName,
  getParamDefinitions: () => [],
};

async function postRelation(body: unknown): Promise<{ status: number; body: any }> {
  const res = await fetch(`${baseUrl}/api/assembly-relation`, {
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

const CREATE_BODY = {
  filePath: '/ws/m.assembly.js',
  create: { type: 'gear', mateA: { mateLine: 9 }, mateB: { mateLine: 10 }, ratio: 2, reverse: true },
};

describe('assembly-relation route', () => {
  beforeAll(async () => {
    const sendFn = (msg: any) => {
      relayed.push(msg);
      return delivered;
    };
    const dispatcher = new FeatureEditDispatcher(fakeServer as any, sendFn, { ackTimeoutMs: 300 });
    const app = express();
    app.use(express.json());
    app.use('/api', createAssemblyMateRouter(fakeServer as any, dispatcher));
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
    delivered = true;
    currentCode = ASSEMBLY_CODE;
    currentFileName = '/ws/m.assembly.js';
  });

  it('rejects a malformed body', async () => {
    expect((await postRelation({ filePath: '/ws/m.assembly.js', create: { type: 'gear', mateA: { mateLine: 9 }, ratio: 2 } })).status).toBe(400);
    expect((await postRelation({ ...CREATE_BODY, edit: { ...CREATE_BODY.create, sourceLine: 11 } })).status).toBe(400);
    expect((await postRelation({ filePath: '/ws/m.assembly.js' })).status).toBe(400);
    expect((await postRelation({ ...CREATE_BODY, create: { ...CREATE_BODY.create, type: 'belt' } })).status).toBe(400);
    expect((await postRelation({ ...CREATE_BODY, create: { ...CREATE_BODY.create, ratio: 'two' } })).status).toBe(400);
    expect((await postRelation({ ...CREATE_BODY, create: { ...CREATE_BODY.create, reverse: 'yes' } })).status).toBe(400);
    expect(relayed).toEqual([]);
  });

  it('refuses a part file, another file, and a missing scene', async () => {
    currentFileName = '/ws/m.part.js';
    expect((await postRelation(CREATE_BODY)).status).toBe(422);
    currentFileName = '/ws/other.assembly.js';
    const other = await postRelation(CREATE_BODY);
    expect(other.status).toBe(422);
    expect(other.body.reason).toMatch(/belongs to m\.assembly\.js/);
    currentFileName = '';
    expect((await postRelation(CREATE_BODY)).status).toBe(404);
    expect(relayed).toEqual([]);
  });

  it('preflights the transform: a non-positive ratio and a wrong-typed side answer 422', async () => {
    const ratio = await postRelation({ ...CREATE_BODY, create: { ...CREATE_BODY.create, ratio: 0 } });
    expect(ratio.status).toBe(422);
    expect(ratio.body.reason).toMatch(/must be positive/);
    currentCode = ASSEMBLY_CODE.replace("mate('revolute', base1.connectors.a2", "mate('fastened', base1.connectors.a2");
    const side = await postRelation(CREATE_BODY);
    expect(side.status).toBe(422);
    expect(side.body.reason).toMatch(/second mate is 'fastened'/);
    expect(relayed).toEqual([]);
  });

  it('relays the create spec and settles on the host ack with the written statement', async () => {
    const pending = postRelation(CREATE_BODY);
    const msg = await untilRelayed();
    expect(msg.type).toBe('apply-feature-edit');
    expect(msg.spec.assemblyRelation).toEqual({
      create: { type: 'gear', mateA: { mateLine: 9 }, mateB: { mateLine: 10 }, ratio: 2, reverse: true },
    });
    const applied = await postRoundTrip(currentCode, msg.spec);
    expect(applied.status).toBe(200);
    expect(applied.body.newCode).toContain("const mate1 = mate('revolute', base1.connectors.a2, g2.connectors.bore);");
    expect(applied.body.newCode).toContain("relation('gear', pinion, mate1, 2).reverse();");
    expect(applied.body.newCode).toContain("import { relation, insert, mate } from 'fluidcad/core';");
    const settled = await pending;
    expect(settled.status).toBe(200);
    expect(settled.body).toEqual({ success: true });
  });

  it('relays an edit spec addressed by the statement line, dropping a false reverse', async () => {
    currentCode = ASSEMBLY_CODE.replace(
      "mate('revolute', base1.connectors.a2, g2.connectors.bore);",
      "const wheel = mate('revolute', base1.connectors.a2, g2.connectors.bore);\nrelation('gear', pinion, wheel, 2);",
    );
    const pending = postRelation({
      filePath: '/ws/m.assembly.js',
      edit: { sourceLine: 11, type: 'gear', mateA: { mateLine: 10 }, mateB: { mateLine: 9 }, ratio: 0.5, reverse: false },
    });
    const msg = await untilRelayed();
    expect(msg.spec.assemblyRelation).toEqual({
      edit: { sourceLine: 11, type: 'gear', mateA: { mateLine: 10 }, mateB: { mateLine: 9 }, ratio: 0.5 },
    });
    const applied = await postRoundTrip(currentCode, msg.spec);
    expect(applied.body.newCode).toContain("relation('gear', wheel, pinion, 0.5);");
    expect((await pending).status).toBe(200);
  });
});
