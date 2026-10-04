import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import http from 'http';
import { createApplyFeatureRouter, type ApplyFeatureRouterOptions } from '../../src/routes/apply-feature/index.ts';
import { FeatureCatalog, type FeatureCatalogEntry } from '../../src/feature-catalog/catalog.ts';
import type { ScannedFeature } from '../../src/feature-catalog/scan.ts';

// The custom feature arms of POST /apply-feature: a create names the feature
// by its catalog id, the route checks the values against its metadata,
// synthesizes the picked geometry in one slot pass, binds picked statements,
// and relays a spec the transform writes through the call shape. An edit
// reads the statement back by the same shape. The scene is faked: the slot
// synthesis answers from a fixed table.

const MODEL = '/ws/model.part.js';

const STANDOFF_META = {
  id: 'acme.standoff', label: 'Standoff', group: 'create', kind: 'tool', operations: ['add', 'new'],
  params: {
    face: { picker: 'face', label: 'On face', surface: 'planar' },
    height: { type: 'length', default: 10, min: 0, label: 'Height' },
    outer: { type: 'length', default: 6, min: 0, label: 'Boss diameter' },
    hole: { type: 'length', default: 3, min: 0, label: 'Hole diameter' },
  },
  call: ['face', { height: 'height', outer: 'outer', hole: 'hole' }],
  hasOnChange: false, ghost: true, contexts: ['part'],
} as unknown as ScannedFeature['meta'];

const GUSSET_META = {
  id: 'acme.gusset', label: 'Gusset', group: 'create', kind: 'tool', operations: ['add', 'new', 'remove'],
  params: {
    profile: { picker: 'sketch', label: 'Profile' },
    axis: { picker: 'axis', label: 'Axis', optional: true },
    targets: { picker: 'solid', multiple: true, optional: true, label: 'Targets' },
    style: { type: 'select', options: [{ label: 'Flat', value: 'flat' }, { label: 'Round', value: 'round' }], default: 'flat', label: 'Style' },
    anchor: { picker: 'point', optional: true, label: 'Anchor' },
  },
  call: ['profile', 'axis', { targets: 'targets', style: 'style', anchor: 'anchor' }],
  hasOnChange: false, ghost: true, contexts: ['part'],
} as unknown as ScannedFeature['meta'];

/** Bosses at connectors, points and face centres: a picker of three kinds. */
const BOSS_META = {
  id: 'acme.boss', label: 'Boss', group: 'create', kind: 'tool', operations: ['add', 'new'], defaultOperation: 'add',
  params: {
    at: { picker: ['connector', 'point', 'anchor'], multiple: true, anchors: ['center'], label: 'At' },
    height: { type: 'length', default: 6, min: 0, label: 'Height' },
  },
  call: ['at', { height: 'height' }],
  hasOnChange: false, ghost: true, contexts: ['part'],
} as unknown as ScannedFeature['meta'];

/** Copies of solids or connectors — two kinds a statement fills — at most two of them. */
const COPIER_META = {
  id: 'acme.copier', label: 'Copier', group: 'create', kind: 'tool', operations: [], defaultOperation: null,
  params: { targets: { picker: ['solid', 'connector'], multiple: true, max: 2, label: 'Targets' } },
  call: ['targets'],
  hasOnChange: false, ghost: true, contexts: ['part'],
} as unknown as ScannedFeature['meta'];

const MODULES: Record<string, ScannedFeature[]> = {
  '/ws/standoff.feature.js': [{ exportName: 'standoff', meta: STANDOFF_META }],
  '/ws/gusset.feature.js': [{ exportName: 'gusset', meta: GUSSET_META }],
  '/ws/boss.feature.js': [{ exportName: 'boss', meta: BOSS_META }],
  '/ws/copier.feature.js': [{ exportName: 'copier', meta: COPIER_META }],
};

/** The catalog as the routes list it; error entries stand in for a refused module. */
let entries: FeatureCatalogEntry[];

function callees(): FeatureCatalog {
  return new FeatureCatalog({
    workspacePath: '/ws',
    scan: async (absPath) => MODULES[absPath]
      ? { file: absPath, features: MODULES[absPath], deps: [] }
      : { file: absPath, features: [], error: `cannot load ${absPath}`, deps: [] },
    builtIns: async () => ({}),
  });
}

