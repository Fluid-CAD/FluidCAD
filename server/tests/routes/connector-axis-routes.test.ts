import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import http from 'http';
import { createApplyFeatureRouter } from '../../src/routes/apply-feature/index.ts';
import { FeatureCatalog, type FeatureCatalogEntry } from '../../src/feature-catalog/catalog.ts';
import type { ScannedFeature } from '../../src/feature-catalog/scan.ts';

// Every axis slot takes a connector — its Z axis through its origin — sent as
// its `connector()` statement's call site, plus the slot of one of its copies.
// Revolve, helix, repeat, rotate and a custom feature's axis value each bind
// it under the connector's own name and write `bolt` or `bolt.instance(n)`,
// create and edit alike; a statement written that way reads back with its
// axis kept as written. The scene is faked: none of these picks synthesize.

const MODEL = '/ws/flange.part.js';

/** `spindle(around, { height })`: a pin along the picked axis. */
const SPINDLE_META = {
  id: 'acme.spindle', label: 'Spindle', group: 'create', kind: 'tool', operations: ['add', 'new'], defaultOperation: 'add',
  params: {
    around: { picker: 'axis', label: 'Around' },
    height: { type: 'length', default: 8, min: 0, label: 'Height' },
    profile: { picker: 'sketch', optional: true, label: 'Profile' },
  },
  call: ['around', { height: 'height', profile: 'profile' }],
  ghost: true, contexts: ['part'],
} as unknown as ScannedFeature['meta'];

const MODULES: Record<string, ScannedFeature[]> = {
  '/ws/spindle.feature.js': [{ exportName: 'spindle', meta: SPINDLE_META }],
};

const ENTRIES: FeatureCatalogEntry[] = [
  { id: 'acme.spindle', exportName: 'spindle', modulePath: '/ws/spindle.feature.js', builtIn: false, meta: SPINDLE_META },
];

function callees(): FeatureCatalog {
  return new FeatureCatalog({
    workspacePath: '/ws',
    scan: async (absPath) => MODULES[absPath]
      ? { file: absPath, features: MODULES[absPath], deps: [] }
      : { file: absPath, features: [], error: `cannot load ${absPath}`, deps: [] },
    builtIns: async () => ({}),
  });
}

const FLANGE_LINES = [
  `import { part, sketch, rect, extrude, connector, select, copy } from 'fluidcad/core'`,
  `import { face } from 'fluidcad/filters'`,
  ``,
  `export const flange = part('Flange', () => {`,
  `  const s = sketch('xz', () => { rect(10, 10) })`,
  `  sketch('xy', () => { rect(100, 100) })`,
  `  const plate = extrude(10)`,
  `  const bolt = connector('bolt', select(face().planar().onPlane('xy', 10))).offset(30, 0, 0)`,
  `  copy('linear', 'y', { count: 2, offset: 20 }, bolt)`,
  `  connector('pivot', plate.endFaces())`,
  `})`,
  ``,
];
const FLANGE = FLANGE_LINES.join('\n');

/** The model with `statements` at the end of the part body. */
function withStatements(...statements: string[]): string {
  return FLANGE.replace(/\}\)\n$/, `${statements.map(s => `  ${s}\n`).join('')}})\n`);
}

/** A statement's call site in FLANGE: its line and the column its call starts at. */
function at(line: number, callee: string): { filePath: string; line: number; column: number } {
  return { filePath: MODEL, line, column: FLANGE_LINES[line - 1].indexOf(`${callee}(`) };
}

const PROFILE = at(5, 'sketch');
const PLATE = at(7, 'extrude');
const BOLT = { kind: 'connector', ...at(8, 'connector') };
const PIVOT = { kind: 'connector', ...at(10, 'connector') };

let currentCode: string;
let relayed: any[];
let server: http.Server | null = null;

const fakeServer = {
  getCurrentCode: () => currentCode,
  getCurrentFileName: () => MODEL,
  getParamDefinitions: () => [],
  synthesizeFeatureSlots: () => null,
};

