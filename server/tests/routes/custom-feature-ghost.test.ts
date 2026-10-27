import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import express from 'express';
import http from 'http';
import { createFeatureGhostRouter } from '../../src/routes/feature-ghost/index.ts';
import type { FeatureCatalogEntry } from '../../src/feature-catalog/catalog.ts';
import type { ScannedFeature } from '../../src/feature-catalog/scan.ts';

// The custom feature arm of POST /feature-ghost: the dialog names the
// feature by its catalog id, sends its typed-in values (resolved where the
// statement sits, like every ghost's) and one ref per picked element. The
// route checks both against the feature's metadata and hands the server the
// module and export to load the builder from. The kernel is faked here; the
// geometry is lib's ghost tests' and the end-to-end test's.

const FILE = '/ws/model.part.js';
const MODULE = '/ws/standoff.feature.js';

const STANDOFF_META = {
  id: 'acme.standoff', label: 'Standoff', group: 'create', kind: 'tool', operations: ['add', 'new'], defaultOperation: 'add',
  params: {
    face: { picker: 'face', label: 'On face', surface: 'planar' },
    height: { type: 'length', default: 10, min: 0, label: 'Height' },
    outer: { type: 'length', default: 6, min: 0, label: 'Boss diameter' },
    hole: { type: 'length', default: 3, min: 0, label: 'Hole diameter' },
  },
  call: ['face', { height: 'height', outer: 'outer', hole: 'hole' }],
  ghost: true, contexts: ['part'],
} as unknown as ScannedFeature['meta'];

const BOLT_CIRCLE_META = {
  id: 'acme.boltCircle', label: 'Bolt circle', group: 'create', kind: 'tool', operations: ['remove'], defaultOperation: 'remove',
  params: {
    around: { picker: 'axis', label: 'Around' },
    count: { type: 'integer', default: 4, min: 1, label: 'Holes' },
    size: { type: 'select', options: [{ label: 'M3', value: 'm3' }, { label: 'M4', value: 'm4' }], default: 'm3', label: 'Screw' },
    through: { type: 'boolean', default: true, label: 'Through all' },
    targets: { picker: 'solid', multiple: true, optional: true, label: 'Targets' },
    profile: { picker: 'sketch', optional: true, label: 'Profile' },
    anchor: { picker: 'point', optional: true, label: 'Anchor' },
  },
  call: ['around', { count: 'count', size: 'size', through: 'through', targets: 'targets', profile: 'profile', anchor: 'anchor' }],
  ghost: true, contexts: ['part'],
} as unknown as ScannedFeature['meta'];

/** A value of a type the server holds no entry for: the SDK refuses one, a newer engine's snapshot may carry it. */
const SWATCH_META = {
  id: 'acme.swatch', label: 'Swatch', group: 'create', kind: 'tool', operations: [],
  params: { tint: { type: 'colour', default: '#fff', label: 'Tint' } },
  call: [{ tint: 'tint' }],
  ghost: true, contexts: ['part'],
} as unknown as ScannedFeature['meta'];

/** Choices: a select and two radios, shown as a grid and cards with images, groups and keywords. */
const CLIP_META = {
  id: 'acme.clip', label: 'Clip', group: 'create', kind: 'tool', operations: [],
  params: {
    size: { type: 'select', label: 'Screw', default: 'm3', display: 'grid', columns: 3, search: true, options: [{ label: 'M3', value: 'm3', image: './clip/m3.svg', description: '3.4 mm', group: 'Metric', keywords: ['iso'] }, { label: 'M4', value: 'm4', image: './clip/m4.svg', group: 'Metric' }] },
    head: { type: 'radio', label: 'Head', default: 'plain', display: 'cards', columns: 2, options: [{ label: 'Plain', value: 'plain', image: './clip/plain.svg' }, { label: 'Counterbore', value: 'counterbore', description: 'A flat recess' }] },
    turns: { type: 'radio', label: 'Turns', optional: true, options: [{ label: 'One', value: 1 }, { label: 'Two', value: 2 }] },
  },
  call: [{ size: 'size', head: 'head', turns: 'turns' }],
  ghost: true, contexts: ['part'],
} as unknown as ScannedFeature['meta'];

