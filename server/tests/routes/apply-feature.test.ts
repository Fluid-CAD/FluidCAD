import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import express from 'express';
import http from 'http';
import { createApplyFeatureRouter } from '../../src/routes/apply-feature.ts';

let server: http.Server;
let baseUrl: string;

/** Calls the route forwarded to the fake server / extension relay. */
let synthesizeCalls: { feature: string; value: number | undefined }[];
/** The `before` boundary each synthesis call carried, parallel to the calls. */
let synthesizeBoundaries: unknown[];
let relayed: any[];

const fakeSynthesis = {
  ok: true,
  spec: { feature: 'fillet', filePath: '/ws/m.fluid.js', producers: [], parts: [], imports: [] },
  preview: 'fillet(3, e.endEdges())',
  args: 'e.endEdges()',
  alternatives: [],
};

/**
 * Per-test synthesis result; reset to `fakeSynthesis` before each test. An
 * array yields one entry per call, in order (loft synthesizes per face pick).
 */
let currentSynthesis: any;
/** Per-test live buffer; reset to null before each test. */
let currentCode: string | null;
/** Per-test live-buffer file name; reset before each test. */
let currentFileName: string | null;

/** Selection-query calls forwarded to the fake server, with their boundary. */
let queryCalls: { method: string; before: unknown }[];
/** Per-test result for the selection query methods. */
let currentQueryResult: any;

const fakeServer = {
  getCurrentCode: () => currentCode,
  getCurrentFileName: () => currentFileName,
  getParamDefinitions: () => [],
  synthesizeApplyFeature: (
    _picks: unknown, feature: string, value: number | undefined,
    _chains?: unknown, _options?: unknown, before?: unknown,
  ) => {
    synthesizeCalls.push({ feature, value });
    synthesizeBoundaries.push(before);
    if (Array.isArray(currentSynthesis)) {
      return currentSynthesis[Math.min(synthesizeCalls.length, currentSynthesis.length) - 1];
    }
    return currentSynthesis;
  },
  explainSelection: (_picks: unknown, before?: unknown) => {
    queryCalls.push({ method: 'explainSelection', before });
    return currentQueryResult;
  },
  expandTangentChain: (_pick: unknown, before?: unknown) => {
    queryCalls.push({ method: 'expandTangentChain', before });
    return currentQueryResult;
  },
  expandBucket: (_pick: unknown, before?: unknown) => {
    queryCalls.push({ method: 'expandBucket', before });
    return currentQueryResult;
  },
  listSelectionGroups: (_pick: unknown, before?: unknown) => {
    queryCalls.push({ method: 'listSelectionGroups', before });
    return currentQueryResult;
  },
  featureSources: (before: unknown) => {
    queryCalls.push({ method: 'featureSources', before });
    return currentQueryResult;
  },
};

const PICK = { shapeId: 'shape-1', sub: { type: 'face', index: 0 } };