async function serve(): Promise<string> {
  const app = express();
  app.use(express.json());
  app.use('/api', createApplyFeatureRouter(fakeServer as any, (msg: any) => {
    relayed.push(msg);
  }, { callees: callees(), catalog: { list: async () => ENTRIES } }));
  server = http.createServer(app);
  await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address() as { port: number };
  return `http://127.0.0.1:${address.port}/api`;
}

async function post(url: string, body: unknown): Promise<{ status: number; body: any }> {
  const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { status: res.status, body: await res.json() };
}

/** Apply the last relayed spec to `code` through the transform endpoint; answers the new code. */
async function written(base: string, code: string): Promise<string> {
  const result = await post(`${base}/code/apply-feature`, { code, spec: relayed[relayed.length - 1].spec });
  expect(result.body.error).toBeUndefined();
  return result.body.newCode;
}

beforeEach(() => {
  currentCode = FLANGE;
  relayed = [];
});

afterEach(async () => {
  if (server) {
    await new Promise<void>(resolve => server!.close(() => resolve()));
    server = null;
  }
});

describe('a connector in a built-in axis slot', () => {
  const revolveBody = (axis: unknown) => ({
    feature: 'revolve', op: 'new', angle: 360, symmetric: false, thin: null,
    profile: { mode: 'bound', ...PROFILE }, axis, scope: [], regions: [],
  });

  it('revolves around a connector, and around one of its copies, bound under its own name', async () => {
    const base = await serve();
    let result = await post(`${base}/apply-feature`, { ...revolveBody(BOLT), preview: true });
    expect(result.status).toBe(200);
    expect(result.body.preview).toBe('revolve(bolt, s).new()');

    result = await post(`${base}/apply-feature`, revolveBody({ ...PIVOT, slot: undefined }));
    expect(result.status).toBe(200);
    expect(result.body.preview).toBe('revolve(pivot, s).new()');
    expect(relayed[0].spec.producers).toMatchObject([
      { line: 5, featureType: 'sketch', bind: true },
      { line: 10, featureType: 'connector', nameHint: 'c', bind: true },
    ]);
    expect(relayed[0].spec.revolve.axis).toEqual({ kind: 'connector', producer: 1 });
    // The pivot is bound under its own name; the revolve lands in its part.
    expect(await written(base, FLANGE)).toBe(withStatements(`revolve(pivot, s).new()`)
      .replace(`  connector('pivot'`, `  const pivot = connector('pivot'`)
      .replace(`import { part,`, `import { revolve, part,`));

    result = await post(`${base}/apply-feature`, revolveBody({ ...BOLT, slot: 1 }));
    expect(result.body.preview).toBe('revolve(bolt.instance(1), s).new()');
    expect(await written(base, FLANGE)).toBe(withStatements(`revolve(bolt.instance(1), s).new()`)
      .replace(`import { part,`, `import { revolve, part,`));
  });

  it('winds a helix around a connector', async () => {
    const base = await serve();
    const result = await post(`${base}/apply-feature`, {
      feature: 'helix', source: { ...BOLT, slot: 1 }, radius: 5, endRadius: null, pitch: 2, turns: null,
      height: 10, startOffset: null, endOffset: null,
    });
    expect(result.status).toBe(200);
    expect(result.body.preview).toBe('helix(bolt.instance(1)).radius(5).pitch(2).height(10)');
    expect(await written(base, FLANGE)).toBe(withStatements(`helix(bolt.instance(1)).radius(5).pitch(2).height(10)`)
      .replace(`import { part,`, `import { helix, part,`));
  });

  it('repeats and rotates around a connector', async () => {
    const base = await serve();
    let result = await post(`${base}/apply-feature`, {
      feature: 'repeat', kind: 'circular', targets: [PLATE], axis: BOLT, count: 4, sweep: { mode: 'angle', value: 360 },
    });
    expect(result.status).toBe(200);
    expect(result.body.preview).toBe(`repeat('circular', bolt, { count: 4, angle: 360 }, plate)`);
    expect(await written(base, FLANGE)).toContain(`  repeat('circular', bolt, { count: 4, angle: 360 }, plate)\n})`);

    result = await post(`${base}/apply-feature`, {
      feature: 'repeat', kind: 'linear', targets: [PLATE], spacingMode: 'offset',
      directions: [{ axis: { kind: 'standard', axis: 'x' }, count: 2, value: 50 }, { axis: { ...BOLT, slot: 1 }, count: 2, value: 5 }],
    });
    expect(result.status).toBe(200);
    expect(result.body.preview).toBe(`repeat('linear', ['x', bolt.instance(1)], { count: [2, 2], offset: [50, 5] }, plate)`);

    result = await post(`${base}/apply-feature`, { feature: 'rotate', targets: [PLATE], axis: { ...BOLT, slot: 1 }, angle: 30 });
    expect(result.status).toBe(200);
    expect(result.body.preview).toBe('rotate(bolt.instance(1), 30, plate)');
    expect(await written(base, FLANGE)).toContain(`  rotate(bolt.instance(1), 30, plate)\n})`);
  });

  it('refuses a connector with no call site, a slot that is no whole index, or in another file', async () => {
    const base = await serve();
    const refusals: [unknown, string][] = [
      [revolveBody({ kind: 'connector', line: 8, column: 15 }), 'a connector axis must carry its connector() {filePath, line}'],
      [revolveBody({ ...BOLT, slot: -1 }), 'a connector axis slot must be a whole number counting from 0'],
      [revolveBody({ ...BOLT, slot: 1.5 }), 'a connector axis slot must be a whole number counting from 0'],
      [revolveBody({ ...BOLT, filePath: '/ws/other.part.js' }), 'the axis and the profile sketch live in different files'],
      [{ feature: 'rotate', targets: [PLATE], axis: { ...BOLT, filePath: '/ws/other.part.js' }, angle: 30 }, 'the axis and the targets live in different files'],
      [{ feature: 'revolve', op: 'new', angle: 360, profile: { mode: 'bound', ...PROFILE }, axis: { kind: 'bolt' } }, 'axis must be {kind: "standard"|"axis"|"edge"|"connector", …}'],
    ];
    for (const [body, error] of refusals) {
      const result = await post(`${base}/apply-feature`, { ...(body as object), preview: true });
      expect(result.status, JSON.stringify(body)).toBe(400);
      expect(result.body.error).toBe(error);
    }
    expect(relayed).toEqual([]);
  });

  describe('editing', () => {
    const EDITED = withStatements(`revolve('z', s).new()`, `rotate(bolt.instance(1), 45, plate)`);
    const REVOLVE_AT = { filePath: MODEL, line: 11, column: 2 };
    const ROTATE_AT = { filePath: MODEL, line: 12, column: 2 };

    beforeEach(() => {
      currentCode = EDITED;
    });

    it('reads a connector axis back as written, and keeps it through an edit of the rest', async () => {
      const base = await serve();
      const parsed = await post(`${base}/feature/parse`, { line: 12, filePath: MODEL });
      expect(parsed.status).toBe(200);
      expect(parsed.body.parsed).toMatchObject({ feature: 'rotate', axisText: 'bolt.instance(1)', angle: 45 });

      const result = await post(`${base}/apply-feature`, { feature: 'rotate', edit: ROTATE_AT, angle: 90 });
      expect(result.status).toBe(200);
      expect(result.body.preview).toBe('rotate(bolt.instance(1), 90, plate)');
      expect(await written(base, EDITED)).toContain(`  rotate(bolt.instance(1), 90, plate)\n})`);
    });

    it('re-sources an axis to a connector, or one of its copies', async () => {
      const base = await serve();
      let result = await post(`${base}/apply-feature`, {
        feature: 'revolve', edit: REVOLVE_AT, op: 'new', angle: 360, axis: BOLT,
      });
      expect(result.status).toBe(200);
      expect(result.body.preview).toBe('revolve(bolt, s).new()');
      expect(await written(base, EDITED)).toContain(`  revolve(bolt, s).new()\n`);

      result = await post(`${base}/apply-feature`, {
        feature: 'rotate', edit: ROTATE_AT, angle: 45, axis: { ...PIVOT, slot: undefined },
      });
      expect(result.status).toBe(200);
      expect(result.body.preview).toBe('rotate(pivot, 45, plate)');
      const code = await written(base, EDITED);
      expect(code).toContain(`  const pivot = connector('pivot', plate.endFaces())\n`);
      expect(code).toContain(`  rotate(pivot, 45, plate)\n})`);
    });
  });
});

