import { describe, it, expect } from 'vitest';
import {
  applyFeatureEdit,
  CustomFeaturePoints,
  CustomFeatureStatement,
  parseFeatureStatement,
  type ApplyFeatureEditSpec,
  type CustomFeatureOptions,
  type CustomPickSource,
} from '../src/apply-feature-edit/index.ts';
import { FeatureCatalog } from '../src/feature-catalog/catalog.ts';
import type { ScannedFeature } from '../src/feature-catalog/scan.ts';

// A custom feature that stands at locations — a connector, one of its
// copies, a point a sketch exports, an anchor on a face — written, read back
// and edited through its call shape. Deterministic: no scene, a catalog
// answering from a fixed module map.

const MODEL = '/ws/model.part.js';

/** The boss: bosses at connectors, points and face centres — a picker of three kinds. */
const BOSS_META = {
  id: 'acme.boss', label: 'Boss', group: 'create', kind: 'tool', operations: ['add', 'new'], defaultOperation: 'add',
  params: {
    at: { picker: ['connector', 'point', 'anchor'], multiple: true, anchors: ['center'], label: 'At' },
    diameter: { type: 'length', default: 8, min: 0, label: 'Boss diameter' },
    height: { type: 'length', default: 6, min: 0, label: 'Height' },
    hole: { type: 'length', default: 3, min: 0, label: 'Hole diameter' },
  },
  call: ['at', { diameter: 'diameter', height: 'height', hole: 'hole' }],
  hasOnChange: false, ghost: true, contexts: ['part'],
} as unknown as ScannedFeature['meta'];

/** A pin standing at one connector. */
const PIN_META = {
  id: 'acme.pin', label: 'Pin', group: 'create', kind: 'tool', operations: [], defaultOperation: null,
  params: { at: { picker: 'connector', label: 'At' } },
  call: ['at'],
  hasOnChange: false, ghost: true, contexts: ['part'],
} as unknown as ScannedFeature['meta'];

const MODULES: Record<string, ScannedFeature[]> = {
  '/ws/boss.feature.js': [{ exportName: 'boss', meta: BOSS_META }],
  '/ws/pin.feature.js': [{ exportName: 'pin', meta: PIN_META }],
};

function catalog(): FeatureCatalog {
  return new FeatureCatalog({
    workspacePath: '/ws',
    scan: async (absPath) => MODULES[absPath]
      ? { file: absPath, features: MODULES[absPath], deps: [] }
      : { file: absPath, features: [], error: `cannot load ${absPath}`, deps: [] },
    builtIns: async () => ({}),
  });
}

function src(...lines: string[]): string {
  return lines.join('\n') + '\n';
}

/** A plate in a part, a connector on its top copied once along x, and a sketch on the top holding a point. */
const PLATE = src(
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
);

/** The producers the picks bind: the connector, the plate, the point sketch. */
const PRODUCERS: ApplyFeatureEditSpec['producers'] = [
  { line: 7, column: 15, featureType: 'connector', nameHint: 'c', bind: true },
  { line: 6, column: 12, featureType: 'extrude', nameHint: 'e', bind: true },
  { line: 9, column: 2, featureType: 'sketch', nameHint: 's', bind: true },
];

/** A boss at the connector, its copy, the sketch's point and the plate top's centre. */
function bossSpec(items: CustomPickSource[], custom: Partial<CustomFeatureOptions> = {}): ApplyFeatureEditSpec {
  return {
    feature: 'custom',
    filePath: MODEL,
    producers: PRODUCERS,
    parts: [{ producer: 1, accessor: 'endFaces', indices: null, filterArgs: null }],
    imports: [],
    custom: {
      id: 'acme.boss',
      exportName: 'boss',
      modulePath: '/ws/boss.feature.js',
      shape: CustomFeatureStatement.shapeOf(BOSS_META),
      values: { at: { kind: 'picks', items } },
      ...custom,
    },
  };
}

const AT_ALL: CustomPickSource[] = [
  { kind: 'producer', producer: 0 },
  { kind: 'producer', producer: 0, instance: 1 },
  { kind: 'sketchPoint', producer: 2, target: { line: 10, featureType: 'point' } },
  { kind: 'part', part: 0, suffix: '.center()' },
];

