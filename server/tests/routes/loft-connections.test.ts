import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import express from 'express';
import http from 'http';
import { createApplyFeatureRouter } from '../../src/routes/apply-feature.ts';
import { applyFeatureEdit } from '../../src/apply-feature-edit.ts';
import { setupOC, render } from '../../../lib/tests/setup.js';
import sketch from '../../../lib/core/sketch.js';
import plane from '../../../lib/core/plane.js';
import loft from '../../../lib/core/loft.js';
import part from '../../../lib/core/part.js';
import { line } from '../../../lib/core/2d/index.js';
import { SceneObject } from '../../../lib/common/scene-object.js';
import { Sketch } from '../../../lib/features/2d/sketch.js';
import { Scene } from '../../../lib/rendering/scene.js';
import { SelectionResolver } from '../../../lib/selection/resolve-selection.js';
import { getSceneManager } from '../../../lib/scene-manager.js';

const FILE = '/ws/model.fluid.js';
const CODE = `const a = sketch('xy', () => {
  line([0, 0], [20, 0]);
  line([20, 0], [20, 20]);
  line([20, 20], [0, 20]);
  line([0, 20], [0, 0]);
});
const b = sketch(plane('xy', { offset: 40 }), () => {
  line([0, 0], [20, 0]);
  line([20, 0], [20, 20]);
  line([20, 20], [0, 20]);
  line([0, 20], [0, 0]);
});`;