/** The same choices with nothing but labels and values. */
const BARE_CLIP_META = {
  id: 'acme.clip', label: 'Clip', group: 'create', kind: 'tool', operations: [],
  params: {
    size: { type: 'select', label: 'Screw', default: 'm3', options: [{ label: 'M3', value: 'm3' }, { label: 'M4', value: 'm4' }] },
    head: { type: 'radio', label: 'Head', default: 'plain', options: [{ label: 'Plain', value: 'plain' }, { label: 'Counterbore', value: 'counterbore' }] },
    turns: { type: 'radio', label: 'Turns', optional: true, options: [{ label: 'One', value: 1 }, { label: 'Two', value: 2 }] },
  },
  call: [{ size: 'size', head: 'head', turns: 'turns' }],
  ghost: true, contexts: ['part'],
} as unknown as ScannedFeature['meta'];

const QUIET_META = { ...STANDOFF_META, id: 'acme.quiet', label: 'Quiet', ghost: false } as unknown as ScannedFeature['meta'];

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

function entry(meta: ScannedFeature['meta'], exportName: string, modulePath: string): FeatureCatalogEntry {
  return { id: meta.id, exportName, modulePath, builtIn: false, meta };
}

let entries: FeatureCatalogEntry[] | null;
let received: any;
let answer: any;
let code: string;
let definitions: unknown[];
let instances: unknown[];

const fakeServer = {
  getCurrentCode: () => code,
  getCurrentFileName: () => FILE,
  getParamDefinitions: () => definitions,
  getRenderedInstances: () => instances,
  getRenderedParts: () => [] as unknown[],
  featureGhost: async (request: unknown) => {
    received = request;
    return answer;
  },
};

const FACE = { kind: 'entities', entities: [{ shapeId: 'shape-1', index: 4, kind: 'face' }] };

let server: http.Server;
let baseUrl: string;

async function post(body: unknown): Promise<{ status: number; body: any }> {
  const res = await fetch(`${baseUrl}/api/feature-ghost`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

function listen(app: express.Express): Promise<{ server: http.Server; baseUrl: string }> {
  const created = http.createServer(app);
  return new Promise((resolve) => {
    created.listen(0, '127.0.0.1', () => {
      const addr = created.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      resolve({ server: created, baseUrl: `http://127.0.0.1:${port}` });
    });
  });
}

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api', createFeatureGhostRouter(fakeServer as never, { catalog: { list: async () => entries } }));
  ({ server, baseUrl } = await listen(app));
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  entries = [
    entry(STANDOFF_META, 'standoff', MODULE),
    entry(BOLT_CIRCLE_META, 'boltCircle', '/ws/parts/bolt-circle.feature.js'),
    entry(QUIET_META, 'quiet', '/ws/quiet.feature.js'),
    entry(BOSS_META, 'boss', '/ws/boss.feature.js'),
  ];
  received = undefined;
  answer = { status: 200, solids: [{ meshes: [] }] };
  code = '';
  definitions = [];
  instances = [];
});

