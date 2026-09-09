import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import http from 'http';
import { FluidCadServer } from '../../src/fluidcad-server.ts';
import { createValidateRouter, ValidateRequests } from '../../src/routes/validate.ts';

let server: http.Server;
let baseUrl: string;
let lastRequest: unknown = null;

const CLEAN_SHAPE = {
  shapeId: 'sh-1', sceneObjectId: 'obj-2', sceneObjectName: 'extrude', part: 'base',
  faces: 6, edges: 12, solids: 1, volume: 16000, findings: [],
};
const INVERTED_FINDING = {
  kind: 'nonPositiveVolume', shapeId: 'sh-2', sceneObjectId: 'obj-4', part: 'pillar',
  message: 'the solid has volume -3000: reversed orientation (inside-out); BRepCheck_Analyzer does not catch this',
};

/**
 * The engine is stubbed with a validator keyed on the request: the route's
 * body validation and status mapping are under test, not the kernel
 * (lib/tests/validation/scene-validator.test.ts covers that).
 */
function stubEngine(opts: { validator?: boolean } = {}): FluidCadServer {
  const engine = new FluidCadServer();
  engine._setSceneForTesting('/ws/two-parts.part.js', { unit: 'mm' });
  const manager: Record<string, unknown> = { getSceneUnit: () => 'mm' };
  if (opts.validator !== false) {
    manager.validate = (_scene: unknown, request: { shapeIds?: string[]; instanceId?: string }) => {
      lastRequest = request;
      if (request.instanceId === 'nope') {
        return { kind: 'refused', code: 'unknown-instance', reason: 'No instance "nope" in the assembly (instance ids come from get_scene_summary).' };
      }
      if (request.instanceId !== undefined) {
        return { kind: 'refused', code: 'not-an-assembly', reason: 'instanceId "inst-1" needs an assembly file; this scene is a part.' };
      }
      if (request.shapeIds?.includes('missing')) {
        return { kind: 'refused', code: 'unknown-shape', reason: 'No rendered shape "missing" in the scene (shape ids come from list_shapes or get_scene_summary).' };
      }
      const broken = !request.shapeIds || request.shapeIds.includes('sh-2');
      return {
        kind: 'report',
        report: {
          ok: !broken,
          checked: broken ? 2 : 1,
          findings: broken ? [INVERTED_FINDING] : [],
          shapes: broken ? [CLEAN_SHAPE, { ...CLEAN_SHAPE, shapeId: 'sh-2', sceneObjectId: 'obj-4', part: 'pillar', volume: -3000, findings: ['nonPositiveVolume'] }] : [CLEAN_SHAPE],
          skipped: [],
          checks: ['invalidTopology', 'openShell', 'nonPositiveVolume', 'noSolid'],
          notChecked: { selfIntersecting: 'not checked: this ocjs build exposes neither BRepAlgoAPI_Check nor BOPAlgo_ArgumentAnalyzer' },
          unit: 'mm',
        },
      };
    };
  }
  engine.setSceneManager(manager as any);
  return engine;
}

async function post(url: string, body: unknown): Promise<{ status: number; body: any }> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

async function listen(app: express.Express): Promise<{ server: http.Server; url: string }> {
  const created = http.createServer(app);
  await new Promise<void>((resolve) => {
    created.listen(0, '127.0.0.1', () => resolve());
  });
  const addr = created.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  return { server: created, url: `http://127.0.0.1:${port}` };
}