describe('loft connections HTTP authoring', () => {
  setupOC();
  let server: http.Server;
  let url: string;
  let scene: Scene;
  let code: string;
  let profiles: { a: Sketch; b: Sketch };
  let sent: any[];
  let lastBefore: number | undefined;
  const engine = {
    getCurrentCode: () => code,
    getCurrentFileName: () => FILE,
    getParamDefinitions: () => [],
    resolveStatementPart: () => null,
    resolveSelection: (request: any, options: any) => {
      lastBefore = request.before;
      return SelectionResolver.resolve(scene, request, options);
    },
  };
  beforeAll(async () => {
    const app = express();
    app.use(express.json());
    app.use('/api', createApplyFeatureRouter(engine as never, message => { sent.push(message); }));
    server = http.createServer(app);
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address() as { port: number };
    url = `http://127.0.0.1:${address.port}/api/apply-feature`;
  });
  afterAll(async () => {
    await new Promise<void>(resolve => server.close(() => resolve()));
  });
  beforeEach(() => {
    code = CODE;
    sent = [];
    lastBefore = undefined;
    profiles = new Function('sketch', 'plane', 'line', `${code}\nreturn { a, b };`)(sketch, plane, line);
    for (const [i, profile] of Object.values(profiles).entries()) {
      profile.setSourceLocation({ filePath: FILE, line: 1 + i * 6, column: 0 });
      profile.getChildren().filter(child => child.getType() === 'line').forEach((child, index) => {
        child.setSourceLocation({ filePath: FILE, line: 2 + i * 6 + index, column: 0 });
      });
    }
    scene = render();
  });
  const profile = (line: number) => ({ kind: 'sketch', filePath: FILE, line, column: 0 });
  function point(s: Sketch, index = 0) {
    const shape = s.getChildren().find(child => child.getType() === 'line')!.getAddedShapes()[0];
    return { kind: 'vertex', entity: { shapeId: shape.id, sub: { type: 'vertex', index } } };
  }
  function request() {
    return { feature: 'loft', op: 'add', thin: null, profiles: [profile(1), profile(7)], guides: [],
      startCondition: null, endCondition: null,
      connections: [{ kind: 'points', points: [point(profiles.a), point(profiles.b)] }] };
  }
  async function post(body: unknown) {
    const response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json() as any };
  }

  it('previews exact export names without writing, then dispatches one atomic edit that builds', async () => {
    const preview = await post({ ...request(), preview: true });
    expect(preview.status, JSON.stringify(preview.body)).toBe(200);
    expect(preview.body.preview).toBe('loft(a, b).connect(a.geometries.l1.start(), b.geometries.l2.start())');
    expect(sent).toHaveLength(0);
    expect(code).toBe(CODE);
    const result = await post(request());
    expect(result.status, JSON.stringify(result.body)).toBe(200);
    expect(sent).toHaveLength(1);
    const applied = await applyFeatureEdit(code, sent[0].spec);
    expect(applied.error).toBeUndefined();
    expect(applied.newCode).toContain(preview.body.preview);
    getSceneManager().startScene();
    new Function('sketch', 'plane', 'line', 'loft', applied.newCode.replace(/^import[^\n]*\n/gm, ''))(sketch, plane, line, loft);
    const built = render();
    expect(built.getRenderedObjects().filter(object => object.hasError)).toHaveLength(0);
    expect(built.getAllSceneObjects().find(object => object.getType() === 'loft')!.getShapes()).toHaveLength(1);
  });

  it('refuses a row whose points are not in profile order, before anything is written', async () => {
    const swapped = { ...request(), connections: [{ kind: 'points', points: [point(profiles.b), point(profiles.a)] }] };
    const result = await post(swapped);
    expect(result.status).toBe(422);
    expect(result.body.reason).toMatch(/connection 1: point 1 is not a vertex of profile 1/);
    expect(sent).toHaveLength(0);
    expect(code).toBe(CODE);
  });

  it('caps the number of connection rows', async () => {
    const row = { kind: 'points', points: [point(profiles.a), point(profiles.b)] };
    const result = await post({ ...request(), connections: Array.from({ length: 65 }, () => row) });
    expect(result.status).toBeGreaterThanOrEqual(400);
    expect(result.body.reason ?? result.body.error).toMatch(/at most 64 connections/);
    expect(sent).toHaveLength(0);
  });

  it('uses the edit boundary and keeps one connection while repicking another', async () => {
    const lf = loft(profiles.a as never, profiles.b as never).connect([0, 0, 0], [0, 0, 40]) as unknown as SceneObject;
    lf.setSourceLocation({ filePath: FILE, line: 13, column: 0 });
    scene = render();
    const original = 'loft(a, b).connect( [0, 0, 0], /* original */ [0, 0, 40] )';
    code += `\n${original};`;
    const index = scene.getAllSceneObjects().indexOf(lf);
    const body = request();
    const result = await post({ ...body, profiles: undefined,
      edit: { filePath: FILE, line: 13, column: 0 }, expectedStatement: original,
      before: { index, type: 'loft', line: 13, column: 0 },
      connections: [{ kind: 'verbatim', sourceIndex: 0 }, { kind: 'points', points: [point(profiles.a, 1), point(profiles.b, 1)] }],
    });
    expect(result.status, JSON.stringify(result.body)).toBe(200);
    expect(lastBefore).toBe(index);
    expect(result.body.preview).toContain(original);
    expect(result.body.preview).toContain('.connect(a.geometries.l1.end(), b.geometries.l2.end())');
    const applied = await applyFeatureEdit(code, sent[0].spec);
    expect(applied.error).toBeUndefined();
    expect(applied.newCode).toContain(result.body.preview);
  });

  it.each(['arity', 'edge', 'index'] as const)('rejects invalid %s connection requests without dispatch', async invalid => {
    const body = request();
    if (invalid === 'arity') {
      body.connections[0].points.pop();
    } else if (invalid === 'edge') {
      body.connections[0].points[0].entity.sub.type = 'edge';
    } else {
      body.connections[0].points[0].entity.sub.index = -1;
    }
    const result = await post(body);
    expect(result.status).toBe(400);
    expect(sent).toHaveLength(0);
  });

  it('composes connections with thin walls in one dispatched statement', async () => {
    const result = await post({ ...request(), thin: [1] });
    expect(result.status, JSON.stringify(result.body)).toBe(200);
    expect(sent).toHaveLength(1);
    const applied = await applyFeatureEdit(code, sent[0].spec);
    expect(applied.error).toBeUndefined();
    expect(applied.newCode).toContain('.thin(1)');
    expect(applied.newCode).toContain('.connect(a.geometries.l1.start(), b.geometries.l2.start())');
  });

  it('rejects unknown vertices and non-object export returns before dispatch', async () => {
    const body = request();
    body.connections[0].points[0].entity.shapeId = 'missing';
    expect((await post(body)).status).toBe(422);
    code = CODE.replace('\n});', '\n  return unknown;\n});');
    const result = await post({ ...request(), preview: true });
    expect(result.status).toBe(422);
    expect(result.body.reason).toMatch(/return|source|callback/);
    expect(sent).toHaveLength(0);
  });

  it('refuses points from another part even when all the new points share that part', async () => {
    let other: Sketch;
    part('other', () => {
      other = sketch('xy', () => {
        const l = line([100, 0], [120, 0]) as unknown as SceneObject;
        l.setSourceLocation({ filePath: FILE, line: 31, column: 0 });
      }) as unknown as Sketch;
      other.setSourceLocation({ filePath: FILE, line: 30, column: 0 });
    });
    scene = render();
    const result = await post({ ...request(), connections: [{ kind: 'points', points: [point(other!), point(other!, 1)] }] });
    expect(result.status).toBe(422);
    expect(result.body.reason).toContain('scope');
    expect(sent).toHaveLength(0);
  });
});