describe('feature-ghost route — custom features', () => {
  it('finds each of two packages\' same-named features by its key (HD29)', async () => {
    const keyed = (pkg: string) => ({ ...STANDOFF_META, id: `${pkg}:standoff` }) as unknown as ScannedFeature['meta'];
    entries = [
      { ...entry(keyed('@acme/kit'), 'standoff', '/library/@acme/kit/0.1.0/features/standoff.feature.js'), package: { name: '@acme/kit', version: '0.1.0', availability: 'dependency' } },
      { ...entry(keyed('@bea-tools/kit'), 'standoff', '/library/@bea-tools/kit/0.1.0/features/standoff.feature.js'), package: { name: '@bea-tools/kit', version: '0.1.0', availability: 'dependency' } },
    ];
    for (const pkg of ['@acme/kit', '@bea-tools/kit']) {
      const { status } = await post({ feature: 'custom', id: `${pkg}:standoff`, values: { height: 5 }, refs: { face: [FACE] } });
      expect(status).toBe(200);
      expect(received).toMatchObject({ feature: 'custom', modulePath: `/library/${pkg}/0.1.0/features/standoff.feature.js`, exportName: 'standoff' });
    }
  });

  it('hands the server the module and export to load, the values resolved and the picks as refs', async () => {
    code = [
      `import { part, param } from 'fluidcad/core';`,
      `export const plate = part('Plate', () => {`,
      `  const tall = param('tall', 12);`,
      `});`,
    ].join('\n');
    const { status, body } = await post({
      feature: 'custom', id: 'acme.standoff', operation: 'new',
      values: { height: 'tall + 2', hole: 2.5, outer: null },
      refs: { face: [FACE] },
      valueScope: { kind: 'append', filePath: FILE, line: 2, column: 22 },
    });

    expect(status).toBe(200);
    expect(body).toEqual({ success: true, solids: [{ meshes: [] }] });
    expect(received).toEqual({
      feature: 'custom',
      modulePath: MODULE,
      exportName: 'standoff',
      values: { height: 14, hole: 2.5 },
      refs: { face: [FACE] },
      operation: 'new',
    });
  });

  it('passes on the values the feature\'s derive() fixed, when the kernel reports any', async () => {
    answer = { status: 200, solids: [{ meshes: [] }], derived: { size: 'M6', head: 'flat' } };
    const { status, body } = await post({ feature: 'custom', id: 'acme.standoff', values: { height: 5 }, refs: { face: [FACE] } });
    expect(status).toBe(200);
    expect(body).toEqual({ success: true, solids: [{ meshes: [] }], derived: { size: 'M6', head: 'flat' } });
  });

  it('carries literals as they are, statements by call site, world axes, and an edit\'s statement', async () => {
    await post({
      feature: 'custom', id: 'acme.boltCircle',
      values: { count: 6, size: 'm4', through: false },
      refs: {
        around: [{ kind: 'standard', name: 'z' }],
        targets: [{ kind: 'statement', filePath: FILE, line: 3 }, { kind: 'statement', filePath: FILE, line: 5 }],
        profile: [{ kind: 'statement', filePath: FILE, line: 2 }],
      },
      exclude: { filePath: FILE, line: 9 },
    });

    expect(received).toEqual({
      feature: 'custom',
      modulePath: '/ws/parts/bolt-circle.feature.js',
      exportName: 'boltCircle',
      values: { count: 6, size: 'm4', through: false },
      refs: {
        around: [{ kind: 'standard', name: 'z' }],
        targets: [{ kind: 'statement', filePath: FILE, line: 3 }, { kind: 'statement', filePath: FILE, line: 5 }],
        profile: [{ kind: 'statement', filePath: FILE, line: 2 }],
      },
      operation: null,
      exclude: { filePath: FILE, line: 9 },
    });
  });

  it('answers a pause as such, and passes refusals through quietly', async () => {
    answer = { status: 200, reason: 'It took 6.3 s to build, over the 5 s a preview may take.', paused: true };
    const paused = await post({ feature: 'custom', id: 'acme.standoff', refs: { face: [FACE] } });
    expect(paused).toEqual({
      status: 200,
      body: { success: false, paused: true, reason: 'It took 6.3 s to build, over the 5 s a preview may take.' },
    });

    answer = { status: 422, reason: 'On face: that pick is not in the rendered scene.' };
    const refused = await post({ feature: 'custom', id: 'acme.standoff', refs: { face: [FACE] } });
    expect(refused).toEqual({ status: 422, body: { success: false, reason: 'On face: that pick is not in the rendered scene.' } });
  });

  it('draws nothing for an expression it cannot resolve', async () => {
    const { status, body } = await post({ feature: 'custom', id: 'acme.standoff', values: { height: 'nowhere * 2' }, refs: { face: [FACE] } });
    expect(status).toBe(200);
    expect(body).toEqual({ success: false, reason: 'That value is not a number the preview can resolve.' });
    expect(received).toBeUndefined();
  });

  it('refuses a feature it cannot offer', async () => {
    expect(await post({ feature: 'custom', id: 'acme.gone' })).toMatchObject({
      status: 422, body: { success: false, reason: "no feature 'acme.gone' in this workspace — is its module still there?" },
    });
    expect(await post({ feature: 'custom', id: 'acme.quiet' })).toMatchObject({
      status: 422, body: { success: false, reason: 'Quiet draws no preview.' },
    });
    expect(await post({ feature: 'custom' })).toMatchObject({ status: 400, body: { reason: "id must be the feature's id" } });

    entries = [{ ...entry(STANDOFF_META, 'standoff', MODULE), error: "the feature id 'acme.standoff' is used by more than one builder" }];
    expect(await post({ feature: 'custom', id: 'acme.standoff' })).toMatchObject({
      status: 422, body: { reason: "the feature id 'acme.standoff' is used by more than one builder" },
    });

    entries = null;
    expect(await post({ feature: 'custom', id: 'acme.standoff' })).toMatchObject({ status: 503 });
    expect(received).toBeUndefined();
  });

  it('passes locations through: a connector and its copy, a picked vertex, an anchor, an edit\'s own elements', async () => {
    const at = [
      { kind: 'connector', filePath: FILE, line: 7 },
      { kind: 'connector', filePath: FILE, line: 7, slot: 2 },
      { kind: 'point', shapeId: 'shape-1', index: 3 },
      { kind: 'anchor', entity: { shapeId: 'shape-1', index: 4, kind: 'face' }, anchor: { kind: 'center' } },
      { kind: 'kept', index: 1 },
    ];
    const { status } = await post({ feature: 'custom', id: 'acme.boss', operation: 'new', refs: { at }, exclude: { filePath: FILE, line: 9 } });
    expect(status).toBe(200);
    expect(received).toMatchObject({
      feature: 'custom', modulePath: '/ws/boss.feature.js', exportName: 'boss', refs: { at }, exclude: { filePath: FILE, line: 9 },
    });

    const refusals: [unknown[], string][] = [
      [[{ kind: 'statement', filePath: FILE, line: 7 }], 'At: not something a connector or a point or an anchor takes'],
      [[{ kind: 'connector', filePath: FILE, line: 7, slot: -1 }], 'At: not something a connector or a point or an anchor takes'],
      [[{ kind: 'anchor', entity: { shapeId: 'shape-1', index: 4, kind: 'face' }, anchor: { kind: 'middle' } }], 'At: not something'],
      [[{ kind: 'point', shapeId: 'shape-1' }], 'At: not something'],
      [[FACE], 'At: not something'],
    ];
    for (const [refs, reason] of refusals) {
      received = undefined;
      const answered = await post({ feature: 'custom', id: 'acme.boss', refs: { at: refs } });
      expect({ refs, answered }).toEqual({ refs, answered: { status: 400, body: { success: false, reason: expect.stringContaining(reason) } } });
      expect(received).toBeUndefined();
    }
  });

  it('refuses values and picks that do not fit the feature', async () => {
    const refusals: [unknown, string][] = [
      [{ id: 'acme.standoff', values: { width: 3 } }, "Standoff has no value 'width'"],
      [{ id: 'acme.standoff', values: { face: 3 } }, 'On face is picked — send it under refs'],
      [{ id: 'acme.standoff', refs: { height: [] } }, 'Height is typed in — send it under values'],
      [{ id: 'acme.standoff', values: { height: true } }, 'Height must be a number or an expression'],
      [{ id: 'acme.boltCircle', values: { through: 'yes' } }, 'Through all must be true or false'],
      [{ id: 'acme.boltCircle', values: { size: false } }, 'Screw must be one of its options'],
      [{ id: 'acme.standoff', refs: { face: [FACE, FACE] } }, 'On face takes one pick'],
      [{ id: 'acme.standoff', refs: { face: [{ kind: 'standard', name: 'xy' }] } }, 'On face: not something a face takes'],
      [{ id: 'acme.standoff', refs: { face: [{ kind: 'entities', entities: [] }] } }, 'On face: not something a face takes'],
      [{ id: 'acme.boltCircle', refs: { around: [{ kind: 'standard', name: 'xy' }] } }, 'Around: not something an axis takes'],
      [{ id: 'acme.boltCircle', refs: { profile: [FACE] } }, 'Profile: not something a sketch takes'],
      [{ id: 'acme.boltCircle', refs: { anchor: [{ kind: 'anchor', entity: { shapeId: 's1', index: 0, kind: 'face' }, anchor: { kind: 'center' } }] } }, 'Anchor: not something a point takes'],
      [{ id: 'acme.boltCircle', refs: { targets: 'all' } }, 'Targets: refs must be a list of picks'],
      [{ id: 'acme.boltCircle', operation: 'add' }, 'Bolt circle offers no operation "add"'],
      [{ id: 'acme.standoff', exclude: { line: 3 } }, 'Invalid exclude reference'],
      [{ id: 'acme.standoff', values: [] }, 'values must be an object of values by name'],
      [{ id: 'acme.standoff', valueScope: 'line 3' }, 'Invalid value scope'],
    ];
    for (const [body, reason] of refusals) {
      const answered = await post({ feature: 'custom', ...(body as object) });
      expect({ request: body, answered }).toEqual({ request: body, answered: { status: 400, body: { success: false, reason } } });
    }
    expect(received).toBeUndefined();
  });

  it('refuses a value of a type the table does not hold by name, never resolving it as a number', async () => {
    entries!.push(entry(SWATCH_META, 'swatch', '/ws/swatch.feature.js'));
    for (const tint of ['#f00', 12]) {
      const answered = await post({ feature: 'custom', id: 'acme.swatch', values: { tint } });
      expect(answered).toEqual({ status: 400, body: { success: false, reason: `Tint is of the type 'colour', which this version of FluidCAD does not know` } });
    }
    expect(received).toBeUndefined();
  });

  it('carries a radio as a literal, like a select, and checks only that it could be an option', async () => {
    entries!.push(entry(CLIP_META, 'clip', '/ws/clip.feature.js'));
    await post({ feature: 'custom', id: 'acme.clip', values: { size: 'm4', head: 'counterbore', turns: 2 } });
    expect(received).toMatchObject({ feature: 'custom', exportName: 'clip', values: { size: 'm4', head: 'counterbore', turns: 2 } });

    received = undefined;
    const answered = await post({ feature: 'custom', id: 'acme.clip', values: { head: true } });
    expect(answered).toEqual({ status: 400, body: { success: false, reason: 'Head must be one of its options' } });
    expect(received).toBeUndefined();
  });

  it('carries a select of several as its list, and refuses a value that is no list', async () => {
    const meta = {
      id: 'acme.finish', label: 'Finish', group: 'create', kind: 'tool', operations: [],
      params: { steps: { type: 'select', multiple: true, label: 'Steps', default: [], options: [{ label: 'Deburr', value: 'deburr' }, { label: 'Polish', value: 'polish' }] } },
      call: [{ steps: 'steps' }], ghost: true, contexts: ['part'],
    } as unknown as ScannedFeature['meta'];
    entries!.push(entry(meta, 'finish', '/ws/finish.feature.js'));
    await post({ feature: 'custom', id: 'acme.finish', values: { steps: ['polish'] } });
    expect(received).toMatchObject({ feature: 'custom', exportName: 'finish', values: { steps: ['polish'] } });
    await post({ feature: 'custom', id: 'acme.finish', values: { steps: [] } });
    expect(received).toMatchObject({ values: { steps: [] } });

    received = undefined;
    const answered = await post({ feature: 'custom', id: 'acme.finish', values: { steps: 'polish' } });
    expect(answered).toEqual({ status: 400, body: { success: false, reason: 'Steps must be a list of its options' } });
    expect(received).toBeUndefined();
  });

  // A choice bound to a variable — `{ ref: 'holeSize' }` — previews as the
  // literal the variable holds where the statement sits, resolved by the
  // same scope the number rows use; a name with no value there draws nothing.
  describe('a choice bound to a variable', () => {
    const FINISH_META = {
      id: 'acme.finish', label: 'Finish', group: 'create', kind: 'tool', operations: [],
      params: { steps: { type: 'select', multiple: true, label: 'Steps', default: [], options: [{ label: 'Deburr', value: 'deburr' }, { label: 'Polish', value: 'polish' }] } },
      call: [{ steps: 'steps' }], ghost: true, contexts: ['part'],
    } as unknown as ScannedFeature['meta'];

    const PART = [
      `import { part, param } from 'fluidcad/core';`,
      `export const plate = part('Plate', () => {`,
      `  const holeSize = 'm4';`,
      `  const screw = param('Screw', 'm3', 'select', { options: [{ label: 'M3', value: 'm3' }, { label: 'M4', value: 'm4' }] });`,
      `  const turns = 2;`,
      `  const steps = ['polish'];`,
      `  const count = param('Count', 4);`,
      `  const flat = true;`,
      `  const one = 'polish';`,
      `});`,
    ].join('\n');
    const scope = { kind: 'append', filePath: FILE, line: 2, column: 22 };

    beforeEach(() => {
      code = PART;
      entries!.push(entry(CLIP_META, 'clip', '/ws/clip.feature.js'), entry(FINISH_META, 'finish', '/ws/finish.feature.js'));
    });

    it('resolves a string const, a param() default, a number and a list to the literals the engine takes', async () => {
      await post({ feature: 'custom', id: 'acme.clip', values: { size: { ref: 'holeSize' }, head: 'plain', turns: { ref: 'turns' } }, valueScope: scope });
      expect(received).toMatchObject({ exportName: 'clip', values: { size: 'm4', head: 'plain', turns: 2 } });

      await post({ feature: 'custom', id: 'acme.clip', values: { size: { ref: 'screw' } }, valueScope: scope });
      expect(received).toMatchObject({ values: { size: 'm3' } });

      await post({ feature: 'custom', id: 'acme.finish', values: { steps: { ref: 'steps' } }, valueScope: scope });
      expect(received).toMatchObject({ exportName: 'finish', values: { steps: ['polish'] } });
    });

    it("prefers the registry's current value of a param() over its default", async () => {
      definitions = [{ label: 'Screw', currentValue: 'm4', sourceLocation: { filePath: FILE, line: 4 } }];
      await post({ feature: 'custom', id: 'acme.clip', values: { size: { ref: 'screw' } }, valueScope: scope });
      expect(received).toMatchObject({ values: { size: 'm4' } });
    });

    it('resolves a rendered instance property through its binding', async () => {
      code = [
        `import { part, insert } from 'fluidcad/core';`,
        `export const plate = part('Plate', () => {`,
        `  const inst = insert(Bolt);`,
        `});`,
      ].join('\n');
      instances = [{ sourceLocation: { filePath: FILE, line: 3, column: 15 }, properties: { kind: 'm4', turns: 2 } }];
      await post({ feature: 'custom', id: 'acme.clip', values: { size: { ref: 'inst.properties.kind' }, turns: { ref: 'inst.properties.turns' } }, valueScope: scope });
      expect(received).toMatchObject({ values: { size: 'm4', turns: 2 } });
    });

    it('draws nothing for a name with no value here, saying so by the label and the name', async () => {
      const unknown = await post({ feature: 'custom', id: 'acme.clip', values: { size: { ref: 'nowhere' } }, valueScope: scope });
      expect(unknown).toEqual({ status: 200, body: { success: false, reason: 'Screw names nowhere, which has no value here' } });
      // A boolean is no option's value; a name out of scope (the top level sees no part body) has none either.
      const flag = await post({ feature: 'custom', id: 'acme.clip', values: { size: { ref: 'flat' } }, valueScope: scope });
      expect(flag.body).toEqual({ success: false, reason: 'Screw names flat, which has no value here' });
      const outside = await post({ feature: 'custom', id: 'acme.clip', values: { size: { ref: 'holeSize' } } });
      expect(outside.body).toEqual({ success: false, reason: 'Screw names holeSize, which has no value here' });
      expect(received).toBeUndefined();
    });

    it('refuses a malformed reference, and a literal of the wrong shape for the kind', async () => {
      const malformed = await post({ feature: 'custom', id: 'acme.clip', values: { size: { ref: 'hole size' } }, valueScope: scope });
      expect(malformed).toEqual({ status: 400, body: { success: false, reason: 'Screw must name a variable' } });
      // A list where one option is wanted, a string where a list is.
      const listed = await post({ feature: 'custom', id: 'acme.clip', values: { size: { ref: 'steps' } }, valueScope: scope });
      expect(listed.body).toEqual({ success: false, reason: 'Screw must be one of its options' });
      const single = await post({ feature: 'custom', id: 'acme.finish', values: { steps: { ref: 'one' } }, valueScope: scope });
      expect(single.body).toEqual({ success: false, reason: 'Steps must be a list of its options' });
      expect(received).toBeUndefined();
    });

    it('leaves the number rows as they were: a reference shape is no number', async () => {
      const refused = await post({ feature: 'custom', id: 'acme.standoff', values: { height: { ref: 'count' } }, refs: { face: [FACE] }, valueScope: scope });
      expect(refused).toEqual({ status: 400, body: { success: false, reason: 'Height must be a number or an expression' } });
      await post({ feature: 'custom', id: 'acme.standoff', values: { height: 'count * 2' }, refs: { face: [FACE] }, valueScope: scope });
      expect(received).toMatchObject({ values: { height: 8 } });
    });
  });

  it('refuses custom features when the router has no catalog', async () => {
    const app = express();
    app.use(express.json());
    app.use('/api', createFeatureGhostRouter(fakeServer as never));
    const bare = await listen(app);
    try {
      const res = await fetch(`${bare.baseUrl}/api/feature-ghost`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ feature: 'custom', id: 'acme.standoff' }),
      });
      expect(res.status).toBe(422);
      expect(await res.json()).toEqual({ success: false, reason: 'this server has no feature catalog to look custom features up in' });
    } finally {
      await new Promise<void>((resolve) => bare.server.close(() => resolve()));
    }
  });
});
