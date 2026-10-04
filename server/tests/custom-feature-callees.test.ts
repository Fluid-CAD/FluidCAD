import { describe, it, expect } from 'vitest';
import {
  applyFeatureEdit,
  FeatureCallees,
  makeProducerBindable,
  makeProducerBoundProbe,
  makeProducerNamer,
  type ApplyFeatureEditSpec,
} from '../src/apply-feature-edit/index.ts';
import { FeatureCatalog } from '../src/feature-catalog/catalog.ts';
import type { ScannedFeature } from '../src/feature-catalog/scan.ts';
import { MoveToPart, type MoveToPartSpec } from '../src/move-to-part.ts';

// A custom feature's call binds, repeats and moves like a built-in's once the
// file's imports are followed through the feature catalog. The catalog here
// scans nothing: its scanner answers from a fixed module map.

const MODEL = '/ws/model.part.js';
const STANDOFF_MODULE = '/ws/standoff.feature.js';

function snapshot(id: string, kind: 'tool' | 'modifier'): ScannedFeature['meta'] {
  return {
    id, label: id, group: 'create', kind, operations: kind === 'tool' ? ['add', 'new'] : [],
    params: { height: { type: 'length', default: 10, label: 'Height' } },
    call: [{ height: 'height' }], hasOnChange: false, ghost: true, contexts: ['part'],
  } as ScannedFeature['meta'];
}

function catalog(modules: Record<string, ScannedFeature[]> = {
  [STANDOFF_MODULE]: [{ exportName: 'standoff', meta: snapshot('acme.standoff', 'tool') }],
}): { catalog: FeatureCatalog; scans: string[] } {
  const scans: string[] = [];
  return {
    scans,
    catalog: new FeatureCatalog({
      workspacePath: '/ws',
      scan: async (absPath) => {
        scans.push(absPath);
        return modules[absPath]
          ? { file: absPath, features: modules[absPath], deps: [] }
          : { file: absPath, features: [], error: `cannot load ${absPath}`, deps: [] };
      },
      builtIns: async () => ({}),
    }),
  };
}

function src(...lines: string[]): string {
  return lines.join('\n') + '\n';
}

/** A fillet on the end edges of the standoff statement at `line`. */
function filletSpec(line: number, featureType = 'acme.standoff'): ApplyFeatureEditSpec {
  return {
    feature: 'fillet',
    value: 0.5,
    filePath: MODEL,
    producers: [{ line, column: 0, featureType, nameHint: 'f', bind: true }],
    parts: [{ producer: 0, accessor: 'endEdges', indices: null, filterArgs: null }],
    imports: [],
  };
}

const BOUND = src(
  `import { sketch, rect, extrude } from 'fluidcad/core'`,
  `import { standoff } from './standoff.feature.js'`,
  ``,
  `sketch('xy', () => { rect(40, 40) })`,
  `const e = extrude(10)`,
  `const s = standoff(e.endFaces(), { height: 12 })`,
);

describe('FeatureCallees', () => {
  const callees = new FeatureCallees(new Map([
    ['standoff', { id: 'acme.standoff', kind: 'tool' as const }],
    ['lift', { id: 'acme.lift', kind: 'modifier' as const }],
  ]));

  it('keeps the built-in lists as they are', () => {
    for (const source of [FeatureCallees.BUILT_IN, callees]) {
      expect(source.produces('extrude', 'extrude')).toBe(true);
      expect(source.produces('extrude', 'cut')).toBe(true);
      expect(source.produces('feature', 'fillet')).toBe(true);
      expect(source.produces('extrude', 'fillet')).toBe(false);
      expect(source.produces('sketch', 'sketch')).toBe(true);
      expect(source.produces('sketch', 'extrude')).toBe(false);
      expect(source.produces('extrude', null)).toBe(false);
      expect(source.buildsFeature('extrude')).toBe(true);
      expect(source.buildsFeature('param')).toBe(false);
    }
  });

  it('makes a custom feature produce its own id, and every repeat target', () => {
    expect(callees.produces('acme.standoff', 'standoff')).toBe(true);
    expect(callees.produces('acme.lift', 'lift')).toBe(true);
    expect(callees.produces('feature', 'standoff')).toBe(true);
    expect(callees.produces('feature', 'lift')).toBe(true);
    // Another type's producer, or an identity input, never binds one.
    expect(callees.produces('acme.lift', 'standoff')).toBe(false);
    expect(callees.produces('extrude', 'standoff')).toBe(false);
    expect(callees.produces('sketch', 'standoff')).toBe(false);
    expect(callees.buildsFeature('standoff')).toBe(true);
    expect(FeatureCallees.BUILT_IN.produces('acme.standoff', 'standoff')).toBe(false);
    expect(FeatureCallees.BUILT_IN.buildsFeature('standoff')).toBe(false);
  });
});