const PLATE = [
  `import { sketch, rect, extrude, part } from 'fluidcad/core'`,
  ``,
  `const s = sketch('xz', () => { rect(10, 10) })`,
  `sketch('xy', () => { rect(40, 40) })`,
  `const e = extrude(10)`,
  `const p = part('Body', () => {})`,
  ``,
].join('\n');

const PLACED = [
  `import { sketch, rect, extrude } from 'fluidcad/core'`,
  `import { standoff as so } from './standoff.feature.js'`,
  ``,
  `sketch('xy', () => { rect(40, 40) })`,
  `const e = extrude(10)`,
  `const s = so(e.endFaces(), { height: 12, outer: 2 * r }).new().name('boss')`,
  ``,
].join('\n');

const FACE_PICK = { shapeId: 'shape-1', sub: { type: 'face', index: 4 } };
const BEFORE = { index: 3, type: 'acme.standoff', line: 6, column: 10 };

let currentCode: string;
let currentFileName: string;
/** What the fake slot synthesis was asked, per call. */
let slotCalls: { request: any; options: any; before: unknown }[];
/** The fake slot synthesis's answer. */
let slotAnswer: any;
let relayed: any[];

/** `e.endFaces()` for every face slot: one part on the extrude at line 5. */
function faceAnswer(slot = 'face'): any {
  return {
    ok: true,
    filePath: MODEL,
    producers: [{ line: 5, column: 10, featureType: 'extrude', nameHint: 'e', bind: true }],
    parts: [{ producer: 0, accessor: 'endFaces', indices: null, filterArgs: null, refs: null }],
    imports: [],
    slots: { [slot]: { parts: [0], args: ['e.endFaces()'], wrap: null } },
  };
}

const fakeServer = {
  getCurrentCode: () => currentCode,
  getCurrentFileName: () => currentFileName,
  getParamDefinitions: () => [],
  synthesizeFeatureSlots: (request: unknown, options: unknown, before?: unknown) => {
    slotCalls.push({ request, options, before });
    return slotAnswer;
  },
};

let server: http.Server | null = null;

async function serve(options: ApplyFeatureRouterOptions = {}): Promise<string> {
  const app = express();
  app.use(express.json());
  app.use('/api', createApplyFeatureRouter(fakeServer as any, (msg: any) => {
    relayed.push(msg);
  }, { callees: callees(), catalog: { list: async () => entries }, ...options }));
  server = http.createServer(app);
  await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address() as { port: number };
  return `http://127.0.0.1:${address.port}/api`;
}

async function post(url: string, body: unknown): Promise<{ status: number; body: any }> {
  const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { status: res.status, body: await res.json() };
}

beforeEach(() => {
  entries = [
    { id: 'acme.standoff', exportName: 'standoff', modulePath: '/ws/standoff.feature.js', builtIn: false, meta: STANDOFF_META },
    { id: 'acme.gusset', exportName: 'gusset', modulePath: '/ws/gusset.feature.js', builtIn: false, meta: GUSSET_META },
    { id: 'acme.boss', exportName: 'boss', modulePath: '/ws/boss.feature.js', builtIn: false, meta: BOSS_META },
    { id: 'acme.copier', exportName: 'copier', modulePath: '/ws/copier.feature.js', builtIn: false, meta: COPIER_META },
  ];
  currentCode = PLATE;
  currentFileName = MODEL;
  slotCalls = [];
  slotAnswer = faceAnswer();
  relayed = [];
});

afterEach(async () => {
  if (server) {
    await new Promise<void>(resolve => server!.close(() => resolve()));
    server = null;
  }
});

/** A standoff create on the plate's top face. */
function standoffBody(extra: Record<string, unknown> = {}, custom: Record<string, unknown> = {}) {
  return {
    feature: 'custom',
    custom: {
      id: 'acme.standoff',
      values: { height: 12, hole: 'holeD' },
      picks: { face: [{ kind: 'entities', entities: [FACE_PICK] }] },
      ...custom,
    },
    ...extra,
  };
}

