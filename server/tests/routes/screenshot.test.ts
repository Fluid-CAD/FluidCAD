import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import express from 'express';
import http from 'http';
import { createScreenshotRouter } from '../../src/routes/screenshot.ts';
import type { ScreenshotSelectionResolver } from '../../src/routes/screenshot-overlays.ts';

let server: http.Server;
let baseUrl: string;
let lastOptions: Record<string, unknown> | null = null;
/** What the route's scene lookup answers: the current render's shape and instance ids, or null for "nothing rendered". */
let sceneIds: ReadonlySet<string> | null = null;

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

/** The scene objects a section may name by id: a plane() (points), a section() (triples, its own cut), a solid, a failed plane. */
const SCENE_OBJECTS: Record<string, any> = {
  'obj-plane': { id: 'obj-plane', kind: 'plane', name: 'Plane', hasError: false, params: { origin: { x: 0, y: 0, z: 30 }, normal: { x: 0, y: 0, z: 1 }, options: {} } },
  'obj-section': { id: 'obj-section', kind: 'section', name: 'A-A', hasError: false, params: { name: 'A-A', origin: [1, 0, 0], normal: [0, 1, 0], offset: 12, flip: true } },
  'obj-2': { id: 'obj-2', kind: 'extrude', name: 'extrude', hasError: false, params: { distance: 10 } },
  'obj-broken': { id: 'obj-broken', kind: 'plane', name: 'Plane', hasError: true, errorMessage: 'Selected shape is not a face', params: {} },
};
const sceneObject = (id: string) => SCENE_OBJECTS[id] ?? null;

