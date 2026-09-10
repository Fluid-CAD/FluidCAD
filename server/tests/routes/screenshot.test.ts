import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import express from 'express';
import http from 'http';
import { createScreenshotRouter } from '../../src/routes/screenshot.ts';
import type { ScreenshotSelectionResolver } from '../../src/routes/screenshot-overlays.ts';

let server: http.Server;
let baseUrl: string;
let lastOptions: Record<string, unknown> | null = null;

const PNG = Buffer.from('89504e470d0a1a0a', 'hex');

const TOP_FACE = {
  shapeId: 'sh-1', kind: 'face', index: 5, sceneObjectId: 'obj-2', sceneObjectName: 'extrude', part: 'base',
  summary: { form: 'plane', center: [20, 20, 10], normal: [0, 0, 1], area: 1600 },
};
const SIDE_FACES = [0, 1].map(index => ({
  shapeId: 'sh-1', kind: 'face', index, sceneObjectId: 'obj-2', sceneObjectName: 'extrude', part: 'base',
  summary: { form: 'plane', center: [0, 20, 5], normal: [-1, 0, 0], area: 400 },
}));
const BORE = {
  shapeId: 'sh-9', kind: 'face', index: 2, instanceId: 'inst-1', sceneObjectId: 'obj-4', sceneObjectName: 'hole', part: 'bracket',
  summary: { form: 'cylinder', center: [0, 0, 0], axis: [0, 0, 1], area: 100, diameter: 5 },
};

/** The engine's resolver stubbed on the expression text — the route's validation and resolution to refs are under test. */
const resolveSelection: ScreenshotSelectionResolver = (request) => {
  const scope = request.scope ? { kind: 'part', partId: 'obj-1', part: 'base' } as const : { kind: 'root' } as const;
  if (request.expression.includes('onPlan(')) {
    return { ok: false, code: 'evaluation-error', reason: 'face(...).onPlan is not a function' };
  }
  if (request.expression.includes('"xy", 10')) {
    return { ok: true, matches: [TOP_FACE as any], count: 1, scope, unit: 'mm' };
  }
  if (request.expression.includes('parallelTo')) {
    return { ok: true, matches: SIDE_FACES as any, count: 2, scope, unit: 'mm' };
  }
  if (request.expression.includes('cylinder')) {
    return { ok: true, matches: [BORE as any], count: 1, scope: { kind: 'instance', instanceId: 'inst-1', partId: 'obj-3', part: 'bracket' }, unit: 'mm' };
  }
  return { ok: true, matches: [], count: 0, scope, unit: 'mm' };
};