describe('creating a custom feature', () => {
  it('previews the statement its picks and values write', async () => {
    const base = await serve();
    const { status, body } = await post(`${base}/apply-feature`, standoffBody({ preview: true }));
    expect(status).toBe(200);
    expect(body).toEqual({ success: true, preview: 'standoff(e.endFaces(), { height: 12, hole: holeD })', args: { face: ['e.endFaces()'] } });
    // One slot pass, each picker as the feature declares it, over the file's names.
    expect(slotCalls).toHaveLength(1);
    expect(slotCalls[0].request).toEqual({
      slots: { face: { picker: 'face', entities: [FACE_PICK], chains: [], options: { label: 'On face', surface: 'planar' } } },
    });
    expect(slotCalls[0].options.namer([{ line: 5, nameHint: 'e', featureType: 'extrude' }])).toEqual(['e']);
    expect(slotCalls[0].before).toBeUndefined();
    expect(relayed).toEqual([]);
  });

  it('relays a spec the transform writes, the builder imported from its module', async () => {
    const base = await serve();
    const { status, body } = await post(`${base}/apply-feature`, standoffBody({}, { operation: 'new' }));
    expect(status).toBe(200);
    expect(body.preview).toBe('standoff(e.endFaces(), { height: 12, hole: holeD }).new()');
    const spec = relayed[0].spec;
    expect(spec).toMatchObject({
      feature: 'custom',
      filePath: MODEL,
      producers: [{ line: 5, featureType: 'extrude', bind: true }],
      parts: [{ producer: 0, accessor: 'endFaces' }],
      custom: {
        id: 'acme.standoff',
        exportName: 'standoff',
        modulePath: '/ws/standoff.feature.js',
        operation: 'new',
        values: {
          face: { kind: 'picks', items: [{ kind: 'part', part: 0 }] },
          height: { kind: 'value', value: 12 },
          hole: { kind: 'value', value: 'holeD' },
        },
      },
    });

    const written = await post(`${base}/code/apply-feature`, { code: PLATE, spec });
    expect(written.body.error).toBeUndefined();
    expect(written.body.newCode).toContain(`import { standoff } from './standoff.feature.js';`);
    expect(written.body.newCode).toContain(`const p = part('Body', () => {})\nstandoff(e.endFaces(), { height: 12, hole: holeD }).new()\n`);
  });

  it('binds picked statements, names world axes, and lands an unpinned statement in the active part', async () => {
    slotAnswer = null;
    const base = await serve();
    const { status, body } = await post(`${base}/apply-feature`, {
      feature: 'custom',
      activePart: { filePath: MODEL, line: 6, column: 10 },
      custom: {
        id: 'acme.gusset',
        values: { style: 'round' },
        picks: {
          profile: [{ kind: 'statement', filePath: MODEL, line: 3, column: 10 }],
          axis: { kind: 'standard', name: 'z' },
          targets: [{ kind: 'statement', filePath: MODEL, line: 5, column: 10 }],
        },
      },
    });
    expect(status).toBe(200);
    expect(slotCalls).toEqual([]);
    expect(body.preview).toBe(`gusset(s, 'z', { targets: e, style: 'round' })`);
    const spec = relayed[0].spec;
    expect(spec.producers).toMatchObject([
      { line: 3, featureType: 'sketch', nameHint: 's', bind: true },
      { line: 5, featureType: 'feature', nameHint: 'f', bind: true },
    ]);
    expect(spec.activePart).toEqual({ line: 6, column: 10 });

    // The solid target pins the statement to the top level it lives at.
    const written = await post(`${base}/code/apply-feature`, { code: PLATE, spec });
    expect(written.body.error).toBeUndefined();
    expect(written.body.newCode).toContain(`const p = part('Body', () => {})\ngusset(s, 'z', { targets: e, style: 'round' })\n`);

    // A sketch alone pins nothing: the statement goes into the active part.
    const sketchOnly = await post(`${base}/apply-feature`, {
      feature: 'custom',
      activePart: { filePath: MODEL, line: 6, column: 10 },
      custom: { id: 'acme.gusset', values: {}, picks: { profile: [{ kind: 'statement', filePath: MODEL, line: 3, column: 10 }] } },
    });
    expect(sketchOnly.status).toBe(200);
    const landed = await post(`${base}/code/apply-feature`, { code: PLATE, spec: relayed[1].spec });
    expect(landed.body.newCode).toContain(`const p = part('Body', () => {\n  gusset(s)\n})`);
  });

  it('refuses what the feature does not declare or allow', async () => {
    const base = await serve();
    const cases: [unknown, number, string][] = [
      [standoffBody({}, { id: 'acme.missing' }), 422, `no feature 'acme.missing' in this workspace`],
      [standoffBody({}, { values: { height: -1 } }), 422, 'Height must be at least 0'],
      [standoffBody({}, { values: { height: 'x;y' } }), 422, 'Height must be a number or an expression'],
      [standoffBody({}, { values: { depth: 3 } }), 422, `'depth' is not one of Standoff's values`],
      [standoffBody({}, { values: { face: 3 } }), 422, 'On face is picked — send it under picks'],
      [standoffBody({}, { picks: {} }), 422, 'On face is required — pick a face'],
      [standoffBody({}, { picks: { height: [{ kind: 'standard', name: 'z' }] } }), 422, 'Height is typed in'],
      [standoffBody({}, { picks: { face: [{ kind: 'statement', filePath: MODEL, line: 5 }] } }), 422, 'On face: a face is not a statement to pick'],
      [{ feature: 'custom', custom: { id: 'acme.gusset', picks: { profile: [{ kind: 'entities', entities: [FACE_PICK] }] } } }, 422, 'Profile: a sketch is picked as its statement, not as geometry'],
      [standoffBody({}, { operation: 'remove' }), 422, 'Standoff offers add, new — not remove'],
      [standoffBody({}, { operation: 'sideways' }), 400, 'custom.operation must be'],
      [standoffBody({}, { picks: { face: [{ kind: 'verbatim', sourceIndex: 0 }] } }), 400, 'custom.picks.face'],
      [{ feature: 'custom', custom: { id: 'acme.gusset', values: { style: 'square' }, picks: { profile: [{ kind: 'statement', filePath: MODEL, line: 3 }] } } }, 422, 'Style must be one of "flat", "round"'],
      [{ feature: 'custom', custom: { id: 'acme.gusset', picks: { profile: [{ kind: 'statement', filePath: MODEL, line: 3 }], axis: [{ kind: 'standard', name: 'xy' }] } } }, 422, `Axis: 'xy' is not a world axis`],
      [{ feature: 'custom', custom: { id: 'acme.gusset', picks: { profile: [{ kind: 'statement', filePath: MODEL, line: 3 }], anchor: [{ kind: 'standard', name: 'z' }] } } }, 422, `Anchor: 'z' is not a point`],
    ];
    for (const [request, status, reason] of cases) {
      const { status: got, body } = await post(`${base}/apply-feature`, request);
      expect(got).toBe(status);
      expect(body.reason ?? body.error).toContain(reason);
    }
    expect(relayed).toEqual([]);
  });

  it('passes a pick refusal through, and refuses an entry it can\'t offer', async () => {
    slotAnswer = { ok: false, reason: 'On face: the picked face is not planar — this value takes faces that match face().planar()' };
    const base = await serve();
    const refused = await post(`${base}/apply-feature`, standoffBody({ preview: true }));
    expect(refused.status).toBe(422);
    expect(refused.body.reason).toContain('face().planar()');

    entries = [{ ...entries[0], error: `the feature id 'acme.standoff' is used by more than one builder` }];
    const shared = await post(`${base}/apply-feature`, standoffBody({ preview: true }));
    expect(shared.status).toBe(422);
    expect(shared.body.reason).toContain('used by more than one builder');
  });

  it('refuses an assembly file, and a server with no catalog', async () => {
    currentFileName = '/ws/main.assembly.js';
    slotAnswer = { ...faceAnswer(), filePath: '/ws/main.assembly.js' };
    const base = await serve();
    const assembly = await post(`${base}/apply-feature`, standoffBody({ preview: true }));
    expect(assembly.status).toBe(422);
    expect(assembly.body.reason).toContain('custom features are written in part files');
    await new Promise<void>(resolve => server!.close(() => resolve()));
    server = null;

    const app = express();
    app.use(express.json());
    app.use('/api', createApplyFeatureRouter(fakeServer as any, () => {}, {}));
    server = http.createServer(app);
    await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', () => resolve()));
    const without = `http://127.0.0.1:${(server.address() as { port: number }).port}/api`;
    const refused = await post(`${without}/apply-feature`, standoffBody({ preview: true }));
    expect(refused.status).toBe(422);
    expect(refused.body.reason).toContain('no feature catalog');
  });
});

