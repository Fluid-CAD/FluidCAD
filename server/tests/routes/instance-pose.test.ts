import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import express from 'express';
import http from 'http';
import { createInstancePoseRouter } from '../../src/routes/instance-pose.ts';
import { createApplyFeatureRouter } from '../../src/routes/apply-feature.ts';
import { FeatureEditDispatcher } from '../../src/edit-dispatch.ts';

// The gizmo commit endpoint: validation, the preflight refusing bad pose
// specs before the editor is touched, and the ack round-trip settling the
// response with the transform's true outcome.
let server: http.Server;
let baseUrl: string;

let relayed: any[];
let delivered: boolean;
let currentCode: string;
let currentFileName: string;

const ASSEMBLY_CODE = [
  `import { insert } from 'fluidcad/core';`,
  `import { housing } from './housing.part.js';`,
  ``,
  `const h = insert(housing());`,
  ``,
].join('\n');

const fakeServer = {
  getCurrentCode: () => currentCode,
  getCurrentFileName: () => currentFileName,
  getParamDefinitions: () => [],
};

async function postPose(body: unknown): Promise<{ status: number; body: any }> {
  const res = await fetch(`${baseUrl}/api/instance-pose`, {
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

const GOOD_BODY = {
  filePath: '/ws/m.assembly.js',
  sourceLine: 4,
  position: [1, 2, 3],
  rotateXYZ: [0, 0, 90],
};

describe('instance-pose route', () => {
  beforeAll(async () => {
    const sendFn = (msg: any) => {
      relayed.push(msg);
      return delivered;
    };
    const dispatcher = new FeatureEditDispatcher(fakeServer as any, sendFn, { ackTimeoutMs: 300 });

    const app = express();
    app.use(express.json());
    app.use('/api', createInstancePoseRouter(fakeServer as any, dispatcher));
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
  });

  it('rejects a malformed body', async () => {
    const { status } = await postPose({ filePath: '/ws/m.assembly.js', sourceLine: 4 });
    expect(status).toBe(400);
  });

  it('refuses when the current file is not an assembly', async () => {
    currentFileName = '/ws/m.fluid.js';
    const { status, body } = await postPose({ ...GOOD_BODY, filePath: '/ws/m.fluid.js' });
    expect(status).toBe(422);
    expect(body.reason).toContain('assembly');
    expect(relayed).toEqual([]);
  });

  it("refuses another file's instance (sub-assembly insert)", async () => {
    const { status, body } = await postPose({ ...GOOD_BODY, filePath: '/ws/sub.assembly.js' });
    expect(status).toBe(422);
    expect(body.reason).toContain('sub.assembly.js');
    expect(relayed).toEqual([]);
  });

  it('preflight refuses an opaque-rotation commit before any dispatch', async () => {
    currentCode = ASSEMBLY_CODE.replace(
      'const h = insert(housing());',
      'const h = insert(housing()).rotate(myAxis, 45);',
    );
    const { status, body } = await postPose(GOOD_BODY);
    expect(status).toBe(422);
    expect(body.success).toBe(false);
    expect(body.reason).toContain(`isn't a plain ('x'|'y'|'z', angle) rotation`);
    expect(relayed).toEqual([]);
  });

  it('answers success once the editor round-trip confirms the rewrite', async () => {
    const applied = postPose(GOOD_BODY);
    const msg = await untilRelayed();
    expect(msg.type).toBe('apply-feature-edit');
    expect(typeof msg.spec.editId).toBe('string');
    expect(msg.spec.instancePose).toMatchObject({ sourceLine: 4 });

    const roundTrip = await postRoundTrip(ASSEMBLY_CODE, msg.spec);
    expect(roundTrip.body.error).toBeUndefined();
    expect(roundTrip.body.newCode).toContain(
      `const h = insert(housing()).rotate('z', 90).translate(1, 2, 3);`,
    );

    const { status, body } = await applied;
    expect(status).toBe(200);
    expect(body).toMatchObject({ success: true });
  });

  it('reports a timeout when the editor never round-trips', async () => {
    const { status, body } = await postPose(GOOD_BODY);
    expect(status).toBe(504);
    expect(body.success).toBe(false);
    expect(body.reason).toContain('did not apply the edit');
  });

  it('keeps the legacy immediate success when no host process is attached', async () => {
    delivered = false;
    const { status, body } = await postPose(GOOD_BODY);
    expect(status).toBe(200);
    expect(body).toMatchObject({ success: true });
  });

  it('rejects malformed translate expressions before any dispatch', async () => {
    const unsafe = await postPose({ ...GOOD_BODY, translateExprs: ['a; b', null, null] });
    expect(unsafe.status).toBe(400);
    const shortArr = await postPose({ ...GOOD_BODY, translateExprs: ['a'] });
    expect(shortArr.status).toBe(400);
    expect(relayed).toEqual([]);
  });

  it('rejects malformed rotate expressions before any dispatch', async () => {
    const { status } = await postPose({ ...GOOD_BODY, rotateExprs: ['a, b', null, null] });
    expect(status).toBe(400);
    expect(relayed).toEqual([]);
  });

  it('rejects malformed newVariables', async () => {
    const { status } = await postPose({ ...GOOD_BODY, newVariables: [{ name: 42 }] });
    expect(status).toBe(400);
    expect(relayed).toEqual([]);
  });

  it('round-trips a typed axis expression, declaring its variable before the insert', async () => {
    const applied = postPose({
      ...GOOD_BODY,
      rotateXYZ: null,
      position: [120, 2, 3],
      translateExprs: ['myVar', null, null],
      newVariables: [{ name: 'myVar', initializer: '120' }],
    });
    const msg = await untilRelayed();
    expect(msg.spec.instancePose.translateExprs).toEqual(['myVar', null, null]);
    expect(msg.spec.newVariables).toEqual([{ name: 'myVar', initializer: '120' }]);

    const roundTrip = await postRoundTrip(ASSEMBLY_CODE, msg.spec);
    expect(roundTrip.body.error).toBeUndefined();
    expect(roundTrip.body.newCode).toContain(
      `const myVar = 120;\nconst h = insert(housing()).translate(myVar, 2, 3);`,
    );

    const { status, body } = await applied;
    expect(status).toBe(200);
    expect(body).toMatchObject({ success: true });
  });

  it('lands a param() declaration after the imports with its import ensured', async () => {
    const applied = postPose({
      ...GOOD_BODY,
      rotateXYZ: null,
      position: [120, 2, 3],
      translateExprs: ['spacing', null, null],
      newVariables: [{ name: 'spacing', initializer: 'param("spacing", 120)' }],
    });
    const msg = await untilRelayed();
    const roundTrip = await postRoundTrip(ASSEMBLY_CODE, msg.spec);
    expect(roundTrip.body.error).toBeUndefined();
    expect(roundTrip.body.newCode).toMatch(/import \{[^}]*\bparam\b[^}]*\} from 'fluidcad\/core'/);
    expect(roundTrip.body.newCode).toContain('const spacing = param("spacing", 120);');
    expect(roundTrip.body.newCode.indexOf('const spacing'))
      .toBeLessThan(roundTrip.body.newCode.indexOf('const h = insert'));
    await applied;
  });

  it('round-trips a typed ring expression, declaring its variable', async () => {
    const applied = postPose({
      ...GOOD_BODY,
      rotateXYZ: [0, 0, 60],
      position: [1, 2, 3],
      rotateExprs: [null, null, 'spin'],
      newVariables: [{ name: 'spin', initializer: '60' }],
    });
    const msg = await untilRelayed();
    expect(msg.spec.instancePose.rotateExprs).toEqual([null, null, 'spin']);

    const roundTrip = await postRoundTrip(ASSEMBLY_CODE, msg.spec);
    expect(roundTrip.body.error).toBeUndefined();
    expect(roundTrip.body.newCode).toContain(
      `const spin = 60;\nconst h = insert(housing()).rotate('z', spin).translate(1, 2, 3);`,
    );

    const { status, body } = await applied;
    expect(status).toBe(200);
    expect(body).toMatchObject({ success: true });
  });

  describe('instance-pose-expressions read', () => {
    async function postRead(body: unknown): Promise<{ status: number; body: any }> {
      const res = await fetch(`${baseUrl}/api/instance-pose-expressions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      return { status: res.status, body: await res.json() };
    }

    const READ_BODY = { filePath: '/ws/m.assembly.js', sourceLine: 4 };

    it('reads the exact translate argument and rotate angle texts', async () => {
      currentCode = ASSEMBLY_CODE.replace(
        'const h = insert(housing());',
        `const h = insert(housing()).rotate('x', tilt).rotate('z', 45).translate(w + 10, gap, 5);`,
      );
      const { status, body } = await postRead(READ_BODY);
      expect(status).toBe(200);
      expect(body.expressions).toEqual({
        translate: { x: 'w + 10', y: 'gap', z: '5' },
        rotate: { x: 'tilt', y: null, z: '45' },
      });
    });

    it('reads a bare chain as identity rotate texts and no translate block', async () => {
      const { body } = await postRead(READ_BODY);
      expect(body.expressions).toEqual({
        translate: null,
        rotate: { x: null, y: null, z: null },
      });
    });

    it('nulls the translate block when a rotate follows the translate', async () => {
      currentCode = ASSEMBLY_CODE.replace(
        'const h = insert(housing());',
        `const h = insert(housing()).translate(1, 2, 3).rotate('z', 45);`,
      );
      const { body } = await postRead(READ_BODY);
      expect(body.expressions.translate).toBeNull();
      expect(body.expressions.rotate).toEqual({ x: null, y: null, z: '45' });
    });

    it('nulls the rotate block for a non-canonical rotate order', async () => {
      currentCode = ASSEMBLY_CODE.replace(
        'const h = insert(housing());',
        `const h = insert(housing()).rotate('z', 45).rotate('x', 30);`,
      );
      const { body } = await postRead(READ_BODY);
      expect(body.expressions.rotate).toBeNull();
    });

    it("answers null for another file's instance", async () => {
      const { body } = await postRead({ ...READ_BODY, filePath: '/ws/sub.assembly.js' });
      expect(body.expressions).toBeNull();
    });

    it('rejects a malformed body', async () => {
      const { status } = await postRead({ filePath: '/ws/m.assembly.js' });
      expect(status).toBe(400);
    });
  });
});