async function post(body: unknown): Promise<{ status: number; body: any }> {
  const res = await fetch(`${baseUrl}/api/apply-feature`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

describe('apply-feature route validation', () => {
  beforeAll(async () => {
    const app = express();
    app.use(express.json());
    app.use('/api', createApplyFeatureRouter(fakeServer as any, (msg) => relayed.push(msg)));

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

  beforeEach(() => {
    synthesizeCalls = [];
    synthesizeBoundaries = [];
    relayed = [];
    currentSynthesis = fakeSynthesis;
    currentCode = null;
    currentFileName = null;
    queryCalls = [];
    currentQueryResult = { ok: true, members: [PICK], groups: [], picks: [] };
  });

  it('rejects an unknown feature', async () => {
    const { status, body } = await post({ feature: 'draft', value: 2, entities: [PICK] });
    expect(status).toBe(400);
    expect(body.error).toContain('"revolve" or "plane"');
  });

  it('rejects a non-positive fillet value', async () => {
    const { status } = await post({ feature: 'fillet', value: -3, entities: [PICK] });
    expect(status).toBe(400);
  });

  it('accepts a negative shell thickness (the hollow-inward idiom)', async () => {
    const { status } = await post({ feature: 'shell', value: -2, entities: [PICK], preview: true });
    expect(status).toBe(200);
    expect(synthesizeCalls).toEqual([{ feature: 'shell', value: -2 }]);
  });

  it('rejects a zero shell thickness', async () => {
    const { status, body } = await post({ feature: 'shell', value: 0, entities: [PICK] });
    expect(status).toBe(400);
    expect(body.error).toContain('nonzero');
  });

  it('rejects an unknown shell join type', async () => {
    const { status, body } = await post({ feature: 'shell', value: -2, entities: [PICK], joinType: 'bevel' });
    expect(status).toBe(400);
    expect(body.error).toContain('joinType');
  });

  it('relays the shell join type on the spec and appends it to the preview', async () => {
    currentSynthesis = {
      ...fakeSynthesis,
      spec: { ...fakeSynthesis.spec, feature: 'shell' },
      preview: 'shell(-2, e.endFaces())',
      args: 'e.endFaces()',
    };
    const { status, body } = await post({ feature: 'shell', value: -2, entities: [PICK], joinType: 'tangent' });
    expect(status).toBe(200);
    expect(body.preview).toBe(`shell(-2, e.endFaces()).join('tangent')`);
    expect(relayed).toHaveLength(1);
    expect(relayed[0].spec.shell).toEqual({ joinType: 'tangent' });
  });

  it('leaves the preview and spec bare for the default arc join type', async () => {
    currentSynthesis = {
      ...fakeSynthesis,
      spec: { ...fakeSynthesis.spec, feature: 'shell' },
      preview: 'shell(-2, e.endFaces())',
      args: 'e.endFaces()',
    };
    const { status, body } = await post({ feature: 'shell', value: -2, entities: [PICK], joinType: 'arc' });
    expect(status).toBe(200);
    expect(body.preview).toBe('shell(-2, e.endFaces())');
    expect(relayed[0].spec.shell).toEqual({ joinType: 'arc' });
  });

  it('accepts sketch without a value and relays the spec to the extension', async () => {
    const { status, body } = await post({ feature: 'sketch', entities: [PICK] });
    expect(status).toBe(200);
    expect(body.success).toBe(true);
    expect(synthesizeCalls).toEqual([{ feature: 'sketch', value: undefined }]);
    expect(relayed).toHaveLength(1);
    expect(relayed[0].type).toBe('apply-feature-edit');
  });

  it('ignores a stray value on sketch instead of validating it', async () => {
    const { status } = await post({ feature: 'sketch', value: -99, entities: [PICK], preview: true });
    expect(status).toBe(200);
    expect(synthesizeCalls).toEqual([{ feature: 'sketch', value: undefined }]);
  });

  it('relays a pick-less sketch as a plane-sketch spec without synthesis', async () => {
    currentFileName = '/ws/m.fluid.js';
    const { status, body } = await post({ feature: 'sketch', entities: [], plane: 'xz' });
    expect(status).toBe(200);
    expect(body.success).toBe(true);
    expect(synthesizeCalls).toEqual([]);
    expect(relayed).toHaveLength(1);
    expect(relayed[0].spec).toEqual({
      feature: 'sketch', sketchPlane: 'xz', filePath: '/ws/m.fluid.js', producers: [], parts: [], imports: [],
    });
  });

  it('previews a pick-less sketch without relaying', async () => {
    currentFileName = '/ws/m.fluid.js';
    const { status, body } = await post({ feature: 'sketch', entities: [], preview: true });
    expect(status).toBe(200);
    expect(body.preview).toContain('sketch(() => {');
    expect(relayed).toHaveLength(0);
  });

  it('previews the picked plane in the statement', async () => {
    currentFileName = '/ws/m.fluid.js';
    const { status, body } = await post({ feature: 'sketch', entities: [], plane: 'yz', preview: true });
    expect(status).toBe(200);
    expect(body.preview).toContain(`sketch('yz', () => {`);
  });

  it('rejects an unknown plane on a pick-less sketch', async () => {
    currentFileName = '/ws/m.fluid.js';
    const { status, body } = await post({ feature: 'sketch', entities: [], plane: 'top' });
    expect(status).toBe(400);
    expect(body.error).toContain('plane');
    expect(relayed).toHaveLength(0);
  });

  it('refuses a pick-less sketch before any render', async () => {
    const { status, body } = await post({ feature: 'sketch', entities: [] });
    expect(status).toBe(404);
    expect(body.reason).toBe('No rendered scene');
    expect(relayed).toHaveLength(0);
  });

  it('relays a plane-feature sketch as a sketch-on-plane spec without synthesis', async () => {
    const { status, body } = await post({
      feature: 'sketch', entities: [],
      planeRef: { filePath: '/ws/m.fluid.js', line: 3, column: 0 },
    });
    expect(status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.preview).toContain('sketch(p, () => {');
    expect(synthesizeCalls).toEqual([]);
    expect(relayed).toHaveLength(1);
    expect(relayed[0].spec).toEqual({
      feature: 'sketch', sketchOnPlane: true, filePath: '/ws/m.fluid.js',
      producers: [{ line: 3, column: 0, featureType: 'plane', nameHint: 'p', bind: true }],
      parts: [], imports: [],
    });
  });

  it('previews a plane-feature sketch with the plane variable name', async () => {
    currentCode = [
      `import { plane } from 'fluidcad/core'`,
      ``,
      `const top = plane('xy', 20)`,
      ``,
    ].join('\n');
    const { status, body } = await post({
      feature: 'sketch', entities: [], preview: true,
      planeRef: { filePath: '/ws/m.fluid.js', line: 3, column: 0 },
    });
    expect(status).toBe(200);
    expect(body.preview).toContain('sketch(top, () => {');
    expect(relayed).toHaveLength(0);
  });

  it('rejects a malformed planeRef on a pick-less sketch', async () => {
    const { status, body } = await post({ feature: 'sketch', entities: [], planeRef: { line: 3 } });
    expect(status).toBe(400);
    expect(body.error).toContain('planeRef');
    expect(relayed).toHaveLength(0);
  });

  it('rejects a pick-less sketch carrying both plane and planeRef', async () => {
    const { status, body } = await post({
      feature: 'sketch', entities: [], plane: 'xz',
      planeRef: { filePath: '/ws/m.fluid.js', line: 3, column: 0 },
    });
    expect(status).toBe(400);
    expect(body.error).toContain('mutually exclusive');
    expect(relayed).toHaveLength(0);
  });

  it('still rejects empty picks for the other features', async () => {
    const { status } = await post({ feature: 'fillet', value: 3, entities: [] });
    expect(status).toBe(400);
  });

  const PROFILE = { mode: 'active', filePath: '/ws/m.fluid.js', line: 3, column: 0 };

  it('relays an extrude spec without touching pick synthesis', async () => {
    const { status, body } = await post({
      feature: 'extrude', op: 'add', distance: 25, thin: null, profile: PROFILE,
    });
    expect(status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.preview).toBe('extrude(25)');
    expect(synthesizeCalls).toEqual([]);
    expect(relayed).toHaveLength(1);
    expect(relayed[0].spec).toMatchObject({
      feature: 'extrude',
      extrude: { op: 'add', distance: 25, thin: null, profile: 'implicit' },
      producers: [{ line: 3, featureType: 'sketch', bind: false }],
      parts: [],
    });
  });

  it('previews a through-all remove as cut() without relaying', async () => {
    const { status, body } = await post({
      feature: 'extrude', op: 'remove', distance: null, profile: PROFILE, preview: true,
    });
    expect(status).toBe(200);
    expect(body.preview).toBe('cut()');
    expect(relayed).toHaveLength(0);
  });

  it('previews thin and new chains', async () => {
    const { body } = await post({
      feature: 'extrude', op: 'new', distance: 10, thin: [2], profile: PROFILE, preview: true,
    });
    expect(body.preview).toBe('extrude(10).thin(2).new()');
  });

  it('previews a two-distance extrude', async () => {
    const { body } = await post({
      feature: 'extrude', op: 'add', distance: 10, distance2: 20, profile: PROFILE, preview: true,
    });
    expect(body.preview).toBe('extrude(10, 20)');
  });

  it('previews symmetric, draft and drill chains', async () => {
    const { body } = await post({
      feature: 'extrude', op: 'add', distance: 30, symmetric: true, draft: 5, drill: false,
      profile: PROFILE, preview: true,
    });
    expect(body.preview).toBe('extrude(30).symmetric().draft(5).drill(false)');
  });

  it('rejects a two-distance symmetric extrude', async () => {
    const { status, body } = await post({
      feature: 'extrude', op: 'add', distance: 10, distance2: 20, symmetric: true, profile: PROFILE,
    });
    expect(status).toBe(400);
    expect(body.error).toContain('symmetric');
  });

  it('rejects a two-distance through-all remove', async () => {
    const { status, body } = await post({
      feature: 'extrude', op: 'remove', distance: null, distance2: 20, profile: PROFILE,
    });
    expect(status).toBe(400);
    expect(body.error).toContain('through-all');
  });

  it('rejects a zero draft angle', async () => {
    const { status } = await post({
      feature: 'extrude', op: 'add', distance: 10, draft: 0, profile: PROFILE,
    });
    expect(status).toBe(400);
  });

  it('binds a bound profile and falls back to the hint name without a code buffer', async () => {
    const { body } = await post({
      feature: 'extrude', op: 'add', distance: 25, profile: { ...PROFILE, mode: 'bound' },
    });
    expect(body.preview).toBe('extrude(25, s)');
    expect(relayed[0].spec.extrude.profile).toBe('bound');
    expect(relayed[0].spec.producers[0].bind).toBe(true);
  });

  it('rejects a through-all add', async () => {
    const { status, body } = await post({
      feature: 'extrude', op: 'add', distance: null, profile: PROFILE,
    });
    expect(status).toBe(400);
    expect(body.error).toContain('through-all');
  });

  it('rejects a zero distance', async () => {
    const { status } = await post({ feature: 'extrude', op: 'add', distance: 0, profile: PROFILE });
    expect(status).toBe(400);
  });

  it('rejects malformed thin offsets', async () => {
    const { status } = await post({
      feature: 'extrude', op: 'add', distance: 25, thin: [0], profile: PROFILE,
    });
    expect(status).toBe(400);
  });

  it('rejects a profile without a source line', async () => {
    const { status, body } = await post({
      feature: 'extrude', op: 'add', distance: 25, profile: { mode: 'active', filePath: '/ws/m.fluid.js' },
    });
    expect(status).toBe(400);
    expect(body.error).toContain('profile');
  });

  const TO_FACE = { shapeId: 'shape-1', sub: { type: 'face', index: 2 } };
  const toFaceSynthesis = {
    ok: true,
    spec: {
      feature: 'extrude',
      filePath: '/ws/m.fluid.js',
      producers: [{ line: 4, column: 0, featureType: 'extrude', nameHint: 'e', bind: true }],
      parts: [{ producer: 0, accessor: 'endFaces', indices: null, filterArgs: null }],
      imports: [],
    },
    preview: 'extrude(e.endFaces())',
    args: 'e.endFaces()',
    alternatives: [],
  };

  it('synthesizes a to-face target and renders it in place of the distance', async () => {
    currentSynthesis = toFaceSynthesis;
    const { status, body } = await post({
      feature: 'extrude', op: 'add', distance: null, profile: PROFILE, toFace: TO_FACE,
    });
    expect(status).toBe(200);
    expect(body.preview).toBe('extrude(e.endFaces())');
    expect(synthesizeCalls).toEqual([{ feature: 'extrude', value: undefined }]);
    expect(relayed[0].spec).toMatchObject({
      feature: 'extrude',
      extrude: { op: 'add', distance: null, profile: 'implicit', toFace: true },
      producers: [
        { line: 3, featureType: 'sketch', bind: false },
        { line: 4, featureType: 'extrude', bind: true },
      ],
      parts: [{ producer: 1, accessor: 'endFaces' }],
    });
  });

  it('previews a bound-profile to-face remove as cut(<face>, s)', async () => {
    currentSynthesis = toFaceSynthesis;
    const { body } = await post({
      feature: 'extrude', op: 'remove', profile: { ...PROFILE, mode: 'bound' },
      toFace: TO_FACE, preview: true,
    });
    expect(body.preview).toBe('cut(e.endFaces(), s)');
    expect(relayed).toHaveLength(0);
  });

  it('rejects a to-face extrude carrying a distance', async () => {
    const { status, body } = await post({
      feature: 'extrude', op: 'add', distance: 25, profile: PROFILE, toFace: TO_FACE,
    });
    expect(status).toBe(400);
    expect(body.error).toContain('to-face');
  });

  it('rejects a symmetric to-face extrude', async () => {
    const { status, body } = await post({
      feature: 'extrude', op: 'add', symmetric: true, profile: PROFILE, toFace: TO_FACE,
    });
    expect(status).toBe(400);
    expect(body.error).toContain('symmetric');
  });

  it('rejects an edge pick as the to-face target', async () => {
    const { status, body } = await post({
      feature: 'extrude', op: 'add', profile: PROFILE,
      toFace: { shapeId: 'shape-1', sub: { type: 'edge', index: 0 } },
    });
    expect(status).toBe(400);
    expect(body.error).toContain('toFace');
  });

  it('refuses a multi-part to-face synthesis', async () => {
    currentSynthesis = {
      ...toFaceSynthesis,
      spec: {
        ...toFaceSynthesis.spec,
        parts: [
          { producer: 0, accessor: 'endFaces', indices: null, filterArgs: null },
          { producer: 0, accessor: 'startFaces', indices: null, filterArgs: null },
        ],
      },
    };
    const { status, body } = await post({
      feature: 'extrude', op: 'add', profile: PROFILE, toFace: TO_FACE,
    });
    expect(status).toBe(422);
    expect(body.reason).toContain('single face');
  });

  it('refuses a to-face target from a different file than the profile', async () => {
    currentSynthesis = { ...toFaceSynthesis, spec: { ...toFaceSynthesis.spec, filePath: '/ws/other.fluid.js' } };
    const { status, body } = await post({
      feature: 'extrude', op: 'add', profile: PROFILE, toFace: TO_FACE,
    });
    expect(status).toBe(422);
    expect(body.reason).toContain('different files');
  });

  it('relays the synthesis refusal for an unsynthesizable to-face target', async () => {
    currentSynthesis = { ok: false, reason: 'that face has no stable selector', pick: TO_FACE };
    const { status, body } = await post({
      feature: 'extrude', op: 'add', profile: PROFILE, toFace: TO_FACE,
    });
    expect(status).toBe(422);
    expect(body.reason).toContain('stable selector');
  });

  const SWEEP_PROFILE = { mode: 'active', filePath: '/ws/m.fluid.js', line: 7, column: 0 };
  const SWEEP_PATH = { kind: 'sketch', filePath: '/ws/m.fluid.js', line: 3, column: 0 };

  it('relays a sketch-path sweep with an implicit profile', async () => {
    const { status, body } = await post({
      feature: 'sweep', op: 'add', thin: null, profile: SWEEP_PROFILE, path: SWEEP_PATH,
    });
    expect(status).toBe(200);
    expect(body.preview).toBe('sweep(p)');
    expect(synthesizeCalls).toEqual([]);
    expect(relayed[0].spec).toMatchObject({
      feature: 'sweep',
      sweep: { op: 'add', profile: 'implicit', path: { kind: 'sketch', producer: 0 } },
      producers: [
        { line: 3, featureType: 'sketch', nameHint: 'p', bind: true },
        { line: 7, featureType: 'sketch', nameHint: 's', bind: false },
      ],
      parts: [],
    });
  });

  it('previews a bound-profile sweep with thin and remove chains', async () => {
    const { body } = await post({
      feature: 'sweep', op: 'remove', thin: [2],
      profile: { ...SWEEP_PROFILE, mode: 'bound' }, path: SWEEP_PATH, preview: true,
    });
    expect(body.preview).toBe('sweep(p, s).thin(2).remove()');
    expect(relayed).toHaveLength(0);
  });

  it('synthesizes an edges path and merges producers ahead of the profile', async () => {
    currentSynthesis = {
      ok: true,
      spec: {
        feature: 'sweep',
        filePath: '/ws/m.fluid.js',
        producers: [{ line: 4, column: 0, featureType: 'extrude', nameHint: 'e', bind: true }],
        parts: [{ producer: 0, accessor: 'endEdges', indices: null, filterArgs: null }],
        imports: [],
      },
      preview: 'sweep(e.endEdges())',
      args: 'e.endEdges()',
      alternatives: [],
    };
    const { status, body } = await post({
      feature: 'sweep', op: 'new', profile: SWEEP_PROFILE,
      path: { kind: 'edges', entities: [{ shapeId: 'shape-1', sub: { type: 'edge', index: 2 } }] },
    });
    expect(status).toBe(200);
    expect(body.preview).toBe('sweep(e.endEdges()).new()');
    expect(synthesizeCalls).toEqual([{ feature: 'sweep', value: undefined }]);
    expect(relayed[0].spec).toMatchObject({
      feature: 'sweep',
      sweep: { op: 'new', profile: 'implicit', path: { kind: 'selector' } },
      producers: [
        { line: 4, featureType: 'extrude', bind: true },
        { line: 7, featureType: 'sketch', bind: false },
      ],
      parts: [{ producer: 0, accessor: 'endEdges' }],
    });
  });

  it('refuses a multi-part edges path', async () => {
    currentSynthesis = {
      ok: true,
      spec: {
        feature: 'sweep',
        filePath: '/ws/m.fluid.js',
        producers: [{ line: 4, column: 0, featureType: 'extrude', nameHint: 'e', bind: true }],
        parts: [
          { producer: 0, accessor: 'endEdges', indices: null, filterArgs: null },
          { producer: 0, accessor: 'sideEdges', indices: null, filterArgs: null },
        ],
        imports: [],
      },
      preview: '', args: '', alternatives: [],
    };
    const { status, body } = await post({
      feature: 'sweep', op: 'add', profile: SWEEP_PROFILE,
      path: { kind: 'edges', entities: [{ shapeId: 'shape-1', sub: { type: 'edge', index: 2 } }] },
    });
    expect(status).toBe(422);
    expect(body.reason).toContain('single selection');
    expect(relayed).toHaveLength(0);
  });

  it('rejects the same sketch as profile and path', async () => {
    const { status, body } = await post({
      feature: 'sweep', op: 'add', profile: SWEEP_PROFILE,
      path: { ...SWEEP_PATH, line: SWEEP_PROFILE.line },
    });
    expect(status).toBe(400);
    expect(body.error).toContain('different sketches');
  });

  const WRAP_SKETCH = { filePath: '/ws/m.fluid.js', line: 5, column: 0 };
  const WRAP_FACE = { shapeId: 'shape-1', sub: { type: 'face', index: 3 } };
  const wrapSynthesis = {
    ok: true,
    spec: {
      feature: 'wrap',
      filePath: '/ws/m.fluid.js',
      producers: [{ line: 4, column: 0, featureType: 'extrude', nameHint: 'e', bind: true }],
      parts: [{ producer: 0, accessor: 'sideFaces', indices: [0], filterArgs: null }],
      imports: [],
    },
    preview: 'wrap(e.sideFaces(0))',
    args: 'e.sideFaces(0)',
    alternatives: [],
  };

  it('synthesizes the wrap target and binds the sketch ahead of it', async () => {
    currentSynthesis = wrapSynthesis;
    const { status, body } = await post({
      feature: 'wrap', op: 'add', thickness: 2, sketch: WRAP_SKETCH, face: WRAP_FACE,
    });
    expect(status).toBe(200);
    expect(body.preview).toBe('wrap(2, s, e.sideFaces(0))');
    expect(synthesizeCalls).toEqual([{ feature: 'wrap', value: undefined }]);
    expect(relayed[0].spec).toMatchObject({
      feature: 'wrap',
      wrap: { op: 'add', thickness: 2, sketch: { producer: 0 } },
      producers: [
        { line: 5, featureType: 'sketch', nameHint: 's', bind: true },
        { line: 4, featureType: 'extrude', bind: true },
      ],
      parts: [{ producer: 1, accessor: 'sideFaces', indices: [0] }],
    });
  });

  it('previews a deboss wrap without relaying', async () => {
    currentSynthesis = wrapSynthesis;
    const { body } = await post({
      feature: 'wrap', op: 'remove', thickness: 1.5, sketch: WRAP_SKETCH, face: WRAP_FACE, preview: true,
    });
    expect(body.preview).toBe('wrap(1.5, s, e.sideFaces(0)).remove()');
    expect(relayed).toHaveLength(0);
  });

  it('rejects a non-positive wrap thickness', async () => {
    const { status, body } = await post({
      feature: 'wrap', op: 'add', thickness: 0, sketch: WRAP_SKETCH, face: WRAP_FACE,
    });
    expect(status).toBe(400);
    expect(body.error).toContain('thickness');
  });

  it('rejects an edge pick as the wrap target', async () => {
    const { status, body } = await post({
      feature: 'wrap', op: 'add', thickness: 2, sketch: WRAP_SKETCH,
      face: { shapeId: 'shape-1', sub: { type: 'edge', index: 0 } },
    });
    expect(status).toBe(400);
    expect(body.error).toContain('face');
  });

  it('refuses a multi-part wrap synthesis', async () => {
    currentSynthesis = {
      ...wrapSynthesis,
      spec: {
        ...wrapSynthesis.spec,
        parts: [
          { producer: 0, accessor: 'sideFaces', indices: [0], filterArgs: null },
          { producer: 0, accessor: 'sideFaces', indices: [1], filterArgs: null },
        ],
      },
    };
    const { status, body } = await post({
      feature: 'wrap', op: 'add', thickness: 2, sketch: WRAP_SKETCH, face: WRAP_FACE,
    });
    expect(status).toBe(422);
    expect(body.reason).toContain('single face');
    expect(relayed).toHaveLength(0);
  });

  it('refuses a wrap target from a different file than the sketch', async () => {
    currentSynthesis = { ...wrapSynthesis, spec: { ...wrapSynthesis.spec, filePath: '/ws/other.fluid.js' } };
    const { status, body } = await post({
      feature: 'wrap', op: 'add', thickness: 2, sketch: WRAP_SKETCH, face: WRAP_FACE,
    });
    expect(status).toBe(422);
    expect(body.reason).toContain('different files');
  });

  const REVOLVE_PROFILE = { mode: 'active', filePath: '/ws/m.fluid.js', line: 7, column: 0 };

  it('relays a standard-axis revolve with an implicit profile', async () => {
    const { status, body } = await post({
      feature: 'revolve', op: 'add', angle: 360, thin: null,
      profile: REVOLVE_PROFILE, axis: { kind: 'standard', axis: 'z' },
    });
    expect(status).toBe(200);
    expect(body.preview).toBe(`revolve('z')`);
    expect(synthesizeCalls).toEqual([]);
    expect(relayed[0].spec).toMatchObject({
      feature: 'revolve',
      revolve: { op: 'add', angle: 360, profile: 'implicit', axis: { kind: 'standard', axis: 'z' } },
      producers: [{ line: 7, featureType: 'sketch', nameHint: 's', bind: false }],
      parts: [],
    });
  });

  it('previews a bound-profile partial revolve with thin and remove chains', async () => {
    const { body } = await post({
      feature: 'revolve', op: 'remove', angle: 90, thin: [2],
      profile: { ...REVOLVE_PROFILE, mode: 'bound' }, axis: { kind: 'standard', axis: 'x' },
      preview: true,
    });
    expect(body.preview).toBe(`revolve('x', 90, s).thin(2).remove()`);
    expect(relayed).toHaveLength(0);
  });

  it('relays an axis-statement revolve binding the axis after the profile', async () => {
    const { status, body } = await post({
      feature: 'revolve', op: 'add', angle: 360,
      profile: REVOLVE_PROFILE, axis: { kind: 'axis', filePath: '/ws/m.fluid.js', line: 3, column: 0 },
    });
    expect(status).toBe(200);
    expect(body.preview).toBe('revolve(a)');
    expect(synthesizeCalls).toEqual([]);
    expect(relayed[0].spec).toMatchObject({
      feature: 'revolve',
      revolve: { op: 'add', profile: 'implicit', axis: { kind: 'axis', producer: 1 } },
      producers: [
        { line: 7, featureType: 'sketch', nameHint: 's', bind: false },
        { line: 3, featureType: 'axis', nameHint: 'a', bind: true },
      ],
      parts: [],
    });
  });

  it('synthesizes an edge axis and wraps it in axis()', async () => {
    currentSynthesis = {
      ok: true,
      spec: {
        feature: 'revolve',
        filePath: '/ws/m.fluid.js',
        producers: [{ line: 4, column: 0, featureType: 'extrude', nameHint: 'e', bind: true }],
        parts: [{ producer: 0, accessor: 'endEdges', indices: [2], filterArgs: null }],
        imports: [],
      },
      preview: 'revolve(axis(e.endEdges(2)))',
      args: 'e.endEdges(2)',
      alternatives: [],
    };
    const { status, body } = await post({
      feature: 'revolve', op: 'new', angle: 360, profile: REVOLVE_PROFILE,
      axis: { kind: 'edge', entity: { shapeId: 'shape-1', sub: { type: 'edge', index: 2 } } },
    });
    expect(status).toBe(200);
    expect(body.preview).toBe('revolve(axis(e.endEdges(2))).new()');
    expect(synthesizeCalls).toEqual([{ feature: 'revolve', value: undefined }]);
    expect(relayed[0].spec).toMatchObject({
      feature: 'revolve',
      revolve: { op: 'new', profile: 'implicit', axis: { kind: 'selector' } },
      producers: [
        { line: 7, featureType: 'sketch', bind: false },
        { line: 4, featureType: 'extrude', bind: true },
      ],
      parts: [{ producer: 1, accessor: 'endEdges' }],
      imports: ['axis'],
    });
  });

  it('refuses a multi-part axis synthesis', async () => {
    currentSynthesis = {
      ok: true,
      spec: {
        feature: 'revolve',
        filePath: '/ws/m.fluid.js',
        producers: [{ line: 4, column: 0, featureType: 'extrude', nameHint: 'e', bind: true }],
        parts: [
          { producer: 0, accessor: 'endEdges', indices: null, filterArgs: null },
          { producer: 0, accessor: 'sideEdges', indices: null, filterArgs: null },
        ],
        imports: [],
      },
      preview: '', args: '', alternatives: [],
    };
    const { status, body } = await post({
      feature: 'revolve', op: 'add', angle: 360, profile: REVOLVE_PROFILE,
      axis: { kind: 'edge', entity: { shapeId: 'shape-1', sub: { type: 'edge', index: 2 } } },
    });
    expect(status).toBe(422);
    expect(body.reason).toContain('single edge');
    expect(relayed).toHaveLength(0);
  });

  it('rejects a face pick as the axis edge', async () => {
    const { status, body } = await post({
      feature: 'revolve', op: 'add', angle: 360, profile: REVOLVE_PROFILE,
      axis: { kind: 'edge', entity: { shapeId: 'shape-1', sub: { type: 'face', index: 0 } } },
    });
    expect(status).toBe(400);
    expect(body.error).toContain('edge');
  });

  it('rejects a zero angle', async () => {
    const { status, body } = await post({
      feature: 'revolve', op: 'add', angle: 0, profile: REVOLVE_PROFILE,
      axis: { kind: 'standard', axis: 'z' },
    });
    expect(status).toBe(400);
    expect(body.error).toContain('angle');
  });

  it('rejects an axis statement from a different file than the profile', async () => {
    const { status, body } = await post({
      feature: 'revolve', op: 'add', angle: 360, profile: REVOLVE_PROFILE,
      axis: { kind: 'axis', filePath: '/ws/other.fluid.js', line: 3, column: 0 },
    });
    expect(status).toBe(400);
    expect(body.error).toContain('different files');
  });

  const LOFT_S1 = { kind: 'sketch', filePath: '/ws/m.fluid.js', line: 3, column: 0 };
  const LOFT_S2 = { kind: 'sketch', filePath: '/ws/m.fluid.js', line: 4, column: 0 };
  const loftFace = (index: number, shapeId = 'shape-1') =>
    ({ kind: 'face', entity: { shapeId, sub: { type: 'face', index } } });

  /** One per-pick synthesis result: a single-part face selector. */
  const loftSynthesis = (accessor: string, line = 5) => ({
    ok: true,
    spec: {
      feature: 'loft',
      filePath: '/ws/m.fluid.js',
      producers: [{ line, column: 0, featureType: 'extrude', nameHint: 'e', bind: true }],
      parts: [{ producer: 0, accessor, indices: null, filterArgs: null }],
      imports: [],
    },
    preview: '', args: '', alternatives: [],
  });

  it('relays a two-sketch loft with ordered bound profiles', async () => {
    const { status, body } = await post({
      feature: 'loft', op: 'add', thin: null, profiles: [LOFT_S1, LOFT_S2],
    });
    expect(status).toBe(200);
    expect(body.preview).toBe('loft(s, s2)');
    expect(synthesizeCalls).toEqual([]);
    expect(relayed[0].spec).toMatchObject({
      feature: 'loft',
      loft: {
        op: 'add',
        profiles: [{ kind: 'sketch', producer: 0 }, { kind: 'sketch', producer: 1 }],
      },
      producers: [
        { line: 3, featureType: 'sketch', nameHint: 's', bind: true },
        { line: 4, featureType: 'sketch', nameHint: 's', bind: true },
      ],
      parts: [],
    });
  });

  it('previews loft thin and remove chains without relaying', async () => {
    const { body } = await post({
      feature: 'loft', op: 'remove', thin: [2], profiles: [LOFT_S1, LOFT_S2], preview: true,
    });
    expect(body.preview).toBe('loft(s, s2).thin(2).remove()');
    expect(relayed).toHaveLength(0);
  });

  it('synthesizes face profiles one pick at a time and merges shared producers', async () => {
    currentSynthesis = [loftSynthesis('endFaces'), loftSynthesis('startFaces')];
    const { status, body } = await post({
      feature: 'loft', op: 'add', thin: null,
      profiles: [LOFT_S1, loftFace(0), loftFace(1)],
    });
    expect(status).toBe(200);
    expect(synthesizeCalls).toEqual([
      { feature: 'loft', value: undefined },
      { feature: 'loft', value: undefined },
    ]);
    expect(body.preview).toBe('loft(s, e.endFaces(), e.startFaces())');
    expect(relayed[0].spec).toMatchObject({
      feature: 'loft',
      loft: {
        profiles: [
          { kind: 'sketch', producer: 0 },
          { kind: 'selector', part: 0 },
          { kind: 'selector', part: 1 },
        ],
      },
      producers: [
        { line: 3, featureType: 'sketch', bind: true },
        { line: 5, featureType: 'extrude', bind: true },
      ],
      parts: [
        { producer: 1, accessor: 'endFaces' },
        { producer: 1, accessor: 'startFaces' },
      ],
    });
  });

  it('suffixes distinct face producers past the shared hint', async () => {
    currentSynthesis = [loftSynthesis('endFaces', 5), loftSynthesis('endFaces', 9)];
    const { body } = await post({
      feature: 'loft', op: 'add', thin: null,
      profiles: [loftFace(0), loftFace(1, 'shape-2')], preview: true,
    });
    expect(body.preview).toBe('loft(e.endFaces(), e2.endFaces())');
  });

  it('refuses a sketch profile from a different file than a preceding face pick', async () => {
    currentSynthesis = loftSynthesis('endFaces');
    const { status, body } = await post({
      feature: 'loft', op: 'add', thin: null,
      profiles: [loftFace(0), { ...LOFT_S1, filePath: '/ws/other.fluid.js' }],
    });
    expect(status).toBe(422);
    expect(body.reason).toContain('different files');
    expect(relayed).toHaveLength(0);
  });

  it('refuses a multi-part face synthesis', async () => {
    const twoParts = loftSynthesis('endFaces');
    twoParts.spec.parts.push({ producer: 0, accessor: 'startFaces', indices: null, filterArgs: null });
    currentSynthesis = twoParts;
    const { status, body } = await post({
      feature: 'loft', op: 'add', thin: null, profiles: [LOFT_S1, loftFace(0)],
    });
    expect(status).toBe(422);
    expect(body.reason).toContain('single face selection');
    expect(relayed).toHaveLength(0);
  });

  it('rejects a duplicated sketch profile', async () => {
    const { status, body } = await post({
      feature: 'loft', op: 'add', thin: null, profiles: [LOFT_S1, LOFT_S1],
    });
    expect(status).toBe(400);
    expect(body.error).toContain('different sketch');
  });

  it('rejects the same face picked twice', async () => {
    const { status, body } = await post({
      feature: 'loft', op: 'add', thin: null, profiles: [loftFace(0), loftFace(0)],
    });
    expect(status).toBe(400);
    expect(body.error).toContain('picked twice');
  });

  it('rejects fewer than two profiles', async () => {
    const { status, body } = await post({
      feature: 'loft', op: 'add', thin: null, profiles: [LOFT_S1],
    });
    expect(status).toBe(400);
    expect(body.error).toContain('2-');
  });

  it('rejects an edge pick as a loft profile', async () => {
    const { status } = await post({
      feature: 'loft', op: 'add', thin: null,
      profiles: [LOFT_S1, { kind: 'face', entity: { shapeId: 'shape-1', sub: { type: 'edge', index: 0 } } }],
    });
    expect(status).toBe(400);
  });

  const LOFT_GUIDE = { filePath: '/ws/m.fluid.js', line: 6, column: 0 };

  it('relays guides as bound producers and previews the .guides chain', async () => {
    const { status, body } = await post({
      feature: 'loft', op: 'add', thin: null,
      profiles: [LOFT_S1, LOFT_S2], guides: [LOFT_GUIDE],
    });
    expect(status).toBe(200);
    expect(body.preview).toBe('loft(s, s2).guides(g)');
    expect(synthesizeCalls).toEqual([]);
    expect(relayed[0].spec).toMatchObject({
      feature: 'loft',
      loft: {
        profiles: [{ kind: 'sketch', producer: 0 }, { kind: 'sketch', producer: 1 }],
        guides: [{ kind: 'sketch', producer: 2 }],
      },
      producers: [
        { line: 3, nameHint: 's', bind: true },
        { line: 4, nameHint: 's', bind: true },
        { line: 6, featureType: 'sketch', nameHint: 'g', bind: true },
      ],
    });
  });

  it('previews condition chains, omitting the default magnitude', async () => {
    const { body } = await post({
      feature: 'loft', op: 'add', thin: null, profiles: [LOFT_S1, LOFT_S2],
      startCondition: { type: 'normal', magnitude: 1 },
      endCondition: { type: 'tangent', magnitude: 2 },
      preview: true,
    });
    expect(body.preview).toBe(`loft(s, s2).startCondition('normal').endCondition('tangent', 2)`);
    expect(relayed).toHaveLength(0);
  });

  it('rejects guides combined with thin walls', async () => {
    const { status, body } = await post({
      feature: 'loft', op: 'add', thin: [2],
      profiles: [LOFT_S1, LOFT_S2], guides: [LOFT_GUIDE],
    });
    expect(status).toBe(400);
    expect(body.error).toContain('thin walls');
  });

  it('rejects a guide duplicating a profile sketch', async () => {
    const { status, body } = await post({
      feature: 'loft', op: 'add', thin: null,
      profiles: [LOFT_S1, LOFT_S2], guides: [{ ...LOFT_GUIDE, line: LOFT_S1.line }],
    });
    expect(status).toBe(400);
    expect(body.error).toContain('different sketch');
  });

  it('rejects more than two guides', async () => {
    const { status, body } = await post({
      feature: 'loft', op: 'add', thin: null, profiles: [LOFT_S1, LOFT_S2],
      guides: [6, 7, 8].map(line => ({ ...LOFT_GUIDE, line })),
    });
    expect(status).toBe(400);
    expect(body.error).toContain('at most two');
  });

  it('rejects a guide from a different file than the profiles', async () => {
    const { status, body } = await post({
      feature: 'loft', op: 'add', thin: null, profiles: [LOFT_S1, LOFT_S2],
      guides: [{ ...LOFT_GUIDE, filePath: '/ws/other.fluid.js' }],
    });
    expect(status).toBe(400);
    expect(body.error).toContain('different file');
  });

  it('rejects a zero condition magnitude', async () => {
    const { status, body } = await post({
      feature: 'loft', op: 'add', thin: null, profiles: [LOFT_S1, LOFT_S2],
      startCondition: { type: 'normal', magnitude: 0 },
    });
    expect(status).toBe(400);
    expect(body.error).toContain('nonzero');
  });

  it('rejects an unknown condition type', async () => {
    const { status, body } = await post({
      feature: 'loft', op: 'add', thin: null, profiles: [LOFT_S1, LOFT_S2],
      endCondition: { type: 'smooth', magnitude: 1 },
    });
    expect(status).toBe(400);
    expect(body.error).toContain('"normal" or "tangent"');
  });

  /** One per-pick plane synthesis result: a single-part selector. */
  const planeSynthesis = (accessor: string, line = 5) => ({
    ok: true,
    spec: {
      feature: 'plane',
      filePath: '/ws/m.fluid.js',
      producers: [{ line, column: 0, featureType: 'extrude', nameHint: 'e', bind: true }],
      parts: [{ producer: 0, accessor, indices: null, filterArgs: null }],
      imports: [],
    },
    preview: '', args: '', alternatives: [],
  });
  const planePick = (index: number, type = 'face', shapeId = 'shape-1') =>
    ({ kind: 'pick', entity: { shapeId, sub: { type, index } } });

  it('relays a standard-base offset plane without synthesis', async () => {
    currentFileName = '/ws/m.fluid.js';
    const { status, body } = await post({
      feature: 'plane', type: 'offset', offset: 10,
      bases: [{ kind: 'standard', plane: 'xy' }],
    });
    expect(status).toBe(200);
    expect(body.preview).toBe(`plane('xy', 10)`);
    expect(synthesizeCalls).toEqual([]);
    expect(relayed[0].spec).toMatchObject({
      feature: 'plane',
      filePath: '/ws/m.fluid.js',
      plane: { type: 'offset', offset: 10, bases: [{ kind: 'standard', plane: 'xy' }] },
      producers: [],
      parts: [],
    });
  });

  it('404s a standard-only plane without a rendered scene', async () => {
    const { status } = await post({
      feature: 'plane', type: 'offset', offset: 10,
      bases: [{ kind: 'standard', plane: 'xy' }],
    });
    expect(status).toBe(404);
  });

  it('previews plane rotation options without relaying', async () => {
    currentFileName = '/ws/m.fluid.js';
    const { body } = await post({
      feature: 'plane', type: 'offset', offset: 10, rotateX: 15,
      bases: [{ kind: 'standard', plane: 'xz' }], preview: true,
    });
    expect(body.preview).toBe(`plane('xz', { offset: 10, rotateX: 15 })`);
    expect(relayed).toHaveLength(0);
  });

  it('synthesizes a picked plane base and renders the offset form', async () => {
    currentSynthesis = planeSynthesis('endFaces');
    const { status, body } = await post({
      feature: 'plane', type: 'offset', offset: 5, bases: [planePick(0)],
    });
    expect(status).toBe(200);
    expect(synthesizeCalls).toEqual([{ feature: 'plane', value: undefined }]);
    expect(body.preview).toBe('plane(e.endFaces(), 5)');
    expect(relayed[0].spec).toMatchObject({
      feature: 'plane',
      plane: { bases: [{ kind: 'selector', part: 0 }] },
      producers: [{ line: 5, featureType: 'extrude', bind: true }],
      parts: [{ producer: 0, accessor: 'endFaces' }],
    });
  });

  it('wraps picked bases in a mid plane and merges shared producers', async () => {
    currentSynthesis = [planeSynthesis('endFaces'), planeSynthesis('startFaces')];
    const { status, body } = await post({
      feature: 'plane', type: 'mid',
      bases: [planePick(0), planePick(1)],
    });
    expect(status).toBe(200);
    expect(synthesizeCalls).toHaveLength(2);
    expect(body.preview).toBe('plane(plane(e.endFaces()), plane(e.startFaces()))');
    expect(relayed[0].spec).toMatchObject({
      plane: { type: 'mid', bases: [{ kind: 'selector', part: 0 }, { kind: 'selector', part: 1 }] },
      producers: [{ line: 5, featureType: 'extrude', bind: true }],
      parts: [{ producer: 0, accessor: 'endFaces' }, { producer: 0, accessor: 'startFaces' }],
    });
  });

  it('binds existing plane features as mid bases', async () => {
    const { status, body } = await post({
      feature: 'plane', type: 'mid', rotateY: 30,
      bases: [
        { kind: 'plane', filePath: '/ws/m.fluid.js', line: 3, column: 0 },
        { kind: 'plane', filePath: '/ws/m.fluid.js', line: 4, column: 0 },
      ],
    });
    expect(status).toBe(200);
    expect(body.preview).toBe(`plane(p, p2, { rotateY: 30 })`);
    expect(synthesizeCalls).toEqual([]);
    expect(relayed[0].spec).toMatchObject({
      plane: { type: 'mid', bases: [{ kind: 'plane', producer: 0 }, { kind: 'plane', producer: 1 }] },
      producers: [
        { line: 3, featureType: 'plane', nameHint: 'p', bind: true },
        { line: 4, featureType: 'plane', nameHint: 'p', bind: true },
      ],
    });
  });

  it('synthesizes an edge plane with its position', async () => {
    currentSynthesis = planeSynthesis('sideEdges');
    const { status, body } = await post({
      feature: 'plane', type: 'edge', position: 0.5, bases: [planePick(2, 'edge')],
    });
    expect(status).toBe(200);
    expect(body.preview).toBe('plane(e.sideEdges(), 0.5)');
    expect(relayed[0].spec).toMatchObject({
      plane: { type: 'edge', position: 0.5, bases: [{ kind: 'selector', part: 0 }] },
    });
  });

  it('rejects an edge plane without a position', async () => {
    const { status, body } = await post({
      feature: 'plane', type: 'edge', bases: [planePick(2, 'edge')],
    });
    expect(status).toBe(400);
    expect(body.error).toContain('position');
  });

  it('rejects an edge plane with a face pick', async () => {
    const { status, body } = await post({
      feature: 'plane', type: 'edge', position: 0.5, bases: [planePick(0)],
    });
    expect(status).toBe(400);
    expect(body.error).toContain('picked edge');
  });

  it('rejects rotation on an edge plane', async () => {
    const { status, body } = await post({
      feature: 'plane', type: 'edge', position: 0.5, rotateX: 15, bases: [planePick(2, 'edge')],
    });
    expect(status).toBe(400);
    expect(body.error).toContain('no offset or rotation');
  });

  it('rejects a position on an offset plane', async () => {
    const { status, body } = await post({
      feature: 'plane', type: 'offset', position: 0.5, bases: [{ kind: 'standard', plane: 'xy' }],
    });
    expect(status).toBe(400);
    expect(body.error).toContain('only valid for an edge plane');
  });

  it('rejects a mid plane with one base', async () => {
    const { status, body } = await post({
      feature: 'plane', type: 'mid', bases: [{ kind: 'standard', plane: 'xy' }],
    });
    expect(status).toBe(400);
    expect(body.error).toContain('exactly two bases');
  });

  it('rejects duplicate plane bases', async () => {
    const { status, body } = await post({
      feature: 'plane', type: 'mid',
      bases: [{ kind: 'standard', plane: 'xy' }, { kind: 'standard', plane: 'xy' }],
    });
    expect(status).toBe(400);
    expect(body.error).toContain('must be different');
  });

  it('rejects a non-finite plane rotation', async () => {
    const { status, body } = await post({
      feature: 'plane', type: 'offset', rotateX: 'lots',
      bases: [{ kind: 'standard', plane: 'xy' }],
    });
    expect(status).toBe(400);
    expect(body.error).toContain('rotateX');
  });

  it('refuses plane bases from different files', async () => {
    currentSynthesis = planeSynthesis('endFaces');
    const { status, body } = await post({
      feature: 'plane', type: 'mid',
      bases: [planePick(0), { kind: 'plane', filePath: '/ws/other.fluid.js', line: 3, column: 0 }],
    });
    expect(status).toBe(422);
    expect(body.reason).toContain('different files');
  });

  it('resolves bound plane names with the plane callee', async () => {
    currentCode = [
      `import { plane, sketch, rect } from 'fluidcad/core'`,
      ``,
      `const top = plane('xy', 30)`,
      `sketch('xy', () => { rect(10, 10) })`,
      ``,
    ].join('\n');
    const res = await fetch(`${baseUrl}/api/sketch-names`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ lines: [3, 4], callee: 'plane' }),
    });
    expect(res.status).toBe(200);
    expect((await res.json()).names).toEqual(['top', null]);
  });

  it('resolves bound sketch names and nulls for everything else', async () => {
    currentCode = [
      `import { sketch, rect, circle, extrude } from 'fluidcad/core'`,
      ``,
      `const spine = sketch('xz', () => { circle(5) })`,
      `sketch('xy', () => { rect(10, 10) })`,
      `extrude(30)`,
      ``,
    ].join('\n');
    const res = await fetch(`${baseUrl}/api/sketch-names`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ lines: [3, 4, 5, 99] }),
    });
    expect(res.status).toBe(200);
    expect((await res.json()).names).toEqual(['spine', null, null, null]);
  });

  it('returns all-null sketch names without a code buffer', async () => {
    const res = await fetch(`${baseUrl}/api/sketch-names`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ lines: [3] }),
    });
    expect((await res.json()).names).toEqual([null]);
  });

  describe('in-place statement edit routes', () => {
    const EDIT_CODE = [
      `import { sketch, rect, extrude, shell } from 'fluidcad/core'`,
      ``,
      `const s = sketch('xy', () => { rect(100, 50) })`,
      `extrude(30)`,
      `shell(-2, e.endFaces())`,
      ``,
    ].join('\n');
    const EDIT_TARGET = { filePath: '/ws/m.fluid.js', line: 4, column: 0 };

    async function postParse(body: unknown): Promise<{ status: number; body: any }> {
      const res = await fetch(`${baseUrl}/api/feature/parse`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      return { status: res.status, body: await res.json() };
    }

    it('parses the statement at a line for the dialog prefill', async () => {
      currentCode = EDIT_CODE;
      currentFileName = '/ws/m.fluid.js';
      const { status, body } = await postParse({ filePath: '/ws/m.fluid.js', line: 4 });
      expect(status).toBe(200);
      expect(body).toEqual({
        ok: true,
        parsed: {
          feature: 'extrude', op: 'add', distance: 30, distance2: null, symmetric: false,
          draft: null, drill: true, thin: null, profileText: null, toFaceText: null,
        },
        statement: 'extrude(30)',
      });
    });

    it('refuses to parse a feature from another file', async () => {
      currentCode = EDIT_CODE;
      currentFileName = '/ws/m.fluid.js';
      const { status, body } = await postParse({ filePath: '/ws/other.fluid.js', line: 4 });
      expect(status).toBe(422);
      expect(body.error).toContain('different file');
    });

    it('404s the parse without a code buffer', async () => {
      const { status } = await postParse({ filePath: '/ws/m.fluid.js', line: 4 });
      expect(status).toBe(404);
    });

    it('relays an extrude edit spec and previews the exact statement', async () => {
      currentCode = EDIT_CODE;
      currentFileName = '/ws/m.fluid.js';
      const { status, body } = await post({
        feature: 'extrude', edit: EDIT_TARGET, op: 'add', distance: 45, thin: [2],
      });
      expect(status).toBe(200);
      expect(body.success).toBe(true);
      expect(body.preview).toBe('extrude(45).thin(2)');
      expect(synthesizeCalls).toEqual([]);
      expect(relayed).toHaveLength(1);
      expect(relayed[0].spec).toMatchObject({
        feature: 'extrude',
        edit: { line: 4, column: 0, extrude: { op: 'add', distance: 45, thin: [2] } },
        producers: [],
        parts: [],
      });
    });

    it('previews an edit without relaying when preview is set', async () => {
      currentCode = EDIT_CODE;
      currentFileName = '/ws/m.fluid.js';
      const { status, body } = await post({
        feature: 'extrude', edit: EDIT_TARGET, op: 'remove', distance: null, thin: null, preview: true,
      });
      expect(status).toBe(200);
      expect(body.preview).toBe('cut()');
      expect(relayed).toHaveLength(0);
    });

    it('rejects a malformed edit op', async () => {
      const { status } = await post({
        feature: 'extrude', edit: EDIT_TARGET, op: 'subtract', distance: 10, thin: null,
      });
      expect(status).toBe(400);
    });

    it('422s an edit whose statement no longer matches the feature', async () => {
      currentCode = EDIT_CODE;
      currentFileName = '/ws/m.fluid.js';
      const { status, body } = await post({
        feature: 'sweep', edit: EDIT_TARGET, op: 'add', thin: null,
      });
      expect(status).toBe(422);
      expect(body.reason).toContain('not');
      expect(relayed).toHaveLength(0);
    });

    it('relays a shell edit with the selector override as rawArgs', async () => {
      currentCode = EDIT_CODE;
      currentFileName = '/ws/m.fluid.js';
      const { status, body } = await post({
        feature: 'shell',
        edit: { filePath: '/ws/m.fluid.js', line: 5, column: 0 },
        value: -3,
        selectorOverride: `face().onPlane('xy')`,
      });
      expect(status).toBe(200);
      expect(body.preview).toBe(`shell(-3, face().onPlane('xy'))`);
      expect(relayed[0].spec).toMatchObject({
        feature: 'shell',
        value: -3,
        rawArgs: `face().onPlane('xy')`,
        edit: { line: 5, column: 0 },
      });
    });

    it('relays a shell edit join type and previews the chain', async () => {
      currentCode = EDIT_CODE;
      currentFileName = '/ws/m.fluid.js';
      const { status, body } = await post({
        feature: 'shell',
        edit: { filePath: '/ws/m.fluid.js', line: 5, column: 0 },
        value: -2,
        joinType: 'intersection',
      });
      expect(status).toBe(200);
      expect(body.preview).toBe(`shell(-2, e.endFaces()).join('intersection')`);
      expect(relayed[0].spec).toMatchObject({
        feature: 'shell',
        value: -2,
        edit: { line: 5, column: 0, shell: { joinType: 'intersection' } },
      });
    });

    it('rejects an unknown shell edit join type', async () => {
      const { status } = await post({
        feature: 'shell',
        edit: { filePath: '/ws/m.fluid.js', line: 5, column: 0 },
        value: -2,
        joinType: 'bevel',
      });
      expect(status).toBe(400);
    });

    it('refuses an edit in a different file than the live buffer', async () => {
      currentCode = EDIT_CODE;
      currentFileName = '/ws/m.fluid.js';
      const { status, body } = await post({
        feature: 'extrude',
        edit: { filePath: '/ws/other.fluid.js', line: 4, column: 0 },
        op: 'add', distance: 10, thin: null,
      });
      expect(status).toBe(422);
      expect(body.reason).toContain('different file');
    });

    describe('edit-mode source re-picking', () => {
      const SOURCE_CODE = [
        `import { sketch, rect, circle, extrude, sweep, loft, shell, wrap } from 'fluidcad/core'`,
        ``,
        `const s = sketch('xy', () => { rect(100, 50) })`,
        `const e = extrude(30)`,
        `const p = sketch('xz', () => { circle(30) })`,
        `shell(-2, e.endFaces())`,
        `sweep(p, s)`,
        `loft(s, p)`,
        `wrap(2, p, e.sideFaces(0))`,
        ``,
      ].join('\n');
      const BEFORE = { index: 5, type: 'shell', line: 6, column: 0 };
      const FACE_PICK = { shapeId: 'shape-1', sub: { type: 'face', index: 2 } };
      const EDGE_PICK = { shapeId: 'shape-1', sub: { type: 'edge', index: 1 } };
      const shellSynthesis = {
        ok: true,
        spec: {
          feature: 'shell',
          filePath: '/ws/m.fluid.js',
          producers: [{ line: 4, column: 0, featureType: 'extrude', nameHint: 'e', bind: true }],
          parts: [{ producer: 0, accessor: 'sideFaces', indices: [0, 2], filterArgs: null }],
          imports: [],
        },
        preview: 'shell(-3, e.sideFaces(0, 2))',
        args: 'e.sideFaces(0, 2)',
        alternatives: ['e.sideFaces(face().onPlane(\'xz\'))'],
      };

      beforeEach(() => {
        currentCode = SOURCE_CODE;
        currentFileName = '/ws/m.fluid.js';
      });

      it('re-sources an extrude profile without synthesis or a boundary', async () => {
        const { status, body } = await post({
          feature: 'extrude',
          edit: { filePath: '/ws/m.fluid.js', line: 4, column: 0 },
          op: 'add', distance: 45, thin: null,
          profile: { mode: 'bound', filePath: '/ws/m.fluid.js', line: 5, column: 0 },
        });
        expect(status).toBe(200);
        expect(body.preview).toBe('extrude(45, p)');
        expect(synthesizeCalls).toEqual([]);
        expect(relayed[0].spec).toMatchObject({
          feature: 'extrude',
          producers: [{ line: 5, column: 0, featureType: 'sketch', nameHint: 's', bind: true }],
          parts: [],
          edit: { line: 4, column: 0, extrude: { profile: { kind: 'sketch', producer: 0 } } },
        });
      });

      it('re-picks a shell selection: synthesis with the boundary, parts on the spec', async () => {
        currentSynthesis = shellSynthesis;
        const { status, body } = await post({
          feature: 'shell',
          edit: { filePath: '/ws/m.fluid.js', line: 6, column: 0 },
          value: -3,
          entities: [FACE_PICK],
          before: BEFORE,
        });
        expect(status).toBe(200);
        expect(body.preview).toBe('shell(-3, e.sideFaces(0, 2))');
        expect(synthesizeCalls).toEqual([{ feature: 'shell', value: -3 }]);
        expect(synthesizeBoundaries).toEqual([BEFORE]);
        expect(relayed[0].spec).toMatchObject({
          feature: 'shell',
          value: -3,
          producers: [{ line: 4, featureType: 'extrude', bind: true }],
          parts: [{ producer: 0, accessor: 'sideFaces', indices: [0, 2] }],
          edit: { line: 6, column: 0 },
          // The relayed edit spec clears the breakpoint the dialog opened with.
          clearBreakpoints: true,
        });
        expect(relayed[0].spec.rawArgs).toBeUndefined();
      });

      it('sets clearBreakpoints on a value-only edit spec too', async () => {
        const { status } = await post({
          feature: 'extrude',
          edit: { filePath: '/ws/m.fluid.js', line: 4, column: 0 },
          op: 'add', distance: 45, thin: null,
        });
        expect(status).toBe(200);
        expect(relayed[0].spec.clearBreakpoints).toBe(true);
      });

      it('suppresses a selectorOverride equal to the synthesized args', async () => {
        currentSynthesis = shellSynthesis;
        const { status } = await post({
          feature: 'shell',
          edit: { filePath: '/ws/m.fluid.js', line: 6, column: 0 },
          value: -3,
          entities: [FACE_PICK],
          selectorOverride: 'e.sideFaces(0, 2)',
          before: BEFORE,
        });
        expect(status).toBe(200);
        expect(relayed[0].spec.rawArgs).toBeUndefined();
      });

      it('rejects re-picked geometry without a boundary', async () => {
        const { status, body } = await post({
          feature: 'shell',
          edit: { filePath: '/ws/m.fluid.js', line: 6, column: 0 },
          value: -3,
          entities: [FACE_PICK],
        });
        expect(status).toBe(400);
        expect(body.error).toContain('before is required');
        expect(synthesizeCalls).toEqual([]);
      });

      const TOFACE_CODE = [
        `import { sketch, rect, circle, extrude } from 'fluidcad/core'`,
        ``,
        `const s = sketch('xy', () => { rect(100, 50) })`,
        `const e = extrude(30, s)`,
        `const p = sketch('xy', () => { circle(30) })`,
        `extrude(e.endFaces(), p)`,
        ``,
      ].join('\n');
      const TOFACE_BEFORE = { index: 5, type: 'extrude', line: 6, column: 0 };
      const toFaceEditSynthesis = {
        ok: true,
        spec: {
          feature: 'extrude',
          filePath: '/ws/m.fluid.js',
          producers: [{ line: 4, column: 0, featureType: 'extrude', nameHint: 'e', bind: true }],
          parts: [{ producer: 0, accessor: 'startFaces', indices: null, filterArgs: null }],
          imports: [],
        },
        preview: 'extrude(e.startFaces())',
        args: 'e.startFaces()',
        alternatives: [],
      };

      it('keeps a to-face target verbatim while editing other options', async () => {
        currentCode = TOFACE_CODE;
        const { status, body } = await post({
          feature: 'extrude',
          edit: { filePath: '/ws/m.fluid.js', line: 6, column: 0 },
          op: 'add', distance: null, draft: 3, thin: null,
          toFace: { kind: 'keep' },
        });
        expect(status).toBe(200);
        expect(body.preview).toBe('extrude(e.endFaces(), p).draft(3)');
        expect(synthesizeCalls).toEqual([]);
        expect(relayed[0].spec).toMatchObject({
          feature: 'extrude',
          parts: [],
          edit: { line: 6, column: 0, extrude: { toFace: { kind: 'keep' } } },
        });
      });

      it('re-picks a to-face target: synthesis with the boundary, selector on the edit spec', async () => {
        currentCode = TOFACE_CODE;
        currentSynthesis = toFaceEditSynthesis;
        const { status, body } = await post({
          feature: 'extrude',
          edit: { filePath: '/ws/m.fluid.js', line: 6, column: 0 },
          op: 'add', distance: null, thin: null,
          toFace: { kind: 'face', entity: FACE_PICK },
          before: TOFACE_BEFORE,
        });
        expect(status).toBe(200);
        expect(body.preview).toBe('extrude(e.startFaces(), p)');
        expect(synthesizeCalls).toEqual([{ feature: 'extrude', value: undefined }]);
        expect(synthesizeBoundaries).toEqual([TOFACE_BEFORE]);
        expect(relayed[0].spec).toMatchObject({
          feature: 'extrude',
          producers: [{ line: 4, featureType: 'extrude', bind: true }],
          parts: [{ producer: 0, accessor: 'startFaces' }],
          edit: { line: 6, column: 0, extrude: { toFace: { kind: 'selector' } } },
        });
      });

      it('switches a to-face edit back to a distance, dropping the target', async () => {
        currentCode = TOFACE_CODE;
        const { status, body } = await post({
          feature: 'extrude',
          edit: { filePath: '/ws/m.fluid.js', line: 6, column: 0 },
          op: 'add', distance: 45, thin: null,
        });
        expect(status).toBe(200);
        expect(body.preview).toBe('extrude(45, p)');
      });

      it('rejects a re-picked to-face target without a boundary', async () => {
        currentCode = TOFACE_CODE;
        const { status, body } = await post({
          feature: 'extrude',
          edit: { filePath: '/ws/m.fluid.js', line: 6, column: 0 },
          op: 'add', distance: null, thin: null,
          toFace: { kind: 'face', entity: FACE_PICK },
        });
        expect(status).toBe(400);
        expect(body.error).toContain('before is required');
        expect(synthesizeCalls).toEqual([]);
      });

      it('rejects a to-face edit carrying a distance', async () => {
        currentCode = TOFACE_CODE;
        const { status, body } = await post({
          feature: 'extrude',
          edit: { filePath: '/ws/m.fluid.js', line: 6, column: 0 },
          op: 'add', distance: 25, thin: null,
          toFace: { kind: 'keep' },
        });
        expect(status).toBe(400);
        expect(body.error).toContain('to-face');
      });

      it('rejects an edge pick as an edited to-face target', async () => {
        currentCode = TOFACE_CODE;
        const { status, body } = await post({
          feature: 'extrude',
          edit: { filePath: '/ws/m.fluid.js', line: 6, column: 0 },
          op: 'add', distance: null, thin: null,
          toFace: { kind: 'face', entity: EDGE_PICK },
          before: TOFACE_BEFORE,
        });
        expect(status).toBe(400);
        expect(body.error).toContain('re-picked target');
      });

      it('refuses a stale expectedStatement before relaying', async () => {
        const { status, body } = await post({
          feature: 'extrude',
          edit: { filePath: '/ws/m.fluid.js', line: 4, column: 0 },
          expectedStatement: 'extrude(31)',
          op: 'add', distance: 45, thin: null,
        });
        expect(status).toBe(422);
        expect(body.reason).toContain('changed since the dialog opened');
        expect(relayed).toHaveLength(0);
      });

      it('re-sources a sweep path from picked edges', async () => {
        currentSynthesis = {
          ...shellSynthesis,
          spec: {
            ...shellSynthesis.spec,
            feature: 'sweep',
            parts: [{ producer: 0, accessor: 'sideEdges', indices: [1], filterArgs: null }],
          },
          args: 'e.sideEdges(1)',
          alternatives: [],
        };
        const { status, body } = await post({
          feature: 'sweep',
          edit: { filePath: '/ws/m.fluid.js', line: 7, column: 0 },
          op: 'add', thin: null,
          path: { kind: 'edges', entities: [EDGE_PICK], chains: [] },
          before: { ...BEFORE, index: 6, type: 'sweep', line: 7 },
        });
        expect(status).toBe(200);
        expect(body.preview).toBe('sweep(e.sideEdges(1), s)');
        expect(synthesizeCalls).toEqual([{ feature: 'sweep', value: undefined }]);
        expect(relayed[0].spec).toMatchObject({
          feature: 'sweep',
          producers: [{ line: 4, featureType: 'extrude' }],
          parts: [{ producer: 0, accessor: 'sideEdges', indices: [1] }],
          edit: { line: 7, sweep: { path: { kind: 'selector' } } },
        });
      });

      it('relays a value-only wrap edit and previews the exact statement', async () => {
        const { status, body } = await post({
          feature: 'wrap',
          edit: { filePath: '/ws/m.fluid.js', line: 9, column: 0 },
          op: 'remove', thickness: 3,
        });
        expect(status).toBe(200);
        expect(body.preview).toBe('wrap(3, p, e.sideFaces(0)).remove()');
        expect(synthesizeCalls).toEqual([]);
        expect(relayed[0].spec).toMatchObject({
          feature: 'wrap',
          producers: [],
          parts: [],
          edit: { line: 9, column: 0, wrap: { op: 'remove', thickness: 3 } },
        });
      });

      it('re-picks a wrap target face: synthesis with the boundary', async () => {
        currentSynthesis = {
          ...shellSynthesis,
          spec: {
            ...shellSynthesis.spec,
            feature: 'wrap',
            parts: [{ producer: 0, accessor: 'endFaces', indices: null, filterArgs: null }],
          },
          args: 'e.endFaces()',
          alternatives: [],
        };
        const { status, body } = await post({
          feature: 'wrap',
          edit: { filePath: '/ws/m.fluid.js', line: 9, column: 0 },
          op: 'add', thickness: 2,
          face: { kind: 'face', entity: FACE_PICK },
          before: { ...BEFORE, index: 8, type: 'wrap', line: 9 },
        });
        expect(status).toBe(200);
        expect(body.preview).toBe('wrap(2, p, e.endFaces())');
        expect(synthesizeCalls).toEqual([{ feature: 'wrap', value: undefined }]);
        expect(synthesizeBoundaries).toEqual([{ ...BEFORE, index: 8, type: 'wrap', line: 9 }]);
        expect(relayed[0].spec).toMatchObject({
          feature: 'wrap',
          producers: [{ line: 4, featureType: 'extrude' }],
          parts: [{ producer: 0, accessor: 'endFaces' }],
          edit: { line: 9, wrap: { face: { kind: 'selector' } } },
        });
      });

      it('re-sources a wrap sketch without synthesis or a boundary', async () => {
        const { status, body } = await post({
          feature: 'wrap',
          edit: { filePath: '/ws/m.fluid.js', line: 9, column: 0 },
          op: 'add', thickness: 2,
          sketch: { kind: 'sketch', filePath: '/ws/m.fluid.js', line: 3, column: 0 },
        });
        expect(status).toBe(200);
        expect(body.preview).toBe('wrap(2, s, e.sideFaces(0))');
        expect(synthesizeCalls).toEqual([]);
        expect(relayed[0].spec).toMatchObject({
          feature: 'wrap',
          producers: [{ line: 3, featureType: 'sketch', bind: true }],
          parts: [],
          edit: { line: 9, wrap: { sketch: { kind: 'sketch', producer: 0 } } },
        });
      });

      it('re-sources loft profiles: verbatim keeps, a sketch ref, a face pick', async () => {
        currentSynthesis = {
          ...shellSynthesis,
          spec: {
            ...shellSynthesis.spec,
            feature: 'loft',
            parts: [{ producer: 0, accessor: 'endFaces', indices: null, filterArgs: null }],
          },
          args: 'e.endFaces()',
          alternatives: [],
        };
        const { status, body } = await post({
          feature: 'loft',
          edit: { filePath: '/ws/m.fluid.js', line: 8, column: 0 },
          op: 'add', thin: null,
          profiles: [
            { kind: 'verbatim', sourceIndex: 1 },
            { kind: 'sketch', filePath: '/ws/m.fluid.js', line: 3, column: 0 },
            { kind: 'face', entity: FACE_PICK },
          ],
          before: { ...BEFORE, index: 7, type: 'loft', line: 8 },
        });
        expect(status).toBe(200);
        expect(body.preview).toBe('loft(p, s, e.endFaces())');
        expect(synthesizeCalls).toEqual([{ feature: 'loft', value: undefined }]);
        expect(relayed[0].spec).toMatchObject({
          feature: 'loft',
          producers: [
            { line: 3, featureType: 'sketch', bind: true },
            { line: 4, featureType: 'extrude', bind: true },
          ],
          parts: [{ producer: 1, accessor: 'endFaces' }],
          edit: {
            line: 8,
            loft: {
              profiles: [
                { kind: 'verbatim', sourceIndex: 1 },
                { kind: 'sketch', producer: 0 },
                { kind: 'selector', part: 0 },
              ],
            },
          },
        });
      });

      it('surfaces a synthesis refusal from the boundary as 422', async () => {
        currentSynthesis = { ok: false, reason: 'the edited statement no longer matches the rendered scene — re-open the edit dialog' };
        const { status, body } = await post({
          feature: 'shell',
          edit: { filePath: '/ws/m.fluid.js', line: 6, column: 0 },
          value: -3,
          entities: [FACE_PICK],
          before: BEFORE,
        });
        expect(status).toBe(422);
        expect(body.reason).toContain('no longer matches');
        expect(relayed).toHaveLength(0);
      });
    });
  });

  describe('selection query boundary (edit-mode scoping)', () => {
    const BEFORE = { index: 3, type: 'shell', line: 5, column: 0 };

    async function postTo(path: string, body: unknown): Promise<{ status: number; body: any }> {
      const res = await fetch(`${baseUrl}/api${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      return { status: res.status, body: await res.json() };
    }

    it('passes the boundary through to the selection queries', async () => {
      for (const path of ['/selection/expand-bucket', '/selection/expand-tangents', '/selection/groups']) {
        const { status } = await postTo(path, { entity: PICK, before: BEFORE });
        expect(status).toBe(200);
      }
      const { status } = await postTo('/selection/explain', { entities: [PICK], before: BEFORE });
      expect(status).toBe(200);
      expect(queryCalls.map(c => c.before)).toEqual([BEFORE, BEFORE, BEFORE, BEFORE]);
    });

    it('omits the boundary when the request carries none', async () => {
      const { status } = await postTo('/selection/expand-bucket', { entity: PICK });
      expect(status).toBe(200);
      expect(queryCalls).toEqual([{ method: 'expandBucket', before: undefined }]);
    });

    it('rejects a malformed boundary', async () => {
      const { status, body } = await postTo('/selection/expand-bucket', {
        entity: PICK,
        before: { index: -1, type: 'shell', line: 5, column: 0 },
      });
      expect(status).toBe(400);
      expect(body.error).toContain('before must be');
      expect(queryCalls).toEqual([]);
    });

    it('surfaces a stale-boundary refusal as 422', async () => {
      currentQueryResult = { ok: false, reason: 'the edited statement no longer matches the rendered scene — re-open the edit dialog' };
      const { status, body } = await postTo('/selection/groups', { entity: PICK, before: BEFORE });
      expect(status).toBe(422);
      expect(body.error).toContain('no longer matches');

      const explain = await postTo('/selection/explain', { entities: [PICK], before: BEFORE });
      expect(explain.status).toBe(422);
      expect(explain.body.error).toContain('no longer matches');
    });

    it('feature/sources requires a boundary and forwards it', async () => {
      currentQueryResult = { ok: true, feature: 'shell', selection: { kind: 'entities', entities: [PICK] } };
      const ok = await postTo('/feature/sources', { before: BEFORE });
      expect(ok.status).toBe(200);
      expect(ok.body.feature).toBe('shell');
      expect(queryCalls).toEqual([{ method: 'featureSources', before: BEFORE }]);

      const missing = await postTo('/feature/sources', {});
      expect(missing.status).toBe(400);

      currentQueryResult = { ok: false, reason: 'the edited statement no longer matches the rendered scene — re-open the edit dialog' };
      const stale = await postTo('/feature/sources', { before: BEFORE });
      expect(stale.status).toBe(422);
    });
  });
});