describe('editing a custom feature', () => {
  beforeEach(() => {
    currentCode = PLACED;
  });

  /** An edit of the standoff at line 6. */
  function editBody(custom: Record<string, unknown>, extra: Record<string, unknown> = {}) {
    return {
      feature: 'custom',
      edit: { filePath: MODEL, line: 6, column: 10 },
      custom: { id: 'acme.standoff', ...custom },
      ...extra,
    };
  }

  it('reads the statement back for the dialog', async () => {
    const base = await serve();
    const { status, body } = await post(`${base}/feature/parse`, { line: 6, filePath: MODEL });
    expect(status).toBe(200);
    expect(body.statement).toBe(`so(e.endFaces(), { height: 12, outer: 2 * r }).new()`);
    expect(body.parsed).toEqual({
      feature: 'custom',
      id: 'acme.standoff',
      callee: 'so',
      values: { height: 12, outer: '2 * r' },
      picks: { face: [{ text: 'e.endFaces()', start: PLACED.indexOf('e.endFaces(), {'), end: PLACED.indexOf('e.endFaces(), {') + 12 }] },
      operation: 'new',
      scopeTexts: [],
      scopeRefs: [],
    });
  });

  it('previews and relays the values it changes, keeping the rest as written', async () => {
    const base = await serve();
    const preview = await post(`${base}/apply-feature`, editBody({ values: { height: 20 } }, {
      preview: true, expectedStatement: `so(e.endFaces(), { height: 12, outer: 2 * r }).new()`,
    }));
    expect(preview.status).toBe(200);
    expect(preview.body.preview).toBe(`so(e.endFaces(), { height: 20, outer: 2 * r }).new()`);

    const applied = await post(`${base}/apply-feature`, editBody({ values: { height: 20, outer: null }, operation: 'add' }));
    expect(applied.status).toBe(200);
    const spec = relayed[0].spec;
    expect(spec.edit.custom).toEqual({
      id: 'acme.standoff',
      values: { face: { kind: 'keep' }, height: { kind: 'value', value: 20 }, hole: { kind: 'keep' } },
      operation: 'add',
    });
    expect(spec.clearBreakpoints).toBe(true);
    const written = await post(`${base}/code/apply-feature`, { code: PLACED, spec });
    expect(written.body.error).toBeUndefined();
    expect(written.body.newCode).toContain(`const s = so(e.endFaces(), { height: 20 }).name('boss')\n`);
  });

  it('synthesizes a re-picked face against the world before the statement', async () => {
    const base = await serve();
    const body = editBody({ picks: { face: [{ kind: 'entities', entities: [FACE_PICK] }] } }, { preview: true });
    expect((await post(`${base}/apply-feature`, body)).status).toBe(400);

    slotAnswer = {
      ...faceAnswer(),
      parts: [{ producer: 0, accessor: 'sideFaces', indices: [2], filterArgs: null, refs: null }],
      slots: { face: { parts: [0], args: ['e.sideFaces(2)'], wrap: null } },
    };
    const { status, body: answer } = await post(`${base}/apply-feature`, { ...body, before: BEFORE });
    expect(status).toBe(200);
    expect(answer.preview).toBe(`so(e.sideFaces(2), { height: 12, outer: 2 * r }).new()`);
    expect(slotCalls[0].before).toEqual(BEFORE);
  });

  it('refuses a statement of another feature', async () => {
    const base = await serve();
    const { status, body } = await post(`${base}/apply-feature`, editBody({ id: 'acme.gusset' }, { preview: true }));
    expect(status).toBe(422);
    expect(body.reason).toContain('is not a acme.gusset');
  });
});

