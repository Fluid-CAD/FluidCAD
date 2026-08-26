import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import express from 'express';
import http from 'http';
import { createAssemblyMateRouter } from '../../src/routes/assembly-mate.ts';
import { createApplyFeatureRouter } from '../../src/routes/apply-feature.ts';
import { FeatureEditDispatcher } from '../../src/edit-dispatch.ts';

// The mate dialog's commit endpoint: validation, the preflight refusing bad
// mate specs before the editor is touched, and the ack round-trip settling
// the response with the transform's true outcome.
let server: http.Server;
let baseUrl: string;

let relayed: any[];
let delivered: boolean;
let currentCode: string;
let currentFileName: string;
// Tangent fixtures: what resolveContactPick / synthesizeApplyFeature answer.
let contactPickResult: any;
let synthesizeResult: any;

const ASSEMBLY_CODE = [
  `import { insert, mate } from 'fluidcad/core';`,
  `import { arm } from './arm.part.js';`,
  `import { base } from './base.part.js';`,
  ``,
  `const arm1 = insert(arm());`,
  `const base1 = insert(base()).grounded();`,
  ``,
  `mate('revolute', arm1.connectors.hinge, base1.connectors.hinge).limits(0, 90);`,
  ``,
].join('\n');

const fakeServer = {
  getCurrentCode: () => currentCode,
  getCurrentFileName: () => currentFileName,
  getParamDefinitions: () => [],
  resolveContactPick: () => contactPickResult,
  synthesizeApplyFeature: () => synthesizeResult,
};