describe('POST /api/validate', () => {
  beforeAll(async () => {
    const app = express();
    app.use(express.json());
    app.use('/api', createValidateRouter(stubEngine()));
    const listening = await listen(app);
    server = listening.server;
    baseUrl = listening.url;
  });

  afterAll(async () => {
    if (server) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('findings are a 200 with ok false, every shape listed, and the checks that ran', async () => {
    const { status, body } = await post(`${baseUrl}/api/validate`, {});
    expect(status).toBe(200);
    expect(body.ok).toBe(false);
    expect(body.checked).toBe(2);
    expect(body.findings).toEqual([INVERTED_FINDING]);
    expect(body.shapes).toHaveLength(2);
    expect(body.checks).toContain('nonPositiveVolume');
    expect(body.notChecked.selfIntersecting).toContain('not checked');
    expect(body.unit).toBe('mm');
    expect(lastRequest).toEqual({});
  });

  it('a clean scope is ok true with no findings, and the request passes through', async () => {
    const { status, body } = await post(`${baseUrl}/api/validate`, { shapeIds: ['sh-1'] });
    expect(status).toBe(200);
    expect(body).toMatchObject({ ok: true, checked: 1, findings: [], shapes: [CLEAN_SHAPE] });
    expect(lastRequest).toEqual({ shapeIds: ['sh-1'] });
  });

  it('an empty body and no body both mean the whole scene', async () => {
    const res = await fetch(`${baseUrl}/api/validate`, { method: 'POST' });
    expect(res.status).toBe(200);
    expect(lastRequest).toEqual({});
  });

  it('validates shapeIds and instanceId before reaching the engine', async () => {
    lastRequest = null;
    expect((await post(`${baseUrl}/api/validate`, { shapeIds: [] })).status).toBe(400);
    expect((await post(`${baseUrl}/api/validate`, { shapeIds: 'sh-1' })).status).toBe(400);
    const emptyEntry = await post(`${baseUrl}/api/validate`, { shapeIds: ['sh-1', ''] });
    expect(emptyEntry.status).toBe(400);
    expect(emptyEntry.body.error).toContain('non-empty');
    const badInstance = await post(`${baseUrl}/api/validate`, { instanceId: 7 });
    expect(badInstance.status).toBe(400);
    expect(badInstance.body.error).toContain('instanceId');
    expect(lastRequest).toBeNull();
  });

  it('an unknown shape, an unknown instance and a part file scoped by instance are 404s naming the problem', async () => {
    const shape = await post(`${baseUrl}/api/validate`, { shapeIds: ['sh-1', 'missing'] });
    expect(shape.status).toBe(404);
    expect(shape.body).toMatchObject({ code: 'unknown-shape' });
    expect(shape.body.error).toContain('"missing"');

    const instance = await post(`${baseUrl}/api/validate`, { instanceId: 'nope' });
    expect(instance.status).toBe(404);
    expect(instance.body).toMatchObject({ code: 'unknown-instance' });

    const partFile = await post(`${baseUrl}/api/validate`, { instanceId: 'inst-1' });
    expect(partFile.status).toBe(404);
    expect(partFile.body).toMatchObject({ code: 'not-an-assembly' });
  });
});

describe('POST /api/validate — engine availability', () => {
  it('no rendered scene is a 404', async () => {
    const engine = new FluidCadServer();
    engine.setSceneManager({ getSceneUnit: () => 'mm', validate: () => ({ kind: 'report', report: {} }) } as any);
    const app = express();
    app.use(express.json());
    app.use('/api', createValidateRouter(engine));
    const listening = await listen(app);
    try {
      const { status, body } = await post(`${listening.url}/api/validate`, {});
      expect(status).toBe(404);
      expect(body.code).toBe('no-scene');
    } finally {
      await new Promise<void>((resolve) => listening.server.close(() => resolve()));
    }
  });

  it('an engine that predates the validator is a 501', async () => {
    const app = express();
    app.use(express.json());
    app.use('/api', createValidateRouter(stubEngine({ validator: false })));
    const listening = await listen(app);
    try {
      const { status, body } = await post(`${listening.url}/api/validate`, {});
      expect(status).toBe(501);
      expect(body.code).toBe('unsupported');
      expect(body.error).toContain('predates');
    } finally {
      await new Promise<void>((resolve) => listening.server.close(() => resolve()));
    }
  });
});

describe('ValidateRequests', () => {
  it('maps refusal codes to statuses', () => {
    expect(ValidateRequests.statusFor('no-scene')).toBe(404);
    expect(ValidateRequests.statusFor('unknown-shape')).toBe(404);
    expect(ValidateRequests.statusFor('unknown-instance')).toBe(404);
    expect(ValidateRequests.statusFor('not-an-assembly')).toBe(404);
    expect(ValidateRequests.statusFor('unsupported')).toBe(501);
    expect(ValidateRequests.statusFor('something-else')).toBe(422);
  });

  it('drops unset fields from the request it builds', () => {
    expect(ValidateRequests.asRequest(undefined)).toEqual({});
    expect(ValidateRequests.asRequest({ shapeIds: ['a'], extra: 1 })).toEqual({ shapeIds: ['a'] });
    expect(ValidateRequests.asRequest({ instanceId: 'i' })).toEqual({ instanceId: 'i' });
  });
});