describe("a connector in a custom feature's axis value", () => {
  const SPINDLE = withStatements(`spindle(bolt.instance(1), { height: 4 })`)
    .replace(`import { face } from 'fluidcad/filters'`, `import { face } from 'fluidcad/filters'\nimport { spindle } from './spindle.feature.js'`);

  it('writes the connector — a copy of one with its slot — for a statement picked as one', async () => {
    const base = await serve();
    let result = await post(`${base}/apply-feature`, {
      feature: 'custom',
      custom: { id: 'acme.spindle', values: {}, picks: { around: [{ kind: 'statement', ...at(8, 'connector'), picker: 'connector', slot: 1 }] } },
    });
    expect(result.status).toBe(200);
    expect(result.body.preview).toBe('spindle(bolt.instance(1))');
    const code = await written(base, FLANGE);
    expect(code).toContain(`import { spindle } from './spindle.feature.js';`);
    expect(code).toContain(`  spindle(bolt.instance(1))\n})`);

    result = await post(`${base}/apply-feature`, {
      feature: 'custom',
      custom: { id: 'acme.spindle', values: {}, picks: { around: [{ kind: 'statement', ...at(10, 'connector'), picker: 'connector' }] } },
    });
    expect(result.status).toBe(200);
    expect(result.body.preview).toBe('spindle(pivot)');
  });

  it('refuses a connector where the value takes none', async () => {
    const base = await serve();
    const result = await post(`${base}/apply-feature`, {
      feature: 'custom',
      preview: true,
      custom: {
        id: 'acme.spindle', values: {}, picks: {
          around: [{ kind: 'standard', name: 'z' }],
          profile: [{ kind: 'statement', ...at(8, 'connector'), picker: 'connector' }],
        },
      },
    });
    expect(result.status).toBe(422);
    expect(result.body.reason).toBe('Profile: takes no connector statement — it takes a sketch');
  });

  it('reads it back with the slot, and keeps it as written through an edit', async () => {
    currentCode = SPINDLE;
    const base = await serve();
    const parsed = await post(`${base}/feature/parse`, { line: 12, filePath: MODEL });
    expect(parsed.status).toBe(200);
    expect(parsed.body.parsed).toMatchObject({
      feature: 'custom', id: 'acme.spindle', values: { height: 4 },
      // The import above the part moved the bolt to line 9.
      picks: { around: [{ text: 'bolt.instance(1)', ref: { line: 9, slot: 1 } }] },
    });

    const result = await post(`${base}/apply-feature`, {
      feature: 'custom', edit: { filePath: MODEL, line: 12, column: 2 },
      custom: { id: 'acme.spindle', values: { height: 6 } },
    });
    expect(result.status).toBe(200);
    expect(result.body.preview).toBe('spindle(bolt.instance(1), { height: 6 })');
    expect(await written(base, SPINDLE)).toContain(`  spindle(bolt.instance(1), { height: 6 })\n})`);

    // Re-picked as the connector itself.
    const repicked = await post(`${base}/apply-feature`, {
      feature: 'custom', edit: { filePath: MODEL, line: 12, column: 2 },
      custom: { id: 'acme.spindle', picks: { around: [{ kind: 'statement', ...at(8, 'connector'), line: 9, picker: 'connector' }] } },
    });
    expect(repicked.status).toBe(200);
    expect(repicked.body.preview).toBe('spindle(bolt, { height: 4 })');
  });
});
