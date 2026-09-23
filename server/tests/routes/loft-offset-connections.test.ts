// Stage 8: a loft connection picked on an offset() vertex authors the
// index-based `o.edge(i)` reference through the same sketch-export rail as
// named entities — hoisting the offset statement, exporting it, executing.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import express from 'express';
import http from 'http';
import { createApplyFeatureRouter } from '../../src/routes/apply-feature.ts';
import { applyFeatureEdit } from '../../src/apply-feature-edit/index.ts';
import { setupOC, render } from '../../../lib/tests/setup.js';
import sketch from '../../../lib/core/sketch.js';
import plane from '../../../lib/core/plane.js';
import loft from '../../../lib/core/loft.js';
import { line, offset } from '../../../lib/core/2d/index.js';
import { SceneObject } from '../../../lib/common/scene-object.js';
import { Shape } from '../../../lib/common/shape.js';
import { Sketch } from '../../../lib/features/2d/sketch.js';
import { Scene } from '../../../lib/rendering/scene.js';
import { SelectionResolver } from '../../../lib/selection/resolve-selection.js';
import { topologyVertices } from '../../../lib/selection/vertex-pick.js';
import { getSceneManager } from '../../../lib/scene-manager.js';

const FILE = '/ws/model.fluid.js';
const CODE = `const a = sketch('xy', () => {
  const b = line([0, 0], [20, 0]).guide();
  const r = line([20, 0], [20, 20]).guide();
  const t = line([20, 20], [0, 20]).guide();
  const l = line([0, 20], [0, 0]).guide();
  offset(-3, b, r, t, l);
});
const b = sketch(plane('xy', { offset: 40 }), () => {
  line([0, 0], [20, 0]);
  line([20, 0], [20, 20]);
  line([20, 20], [0, 20]);
  line([0, 20], [0, 0]);
});`;

describe('loft connections on offset vertices', () => {
  setupOC();
  let server: http.Server;
  let url: string;
  let scene: Scene;
  let code: string;
  let profiles: { a: Sketch; b: Sketch };
  let sent: any[];
  const engine = {
    getCurrentCode: () => code,
    getCurrentFileName: () => FILE,
    getParamDefinitions: () => [],
    resolveStatementPart: () => null,
    resolveSelection: (request: any, options: any) => SelectionResolver.resolve(scene, request, options),
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
    profiles = new Function('sketch', 'plane', 'line', 'offset', `${code}\nreturn { a, b };`)(sketch, plane, line, offset);
    profiles.a.setSourceLocation({ filePath: FILE, line: 1, column: 0 });
    profiles.a.getChildren().forEach((child, index) => {
      child.setSourceLocation({ filePath: FILE, line: 2 + index, column: 0 });
    });
    profiles.b.setSourceLocation({ filePath: FILE, line: 8, column: 0 });
    profiles.b.getChildren().filter(child => child.getType() === 'line').forEach((child, index) => {
      child.setSourceLocation({ filePath: FILE, line: 9 + index, column: 0 });
    });
    scene = render();
  });
  const profile = (line: number) => ({ kind: 'sketch', filePath: FILE, line, column: 0 });
  function vertexAt(shape: Shape, at: [number, number, number]) {
    const points = topologyVertices(shape);
    for (let i = 0; i < points.length; i += 3) {
      if (Math.hypot(points[i] - at[0], points[i + 1] - at[1], points[i + 2] - at[2]) < 1e-6) {
        return { kind: 'vertex', entity: { shapeId: shape.id, sub: { type: 'vertex', index: i / 3 } } };
      }
    }
    throw new Error(`no vertex at ${at}`);
  }
  async function post(body: unknown) {
    const response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json() as any };
  }

  it('authors o.edge(i) references, hoists and exports the offset, and the result builds', async () => {
    const offsetEdges = profiles.a.getChildren().find(child => child.getType() === 'offset')!.getAddedShapes();
    const bottom = profiles.b.getChildren().find(child => child.getType() === 'line')!.getAddedShapes()[0];
    const request = { feature: 'loft', op: 'add', thin: null, profiles: [profile(1), profile(8)], guides: [],
      startCondition: null, endCondition: null,
      connections: [{ kind: 'points', points: [vertexAt(offsetEdges[1], [17, 3, 0]), vertexAt(bottom, [20, 0, 40])] }] };
    const preview = await post({ ...request, preview: true });
    expect(preview.status, JSON.stringify(preview.body)).toBe(200);
    expect(preview.body.preview).toBe('loft(a, b).connect(a.geometries.o1.edge(0).end(), b.geometries.l1.end())');
    expect(sent).toHaveLength(0);

    const result = await post(request);
    expect(result.status, JSON.stringify(result.body)).toBe(200);
    const applied = await applyFeatureEdit(code, sent[0].spec);
    expect(applied.error).toBeUndefined();
    expect(applied.newCode).toContain('const o1 = offset(-3, b, r, t, l);');
    expect(applied.newCode).toContain('return { o1 };');
    expect(applied.newCode).toContain(preview.body.preview);

    getSceneManager().startScene();
    new Function('sketch', 'plane', 'line', 'offset', 'loft', applied.newCode.replace(/^import[^\n]*\n/gm, ''))(sketch, plane, line, offset, loft);
    const built = render();
    expect(built.getRenderedObjects().filter(object => object.hasError).map(object => object.errorMessage)).toEqual([]);
    const result3d = built.getAllSceneObjects().find(object => object.getType() === 'loft') as SceneObject;
    expect(result3d.getShapes()).toHaveLength(1);
  });
});
