import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import express from 'express';
import http from 'http';
import { createApplyFeatureRouter } from '../../src/routes/apply-feature.ts';

let server: http.Server;
let baseUrl: string;

/** Calls the route forwarded to the fake server / extension relay. */
let synthesizeCalls: { feature: string; value: number | undefined }[];
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

const fakeServer = {
  getCurrentCode: () => currentCode,
  getCurrentFileName: () => currentFileName,
  getParamDefinitions: () => [],
  synthesizeApplyFeature: (
    _picks: unknown, feature: string, value: number | undefined,
  ) => {
    synthesizeCalls.push({ feature, value });
    if (Array.isArray(currentSynthesis)) {
      return currentSynthesis[Math.min(synthesizeCalls.length, currentSynthesis.length) - 1];
    }
    return currentSynthesis;
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
    relayed = [];
    currentSynthesis = fakeSynthesis;
    currentCode = null;
    currentFileName = null;
  });

  it('rejects an unknown feature', async () => {
    const { status, body } = await post({ feature: 'draft', value: 2, entities: [PICK] });
    expect(status).toBe(400);
    expect(body.error).toContain('"sweep" or "loft"');
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
        parsed: { feature: 'extrude', op: 'add', distance: 30, thin: null, profileText: null },
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
  });
});
