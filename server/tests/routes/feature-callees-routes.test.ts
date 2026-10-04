import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import http from 'http';
import { createApplyFeatureRouter } from '../../src/routes/apply-feature/index.ts';
import { createResolveSelectionRouter } from '../../src/routes/resolve-selection.ts';
import { createTimelineRouter } from '../../src/routes/timeline.ts';
import { FeatureCatalog } from '../../src/feature-catalog/catalog.ts';
import type { ScannedFeature } from '../../src/feature-catalog/scan.ts';
import type { FeatureCalleeSource } from '../../src/apply-feature-edit/index.ts';

// The routers hand the feature catalog to everything that classifies a
// callee: the transform behind /code/apply-feature, the dispatcher's
// preflight, the synthesis namers and bindability probes, the move-to-part
// dry run. Without it a standoff's statement is no producer.

const MODEL = '/ws/model.part.js';

const CODE = [
  `import { sketch, rect, extrude, fillet, part } from 'fluidcad/core'`,
  `import { standoff } from './standoff.feature.js'`,
  ``,
  `sketch('xy', () => { rect(40, 40) })`,
  `const e = extrude(10)`,
  `const s = standoff(e.endFaces(), { height: 12 })`,
  `fillet(s.endEdges(), 0.5)`,
  ``,
  `const p1 = part('Body', () => {})`,
  ``,
].join('\n');

const FILLET_SPEC = {
  feature: 'fillet',
  value: 0.5,
  filePath: MODEL,
  producers: [{ line: 6, column: 10, featureType: 'acme.standoff', nameHint: 'f', bind: true }],
  parts: [{ producer: 0, accessor: 'endEdges', indices: null, filterArgs: null }],
  imports: [],
};

const STANDOFF_META = {
  id: 'acme.standoff', label: 'Standoff', group: 'create', kind: 'tool', operations: ['add', 'new'],
  params: {}, call: [], hasOnChange: false, ghost: true, contexts: ['part'],
} as unknown as ScannedFeature['meta'];

function standoffCatalog(): FeatureCatalog {
  return new FeatureCatalog({
    workspacePath: '/ws',
    scan: async (absPath) => absPath === '/ws/standoff.feature.js'
      ? { file: absPath, features: [{ exportName: 'standoff', meta: STANDOFF_META }], deps: [] }
      : { file: absPath, features: [], error: 'no such module', deps: [] },
    builtIns: async () => ({}),
  });
}

let synthesisOptions: any[];
let resolveOptions: any[];

const fakeServer = {
  getCurrentCode: () => CODE,
  getCurrentFileName: () => MODEL,
  getParamDefinitions: () => [],
  synthesizeApplyFeature: (_picks: unknown, _feature: string, _value: unknown, _chains: unknown, options: unknown) => {
    synthesisOptions.push(options);
    return { ok: true, spec: FILLET_SPEC, preview: 'fillet(0.5, s.endEdges())', args: 's.endEdges()', alternatives: [] };
  },
  resolveSelection: (_request: unknown, options: unknown) => {
    resolveOptions.push(options);
    return { ok: true, count: 0, matches: [], scope: { kind: 'root' }, unit: 'mm' };
  },
};

let server: http.Server | null = null;

async function serve(mount: (app: express.Express) => void): Promise<string> {
  const app = express();
  app.use(express.json());
  mount(app);
  server = http.createServer(app);
  await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address() as { port: number };
  return `http://127.0.0.1:${address.port}/api`;
}

async function post(url: string, body: unknown): Promise<{ status: number; body: any }> {
  const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { status: res.status, body: await res.json() };
}

function applyFeatureRouter(callees?: FeatureCalleeSource) {
  return createApplyFeatureRouter(fakeServer as any, () => {}, callees ? { callees } : {});
}

beforeEach(() => {
  synthesisOptions = [];
  resolveOptions = [];
});

afterEach(async () => {
  if (server) {
    await new Promise<void>(resolve => server!.close(() => resolve()));
    server = null;
  }
});

describe('routes with the feature catalog', () => {
  it('runs the editor round trip’s transform over the catalog', async () => {
    const without = await serve(app => app.use('/api', applyFeatureRouter()));
    const refused = await post(`${without}/code/apply-feature`, { code: CODE, spec: FILLET_SPEC });
    expect(refused.body.error).toContain('expected a acme.standoff()-producing call');
    await new Promise<void>(resolve => server!.close(() => resolve()));

    const base = await serve(app => app.use('/api', applyFeatureRouter(standoffCatalog())));
    const { status, body } = await post(`${base}/code/apply-feature`, { code: CODE, spec: FILLET_SPEC });
    expect(status).toBe(200);
    expect(body.error).toBeUndefined();
    expect(body.newCode).toContain(`const p1 = part('Body', () => {})\nfillet(0.5, s.endEdges())\n`);
  });

  it('preflights a dispatched fillet over the catalog', async () => {
    const without = await serve(app => app.use('/api', applyFeatureRouter()));
    const refused = await post(`${without}/apply-feature`, {
      feature: 'fillet', value: 0.5, entities: [{ shapeId: 'shape-1', sub: { type: 'edge', index: 0 } }],
    });
    expect(refused.status).toBe(422);
    expect(refused.body.reason).toContain('expected a acme.standoff()-producing call');
    await new Promise<void>(resolve => server!.close(() => resolve()));

    const base = await serve(app => app.use('/api', applyFeatureRouter(standoffCatalog())));
    const { status, body } = await post(`${base}/apply-feature`, {
      feature: 'fillet', value: 0.5, entities: [{ shapeId: 'shape-1', sub: { type: 'edge', index: 0 } }],
    });
    expect(status).toBe(200);
    expect(body.success).toBe(true);
  });

  it('names the standoff’s variable in the synthesis preview', async () => {
    const base = await serve(app => app.use('/api', applyFeatureRouter(standoffCatalog())));
    const { status } = await post(`${base}/apply-feature`, {
      feature: 'fillet', value: 0.5, preview: true, entities: [{ shapeId: 'shape-1', sub: { type: 'edge', index: 0 } }],
    });
    expect(status).toBe(200);
    expect(synthesisOptions[0].namer([{ line: 6, nameHint: 'f', featureType: 'acme.standoff' }])).toEqual(['s']);
  });

  it('probes the standoff as bindable when resolving a selection', async () => {
    const base = await serve(app => app.use('/api', createResolveSelectionRouter(fakeServer as any, standoffCatalog())));
    const { status } = await post(`${base}/resolve-selection`, { expression: 'edge()' });
    expect(status).toBe(200);
    expect(resolveOptions[0].bindable({ line: 6, column: 10, featureType: 'acme.standoff' })).toBe(true);
    expect(resolveOptions[0].namer([{ line: 6, nameHint: 'f', featureType: 'acme.standoff' }])).toEqual(['s']);
  });

  it('brings a standoff along in the move-to-part dry run', async () => {
    const base = await serve(app => app.use('/api', createTimelineRouter(fakeServer as any, () => {}, () => {}, {
      callees: standoffCatalog(),
    })));
    const { status, body } = await post(`${base}/move-to-part`, {
      filePath: MODEL, lines: [7], part: { line: 9, column: 11 }, dryRun: true,
    });
    expect(status).toBe(200);
    // The standoff, and what it stands on in turn.
    expect(body).toMatchObject({
      success: false,
      needs: [{ name: 's', line: 6 }, { name: 'e', line: 5 }, { name: 'sketch', line: 4 }],
    });
  });
});