describe('a custom feature at locations', () => {
  /** A plate in a part, a connector on its top copied along x, and a sketch on the top holding a point. */
  const BOSS_PLATE = [
    `import { part, sketch, rect, point, extrude, connector, copy, select } from 'fluidcad/core'`,
    `import { face } from 'fluidcad/filters'`,
    ``,
    `part('plate', () => {`,
    `  sketch('xy', () => { rect(60, 40) })`,
    `  const e = extrude(10)`,
    `  const bolt = connector('bolt', select(face().onPlane('xy', 10)))`,
    `  copy('linear', 'x', { count: 2, offset: 15 }, bolt)`,
    `  sketch(e.endFaces(), () => {`,
    `    point([-20, -10])`,
    `  })`,
    `})`,
    ``,
  ].join('\n');

  const CORNER = { shapeId: 'shape-1', sub: { type: 'vertex', index: 3 } };
  const DOT = { shapeId: 'shape-9', sub: { type: 'vertex', index: 0 } };
  const TOP = { shapeId: 'shape-1', sub: { type: 'face', index: 4 } };

  /** The slot pass's answer: the corner as the end of an edge, the dot as the sketch's point, the top's centre. */
  function locationsAnswer(): any {
    return {
      ok: true,
      filePath: MODEL,
      producers: [
        { line: 6, column: 12, featureType: 'extrude', nameHint: 'e', bind: true },
        { line: 9, column: 2, featureType: 'sketch', nameHint: 's', bind: true },
      ],
      parts: [
        { producer: 0, accessor: 'endEdges', indices: [0], filterArgs: null, refs: null },
        { producer: 0, accessor: 'endFaces', indices: null, filterArgs: null, refs: null },
      ],
      imports: [],
      slots: {
        'at#point': {
          parts: [0], wrap: null,
          points: [{ part: 0, suffix: '.start()' }, { sketch: 1, target: { line: 10, featureType: 'point' } }],
          args: ['e.endEdges(0).start()', 's.geometries.p1'],
        },
        'at#anchor': { parts: [1], wrap: null, points: [{ part: 1, suffix: '.center()' }], args: ['e.endFaces().center()'] },
      },
    };
  }

  beforeEach(() => {
    currentCode = BOSS_PLATE;
    slotAnswer = locationsAnswer();
  });

  function bossBody(at: unknown[], extra: Record<string, unknown> = {}) {
    return { feature: 'custom', custom: { id: 'acme.boss', values: {}, picks: { at } }, ...extra };
  }

  const AT = [
    { kind: 'statement', filePath: MODEL, line: 7, column: 15, picker: 'connector' },
    { kind: 'point', entity: CORNER },
    { kind: 'anchor', entity: TOP, anchor: { kind: 'center' } },
    { kind: 'statement', filePath: MODEL, line: 7, column: 15, picker: 'connector', slot: 1 },
    { kind: 'point', entity: DOT },
  ];

  it('routes each pick to the kind that takes it, and writes them in the order they were picked', async () => {
    const base = await serve();
    const { status, body } = await post(`${base}/apply-feature`, bossBody(AT, { preview: true }));
    expect(status).toBe(200);
    expect(body.preview).toBe('boss([bolt, e.endEdges(0).start(), e.endFaces().center(), bolt.instance(1), s.geometries.p1])');
    expect(body.args).toEqual({ at: ['e.endEdges(0).start()', 'e.endFaces().center()', 's.geometries.p1'] });
    // One slot pass, one slot per kind; each a list, the value's max counted here.
    expect(slotCalls).toHaveLength(1);
    expect(slotCalls[0].request).toEqual({
      slots: {
        'at#point': { picker: 'point', entities: [CORNER, DOT], options: { label: 'At', multiple: true, anchors: ['center'] } },
        'at#anchor': {
          picker: 'anchor', entities: [TOP], anchors: [{ kind: 'center' }], options: { label: 'At', multiple: true, anchors: ['center'] },
        },
      },
    });

    const applied = await post(`${base}/apply-feature`, bossBody(AT));
    expect(applied.status).toBe(200);
    const spec = relayed[0].spec;
    expect(spec.custom.values.at.items).toEqual([
      { kind: 'producer', producer: 2 },
      { kind: 'part', part: 0, suffix: '.start()' },
      { kind: 'part', part: 1, suffix: '.center()' },
      { kind: 'producer', producer: 2, instance: 1 },
      { kind: 'sketchPoint', producer: 1, target: { line: 10, featureType: 'point' } },
    ]);
    expect(spec.producers[2]).toMatchObject({ line: 7, featureType: 'connector', nameHint: 'c', bind: true });

    const written = await post(`${base}/code/apply-feature`, { code: BOSS_PLATE, spec });
    expect(written.body.error).toBeUndefined();
    expect(written.body.newCode).toContain(`  const s = sketch(e.endFaces(), () => {\n    const p1 = point([-20, -10])\n    return { p1 };\n  })\n`);
    expect(written.body.newCode).toContain(`  boss([bolt, e.endEdges(0).start(), e.endFaces().center(), bolt.instance(1), s.geometries.p1])\n})`);
  });

  it('binds statements of a picker of two statement kinds by the kind each was picked as', async () => {
    slotAnswer = null;
    const base = await serve();
    const { status, body } = await post(`${base}/apply-feature`, {
      feature: 'custom',
      custom: {
        id: 'acme.copier', values: {},
        picks: { targets: [
          { kind: 'statement', filePath: MODEL, line: 6, column: 12, picker: 'solid' },
          { kind: 'statement', filePath: MODEL, line: 7, column: 15, picker: 'connector', slot: 1 },
        ] },
      },
    });
    expect(status).toBe(200);
    expect(body.preview).toBe('copier([e, bolt.instance(1)])');
    expect(slotCalls).toEqual([]);
    expect(relayed[0].spec.producers).toMatchObject([
      { line: 6, featureType: 'feature', nameHint: 'f', bind: true },
      { line: 7, featureType: 'connector', nameHint: 'c', bind: true },
    ]);
  });

  it('refuses picks the value does not take', async () => {
    const base = await serve();
    const statement = (picker?: string, slot?: number) => ({
      kind: 'statement', filePath: MODEL, line: 6, column: 12, ...(picker ? { picker } : {}), ...(slot !== undefined ? { slot } : {}),
    });
    const copier = (targets: unknown[]) => ({ feature: 'custom', custom: { id: 'acme.copier', values: {}, picks: { targets } } });
    const cases: [unknown, number, string][] = [
      [bossBody([{ kind: 'anchor', entity: TOP, anchor: { kind: 'start' } }]), 422, 'At: takes anchors at center() — not start()'],
      [bossBody([statement('solid')]), 422, 'At: takes no solid statement — it takes a connector, a point or an anchor'],
      [bossBody([{ kind: 'entities', entities: [FACE_PICK] }]), 422, 'At: a connector, a point or an anchor is not picked as faces or edges'],
      [bossBody([{ kind: 'point', entity: TOP }]), 400, 'custom.picks.at'],
      [bossBody([{ kind: 'standard', name: 'z' }]), 422, "At: 'z' is not a connector, a point or an anchor"],
      [bossBody([]), 422, 'At is required — pick a connector, a point or an anchor'],
      [copier([statement()]), 422, 'Targets: say which kind the statement is picked as (picker)'],
      [copier([statement('solid', 1)]), 422, "Targets: only a connector is picked with a copy's slot"],
      [copier([{ kind: 'point', entity: CORNER }]), 422, 'Targets: takes no points — it takes a solid or a connector'],
      [copier([statement('solid'), statement('solid'), statement('connector')]), 422, 'Targets takes at most 2, got 3'],
      [standoffBody({}, { picks: { face: [{ kind: 'anchor', entity: TOP, anchor: { kind: 'center' } }] } }), 422, 'On face: takes no anchors — it takes a face'],
    ];
    for (const [request, status, reason] of cases) {
      const { status: got, body } = await post(`${base}/apply-feature`, request);
      expect({ request, got, reason: body.reason ?? body.error }).toEqual({ request, got: status, reason: expect.stringContaining(reason) });
    }
    expect(relayed).toEqual([]);
  });

  it('edits the locations it changes, keeping the rest as written, the new point against the world before it', async () => {
    currentCode = BOSS_PLATE
      .replace(`\n\npart(`, `\nimport { boss } from './boss.feature.js'\npart(`)
      .replace(`  })\n})`, `  })\n  boss([bolt, e.endFaces().center()], { height: 8 })\n})`);
    slotAnswer = {
      ...locationsAnswer(),
      slots: { 'at#point': { parts: [0], wrap: null, points: [{ part: 0, suffix: '.start()' }], args: ['e.endEdges(0).start()'] } },
    };
    const base = await serve();
    const parsed = await post(`${base}/feature/parse`, { line: 12, filePath: MODEL });
    expect(parsed.body.parsed.picks.at.map((pick: any) => pick.ref)).toEqual([{ line: 7, column: 15 }, undefined]);

    const body = {
      feature: 'custom',
      edit: { filePath: MODEL, line: 12, column: 2 },
      custom: { id: 'acme.boss', values: {}, picks: { at: [{ kind: 'verbatim', sourceIndex: 1 }, { kind: 'point', entity: CORNER }] } },
      preview: true,
    };
    expect((await post(`${base}/apply-feature`, body)).status).toBe(400);
    const { status, body: answer } = await post(`${base}/apply-feature`, { ...body, before: { ...BEFORE, type: 'acme.boss', line: 12 } });
    expect(status).toBe(200);
    expect(answer.preview).toBe('boss([e.endFaces().center(), e.endEdges(0).start()], { height: 8 })');
    expect(slotCalls[0].before).toEqual({ ...BEFORE, type: 'acme.boss', line: 12 });
  });
});
