import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import http from 'http';
import { FluidCadServer } from '../../src/fluidcad-server.ts';
import { createResolveSelectionRouter } from '../../src/routes/resolve-selection.ts';
import { createMeasureRouter } from '../../src/routes/measure.ts';

let server: http.Server;
let baseUrl: string;
let lastMeasureRefs: unknown[] = [];
let lastResolveRequest: unknown = null;

const TOP_FACE = {
  shapeId: 'sh-1', kind: 'face', index: 5, sceneObjectId: 'obj-2', sceneObjectName: 'extrude', part: 'base',
  summary: { form: 'plane', center: [20, 20, 10], normal: [0, 0, 1], area: 1600 },
};
const SIDE_FACES = [0, 1].map(index => ({
  shapeId: 'sh-1', kind: 'face', index, sceneObjectId: 'obj-2', sceneObjectName: 'extrude', part: 'base',
  summary: { form: 'plane', center: [0, 20, 5], normal: [-1, 0, 0], area: 400 },
}));

/**
 * The engine is stubbed with a resolver keyed on the expression: the routes'
 * validation, status mapping and the measure merge are under test, not the
 * kernel (lib/tests/selection/resolve-selection.test.ts covers that).
 */
function stubEngine(): FluidCadServer {
  const engine = new FluidCadServer();
  engine._setSceneForTesting('/ws/two-parts.part.js', { unit: 'mm' });
  engine.setSceneManager({
    getSceneUnit: () => 'mm',
    measure: (_scene: unknown, refs: unknown[]) => {
      lastMeasureRefs = refs;
      return {
        entities: refs.map(ref => ({ ref, geomType: 'plane', area: 1600, summary: TOP_FACE.summary })),
        primary: 'totalArea',
        primaryLabel: 'Area',
        totalArea: 1600,
      };
    },
    resolveSelection: (_scene: unknown, request: { expression: string; scope?: Record<string, string> }) => {
      lastResolveRequest = request;
      if (request.scope && 'part' in request.scope && request.scope.part === 'nope') {
        return { ok: false, code: 'unknown-scope', reason: 'No part "nope" in the scene (pass a part name or a part\'s scene object id).' };
      }
      if (request.scope && 'part' in request.scope && request.scope.part === 'twin') {
        return { ok: false, code: 'ambiguous-scope', reason: 'Part "twin" names 2 variants in the scene', candidates: ['obj-7', 'obj-9'] };
      }
      if (request.expression.includes('onPlan(')) {
        return { ok: false, code: 'evaluation-error', reason: 'face(...).onPlan is not a function' };
      }
      const scope = request.scope ? { kind: 'part', partId: 'obj-1', part: 'base' } : { kind: 'root' };
      if (request.expression.includes('"xy", 10')) {
        return { ok: true, matches: [TOP_FACE], count: 1, scope, unit: 'mm' };
      }
      if (request.expression.includes('parallelTo')) {
        return { ok: true, matches: SIDE_FACES, count: 2, scope, unit: 'mm' };
      }
      return { ok: true, matches: [], count: 0, scope, unit: 'mm' };
    },
  } as any);
  return engine;
}