describe('applyFeatureEdit with custom feature callees', () => {
  it('refuses a standoff producer without a catalog, and binds it with one', async () => {
    const refused = await applyFeatureEdit(BOUND, filletSpec(6));
    expect(refused.error).toContain('expected a acme.standoff()-producing call');

    const { catalog: features } = catalog();
    const result = await applyFeatureEdit(BOUND, filletSpec(6), { callees: features });
    expect(result.error).toBeUndefined();
    expect(result.newCode).toBe(src(
      `import { fillet, sketch, rect, extrude } from 'fluidcad/core'`,
      `import { standoff } from './standoff.feature.js'`,
      ``,
      `sketch('xy', () => { rect(40, 40) })`,
      `const e = extrude(10)`,
      `const s = standoff(e.endFaces(), { height: 12 })`,
      `fillet(0.5, s.endEdges())`,
    ));
  });

  it('binds a bare standoff statement to a fresh variable', async () => {
    const code = BOUND.replace('const s = standoff(', 'standoff(');
    const result = await applyFeatureEdit(code, filletSpec(6), { callees: catalog().catalog });
    expect(result.error).toBeUndefined();
    expect(result.newCode).toContain(`const f = standoff(e.endFaces(), { height: 12 })`);
    expect(result.newCode).toContain(`fillet(0.5, f.endEdges())`);
  });

  it('follows an aliased import to the feature', async () => {
    const code = BOUND
      .replace(`import { standoff } from`, `import { standoff as so } from`)
      .replace('const s = standoff(', 'const s = so(');
    const result = await applyFeatureEdit(code, filletSpec(6), { callees: catalog().catalog });
    expect(result.error).toBeUndefined();
    expect(result.newCode).toContain(`fillet(0.5, s.endEdges())`);
  });

  it('follows a relative import from another directory', async () => {
    const code = BOUND.replace(`'./standoff.feature.js'`, `'../standoff.feature.js'`);
    const result = await applyFeatureEdit(code, { ...filletSpec(6), filePath: '/ws/parts/model.part.js' },
      { callees: catalog().catalog });
    expect(result.error).toBeUndefined();
    expect(result.newCode).toContain(`fillet(0.5, s.endEdges())`);
  });

  it('repeats a standoff like a built-in feature', async () => {
    const result = await applyFeatureEdit(BOUND, {
      feature: 'repeat',
      repeat: {
        kind: 'linear',
        spacingMode: 'offset',
        directions: [{ axis: { kind: 'standard', axis: 'x' }, count: 3, value: 20 }],
        targets: [{ producer: 0 }],
      },
      filePath: MODEL,
      producers: [{ line: 6, column: 0, featureType: 'feature', nameHint: 'f', bind: true }],
      parts: [],
      imports: [],
    }, { callees: catalog().catalog });
    expect(result.error).toBeUndefined();
    expect(result.newCode).toContain(`repeat('linear', 'x', { count: 3, offset: 20 }, s)`);
  });

  it('refuses a standoff call where another feature type was picked', async () => {
    const result = await applyFeatureEdit(BOUND, filletSpec(6, 'acme.bracket'), { callees: catalog().catalog });
    expect(result.error).toContain('expected a acme.bracket()-producing call');
  });

  it('refuses a callee the file does not import from a feature module', async () => {
    const local = BOUND.replace(`import { standoff } from './standoff.feature.js'`, `const standoff = (f, o) => f`);
    const notFeature = BOUND.replace(`'./standoff.feature.js'`, `'./standoff.js'`);
    const missing = BOUND.replace(`'./standoff.feature.js'`, `'./bracket.feature.js'`);
    for (const code of [local, notFeature, missing]) {
      const result = await applyFeatureEdit(code, filletSpec(6), { callees: catalog().catalog });
      expect(result.error).toContain('expected a acme.standoff()-producing call');
    }
  });

  it('resolves the callees once per edit, for the spec’s own file', async () => {
    const asked: { filePath: string }[] = [];
    const source = {
      calleesFor: async (_code: string, filePath: string) => {
        asked.push({ filePath });
        return catalog().catalog.calleesFor(BOUND, filePath);
      },
    };
    const result = await applyFeatureEdit(BOUND, filletSpec(6), { callees: source });
    expect(result.error).toBeUndefined();
    expect(asked).toEqual([{ filePath: MODEL }]);

    // A spec that binds no producer never asks.
    asked.length = 0;
    await applyFeatureEdit(BOUND, { ...filletSpec(6), sketchClosed: { sourceLine: 4, closed: true } }, { callees: source });
    expect(asked).toEqual([]);
  });
});