/** The engine's resolver stubbed on the expression text (or the pick) — the route's validation and resolution to refs are under test. */
const resolveSelection: ScreenshotSelectionResolver = (request) => {
  const scope = request.scope ? { kind: 'part', partId: 'obj-1', part: 'base' } as const : { kind: 'root' } as const;
  if (request.picks) {
    const pick = request.picks[0];
    const instance = request.scope && 'instanceId' in request.scope ? request.scope.instanceId : undefined;
    if (pick.shapeId === 'sh-1' && pick.sub.index === 5) {
      return { ok: true, matches: [{ ...TOP_FACE, ...(instance ? { instanceId: instance } : {}) } as any], count: 1, scope, unit: 'mm' };
    }
    if (pick.shapeId === 'sh-9' && pick.sub.index === 2) {
      return { ok: true, matches: [BORE as any], count: 1, scope, unit: 'mm' };
    }
    return { ok: false, code: 'unresolved-pick', reason: `No solid "${pick.shapeId}" in the scene (ids come from list_shapes / get_scene_summary).`, pick } as any;
  }
  if (request.expression!.includes('onPlan(')) {
    return { ok: false, code: 'evaluation-error', reason: 'face(...).onPlan is not a function' };
  }
  if (request.expression!.includes('"xy", 10')) {
    return { ok: true, matches: [TOP_FACE as any], count: 1, scope, unit: 'mm' };
  }
  if (request.expression!.includes('parallelTo')) {
    return { ok: true, matches: SIDE_FACES as any, count: 2, scope, unit: 'mm' };
  }
  if (request.expression!.includes('cylinder')) {
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
    }, resolveSelection, () => sceneIds, sceneObject));
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
    sceneIds = new Set(['sh-1', 'sh-2', 'sh-9', 'inst-1']);
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

  it('refuses fitTo without a highlight, and any value but "highlight" or a shape fit', async () => {
    const noHighlight = await post({ fitTo: 'highlight' });
    expect(noHighlight.status).toBe(400);
    expect(noHighlight.body.error).toContain('needs a non-empty highlight');
    const wrong = await post({ highlight: [{ shapeId: 'sh-1', kind: 'face', index: 1 }], fitTo: 'model' });
    expect(wrong.status).toBe(400);
    expect(wrong.body.error).toContain('fitTo must be "highlight" or { shapes');
  });

  it('forwards a shape fit as given, beside the overlays it leaves alone', async () => {
    const bare = await post({ view: { kind: 'named', name: 'iso-ftr' }, fitTo: { shapes: ['sh-2'] } });
    expect(bare.status).toBe(200);
    expect(lastOptions).toEqual({ view: { kind: 'named', name: 'iso-ftr' }, fitTo: { shapes: ['sh-2'] } });

    // Framing only: focus/hide and the highlight travel unchanged, and no highlight is needed.
    const highlight = [{ shapeId: 'sh-1', kind: 'face', index: 0 }];
    const full = await post({ fitTo: { shapes: ['sh-1', 'inst-1'], margin: 1.5 }, focus: ['sh-9'], highlight, multi: true });
    expect(full.status).toBe(200);
    expect(lastOptions).toEqual({ multi: true, fitTo: { shapes: ['sh-1', 'inst-1'], margin: 1.5 }, focus: ['sh-9'], highlight });

    const flush = await post({ fitTo: { shapes: ['sh-1'], margin: 1 } });
    expect(flush.status).toBe(200);
    expect(lastOptions?.fitTo).toEqual({ shapes: ['sh-1'], margin: 1 });
  });

  it('refuses a malformed shape fit with the field named', async () => {
    const cases: Array<[unknown, string]> = [
      [{}, 'fitTo.shapes must be an array of 1-64'],
      [['sh-1'], 'fitTo must be "highlight" or { shapes'],
      [null, 'fitTo must be "highlight" or { shapes'],
      [{ shapes: [] }, 'fitTo.shapes must be an array of 1-64'],
      [{ shapes: 'sh-1' }, 'fitTo.shapes must be an array of 1-64'],
      [{ shapes: Array.from({ length: 65 }, (_, i) => `sh-${i}`) }, 'fitTo.shapes must be an array of 1-64'],
      [{ shapes: ['sh-1', ''] }, 'fitTo.shapes must contain non-empty string ids'],
      [{ shapes: ['sh-1', 7] }, 'fitTo.shapes must contain non-empty string ids'],
      [{ shapes: ['sh-1'], margin: 0.9 }, 'fitTo.margin must be a number between 1 and 10'],
      [{ shapes: ['sh-1'], margin: 11 }, 'fitTo.margin must be a number between 1 and 10'],
      [{ shapes: ['sh-1'], margin: '1.2' }, 'fitTo.margin must be a number between 1 and 10'],
    ];
    for (const [fitTo, expected] of cases) {
      const res = await post({ fitTo });
      expect(res.status, JSON.stringify(fitTo)).toBe(400);
      expect(res.body.error).toContain(expected);
    }
    expect(lastOptions).toBeNull();
  });

  it('refuses a shape fit naming an id the current render does not hold, before the page is asked', async () => {
    const res = await post({ fitTo: { shapes: ['sh-1', 'sh-404'] } });
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('unknown-shape');
    expect(res.body.error).toBe('fitTo.shapes[1] "sh-404" is not a shape or instance id of the current render.');
    expect(lastOptions).toBeNull();
  });

  it('forwards a shape fit unchecked when nothing has rendered to check it against', async () => {
    sceneIds = null;
    const res = await post({ fitTo: { shapes: ['sh-404'] } });
    expect(res.status).toBe(200);
    expect(lastOptions?.fitTo).toEqual({ shapes: ['sh-404'] });
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
      [{ plane: { sceneObjectId: '' } }, 'section.plane.sceneObjectId'],
      [{ plane: { shapeId: 'sh-1', kind: 'edge', index: 0 } }, 'section.plane.kind'],
      [{ plane: { shapeId: 'sh-1', index: 1.5 } }, 'section.plane.index'],
      [{ plane: { shapeId: 'sh-1', index: 1, instanceId: 7 } }, 'section.plane.instanceId'],
      [{ plane: { expression: '' } }, 'section.plane.expression'],
      [{ plane: { expression: 'face()', scope: { part: '' } } }, 'section.plane.scope'],
      [{ plane: { other: 1 } }, 'a planar face'],
    ];
    for (const [section, expected] of cases) {
      const res = await post({ section });
      expect(res.status, JSON.stringify(section)).toBe(400);
      expect(res.body.error).toContain(expected);
    }
    expect(lastOptions).toBeNull();
  });

  it('resolves a section on a planar face — by index or by filter — to the face\'s own plane', async () => {
    const byIndex = await post({ section: { plane: { shapeId: 'sh-1', kind: 'face', index: 5 }, offset: -4 } });
    expect(byIndex.status).toBe(200);
    expect(lastOptions?.section).toEqual({ plane: { origin: [20, 20, 10], normal: [0, 0, 1] }, offset: -4 });

    const posed = await post({ section: { plane: { shapeId: 'sh-1', index: 5, instanceId: 'inst-1' }, flip: true } });
    expect(posed.status).toBe(200);
    expect(lastOptions?.section).toEqual({ plane: { origin: [20, 20, 10], normal: [0, 0, 1] }, flip: true });

    const byFilter = await post({ section: { plane: { expression: 'face().onPlane("xy", 10)', scope: { part: 'base' } } } });
    expect(byFilter.status).toBe(200);
    expect(lastOptions?.section).toEqual({ plane: { origin: [20, 20, 10], normal: [0, 0, 1] } });
  });

  it('refuses a face plane that is not one planar face: several matches, a cylinder, a missing pick', async () => {
    const several = await post({ section: { plane: { expression: 'face().parallelTo("yz")', scope: { part: 'base' } } } });
    expect(several.status).toBe(409);
    expect(several.body.code).toBe('ambiguous-match');
    expect(several.body.error).toContain('section.plane');
    expect(several.body.error).toContain('exactly one planar face');
    expect(several.body.candidates).toHaveLength(2);

    const curved = await post({ section: { plane: { shapeId: 'sh-9', index: 2 } } });
    expect(curved.status).toBe(422);
    expect(curved.body.code).toBe('not-planar');
    expect(curved.body.error).toContain('cylinder face, not planar');

    const curvedFilter = await post({ section: { plane: { expression: 'face().cylinder()', scope: { instanceId: 'inst-1' } } } });
    expect(curvedFilter.status).toBe(422);
    expect(curvedFilter.body.code).toBe('not-planar');

    const missing = await post({ section: { plane: { shapeId: 'sh-404', index: 0 } } });
    expect(missing.status).toBe(404);
    expect(missing.body.code).toBe('unresolved-pick');

    const none = await post({ section: { plane: { expression: 'edge().circle(99)', scope: { part: 'base' } } } });
    expect(none.status).toBe(404);
    expect(none.body.code).toBe('no-match');
    expect(lastOptions).toBeNull();
  });

  it('resolves a section on a plane() statement to its plane and on a section() statement to its saved cut', async () => {
    const plane = await post({ section: { plane: { sceneObjectId: 'obj-plane' }, offset: -5 } });
    expect(plane.status).toBe(200);
    expect(lastOptions?.section).toEqual({ plane: { origin: [0, 0, 30], normal: [0, 0, 1] }, offset: -5 });

    // The statement's own offset and flip are the cut; the request moves it further and may override the flip.
    const saved = await post({ section: { plane: { sceneObjectId: 'obj-section' } } });
    expect(saved.status).toBe(200);
    expect(lastOptions?.section).toEqual({ plane: { origin: [1, 0, 0], normal: [0, 1, 0] }, offset: 12, flip: true });

    const moved = await post({ section: { plane: { sceneObjectId: 'obj-section' }, offset: -2, flip: false } });
    expect(moved.status).toBe(200);
    expect(lastOptions?.section).toEqual({ plane: { origin: [1, 0, 0], normal: [0, 1, 0] }, offset: 10, flip: false });
  });

  it('refuses a statement that is unknown, carries no plane or did not build', async () => {
    const unknown = await post({ section: { plane: { sceneObjectId: 'obj-404' } } });
    expect(unknown.status).toBe(404);
    expect(unknown.body.code).toBe('no-match');
    expect(unknown.body.error).toContain('obj-404');

    const solid = await post({ section: { plane: { sceneObjectId: 'obj-2' } } });
    expect(solid.status).toBe(422);
    expect(solid.body.code).toBe('not-a-plane');
    expect(solid.body.error).toContain('extrude "extrude" (obj-2) carries no plane');

    const broken = await post({ section: { plane: { sceneObjectId: 'obj-broken' } } });
    expect(broken.status).toBe(422);
    expect(broken.body.code).toBe('not-a-plane');
    expect(broken.body.error).toContain('did not build: Selected shape is not a face');
    expect(lastOptions).toBeNull();
  });

  it('accepts the section view, alone or in a grid, only with a section to look at', async () => {
    const single = await post({ view: { kind: 'section' }, section: { plane: 'xz' } });
    expect(single.status).toBe(200);
    expect(lastOptions?.view).toEqual({ kind: 'section' });

    const straight = await post({ multi: true, views: [{ kind: 'section', straight: true }, { kind: 'named', name: 'top' }], section: { plane: 'xz' } });
    expect(straight.status).toBe(200);
    expect(lastOptions?.views).toEqual([{ kind: 'section', straight: true }, { kind: 'named', name: 'top' }]);

    const noSection = await post({ view: { kind: 'section' } });
    expect(noSection.status).toBe(400);
    expect(noSection.body.error).toContain('view.kind "section"');

    const noSectionGrid = await post({ multi: true, views: [{ kind: 'named', name: 'top' }, { kind: 'section' }] });
    expect(noSectionGrid.status).toBe(400);
    expect(noSectionGrid.body.error).toContain('views[1].kind "section"');

    const badStraight = await post({ view: { kind: 'section', straight: 'yes' }, section: { plane: 'xz' } });
    expect(badStraight.status).toBe(400);
    expect(badStraight.body.error).toContain('view.straight');
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

  it('refuses a section on a face or a statement with a 501, and still takes a datum or explicit plane', async () => {
    const face = await fetch(`${bareUrl}/api/screenshot`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ section: { plane: { shapeId: 'sh-1', index: 5 } } }),
    });
    expect(face.status).toBe(501);
    expect((await face.json()).error).toContain('face planes cannot be resolved');
    const statement = await fetch(`${bareUrl}/api/screenshot`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ section: { plane: { sceneObjectId: 'obj-plane' } } }),
    });
    expect(statement.status).toBe(501);
    const datum = await fetch(`${bareUrl}/api/screenshot`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ section: { plane: 'xz' } }),
    });
    expect(datum.status).toBe(200);
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