async function post(path: string, body: unknown): Promise<{ status: number; body: any }> {
  const res = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

describe('POST /api/resolve-selection', () => {
  beforeAll(async () => {
    const app = express();
    app.use(express.json());
    const engine = stubEngine();
    app.use('/api', createResolveSelectionRouter(engine));
    app.use('/api', createMeasureRouter(engine));
    server = http.createServer(app);
    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', () => resolve());
    });
    const addr = server.address();
    const port = typeof addr === 'object' && addr ? addr.port : 0;
    baseUrl = `http://127.0.0.1:${port}`;
  });

  afterAll(async () => {
    if (server) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('returns the matches, count, resolved scope and unit', async () => {
    const { status, body } = await post('/api/resolve-selection', { expression: 'face().onPlane("xy", 10)', scope: { part: 'base' } });
    expect(status).toBe(200);
    expect(body.count).toBe(1);
    expect(body.matches[0]).toEqual(TOP_FACE);
    expect(body.scope).toEqual({ kind: 'part', partId: 'obj-1', part: 'base' });
    expect(body.unit).toBe('mm');
    expect(lastResolveRequest).toEqual({ expression: 'face().onPlane("xy", 10)', scope: { part: 'base' } });
  });

  it('zero matches is a 200 with count 0', async () => {
    const { status, body } = await post('/api/resolve-selection', { expression: 'edge().circle(5)' });
    expect(status).toBe(200);
    expect(body).toMatchObject({ count: 0, matches: [], scope: { kind: 'root' } });
  });

  it('validates the expression and the scope shape', async () => {
    expect((await post('/api/resolve-selection', {})).status).toBe(400);
    expect((await post('/api/resolve-selection', { expression: '   ' })).status).toBe(400);
    const badScope = await post('/api/resolve-selection', { expression: 'face()', scope: { part: 'a', instanceId: 'b' } });
    expect(badScope.status).toBe(400);
    expect(badScope.body.error).toContain('exactly one of');
    const emptyScope = await post('/api/resolve-selection', { expression: 'face()', scope: { sceneObjectId: '' } });
    expect(emptyScope.status).toBe(400);
    expect(emptyScope.body.error).toContain('sceneObjectId');
    const unknownKey = await post('/api/resolve-selection', { expression: 'face()', scope: { partName: 'base' } });
    expect(unknownKey.status).toBe(400);
  });

  it('refuses an unknown scope with 404 naming it, and an ambiguous part with 409 and candidates', async () => {
    const unknown = await post('/api/resolve-selection', { expression: 'face()', scope: { part: 'nope' } });
    expect(unknown.status).toBe(404);
    expect(unknown.body.code).toBe('unknown-scope');
    expect(unknown.body.error).toContain('"nope"');

    const ambiguous = await post('/api/resolve-selection', { expression: 'face()', scope: { part: 'twin' } });
    expect(ambiguous.status).toBe(409);
    expect(ambiguous.body.code).toBe('ambiguous-scope');
    expect(ambiguous.body.candidates).toEqual(['obj-7', 'obj-9']);
  });

  it('an expression that fails to evaluate is a 422 naming the problem', async () => {
    const { status, body } = await post('/api/resolve-selection', { expression: 'face().onPlan("xy")' });
    expect(status).toBe(422);
    expect(body.code).toBe('evaluation-error');
    expect(body.error).toContain('onPlan');
  });

  it('is a 404 before any scene is rendered and a 501 on an engine without the resolver', async () => {
    const noScene = new FluidCadServer();
    noScene.setSceneManager({ resolveSelection: () => ({ ok: true }) } as any);
    const noSceneResult = noScene.resolveSelection({ expression: 'face()' });
    expect(noSceneResult).toMatchObject({ ok: false, code: 'no-scene' });

    const legacy = new FluidCadServer();
    legacy._setSceneForTesting('/ws/a.part.js', { unit: 'mm' });
    legacy.setSceneManager({ measure: () => null } as any);
    const legacyResult = legacy.resolveSelection({ expression: 'face()' });
    expect(legacyResult).toMatchObject({ ok: false, code: 'unsupported' });
  });
});

describe('POST /api/measure with filter entities', () => {
  beforeAll(async () => {
    const app = express();
    app.use(express.json());
    const engine = stubEngine();
    app.use('/api', createMeasureRouter(engine));
    server = http.createServer(app);
    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', () => resolve());
    });
    const addr = server.address();
    const port = typeof addr === 'object' && addr ? addr.port : 0;
    baseUrl = `http://127.0.0.1:${port}`;
  });

  afterAll(async () => {
    if (server) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('resolves a single-match filter to its index ref and reports where it came from', async () => {
    const { status, body } = await post('/api/measure', {
      entities: [
        { expression: 'face().onPlane("xy", 10)', scope: { part: 'base' } },
        { shapeId: 'sh-9', kind: 'edge', index: 2 },
      ],
    });
    expect(status).toBe(200);
    expect(lastMeasureRefs).toEqual([
      { shapeId: 'sh-1', kind: 'face', index: 5 },
      { shapeId: 'sh-9', kind: 'edge', index: 2 },
    ]);
    expect(body.entities[0]).toMatchObject({
      ref: { shapeId: 'sh-1', kind: 'face', index: 5 },
      expression: 'face().onPlane("xy", 10)',
      sceneObjectId: 'obj-2',
      part: 'base',
      summary: TOP_FACE.summary,
    });
    expect(body.entities[1].expression).toBeUndefined();
    expect(body.entities[1].summary).toEqual(TOP_FACE.summary);
    expect(body.unit).toBe('mm');
  });

  it('refuses a filter that matches several entities, listing the candidates, and never takes the first', async () => {
    lastMeasureRefs = [];
    const { status, body } = await post('/api/measure', {
      entities: [{ expression: 'face().parallelTo("yz")', scope: { part: 'base' } }],
    });
    expect(status).toBe(409);
    expect(body.code).toBe('ambiguous-match');
    expect(body.error).toContain('entities[0]');
    expect(body.error).toContain('matches 2 entities');
    expect(body.candidates).toEqual(SIDE_FACES);
    expect(lastMeasureRefs).toEqual([]);
  });

  it('refuses a filter that matches nothing, naming the expression and scope', async () => {
    const { status, body } = await post('/api/measure', {
      entities: [{ expression: 'edge().circle(5)', scope: { part: 'base' } }],
    });
    expect(status).toBe(404);
    expect(body.code).toBe('no-match');
    expect(body.error).toContain('edge().circle(5)');
    expect(body.error).toContain('in part "base"');
  });

  it('propagates resolver refusals with their status', async () => {
    const unknown = await post('/api/measure', { entities: [{ expression: 'face()', scope: { part: 'nope' } }] });
    expect(unknown.status).toBe(404);
    expect(unknown.body.error).toContain('entities[0]');
    const broken = await post('/api/measure', { entities: [{ expression: 'face().onPlan("xy")' }] });
    expect(broken.status).toBe(422);
    expect(broken.body.code).toBe('evaluation-error');
  });

  it('validates filter entities before resolving', async () => {
    const empty = await post('/api/measure', { entities: [{ expression: '' }] });
    expect(empty.status).toBe(400);
    expect(empty.body.error).toContain('entities[0].expression');
    const badScope = await post('/api/measure', { entities: [{ expression: 'face()', scope: 'base' }] });
    expect(badScope.status).toBe(400);
    expect(badScope.body.error).toContain('entities[0].scope');
  });
});