describe('synthesis probes with custom feature callees', () => {
  it('names, binds and probes a standoff producer like a built-in one', async () => {
    const callees = await catalog().catalog.calleesFor(BOUND, MODEL);
    const producer = { line: 6, featureType: 'acme.standoff' };

    expect((await makeProducerBindable(BOUND))(producer)).toBe(false);
    expect((await makeProducerBindable(BOUND, callees))(producer)).toBe(true);
    expect((await makeProducerNamer(BOUND))([{ ...producer, nameHint: 'f' }])).toEqual([null]);
    expect((await makeProducerNamer(BOUND, callees))([{ ...producer, nameHint: 'f' }])).toEqual(['s']);
    expect((await makeProducerBoundProbe(BOUND, callees))(producer)).toBe(true);
  });
});

describe('MoveToPart with custom feature callees', () => {
  const code = src(
    `import { fillet, part } from 'fluidcad/core'`,
    `import { standoff } from './standoff.feature.js'`,
    ``,
    `const s = standoff(null, { height: 12 })`,
    `fillet(s.endEdges(), 0.5)`,
    ``,
    `const p1 = part('Body', () => {})`,
  );

  async function moveSpec(lines: number[]): Promise<MoveToPartSpec> {
    const captured = await MoveToPart.captureStatements(code, lines);
    if ('error' in captured) {
      throw new Error(captured.error);
    }
    return { statements: captured.statements, part: { line: 7, column: 11 } };
  }

  it('brings the standoff a moved statement reads along', async () => {
    // Read as a plain value without the catalog: the move would leave the
    // standoff's geometry outside the part.
    expect(await MoveToPart.analyze(code, await moveSpec([5]))).toEqual({ ok: true });

    const callees = await catalog().catalog.calleesFor(code, MODEL);
    const analysis = await MoveToPart.analyze(code, await moveSpec([5]), callees);
    expect(analysis.ok).toBe(false);
    if (analysis.ok === false) {
      expect(analysis.needs).toEqual([{ name: 's', line: 4 }]);
    }

    const { catalog: features } = catalog();
    const refused = await applyFeatureEdit(code, {
      feature: 'sketch', filePath: MODEL, producers: [], parts: [], imports: [], moveToPart: await moveSpec([5]),
    }, { callees: features });
    expect(refused.error).toContain(`'s' (line 4)`);

    const moved = await applyFeatureEdit(code, {
      feature: 'sketch', filePath: MODEL, producers: [], parts: [], imports: [], moveToPart: await moveSpec([4, 5]),
    }, { callees: features });
    expect(moved.error).toBeUndefined();
    expect(moved.newCode).toBe(src(
      `import { fillet, part } from 'fluidcad/core'`,
      `import { standoff } from './standoff.feature.js'`,
      ``,
      `const p1 = part('Body', () => {`,
      `  const s = standoff(null, { height: 12 })`,
      `  fillet(s.endEdges(), 0.5)`,
      `})`,
    ));
  });
});
