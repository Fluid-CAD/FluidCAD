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
/** The options each synthesis call carried, parallel to the calls. */
let synthesizeOptions: unknown[];
let relayed: any[];

/** Picks forwarded to the connector anchor-suggestion endpoint. */
let anchorCalls: unknown[];
/** Per-test result for the anchor-suggestion endpoint. */
let currentAnchors: any;

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

/** Sketch-branch synthesis calls (2D {shapeId} picks). */
let sketchSynthesizeCalls: {
  picks: unknown; feature: string; value: number | string | undefined;
  offset?: unknown; slot?: unknown; axisRefs?: unknown;
}[];

/** Descriptor lists forwarded to the 2D target resolver (offset edit seeding). */
let sketchTargetCalls: unknown[];
/** Per-test result for the 2D target resolver. */
let currentSketchTargets: any;

/** Picks forwarded to the consumer-side exposure resolver. */
let exposureCalls: unknown[];
/** Per-test result for the exposure resolver; null keeps the normal flow. */
let currentExposureResolution: any;

const fakeServer = {
  getCurrentCode: () => currentCode,
  getCurrentFileName: () => currentFileName,
  getParamDefinitions: () => [],
  resolvePickExposure: (pick: unknown) => {
    exposureCalls.push(pick);
    return currentExposureResolution;
  },
  synthesizeSketchApplyFeature: (
    picks: unknown, feature: string, value: number | string | undefined,
    options?: { offset?: unknown; slot?: unknown; axisRefs?: unknown },
  ) => {
    sketchSynthesizeCalls.push({
      picks, feature, value,
      offset: options?.offset, slot: options?.slot, axisRefs: options?.axisRefs,
    });
    return currentSynthesis;
  },
  resolveSketchStatementTargets: (descriptors: unknown[]) => {
    sketchTargetCalls.push(descriptors);
    return currentSketchTargets;
  },
  synthesizeApplyFeature: (
    _picks: unknown, feature: string, value: number | undefined,
    _chains?: unknown, options?: unknown, before?: unknown,
  ) => {
    synthesizeCalls.push({ feature, value });
    synthesizeBoundaries.push(before);
    synthesizeOptions.push(options);
    if (Array.isArray(currentSynthesis)) {
      return currentSynthesis[Math.min(synthesizeCalls.length, currentSynthesis.length) - 1];
    }
    return currentSynthesis;
  },
  suggestConnectorAnchors: (pick: unknown, _options?: unknown) => {
    anchorCalls.push(pick);
    return currentAnchors;
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
    // This suite relays synthetic specs that would never survive the real
    // transform — the preflight/ack layer has its own suite next door.
    app.use('/api', createApplyFeatureRouter(fakeServer as any, (msg) => { relayed.push(msg); }, { preflight: false }));

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
    synthesizeOptions = [];
    sketchSynthesizeCalls = [];
    sketchTargetCalls = [];
    currentSketchTargets = { ok: true, shapeIds: ['edge-1'] };
    relayed = [];
    currentSynthesis = fakeSynthesis;
    currentCode = null;
    currentFileName = null;
    queryCalls = [];
    currentQueryResult = { ok: true, members: [PICK], groups: [], picks: [] };
    anchorCalls = [];
    currentAnchors = { ok: true, defaultName: 'c1', args: 'e.endFaces(0)', anchors: [] };
    exposureCalls = [];
    currentExposureResolution = null;
  });

  it('rejects an unknown feature', async () => {
    const { status, body } = await post({ feature: 'draft', value: 2, entities: [PICK] });
    expect(status).toBe(400);
    expect(body.error).toContain('"revolve", "plane", "project", "repeat", "copy" or "boolean"');
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

  it('accepts a negative offset distance (the offset-inward idiom)', async () => {
    const { status } = await post({ feature: 'offset', value: -5, entities: [PICK], preview: true });
    expect(status).toBe(200);
    expect(synthesizeCalls).toEqual([{ feature: 'offset', value: -5 }]);
  });

  it('rejects a zero offset distance', async () => {
    const { status, body } = await post({ feature: 'offset', value: 0, entities: [PICK] });
    expect(status).toBe(400);
    expect(body.error).toContain('nonzero');
  });

  it('relays a face-picked offset spec to the extension', async () => {
    currentSynthesis = {
      ...fakeSynthesis,
      spec: { ...fakeSynthesis.spec, feature: 'offset', value: 5 },
      preview: 'offset(5, e.endFaces())',
      args: 'e.endFaces()',
    };
    const { status, body } = await post({ feature: 'offset', value: 5, entities: [PICK] });
    expect(status).toBe(200);
    expect(body.preview).toBe('offset(5, e.endFaces())');
    expect(relayed).toHaveLength(1);
    expect(relayed[0].spec.feature).toBe('offset');
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

  const chamferSynthesis = {
    ...fakeSynthesis,
    spec: { ...fakeSynthesis.spec, feature: 'chamfer' },
    preview: 'chamfer(2, e.endEdges())',
    args: 'e.endEdges()',
  };

  it('rejects a non-positive chamfer distance2', async () => {
    const { status, body } = await post({ feature: 'chamfer', value: 2, distance2: 0, entities: [PICK] });
    expect(status).toBe(400);
    expect(body.error).toContain('distance2');
  });

  it('rejects a chamfer angle of 90 degrees or more', async () => {
    const { status, body } = await post({
      feature: 'chamfer', value: 2, distance2: 95, isAngle: true, entities: [PICK],
    });
    expect(status).toBe(400);
    expect(body.error).toContain('angle');
  });

  it('rejects isAngle without a distance2 value', async () => {
    const { status, body } = await post({ feature: 'chamfer', value: 2, isAngle: true, entities: [PICK] });
    expect(status).toBe(400);
    expect(body.error).toContain('distance2');
  });

  it('relays a two-distance chamfer on the spec and folds it into the preview', async () => {
    currentSynthesis = chamferSynthesis;
    const { status, body } = await post({ feature: 'chamfer', value: 2, distance2: 3, entities: [PICK] });
    expect(status).toBe(200);
    expect(body.preview).toBe('chamfer(2, 3, e.endEdges())');
    expect(relayed).toHaveLength(1);
    expect(relayed[0].spec.chamfer).toEqual({ distance2: 3, isAngle: false });
  });

  it('relays a distance-and-angle chamfer with the literal true in the preview', async () => {
    currentSynthesis = chamferSynthesis;
    const { status, body } = await post({
      feature: 'chamfer', value: 2, distance2: 45, isAngle: true, entities: [PICK], preview: true,
    });
    expect(status).toBe(200);
    expect(body.preview).toBe('chamfer(2, 45, true, e.endEdges())');
    expect(relayed).toHaveLength(0);
  });

  it('leaves the spec and preview bare without a second chamfer value', async () => {
    currentSynthesis = chamferSynthesis;
    const { status, body } = await post({ feature: 'chamfer', value: 2, entities: [PICK] });
    expect(status).toBe(200);
    expect(body.preview).toBe('chamfer(2, e.endEdges())');
    expect(relayed[0].spec.chamfer).toBeUndefined();
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
      editId: expect.any(String),
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

  it('forwards the active part into a pick-less sketch spec', async () => {
    currentFileName = '/ws/m.fluid.js';
    const { status } = await post({
      feature: 'sketch', entities: [], plane: 'xz',
      activePart: { filePath: '/ws/m.fluid.js', line: 3, column: 0 },
    });
    expect(status).toBe(200);
    expect(relayed).toHaveLength(1);
    expect(relayed[0].spec.activePart).toEqual({ line: 3, column: 0 });
  });

  it('drops an active part that lives in another file', async () => {
    currentFileName = '/ws/m.fluid.js';
    const { status } = await post({
      feature: 'sketch', entities: [], plane: 'xz',
      activePart: { filePath: '/ws/other.fluid.js', line: 3, column: 0 },
    });
    expect(status).toBe(200);
    expect(relayed).toHaveLength(1);
    expect(relayed[0].spec.activePart).toBeUndefined();
  });

  it('rejects a malformed active part', async () => {
    currentFileName = '/ws/m.fluid.js';
    const { status, body } = await post({
      feature: 'sketch', entities: [], plane: 'xz', activePart: { line: 'x' },
    });
    expect(status).toBe(400);
    expect(body.error).toContain('activePart');
    expect(relayed).toHaveLength(0);
  });

  describe('foreign sketch (cross-part reference)', () => {
    const FILE = '/ws/m.fluid.js';
    const TWO_PART_CODE = [
      `import { sketch, rect, extrude, part, expose } from 'fluidcad/core'`,
      ``,
      `export const p1 = part('Donor', () => {`,
      `  sketch('xy', () => { rect(100, 50) })`,
      `  const e = extrude(30)`,
      `  expose('endFace', e.endFaces(0))`,
      `})`,
      ``,
      `export const p2 = part('Consumer', () => {`,
      `  extrude(5)`,
      `})`,
      ``,
    ].join('\n');
    const ACTIVE = { filePath: FILE, line: 9, column: 18 };
    const donorResolution = (matched: string | null, existingNames: string[]) => ({
      ok: true,
      donor: { partName: 'Donor', filePath: FILE, line: 3, column: 18, matched, existingNames },
    });

    it('relays a sketchForeign spec into the active part for a matched exposure', async () => {
      currentCode = TWO_PART_CODE;
      currentFileName = FILE;
      currentExposureResolution = donorResolution('endFace', ['endFace']);

      const { status, body } = await post({
        feature: 'sketch', entities: [PICK], activePart: ACTIVE,
      });
      expect(status).toBe(200);
      expect(body.preview).toBe(`sketch(p1.features.endFace, () => { ... })`);
      // A matched exposure needs no donor-side synthesis and no normal
      // sketch synthesis — the reference is composed route-side.
      expect(synthesizeCalls).toEqual([]);
      expect(relayed).toHaveLength(1);
      const spec = relayed[0].spec;
      expect(spec.feature).toBe('sketch');
      expect(spec.filePath).toBe(FILE);
      expect(spec.activePart).toEqual({ line: 9, column: 18 });
      expect(spec.sketchForeign).toEqual({ exposeName: 'endFace', donor: { line: 3, column: 18 } });
    });

    it('allocates a fresh name and embeds the expose create spec when unmatched', async () => {
      currentCode = TWO_PART_CODE;
      currentFileName = FILE;
      currentExposureResolution = donorResolution(null, ['g1']);
      const exposeSpec = {
        feature: 'expose', filePath: FILE,
        expose: { name: 'g2', part: { line: 3, column: 18 } },
        producers: [{ line: 5, column: 2, featureType: 'extrude', nameHint: 'e', bind: true }],
        parts: [{ producer: 0, accessor: 'endFaces', indices: [0], filterArgs: null }],
        imports: [],
      };
      currentSynthesis = {
        ok: true, spec: exposeSpec, preview: `expose('g2', e.endFaces(0))`,
        args: 'e.endFaces(0)', alternatives: [],
      };

      const { status, body } = await post({
        feature: 'sketch', entities: [PICK], activePart: ACTIVE,
      });
      expect(status).toBe(200);
      expect(body.preview).toBe(`sketch(p1.features.g2, () => { ... })`);
      // Both synthesis passes ran the donor-side expose rail with the
      // allocated name (g1 was taken).
      expect(synthesizeCalls.every(c => c.feature === 'expose')).toBe(true);
      expect(synthesizeCalls.length).toBeGreaterThan(0);
      expect(relayed).toHaveLength(1);
      const spec = relayed[0].spec;
      expect(spec.sketchForeign.exposeName).toBe('g2');
      expect(spec.sketchForeign.donor).toEqual({ line: 3, column: 18 });
      expect(spec.sketchForeign.create).toEqual(exposeSpec);
    });

    it('keeps the normal flow when the picked part IS the active part', async () => {
      currentCode = TWO_PART_CODE;
      currentFileName = FILE;
      currentExposureResolution = {
        ok: true,
        donor: { partName: 'Consumer', filePath: FILE, line: 9, column: 18, matched: null, existingNames: [] },
      };

      await post({ feature: 'sketch', entities: [PICK], activePart: ACTIVE, preview: true });
      // Fell through to the ordinary pick-carrying sketch synthesis.
      expect(synthesizeCalls).toEqual([{ feature: 'sketch', value: undefined }]);
    });

    it('surfaces the resolver refusal (assembly scenes)', async () => {
      currentExposureResolution = { ok: false, reason: 'cross-part geometry references are authored in the part file' };

      const { status, body } = await post({
        feature: 'sketch', entities: [PICK], activePart: ACTIVE,
      });
      expect(status).toBe(422);
      expect(body.reason).toContain('part file');
      expect(relayed).toHaveLength(0);
    });

    it('refuses a donor that is not bound to a const', async () => {
      currentCode = [
        `import { sketch, rect, extrude, part } from 'fluidcad/core'`,
        ``,
        `export function makeDonor() {`,
        `  return part('Donor', () => {`,
        `    const e = extrude(30)`,
        `    expose('endFace', e.endFaces(0))`,
        `  })`,
        `}`,
        ``,
        `export const p2 = part('Consumer', () => {`,
        `  extrude(5)`,
        `})`,
        ``,
      ].join('\n');
      currentFileName = FILE;
      currentExposureResolution = {
        ok: true,
        donor: { partName: 'Donor', filePath: FILE, line: 4, column: 9, matched: 'endFace', existingNames: ['endFace'] },
      };

      const { status, body } = await post({
        feature: 'sketch', entities: [PICK], activePart: { filePath: FILE, line: 10, column: 18 },
      });
      expect(status).toBe(422);
      expect(body.reason).toContain('not bound to a const');
      expect(relayed).toHaveLength(0);
    });
  });

  describe('part/new', () => {
    async function postPartNew(body: unknown): Promise<{ status: number; body: any }> {
      const res = await fetch(`${baseUrl}/api/part/new`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      return { status: res.status, body: await res.json() };
    }

    it('relays a newPart spec for the current part file', async () => {
      currentFileName = '/ws/m.fluid.js';
      const { status, body } = await postPartNew({});
      expect(status).toBe(200);
      expect(body.success).toBe(true);
      expect(relayed).toHaveLength(1);
      expect(relayed[0].spec).toEqual({
        feature: 'sketch', filePath: '/ws/m.fluid.js', producers: [], parts: [], imports: [],
        newPart: {},
        editId: expect.any(String),
      });
    });

    it('carries a provided name', async () => {
      currentFileName = '/ws/m.fluid.js';
      const { status } = await postPartNew({ name: 'Bracket' });
      expect(status).toBe(200);
      expect(relayed[0].spec.newPart).toEqual({ name: 'Bracket' });
    });

    it('refuses before any render', async () => {
      const { status, body } = await postPartNew({});
      expect(status).toBe(404);
      expect(body.reason).toBe('No rendered scene');
      expect(relayed).toHaveLength(0);
    });

    it('refuses in an assembly file', async () => {
      currentFileName = '/ws/a.assembly.js';
      const { status, body } = await postPartNew({});
      expect(status).toBe(422);
      expect(body.reason).toContain('part file');
      expect(relayed).toHaveLength(0);
    });

    it('rejects an empty name', async () => {
      currentFileName = '/ws/m.fluid.js';
      const { status, body } = await postPartNew({ name: '' });
      expect(status).toBe(400);
      expect(body.error).toContain('name');
      expect(relayed).toHaveLength(0);
    });
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
      editId: expect.any(String),
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

  it('previews a negative thin offset', async () => {
    const { body } = await post({
      feature: 'extrude', op: 'add', distance: 10, thin: [-2], profile: PROFILE, preview: true,
    });
    expect(body.preview).toBe('extrude(10).thin(-2)');
  });

  it('previews two thin offsets', async () => {
    const { body } = await post({
      feature: 'extrude', op: 'add', distance: 10, thin: [2, 3.5], profile: PROFILE, preview: true,
    });
    expect(body.preview).toBe('extrude(10).thin(2, 3.5)');
  });

  it('previews a two-distance extrude', async () => {
    const { body } = await post({
      feature: 'extrude', op: 'add', distance: 10, distance2: 20, profile: PROFILE, preview: true,
    });
    expect(body.preview).toBe('extrude(10, 20)');
  });

  it('previews symmetric, draft, endOffset and drill chains', async () => {
    const { body } = await post({
      feature: 'extrude', op: 'add', distance: 30, symmetric: true, draft: 5, endOffset: 2,
      drill: false, profile: PROFILE, preview: true,
    });
    expect(body.preview).toBe('extrude(30).symmetric().draft(5).endOffset(2).drill(false)');
  });

  it('rejects a zero endOffset — no chain is the way to write none', async () => {
    const { status, body } = await post({
      feature: 'extrude', op: 'add', distance: 30, endOffset: 0, profile: PROFILE,
    });
    expect(status).toBe(400);
    expect(body.error).toContain('endOffset');
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
      extrude: { op: 'add', distance: null, profile: 'implicit', toFace: 'selector' },
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

  it('writes a first-face target as the literal, synthesizing nothing', async () => {
    const { status, body } = await post({
      feature: 'extrude', op: 'add', distance: null, profile: PROFILE, toFace: 'first-face',
    });
    expect(status).toBe(200);
    expect(body.preview).toBe(`extrude('first-face')`);
    expect(synthesizeCalls).toEqual([]);
    expect(relayed[0].spec).toMatchObject({
      feature: 'extrude',
      extrude: { op: 'add', distance: null, profile: 'implicit', toFace: 'first-face' },
      producers: [{ line: 3, featureType: 'sketch', bind: false }],
      parts: [],
    });
  });

  it('previews a bound-profile last-face remove as cut(\'last-face\', s)', async () => {
    const { body } = await post({
      feature: 'extrude', op: 'remove', profile: { ...PROFILE, mode: 'bound' },
      toFace: 'last-face', preview: true,
    });
    expect(body.preview).toBe(`cut('last-face', s)`);
    expect(relayed).toHaveLength(0);
  });

  it('rejects a first-face extrude carrying a distance', async () => {
    const { status, body } = await post({
      feature: 'extrude', op: 'add', distance: 25, profile: PROFILE, toFace: 'first-face',
    });
    expect(status).toBe(400);
    expect(body.error).toContain('to-face');
  });

  it('rejects an unknown to-face literal', async () => {
    const { status, body } = await post({
      feature: 'extrude', op: 'add', profile: PROFILE, toFace: 'middle-face',
    });
    expect(status).toBe(400);
    expect(body.error).toContain('toFace');
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
        { line: 3, featureType: 'wire', nameHint: 'p', bind: true },
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

  it('previews a symmetric partial revolve', async () => {
    const { body } = await post({
      feature: 'revolve', op: 'add', angle: 90, symmetric: true,
      profile: REVOLVE_PROFILE, axis: { kind: 'standard', axis: 'x' },
      preview: true,
    });
    expect(body.preview).toBe(`revolve('x', 90).symmetric()`);
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

  it('relays a standard-axis helix with chained options', async () => {
    currentFileName = '/ws/m.fluid.js';
    const { status, body } = await post({
      feature: 'helix', source: { kind: 'standard', axis: 'z' },
      radius: 15, pitch: 10, turns: 4,
    });
    expect(status).toBe(200);
    expect(body.preview).toBe(`helix('z').radius(15).pitch(10).turns(4)`);
    expect(synthesizeCalls).toEqual([]);
    expect(relayed[0].spec).toMatchObject({
      feature: 'helix',
      helix: { source: { kind: 'standard', axis: 'z' }, radius: 15, pitch: 10, turns: 4, endRadius: null },
      producers: [],
      parts: [],
    });
  });

  it('previews a standard-axis helix without relaying', async () => {
    currentFileName = '/ws/m.fluid.js';
    const { body } = await post({
      feature: 'helix', source: { kind: 'standard', axis: 'y' }, turns: 6, preview: true,
    });
    expect(body.preview).toBe(`helix('y').turns(6)`);
    expect(relayed).toHaveLength(0);
  });

  it('binds an axis-statement helix source', async () => {
    const { status, body } = await post({
      feature: 'helix', source: { kind: 'axis', filePath: '/ws/m.fluid.js', line: 3, column: 0 },
      turns: 3,
    });
    expect(status).toBe(200);
    expect(body.preview).toBe('helix(a).turns(3)');
    expect(synthesizeCalls).toEqual([]);
    expect(relayed[0].spec).toMatchObject({
      feature: 'helix',
      helix: { source: { kind: 'axis', producer: 0 }, turns: 3 },
      producers: [{ line: 3, featureType: 'axis', nameHint: 'a', bind: true }],
      parts: [],
    });
  });

  it('synthesizes an edge helix source and wraps it in axis()', async () => {
    currentSynthesis = {
      ok: true,
      spec: {
        feature: 'helix',
        filePath: '/ws/m.fluid.js',
        producers: [{ line: 4, column: 0, featureType: 'extrude', nameHint: 'e', bind: true }],
        parts: [{ producer: 0, accessor: 'endEdges', indices: [2], filterArgs: null }],
        imports: [],
      },
      preview: 'helix(axis(e.endEdges(2)))', args: 'e.endEdges(2)', alternatives: [],
    };
    const { status, body } = await post({
      feature: 'helix',
      source: { kind: 'edge', entity: { shapeId: 'shape-1', sub: { type: 'edge', index: 2 } } },
      turns: 2,
    });
    expect(status).toBe(200);
    expect(body.preview).toBe('helix(axis(e.endEdges(2))).turns(2)');
    expect(synthesizeCalls).toEqual([{ feature: 'helix', value: undefined }]);
    expect(relayed[0].spec).toMatchObject({
      feature: 'helix',
      helix: { source: { kind: 'edge' }, turns: 2 },
      parts: [{ producer: 0, accessor: 'endEdges' }],
      imports: ['axis'],
    });
  });

  it('synthesizes a face helix source on its own', async () => {
    currentSynthesis = {
      ok: true,
      spec: {
        feature: 'helix',
        filePath: '/ws/m.fluid.js',
        producers: [{ line: 4, column: 0, featureType: 'extrude', nameHint: 'e', bind: true }],
        parts: [{ producer: 0, accessor: 'sideFaces', indices: [0], filterArgs: null }],
        imports: [],
      },
      preview: 'helix(e.sideFaces(0))', args: 'e.sideFaces(0)', alternatives: [],
    };
    const { status, body } = await post({
      feature: 'helix',
      source: { kind: 'face', entity: { shapeId: 'shape-1', sub: { type: 'face', index: 0 } } },
      turns: 6,
    });
    expect(status).toBe(200);
    expect(body.preview).toBe('helix(e.sideFaces(0)).turns(6)');
    expect(synthesizeCalls).toEqual([{ feature: 'helix', value: undefined }]);
    expect(relayed[0].spec).toMatchObject({
      feature: 'helix',
      helix: { source: { kind: 'face' }, turns: 6 },
      parts: [{ producer: 0, accessor: 'sideFaces' }],
      imports: [],
    });
  });

  it('rejects a positive-only helix option that is negative', async () => {
    const { status, body } = await post({
      feature: 'helix', source: { kind: 'standard', axis: 'z' }, radius: -5,
    });
    expect(status).toBe(400);
    expect(body.error).toContain('radius');
  });

  it('rejects a non-face pick as the helix face source', async () => {
    const { status, body } = await post({
      feature: 'helix',
      source: { kind: 'face', entity: { shapeId: 'shape-1', sub: { type: 'edge', index: 0 } } },
    });
    expect(status).toBe(400);
    expect(body.error).toContain('face');
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
        { line: 6, featureType: 'wire', nameHint: 'g', bind: true },
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

  it('binds a helix as an edge plane base without synthesis', async () => {
    currentFileName = '/ws/m.fluid.js';
    currentCode = [
      `import { helix } from 'fluidcad/core'`,
      ``,
      `const spring = helix('z').radius(10).pitch(4).turns(6)`,
      ``,
    ].join('\n');
    const { status, body } = await post({
      feature: 'plane', type: 'edge', position: 0.5,
      bases: [{ kind: 'wire', filePath: '/ws/m.fluid.js', line: 3, column: 0 }],
    });
    expect(status).toBe(200);
    expect(body.preview).toBe('plane(spring, 0.5)');
    expect(synthesizeCalls).toEqual([]);
    expect(relayed[0].spec).toMatchObject({
      feature: 'plane',
      plane: { type: 'edge', position: 0.5, bases: [{ kind: 'wire', producer: 0 }] },
      producers: [{ line: 3, featureType: 'wire', nameHint: 'e', bind: true }],
      parts: [],
    });
  });

  it('binds a single-curve sketch as an edge plane base without synthesis', async () => {
    currentFileName = '/ws/m.fluid.js';
    currentCode = [
      `import { sketch, bezier } from 'fluidcad/core'`,
      ``,
      `const p = sketch('xy', () => { bezier([0, 0], [38.78, 52.5], [127.59, 51.17], [128.31, 88.4]) })`,
      ``,
    ].join('\n');
    const { status, body } = await post({
      feature: 'plane', type: 'edge', position: 0.5,
      bases: [{ kind: 'wire', filePath: '/ws/m.fluid.js', line: 3, column: 10 }],
    });
    expect(status).toBe(200);
    // The sketch draws one curve, so it addresses the edge directly — no
    // selector synthesis stands between the pick and the statement.
    expect(body.preview).toBe('plane(p, 0.5)');
    expect(synthesizeCalls).toEqual([]);
    expect(relayed[0].spec).toMatchObject({
      feature: 'plane',
      plane: { type: 'edge', position: 0.5, bases: [{ kind: 'wire', producer: 0 }] },
      producers: [{ line: 3, featureType: 'wire', nameHint: 'e', bind: true }],
      parts: [],
    });
  });

  it('rejects a helix base outside the edge form', async () => {
    const { status, body } = await post({
      feature: 'plane', type: 'offset', offset: 5,
      bases: [{ kind: 'wire', filePath: '/ws/m.fluid.js', line: 3, column: 0 }],
    });
    expect(status).toBe(400);
    expect(body.error).toContain('only valid for an edge plane');
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

  it('rejects an unsafe plane rotation expression', async () => {
    const { status, body } = await post({
      feature: 'plane', type: 'offset', rotateX: '1; nope()',
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
          draft: null, endOffset: null, drill: true, thin: null, profileText: null,
          toFaceText: null, toFaceKind: null,
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

    const CHAMFER_EDIT_CODE = [
      `import { chamfer } from 'fluidcad/core'`,
      ``,
      `chamfer(2, 45, true, e.endEdges())`,
      ``,
    ].join('\n');

    it('relays a chamfer edit second value and previews the overload', async () => {
      currentCode = CHAMFER_EDIT_CODE;
      currentFileName = '/ws/m.fluid.js';
      const { status, body } = await post({
        feature: 'chamfer',
        edit: { filePath: '/ws/m.fluid.js', line: 3, column: 0 },
        value: 2,
        distance2: 3,
      });
      expect(status).toBe(200);
      expect(body.preview).toBe('chamfer(2, 3, e.endEdges())');
      expect(relayed[0].spec).toMatchObject({
        feature: 'chamfer',
        value: 2,
        edit: { line: 3, column: 0, chamfer: { distance2: 3, isAngle: false } },
      });
    });

    it('returns a chamfer edit without a second value to the equal form', async () => {
      currentCode = CHAMFER_EDIT_CODE;
      currentFileName = '/ws/m.fluid.js';
      const { status, body } = await post({
        feature: 'chamfer',
        edit: { filePath: '/ws/m.fluid.js', line: 3, column: 0 },
        value: 2,
      });
      expect(status).toBe(200);
      expect(body.preview).toBe('chamfer(2, e.endEdges())');
      expect(relayed[0].spec.edit.chamfer).toEqual({ distance2: null, isAngle: false });
    });

    it('rejects a chamfer edit with an out-of-range angle', async () => {
      const { status } = await post({
        feature: 'chamfer',
        edit: { filePath: '/ws/m.fluid.js', line: 3, column: 0 },
        value: 2,
        distance2: 90,
        isAngle: true,
      });
      expect(status).toBe(400);
    });

    describe('offset (2D) edits', () => {
      const OFFSET_CODE = [
        `import { sketch, rect, offset } from 'fluidcad/core'`,
        ``,
        `sketch('xy', () => {`,
        `  const r = rect(100, 50)`,
        `  offset(2, r.edge('top'))`,
        `})`,
        ``,
      ].join('\n');
      const OFFSET_EDIT = { filePath: '/ws/m.fluid.js', line: 5, column: 2 };

      beforeEach(() => {
        currentCode = OFFSET_CODE;
        currentFileName = '/ws/m.fluid.js';
      });

      it('rewrites the distance and the toggles, keeping the targets', async () => {
        const { status, body } = await post({
          feature: 'offset', edit: OFFSET_EDIT, value: 5, close: true,
        });
        expect(status).toBe(200);
        expect(body.preview).toBe(`offset(5, r.edge('top')).close()`);
        expect(sketchSynthesizeCalls).toHaveLength(0);
        expect(relayed[0].spec).toMatchObject({
          feature: 'offset',
          value: 5,
          offset: { removeOriginal: false, close: true },
          edit: { line: 5, column: 2 },
          parts: [],
          clearBreakpoints: true,
        });
      });

      it('synthesizes re-picked sketch edges without a boundary', async () => {
        currentSynthesis = {
          ok: true,
          spec: {
            feature: 'offset', value: 5, filePath: '/ws/m.fluid.js',
            producers: [{ line: 4, column: 2, featureType: 'rect', nameHint: 'r', bind: true }],
            parts: [{ producer: 0, accessor: 'edge', indices: null, filterArgs: `'left'` }],
            imports: [],
          },
          preview: `offset(5, r.edge('left'))`,
          args: `r.edge('left')`,
          alternatives: [`r.edge(3)`],
        };
        const { status, body } = await post({
          feature: 'offset', edit: OFFSET_EDIT, value: 5, removeOriginal: true,
          sketchEntities: [{ shapeId: 'edge-7' }], preview: true,
        });
        expect(status).toBe(200);
        expect(body.preview).toBe(`offset(5, true, r.edge('left'))`);
        expect(body.args).toBe(`r.edge('left')`);
        expect(sketchSynthesizeCalls).toEqual([
          {
            picks: [{ shapeId: 'edge-7' }],
            feature: 'offset',
            value: 5,
            offset: { removeOriginal: true, close: false },
          },
        ]);
        expect(relayed).toHaveLength(0);
      });

      it('rejects a closed offset that also removes the original', async () => {
        const { status, body } = await post({
          feature: 'offset', edit: OFFSET_EDIT, value: 5, removeOriginal: true, close: true,
        });
        expect(status).toBe(400);
        expect(body.error).toContain('closed offset');
      });

      it('rejects a zero distance', async () => {
        const { status } = await post({ feature: 'offset', edit: OFFSET_EDIT, value: 0 });
        expect(status).toBe(400);
      });

      it('422s an edit whose statement is not an offset', async () => {
        const { status, body } = await post({
          feature: 'offset',
          edit: { filePath: '/ws/m.fluid.js', line: 4, column: 2 },
          value: 5,
        });
        expect(status).toBe(422);
        expect(body.reason).toContain('rect');
        expect(relayed).toHaveLength(0);
      });

      it('heals the edit line when the pause-before breakpoint shifted the statement', async () => {
        // The edit dialog's double-click pauses the build BEFORE the offset:
        // the inserted `breakpoint();` shifts the statement below the line
        // the dialog captured (OFFSET_EDIT still says 5). The statement's
        // exact text re-locates it.
        currentCode = [
          `import { sketch, rect, offset, breakpoint } from 'fluidcad/core'`,
          ``,
          `sketch('xy', () => {`,
          `  const r = rect(100, 50)`,
          `  breakpoint();`,
          ``,
          `  offset(2, r.edge('top'))`,
          `})`,
          ``,
        ].join('\n');
        const { status, body } = await post({
          feature: 'offset', edit: OFFSET_EDIT, value: 5, close: true,
          expectedStatement: `offset(2, r.edge('top'))`,
        });
        expect(status).toBe(200);
        expect(body.preview).toBe(`offset(5, r.edge('top')).close()`);
        expect(relayed[0].spec.edit).toMatchObject({ line: 7, column: 2 });
      });

      it('keeps the stale line when the statement text is ambiguous', async () => {
        // Two identical offset statements: content can no longer identify
        // the edited one, so the heal declines and the stale line surfaces
        // as the ordinary drift refusal instead of guessing.
        currentCode = [
          `import { sketch, rect, offset, breakpoint } from 'fluidcad/core'`,
          ``,
          `sketch('xy', () => {`,
          `  const r = rect(100, 50)`,
          `  breakpoint();`,
          ``,
          `  offset(2, r.edge('top'))`,
          `})`,
          `sketch('xz', () => {`,
          `  const r = rect(100, 50)`,
          `  offset(2, r.edge('top'))`,
          `})`,
          ``,
        ].join('\n');
        const { status } = await post({
          feature: 'offset', edit: OFFSET_EDIT, value: 5,
          expectedStatement: `offset(2, r.edge('top'))`,
        });
        expect(status).toBe(422);
        expect(relayed).toHaveLength(0);
      });
    });

    describe('slot (2D) edits', () => {
      const SLOT_CODE = [
        `import { sketch, hLine, slot } from 'fluidcad/core'`,
        ``,
        `sketch('xy', () => {`,
        `  const l = hLine(60)`,
        `  slot(l, 10)`,
        `})`,
        ``,
      ].join('\n');
      const SLOT_EDIT = { filePath: '/ws/m.fluid.js', line: 5, column: 2 };

      beforeEach(() => {
        currentCode = SLOT_CODE;
        currentFileName = '/ws/m.fluid.js';
      });

      it('rewrites the radius and the flag, keeping the source', async () => {
        const { status, body } = await post({
          feature: 'slot', edit: SLOT_EDIT, value: 12, removeOriginal: false,
        });
        expect(status).toBe(200);
        expect(body.preview).toBe('slot(l, 12, false)');
        expect(sketchSynthesizeCalls).toHaveLength(0);
        expect(relayed[0].spec).toMatchObject({
          feature: 'slot',
          value: 12,
          slot: { removeOriginal: false },
          edit: { line: 5, column: 2 },
          parts: [],
          clearBreakpoints: true,
        });
      });

      it('synthesizes a re-picked source without a boundary', async () => {
        currentSynthesis = {
          ok: true,
          spec: {
            feature: 'slot', value: 12, slot: { removeOriginal: true }, filePath: '/ws/m.fluid.js',
            producers: [{ line: 4, column: 2, featureType: 'line', nameHint: 'l', bind: true }],
            parts: [{ producer: 0, accessor: '', indices: null, filterArgs: null }],
            imports: [],
          },
          preview: 'slot(l, 12)',
          args: 'l',
          alternatives: [],
        };
        const { status, body } = await post({
          feature: 'slot', edit: SLOT_EDIT, value: 12,
          sketchEntities: [{ shapeId: 'edge-7' }], preview: true,
        });
        expect(status).toBe(200);
        expect(body.preview).toBe('slot(l, 12)');
        expect(body.args).toBe('l');
        expect(sketchSynthesizeCalls).toEqual([
          {
            picks: [{ shapeId: 'edge-7' }],
            feature: 'slot',
            value: 12,
            slot: { removeOriginal: true },
          },
        ]);
        expect(relayed).toHaveLength(0);
      });

      it('rejects a non-positive radius', async () => {
        const { status, body } = await post({ feature: 'slot', edit: SLOT_EDIT, value: 0 });
        expect(status).toBe(400);
        expect(body.error).toContain('positive');
      });

      it('replaces the statement via drawStatement (the Draw tab)', async () => {
        const { status, body } = await post({
          feature: 'slot', edit: SLOT_EDIT, drawStatement: 'slot([0, 0], [40, 20], 8)',
        });
        expect(status).toBe(200);
        expect(body.preview).toBe('slot([0, 0], [40, 20], 8)');
        expect(sketchSynthesizeCalls).toHaveLength(0);
        expect(relayed[0].spec.edit).toMatchObject({
          line: 5, column: 2,
          slot: { drawStatement: 'slot([0, 0], [40, 20], 8)' },
        });
      });

      it('rejects drawStatement combined with other slot fields', async () => {
        const { status, body } = await post({
          feature: 'slot', edit: SLOT_EDIT, drawStatement: 'slot(40, 8)', value: 12,
        });
        expect(status).toBe(400);
        expect(body.error).toContain('no other slot fields');
      });

      it('422s an edit whose statement is a from-dimensions slot', async () => {
        currentCode = [
          `import { sketch, slot } from 'fluidcad/core'`,
          ``,
          `sketch('xy', () => {`,
          `  slot(40, 8)`,
          `})`,
          ``,
        ].join('\n');
        const { status, body } = await post({
          feature: 'slot',
          edit: { filePath: '/ws/m.fluid.js', line: 4, column: 2 },
          value: 12,
        });
        expect(status).toBe(422);
        expect(body.reason).toContain('dimensions');
        expect(relayed).toHaveLength(0);
      });
    });

    describe('fillet (2D) edits', () => {
      const FILLET_CODE = [
        `import { sketch, rect, fillet } from 'fluidcad/core'`,
        ``,
        `sketch('xy', () => {`,
        `  const r = rect(100, 50)`,
        `  fillet(2, r.edge('top'))`,
        `})`,
        ``,
      ].join('\n');
      const FILLET_EDIT = { filePath: '/ws/m.fluid.js', line: 5, column: 2 };

      beforeEach(() => {
        currentCode = FILLET_CODE;
        currentFileName = '/ws/m.fluid.js';
      });

      it('rewrites the radius, keeping the targets verbatim', async () => {
        const { status, body } = await post({
          feature: 'fillet', edit: FILLET_EDIT, value: 5,
        });
        expect(status).toBe(200);
        expect(body.preview).toBe(`fillet(5, r.edge('top'))`);
        expect(sketchSynthesizeCalls).toHaveLength(0);
        expect(relayed[0].spec).toMatchObject({
          feature: 'fillet',
          value: 5,
          edit: { line: 5, column: 2 },
          parts: [],
          clearBreakpoints: true,
        });
      });

      it('synthesizes re-picked sketch edges without a boundary', async () => {
        currentSynthesis = {
          ok: true,
          spec: {
            feature: 'fillet', value: 5, filePath: '/ws/m.fluid.js',
            producers: [{ line: 4, column: 2, featureType: 'rect', nameHint: 'r', bind: true }],
            parts: [{ producer: 0, accessor: 'edge', indices: null, filterArgs: `'left'` }],
            imports: [],
          },
          preview: `fillet(5, r.edge('left'))`,
          args: `r.edge('left')`,
          alternatives: [`r.edge(3)`],
        };
        const { status, body } = await post({
          feature: 'fillet', edit: FILLET_EDIT, value: 5,
          sketchEntities: [{ shapeId: 'edge-7' }], preview: true,
        });
        expect(status).toBe(200);
        expect(body.preview).toBe(`fillet(5, r.edge('left'))`);
        expect(body.args).toBe(`r.edge('left')`);
        expect(sketchSynthesizeCalls).toEqual([
          {
            picks: [{ shapeId: 'edge-7' }],
            feature: 'fillet',
            value: 5,
          },
        ]);
        expect(relayed).toHaveLength(0);
      });

      it('rejects mixing 3D entities with sketchEntities', async () => {
        const { status, body } = await post({
          feature: 'fillet', edit: FILLET_EDIT, value: 5,
          entities: [PICK], sketchEntities: [{ shapeId: 'edge-7' }],
        });
        expect(status).toBe(400);
        expect(body.error).toContain('not both');
      });

      it('rejects a non-positive radius', async () => {
        const { status } = await post({ feature: 'fillet', edit: FILLET_EDIT, value: 0 });
        expect(status).toBe(400);
      });

      it('heals the edit line when the pause-before breakpoint shifted the statement', async () => {
        currentCode = [
          `import { sketch, rect, fillet, breakpoint } from 'fluidcad/core'`,
          ``,
          `sketch('xy', () => {`,
          `  const r = rect(100, 50)`,
          `  breakpoint();`,
          ``,
          `  fillet(2, r.edge('top'))`,
          `})`,
          ``,
        ].join('\n');
        const { status, body } = await post({
          feature: 'fillet', edit: FILLET_EDIT, value: 5,
          expectedStatement: `fillet(2, r.edge('top'))`,
        });
        expect(status).toBe(200);
        expect(body.preview).toBe(`fillet(5, r.edge('top'))`);
        expect(relayed[0].spec.edit).toMatchObject({ line: 7, column: 2 });
      });
    });

    describe('offset edit target seeding (/sketch/feature-sources)', () => {
      const SEED_CODE = [
        `import {breakpoint, sketch, rect, offset } from 'fluidcad/core'`,
        ``,
        `sketch('xy', () => {`,
        `  const r = rect(100, 50)`,
        `  breakpoint();`,
        ``,
        `  offset(2, r.edge('top'))`,
        `})`,
        ``,
      ].join('\n');

      async function postSources(body: unknown): Promise<{ status: number; body: any }> {
        const res = await fetch(`${baseUrl}/api/sketch/feature-sources`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        return { status: res.status, body: await res.json() };
      }

      beforeEach(() => {
        currentCode = SEED_CODE;
        currentFileName = '/ws/m.fluid.js';
      });

      it('heals the shifted line, parses the targets and resolves them', async () => {
        // The dialog captured line 5; the pause-before breakpoint shifted the
        // statement to line 7 — the same healing the apply route uses.
        const { status, body } = await postSources({
          edit: { filePath: '/ws/m.fluid.js', line: 5, column: 2 },
          expectedStatement: `offset(2, r.edge('top'))`,
        });
        expect(status).toBe(200);
        expect(body).toEqual({ ok: true, shapeIds: ['edge-1'] });
        expect(sketchTargetCalls).toEqual([[{ kind: 'accessor', line: 4, args: ['top'] }]]);
      });

      it('parses a 2D fillet statement’s targets the same way', async () => {
        currentCode = SEED_CODE.replace(`offset(2, r.edge('top'))`, `fillet(2, r.edge('top'), r)`);
        const { status, body } = await postSources({
          edit: { filePath: '/ws/m.fluid.js', line: 7, column: 2 },
        });
        expect(status).toBe(200);
        expect(body).toEqual({ ok: true, shapeIds: ['edge-1'] });
        expect(sketchTargetCalls).toEqual([[
          { kind: 'accessor', line: 4, args: ['top'] },
          { kind: 'owner', line: 4 },
        ]]);
      });

      it('resolves a whole-sketch offset to no seeds without touching the kernel', async () => {
        currentCode = SEED_CODE.replace(`offset(2, r.edge('top'))`, 'offset(2)');
        const { status, body } = await postSources({
          edit: { filePath: '/ws/m.fluid.js', line: 7, column: 2 },
        });
        expect(status).toBe(200);
        expect(body).toEqual({ ok: true, shapeIds: [] });
        expect(sketchTargetCalls).toHaveLength(0);
      });

      it('422s targets the parser cannot resolve', async () => {
        currentCode = SEED_CODE.replace(`r.edge('top')`, 'someHelper()');
        const { status, body } = await postSources({
          edit: { filePath: '/ws/m.fluid.js', line: 7, column: 2 },
        });
        expect(status).toBe(422);
        expect(body.error).toContain('someHelper');
        expect(sketchTargetCalls).toHaveLength(0);
      });

      it('422s a kernel refusal', async () => {
        currentSketchTargets = { ok: false, reason: 'no sketch is active' };
        const { status, body } = await postSources({
          edit: { filePath: '/ws/m.fluid.js', line: 7, column: 2 },
        });
        expect(status).toBe(422);
        expect(body.error).toContain('no sketch is active');
      });
    });

    describe('project (2D) edits', () => {
      const PROJECT_CODE = [
        `import { sketch, extrude, project } from 'fluidcad/core'`,
        ``,
        `const b = extrude(30)`,
        `sketch('xy', () => {`,
        `  project(b.sideFaces(0))`,
        `})`,
        ``,
      ].join('\n');
      const PROJECT_EDIT = { filePath: '/ws/m.fluid.js', line: 5, column: 2 };

      beforeEach(() => {
        currentCode = PROJECT_CODE;
        currentFileName = '/ws/m.fluid.js';
      });

      it('keeps the statement arguments when nothing is re-picked', async () => {
        const { status, body } = await post({
          feature: 'project', edit: PROJECT_EDIT, preview: true,
        });
        expect(status).toBe(200);
        expect(body.preview).toBe(`project(b.sideFaces(0))`);
        expect(synthesizeCalls).toHaveLength(0);
        expect(relayed).toHaveLength(0);
      });

      it('rewrites the source list from an edited expression row', async () => {
        const { status, body } = await post({
          feature: 'project', edit: PROJECT_EDIT, selectorOverride: 'b.sideFaces(1)',
        });
        expect(status).toBe(200);
        expect(body.preview).toBe(`project(b.sideFaces(1))`);
        expect(relayed[0].spec).toMatchObject({
          feature: 'project',
          rawArgs: 'b.sideFaces(1)',
          edit: { line: 5, column: 2 },
          clearBreakpoints: true,
        });
      });

      it('synthesizes re-picked 3D sources against the pre-statement boundary', async () => {
        currentSynthesis = {
          ok: true,
          spec: {
            feature: 'project', filePath: '/ws/m.fluid.js',
            producers: [{ line: 3, column: 10, featureType: 'extrude', nameHint: 'e', bind: true }],
            parts: [{ producer: 0, accessor: 'endFaces', indices: null, filterArgs: null }],
            imports: [],
          },
          preview: `project(b.endFaces())`,
          args: `b.endFaces()`,
          alternatives: [],
        };
        const before = { index: 8, type: 'projection', line: 5, column: 2 };
        const { status, body } = await post({
          feature: 'project', edit: PROJECT_EDIT, entities: [PICK], before, preview: true,
        });
        expect(status).toBe(200);
        expect(body.preview).toBe(`project(b.endFaces())`);
        expect(body.args).toBe(`b.endFaces()`);
        expect(synthesizeCalls).toEqual([{ feature: 'project', value: undefined }]);
        expect(synthesizeBoundaries).toEqual([before]);
        expect(relayed).toHaveLength(0);
      });

      it('400s re-picked sources without a boundary', async () => {
        // The picks were made against the edit session's pre-statement
        // rollback — boundary-less synthesis would resolve them against the
        // full scene.
        const { status, body } = await post({
          feature: 'project', edit: PROJECT_EDIT, entities: [PICK], preview: true,
        });
        expect(status).toBe(400);
        expect(body.error).toContain('before');
        expect(synthesizeCalls).toHaveLength(0);
      });

      it('heals the edit line when the pause-before breakpoint shifted the statement', async () => {
        currentCode = [
          `import { sketch, extrude, project, breakpoint } from 'fluidcad/core'`,
          ``,
          `const b = extrude(30)`,
          `sketch('xy', () => {`,
          `  breakpoint();`,
          ``,
          `  project(b.sideFaces(0))`,
          `})`,
          ``,
        ].join('\n');
        const { status, body } = await post({
          feature: 'project', edit: PROJECT_EDIT, selectorOverride: 'b.sideFaces(1)',
          expectedStatement: `project(b.sideFaces(0))`,
        });
        expect(status).toBe(200);
        expect(body.preview).toBe(`project(b.sideFaces(1))`);
        expect(relayed[0].spec.edit).toMatchObject({ line: 7, column: 2 });
      });

      it('422s an edit whose statement is not a project', async () => {
        const { status, body } = await post({
          feature: 'project',
          edit: { filePath: '/ws/m.fluid.js', line: 3, column: 10 },
        });
        expect(status).toBe(422);
        expect(body.reason).toContain('extrude');
        expect(relayed).toHaveLength(0);
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

    it('relays a sketch retarget onto an origin plane, no synthesis, no breakpoint clear', async () => {
      currentCode = EDIT_CODE;
      currentFileName = '/ws/m.fluid.js';
      const { status, body } = await post({
        feature: 'sketch',
        edit: { filePath: '/ws/m.fluid.js', line: 3, column: 0 },
        plane: 'xz',
      });
      expect(status).toBe(200);
      expect(body.success).toBe(true);
      expect(body.preview).toBe(`sketch('xz', () => { rect(100, 50) })`);
      expect(synthesizeCalls).toEqual([]);
      expect(relayed[0].spec).toMatchObject({
        feature: 'sketch',
        edit: { line: 3, column: 0, sketch: { target: { kind: 'standard', plane: 'xz' } } },
        clearBreakpoints: false,
      });
    });

    it('synthesizes a sketch retarget face pick without a boundary', async () => {
      currentCode = EDIT_CODE;
      currentFileName = '/ws/m.fluid.js';
      currentSynthesis = {
        ok: true,
        spec: {
          feature: 'sketch', filePath: '/ws/m.fluid.js',
          producers: [{ line: 4, column: 0, featureType: 'extrude', nameHint: 'e', bind: true }],
          parts: [{ producer: 0, accessor: 'endFaces', indices: [1], filterArgs: null }],
          imports: [],
        },
        preview: 'sketch(e.endFaces(1), () => {})',
        args: 'e.endFaces(1)',
        alternatives: [],
      };
      const { status, body } = await post({
        feature: 'sketch',
        edit: { filePath: '/ws/m.fluid.js', line: 3, column: 0 },
        entities: [PICK],
      });
      expect(status).toBe(200);
      expect(body.success).toBe(true);
      expect(body.preview).toBe(`sketch(e2.endFaces(1), () => { rect(100, 50) })`);
      expect(synthesizeCalls).toEqual([{ feature: 'sketch', value: undefined }]);
      expect(synthesizeBoundaries).toEqual([undefined]);
      expect(relayed[0].spec).toMatchObject({
        feature: 'sketch',
        edit: { line: 3, column: 0, sketch: { target: { kind: 'selector' } } },
        parts: [{ producer: 0, accessor: 'endFaces', indices: [1], filterArgs: null }],
      });
    });

    it('rejects a sketch retarget with more than one target source', async () => {
      const { status } = await post({
        feature: 'sketch',
        edit: { filePath: '/ws/m.fluid.js', line: 3, column: 0 },
        plane: 'xy',
        entities: [PICK],
      });
      expect(status).toBe(400);
    });

    it('rejects a sketch retarget with no target source', async () => {
      const { status } = await post({
        feature: 'sketch',
        edit: { filePath: '/ws/m.fluid.js', line: 3, column: 0 },
        entities: [],
      });
      expect(status).toBe(400);
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

      it('re-picks a face offset selection: synthesis with the boundary, parts on the spec', async () => {
        currentCode = [
          `import { sketch, rect, extrude, offset } from 'fluidcad/core'`,
          ``,
          `sketch('xy', () => { rect(100, 50) })`,
          `const e = extrude(30)`,
          `offset(-5, e.endFaces())`,
          ``,
        ].join('\n');
        currentSynthesis = {
          ok: true,
          spec: {
            feature: 'offset',
            value: -5,
            filePath: '/ws/m.fluid.js',
            producers: [{ line: 4, column: 0, featureType: 'extrude', nameHint: 'e', bind: true }],
            parts: [{ producer: 0, accessor: 'startFaces', indices: null, filterArgs: null }],
            imports: [],
          },
          preview: 'offset(-5, e.startFaces())',
          args: 'e.startFaces()',
          alternatives: [],
        };
        const offsetBefore = { index: 2, type: 'offset', line: 5, column: 0 };
        const { status, body } = await post({
          feature: 'offset',
          edit: { filePath: '/ws/m.fluid.js', line: 5, column: 0 },
          value: -5,
          entities: [FACE_PICK],
          before: offsetBefore,
        });
        expect(status).toBe(200);
        expect(body.success).toBe(true);
        expect(synthesizeCalls).toEqual([{ feature: 'offset', value: -5 }]);
        expect(synthesizeBoundaries).toEqual([offsetBefore]);
        expect(relayed[0].spec).toMatchObject({
          feature: 'offset',
          value: -5,
          producers: [{ line: 4, featureType: 'extrude', bind: true }],
          parts: [{ producer: 0, accessor: 'startFaces' }],
          edit: { line: 5, column: 0 },
          clearBreakpoints: true,
        });
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

      it('swaps a picked to-face target for the first-face literal, synthesizing nothing', async () => {
        currentCode = TOFACE_CODE;
        const { status, body } = await post({
          feature: 'extrude',
          edit: { filePath: '/ws/m.fluid.js', line: 6, column: 0 },
          op: 'add', distance: null, thin: null,
          toFace: { kind: 'first-face' },
        });
        expect(status).toBe(200);
        expect(body.preview).toBe(`extrude('first-face', p)`);
        expect(synthesizeCalls).toEqual([]);
        expect(relayed[0].spec).toMatchObject({
          feature: 'extrude',
          parts: [],
          edit: { line: 6, column: 0, extrude: { toFace: { kind: 'first-face' } } },
        });
      });

      it('rejects an unknown edited to-face kind', async () => {
        currentCode = TOFACE_CODE;
        const { status, body } = await post({
          feature: 'extrude',
          edit: { filePath: '/ws/m.fluid.js', line: 6, column: 0 },
          op: 'add', distance: null, thin: null,
          toFace: { kind: 'middle-face' },
        });
        expect(status).toBe(400);
        expect(body.error).toContain('toFace');
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

  describe('repeat', () => {
    const T1 = { filePath: '/ws/m.fluid.js', line: 4, column: 0 };
    const T2 = { filePath: '/ws/m.fluid.js', line: 6, column: 0 };
    const CODE = [
      "import { sketch, rect, extrude, cut } from 'fluidcad/core'",
      '',
      "sketch('xy', () => { rect(100, 50) })",
      'extrude(30)',
      "sketch('xy', () => { rect(10, 10) })",
      'cut(5)',
      '',
    ].join('\n');

    it('rejects an unknown kind', async () => {
      const { status, body } = await post({ feature: 'repeat', kind: 'spiral', targets: [T1] });
      expect(status).toBe(400);
      expect(body.error).toContain('kind must be');
    });

    it('rejects an empty target list', async () => {
      const { status, body } = await post({
        feature: 'repeat', kind: 'linear', targets: [], spacingMode: 'offset',
        directions: [{ axis: { kind: 'standard', axis: 'x' }, count: 3, value: 40 }],
      });
      expect(status).toBe(400);
      expect(body.error).toContain('targets must be');
    });

    it('rejects a duplicate target', async () => {
      const { status, body } = await post({
        feature: 'repeat', kind: 'mirror', targets: [T1, T1],
        plane: { kind: 'standard', plane: 'yz' },
      });
      expect(status).toBe(400);
      expect(body.error).toContain('picked twice');
    });

    it('rejects an axis on a mirror repeat', async () => {
      const { status, body } = await post({
        feature: 'repeat', kind: 'mirror', targets: [T1],
        plane: { kind: 'standard', plane: 'yz' }, axis: { kind: 'standard', axis: 'x' },
      });
      expect(status).toBe(400);
      expect(body.error).toContain('a mirror repeat takes no axis');
    });

    it('rejects a direction count below 2', async () => {
      const { status, body } = await post({
        feature: 'repeat', kind: 'linear', targets: [T1], spacingMode: 'offset',
        directions: [{ axis: { kind: 'standard', axis: 'x' }, count: 1, value: 40 }],
      });
      expect(status).toBe(400);
      expect(body.error).toContain('each direction count must be an integer of at least 2');
    });

    it('rejects directions on a circular repeat', async () => {
      const { status, body } = await post({
        feature: 'repeat', kind: 'circular', targets: [T1],
        axis: { kind: 'standard', axis: 'z' }, count: 4, sweep: { mode: 'angle', value: 360 },
        directions: [{ axis: { kind: 'standard', axis: 'x' }, count: 3, value: 40 }],
      });
      expect(status).toBe(400);
      expect(body.error).toContain('only a linear repeat takes directions');
    });

    it('rejects a zero rotate angle', async () => {
      const { status, body } = await post({
        feature: 'repeat', kind: 'rotate', targets: [T1],
        axis: { kind: 'standard', axis: 'z' }, angle: 0,
      });
      expect(status).toBe(400);
      expect(body.error).toContain('angle must be a nonzero');
    });

    it('previews and relays a linear repeat on a standard axis', async () => {
      currentCode = CODE;
      const linearBody = {
        feature: 'repeat', kind: 'linear', targets: [T1, T2], spacingMode: 'offset',
        directions: [{ axis: { kind: 'standard', axis: 'x' }, count: 3, value: 40 }],
      };
      const preview = await post({ ...linearBody, preview: true });
      expect(preview.status).toBe(200);
      expect(preview.body.preview).toBe("repeat('linear', 'x', { count: 3, offset: 40 }, f, f2)");
      expect(relayed).toEqual([]);
      expect(synthesizeCalls).toEqual([]);

      const { status, body } = await post(linearBody);
      expect(status).toBe(200);
      expect(body.success).toBe(true);
      expect(relayed).toHaveLength(1);
      const spec = relayed[0].spec;
      expect(relayed[0].type).toBe('apply-feature-edit');
      expect(spec.feature).toBe('repeat');
      expect(spec.repeat.kind).toBe('linear');
      expect(spec.repeat.spacingMode).toBe('offset');
      expect(spec.repeat.directions).toEqual([
        { axis: { kind: 'standard', axis: 'x' }, count: 3, value: 40 },
      ]);
      expect(spec.repeat.targets).toEqual([{ producer: 0 }, { producer: 1 }]);
      expect(spec.producers).toHaveLength(2);
      expect(spec.producers.every((p: any) => p.featureType === 'feature' && p.bind)).toBe(true);
      expect(spec.parts).toEqual([]);
    });

    it('previews a two-direction linear repeat as the array forms', async () => {
      currentCode = CODE;
      const { status, body } = await post({
        feature: 'repeat', kind: 'linear', targets: [T1], spacingMode: 'length',
        directions: [
          { axis: { kind: 'standard', axis: 'x' }, count: 3, value: 120 },
          { axis: { kind: 'standard', axis: 'y' }, count: 2, value: 60 },
        ],
        preview: true,
      });
      expect(status).toBe(200);
      expect(body.preview).toBe("repeat('linear', ['x', 'y'], { count: [3, 2], length: [120, 60] }, f)");
    });

    it('synthesizes a picked mirror face through the plane kind', async () => {
      currentCode = CODE;
      currentSynthesis = {
        ok: true,
        spec: {
          feature: 'plane',
          filePath: '/ws/m.fluid.js',
          producers: [{ line: 4, column: 0, featureType: 'extrude', nameHint: 'e', bind: true }],
          parts: [{ producer: 0, accessor: 'endFaces', indices: [0], filterArgs: null }],
          imports: [],
        },
        preview: '',
        args: 'e.endFaces(0)',
        alternatives: [],
      };
      const { status, body } = await post({
        feature: 'repeat', kind: 'mirror', targets: [T2],
        plane: { kind: 'face', entity: PICK },
      });
      expect(status).toBe(200);
      expect(synthesizeCalls).toEqual([{ feature: 'plane', value: undefined }]);
      expect(body.preview).toContain("repeat('mirror', plane(");
      expect(relayed).toHaveLength(1);
      const spec = relayed[0].spec;
      expect(spec.repeat.plane).toEqual({ kind: 'selector', part: 0 });
      expect(spec.imports).toContain('plane');
      expect(spec.parts).toHaveLength(1);
    });

    it('synthesizes a picked axis edge through the revolve kind', async () => {
      currentCode = CODE;
      currentSynthesis = {
        ok: true,
        spec: {
          feature: 'revolve',
          filePath: '/ws/m.fluid.js',
          producers: [{ line: 4, column: 0, featureType: 'extrude', nameHint: 'e', bind: true }],
          parts: [{ producer: 0, accessor: 'endEdges', indices: [2], filterArgs: null }],
          imports: [],
        },
        preview: '',
        args: 'e.endEdges(2)',
        alternatives: [],
      };
      const { status, body } = await post({
        feature: 'repeat', kind: 'circular', targets: [T2],
        axis: { kind: 'edge', entity: { shapeId: 'shape-1', sub: { type: 'edge', index: 2 } } },
        count: 6, sweep: { mode: 'angle', value: 360 },
      });
      expect(status).toBe(200);
      expect(synthesizeCalls).toEqual([{ feature: 'revolve', value: undefined }]);
      expect(body.preview).toContain('axis(');
      expect(body.preview).toContain('{ count: 6, angle: 360 }');
      expect(relayed).toHaveLength(1);
      const spec = relayed[0].spec;
      expect(spec.repeat.axis).toEqual({ kind: 'selector', part: 0 });
      expect(spec.imports).toContain('axis');
    });

    it('surfaces a synthesis refusal for the picked input as 422', async () => {
      currentSynthesis = { ok: false, reason: 'that face cannot be named' };
      const { status, body } = await post({
        feature: 'repeat', kind: 'mirror', targets: [T2],
        plane: { kind: 'face', entity: PICK },
      });
      expect(status).toBe(422);
      expect(body.reason).toContain('cannot be named');
      expect(relayed).toEqual([]);
    });
  });

  describe('repeat edit', () => {
    const EDIT_CODE = [
      "import { sketch, rect, extrude, cut, repeat } from 'fluidcad/core'",
      '',
      "sketch('xy', () => { rect(100, 50) })",
      'const e = extrude(30)',
      "sketch('xy', () => { rect(10, 10) })",
      'const c = cut(5)',
      "repeat('rotate', 'z', 45, e)",
      '',
    ].join('\n');
    const EDIT = { filePath: '/ws/m.fluid.js', line: 7, column: 0 };
    const EDIT_BEFORE = { index: 6, type: 'repeat-matrix', line: 7, column: 0 };

    it('relays a rotate edit keeping the statement axis and previews it', async () => {
      currentCode = EDIT_CODE;
      currentFileName = '/ws/m.fluid.js';
      const { status, body } = await post({
        feature: 'repeat', edit: EDIT, kind: 'rotate', angle: 30,
      });
      expect(status).toBe(200);
      expect(body.preview).toBe("repeat('rotate', 'z', 30, e)");
      expect(synthesizeCalls).toEqual([]);
      expect(relayed[0].spec).toMatchObject({
        feature: 'repeat',
        producers: [],
        parts: [],
        edit: {
          line: 7, column: 0,
          repeat: { kind: 'rotate', angle: 30, axis: { kind: 'keep', sourceIndex: 0 } },
        },
        clearBreakpoints: true,
      });
    });

    it('replaces the target list, binding a re-picked feature', async () => {
      currentCode = EDIT_CODE;
      currentFileName = '/ws/m.fluid.js';
      const { status, body } = await post({
        feature: 'repeat', edit: EDIT, kind: 'rotate', angle: 45,
        targets: [
          { kind: 'verbatim', sourceIndex: 0 },
          { kind: 'feature', filePath: '/ws/m.fluid.js', line: 6, column: 0 },
        ],
      });
      expect(status).toBe(200);
      expect(body.preview).toBe("repeat('rotate', 'z', 45, e, c)");
      expect(relayed[0].spec).toMatchObject({
        producers: [{ line: 6, featureType: 'feature', bind: true }],
        edit: {
          repeat: {
            targets: [{ kind: 'verbatim', sourceIndex: 0 }, { kind: 'feature', producer: 0 }],
          },
        },
      });
    });

    it('re-picks the axis edge: synthesis with the boundary, selector on the edit spec', async () => {
      currentCode = EDIT_CODE;
      currentFileName = '/ws/m.fluid.js';
      currentSynthesis = {
        ok: true,
        spec: {
          feature: 'revolve',
          filePath: '/ws/m.fluid.js',
          producers: [{ line: 4, column: 0, featureType: 'extrude', nameHint: 'e', bind: true }],
          parts: [{ producer: 0, accessor: 'endEdges', indices: [2], filterArgs: null }],
          imports: [],
        },
        preview: '',
        args: 'e.endEdges(2)',
        alternatives: [],
      };
      const { status, body } = await post({
        feature: 'repeat', edit: EDIT, kind: 'rotate', angle: 45,
        axis: { kind: 'edge', entity: { shapeId: 'shape-1', sub: { type: 'edge', index: 2 } } },
        before: EDIT_BEFORE,
      });
      expect(status).toBe(200);
      expect(body.preview).toBe("repeat('rotate', axis(e.endEdges(2)), 45, e)");
      expect(synthesizeCalls).toEqual([{ feature: 'revolve', value: undefined }]);
      expect(synthesizeBoundaries).toEqual([EDIT_BEFORE]);
      expect(relayed[0].spec).toMatchObject({
        producers: [{ line: 4, featureType: 'extrude' }],
        parts: [{ producer: 0, accessor: 'endEdges', indices: [2] }],
        edit: { repeat: { axis: { kind: 'selector', part: 0 } } },
      });
      expect(relayed[0].spec.imports).toContain('axis');
    });

    it('rejects a re-picked axis edge without a boundary', async () => {
      currentCode = EDIT_CODE;
      currentFileName = '/ws/m.fluid.js';
      const { status, body } = await post({
        feature: 'repeat', edit: EDIT, kind: 'rotate', angle: 45,
        axis: { kind: 'edge', entity: { shapeId: 'shape-1', sub: { type: 'edge', index: 2 } } },
      });
      expect(status).toBe(400);
      expect(body.error).toContain('before is required');
      expect(synthesizeCalls).toEqual([]);
    });

    it('rejects an unknown kind on an edit', async () => {
      const { status, body } = await post({ feature: 'repeat', edit: EDIT, kind: 'spiral' });
      expect(status).toBe(400);
      expect(body.error).toContain('kind must be');
    });

    it('422s an edit whose statement is not a repeat', async () => {
      currentCode = EDIT_CODE;
      currentFileName = '/ws/m.fluid.js';
      const { status, body } = await post({
        feature: 'repeat',
        edit: { filePath: '/ws/m.fluid.js', line: 4, column: 0 },
        kind: 'rotate', angle: 45,
      });
      expect(status).toBe(422);
      expect(body.reason).toContain('not a repeat');
      expect(relayed).toHaveLength(0);
    });
  });

  describe('copy', () => {
    const T1 = { filePath: '/ws/m.fluid.js', line: 4, column: 0 };
    const T2 = { filePath: '/ws/m.fluid.js', line: 6, column: 0 };
    const CODE = [
      "import { sketch, rect, extrude, cut } from 'fluidcad/core'",
      '',
      "sketch('xy', () => { rect(100, 50) })",
      'extrude(30)',
      "sketch('xy', () => { rect(10, 10) })",
      'cut(5)',
      '',
    ].join('\n');

    it('rejects an unknown kind', async () => {
      const { status, body } = await post({ feature: 'copy', kind: 'mirror', targets: [T1] });
      expect(status).toBe(400);
      expect(body.error).toContain('kind must be');
    });

    it('rejects an empty target list', async () => {
      const { status, body } = await post({
        feature: 'copy', kind: 'linear', targets: [], spacingMode: 'offset',
        directions: [{ axis: { kind: 'standard', axis: 'x' }, count: 3, value: 40 }],
      });
      expect(status).toBe(400);
      expect(body.error).toContain('targets must be');
    });

    it('rejects more targets than the ceiling', async () => {
      const targets = Array.from({ length: 17 }, (_, i) => ({
        filePath: '/ws/m.fluid.js', line: i + 1, column: 0,
      }));
      const { status, body } = await post({
        feature: 'copy', kind: 'linear', targets, spacingMode: 'offset',
        directions: [{ axis: { kind: 'standard', axis: 'x' }, count: 3, value: 40 }],
      });
      expect(status).toBe(400);
      expect(body.error).toContain('targets must be 1-16');
    });

    it('rejects a circular copy without an axis', async () => {
      const { status, body } = await post({
        feature: 'copy', kind: 'circular', targets: [T1],
        count: 6, sweep: { mode: 'angle', value: 360 },
      });
      expect(status).toBe(400);
      expect(body.error).toContain('axis must be');
    });

    it('rejects directions on a circular copy', async () => {
      const { status, body } = await post({
        feature: 'copy', kind: 'circular', targets: [T1],
        axis: { kind: 'standard', axis: 'z' }, count: 4, sweep: { mode: 'angle', value: 360 },
        directions: [{ axis: { kind: 'standard', axis: 'x' }, count: 3, value: 40 }],
      });
      expect(status).toBe(400);
      expect(body.error).toContain('only a linear copy takes directions');
    });

    it('rejects a centered flag on a circular copy', async () => {
      const { status, body } = await post({
        feature: 'copy', kind: 'circular', targets: [T1],
        axis: { kind: 'standard', axis: 'z' }, count: 4, sweep: { mode: 'angle', value: 360 },
        centered: true,
      });
      expect(status).toBe(400);
      expect(body.error).toContain('a circular copy takes no centered flag');
    });

    it('previews and relays a linear copy on a standard axis', async () => {
      currentCode = CODE;
      const linearBody = {
        feature: 'copy', kind: 'linear', targets: [T1, T2], spacingMode: 'offset',
        directions: [{ axis: { kind: 'standard', axis: 'x' }, count: 3, value: 40 }],
      };
      const preview = await post({ ...linearBody, preview: true });
      expect(preview.status).toBe(200);
      expect(preview.body.preview).toBe("copy('linear', 'x', { count: 3, offset: 40 }, f, f2)");
      expect(relayed).toEqual([]);
      expect(synthesizeCalls).toEqual([]);

      const { status, body } = await post(linearBody);
      expect(status).toBe(200);
      expect(body.success).toBe(true);
      expect(relayed).toHaveLength(1);
      const spec = relayed[0].spec;
      expect(relayed[0].type).toBe('apply-feature-edit');
      expect(spec.feature).toBe('copy');
      expect(spec.copy.kind).toBe('linear');
      expect(spec.copy.spacingMode).toBe('offset');
      expect(spec.copy.directions).toEqual([
        { axis: { kind: 'standard', axis: 'x' }, count: 3, value: 40 },
      ]);
      expect(spec.copy.targets).toEqual([{ producer: 0 }, { producer: 1 }]);
      expect(spec.producers).toHaveLength(2);
      expect(spec.producers.every((p: any) => p.featureType === 'feature' && p.bind)).toBe(true);
      expect(spec.parts).toEqual([]);
    });

    it('previews and relays a circular copy on a standard axis', async () => {
      currentCode = CODE;
      const circularBody = {
        feature: 'copy', kind: 'circular', targets: [T1],
        axis: { kind: 'standard', axis: 'z' }, count: 6, sweep: { mode: 'angle', value: 360 },
      };
      const preview = await post({ ...circularBody, preview: true });
      expect(preview.status).toBe(200);
      expect(preview.body.preview).toBe("copy('circular', 'z', { count: 6, angle: 360 }, f)");

      const { status } = await post(circularBody);
      expect(status).toBe(200);
      expect(relayed).toHaveLength(1);
      const spec = relayed[0].spec;
      expect(spec.copy.kind).toBe('circular');
      expect(spec.copy.count).toBe(6);
      expect(spec.copy.sweep).toEqual({ mode: 'angle', value: 360 });
      expect(spec.copy.targets).toEqual([{ producer: 0 }]);
    });

    it('writes the skip list each kind spells', async () => {
      currentCode = CODE;
      const linear = await post({
        feature: 'copy', kind: 'linear', targets: [T1], spacingMode: 'offset',
        directions: [{ axis: { kind: 'standard', axis: 'x' }, count: 4, value: 40 }],
        skip: [[1], [3]],
        preview: true,
      });
      expect(linear.status).toBe(200);
      expect(linear.body.preview).toBe("copy('linear', 'x', { count: 4, offset: 40, skip: [[1], [3]] }, f)");

      const circular = await post({
        feature: 'copy', kind: 'circular', targets: [T1],
        axis: { kind: 'standard', axis: 'z' }, count: 6, sweep: { mode: 'angle', value: 360 },
        skip: [[2]],
        preview: true,
      });
      expect(circular.status).toBe(200);
      expect(circular.body.preview).toBe("copy('circular', 'z', { count: 6, angle: 360, skip: [2] }, f)");
    });

    it('rejects skip entries that are not whole indices, or wider than the directions', async () => {
      currentCode = CODE;
      const base = {
        feature: 'copy', kind: 'linear', targets: [T1], spacingMode: 'offset',
        directions: [{ axis: { kind: 'standard', axis: 'x' }, count: 4, value: 40 }],
        preview: true,
      };
      for (const skip of [[[1.5]], [[-1]], [['1']], [[]], [[1, 2]], [1]]) {
        const { status, body } = await post({ ...base, skip });
        expect(status, JSON.stringify(skip)).toBe(400);
        expect(body.error).toContain('skip');
      }
    });

    it('synthesizes a picked axis edge through the revolve kind', async () => {
      currentCode = CODE;
      currentSynthesis = {
        ok: true,
        spec: {
          feature: 'revolve',
          filePath: '/ws/m.fluid.js',
          producers: [{ line: 4, column: 0, featureType: 'extrude', nameHint: 'e', bind: true }],
          parts: [{ producer: 0, accessor: 'endEdges', indices: [2], filterArgs: null }],
          imports: [],
        },
        preview: '',
        args: 'e.endEdges(2)',
        alternatives: [],
      };
      const { status, body } = await post({
        feature: 'copy', kind: 'circular', targets: [T2],
        axis: { kind: 'edge', entity: { shapeId: 'shape-1', sub: { type: 'edge', index: 2 } } },
        count: 6, sweep: { mode: 'angle', value: 360 },
      });
      expect(status).toBe(200);
      expect(synthesizeCalls).toEqual([{ feature: 'revolve', value: undefined }]);
      expect(body.preview).toContain('axis(');
      expect(body.preview).toContain('{ count: 6, angle: 360 }');
      expect(relayed).toHaveLength(1);
      const spec = relayed[0].spec;
      expect(spec.copy.axis).toEqual({ kind: 'selector', part: 0 });
      expect(spec.imports).toContain('axis');
    });

    it('surfaces a synthesis refusal for the picked axis as 422', async () => {
      currentSynthesis = { ok: false, reason: 'that edge cannot be named' };
      const { status, body } = await post({
        feature: 'copy', kind: 'circular', targets: [T2],
        axis: { kind: 'edge', entity: { shapeId: 'shape-1', sub: { type: 'edge', index: 2 } } },
        count: 6, sweep: { mode: 'angle', value: 360 },
      });
      expect(status).toBe(422);
      expect(body.reason).toContain('cannot be named');
      expect(relayed).toEqual([]);
    });
  });

  describe('copy edit', () => {
    const EDIT_CODE = [
      "import { sketch, rect, extrude, cut, copy } from 'fluidcad/core'",
      '',
      "sketch('xy', () => { rect(100, 50) })",
      'const e = extrude(30)',
      "sketch('xy', () => { rect(10, 10) })",
      'const c = cut(5)',
      "copy('linear', 'x', { count: 3, offset: 40 }, e)",
      '',
    ].join('\n');
    const EDIT = { filePath: '/ws/m.fluid.js', line: 7, column: 0 };
    const EDIT_BEFORE = { index: 6, type: 'copy-linear', line: 7, column: 0 };

    it('relays a linear edit keeping the statement axis and previews it', async () => {
      currentCode = EDIT_CODE;
      currentFileName = '/ws/m.fluid.js';
      const { status, body } = await post({
        feature: 'copy', edit: EDIT, kind: 'linear', spacingMode: 'length',
        directions: [{ count: 5, value: 120 }],
      });
      expect(status).toBe(200);
      expect(body.preview).toBe("copy('linear', 'x', { count: 5, length: 120 }, e)");
      expect(synthesizeCalls).toEqual([]);
      expect(relayed[0].spec).toMatchObject({
        feature: 'copy',
        producers: [],
        parts: [],
        edit: {
          line: 7, column: 0,
          copy: {
            kind: 'linear',
            spacingMode: 'length',
            directions: [{ axis: { kind: 'keep', sourceIndex: 0 }, count: 5, value: 120 }],
          },
        },
        clearBreakpoints: true,
      });
    });

    it('relays the edited skip list onto the edit spec', async () => {
      currentCode = EDIT_CODE;
      currentFileName = '/ws/m.fluid.js';
      const { status, body } = await post({
        feature: 'copy', edit: EDIT, kind: 'linear', spacingMode: 'offset',
        directions: [{ count: 4, value: 40 }],
        skip: [[1], [3]],
      });
      expect(status).toBe(200);
      expect(body.preview).toBe("copy('linear', 'x', { count: 4, offset: 40, skip: [[1], [3]] }, e)");
      expect(relayed[0].spec.edit.copy.skip).toEqual([[1], [3]]);
    });

    it('rewrites the kind to circular, replacing the target list', async () => {
      currentCode = EDIT_CODE;
      currentFileName = '/ws/m.fluid.js';
      const { status, body } = await post({
        feature: 'copy', edit: EDIT, kind: 'circular',
        axis: { kind: 'standard', axis: 'z' }, count: 6, sweep: { mode: 'angle', value: 360 },
        targets: [
          { kind: 'verbatim', sourceIndex: 0 },
          { kind: 'feature', filePath: '/ws/m.fluid.js', line: 6, column: 0 },
        ],
      });
      expect(status).toBe(200);
      expect(body.preview).toBe("copy('circular', 'z', { count: 6, angle: 360 }, e, c)");
      expect(relayed[0].spec).toMatchObject({
        producers: [{ line: 6, featureType: 'feature', bind: true }],
        edit: {
          copy: {
            kind: 'circular',
            targets: [{ kind: 'verbatim', sourceIndex: 0 }, { kind: 'feature', producer: 0 }],
          },
        },
      });
    });

    it('re-picks the axis edge: synthesis with the boundary, selector on the edit spec', async () => {
      currentCode = EDIT_CODE;
      currentFileName = '/ws/m.fluid.js';
      currentSynthesis = {
        ok: true,
        spec: {
          feature: 'revolve',
          filePath: '/ws/m.fluid.js',
          producers: [{ line: 4, column: 0, featureType: 'extrude', nameHint: 'e', bind: true }],
          parts: [{ producer: 0, accessor: 'endEdges', indices: [2], filterArgs: null }],
          imports: [],
        },
        preview: '',
        args: 'e.endEdges(2)',
        alternatives: [],
      };
      const { status, body } = await post({
        feature: 'copy', edit: EDIT, kind: 'linear', spacingMode: 'offset',
        directions: [{
          axis: { kind: 'edge', entity: { shapeId: 'shape-1', sub: { type: 'edge', index: 2 } } },
          count: 3, value: 40,
        }],
        before: EDIT_BEFORE,
      });
      expect(status).toBe(200);
      expect(body.preview).toBe("copy('linear', axis(e.endEdges(2)), { count: 3, offset: 40 }, e)");
      expect(synthesizeCalls).toEqual([{ feature: 'revolve', value: undefined }]);
      expect(synthesizeBoundaries).toEqual([EDIT_BEFORE]);
      expect(relayed[0].spec).toMatchObject({
        producers: [{ line: 4, featureType: 'extrude' }],
        parts: [{ producer: 0, accessor: 'endEdges', indices: [2] }],
        edit: { copy: { directions: [{ axis: { kind: 'selector', part: 0 } }] } },
      });
      expect(relayed[0].spec.imports).toContain('axis');
    });

    it('rejects a re-picked axis edge without a boundary', async () => {
      currentCode = EDIT_CODE;
      currentFileName = '/ws/m.fluid.js';
      const { status, body } = await post({
        feature: 'copy', edit: EDIT, kind: 'linear', spacingMode: 'offset',
        directions: [{
          axis: { kind: 'edge', entity: { shapeId: 'shape-1', sub: { type: 'edge', index: 2 } } },
          count: 3, value: 40,
        }],
      });
      expect(status).toBe(400);
      expect(body.error).toContain('before is required');
      expect(synthesizeCalls).toEqual([]);
    });

    it('rejects an unknown kind on an edit', async () => {
      const { status, body } = await post({ feature: 'copy', edit: EDIT, kind: 'mirror' });
      expect(status).toBe(400);
      expect(body.error).toContain('kind must be');
    });

    it('422s an edit whose statement is not a copy', async () => {
      currentCode = EDIT_CODE;
      currentFileName = '/ws/m.fluid.js';
      const { status, body } = await post({
        feature: 'copy',
        edit: { filePath: '/ws/m.fluid.js', line: 4, column: 0 },
        kind: 'linear', spacingMode: 'offset',
        directions: [{ count: 3, value: 40 }],
      });
      expect(status).toBe(422);
      expect(body.reason).toContain('not a copy');
      expect(relayed).toHaveLength(0);
    });
  });

  // The in-sketch copy (sketchEntities branch): targets are whole geometries
  // as bare variables, the quick buttons emit sketch-local axes, an
  // edge-picked direction renders `axis(<var>)`, and the circular kind takes
  // an [x, y] center. The kernel resolution is mocked; the statement
  // rendering and spec assembly are the real route's.
  describe('2D copy (sketch branch)', () => {
    const CODE = [
      "import { sketch, rect, aLine, move } from 'fluidcad/core'",
      '',
      "sketch('xy', () => {",
      '  rect(20, 20)',
      '  move([0, 40])',
      '  aLine(30, 50)',
      '})',
      '',
    ].join('\n');

    const copySynthesis = (opts: {
      producers: any[]; parts?: any[]; targets: number[]; axisParts?: number[]; args?: string;
    }) => ({
      ok: true,
      spec: {
        feature: 'copy', filePath: '/ws/m.fluid.js',
        producers: opts.producers, parts: opts.parts ?? [], imports: [],
      },
      preview: '', args: opts.args ?? 'r', alternatives: [],
      copySlots: { targets: opts.targets, axisParts: opts.axisParts ?? [] },
    });

    it('renders a linear copy along a sketch-local axis and imports local', async () => {
      currentCode = CODE;
      currentSynthesis = copySynthesis({
        producers: [{ line: 4, column: 2, featureType: 'rect', nameHint: 'r', bind: true }],
        targets: [0],
      });
      const { status, body } = await post({
        feature: 'copy', sketchEntities: [{ shapeId: 'e1' }],
        copy2d: {
          kind: 'linear', spacingMode: 'offset',
          directions: [{ axis: { kind: 'local', axis: 'x' }, count: 3, value: 20 }],
        },
      });
      expect(status).toBe(200);
      expect(body.preview).toBe("copy('linear', local('x'), { count: 3, offset: 20 }, r)");
      expect(sketchSynthesizeCalls).toEqual([{
        picks: [{ shapeId: 'e1' }], feature: 'copy', value: undefined,
        offset: undefined, slot: undefined, axisRefs: [],
      }]);
      expect(relayed[0].spec).toMatchObject({
        feature: 'copy',
        copy: {
          kind: 'linear', spacingMode: 'offset',
          directions: [{ axis: { kind: 'local', axis: 'x' }, count: 3, value: 20 }],
          targets: [{ producer: 0 }],
        },
      });
      expect(relayed[0].spec.imports).toContain('local');
    });

    it('renders an edge-picked direction as axis(<var>) and imports axis', async () => {
      currentCode = CODE;
      currentSynthesis = copySynthesis({
        producers: [
          { line: 4, column: 2, featureType: 'rect', nameHint: 'r', bind: true },
          { line: 6, column: 2, featureType: 'line', nameHint: 'l', bind: true },
        ],
        parts: [{ producer: 1, accessor: '', indices: null, filterArgs: null }],
        targets: [0],
        axisParts: [0],
      });
      const { status, body } = await post({
        feature: 'copy', sketchEntities: [{ shapeId: 'e1' }],
        sketchAxisEntities: [{ shapeId: 'l1' }],
        copy2d: {
          kind: 'linear', spacingMode: 'length', centered: true,
          directions: [{ axis: { kind: 'edge' }, count: 4, value: 90 }],
        },
      });
      expect(status).toBe(200);
      expect(body.preview).toBe("copy('linear', axis(l), { count: 4, length: 90, centered: true }, r)");
      expect(sketchSynthesizeCalls[0]).toMatchObject({ feature: 'copy', axisRefs: [{ shapeId: 'l1' }] });
      expect(relayed[0].spec).toMatchObject({
        copy: { directions: [{ axis: { kind: 'selector', part: 0 } }] },
        parts: [{ producer: 1, accessor: '' }],
      });
      expect(relayed[0].spec.imports).toContain('axis');
    });

    it('renders a circular copy around its [x, y] center', async () => {
      currentCode = CODE;
      currentSynthesis = copySynthesis({
        producers: [{ line: 4, column: 2, featureType: 'rect', nameHint: 'r', bind: true }],
        targets: [0],
      });
      const { status, body } = await post({
        feature: 'copy', sketchEntities: [{ shapeId: 'e1' }],
        copy2d: {
          kind: 'circular', center: [0, 'w / 2'], count: 6,
          sweep: { mode: 'angle', value: 360 }, skip: [[2]],
        },
      });
      expect(status).toBe(200);
      expect(body.preview).toBe("copy('circular', [0, w / 2], { count: 6, angle: 360, skip: [2] }, r)");
      expect(relayed[0].spec).toMatchObject({
        copy: { kind: 'circular', center: [0, 'w / 2'], count: 6, skip: [[2]] },
      });
    });

    it('rejects axis picks that do not match the edge directions', async () => {
      const { status, body } = await post({
        feature: 'copy', sketchEntities: [{ shapeId: 'e1' }],
        sketchAxisEntities: [{ shapeId: 'l1' }],
        copy2d: {
          kind: 'linear', spacingMode: 'offset',
          directions: [{ axis: { kind: 'local', axis: 'x' }, count: 3, value: 20 }],
        },
      });
      expect(status).toBe(400);
      expect(body.error).toContain('exactly one pick per edge-picked direction');
      expect(sketchSynthesizeCalls).toHaveLength(0);
    });

    it('422s a kernel that predates the copy kind (no copySlots)', async () => {
      currentCode = CODE;
      currentSynthesis = {
        ok: true,
        spec: { feature: 'copy', filePath: '/ws/m.fluid.js', producers: [], parts: [], imports: [] },
        preview: '', args: 'edge().line(20)', alternatives: [],
      };
      const { status, body } = await post({
        feature: 'copy', sketchEntities: [{ shapeId: 'e1' }],
        copy2d: {
          kind: 'linear', spacingMode: 'offset',
          directions: [{ axis: { kind: 'local', axis: 'x' }, count: 3, value: 20 }],
        },
      });
      expect(status).toBe(422);
      expect(body.reason).toContain('update its fluidcad dependency');
    });
  });

  describe('2D copy edit (sketch branch)', () => {
    const EDIT_CODE = [
      "import { sketch, rect, copy, local } from 'fluidcad/core'",
      '',
      "sketch('xy', () => {",
      '  const r = rect(20, 20)',
      "  copy('linear', local('x'), { count: 3, offset: 20 }, r)",
      '})',
      '',
    ].join('\n');
    const EDIT = { filePath: '/ws/m.fluid.js', line: 5, column: 2 };

    it('rewrites the options keeping the local axis and targets verbatim', async () => {
      currentCode = EDIT_CODE;
      currentFileName = '/ws/m.fluid.js';
      const { status, body } = await post({
        feature: 'copy', edit: EDIT, kind: 'linear', spacingMode: 'offset',
        directions: [{ count: 4, value: 25 }],
      });
      expect(status).toBe(200);
      expect(body.preview).toBe("copy('linear', local('x'), { count: 4, offset: 25 }, r)");
      expect(sketchSynthesizeCalls).toEqual([]);
      expect(relayed[0].spec).toMatchObject({
        edit: {
          copy: {
            kind: 'linear',
            directions: [{ axis: { kind: 'keep', sourceIndex: 0 }, count: 4, value: 25 }],
          },
        },
      });
    });

    it('re-sources a direction to the other local axis', async () => {
      currentCode = EDIT_CODE;
      currentFileName = '/ws/m.fluid.js';
      const { status, body } = await post({
        feature: 'copy', edit: EDIT, kind: 'linear', spacingMode: 'offset',
        directions: [{ axis: { kind: 'local', axis: 'y' }, count: 3, value: 20 }],
      });
      expect(status).toBe(200);
      expect(body.preview).toBe("copy('linear', local('y'), { count: 3, offset: 20 }, r)");
      expect(relayed[0].spec.imports).toContain('local');
    });

    it('re-picks the targets through the sketch kernel (no boundary needed)', async () => {
      currentCode = EDIT_CODE;
      currentFileName = '/ws/m.fluid.js';
      currentSynthesis = {
        ok: true,
        spec: {
          feature: 'copy', filePath: '/ws/m.fluid.js',
          producers: [{ line: 4, column: 12, featureType: 'rect', nameHint: 'r', bind: true }],
          parts: [], imports: [],
        },
        preview: '', args: 'r', alternatives: [],
        copySlots: { targets: [0], axisParts: [] },
      };
      const { status, body } = await post({
        feature: 'copy', edit: EDIT, kind: 'linear', spacingMode: 'offset',
        directions: [{ count: 3, value: 20 }],
        sketchTargets: [{ shapeId: 'e1' }],
      });
      expect(status).toBe(200);
      expect(body.preview).toBe("copy('linear', local('x'), { count: 3, offset: 20 }, r)");
      expect(sketchSynthesizeCalls[0]).toMatchObject({
        picks: [{ shapeId: 'e1' }], feature: 'copy', axisRefs: [],
      });
      expect(relayed[0].spec).toMatchObject({
        edit: { copy: { targets: [{ kind: 'feature', producer: 0 }] } },
      });
    });

    it('rewrites a circular copy center from the dialog fields', async () => {
      const circularCode = [
        "import { sketch, circle, copy } from 'fluidcad/core'",
        '',
        "sketch('xy', () => {",
        '  const c = circle([30, 0], 5)',
        "  copy('circular', [0, 0], { count: 4, angle: 360 }, c)",
        '})',
        '',
      ].join('\n');
      currentCode = circularCode;
      currentFileName = '/ws/m.fluid.js';
      const { status, body } = await post({
        feature: 'copy', edit: { filePath: '/ws/m.fluid.js', line: 5, column: 2 },
        kind: 'circular', center: [5, 10], count: 4, sweep: { mode: 'angle', value: 360 },
      });
      expect(status).toBe(200);
      expect(body.preview).toBe("copy('circular', [5, 10], { count: 4, angle: 360 }, c)");
      expect(relayed[0].spec).toMatchObject({
        edit: { copy: { kind: 'circular', center: [5, 10] } },
      });
    });

    it('rejects a center on a linear copy edit', async () => {
      const { status, body } = await post({
        feature: 'copy', edit: EDIT, kind: 'linear', spacingMode: 'offset',
        directions: [{ count: 3, value: 20 }],
        center: [0, 0],
      });
      expect(status).toBe(400);
      expect(body.error).toContain('linear copy carries');
    });
  });

  describe('boolean', () => {
    const T1 = { filePath: '/ws/m.fluid.js', line: 4, column: 0 };
    const T2 = { filePath: '/ws/m.fluid.js', line: 6, column: 0 };
    const CODE = [
      "import { sketch, rect, extrude, cut } from 'fluidcad/core'",
      '',
      "sketch('xy', () => { rect(100, 50) })",
      'extrude(30)',
      "sketch('xy', () => { rect(10, 10) })",
      'cut(5)',
      '',
    ].join('\n');

    it('rejects an unknown kind', async () => {
      const { status, body } = await post({ feature: 'boolean', kind: 'union', targets: [T1, T2] });
      expect(status).toBe(400);
      expect(body.error).toContain('kind must be');
    });

    it('rejects fewer than two targets', async () => {
      const { status, body } = await post({ feature: 'boolean', kind: 'fuse', targets: [T1] });
      expect(status).toBe(400);
      expect(body.error).toContain('targets must be 2-16');
    });

    it('rejects a subtract that does not take exactly two targets', async () => {
      const { status, body } = await post({
        feature: 'boolean', kind: 'subtract',
        targets: [T1, T2, { filePath: '/ws/m.fluid.js', line: 8, column: 0 }],
      });
      expect(status).toBe(400);
      expect(body.error).toContain('exactly a base and a tool');
    });

    it('rejects the same target picked twice', async () => {
      const { status, body } = await post({ feature: 'boolean', kind: 'fuse', targets: [T1, T1] });
      expect(status).toBe(400);
      expect(body.error).toContain('picked twice');
    });

    it('previews and relays a fuse', async () => {
      currentCode = CODE;
      const fuseBody = { feature: 'boolean', kind: 'fuse', targets: [T1, T2] };
      const preview = await post({ ...fuseBody, preview: true });
      expect(preview.status).toBe(200);
      expect(preview.body.preview).toBe('fuse(f, f2)');
      expect(relayed).toEqual([]);
      expect(synthesizeCalls).toEqual([]);

      const { status, body } = await post(fuseBody);
      expect(status).toBe(200);
      expect(body.success).toBe(true);
      expect(relayed).toHaveLength(1);
      const spec = relayed[0].spec;
      expect(relayed[0].type).toBe('apply-feature-edit');
      expect(spec.feature).toBe('boolean');
      expect(spec.boolean.kind).toBe('fuse');
      expect(spec.boolean.targets).toEqual([{ producer: 0 }, { producer: 1 }]);
      expect(spec.producers).toHaveLength(2);
      expect(spec.producers.every((p: any) => p.featureType === 'feature' && p.bind)).toBe(true);
      expect(spec.parts).toEqual([]);
      expect(spec.imports).toEqual([]);
    });

    it('previews a subtract in base-then-tool argument order', async () => {
      currentCode = CODE;
      const { status, body } = await post({
        feature: 'boolean', kind: 'subtract', targets: [T2, T1],
      });
      expect(status).toBe(200);
      expect(body.preview).toBe('subtract(f, f2)');
      const spec = relayed[0].spec;
      expect(spec.boolean.targets).toEqual([{ producer: 0 }, { producer: 1 }]);
      expect(spec.producers[0].line).toBe(6);
      expect(spec.producers[1].line).toBe(4);
    });
  });

  describe('mirror', () => {
    const T1 = { filePath: '/ws/m.fluid.js', line: 4, column: 0 };
    const T2 = { filePath: '/ws/m.fluid.js', line: 6, column: 0 };
    const CODE = [
      "import { sketch, rect, extrude, cut } from 'fluidcad/core'",
      '',
      "sketch('xy', () => { rect(100, 50) })",
      'extrude(30)',
      "sketch('xy', () => { rect(10, 10) })",
      'cut(5)',
      '',
    ].join('\n');

    it('rejects an empty target list', async () => {
      const { status, body } = await post({
        feature: 'mirror', targets: [], plane: { kind: 'standard', plane: 'yz' }, op: 'add',
      });
      expect(status).toBe(400);
      expect(body.error).toContain('targets must be');
    });

    it('rejects a duplicate target', async () => {
      const { status, body } = await post({
        feature: 'mirror', targets: [T1, T1], plane: { kind: 'standard', plane: 'yz' }, op: 'add',
      });
      expect(status).toBe(400);
      expect(body.error).toContain('picked twice');
    });

    it('rejects a missing plane and a bad op', async () => {
      const noPlane = await post({ feature: 'mirror', targets: [T1], op: 'add' });
      expect(noPlane.status).toBe(400);
      expect(noPlane.body.error).toContain('plane must be');

      const badOp = await post({
        feature: 'mirror', targets: [T1], plane: { kind: 'standard', plane: 'yz' }, op: 'cut',
      });
      expect(badOp.status).toBe(400);
      expect(badOp.body.error).toContain('op must be');
    });

    it('previews and relays a mirror across a standard plane', async () => {
      currentCode = CODE;
      const mirrorBody = {
        feature: 'mirror', targets: [T1, T2],
        plane: { kind: 'standard', plane: 'yz' }, op: 'add',
      };
      const preview = await post({ ...mirrorBody, preview: true });
      expect(preview.status).toBe(200);
      expect(preview.body.preview).toBe("mirror('yz', f, f2)");
      expect(relayed).toEqual([]);
      expect(synthesizeCalls).toEqual([]);

      const { status, body } = await post(mirrorBody);
      expect(status).toBe(200);
      expect(body.success).toBe(true);
      expect(relayed).toHaveLength(1);
      const spec = relayed[0].spec;
      expect(relayed[0].type).toBe('apply-feature-edit');
      expect(spec.feature).toBe('mirror');
      expect(spec.mirror.plane).toEqual({ kind: 'standard', plane: 'yz' });
      expect(spec.mirror.op).toBe('add');
      expect(spec.mirror.targets).toEqual([{ producer: 0 }, { producer: 1 }]);
      expect(spec.producers).toHaveLength(2);
      expect(spec.producers.every((p: any) => p.featureType === 'feature' && p.bind)).toBe(true);
      expect(spec.parts).toEqual([]);
    });

    it('previews the remove chain', async () => {
      currentCode = CODE;
      const { status, body } = await post({
        feature: 'mirror', targets: [T1],
        plane: { kind: 'standard', plane: 'xy' }, op: 'remove', preview: true,
      });
      expect(status).toBe(200);
      expect(body.preview).toBe("mirror('xy', f).remove()");
    });

    it('synthesizes a picked mirror face through the plane kind', async () => {
      currentCode = CODE;
      currentSynthesis = {
        ok: true,
        spec: {
          feature: 'plane',
          filePath: '/ws/m.fluid.js',
          producers: [{ line: 4, column: 0, featureType: 'extrude', nameHint: 'e', bind: true }],
          parts: [{ producer: 0, accessor: 'endFaces', indices: [0], filterArgs: null }],
          imports: [],
        },
        preview: '',
        args: 'e.endFaces(0)',
        alternatives: [],
      };
      const { status, body } = await post({
        feature: 'mirror', targets: [T2],
        plane: { kind: 'face', entity: PICK }, op: 'add',
      });
      expect(status).toBe(200);
      expect(synthesizeCalls).toEqual([{ feature: 'plane', value: undefined }]);
      expect(body.preview).toContain('mirror(plane(');
      expect(relayed).toHaveLength(1);
      const spec = relayed[0].spec;
      expect(spec.mirror.plane).toEqual({ kind: 'selector', part: 0 });
      expect(spec.imports).toContain('plane');
      expect(spec.parts).toHaveLength(1);
    });

    it('surfaces a synthesis refusal for the picked plane as 422', async () => {
      currentSynthesis = { ok: false, reason: 'that face cannot be named' };
      const { status, body } = await post({
        feature: 'mirror', targets: [T2],
        plane: { kind: 'face', entity: PICK }, op: 'add',
      });
      expect(status).toBe(422);
      expect(body.reason).toContain('cannot be named');
      expect(relayed).toEqual([]);
    });
  });

  describe('mirror edit', () => {
    const EDIT_CODE = [
      "import { sketch, rect, extrude, cut, mirror } from 'fluidcad/core'",
      '',
      "sketch('xy', () => { rect(100, 50) })",
      'const e = extrude(30)',
      "sketch('xy', () => { rect(10, 10) })",
      'const c = cut(5)',
      "mirror('yz', e)",
      '',
    ].join('\n');
    const EDIT = { filePath: '/ws/m.fluid.js', line: 7, column: 0 };
    const EDIT_BEFORE = { index: 6, type: 'mirror', line: 7, column: 0 };

    it('relays an op switch keeping the plane and targets, and previews it', async () => {
      currentCode = EDIT_CODE;
      currentFileName = '/ws/m.fluid.js';
      const { status, body } = await post({ feature: 'mirror', edit: EDIT, op: 'new' });
      expect(status).toBe(200);
      expect(body.preview).toBe("mirror('yz', e).new()");
      expect(synthesizeCalls).toEqual([]);
      expect(relayed[0].spec).toMatchObject({
        feature: 'mirror',
        producers: [],
        parts: [],
        edit: {
          line: 7, column: 0,
          mirror: { plane: { kind: 'keep' }, op: 'new' },
        },
        clearBreakpoints: true,
      });
      expect(relayed[0].spec.edit.mirror.targets).toBeUndefined();
    });

    it('replaces the target list, mixing kept and re-picked features', async () => {
      currentCode = EDIT_CODE;
      currentFileName = '/ws/m.fluid.js';
      const { status, body } = await post({
        feature: 'mirror', edit: EDIT, op: 'add',
        plane: { kind: 'keep' },
        targets: [
          { kind: 'verbatim', sourceIndex: 0 },
          { kind: 'feature', filePath: '/ws/m.fluid.js', line: 6, column: 0 },
        ],
      });
      expect(status).toBe(200);
      expect(body.preview).toBe("mirror('yz', e, c)");
      expect(relayed[0].spec).toMatchObject({
        producers: [{ line: 6, featureType: 'feature', bind: true }],
        edit: {
          mirror: {
            targets: [{ kind: 'verbatim', sourceIndex: 0 }, { kind: 'feature', producer: 0 }],
          },
        },
      });
    });

    it('re-sources the plane with a standard origin plane', async () => {
      currentCode = EDIT_CODE;
      currentFileName = '/ws/m.fluid.js';
      const { status, body } = await post({
        feature: 'mirror', edit: EDIT, op: 'add',
        plane: { kind: 'standard', plane: 'xz' },
      });
      expect(status).toBe(200);
      expect(body.preview).toBe("mirror('xz', e)");
      expect(relayed[0].spec.edit.mirror.plane).toEqual({ kind: 'standard', plane: 'xz' });
    });

    it('re-picks the plane face: synthesis with the boundary, selector on the edit spec', async () => {
      currentCode = EDIT_CODE;
      currentFileName = '/ws/m.fluid.js';
      currentSynthesis = {
        ok: true,
        spec: {
          feature: 'plane',
          filePath: '/ws/m.fluid.js',
          producers: [{ line: 4, column: 0, featureType: 'extrude', nameHint: 'e', bind: true }],
          parts: [{ producer: 0, accessor: 'endFaces', indices: [1], filterArgs: null }],
          imports: [],
        },
        preview: '',
        args: 'e.endFaces(1)',
        alternatives: [],
      };
      const { status, body } = await post({
        feature: 'mirror', edit: EDIT, op: 'add',
        plane: { kind: 'face', entity: PICK },
        before: EDIT_BEFORE,
      });
      expect(status).toBe(200);
      expect(body.preview).toBe("mirror(plane(e.endFaces(1)), e)");
      expect(relayed[0].spec.edit.mirror.plane).toEqual({ kind: 'selector', part: 0 });
      expect(relayed[0].spec.imports).toContain('plane');
    });

    it('requires the boundary when the plane is re-picked', async () => {
      currentCode = EDIT_CODE;
      currentFileName = '/ws/m.fluid.js';
      const { status, body } = await post({
        feature: 'mirror', edit: EDIT, op: 'add',
        plane: { kind: 'face', entity: PICK },
      });
      expect(status).toBe(400);
      expect(body.error).toContain('before is required');
    });

    it('rejects a bad op on an edit', async () => {
      const { status, body } = await post({ feature: 'mirror', edit: EDIT, op: 'cut' });
      expect(status).toBe(400);
      expect(body.error).toContain('op must be');
    });

    it('422s an edit whose statement is not a mirror', async () => {
      currentCode = EDIT_CODE;
      currentFileName = '/ws/m.fluid.js';
      const { status, body } = await post({
        feature: 'mirror',
        edit: { filePath: '/ws/m.fluid.js', line: 4, column: 0 },
        op: 'add',
      });
      expect(status).toBe(422);
      expect(body.reason).toContain('not a mirror');
      expect(relayed).toHaveLength(0);
    });
  });

  describe('rotate', () => {
    const EDGE_PICK = { shapeId: 'shape-1', sub: { type: 'edge', index: 0 } };
    const T1 = { filePath: '/ws/m.fluid.js', line: 4, column: 0 };
    const T2 = { filePath: '/ws/m.fluid.js', line: 6, column: 0 };
    const CODE = [
      "import { sketch, rect, extrude, cut } from 'fluidcad/core'",
      '',
      "sketch('xy', () => { rect(100, 50) })",
      'extrude(30)',
      "sketch('xy', () => { rect(10, 10) })",
      'cut(5)',
      '',
    ].join('\n');

    it('rejects an empty target list', async () => {
      const { status, body } = await post({
        feature: 'rotate', targets: [], axis: { kind: 'standard', axis: 'z' }, angle: 45,
      });
      expect(status).toBe(400);
      expect(body.error).toContain('targets must be');
    });

    it('rejects a duplicate target', async () => {
      const { status, body } = await post({
        feature: 'rotate', targets: [T1, T1], axis: { kind: 'standard', axis: 'z' }, angle: 45,
      });
      expect(status).toBe(400);
      expect(body.error).toContain('picked twice');
    });

    it('rejects a missing axis and a zero angle', async () => {
      const noAxis = await post({ feature: 'rotate', targets: [T1], angle: 45 });
      expect(noAxis.status).toBe(400);
      expect(noAxis.body.error).toContain('axis must be');

      const zeroAngle = await post({
        feature: 'rotate', targets: [T1], axis: { kind: 'standard', axis: 'z' }, angle: 0,
      });
      expect(zeroAngle.status).toBe(400);
      expect(zeroAngle.body.error).toContain('angle must be');
    });

    it('previews and relays a rotate around a standard axis', async () => {
      currentCode = CODE;
      const rotateBody = {
        feature: 'rotate', targets: [T1, T2],
        axis: { kind: 'standard', axis: 'z' }, angle: 45, copy: false,
      };
      const preview = await post({ ...rotateBody, preview: true });
      expect(preview.status).toBe(200);
      expect(preview.body.preview).toBe("rotate('z', 45, f, f2)");
      expect(relayed).toEqual([]);
      expect(synthesizeCalls).toEqual([]);

      const { status, body } = await post(rotateBody);
      expect(status).toBe(200);
      expect(body.success).toBe(true);
      expect(relayed).toHaveLength(1);
      const spec = relayed[0].spec;
      expect(relayed[0].type).toBe('apply-feature-edit');
      expect(spec.feature).toBe('rotate');
      expect(spec.rotate.axis).toEqual({ kind: 'standard', axis: 'z' });
      expect(spec.rotate.angle).toBe(45);
      expect(spec.rotate.copy).toBe(false);
      expect(spec.rotate.targets).toEqual([{ producer: 0 }, { producer: 1 }]);
      expect(spec.producers).toHaveLength(2);
      expect(spec.producers.every((p: any) => p.featureType === 'feature' && p.bind)).toBe(true);
      expect(spec.parts).toEqual([]);
    });

    it('previews the copy flag', async () => {
      currentCode = CODE;
      const { status, body } = await post({
        feature: 'rotate', targets: [T1],
        axis: { kind: 'standard', axis: 'x' }, angle: 30, copy: true, preview: true,
      });
      expect(status).toBe(200);
      expect(body.preview).toBe("rotate('x', 30, true, f)");
    });

    it('synthesizes a picked axis edge through the revolve kind', async () => {
      currentCode = CODE;
      currentSynthesis = {
        ok: true,
        spec: {
          feature: 'revolve',
          filePath: '/ws/m.fluid.js',
          producers: [{ line: 4, column: 0, featureType: 'extrude', nameHint: 'e', bind: true }],
          parts: [{ producer: 0, accessor: 'endEdges', indices: [0], filterArgs: null }],
          imports: [],
        },
        preview: '',
        args: 'e.endEdges(0)',
        alternatives: [],
      };
      const { status, body } = await post({
        feature: 'rotate', targets: [T2],
        axis: { kind: 'edge', entity: EDGE_PICK }, angle: 45,
      });
      expect(status).toBe(200);
      expect(synthesizeCalls).toEqual([{ feature: 'revolve', value: undefined }]);
      expect(body.preview).toContain('rotate(axis(');
      expect(relayed).toHaveLength(1);
      const spec = relayed[0].spec;
      expect(spec.rotate.axis).toEqual({ kind: 'selector', part: 0 });
      expect(spec.imports).toContain('axis');
      expect(spec.parts).toHaveLength(1);
    });

    it('surfaces a synthesis refusal for the picked axis as 422', async () => {
      currentSynthesis = { ok: false, reason: 'that edge cannot be named' };
      const { status, body } = await post({
        feature: 'rotate', targets: [T2],
        axis: { kind: 'edge', entity: EDGE_PICK }, angle: 45,
      });
      expect(status).toBe(422);
      expect(body.reason).toContain('cannot be named');
      expect(relayed).toEqual([]);
    });
  });

  describe('rotate edit', () => {
    const EDGE_PICK = { shapeId: 'shape-1', sub: { type: 'edge', index: 0 } };
    const EDIT_CODE = [
      "import { sketch, rect, extrude, cut, rotate } from 'fluidcad/core'",
      '',
      "sketch('xy', () => { rect(100, 50) })",
      'const e = extrude(30)',
      "sketch('xy', () => { rect(10, 10) })",
      'const c = cut(5)',
      "rotate('z', 45, e)",
      '',
    ].join('\n');
    const EDIT = { filePath: '/ws/m.fluid.js', line: 7, column: 0 };
    const EDIT_BEFORE = { index: 6, type: 'rotate', line: 7, column: 0 };

    it('relays an angle/copy change keeping the axis and targets, and previews it', async () => {
      currentCode = EDIT_CODE;
      currentFileName = '/ws/m.fluid.js';
      const { status, body } = await post({ feature: 'rotate', edit: EDIT, angle: 90, copy: true });
      expect(status).toBe(200);
      expect(body.preview).toBe("rotate('z', 90, true, e)");
      expect(synthesizeCalls).toEqual([]);
      expect(relayed[0].spec).toMatchObject({
        feature: 'rotate',
        producers: [],
        parts: [],
        edit: {
          line: 7, column: 0,
          rotate: { axis: { kind: 'keep' }, angle: 90, copy: true },
        },
        clearBreakpoints: true,
      });
      expect(relayed[0].spec.edit.rotate.targets).toBeUndefined();
    });

    it('replaces the target list, mixing kept and re-picked features', async () => {
      currentCode = EDIT_CODE;
      currentFileName = '/ws/m.fluid.js';
      const { status, body } = await post({
        feature: 'rotate', edit: EDIT, angle: 45,
        axis: { kind: 'keep' },
        targets: [
          { kind: 'verbatim', sourceIndex: 0 },
          { kind: 'feature', filePath: '/ws/m.fluid.js', line: 6, column: 0 },
        ],
      });
      expect(status).toBe(200);
      expect(body.preview).toBe("rotate('z', 45, e, c)");
      expect(relayed[0].spec).toMatchObject({
        producers: [{ line: 6, featureType: 'feature', bind: true }],
        edit: {
          rotate: {
            targets: [{ kind: 'verbatim', sourceIndex: 0 }, { kind: 'feature', producer: 0 }],
          },
        },
      });
    });

    it('re-sources the axis with a standard world axis', async () => {
      currentCode = EDIT_CODE;
      currentFileName = '/ws/m.fluid.js';
      const { status, body } = await post({
        feature: 'rotate', edit: EDIT, angle: 45,
        axis: { kind: 'standard', axis: 'x' },
      });
      expect(status).toBe(200);
      expect(body.preview).toBe("rotate('x', 45, e)");
      expect(relayed[0].spec.edit.rotate.axis).toEqual({ kind: 'standard', axis: 'x' });
    });

    it('re-picks the axis edge: synthesis with the boundary, selector on the edit spec', async () => {
      currentCode = EDIT_CODE;
      currentFileName = '/ws/m.fluid.js';
      currentSynthesis = {
        ok: true,
        spec: {
          feature: 'revolve',
          filePath: '/ws/m.fluid.js',
          producers: [{ line: 4, column: 0, featureType: 'extrude', nameHint: 'e', bind: true }],
          parts: [{ producer: 0, accessor: 'endEdges', indices: [1], filterArgs: null }],
          imports: [],
        },
        preview: '',
        args: 'e.endEdges(1)',
        alternatives: [],
      };
      const { status, body } = await post({
        feature: 'rotate', edit: EDIT, angle: 45,
        axis: { kind: 'edge', entity: EDGE_PICK },
        before: EDIT_BEFORE,
      });
      expect(status).toBe(200);
      expect(body.preview).toBe("rotate(axis(e.endEdges(1)), 45, e)");
      expect(relayed[0].spec.edit.rotate.axis).toEqual({ kind: 'selector', part: 0 });
      expect(relayed[0].spec.imports).toContain('axis');
    });

    it('requires the boundary when the axis is re-picked', async () => {
      currentCode = EDIT_CODE;
      currentFileName = '/ws/m.fluid.js';
      const { status, body } = await post({
        feature: 'rotate', edit: EDIT, angle: 45,
        axis: { kind: 'edge', entity: EDGE_PICK },
      });
      expect(status).toBe(400);
      expect(body.error).toContain('before is required');
    });

    it('rejects a zero angle on an edit', async () => {
      const { status, body } = await post({ feature: 'rotate', edit: EDIT, angle: 0 });
      expect(status).toBe(400);
      expect(body.error).toContain('angle must be');
    });

    it('422s an edit whose statement is not a rotate', async () => {
      currentCode = EDIT_CODE;
      currentFileName = '/ws/m.fluid.js';
      const { status, body } = await post({
        feature: 'rotate',
        edit: { filePath: '/ws/m.fluid.js', line: 4, column: 0 },
        angle: 45,
      });
      expect(status).toBe(422);
      expect(body.reason).toContain('not a rotate');
      expect(relayed).toHaveLength(0);
    });
  });

  describe('boolean edit', () => {
    const EDIT_CODE = [
      "import { sketch, rect, extrude, cut, fuse } from 'fluidcad/core'",
      '',
      "sketch('xy', () => { rect(100, 50) })",
      'const e = extrude(30)',
      "sketch('xy', () => { rect(10, 10) })",
      'const c = cut(5)',
      'fuse(e, c)',
      '',
    ].join('\n');
    const EDIT = { filePath: '/ws/m.fluid.js', line: 7, column: 0 };

    it('relays a kind switch keeping the targets and previews it', async () => {
      currentCode = EDIT_CODE;
      currentFileName = '/ws/m.fluid.js';
      const { status, body } = await post({ feature: 'boolean', edit: EDIT, kind: 'subtract' });
      expect(status).toBe(200);
      expect(body.preview).toBe('subtract(e, c)');
      expect(synthesizeCalls).toEqual([]);
      expect(relayed[0].spec).toMatchObject({
        feature: 'boolean',
        producers: [],
        parts: [],
        edit: {
          line: 7, column: 0,
          boolean: { kind: 'subtract' },
        },
        clearBreakpoints: true,
      });
      expect(relayed[0].spec.edit.boolean.targets).toBeUndefined();
    });

    it('replaces the target list, mixing kept and re-picked features', async () => {
      currentCode = EDIT_CODE;
      currentFileName = '/ws/m.fluid.js';
      const { status, body } = await post({
        feature: 'boolean', edit: EDIT, kind: 'fuse',
        targets: [
          { kind: 'verbatim', sourceIndex: 1 },
          { kind: 'feature', filePath: '/ws/m.fluid.js', line: 4, column: 0 },
        ],
      });
      expect(status).toBe(200);
      expect(body.preview).toBe('fuse(c, e)');
      expect(relayed[0].spec).toMatchObject({
        producers: [{ line: 4, featureType: 'feature', bind: true }],
        edit: {
          boolean: {
            kind: 'fuse',
            targets: [{ kind: 'verbatim', sourceIndex: 1 }, { kind: 'feature', producer: 0 }],
          },
        },
      });
    });

    it('rejects an unknown kind on an edit', async () => {
      const { status, body } = await post({ feature: 'boolean', edit: EDIT, kind: 'union' });
      expect(status).toBe(400);
      expect(body.error).toContain('kind must be');
    });

    it('rejects a subtract edit without exactly two targets', async () => {
      const { status, body } = await post({
        feature: 'boolean', edit: EDIT, kind: 'subtract',
        targets: [{ kind: 'verbatim', sourceIndex: 0 }],
      });
      expect(status).toBe(400);
      expect(body.error).toContain('exactly a base and a tool');
    });

    it('422s an edit whose statement is not a boolean', async () => {
      currentCode = EDIT_CODE;
      currentFileName = '/ws/m.fluid.js';
      const { status, body } = await post({
        feature: 'boolean',
        edit: { filePath: '/ws/m.fluid.js', line: 4, column: 0 },
        kind: 'fuse',
      });
      expect(status).toBe(422);
      expect(body.reason).toContain('not a boolean');
      expect(relayed).toHaveLength(0);
    });
  });

  describe('plane edit', () => {
    const EDIT_CODE = [
      "import { sketch, rect, extrude, plane } from 'fluidcad/core'",
      '',
      "sketch('xy', () => { rect(100, 50) })",
      'const e = extrude(30)',
      "const top = plane('xy', 20)",
      "plane('xz', 10)",
      '',
    ].join('\n');
    const EDIT = { filePath: '/ws/m.fluid.js', line: 6, column: 0 };
    const BEFORE = { index: 3, type: 'plane', line: 6, column: 0 };

    beforeEach(() => {
      currentCode = EDIT_CODE;
      currentFileName = '/ws/m.fluid.js';
    });

    it('relays a value-only edit keeping the base, and previews it', async () => {
      const { status, body } = await post({
        feature: 'plane', edit: EDIT, type: 'offset', offset: 25, rotateX: 15,
      });
      expect(status).toBe(200);
      expect(body.preview).toBe(`plane('xz', { offset: 25, rotateX: 15 })`);
      expect(synthesizeCalls).toEqual([]);
      expect(relayed[0].spec).toMatchObject({
        feature: 'plane',
        producers: [],
        parts: [],
        edit: { line: 6, column: 0, plane: { type: 'offset', offset: 25, rotateX: 15 } },
        clearBreakpoints: true,
      });
      expect(relayed[0].spec.edit.plane.bases).toBeUndefined();
    });

    it('binds a re-sourced plane base and keeps the other verbatim', async () => {
      const { status, body } = await post({
        feature: 'plane', edit: EDIT, type: 'mid',
        bases: [
          { kind: 'verbatim', sourceIndex: 0 },
          { kind: 'plane', filePath: '/ws/m.fluid.js', line: 5, column: 12 },
        ],
      });
      expect(status).toBe(200);
      expect(body.preview).toBe(`plane('xz', top)`);
      expect(synthesizeCalls).toEqual([]);
      expect(relayed[0].spec).toMatchObject({
        producers: [{ line: 5, column: 12, featureType: 'plane', nameHint: 'p', bind: true }],
        edit: {
          plane: {
            type: 'mid',
            bases: [{ kind: 'verbatim', sourceIndex: 0 }, { kind: 'plane', producer: 0 }],
          },
        },
      });
    });

    it('re-picks a base: synthesis with the boundary, the part on the spec', async () => {
      currentSynthesis = planeSynthesis('endFaces', 4);
      const { status } = await post({
        feature: 'plane', edit: EDIT, type: 'offset', offset: 10,
        bases: [planePick(0)],
        before: BEFORE,
      });
      expect(status).toBe(200);
      expect(synthesizeCalls).toEqual([{ feature: 'plane', value: undefined }]);
      expect(synthesizeBoundaries).toEqual([BEFORE]);
      expect(relayed[0].spec).toMatchObject({
        producers: [{ line: 4, featureType: 'extrude', bind: true }],
        parts: [{ producer: 0, accessor: 'endFaces' }],
        edit: { plane: { bases: [{ kind: 'selector', part: 0 }] } },
      });
    });

    it('rejects a re-picked base without a boundary', async () => {
      const { status, body } = await post({
        feature: 'plane', edit: EDIT, type: 'offset', offset: 10,
        bases: [planePick(0)],
      });
      expect(status).toBe(400);
      expect(body.error).toContain('before is required');
    });

    it('rejects a base count the form does not take', async () => {
      const { status, body } = await post({
        feature: 'plane', edit: EDIT, type: 'mid',
        bases: [{ kind: 'standard', plane: 'xy' }],
      });
      expect(status).toBe(400);
      expect(body.error).toContain('exactly two bases');
    });

    it('rejects an edge plane edit without a position', async () => {
      const { status, body } = await post({ feature: 'plane', edit: EDIT, type: 'edge' });
      expect(status).toBe(400);
      expect(body.error).toContain('position must be');
    });

    it('422s an edit whose statement is not a plane', async () => {
      const { status, body } = await post({
        feature: 'plane',
        edit: { filePath: '/ws/m.fluid.js', line: 4, column: 0 },
        type: 'offset', offset: 10,
      });
      expect(status).toBe(422);
      expect(body.reason).toContain('not a plane');
      expect(relayed).toHaveLength(0);
    });
  });

  describe('sketch-edge picks (2D branch)', () => {
    const SKETCH_SYNTHESIS = {
      ok: true,
      spec: {
        feature: 'fillet',
        value: 4,
        filePath: '/ws/m.fluid.js',
        producers: [{ line: 4, column: 0, featureType: 'rect', nameHint: 'r', bind: true }],
        parts: [{ producer: 0, accessor: 'edge', indices: null, filterArgs: "'top'" }],
        imports: [],
      },
      preview: "fillet(4, r.edge('top'))",
      args: "r.edge('top')",
      alternatives: ['r.edge(2)'],
    };

    it('rejects malformed sketch entities', async () => {
      const { status, body } = await post({ feature: 'fillet', value: 4, sketchEntities: [{}] });
      expect(status).toBe(400);
      expect(body.error).toContain('sketchEntities must be');
    });

    it('rejects non-fillet features for sketch selections', async () => {
      const { status, body } = await post({
        feature: 'chamfer', value: 4, sketchEntities: [{ shapeId: 'edge-1' }],
      });
      expect(status).toBe(400);
      expect(body.error).toContain('feature must be "fillet"');
    });

    it('rejects a non-positive value', async () => {
      const { status } = await post({
        feature: 'fillet', value: 0, sketchEntities: [{ shapeId: 'edge-1' }],
      });
      expect(status).toBe(400);
    });

    it('previews via the sketch synthesis branch', async () => {
      currentSynthesis = SKETCH_SYNTHESIS;
      const { status, body } = await post({
        feature: 'fillet', value: 4, sketchEntities: [{ shapeId: 'edge-1' }], preview: true,
      });
      expect(status).toBe(200);
      expect(body).toMatchObject({
        success: true,
        preview: "fillet(4, r.edge('top'))",
        args: "r.edge('top')",
        alternatives: ['r.edge(2)'],
      });
      expect(sketchSynthesizeCalls).toEqual([
        { picks: [{ shapeId: 'edge-1' }], feature: 'fillet', value: 4 },
      ]);
      expect(synthesizeCalls).toHaveLength(0);
      expect(relayed).toHaveLength(0);
    });

    it('relays the spec to the extension on apply', async () => {
      currentSynthesis = SKETCH_SYNTHESIS;
      const { status, body } = await post({
        feature: 'fillet', value: 4, sketchEntities: [{ shapeId: 'edge-1' }],
      });
      expect(status).toBe(200);
      expect(body.success).toBe(true);
      expect(relayed).toEqual([
        { type: 'apply-feature-edit', spec: { ...SKETCH_SYNTHESIS.spec, editId: expect.any(String) } },
      ]);
    });

    it('carries a hand-edited selector override as rawArgs', async () => {
      currentSynthesis = SKETCH_SYNTHESIS;
      const { status } = await post({
        feature: 'fillet', value: 4, sketchEntities: [{ shapeId: 'edge-1' }],
        selectorOverride: "r.edge('top'), r.edge('left')",
      });
      expect(status).toBe(200);
      expect(relayed[0].spec.rawArgs).toBe("r.edge('top'), r.edge('left')");
    });

    it('422s a synthesis refusal', async () => {
      currentSynthesis = { ok: false, reason: 'no edge filter distinguishes the picked edges' };
      const { status, body } = await post({
        feature: 'fillet', value: 4, sketchEntities: [{ shapeId: 'edge-1' }],
      });
      expect(status).toBe(422);
      expect(body.reason).toContain('no edge filter');
      expect(relayed).toHaveLength(0);
    });

    it('previews an offset through the same branch', async () => {
      currentSynthesis = {
        ...SKETCH_SYNTHESIS,
        spec: { ...SKETCH_SYNTHESIS.spec, feature: 'offset', value: 3 },
        preview: "offset(3, r.edge('top'))",
      };
      const { status, body } = await post({
        feature: 'offset', value: 3, sketchEntities: [{ shapeId: 'edge-1' }], preview: true,
      });
      expect(status).toBe(200);
      expect(body).toMatchObject({ success: true, preview: "offset(3, r.edge('top'))" });
      expect(sketchSynthesizeCalls).toEqual([
        {
          picks: [{ shapeId: 'edge-1' }],
          feature: 'offset',
          value: 3,
          // Both toggles off — the plain form the dialog opens on.
          offset: { removeOriginal: false, close: false },
        },
      ]);
    });

    it('relays a subtract with slot-addressed picks and no value', async () => {
      currentSynthesis = {
        ok: true,
        spec: {
          feature: 'subtract',
          filePath: '/ws/m.fluid.js',
          producers: [
            { line: 4, column: 0, featureType: 'rect', nameHint: 'r', bind: true },
            { line: 6, column: 0, featureType: 'circle', nameHint: 'c', bind: true },
          ],
          parts: [
            { producer: 0, accessor: '', indices: null, filterArgs: null },
            { producer: 1, accessor: '', indices: null, filterArgs: null },
          ],
          imports: [],
        },
        preview: 'subtract(r, c)',
        args: 'r, c',
        alternatives: [],
      };
      const { status, body } = await post({
        feature: 'subtract',
        sketchEntities: [{ shapeId: 'edge-1' }],
        sketchToolEntities: [{ shapeId: 'edge-9' }],
      });
      expect(status).toBe(200);
      expect(body.success).toBe(true);
      expect(sketchSynthesizeCalls).toEqual([
        { picks: [{ shapeId: 'edge-1' }], feature: 'subtract', value: undefined },
      ]);
      expect(relayed).toHaveLength(1);
    });

    it('requires the tool slot for subtract and rejects it elsewhere', async () => {
      const missing = await post({
        feature: 'subtract', sketchEntities: [{ shapeId: 'edge-1' }],
      });
      expect(missing.status).toBe(400);
      expect(missing.body.error).toContain('sketchToolEntities');

      const misplaced = await post({
        feature: 'fuse',
        sketchEntities: [{ shapeId: 'edge-1' }],
        sketchToolEntities: [{ shapeId: 'edge-9' }],
      });
      expect(misplaced.status).toBe(400);
      expect(misplaced.body.error).toContain('only applies to subtract');
    });

    it('previews a valueless trim through the same branch', async () => {
      currentSynthesis = {
        ...SKETCH_SYNTHESIS,
        spec: { ...SKETCH_SYNTHESIS.spec, feature: 'trim', value: undefined },
        preview: "trim(r.edge('top'))",
      };
      const { status, body } = await post({
        feature: 'trim', sketchEntities: [{ shapeId: 'edge-1' }], preview: true,
      });
      expect(status).toBe(200);
      expect(body).toMatchObject({ success: true, preview: "trim(r.edge('top'))" });
      expect(sketchSynthesizeCalls).toEqual([
        { picks: [{ shapeId: 'edge-1' }], feature: 'trim', value: undefined },
      ]);
    });

    it('accepts a negative offset distance but rejects zero', async () => {
      currentSynthesis = {
        ...SKETCH_SYNTHESIS,
        spec: { ...SKETCH_SYNTHESIS.spec, feature: 'offset', value: -2 },
        preview: "offset(-2, r.edge('top'))",
      };
      const negative = await post({
        feature: 'offset', value: -2, sketchEntities: [{ shapeId: 'edge-1' }], preview: true,
      });
      expect(negative.status).toBe(200);
      const zero = await post({
        feature: 'offset', value: 0, sketchEntities: [{ shapeId: 'edge-1' }],
      });
      expect(zero.status).toBe(400);
      expect(zero.body.error).toContain('nonzero');
    });

    describe('offset toggles', () => {
      const OFFSET_SYNTHESIS = {
        ...SKETCH_SYNTHESIS,
        spec: { ...SKETCH_SYNTHESIS.spec, feature: 'offset', value: 3 },
        preview: "offset(3, r.edge('top'))",
      };

      it('writes removeOriginal as the second argument', async () => {
        currentSynthesis = OFFSET_SYNTHESIS;
        const { status, body } = await post({
          feature: 'offset', value: 3, removeOriginal: true,
          sketchEntities: [{ shapeId: 'edge-1' }],
        });
        expect(status).toBe(200);
        expect(body.preview).toBe("offset(3, true, r.edge('top'))");
        expect(sketchSynthesizeCalls[0].offset).toEqual({ removeOriginal: true, close: false });
        expect(relayed[0].spec.offset).toEqual({ removeOriginal: true, close: false });
      });

      it('chains .close() and previews it', async () => {
        currentSynthesis = OFFSET_SYNTHESIS;
        const { status, body } = await post({
          feature: 'offset', value: 3, close: true,
          sketchEntities: [{ shapeId: 'edge-1' }], preview: true,
        });
        expect(status).toBe(200);
        expect(body.preview).toBe("offset(3, r.edge('top')).close()");
        expect(relayed).toHaveLength(0);
      });

      it('re-attaches the toggles over a kernel that ignores them', async () => {
        // A workspace kernel predating the option returns a spec without it;
        // the route still writes the form the dialog asked for.
        currentSynthesis = OFFSET_SYNTHESIS;
        const { status } = await post({
          feature: 'offset', value: 3, close: true, sketchEntities: [{ shapeId: 'edge-1' }],
        });
        expect(status).toBe(200);
        expect(relayed[0].spec.offset).toEqual({ removeOriginal: false, close: true });
      });

      it('rejects a closed offset that also removes the original', async () => {
        currentSynthesis = OFFSET_SYNTHESIS;
        const { status, body } = await post({
          feature: 'offset', value: 3, removeOriginal: true, close: true,
          sketchEntities: [{ shapeId: 'edge-1' }],
        });
        expect(status).toBe(400);
        expect(body.error).toContain('closed offset');
        expect(relayed).toHaveLength(0);
      });

      it('rejects the toggles on another 2D op', async () => {
        currentSynthesis = SKETCH_SYNTHESIS;
        const { status, body } = await post({
          feature: 'fillet', value: 4, close: true, sketchEntities: [{ shapeId: 'edge-1' }],
        });
        expect(status).toBe(400);
        expect(body.error).toContain('only apply to offset');
      });
    });

    describe('slot from edge', () => {
      const SLOT_SYNTHESIS = {
        ok: true,
        spec: {
          feature: 'slot',
          value: 10,
          slot: { removeOriginal: true },
          filePath: '/ws/m.fluid.js',
          producers: [{ line: 4, column: 2, featureType: 'line', nameHint: 'l', bind: true }],
          parts: [{ producer: 0, accessor: '', indices: null, filterArgs: null }],
          imports: [],
        },
        preview: 'slot(l, 10)',
        args: 'l',
        alternatives: [],
      };

      it('previews through the sketch branch with the slot options', async () => {
        currentSynthesis = SLOT_SYNTHESIS;
        const { status, body } = await post({
          feature: 'slot', value: 10, sketchEntities: [{ shapeId: 'edge-1' }], preview: true,
        });
        expect(status).toBe(200);
        expect(body).toMatchObject({ success: true, preview: 'slot(l, 10)', args: 'l' });
        expect(sketchSynthesizeCalls).toEqual([
          {
            picks: [{ shapeId: 'edge-1' }],
            feature: 'slot',
            value: 10,
            // Absent toggle reads as the kernel default: remove the source.
            slot: { removeOriginal: true },
          },
        ]);
        expect(relayed).toHaveLength(0);
      });

      it('writes the keep-original form as the trailing false', async () => {
        currentSynthesis = SLOT_SYNTHESIS;
        const { status, body } = await post({
          feature: 'slot', value: 10, removeOriginal: false,
          sketchEntities: [{ shapeId: 'edge-1' }],
        });
        expect(status).toBe(200);
        expect(body.preview).toBe('slot(l, 10, false)');
        expect(sketchSynthesizeCalls[0].slot).toEqual({ removeOriginal: false });
        expect(relayed[0].spec.slot).toEqual({ removeOriginal: false });
      });

      it('rejects a non-positive radius and the offset-only close toggle', async () => {
        const zero = await post({
          feature: 'slot', value: 0, sketchEntities: [{ shapeId: 'edge-1' }],
        });
        expect(zero.status).toBe(400);
        expect(zero.body.error).toContain('positive');

        const closed = await post({
          feature: 'slot', value: 10, close: true, sketchEntities: [{ shapeId: 'edge-1' }],
        });
        expect(closed.status).toBe(400);
        expect(closed.body.error).toContain('close only applies to offset');
      });

      it('422s a kernel whose synthesis cannot render a bare source variable', async () => {
        // An old workspace kernel without the 'slot' kind falls through its
        // accessor ladder — the route refuses instead of writing a statement
        // SlotFromEdge cannot consume.
        currentSynthesis = {
          ...SLOT_SYNTHESIS,
          preview: "slot(l.edge('top'), 10)",
          args: "l.edge('top')",
        };
        const { status, body } = await post({
          feature: 'slot', value: 10, sketchEntities: [{ shapeId: 'edge-1' }],
        });
        expect(status).toBe(422);
        expect(body.reason).toContain('does not support slot from edge');
        expect(relayed).toHaveLength(0);
      });
    });
  });
  describe('project', () => {
    const SKETCH = { filePath: '/ws/m.fluid.js', line: 9, column: 0 };
    const projectSynthesis = {
      ok: true,
      spec: {
        feature: 'project', filePath: '/ws/m.fluid.js',
        producers: [{ line: 4, column: 0, featureType: 'extrude', nameHint: 'e', bind: true }],
        parts: [{ producer: 0, accessor: 'endFaces', indices: null, filterArgs: '0' }],
        imports: [],
      },
      preview: 'project(e.endFaces(0))',
      args: 'e.endFaces(0)',
      alternatives: ['e.face(2)'],
    };

    it('synthesizes with the project kind and no value', async () => {
      currentSynthesis = projectSynthesis;
      const { status, body } = await post({
        feature: 'project', entities: [PICK], sketch: SKETCH, preview: true,
      });
      expect(status).toBe(200);
      expect(synthesizeCalls).toEqual([{ feature: 'project', value: undefined }]);
      expect(body).toMatchObject({
        success: true,
        preview: 'project(e.endFaces(0))',
        args: 'e.endFaces(0)',
        alternatives: ['e.face(2)'],
      });
      expect(relayed).toEqual([]);
    });

    it('relays a spec carrying the target sketch call site', async () => {
      currentSynthesis = projectSynthesis;
      const { status, body } = await post({ feature: 'project', entities: [PICK], sketch: SKETCH });
      expect(status).toBe(200);
      expect(body).toMatchObject({ success: true, preview: 'project(e.endFaces(0))' });
      expect(relayed).toHaveLength(1);
      expect(relayed[0].spec).toMatchObject({
        feature: 'project',
        project: { sketch: { line: 9, column: 0 } },
        parts: projectSynthesis.spec.parts,
      });
    });

    it('carries an edited argument list as rawArgs', async () => {
      currentSynthesis = projectSynthesis;
      await post({
        feature: 'project', entities: [PICK], sketch: SKETCH,
        selectorOverride: 'e.endFaces(0), e.sideFaces(1)',
      });
      expect(relayed[0].spec.rawArgs).toBe('e.endFaces(0), e.sideFaces(1)');
    });

    it('omits rawArgs when the override matches the synthesized args', async () => {
      currentSynthesis = projectSynthesis;
      await post({
        feature: 'project', entities: [PICK], sketch: SKETCH, selectorOverride: 'e.endFaces(0)',
      });
      expect(relayed[0].spec.rawArgs).toBeUndefined();
    });

    it('rejects a missing sketch target', async () => {
      const { status, body } = await post({ feature: 'project', entities: [PICK] });
      expect(status).toBe(400);
      expect(body.error).toContain('sketch must be {filePath, line, column}');
    });

    it('rejects an empty pick set', async () => {
      const { status, body } = await post({ feature: 'project', entities: [], sketch: SKETCH });
      expect(status).toBe(400);
      expect(body.error).toContain('entities must be a non-empty array');
    });

    it('surfaces a synthesis refusal as a 422', async () => {
      currentSynthesis = { ok: false, reason: 'the pick belongs to a repeated instance' };
      const { status, body } = await post({ feature: 'project', entities: [PICK], sketch: SKETCH });
      expect(status).toBe(422);
      expect(body).toMatchObject({ success: false, reason: 'the pick belongs to a repeated instance' });
      expect(relayed).toEqual([]);
    });

    it('refuses sources living in a different file than the sketch', async () => {
      currentSynthesis = projectSynthesis;
      const { status, body } = await post({
        feature: 'project', entities: [PICK],
        sketch: { filePath: '/ws/other.fluid.js', line: 9, column: 0 },
      });
      expect(status).toBe(422);
      expect(body.reason).toContain('different file than the sketch');
      expect(relayed).toEqual([]);
    });
  });

  describe('connector', () => {
    const connectorSynthesis = {
      ok: true,
      spec: {
        feature: 'connector',
        filePath: '/ws/m.fluid.js',
        connector: { name: 'mountTop', part: { line: 2, column: 0 }, anchor: { kind: 'center' } },
        producers: [{ line: 5, column: 2, featureType: 'extrude', nameHint: 'e', bind: true }],
        parts: [{ producer: 0, accessor: 'endFaces', indices: [0], filterArgs: null }],
        imports: [],
      },
      preview: `connector('mountTop', e.endFaces(0).center())`,
      args: 'e.endFaces(0).center()',
      alternatives: [],
    };

    it('forwards anchor + adjustments into synthesis options and composes the chain', async () => {
      currentSynthesis = connectorSynthesis;
      const { status, body } = await post({
        feature: 'connector', name: 'mountTop', entities: [PICK],
        anchor: { kind: 'center' }, rotate: { axis: 'x', angle: 90 }, offset: [0, 0, 5], preview: true,
      });
      expect(status).toBe(200);
      expect(body.preview).toBe(`connector('mountTop', e.endFaces(0).center()).offset(0, 0, 5).rotate('x', 90)`);
      expect(synthesizeCalls).toEqual([{ feature: 'connector', value: 'mountTop' as any }]);
      expect((synthesizeOptions[0] as any)?.connector).toEqual({
        anchor: { kind: 'center' }, rotate: { axis: 'x', angle: 90 }, offset: [0, 0, 5],
      });
    });

    it('relays the synthesized spec on apply', async () => {
      currentSynthesis = connectorSynthesis;
      const { status, body } = await post({
        feature: 'connector', name: 'mountTop', entities: [PICK], anchor: { kind: 'center' },
      });
      expect(status).toBe(200);
      expect(body.success).toBe(true);
      expect(relayed).toHaveLength(1);
      expect(relayed[0].spec.feature).toBe('connector');
      expect(relayed[0].spec.connector.anchor).toEqual({ kind: 'center' });
    });

    it('rejects a malformed anchor, rotation, or offset', async () => {
      const bad = [
        { anchor: { kind: 'middle' } },
        { anchor: { kind: 'offset', mode: 'sideways', value: 1 } },
        { rotate: { axis: 'z', angle: 'ninety' } },
        { rotate: { axis: 'w', angle: 90 } },
        { rotate: 90 },
        { offset: [1, 2] },
        { offset: [1, 2, 'three'] },
      ];
      for (const extra of bad) {
        const { status } = await post({
          feature: 'connector', name: 'mountTop', entities: [PICK], ...extra,
        });
        expect(status).toBe(400);
      }
      expect(synthesizeCalls).toEqual([]);
    });

    it('rejects a bad name', async () => {
      const { status, body } = await post({ feature: 'connector', name: 'not a name', entities: [PICK] });
      expect(status).toBe(400);
      expect(body.error).toContain('plain identifier');
    });

    // -- in-place edits (timeline double-click) ------------------------------

    const CONNECTOR_EDIT_CODE = [
      `import { extrude, part, connector } from 'fluidcad/core'`,
      ``,
      `part('plate', () => {`,
      `  const e = extrude(30)`,
      `  connector('mountTop', e.endFaces(0).center()).rotate('z', 90)`,
      `})`,
      ``,
    ].join('\n');
    const CONNECTOR_EDIT = { filePath: '/ws/m.fluid.js', line: 5, column: 2 };

    it('previews an edit that keeps the statement source and rewrites the chain', async () => {
      currentCode = CONNECTOR_EDIT_CODE;
      currentFileName = '/ws/m.fluid.js';
      const { status, body } = await post({
        feature: 'connector',
        edit: CONNECTOR_EDIT,
        name: 'mountLeft',
        rotate: { axis: 'y', angle: 180 },
        offset: [0, 0, 2],
        preview: true,
      });
      expect(status).toBe(200);
      expect(body.preview).toBe(
        `connector('mountLeft', e.endFaces(0).center()).offset(0, 0, 2).rotate('y', 180)`,
      );
      // No re-pick: synthesis never runs, so no boundary is needed.
      expect(synthesizeCalls).toEqual([]);
    });

    it('relays an edit that clears both adjustments', async () => {
      currentCode = CONNECTOR_EDIT_CODE;
      currentFileName = '/ws/m.fluid.js';
      const { status, body } = await post({
        feature: 'connector', edit: CONNECTOR_EDIT, name: 'mountTop', rotate: null, offset: null,
      });
      expect(status).toBe(200);
      expect(body.preview).toBe(`connector('mountTop', e.endFaces(0).center())`);
      expect(relayed[0].spec).toMatchObject({
        feature: 'connector',
        edit: { line: 5, column: 2, connector: { name: 'mountTop', rotate: null, offset: null } },
      });
    });

    it('synthesizes a re-picked source against the boundary, name and anchor riding along', async () => {
      currentCode = CONNECTOR_EDIT_CODE;
      currentFileName = '/ws/m.fluid.js';
      currentSynthesis = {
        ...connectorSynthesis,
        args: 'e.sideFaces(2).center()',
        spec: {
          ...connectorSynthesis.spec,
          parts: [{ producer: 0, accessor: 'sideFaces', indices: [2], filterArgs: null }],
        },
      };
      const before = { index: 2, type: 'connector', line: 5, column: 2 };
      const { status, body } = await post({
        feature: 'connector',
        edit: CONNECTOR_EDIT,
        name: 'mountTop',
        rotate: null,
        offset: null,
        entities: [PICK],
        anchor: { kind: 'center' },
        before,
      });
      expect(status).toBe(200);
      expect(body.preview).toBe(`connector('mountTop', e.sideFaces(2).center())`);
      // The name rides the value channel and the anchor the options — the same
      // contract the create path uses, so the args come back suffixed.
      expect(synthesizeCalls).toEqual([{ feature: 'connector', value: 'mountTop' as any }]);
      expect((synthesizeOptions[0] as any)?.connector).toEqual({ anchor: { kind: 'center' } });
      expect(synthesizeBoundaries[0]).toEqual(before);
    });

    it('rejects a re-picked source with no boundary', async () => {
      currentCode = CONNECTOR_EDIT_CODE;
      currentFileName = '/ws/m.fluid.js';
      const { status, body } = await post({
        feature: 'connector',
        edit: CONNECTOR_EDIT,
        name: 'mountTop',
        rotate: null,
        offset: null,
        entities: [PICK],
        anchor: { kind: 'center' },
      });
      expect(status).toBe(400);
      expect(body.error).toContain('before is required');
    });

    it('rejects an edit with a bad name, adjustment, or multi-pick source', async () => {
      currentCode = CONNECTOR_EDIT_CODE;
      currentFileName = '/ws/m.fluid.js';
      const base = { feature: 'connector', edit: CONNECTOR_EDIT, rotate: null, offset: null };
      const bad = [
        { ...base, name: 'not a name' },
        { ...base, name: 'c', rotate: { axis: 'w', angle: 90 } },
        { ...base, name: 'c', offset: [1, 2] },
        // A connector's frame derives from exactly one face or edge.
        { ...base, name: 'c', entities: [PICK, PICK], anchor: { kind: 'center' }, before: { index: 2, type: 'connector', line: 5, column: 2 } },
      ];
      for (const body of bad) {
        const { status } = await post(body);
        expect(status).toBe(400);
      }
      expect(relayed).toHaveLength(0);
    });

    it('refuses an edit whose line holds another feature', async () => {
      currentCode = CONNECTOR_EDIT_CODE;
      currentFileName = '/ws/m.fluid.js';
      const { status, body } = await post({
        feature: 'connector',
        edit: { filePath: '/ws/m.fluid.js', line: 4, column: 2 },
        name: 'mountTop',
        rotate: null,
        offset: null,
      });
      expect(status).toBe(422);
      expect(body.reason).toContain('extrude');
      expect(relayed).toHaveLength(0);
    });

    async function postAnchors(body: unknown): Promise<{ status: number; body: any }> {
      const res = await fetch(`${baseUrl}/api/selection/connector-anchors`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      return { status: res.status, body: await res.json() };
    }

    it('anchors endpoint returns the suggestion payload', async () => {
      currentAnchors = {
        ok: true, defaultName: 'c2', args: 'e.endFaces(0)',
        anchors: [{
          anchor: { kind: 'center' }, suffix: '.center()',
          frame: {
            origin: { x: 1, y: 2, z: 3 },
            xDirection: { x: 1, y: 0, z: 0 },
            yDirection: { x: 0, y: 1, z: 0 },
            normal: { x: 0, y: 0, z: 1 },
          },
        }],
      };
      const { status, body } = await postAnchors({ entity: PICK });
      expect(status).toBe(200);
      expect(body.success).toBe(true);
      expect(body.defaultName).toBe('c2');
      expect(body.args).toBe('e.endFaces(0)');
      expect(body.anchors).toHaveLength(1);
      expect(body.anchors[0].suffix).toBe('.center()');
      expect(anchorCalls).toEqual([PICK]);
    });

    it('anchors endpoint surfaces refusals as success:false', async () => {
      currentAnchors = { ok: false, reason: 'connectors attach to geometry inside a part() block — wrap the feature statements in part(...)' };
      const { status, body } = await postAnchors({ entity: PICK });
      expect(status).toBe(200);
      expect(body.success).toBe(false);
      expect(body.reason).toContain('part()');
    });

    it('anchors endpoint rejects a malformed pick', async () => {
      const { status } = await postAnchors({ entity: { shapeId: 's' } });
      expect(status).toBe(400);
      expect(anchorCalls).toEqual([]);
    });
  });
});