describe('a custom feature standing at locations', () => {
  it('writes a connector, its copy, an exported sketch point and a face centre in one call', async () => {
    const result = await applyFeatureEdit(PLATE, bossSpec(AT_ALL), { callees: catalog() });

    expect(result.error).toBeUndefined();
    expect(result.newCode).toBe(src(
      `import { part, sketch, rect, point, extrude, connector, copy, select } from 'fluidcad/core'`,
      `import { face } from 'fluidcad/filters'`,
      `import { boss } from './boss.feature.js';`,
      ``,
      `part('plate', () => {`,
      `  sketch('xy', () => { rect(60, 40) })`,
      `  const e = extrude(10)`,
      `  const bolt = connector('bolt', select(face().onPlane('xy', 10)))`,
      `  copy('linear', 'x', { count: 2, offset: 15 }, bolt)`,
      `  const s = sketch(e.endFaces(), () => {`,
      `    const p1 = point([-20, -10])`,
      `    return { p1 };`,
      `  })`,
      `  boss([bolt, bolt.instance(1), s.geometries.p1, e.endFaces().center()])`,
      `})`,
    ));
  });

  it('stages the export alone, naming the point by what it wrote', async () => {
    const spec = bossSpec([{ kind: 'sketchPoint', producer: 2, target: { line: 10, featureType: 'point' } }]);
    expect(CustomFeaturePoints.needsStaging(spec)).toBe(true);
    expect(CustomFeaturePoints.needsStaging(bossSpec([{ kind: 'producer', producer: 0 }]))).toBe(false);

    const staged = await CustomFeaturePoints.prepare(PLATE, spec);
    expect('error' in staged).toBe(false);
    if ('error' in staged) {
      return;
    }
    expect(staged.spec.custom!.values.at).toEqual({ kind: 'picks', items: [{ kind: 'expression', expression: 's.geometries.p1' }] });
    expect(staged.code).toContain('return { p1 };');
    // The producers follow the edit: the sketch statement kept its line, nothing above it moved.
    expect(staged.spec.producers.map(p => p.line)).toEqual([7, 6, 9]);
  });

  it('refuses an anchor suffix it cannot write, and a copy slot on anything but a connector', async () => {
    const bad = await applyFeatureEdit(PLATE, bossSpec([{ kind: 'part', part: 0, suffix: '.center(); evil()' }]), { callees: catalog() });
    expect(bad.error).toContain("the value of 'at'");
    const notConnector = await applyFeatureEdit(PLATE, bossSpec([{ kind: 'producer', producer: 1, instance: 2 }]), { callees: catalog() });
    expect(notConnector.error).toContain("the value of 'at'");
  });

  it('reads the locations back, a copy by its seed statement and slot, and edits keeping them', async () => {
    const code = src(
      `import { part, sketch, rect, point, extrude, connector, copy, select } from 'fluidcad/core'`,
      `import { face } from 'fluidcad/filters'`,
      `import { boss } from './boss.feature.js'`,
      ``,
      `part('plate', () => {`,
      `  sketch('xy', () => { rect(60, 40) })`,
      `  const e = extrude(10)`,
      `  const bolt = connector('bolt', select(face().onPlane('xy', 10)))`,
      `  copy('linear', 'x', { count: 2, offset: 15 }, bolt)`,
      `  boss([bolt, bolt.instance(1), e.endFaces().center()], { height: 8 })`,
      `})`,
    );
    const callees = await catalog().calleesFor(code, MODEL);
    const parsed = await parseFeatureStatement(code, 10, callees);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok || parsed.parsed.feature !== 'custom') {
      return;
    }
    expect(parsed.parsed.values).toEqual({ height: 8 });
    expect(parsed.parsed.picks.at.map(pick => ({ text: pick.text, ref: pick.ref }))).toEqual([
      { text: 'bolt', ref: { line: 8, column: 15 } },
      { text: 'bolt.instance(1)', ref: { line: 8, column: 15, slot: 1 } },
      { text: 'e.endFaces().center()', ref: undefined },
    ]);

    // Keep the copy and the anchor, drop the connector, add a vertex named on the plate.
    const edit: ApplyFeatureEditSpec = {
      feature: 'custom',
      filePath: MODEL,
      producers: [{ line: 7, column: 12, featureType: 'extrude', nameHint: 'e', bind: true }],
      parts: [{ producer: 0, accessor: 'endEdges', indices: [0], filterArgs: null }],
      imports: [],
      edit: {
        line: 10, column: 2,
        custom: {
          id: 'acme.boss',
          values: {
            at: { kind: 'picks', items: [{ kind: 'verbatim', sourceIndex: 1 }, { kind: 'verbatim', sourceIndex: 2 }, { kind: 'part', part: 0, suffix: '.start()' }] },
            height: { kind: 'keep' },
          },
        },
      },
    };
    const result = await applyFeatureEdit(code, edit, { callees: catalog() });
    expect(result.error).toBeUndefined();
    expect(result.newCode).toContain('  boss([bolt.instance(1), e.endFaces().center(), e.endEdges(0).start()], { height: 8 })\n');
  });

  it('writes a lone connector for a single value, with its import', async () => {
    const spec: ApplyFeatureEditSpec = {
      feature: 'custom',
      filePath: MODEL,
      producers: [PRODUCERS[0]],
      parts: [],
      imports: [],
      custom: {
        id: 'acme.pin', exportName: 'pin', modulePath: '/ws/pin.feature.js',
        shape: CustomFeatureStatement.shapeOf(PIN_META),
        values: { at: { kind: 'picks', items: [{ kind: 'producer', producer: 0, instance: 1 }] } },
      },
    };
    const result = await applyFeatureEdit(PLATE, spec, { callees: catalog() });
    expect(result.error).toBeUndefined();
    expect(result.newCode).toContain(`import { pin } from './pin.feature.js';`);
    expect(result.newCode).toContain('  pin(bolt.instance(1))\n');
  });
});