async function postMate(body: unknown): Promise<{ status: number; body: any }> {
  const res = await fetch(`${baseUrl}/api/assembly-mate`, {
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
  create: {
    type: 'fastened',
    connectorA: { instanceLine: 5, connectorName: 'tip' },
    connectorB: { instanceLine: 6, connectorName: 'slot' },
  },
};

describe('assembly-mate route', () => {
  beforeAll(async () => {
    const sendFn = (msg: any) => {
      relayed.push(msg);
      return delivered;
    };
    const dispatcher = new FeatureEditDispatcher(fakeServer as any, sendFn, { ackTimeoutMs: 300 });

    const app = express();
    app.use(express.json());
    app.use('/api', createAssemblyMateRouter(fakeServer as any, dispatcher));
    // The settle endpoint the host round-trips through — must share the dispatcher.
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
    contactPickResult = null;
    synthesizeResult = null;
  });

  it('rejects a malformed body', async () => {
    const missingSide = await postMate({
      filePath: '/ws/m.assembly.js',
      create: { type: 'fastened', connectorA: { instanceLine: 5, connectorName: 'tip' } },
    });
    expect(missingSide.status).toBe(400);
    const bothModes = await postMate({ ...CREATE_BODY, edit: { ...CREATE_BODY.create, sourceLine: 8 } });
    expect(bothModes.status).toBe(400);
    const neitherMode = await postMate({ filePath: '/ws/m.assembly.js' });
    expect(neitherMode.status).toBe(400);
    const badType = await postMate({
      ...CREATE_BODY,
      create: { ...CREATE_BODY.create, type: 'spherical' },
    });
    expect(badType.status).toBe(400);
    expect(relayed).toEqual([]);
  });

  it('refuses when the current file is not an assembly', async () => {
    currentFileName = '/ws/m.fluid.js';
    const { status, body } = await postMate({ ...CREATE_BODY, filePath: '/ws/m.fluid.js' });
    expect(status).toBe(422);
    expect(body.reason).toContain('assembly');
    expect(relayed).toEqual([]);
  });

  it("refuses another file's mate (sub-assembly)", async () => {
    const { status, body } = await postMate({ ...CREATE_BODY, filePath: '/ws/sub.assembly.js' });
    expect(status).toBe(422);
    expect(body.reason).toContain('sub.assembly.js');
    expect(relayed).toEqual([]);
  });

  it('preflight refuses an unresolvable instance line before any dispatch', async () => {
    const { status, body } = await postMate({
      ...CREATE_BODY,
      create: {
        ...CREATE_BODY.create,
        connectorA: { instanceLine: 8, connectorName: 'tip' },
      },
    });
    expect(status).toBe(422);
    expect(body.success).toBe(false);
    expect(body.reason).toContain('not an insert()');
    expect(relayed).toEqual([]);
  });

  it('preflight refuses invalid options before any dispatch', async () => {
    const { status, body } = await postMate({
      ...CREATE_BODY,
      create: { ...CREATE_BODY.create, type: 'planar', options: { offset: [3, 0, 0] } },
    });
    expect(status).toBe(422);
    expect(body.reason).toContain('along Z');
    expect(relayed).toEqual([]);
  });

  it('answers success once the editor round-trip confirms the create', async () => {
    const applied = postMate({
      ...CREATE_BODY,
      create: { ...CREATE_BODY.create, options: { flip: true, rotate: 15 } },
    });
    const msg = await untilRelayed();
    expect(msg.type).toBe('apply-feature-edit');
    expect(typeof msg.spec.editId).toBe('string');
    expect(msg.spec.assemblyMate.create).toMatchObject({ type: 'fastened' });

    const roundTrip = await postRoundTrip(ASSEMBLY_CODE, msg.spec);
    expect(roundTrip.body.error).toBeUndefined();
    expect(roundTrip.body.newCode).toContain(
      `mate('fastened', arm1.connectors.tip, base1.connectors.slot).flip().rotate(15);`,
    );

    const { status, body } = await applied;
    expect(status).toBe(200);
    expect(body).toMatchObject({ success: true });
  });

  it('answers success once the editor round-trip confirms the edit', async () => {
    const applied = postMate({
      filePath: '/ws/m.assembly.js',
      edit: {
        sourceLine: 8,
        type: 'slider',
        connectorA: { instanceLine: 5, connectorName: 'hinge' },
        connectorB: { instanceLine: 6, connectorName: 'hinge' },
        options: { limits: [0, 40] },
      },
    });
    const msg = await untilRelayed();
    const roundTrip = await postRoundTrip(ASSEMBLY_CODE, msg.spec);
    expect(roundTrip.body.error).toBeUndefined();
    expect(roundTrip.body.newCode).toContain(
      `mate('slider', arm1.connectors.hinge, base1.connectors.hinge).limits(0, 40);`,
    );
    expect(roundTrip.body.newCode).not.toContain(`limits(0, 90)`);

    const { status, body } = await applied;
    expect(status).toBe(200);
    expect(body).toMatchObject({ success: true });
  });

  it('reports a timeout when the editor never round-trips', async () => {
    const { status, body } = await postMate(CREATE_BODY);
    expect(status).toBe(504);
    expect(body.success).toBe(false);
    expect(body.reason).toContain('did not apply the edit');
  });

  it('keeps the legacy immediate success when no host process is attached', async () => {
    delivered = false;
    const { status, body } = await postMate(CREATE_BODY);
    expect(status).toBe(200);
    expect(body).toMatchObject({ success: true });
  });

  // Tangent mates (17-mate-tangent §7.2/§7.3): geometry sides, the classify
  // route, and the find-or-create sequencing incl. mid-sequence failure.
  describe('tangent', () => {
    const PLANE_SEED = {
      form: 'plane', point: [0, 0, 10], dir: [0, 0, 1], xDir: [1, 0, 0], convex: true,
    };

    it('matched exposures ride straight to the mate statement', async () => {
      const applied = postMate({
        filePath: '/ws/m.assembly.js',
        create: {
          type: 'tangent',
          geometryA: { instanceLine: 5, exposeName: 'profile' },
          geometryB: { instanceLine: 6, exposeName: 'tip' },
          options: { propagate: false },
        },
      });
      const msg = await untilRelayed();
      expect(msg.spec.assemblyMate.create).toMatchObject({ type: 'tangent' });
      expect(msg.spec.assemblyMate.exposeCreates).toBeUndefined();
      const roundTrip = await postRoundTrip(ASSEMBLY_CODE, msg.spec);
      expect(roundTrip.body.error).toBeUndefined();
      expect(roundTrip.body.newCode).toContain(
        `mate('tangent', arm1.features.profile, base1.features.tip).noPropagate();`,
      );
      const { status, body } = await applied;
      expect(status).toBe(200);
      expect(body).toMatchObject({ success: true });
    });

    it('rejects mixed side kinds at validation', async () => {
      const { status } = await postMate({
        filePath: '/ws/m.assembly.js',
        create: {
          type: 'tangent',
          connectorA: { instanceLine: 5, connectorName: 'tip' },
          connectorB: { instanceLine: 6, connectorName: 'tip' },
        },
      });
      expect(status).toBe(400);
      expect(relayed).toEqual([]);
    });

    it('refuses an unsupported surface form with the pointed message', async () => {
      contactPickResult = {
        ok: true,
        donor: {
          partName: 'Arm', filePath: '/ws/arm.part.js', line: 3, column: 0,
          matched: null, existingNames: [],
        },
        seed: null,
        chain: [],
      };
      const { status, body } = await postMate({
        filePath: '/ws/m.assembly.js',
        create: {
          type: 'tangent',
          geometryA: { instanceLine: 5, pick: { shapeId: 's1', sub: { type: 'face', index: 0 } } },
          geometryB: { instanceLine: 6, exposeName: 'tip' },
        },
      });
      expect(status).toBe(422);
      expect(body.reason).toContain("isn't supported yet");
      expect(relayed).toEqual([]);
    });

    it('sequences a cross-file expose create before the mate dispatch', async () => {
      contactPickResult = {
        ok: true,
        donor: {
          partName: 'Arm', filePath: '/ws/arm.part.js', line: 3, column: 0,
          matched: null, existingNames: ['g1'],
        },
        seed: PLANE_SEED,
        chain: [PLANE_SEED],
      };
      synthesizeResult = {
        ok: true,
        spec: {
          feature: 'expose',
          filePath: '/ws/arm.part.js',
          expose: { name: 'g2', part: { line: 3, column: 24 } },
          producers: [{ line: 4, column: 2, featureType: 'extrude', nameHint: 'e', bind: true }],
          parts: [{ producer: 0, accessor: 'endFaces', indices: [0], filterArgs: null }],
          imports: [],
        },
      };
      const applied = postMate({
        filePath: '/ws/m.assembly.js',
        create: {
          type: 'tangent',
          geometryA: { instanceLine: 5, pick: { shapeId: 's1', sub: { type: 'face', index: 0 } } },
          geometryB: { instanceLine: 6, exposeName: 'tip' },
        },
      });
      // First relay: the donor-file expose spec (dispatcher.send).
      const exposeMsg = await untilRelayed();
      expect(exposeMsg.spec.feature).toBe('expose');
      expect(exposeMsg.spec.filePath).toBe('/ws/arm.part.js');
      const donorCode = [
        `import { part, sketch, extrude } from 'fluidcad/core';`,
        ``,
        `export const arm = () => part('Arm', () => {`,
        `  const e = extrude(10)`,
        `});`,
      ].join('\n');
      const exposeTrip = await postRoundTrip(donorCode, exposeMsg.spec);
      expect(exposeTrip.body.error).toBeUndefined();
      expect(exposeTrip.body.newCode).toContain(`expose('g2', e.endFaces(0))`);
      // Second relay: the mate spec against the assembly file, referencing
      // the freshly allocated name.
      let mateMsg: any;
      for (let i = 0; i < 100 && !mateMsg; i++) {
        mateMsg = relayed.find(m => m.spec.assemblyMate);
        if (!mateMsg) await new Promise(r => setTimeout(r, 5));
      }
      expect(mateMsg.spec.assemblyMate.create.geometryA.exposeName).toBe('g2');
      const mateTrip = await postRoundTrip(ASSEMBLY_CODE, mateMsg.spec);
      expect(mateTrip.body.newCode).toContain(
        `mate('tangent', arm1.features.g2, base1.features.tip);`,
      );
      const { status, body } = await applied;
      expect(status).toBe(200);
      expect(body).toMatchObject({ success: true });
    });

    it('a failing cross-file create surfaces a 422 naming the exposure', async () => {
      contactPickResult = {
        ok: true,
        donor: {
          partName: 'Arm', filePath: '/ws/arm.part.js', line: 3, column: 0,
          matched: null, existingNames: [],
        },
        seed: PLANE_SEED,
        chain: [PLANE_SEED],
      };
      synthesizeResult = {
        ok: true,
        spec: {
          feature: 'expose',
          filePath: '/ws/arm.part.js',
          expose: { name: 'g1', part: { line: 3, column: 24 } },
          producers: [{ line: 4, column: 2, featureType: 'extrude', nameHint: 'e', bind: true }],
          parts: [{ producer: 0, accessor: 'endFaces', indices: [0], filterArgs: null }],
          imports: [],
        },
      };
      const applied = postMate({
        filePath: '/ws/m.assembly.js',
        create: {
          type: 'tangent',
          geometryA: { instanceLine: 5, pick: { shapeId: 's1', sub: { type: 'face', index: 0 } } },
          geometryB: { instanceLine: 6, exposeName: 'tip' },
        },
      });
      const exposeMsg = await untilRelayed();
      // Ack the expose against code with no part() at the addressed line —
      // the transform fails and dispatcher.send reports the error.
      const exposeTrip = await postRoundTrip(`const nothing = 1;\n`, exposeMsg.spec);
      expect(exposeTrip.body.error).toBeDefined();
      const { status, body } = await applied;
      expect(status).toBe(422);
      expect(body.reason).toContain(`expose('g1')`);
      expect(body.reason).toContain('arm.part.js');
    });

    it('classify-contact resolves a pick and 422s a failed attribution', async () => {
      contactPickResult = {
        ok: true,
        donor: {
          partName: 'Arm', filePath: '/ws/arm.part.js', line: 3, column: 0,
          matched: 'g1', existingNames: ['g1'],
        },
        seed: PLANE_SEED,
        chain: [PLANE_SEED],
      };
      const okRes = await fetch(`${baseUrl}/api/classify-contact`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pick: { shapeId: 's1', sub: { type: 'face', index: 0 } } }),
      });
      expect(okRes.status).toBe(200);
      const okBody = await okRes.json();
      expect(okBody.donor.matched).toBe('g1');
      expect(okBody.seed.form).toBe('plane');

      contactPickResult = { ok: false, reason: 'pick does not resolve' };
      const badRes = await fetch(`${baseUrl}/api/classify-contact`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pick: { shapeId: 's1', sub: { type: 'face', index: 0 } } }),
      });
      expect(badRes.status).toBe(422);
    });
  });

  // The pen-button endpoints: property read from the part file, write through
  // the dispatcher (cross-file spec — the preflight self-skips).
  describe('assembly-connector routes', () => {
  const PART_CODE = [
    `import { part, connector, extrude } from 'fluidcad/core';`,
    ``,
    `export const arm = () => part('arm', () => {`,
    `  const body = extrude(s, 10);`,
    `  connector('hinge', body.endFaces(0).center()).offset(0, 0, 2).rotate('x', 90);`,
    `});`,
  ].join('\n');

  async function post(path: string, body: unknown): Promise<{ status: number; body: any }> {
    const res = await fetch(`${baseUrl}/api/${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { status: res.status, body: await res.json() };
  }

  it('reads dialog-editable properties from the current buffer', async () => {
    currentFileName = '/ws/arm.part.js';
    currentCode = PART_CODE;
    const { status, body } = await post('assembly-connector-properties', {
      filePath: '/ws/arm.part.js',
      sourceLine: 5,
    });
    expect(status).toBe(200);
    expect(body).toEqual({
      name: 'hinge',
      rotate: { axis: 'x', angle: 90 },
      offset: [0, 0, 2],
    });
  });

  it('404s an unreadable file and 422s a non-connector line', async () => {
    const unreadable = await post('assembly-connector-properties', {
      filePath: '/nope/missing.part.js',
      sourceLine: 5,
    });
    expect(unreadable.status).toBe(404);

    currentFileName = '/ws/arm.part.js';
    currentCode = PART_CODE;
    const wrongLine = await post('assembly-connector-properties', {
      filePath: '/ws/arm.part.js',
      sourceLine: 4,
    });
    expect(wrongLine.status).toBe(422);
  });

  it('round-trips a cross-file property write through the dispatcher', async () => {
    const applied = post('assembly-connector', {
      filePath: '/ws/arm.part.js',
      sourceLine: 5,
      name: 'pivot',
      rotate: null,
      offset: [0, 0, 5],
    });
    const msg = await untilRelayed();
    expect(msg.spec.filePath).toBe('/ws/arm.part.js');
    expect(msg.spec.connectorProps).toMatchObject({ sourceLine: 5, name: 'pivot' });

    const roundTrip = await postRoundTrip(PART_CODE, msg.spec);
    expect(roundTrip.body.error).toBeUndefined();
    expect(roundTrip.body.newCode).toContain(
      `connector('pivot', body.endFaces(0).center()).offset(0, 0, 5);`,
    );

    const { status, body } = await applied;
    expect(status).toBe(200);
    expect(body).toMatchObject({ success: true });
  });

  it('rejects malformed write bodies', async () => {
    const badRotate = await post('assembly-connector', {
      filePath: '/ws/arm.part.js', sourceLine: 5, name: 'x', rotate: { axis: 'q', angle: 1 }, offset: null,
    });
    expect(badRotate.status).toBe(400);
    const badOffset = await post('assembly-connector', {
      filePath: '/ws/arm.part.js', sourceLine: 5, name: 'x', rotate: null, offset: [1, 2],
    });
    expect(badOffset.status).toBe(400);
  });
});
});