async function post(body: unknown): Promise<{ status: number; body: any; contentType: string }> {
  const res = await fetch(`${baseUrl}/api/screenshot`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const contentType = res.headers.get('content-type') ?? '';
  const payload = contentType.includes('json') ? await res.json() : Buffer.from(await res.arrayBuffer());
  return { status: res.status, body: payload, contentType };
}

describe('POST /api/screenshot overlays', () => {
  beforeAll(async () => {
    const app = express();
    app.use(express.json());
    app.use('/api', createScreenshotRouter(async (options) => {
      lastOptions = options;
      return PNG;
    }, resolveSelection));
    server = http.createServer(app);
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address() as { port: number };
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    await new Promise<void>(resolve => server.close(() => resolve()));
  });

  beforeEach(() => {
    lastOptions = null;
  });

  it('forwards index highlights, annotations and fitTo to the page unchanged', async () => {
    const highlight = [{ shapeId: 'sh-1', kind: 'face', index: 3 }, { shapeId: 'sh-9', kind: 'edge', index: 0, instanceId: 'inst-1' }];
    const annotations = [{ from: [0, 0, 0], to: [10, 0, 0], label: '10 mm' }];
    const res = await post({ highlight, annotations, fitTo: 'highlight', width: 400 });
    expect(res.status).toBe(200);
    expect(res.contentType).toContain('image/png');
    expect(lastOptions).toEqual({ width: 400, highlight, annotations, fitTo: 'highlight' });
  });

  it('resolves an expression highlight to every matching ref before the request reaches the page', async () => {
    const res = await post({
      highlight: [
        { expression: 'face().parallelTo("yz")', scope: { part: 'base' } },
        { shapeId: 'sh-2', kind: 'edge', index: 7 },
        { expression: 'face().cylinder()', scope: { instanceId: 'inst-1' } },
      ],
    });
    expect(res.status).toBe(200);
    expect(lastOptions?.highlight).toEqual([
      { shapeId: 'sh-1', kind: 'face', index: 0 },
      { shapeId: 'sh-1', kind: 'face', index: 1 },
      { shapeId: 'sh-2', kind: 'edge', index: 7 },
      { shapeId: 'sh-9', kind: 'face', index: 2, instanceId: 'inst-1' },
    ]);
  });

  it('refuses a highlight expression that matches nothing with a 404 naming it', async () => {
    const res = await post({ highlight: [{ expression: 'edge().circle(99)', scope: { part: 'base' } }] });
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('no-match');
    expect(res.body.error).toContain('highlight[0]');
    expect(res.body.error).toContain('matches nothing in part "base"');
    expect(lastOptions).toBeNull();
  });

  it('refuses a highlight expression that does not evaluate', async () => {
    const res = await post({ highlight: [{ expression: 'face().onPlan("xy")' }] });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('evaluation-error');
    expect(res.body.error).toContain('onPlan is not a function');
  });

  it('refuses a request that passes both hide and focus', async () => {
    const res = await post({ hide: ['sh-1'], focus: ['sh-2'] });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('hide and focus are exclusive');
    expect(lastOptions).toBeNull();
  });

  it('validates hide/focus id lists', async () => {
    expect((await post({ hide: [] })).status).toBe(400);
    expect((await post({ focus: ['ok', ''] })).status).toBe(400);
    expect((await post({ hide: 'sh-1' })).status).toBe(400);
    const res = await post({ focus: ['sh-1', 'inst-2'] });
    expect(res.status).toBe(200);
    expect(lastOptions?.focus).toEqual(['sh-1', 'inst-2']);
  });

  it('validates annotations', async () => {
    const bad = await post({ annotations: [{ from: [0, 0], to: [1, 1, 1] }] });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toContain('annotations[0].from');
    expect((await post({ annotations: [] })).status).toBe(400);
    expect((await post({ annotations: [{ from: [0, 0, 0], to: [1, 1, 1], label: 42 }] })).status).toBe(400);
    expect((await post({ annotations: [{ from: [0, 0, 0], to: [1, 1, Number.NaN] }] })).status).toBe(400);
    expect(lastOptions).toBeNull();
  });

  it('refuses fitTo without a highlight, and any value but "highlight"', async () => {
    const noHighlight = await post({ fitTo: 'highlight' });
    expect(noHighlight.status).toBe(400);
    expect(noHighlight.body.error).toContain('needs a non-empty highlight');
    const wrong = await post({ highlight: [{ shapeId: 'sh-1', kind: 'face', index: 1 }], fitTo: 'model' });
    expect(wrong.status).toBe(400);
  });

  it('validates a malformed highlight entry with its position named', async () => {
    const res = await post({ highlight: [{ shapeId: 'sh-1', kind: 'face', index: 1 }, { shapeId: 'sh-1', kind: 'vertex', index: 0 }] });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('highlight[1]');
    const badScope = await post({ highlight: [{ expression: 'face()', scope: { part: '' } }] });
    expect(badScope.status).toBe(400);
    expect(badScope.body.error).toContain('highlight[0].scope');
  });

  it('accepts 2-6 views on a multi capture and refuses them otherwise', async () => {
    const views = [{ kind: 'named', name: 'iso-ftr' }, { kind: 'look-from', eye: [10, -10, 10] }];
    const ok = await post({ multi: true, views });
    expect(ok.status).toBe(200);
    expect(lastOptions?.views).toEqual(views);
    expect(lastOptions?.multi).toBe(true);

    const single = await post({ multi: true, views: [views[0]] });
    expect(single.status).toBe(400);
    expect(single.body.error).toContain('2-6');
    const seven = await post({ multi: true, views: Array(7).fill(views[0]) });
    expect(seven.status).toBe(400);
    const badView = await post({ multi: true, views: [views[0], { kind: 'named', name: 'sideways' }] });
    expect(badView.status).toBe(400);
    expect(badView.body.error).toContain('views[1].name');
    const notMulti = await post({ views });
    expect(notMulti.status).toBe(400);
    expect(notMulti.body.error).toContain('multi: true');
  });

  it('forwards a named-plane section and an explicit-plane section to the page as given', async () => {
    const named = await post({ section: { plane: 'xy', offset: 10 } });
    expect(named.status).toBe(200);
    expect(lastOptions?.section).toEqual({ plane: 'xy', offset: 10 });

    const explicit = await post({ multi: true, section: { plane: { origin: [1, 2, 3], normal: [0, -1, 0] }, flip: true } });
    expect(explicit.status).toBe(200);
    expect(lastOptions?.section).toEqual({ plane: { origin: [1, 2, 3], normal: [0, -1, 0] }, flip: true });
    expect(lastOptions?.multi).toBe(true);

    const bare = await post({ section: { plane: 'yz' } });
    expect(bare.status).toBe(200);
    expect(lastOptions?.section).toEqual({ plane: 'yz' });
  });

  it('refuses a malformed section with the field named', async () => {
    const cases: Array<[unknown, string]> = [
      ['xy', 'section must be an object'],
      [{}, 'section.plane must be one of xy, yz, xz'],
      [{ plane: 'ab' }, 'section.plane'],
      [{ plane: { origin: [0, 0], normal: [0, 0, 1] } }, 'section.plane.origin'],
      [{ plane: { origin: [0, 0, 0], normal: [0, 0, 0] } }, 'zero vector'],
      [{ plane: { origin: [0, 0, 0], normal: [0, 'a', 1] } }, 'section.plane.normal'],
      [{ plane: 'xy', offset: '10' }, 'section.offset'],
      [{ plane: 'xy', flip: 'yes' }, 'section.flip'],
    ];
    for (const [section, expected] of cases) {
      const res = await post({ section });
      expect(res.status, JSON.stringify(section)).toBe(400);
      expect(res.body.error).toContain(expected);
    }
    expect(lastOptions).toBeNull();
  });
});

describe('POST /api/screenshot without a resolver', () => {
  let bare: http.Server;
  let bareUrl: string;

  beforeAll(async () => {
    const app = express();
    app.use(express.json());
    app.use('/api', createScreenshotRouter(async () => PNG));
    bare = http.createServer(app);
    await new Promise<void>(resolve => bare.listen(0, '127.0.0.1', resolve));
    bareUrl = `http://127.0.0.1:${(bare.address() as { port: number }).port}`;
  });

  afterAll(async () => {
    await new Promise<void>(resolve => bare.close(() => resolve()));
  });

  it('still takes index highlights but refuses expressions', async () => {
    const index = await fetch(`${bareUrl}/api/screenshot`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ highlight: [{ shapeId: 'sh-1', kind: 'face', index: 1 }] }),
    });
    expect(index.status).toBe(200);
    const expression = await fetch(`${bareUrl}/api/screenshot`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ highlight: [{ expression: 'face()' }] }),
    });
    expect(expression.status).toBe(501);
  });
});
