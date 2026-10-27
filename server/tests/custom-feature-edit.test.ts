import { describe, it, expect } from 'vitest';
import {
  applyFeatureEdit,
  CustomFeatureStatement,
  parseFeatureStatement,
  type ApplyFeatureEditSpec,
  type CustomFeatureOptions,
  TypedInKinds,
  type TypedInSpec,
} from '../src/apply-feature-edit/index.ts';
import { FeatureCatalog } from '../src/feature-catalog/catalog.ts';
import type { ScannedFeature } from '../src/feature-catalog/scan.ts';

// A custom feature's statement goes through the call shape its metadata
// declares, both ways: a create writes the call and the builder's import, an
// edit reads the statement back by the same shape and re-renders it with the
// values it keeps. Deterministic: no scene, a catalog answering from a fixed
// module map.

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
  ghost: true, contexts: ['part'],
} as unknown as ScannedFeature['meta'];

/** A modifier in the draft shape: an angle, then the faces spread. */
const TAPER_META = {
  id: 'acme.taper', label: 'Taper', group: 'modify', kind: 'modifier', operations: [],
  params: {
    angle: { type: 'angle', default: 3, label: 'Angle' },
    faces: { picker: 'face', multiple: true, label: 'Faces' },
  },
  call: ['angle', '...faces'],
  ghost: true, contexts: ['part'],
} as unknown as ScannedFeature['meta'];

/** Every other kind of value: a sketch, an axis, a list of solids, text, a flag, a choice. */
const GUSSET_META = {
  id: 'acme.gusset', label: 'Gusset', group: 'create', kind: 'tool', operations: ['add', 'new', 'remove'],
  params: {
    profile: { picker: 'sketch', label: 'Profile' },
    axis: { picker: 'axis', label: 'Axis', optional: true },
    width: { type: 'length', default: 2, label: 'Width' },
    targets: { picker: 'solid', multiple: true, optional: true, label: 'Targets' },
    tag: { type: 'text', optional: true, label: 'Tag' },
    flip: { type: 'boolean', default: false, label: 'Flip' },
    style: { type: 'select', options: [{ label: 'Flat', value: 'flat' }, { label: 'Round', value: 'round' }], default: 'flat', label: 'Style' },
  },
  call: ['profile', 'axis', { width: 'width', targets: 'targets', tag: 'tag', flip: 'flip', style: 'style' }],
  ghost: true, contexts: ['part'],
} as unknown as ScannedFeature['meta'];

/** A ring of holes around an axis that only cuts: remove is its default, written without a chain. */
const BOLT_CIRCLE_META = {
  id: 'acme.boltCircle', label: 'Bolt circle', group: 'create', kind: 'tool', operations: ['remove'],
  defaultOperation: 'remove',
  params: {
    around: { picker: 'axis', label: 'Around axis' },
    count: { type: 'integer', default: 4, min: 1, label: 'Holes' },
  },
  call: ['around', { count: 'count' }],
  ghost: true, contexts: ['part'],
} as unknown as ScannedFeature['meta'];

/** A pocket that cuts by default and may keep its tool apart instead. */
const POCKET_META = {
  id: 'acme.pocket', label: 'Pocket', group: 'create', kind: 'tool', operations: ['remove', 'new'],
  defaultOperation: 'remove',
  params: { depth: { type: 'length', default: 2, label: 'Depth' } },
  call: [{ depth: 'depth' }],
  ghost: true, contexts: ['part'],
} as unknown as ScannedFeature['meta'];

/** A value of a type the server holds no entry for: the SDK refuses one, a newer engine's snapshot may carry it. */
const SWATCH_META = {
  id: 'acme.swatch', label: 'Swatch', group: 'create', kind: 'tool', operations: [],
  params: { tint: { type: 'colour', default: '#fff', label: 'Tint' } },
  call: [{ tint: 'tint' }],
  ghost: true, contexts: ['part'],
} as unknown as ScannedFeature['meta'];

/** The screw options as shown: images, a description, a group, keywords — and one offered only while the head is plain. */
const SHOWN_SCREW_OPTIONS: { label: string; value: string; image: string; description?: string; group: string; keywords?: string[]; when?: Record<string, string> }[] = [
  { label: 'M3', value: 'm3', image: './clip/m3.svg', description: '3.4 mm', group: 'Metric', keywords: ['iso'] },
  { label: 'M4', value: 'm4', image: './clip/m4.svg', group: 'Metric', when: { head: 'plain' } },
];

/** Choices: a select and two radios, shown as a grid and cards with images, groups and keywords. */
const CLIP_META = {
  id: 'acme.clip', label: 'Clip', group: 'create', kind: 'tool', operations: [],
  params: {
    size: { type: 'select', label: 'Screw', default: 'm3', display: 'grid', columns: 3, search: true, options: SHOWN_SCREW_OPTIONS },
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

const MODULES: Record<string, ScannedFeature[]> = {
  '/ws/clip.feature.js': [{ exportName: 'clip', meta: CLIP_META }],
  '/ws/swatch.feature.js': [{ exportName: 'swatch', meta: SWATCH_META }],
  '/ws/standoff.feature.js': [{ exportName: 'standoff', meta: STANDOFF_META }],
  '/ws/lib/taper.feature.js': [{ exportName: 'taper', meta: TAPER_META }],
  '/ws/gusset.feature.js': [{ exportName: 'gusset', meta: GUSSET_META }],
  '/ws/bolt-circle.feature.js': [{ exportName: 'boltCircle', meta: BOLT_CIRCLE_META }],
  '/ws/pocket.feature.js': [{ exportName: 'pocket', meta: POCKET_META }],
};

/** Every C4 presentation field on show: a slider, a stepper, a checkbox, a text with its limits, hints. */
const DIAL_META = {
  id: 'acme.dial', label: 'Dial', group: 'create', kind: 'tool', operations: [],
  params: {
    depth: { type: 'length', label: 'Depth', default: 2, min: 1, max: 50, display: 'slider', suffix: 'mm', hint: 'Measured from the surface' },
    count: { type: 'integer', label: 'Count', optional: true, min: 1, max: 8, display: 'stepper', suffix: 'x' },
    flush: { type: 'boolean', label: 'Flush', default: false, display: 'checkbox', hint: 'Level with the face' },
    note: { type: 'text', label: 'Note', optional: true, multiline: true, placeholder: 'A2-70', maxLength: 12, pattern: '[A-Za-z0-9\\n-]*', hint: 'Letters, digits and dashes' },
  },
  call: [{ depth: 'depth', count: 'count', flush: 'flush', note: 'note' }],
  ghost: true, contexts: ['part'],
} as unknown as ScannedFeature['meta'];

/** The same values with no presentation: what is left is what a statement may depend on. */
const BARE_DIAL_META = {
  id: 'acme.dial', label: 'Dial', group: 'create', kind: 'tool', operations: [],
  params: {
    depth: { type: 'length', label: 'Depth', default: 2, min: 1, max: 50 },
    count: { type: 'integer', label: 'Count', optional: true, min: 1, max: 8 },
    flush: { type: 'boolean', label: 'Flush', default: false },
    note: { type: 'text', label: 'Note', optional: true, maxLength: 12, pattern: '[A-Za-z0-9\\n-]*' },
  },
  call: [{ depth: 'depth', count: 'count', flush: 'flush', note: 'note' }],
  ghost: true, contexts: ['part'],
} as unknown as ScannedFeature['meta'];

MODULES['/ws/dial.feature.js'] = [{ exportName: 'dial', meta: DIAL_META }];

/** Two multi-selects — one with a default list, one starting empty — ahead of a length, all positional. */
const RIM_META = {
  id: 'acme.rim', label: 'Rim', group: 'create', kind: 'tool', operations: [],
  params: {
    coats: { type: 'select', multiple: true, label: 'Coats', default: [], options: [{ label: 'Prime', value: 'prime' }, { label: 'Two', value: 2 }] },
    finishes: { type: 'select', multiple: true, label: 'Finishes', default: ['deburr'], min: 0, max: 2, display: 'grid', columns: 3, search: true, hint: 'Up to two', options: [{ label: 'Deburr', value: 'deburr', description: 'Break the edge' }, { label: 'Chamfer', value: 'chamfer' }, { label: 'Polish', value: 'polish' }] },
    depth: { type: 'length', label: 'Depth', optional: true },
  },
  call: ['coats', 'finishes', 'depth'],
  ghost: true, contexts: ['part'],
} as unknown as ScannedFeature['meta'];

/** The same lists with nothing but labels, values and counts. */
const BARE_RIM_META = {
  id: 'acme.rim', label: 'Rim', group: 'create', kind: 'tool', operations: [],
  params: {
    coats: { type: 'select', multiple: true, label: 'Coats', default: [], options: [{ label: 'Prime', value: 'prime' }, { label: 'Two', value: 2 }] },
    finishes: { type: 'select', multiple: true, label: 'Finishes', default: ['deburr'], min: 0, max: 2, options: [{ label: 'Deburr', value: 'deburr' }, { label: 'Chamfer', value: 'chamfer' }, { label: 'Polish', value: 'polish' }] },
    depth: { type: 'length', label: 'Depth', optional: true },
  },
  call: ['coats', 'finishes', 'depth'],
  ghost: true, contexts: ['part'],
} as unknown as ScannedFeature['meta'];

MODULES['/ws/rim.feature.js'] = [{ exportName: 'rim', meta: RIM_META }];

/** A gear placed on an optional pick: left out, the call goes straight to its options. */
const GEAR_META = {
  id: 'acme.gear', label: 'Gear', group: 'create', kind: 'tool', operations: ['add', 'new'],
  params: {
    at: { picker: ['face', 'edge'], label: 'At', optional: true },
    teeth: { type: 'integer', default: 24, min: 3, label: 'Teeth' },
    width: { type: 'length', default: 10, label: 'Width' },
  },
  call: ['at', { teeth: 'teeth', width: 'width' }],
  ghost: true, contexts: ['part'],
} as unknown as ScannedFeature['meta'];

MODULES['/ws/gear.feature.js'] = [{ exportName: 'gear', meta: GEAR_META }];

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

const PLATE = src(
  `import { sketch, rect, extrude } from 'fluidcad/core'`,
  ``,
  `sketch('xy', () => { rect(40, 40) })`,
  `const e = extrude(10)`,
);

/** A standoff on `e.endFaces()` — the plate's top, as the slot synthesis names it. */
function standoffSpec(custom: Partial<CustomFeatureOptions> = {}): ApplyFeatureEditSpec {
  return {
    feature: 'custom',
    filePath: MODEL,
    producers: [{ line: 4, column: 10, featureType: 'extrude', nameHint: 'e', bind: true }],
    parts: [{ producer: 0, accessor: 'endFaces', indices: null, filterArgs: null }],
    imports: [],
    custom: {
      id: 'acme.standoff',
      exportName: 'standoff',
      modulePath: '/ws/standoff.feature.js',
      shape: CustomFeatureStatement.shapeOf(STANDOFF_META),
      values: {
        face: { kind: 'picks', items: [{ kind: 'part', part: 0 }] },
        height: { kind: 'value', value: 12 },
        hole: { kind: 'value', value: 'holeD' },
      },
      ...custom,
    },
  };
}

describe('creating a custom feature statement', () => {
  it('writes the call by its shape and imports the builder from its module', async () => {
    const result = await applyFeatureEdit(PLATE, standoffSpec(), { callees: catalog() });
    expect(result.error).toBeUndefined();
    expect(result.newCode).toBe(src(
      `import { sketch, rect, extrude } from 'fluidcad/core'`,
      `import { standoff } from './standoff.feature.js';`,
      ``,
      `sketch('xy', () => { rect(40, 40) })`,
      `const e = extrude(10)`,
      `standoff(e.endFaces(), { height: 12, hole: holeD })`,
    ));
  });

  it('writes the operation the dialog chose', async () => {
    const result = await applyFeatureEdit(PLATE, standoffSpec({ operation: 'new' }));
    expect(result.error).toBeUndefined();
    expect(result.newCode).toContain(`standoff(e.endFaces(), { height: 12, hole: holeD }).new()`);

    const refused = await applyFeatureEdit(PLATE, standoffSpec({ operation: 'remove' }));
    expect(refused.error).toContain(`the operation 'remove' is not one the feature offers`);
  });

  it('reuses the file\'s import of the builder, whatever it calls it or spells the path', async () => {
    for (const [line, callee] of [
      [`import { standoff as so } from './standoff.feature.js'`, 'so'],
      [`import { standoff } from "./sub/../standoff.feature.js"`, 'standoff'],
    ]) {
      const code = PLATE.replace(`'fluidcad/core'\n`, `'fluidcad/core'\n${line}\n`);
      const result = await applyFeatureEdit(code, { ...standoffSpec(), producers: [{ line: 5, column: 10, featureType: 'extrude', nameHint: 'e', bind: true }] });
      expect(result.error).toBeUndefined();
      expect(result.newCode).toContain(`${line}\n`);
      expect(result.newCode).toContain(`\n${callee}(e.endFaces(), { height: 12, hole: holeD })\n`);
      expect(result.newCode.match(/standoff\.feature\.js/g)).toHaveLength(1);
    }
  });

  it('imports the builder under a free name when the file already binds its own', async () => {
    const code = PLATE + `const standoff = 3\n`;
    const result = await applyFeatureEdit(code, standoffSpec());
    expect(result.error).toBeUndefined();
    expect(result.newCode).toContain(`import { standoff as standoffFeature } from './standoff.feature.js';`);
    expect(result.newCode).toContain(`standoffFeature(e.endFaces(), { height: 12, hole: holeD })`);
  });

  it('imports from a module in another directory by its relative path', async () => {
    const result = await applyFeatureEdit(PLATE, {
      ...standoffSpec(),
      custom: {
        id: 'acme.taper',
        exportName: 'taper',
        modulePath: '/ws/lib/taper.feature.js',
        shape: CustomFeatureStatement.shapeOf(TAPER_META),
        values: {
          angle: { kind: 'value', value: 5 },
          faces: { kind: 'picks', items: [{ kind: 'part', part: 0 }] },
        },
      },
      filePath: '/ws/parts/model.part.js',
    });
    expect(result.error).toBeUndefined();
    expect(result.newCode).toContain(`import { taper } from '../lib/taper.feature.js';`);
    expect(result.newCode).toContain(`taper(5, e.endFaces())`);
  });

  it('spreads a rest value over the arguments and lays a list option out as one', async () => {
    const spec = standoffSpec();
    spec.parts = [
      { producer: 0, accessor: 'endFaces', indices: null, filterArgs: null },
      { producer: 0, accessor: 'sideFaces', indices: [0], filterArgs: null },
    ];
    const taper = await applyFeatureEdit(PLATE, {
      ...spec,
      custom: {
        id: 'acme.taper', exportName: 'taper', modulePath: '/ws/lib/taper.feature.js',
        shape: CustomFeatureStatement.shapeOf(TAPER_META),
        values: {
          angle: { kind: 'value', value: 5 },
          faces: { kind: 'picks', items: [{ kind: 'part', part: 0 }, { kind: 'part', part: 1 }] },
        },
      },
    });
    expect(taper.error).toBeUndefined();
    expect(taper.newCode).toContain(`taper(5, e.endFaces(), e.sideFaces(0))`);
  });

  it('writes statement picks, world axes and every kind of typed-in value', async () => {
    const code = src(
      `import { sketch, rect, extrude, part } from 'fluidcad/core'`,
      ``,
      `const s = sketch('xz', () => { rect(10, 10) })`,
      `const p = part('Body', () => {`,
      `  sketch('xy', () => { rect(40, 40) })`,
      `  const base = extrude(10)`,
      `  extrude(5)`,
      `})`,
    );
    const spec: ApplyFeatureEditSpec = {
      feature: 'custom',
      filePath: MODEL,
      producers: [
        { line: 3, column: 10, featureType: 'sketch', nameHint: 's', bind: true },
        { line: 6, column: 15, featureType: 'feature', nameHint: 'f', bind: true },
        { line: 7, column: 2, featureType: 'feature', nameHint: 'f', bind: true },
      ],
      parts: [],
      imports: [],
      custom: {
        id: 'acme.gusset', exportName: 'gusset', modulePath: '/ws/gusset.feature.js',
        shape: CustomFeatureStatement.shapeOf(GUSSET_META),
        values: {
          profile: { kind: 'picks', items: [{ kind: 'producer', producer: 0 }] },
          axis: { kind: 'picks', items: [{ kind: 'standard', name: 'z' }] },
          width: { kind: 'value', value: 'w * 2' },
          targets: { kind: 'picks', items: [{ kind: 'producer', producer: 1 }, { kind: 'producer', producer: 2 }] },
          tag: { kind: 'literal', value: `it's "here"` },
          flip: { kind: 'literal', value: true },
          style: { kind: 'literal', value: 'round' },
        },
        operation: 'remove',
        scope: [{ kind: 'feature', producer: 1 }],
      },
    };
    const result = await applyFeatureEdit(code, spec);
    expect(result.error).toBeUndefined();
    expect(result.newCode).toContain(
      `  const f = extrude(5)\n`
      + `  gusset(s, 'z', { width: w * 2, targets: [base, f], tag: 'it\\'s "here"', flip: true, style: 'round' })`
      + `.remove().scope(base)\n})`,
    );
    expect(result.newCode).toContain(`import { gusset } from './gusset.feature.js';`);
  });

  it('holds a placeholder for a value left out before a later one, and appends a pick-less statement', async () => {
    const result = await applyFeatureEdit(PLATE, {
      feature: 'custom',
      filePath: MODEL,
      producers: [],
      parts: [],
      imports: [],
      custom: {
        id: 'acme.gusset', exportName: 'gusset', modulePath: '/ws/gusset.feature.js',
        shape: CustomFeatureStatement.shapeOf(GUSSET_META),
        values: { axis: { kind: 'picks', items: [{ kind: 'standard', name: 'x' }] } },
      },
    });
    expect(result.error).toBeUndefined();
    expect(result.newCode).toBe(src(
      `import { sketch, rect, extrude } from 'fluidcad/core'`,
      `import { gusset } from './gusset.feature.js';`,
      ``,
      `sketch('xy', () => { rect(40, 40) })`,
      `const e = extrude(10)`,
      `gusset(undefined, 'x')`,
    ));
  });

  it('refuses a spec its shape cannot write', async () => {
    const cases: [Partial<CustomFeatureOptions>, string][] = [
      [{ values: { depth: { kind: 'value', value: 1 } } }, `'depth' is not one of the feature's values`],
      [{ values: { face: { kind: 'keep' } } }, `the value of 'face'`],
      [{ values: { face: { kind: 'picks', items: [{ kind: 'part', part: 3 }] } } }, `the value of 'face'`],
      [{ values: { face: { kind: 'picks', items: [{ kind: 'verbatim', sourceIndex: 0 }] } } }, `the value of 'face'`],
      [{ values: {} }, 'every selector part belongs to one picked value'],
      [{ exportName: 'not a name' }, 'malformed custom feature spec'],
      [{ shape: { call: ['face', 'face'], operations: [], params: {} } }, `the feature's call shape is malformed`],
    ];
    for (const [custom, error] of cases) {
      const result = await applyFeatureEdit(PLATE, standoffSpec(custom));
      expect(result.error).toContain(error);
      expect(result.newCode).toBe(PLATE);
    }
    const twoFaces = standoffSpec({ values: { face: { kind: 'picks', items: [{ kind: 'part', part: 0 }, { kind: 'part', part: 1 }] } } });
    twoFaces.parts.push({ producer: 0, accessor: 'sideFaces', indices: null, filterArgs: null });
    expect((await applyFeatureEdit(PLATE, twoFaces)).error).toContain(`'face' takes one pick, got 2`);
  });
});

const PLACED = src(
  `import { sketch, rect, extrude } from 'fluidcad/core'`,
  `import { standoff as so } from './standoff.feature.js'`,
  ``,
  `sketch('xy', () => { rect(40, 40) })`,
  `const e = extrude(10)`,
  `const s = so(e.endFaces(), { height: 12, outer: 2 * r }).new().name('boss')`,
);

/** An edit of the standoff on line 6, keeping every value it doesn't set. */
function editSpec(custom: Partial<CustomFeatureOptions>, extra: Partial<ApplyFeatureEditSpec> = {}): ApplyFeatureEditSpec {
  return {
    feature: 'custom',
    filePath: MODEL,
    producers: [],
    parts: [],
    imports: [],
    edit: {
      line: 6,
      column: 10,
      custom: {
        id: 'acme.standoff',
        values: { face: { kind: 'keep' }, height: { kind: 'keep' }, outer: { kind: 'keep' }, hole: { kind: 'keep' } },
        ...custom,
      },
    },
    ...extra,
  };
}

describe('a call that goes straight to its options', () => {
  function gearSpec(values: CustomFeatureOptions['values'], picked = false): ApplyFeatureEditSpec {
    return {
      feature: 'custom',
      filePath: MODEL,
      producers: picked ? [{ line: 4, column: 10, featureType: 'extrude', nameHint: 'e', bind: true }] : [],
      parts: picked ? [{ producer: 0, accessor: 'endFaces', indices: null, filterArgs: null }] : [],
      imports: [],
      custom: {
        id: 'acme.gear', exportName: 'gear', modulePath: '/ws/gear.feature.js',
        shape: CustomFeatureStatement.shapeOf(GEAR_META),
        values,
      },
    };
  }

  const GEARED = (call: string) => src(
    `import { sketch, rect, extrude } from 'fluidcad/core'`,
    `import { gear } from './gear.feature.js'`,
    `sketch('xy', () => { rect(40, 40) })`,
    `const e = extrude(10)`,
    `const g = ${call}`,
  );

  function gearEdit(values: CustomFeatureOptions['values'], picked = false): ApplyFeatureEditSpec {
    return {
      feature: 'custom',
      filePath: MODEL,
      producers: picked ? [{ line: 4, column: 10, featureType: 'extrude', nameHint: 'e', bind: true }] : [],
      parts: picked ? [{ producer: 0, accessor: 'endFaces', indices: null, filterArgs: null }] : [],
      imports: [],
      edit: { line: 5, column: 11, custom: { id: 'acme.gear', values } },
    };
  }

  it('writes no placeholder for an optional pick left out ahead of the options', async () => {
    const some = await applyFeatureEdit(PLATE, gearSpec({ teeth: { kind: 'value', value: 30 } }));
    expect(some.error).toBeUndefined();
    expect(some.newCode).toContain(`gear({ teeth: 30 })`);
    expect(some.newCode).not.toContain('undefined');

    const none = await applyFeatureEdit(PLATE, gearSpec({}));
    expect(none.error).toBeUndefined();
    expect(none.newCode).toContain(`gear()`);

    const placed = await applyFeatureEdit(PLATE, gearSpec({
      at: { kind: 'picks', items: [{ kind: 'part', part: 0 }] },
      teeth: { kind: 'value', value: 30 },
    }, true));
    expect(placed.error).toBeUndefined();
    expect(placed.newCode).toContain(`gear(e.endFaces(), { teeth: 30 })`);
  });

  it('reads the short form back as editable, and the old placeholder form too', async () => {
    for (const call of [`gear({ teeth: 30 })`, `gear(undefined, { teeth: 30 })`, `gear(null, { teeth: 30 })`]) {
      const code = GEARED(call);
      const parsed = await parseFeatureStatement(code, 5, await catalog().calleesFor(code, MODEL));
      expect(parsed, call).toMatchObject({ ok: true, parsed: { id: 'acme.gear', values: { teeth: 30 }, picks: {} } });
    }
  });

  it('adds the pick in front of the options on an edit, and takes it out again', async () => {
    const short = GEARED(`gear({ teeth: 30, width: 4 })`);
    const picked = await applyFeatureEdit(short, gearEdit({
      at: { kind: 'picks', items: [{ kind: 'part', part: 0 }] }, teeth: { kind: 'keep' }, width: { kind: 'keep' },
    }, true), { callees: catalog() });
    expect(picked.error).toBeUndefined();
    expect(picked.newCode).toContain(`const g = gear(e.endFaces(), { teeth: 30, width: 4 })`);

    const cleared = await applyFeatureEdit(picked.newCode!, gearEdit({ teeth: { kind: 'keep' }, width: { kind: 'keep' } }), { callees: catalog() });
    expect(cleared.error).toBeUndefined();
    expect(cleared.newCode).toContain(`const g = gear({ teeth: 30, width: 4 })`);

    const old = GEARED(`gear(undefined, { teeth: 30 })`);
    const rewritten = await applyFeatureEdit(old, gearEdit({ teeth: { kind: 'value', value: 31 } }), { callees: catalog() });
    expect(rewritten.error).toBeUndefined();
    expect(rewritten.newCode).toContain(`const g = gear({ teeth: 31 })`);
  });
});

describe('reading a custom feature statement back', () => {
  it('reads the values, the picks as written and the operation by the call shape', async () => {
    const callees = await catalog().calleesFor(PLACED, MODEL);
    const result = await parseFeatureStatement(PLACED, 6, callees);
    expect(result.ok).toBe(true);
    if (result.ok !== true) {
      return;
    }
    expect(result.statement).toBe(`so(e.endFaces(), { height: 12, outer: 2 * r }).new()`);
    const start = PLACED.indexOf('e.endFaces(), {');
    expect(result.parsed).toMatchObject({
      feature: 'custom',
      id: 'acme.standoff',
      callee: 'so',
      values: { height: 12, outer: '2 * r' },
      picks: { face: [{ text: 'e.endFaces()', start, end: start + 'e.endFaces()'.length }] },
      operation: 'new',
      scopeTexts: [],
    });
  });

  it('seeds a statement pick with the row it names', async () => {
    const code = src(
      `import { sketch, rect } from 'fluidcad/core'`,
      `import { gusset } from './gusset.feature.js'`,
      `const s = sketch('xz', () => { rect(10, 10) })`,
      `gusset(s, undefined, { flip: true, style: 'round', tag: "a\\nb" }).remove().scope(s)`,
    );
    const parsed = await parseFeatureStatement(code, 4, await catalog().calleesFor(code, MODEL));
    expect(parsed).toMatchObject({
      ok: true,
      parsed: {
        values: { flip: true, style: 'round', tag: 'a\nb' },
        picks: { profile: [{ text: 's', ref: { line: 3, column: 10 } }] },
        operation: 'remove',
        scopeTexts: ['s'],
        scopeRefs: [{ line: 3, column: 10 }],
      },
    });
    expect(parsed.ok && parsed.parsed.feature === 'custom' && parsed.parsed.picks.axis).toBeUndefined();
  });

  it('refuses a statement its shape does not fit as not editable in the dialog', async () => {
    const cases: [string, string][] = [
      [`const s = so(e.endFaces(), opts)`, `argument 2 must be an object of options`],
      [`const s = so(e.endFaces(), { ...opts })`, 'the object of options holds `...opts`'],
      [`const s = so(e.endFaces(), { depth: 3 })`, `unknown option 'depth'`],
      [`const s = so(...args)`, 'spreads `...args`'],
      [`const s = so(e.endFaces(), { height: 'tall' })`, `'height' is not a plain number or expression`],
      [`const s = so(e.endFaces(), {}, 3)`, 'takes at most 2 arguments'],
    ];
    for (const [line, reason] of cases) {
      const code = PLACED.replace(/const s = .*\n/, `${line}\n`);
      const parsed = await parseFeatureStatement(code, 6, await catalog().calleesFor(code, MODEL));
      expect(parsed.ok).toBe(false);
      expect(parsed.ok === false && parsed.reason).toContain(reason);
      expect(parsed.ok === false && parsed.reason).toContain('not editable in the dialog');
    }
  });

  it('refuses an operation chain hidden behind a chain the dialog does not write', async () => {
    const code = PLACED.replace(`.new().name('boss')`, `.name('boss').new()`);
    const parsed = await parseFeatureStatement(code, 6, await catalog().calleesFor(code, MODEL));
    expect(parsed.ok === false && parsed.reason).toContain('a .new() chain follows other calls');
  });

  it('knows no custom feature without the catalog', async () => {
    const parsed = await parseFeatureStatement(PLACED, 6);
    expect(parsed.ok === false && parsed.reason).toBe('so() is not an editable feature statement');
  });
});

describe('editing a custom feature statement', () => {
  it('re-renders the values the dialog set and keeps the rest as written', async () => {
    const result = await applyFeatureEdit(PLACED, editSpec({
      values: { face: { kind: 'keep' }, height: { kind: 'value', value: 20 }, outer: { kind: 'keep' }, hole: { kind: 'value', value: 2.5 } },
    }), { callees: catalog() });
    expect(result.error).toBeUndefined();
    expect(result.newCode).toBe(PLACED.replace(
      `so(e.endFaces(), { height: 12, outer: 2 * r }).new()`,
      `so(e.endFaces(), { height: 20, outer: 2 * r, hole: 2.5 }).new()`,
    ));
  });

  it('drops a value the dialog left out, and changes the operation', async () => {
    const result = await applyFeatureEdit(PLACED, editSpec({
      values: { face: { kind: 'keep' }, height: { kind: 'keep' } },
      operation: 'add',
    }), { callees: catalog() });
    expect(result.error).toBeUndefined();
    expect(result.newCode).toContain(`const s = so(e.endFaces(), { height: 12 }).name('boss')\n`);
  });

  it('writes a re-picked face from the spec\'s parts', async () => {
    const result = await applyFeatureEdit(PLACED, editSpec(
      { values: { face: { kind: 'picks', items: [{ kind: 'part', part: 0 }] }, height: { kind: 'keep' } } },
      {
        producers: [{ line: 5, column: 10, featureType: 'extrude', nameHint: 'e', bind: true }],
        parts: [{ producer: 0, accessor: 'sideFaces', indices: [2], filterArgs: null }],
      },
    ), { callees: catalog() });
    expect(result.error).toBeUndefined();
    expect(result.newCode).toContain(`const s = so(e.sideFaces(2), { height: 12 }).new().name('boss')`);
  });

  it('keeps list elements by position and adds re-picked ones', async () => {
    const code = src(
      `import { sketch, rect, extrude } from 'fluidcad/core'`,
      `import { taper } from './lib/taper.feature.js'`,
      `sketch('xy', () => { rect(40, 40) })`,
      `const e = extrude(10)`,
      `taper(3, e.sideFaces(0), e.sideFaces(1))`,
    );
    const result = await applyFeatureEdit(code, {
      feature: 'custom',
      filePath: MODEL,
      producers: [{ line: 4, column: 10, featureType: 'extrude', nameHint: 'e', bind: true }],
      parts: [{ producer: 0, accessor: 'sideFaces', indices: [3], filterArgs: null }],
      imports: [],
      edit: {
        line: 5,
        column: 0,
        custom: {
          id: 'acme.taper',
          values: {
            angle: { kind: 'value', value: 4 },
            faces: { kind: 'picks', items: [{ kind: 'verbatim', sourceIndex: 1 }, { kind: 'part', part: 0 }] },
          },
        },
      },
    }, { callees: catalog() });
    expect(result.error).toBeUndefined();
    expect(result.newCode).toContain(`\ntaper(4, e.sideFaces(1), e.sideFaces(3))\n`);
  });

  it('refuses a statement of another feature, and one the catalog no longer reads', async () => {
    const other = await applyFeatureEdit(PLACED, editSpec({ id: 'acme.taper' }), { callees: catalog() });
    expect(other.error).toContain(`the statement builds 'acme.standoff', not 'acme.taper'`);

    const without = await applyFeatureEdit(PLACED, editSpec({}));
    expect(without.error).toContain('so() is not an editable feature statement');
  });
});

describe("a custom feature's default operation", () => {
  const BOLTED = src(
    `import { sketch, rect, extrude } from 'fluidcad/core'`,
    `import { boltCircle } from './bolt-circle.feature.js'`,
    `import { pocket } from './pocket.feature.js'`,
    `sketch('xy', () => { rect(40, 40) })`,
    `const e = extrude(10)`,
    `boltCircle('z', { count: 8 }).remove()`,
    `boltCircle('x', { count: 3 })`,
    `pocket({ depth: 4 }).new()`,
    `standoff(e.endFaces()).add()`,
  ).replace(`import { pocket }`, `import { standoff } from './standoff.feature.js'\nimport { pocket }`);

  /** A create of a bolt circle around the world Z axis. */
  function boltSpec(custom: Partial<CustomFeatureOptions> = {}, extra: Partial<ApplyFeatureEditSpec> = {}): ApplyFeatureEditSpec {
    return {
      feature: 'custom',
      filePath: MODEL,
      producers: [],
      parts: [],
      imports: [],
      custom: {
        id: 'acme.boltCircle', exportName: 'boltCircle', modulePath: '/ws/bolt-circle.feature.js',
        shape: CustomFeatureStatement.shapeOf(BOLT_CIRCLE_META),
        values: { around: { kind: 'picks', items: [{ kind: 'standard', name: 'z' }] }, count: { kind: 'value', value: 6 } },
        ...custom,
      },
      ...extra,
    };
  }

  /** An edit of the statement on `line` of BOLTED. */
  function edit(line: number, custom: CustomFeatureOptions, extra: Partial<ApplyFeatureEditSpec> = {}): ApplyFeatureEditSpec {
    return { feature: 'custom', filePath: MODEL, producers: [], parts: [], imports: [], edit: { line, column: 0, custom }, ...extra };
  }

  it('is written without a chain, whether the dialog names it or leaves it out', async () => {
    for (const operation of ['remove', undefined] as const) {
      const result = await applyFeatureEdit(PLATE, boltSpec(operation ? { operation } : {}));
      expect(result.error).toBeUndefined();
      expect(result.newCode).toContain(`\nboltCircle('z', { count: 6 })\n`);
    }
  });

  it('writes only the scope when the default operation names solids', async () => {
    const result = await applyFeatureEdit(PLATE, boltSpec(
      { operation: 'remove', scope: [{ kind: 'feature', producer: 0 }] },
      { producers: [{ line: 4, column: 10, featureType: 'extrude', nameHint: 'e', bind: true }] },
    ));
    expect(result.error).toBeUndefined();
    expect(result.newCode).toContain(`\nboltCircle('z', { count: 6 }).scope(e)\n`);
  });

  it('reads back from both spellings, and refuses an operation the feature does not offer', async () => {
    const callees = await catalog().calleesFor(BOLTED, MODEL);
    const explicit = await parseFeatureStatement(BOLTED, 7, callees);
    const implicit = await parseFeatureStatement(BOLTED, 8, callees);
    expect(explicit).toMatchObject({ ok: true, parsed: { id: 'acme.boltCircle', values: { count: 8 }, operation: 'remove', operationWritten: true } });
    expect(implicit).toMatchObject({ ok: true, parsed: { id: 'acme.boltCircle', values: { count: 3 }, operation: 'remove', operationWritten: false } });

    const added = BOLTED.replace(`boltCircle('x', { count: 3 })`, `boltCircle('x', { count: 3 }).add()`);
    const refused = await parseFeatureStatement(added, 8, await catalog().calleesFor(added, MODEL));
    expect(refused.ok === false && refused.reason).toContain(
      `boltCircle(): the statement uses .add(), which its dialog doesn't offer — it offers 'remove' — not editable in the dialog`,
    );
  });

  it('keeps the chains as written on an edit that leaves the operation alone', async () => {
    const count = (value: number) => ({ around: { kind: 'keep' as const }, count: { kind: 'value' as const, value } });
    const explicit = await applyFeatureEdit(BOLTED, edit(7, { id: 'acme.boltCircle', values: count(6) }), { callees: catalog() });
    expect(explicit.error).toBeUndefined();
    expect(explicit.newCode).toContain(`\nboltCircle('z', { count: 6 }).remove()\n`);

    // Naming the operation it already applies is no change either.
    const named = await applyFeatureEdit(BOLTED, edit(7, { id: 'acme.boltCircle', values: count(6), operation: 'remove' }), { callees: catalog() });
    expect(named.newCode).toContain(`\nboltCircle('z', { count: 6 }).remove()\n`);

    const implicit = await applyFeatureEdit(BOLTED, edit(8, { id: 'acme.boltCircle', values: count(5) }), { callees: catalog() });
    expect(implicit.error).toBeUndefined();
    expect(implicit.newCode).toContain(`\nboltCircle('x', { count: 5 })\n`);

    // A scope joins the operation the statement spelled out.
    const scoped = await applyFeatureEdit(BOLTED, edit(7, {
      id: 'acme.boltCircle', values: count(8), scope: [{ kind: 'feature', producer: 0 }],
    }, { producers: [{ line: 6, column: 6, featureType: 'extrude', nameHint: 'e', bind: true }] }), { callees: catalog() });
    expect(scoped.error).toBeUndefined();
    expect(scoped.newCode).toContain(`\nboltCircle('z', { count: 8 }).remove().scope(e)\n`);

    // The standoff adds by default: its spelled-out .add() stays too.
    const added = await applyFeatureEdit(BOLTED, edit(10, {
      id: 'acme.standoff', values: { face: { kind: 'keep' }, height: { kind: 'value', value: 7 } },
    }), { callees: catalog() });
    expect(added.error).toBeUndefined();
    expect(added.newCode).toContain(`\nstandoff(e.endFaces(), { height: 7 }).add()\n`);
  });

  it('drops the chain when an edit changes the operation to the default', async () => {
    const result = await applyFeatureEdit(BOLTED, edit(9, { id: 'acme.pocket', values: { depth: { kind: 'keep' } }, operation: 'remove' }), { callees: catalog() });
    expect(result.error).toBeUndefined();
    expect(result.newCode).toContain(`\npocket({ depth: 4 })\n`);

    const back = await applyFeatureEdit(result.newCode!, edit(9, { id: 'acme.pocket', values: { depth: { kind: 'keep' } }, operation: 'new' }), { callees: catalog() });
    expect(back.newCode).toContain(`\npocket({ depth: 4 }).new()\n`);
  });
});

describe('a typed-in type the table does not hold', () => {
  it('refuses to write a value of it, by name', async () => {
    const result = await applyFeatureEdit(PLATE, {
      feature: 'custom',
      filePath: MODEL,
      producers: [],
      parts: [],
      imports: [],
      custom: {
        id: 'acme.swatch',
        exportName: 'swatch',
        modulePath: '/ws/swatch.feature.js',
        shape: CustomFeatureStatement.shapeOf(SWATCH_META),
        values: { tint: { kind: 'literal', value: '#f00' } },
      },
    }, { callees: catalog() });
    expect(result.newCode).toBe(PLATE);
    expect(result.error).toContain(`'tint' is of the type 'colour', which this version of FluidCAD does not know`);
  });

  it('reads a statement that writes one as not editable, saying the type is unknown', async () => {
    const code = src(`import { swatch } from './swatch.feature.js'`, ``, `swatch({ tint: '#f00' })`);
    const callees = await catalog().calleesFor(code, MODEL);
    const parsed = await parseFeatureStatement(code, 3, callees);
    expect(parsed.ok).toBe(false);
    expect(parsed.ok === false && parsed.reason).toContain(`swatch()'s 'tint' is of the type 'colour', which this version of FluidCAD does not know`);
    expect(parsed.ok === false && parsed.reason).toContain('not editable in the dialog');
  });
});

describe('a radio value, and choices that differ only in how they are shown', () => {
  function clipSpec(meta: ScannedFeature['meta'], values: CustomFeatureOptions['values']): ApplyFeatureEditSpec {
    return {
      feature: 'custom',
      filePath: MODEL,
      producers: [],
      parts: [],
      imports: [],
      custom: { id: 'acme.clip', exportName: 'clip', modulePath: '/ws/clip.feature.js', shape: CustomFeatureStatement.shapeOf(meta), values },
    };
  }

  it('writes a radio as a select: a string as a literal, a number as one — whatever the presentation', async () => {
    const values: CustomFeatureOptions['values'] = {
      size: { kind: 'literal', value: 'm4' }, head: { kind: 'literal', value: 'counterbore' }, turns: { kind: 'value', value: 2 },
    };
    const shown = await applyFeatureEdit(PLATE, clipSpec(CLIP_META, values), { callees: catalog() });
    const bare = await applyFeatureEdit(PLATE, clipSpec(BARE_CLIP_META, values), { callees: catalog() });
    expect(shown.error).toBeUndefined();
    expect(shown.newCode).toContain(`clip({ size: 'm4', head: 'counterbore', turns: 2 })`);
    expect(bare.newCode).toBe(shown.newCode);
    // The shape a statement is written by carries no presentation at all.
    expect(CustomFeatureStatement.shapeOf(CLIP_META)).toEqual(CustomFeatureStatement.shapeOf(BARE_CLIP_META));
  });

  it("reads no option's 'when': a value its 'when' does not offer is written, checked against every declared option", async () => {
    // CLIP_META offers 'm4' while the head is plain only; the dialog narrows, the statement owes it nothing.
    const select = TypedInKinds.of('select')!;
    const [shown, bare] = [CLIP_META, BARE_CLIP_META].map(meta => (meta.params as Record<string, TypedInSpec>).size);
    expect(SHOWN_SCREW_OPTIONS[1].when).toEqual({ head: 'plain' });
    expect(select.source(shown, 'm4')).toEqual({ kind: 'literal', value: 'm4' });
    expect(select.source(shown, 'm4')).toEqual(select.source(bare, 'm4'));
    expect(select.source(shown, 'm9')).toEqual(select.source(bare, 'm9'));
    const values: CustomFeatureOptions['values'] = { size: { kind: 'literal', value: 'm4' }, head: { kind: 'literal', value: 'counterbore' } };
    const written = await applyFeatureEdit(PLATE, clipSpec(CLIP_META, values), { callees: catalog() });
    expect(written.error).toBeUndefined();
    expect(written.newCode).toContain(`clip({ size: 'm4', head: 'counterbore' })`);
    expect((await applyFeatureEdit(PLATE, clipSpec(BARE_CLIP_META, values), { callees: catalog() })).newCode).toBe(written.newCode);
  });

  it('reads a radio back, edits it keeping the rest, and refuses one that is no plain literal', async () => {
    const code = src(`import { clip } from './clip.feature.js'`, ``, `clip({ size: 'm4', head: 'counterbore', turns: 2 })`);
    const callees = await catalog().calleesFor(code, MODEL);
    const parsed = await parseFeatureStatement(code, 3, callees);
    expect(parsed.ok && parsed.parsed).toMatchObject({ feature: 'custom', id: 'acme.clip', values: { size: 'm4', head: 'counterbore', turns: 2 } });

    const edited = await applyFeatureEdit(code, {
      feature: 'custom', filePath: MODEL, producers: [], parts: [], imports: [],
      edit: { line: 3, column: 0, custom: { id: 'acme.clip', values: { size: { kind: 'keep' }, head: { kind: 'literal', value: 'plain' }, turns: { kind: 'keep' } } } },
    }, { callees: catalog() });
    expect(edited.error).toBeUndefined();
    expect(edited.newCode).toContain(`clip({ size: 'm4', head: 'plain', turns: 2 })`);

    const computed = src(`import { clip } from './clip.feature.js'`, ``, `clip({ head: pick() })`);
    const refused = await parseFeatureStatement(computed, 3, await catalog().calleesFor(computed, MODEL));
    expect(refused.ok === false && refused.reason).toContain(`clip()'s 'head' is not a plain string or number`);
  });
});

describe('rows that differ only in how they look: slider, stepper, suffix, checkbox, hint, placeholder, multiline', () => {
  function dialSpec(meta: ScannedFeature['meta'], values: CustomFeatureOptions['values']): ApplyFeatureEditSpec {
    return {
      feature: 'custom',
      filePath: MODEL,
      producers: [],
      parts: [],
      imports: [],
      custom: { id: 'acme.dial', exportName: 'dial', modulePath: '/ws/dial.feature.js', shape: CustomFeatureStatement.shapeOf(meta), values },
    };
  }

  it('writes byte-identical statements from two declarations that differ only in presentation', async () => {
    const values: CustomFeatureOptions['values'] = {
      depth: { kind: 'value', value: 12 }, count: { kind: 'value', value: 3 }, flush: { kind: 'literal', value: true }, note: { kind: 'literal', value: 'A2-70' },
    };
    const shown = await applyFeatureEdit(PLATE, dialSpec(DIAL_META, values), { callees: catalog() });
    const bare = await applyFeatureEdit(PLATE, dialSpec(BARE_DIAL_META, values), { callees: catalog() });
    expect(shown.error).toBeUndefined();
    expect(shown.newCode).toContain(`dial({ depth: 12, count: 3, flush: true, note: 'A2-70' })`);
    expect(bare.newCode).toBe(shown.newCode);
    expect(CustomFeatureStatement.shapeOf(DIAL_META)).toEqual(CustomFeatureStatement.shapeOf(BARE_DIAL_META));
    // A value's check reads no presentation either: the same verdicts from both declarations.
    for (const [name, raw] of [['depth', 12], ['depth', 51], ['depth', 'gap * 2'], ['count', 2.5], ['flush', true], ['note', 'A2-70'], ['note', 'no!']] as const) {
      const [a, b] = [DIAL_META, BARE_DIAL_META].map(meta => {
        const spec = (meta.params as Record<string, TypedInSpec>)[name];
        return TypedInKinds.of(spec.type)!.source(spec, raw);
      });
      expect(a).toEqual(b);
    }
  });

  it("holds a text to its declaration's maxLength and pattern, inside the flat limit", () => {
    const text = TypedInKinds.of('text')!;
    const spec = { label: 'Note', type: 'text', maxLength: 12, pattern: '[A-Za-z0-9-]*' };
    expect(text.source(spec, 'A2-70')).toEqual({ kind: 'literal', value: 'A2-70' });
    expect(text.source(spec, '')).toEqual({ kind: 'literal', value: '' });
    expect(text.source(spec, 'A2-70-A2-70-A2')).toBe('Note must be at most 12 characters');
    expect(text.source(spec, 'A2 70')).toBe('Note must match [A-Za-z0-9-]*');
    // The whole value is matched, not a part of it.
    expect(text.source({ label: 'Note', type: 'text', pattern: 'A' }, 'AA')).toBe('Note must match A');
    expect(text.source({ label: 'Note', type: 'text' }, 'x'.repeat(2000))).toEqual({ kind: 'literal', value: 'x'.repeat(2000) });
    expect(text.source({ label: 'Note', type: 'text', maxLength: 5000 }, 'x'.repeat(2001))).toBe('Note must be a string');
    expect(text.source(spec, 7)).toBe('Note must be a string');
  });

  it('writes a text of several lines as one single-quoted literal and reads it back', async () => {
    expect(TypedInKinds.quote(`it's\na "b"\\`)).toBe(`'it\\'s\\na "b"\\\\'`);
    const written = await applyFeatureEdit(PLATE, dialSpec(DIAL_META, { note: { kind: 'literal', value: 'A2\n70' } }), { callees: catalog() });
    expect(written.error).toBeUndefined();
    expect(written.newCode).toContain(`dial({ note: 'A2\\n70' })`);
    const line = written.newCode.split('\n').findIndex(text => text.includes('dial({')) + 1;
    const parsed = await parseFeatureStatement(written.newCode, line, await catalog().calleesFor(written.newCode, MODEL));
    expect(parsed.ok && parsed.parsed).toMatchObject({ feature: 'custom', id: 'acme.dial', values: { note: 'A2\n70' } });
  });
});

describe('a multi-select: a list of option values, written as one array literal', () => {
  const FINISHES = { label: 'Finishes', type: 'select', multiple: true, min: 1, max: 2, options: [{ value: 'deburr' }, { value: 'chamfer' }, { value: 2 }] };

  function rimSpec(meta: ScannedFeature['meta'], values: CustomFeatureOptions['values']): ApplyFeatureEditSpec {
    return {
      feature: 'custom',
      filePath: MODEL,
      producers: [],
      parts: [],
      imports: [],
      custom: { id: 'acme.rim', exportName: 'rim', modulePath: '/ws/rim.feature.js', shape: CustomFeatureStatement.shapeOf(meta), values },
    };
  }

  async function rimAt(code: string) {
    return parseFeatureStatement(code, 3, await catalog().calleesFor(code, MODEL));
  }

  it('is the list kind of the one table: checked against its options and counts, and never a single select', () => {
    const list = TypedInKinds.of('select', true)!;
    expect(list).not.toBe(TypedInKinds.of('select'));
    expect(TypedInKinds.of('radio', true)).toBe(TypedInKinds.of('radio'));
    expect(list.source(FINISHES, ['chamfer', 2])).toEqual({ kind: 'list', values: ['chamfer', 2] });
    expect(list.source({ ...FINISHES, min: 0 }, [])).toEqual({ kind: 'list', values: [] });
    expect(list.source(FINISHES, 'deburr')).toBe('Finishes must be a list of "deburr", "chamfer", 2');
    expect(list.source(FINISHES, ['polish'])).toBe('Finishes must be a list of "deburr", "chamfer", 2');
    expect(list.source(FINISHES, ['deburr', 'deburr'])).toBe('Finishes lists "deburr" twice');
    expect(list.source(FINISHES, [])).toBe('Finishes takes at least 1');
    expect(list.source(FINISHES, ['deburr', 'chamfer', 2])).toBe('Finishes takes at most 2');
    // A preview takes any list of strings and numbers; the options and counts are the kernel's to check.
    expect(list.preview(FINISHES, ['polish'])).toBeNull();
    expect(list.preview(FINISHES, [])).toBeNull();
    expect(list.preview(FINISHES, 'deburr')).toBe('Finishes must be a list of its options');
    expect(list.preview(FINISHES, [true])).toBe('Finishes must be a list of its options');
  });

  it('keeps its brackets around one element and around none', () => {
    expect(TypedInKinds.text({ kind: 'list', values: ['deburr', 'polish'] })).toBe(`['deburr', 'polish']`);
    expect(TypedInKinds.text({ kind: 'list', values: ['deburr'] })).toBe(`['deburr']`);
    expect(TypedInKinds.text({ kind: 'list', values: [] })).toBe(`[]`);
    expect(TypedInKinds.text({ kind: 'list', values: [2, `it's`] })).toBe(`[2, 'it\\'s']`);
  });

  it.each([
    [['deburr', 'polish'], `['deburr', 'polish']`],
    [['deburr'], `['deburr']`],
    [[], `[]`],
  ])('writes %j as %s and reads it back, whatever the presentation', async (values, text) => {
    const sources: CustomFeatureOptions['values'] = { coats: { kind: 'list', values: [2] }, finishes: { kind: 'list', values } };
    const shown = await applyFeatureEdit(PLATE, rimSpec(RIM_META, sources), { callees: catalog() });
    const bare = await applyFeatureEdit(PLATE, rimSpec(BARE_RIM_META, sources), { callees: catalog() });
    expect(shown.error).toBeUndefined();
    expect(shown.newCode).toContain(`rim([2], ${text})`);
    expect(bare.newCode).toBe(shown.newCode);
    expect(CustomFeatureStatement.shapeOf(RIM_META)).toEqual(CustomFeatureStatement.shapeOf(BARE_RIM_META));

    const line = shown.newCode.split('\n').findIndex(row => row.includes('rim(')) + 1;
    const parsed = await parseFeatureStatement(shown.newCode, line, await catalog().calleesFor(shown.newCode, MODEL));
    expect(parsed.ok && parsed.parsed).toMatchObject({ feature: 'custom', id: 'acme.rim', values: { coats: [2], finishes: values } });
  });

  it('writes the default list where a list is left out before a later argument', async () => {
    const written = await applyFeatureEdit(PLATE, rimSpec(RIM_META, { depth: { kind: 'value', value: 4 } }), { callees: catalog() });
    expect(written.error).toBeUndefined();
    expect(written.newCode).toContain(`rim([], ['deburr'], 4)`);
  });

  it('edits the list alone, and writes an emptied one as [] rather than dropping it', async () => {
    const code = src(`import { rim } from './rim.feature.js'`, ``, `rim(['prime'], ['deburr', 'polish'], 4)`);
    const edit = (finishes: (string | number)[]) => applyFeatureEdit(code, {
      feature: 'custom', filePath: MODEL, producers: [], parts: [], imports: [],
      edit: { line: 3, column: 0, custom: { id: 'acme.rim', values: { coats: { kind: 'keep' }, finishes: { kind: 'list', values: finishes }, depth: { kind: 'keep' } } } },
    }, { callees: catalog() });
    const changed = await edit(['chamfer']);
    expect(changed.error).toBeUndefined();
    expect(changed.newCode).toContain(`rim(['prime'], ['chamfer'], 4)`);
    expect((await edit([])).newCode).toContain(`rim(['prime'], [], 4)`);
  });

  it('refuses a statement whose list is no plain list of strings and numbers, by message', async () => {
    for (const coats of [`[...base]`, `base()`, `['prime', two]`, `'prime'`, `[['prime']]`]) {
      const refused = await rimAt(src(`import { rim } from './rim.feature.js'`, ``, `rim(${coats}, ['deburr'], 4)`));
      expect(refused.ok === false && refused.reason).toContain(`rim()'s 'coats' is not a plain list of strings or numbers`);
    }
    const read = await rimAt(src(`import { rim } from './rim.feature.js'`, ``, `rim(["prime", 2], [], 4)`));
    expect(read.ok && read.parsed).toMatchObject({ values: { coats: ['prime', 2], finishes: [], depth: 4 } });
    // A bare name is a reference to a list-valued variable, not a malformed list.
    const bound = await rimAt(src(`import { rim } from './rim.feature.js'`, ``, `rim(base, ['deburr'], 4)`));
    expect(bound.ok && bound.parsed).toMatchObject({ values: { coats: { ref: 'base' }, finishes: ['deburr'], depth: 4 } });
  });
});

// A select (or a radio, the same kind) may hold a reference to a variable
// in place of one of its options — `{ ref: 'holeSize' }` on the wire, the
// name written bare in the statement the way a number row writes an
// expression, and read back as the reference. Only a name or a dotted
// member path is a reference; a text takes none.
describe('a choice bound to a variable', () => {
  const select = TypedInKinds.of('select')!;
  const list = TypedInKinds.of('select', true)!;
  const SCREW = (CLIP_META.params as Record<string, TypedInSpec>).size;
  const FINISHES = { label: 'Finishes', type: 'select', multiple: true, min: 1, max: 2, options: [{ value: 'deburr' }, { value: 'chamfer' }] };

  function clipSpec(values: CustomFeatureOptions['values']): ApplyFeatureEditSpec {
    return {
      feature: 'custom', filePath: MODEL, producers: [], parts: [], imports: [],
      custom: { id: 'acme.clip', exportName: 'clip', modulePath: '/ws/clip.feature.js', shape: CustomFeatureStatement.shapeOf(CLIP_META), values },
    };
  }

  async function clipAt(statement: string) {
    const code = src(`import { clip } from './clip.feature.js'`, ``, statement);
    return parseFeatureStatement(code, 3, await catalog().calleesFor(code, MODEL));
  }

  it('writes a reference bare, as the number rows write an expression', async () => {
    expect(select.source(SCREW, { ref: 'holeSize' })).toEqual({ kind: 'value', value: 'holeSize' });
    expect(select.source(SCREW, { ref: 'inst.properties.kind' })).toEqual({ kind: 'value', value: 'inst.properties.kind' });
    expect(select.source(SCREW, { ref: '$_ok.a1' })).toEqual({ kind: 'value', value: '$_ok.a1' });
    expect(TypedInKinds.text({ kind: 'value', value: 'holeSize' })).toBe('holeSize');

    const written = await applyFeatureEdit(PLATE, clipSpec({ size: { kind: 'value', value: 'holeSize' }, head: { kind: 'literal', value: 'plain' } }), { callees: catalog() });
    expect(written.error).toBeUndefined();
    expect(written.newCode).toContain(`clip({ size: holeSize, head: 'plain' })`);
  });

  it('refuses a malformed reference by name, and lets a non-reference fall through to the options', () => {
    for (const ref of ['', ' holeSize', 'hole size', 'a + b', 'size()', 'a[0]', 'a.', '.a', '1st', 'a?.b', 'a..b', "'m4'"]) {
      expect(select.source(SCREW, { ref }), ref).toBe('Screw must name a variable');
      expect(select.preview(SCREW, { ref }), ref).toBe('Screw must name a variable');
      expect(list.source(FINISHES, { ref }), ref).toBe('Finishes must name a variable');
      expect(list.preview(FINISHES, { ref }), ref).toBe('Finishes must name a variable');
    }
    expect(select.preview(SCREW, { ref: 'holeSize' })).toBeNull();
    expect(list.preview(FINISHES, { ref: 'coats' })).toBeNull();
    // Not a reference's shape at all: checked as an option, as before.
    expect(select.source(SCREW, { ref: 3 })).toBe('Screw must be one of "m3", "m4"');
    expect(select.source(SCREW, { name: 'holeSize' })).toBe('Screw must be one of "m3", "m4"');
    expect(select.preview(SCREW, { ref: 3 })).toBe('Screw must be one of its options');
    expect(TypedInKinds.isRef({ ref: 'x' })).toBe(true);
    expect(TypedInKinds.isRef({ ref: 3 })).toBe(false);
    expect(TypedInKinds.isRef(['x'])).toBe(false);
    expect(TypedInKinds.refText({ ref: 'a.b' })).toBe('a.b');
    expect(TypedInKinds.refText({ ref: 'a-b' })).toBeNull();
  });

  it('refuses a reference on a text, which stays a literal, and on a boolean', () => {
    const text = TypedInKinds.of('text')!;
    const NOTE = { label: 'Note', type: 'text' };
    expect(text.source(NOTE, { ref: 'label' })).toBe('Note is text, which takes no variable');
    expect(text.preview(NOTE, { ref: 'label' })).toBe('Note is text, which takes no variable');
    expect(text.source(NOTE, 'label')).toEqual({ kind: 'literal', value: 'label' });
    const flag = TypedInKinds.of('boolean')!;
    expect(flag.source({ label: 'Flush', type: 'boolean' }, { ref: 'flush' })).toBe('Flush must be true or false');
  });

  it('reads a bare name or a dotted path back as the reference, and nothing else', async () => {
    const named = await clipAt(`clip({ size: holeSize, head: 'plain' })`);
    expect(named.ok && named.parsed).toMatchObject({ feature: 'custom', values: { size: { ref: 'holeSize' }, head: 'plain' } });
    const path = await clipAt(`clip({ size: inst.properties.kind, head: 'plain' })`);
    expect(path.ok && path.parsed).toMatchObject({ values: { size: { ref: 'inst.properties.kind' } } });
    // A radio is the same kind: a bound radio statement is editable too.
    const radio = await clipAt(`clip({ size: 'm4', head: headKind })`);
    expect(radio.ok && radio.parsed).toMatchObject({ values: { size: 'm4', head: { ref: 'headKind' } } });

    for (const head of [`pick()`, `this.x`, `kinds[0]`, `inst?.properties.kind`, `a.b()`, `(holeSize)`, `\`m4\``, `inst.properties.kind + ''`]) {
      const refused = await clipAt(`clip({ size: 'm4', head: ${head} })`);
      expect(refused.ok === false && refused.reason, head).toContain(`clip()'s 'head' is not a plain string or number`);
    }
  });

  it('edits around a reference, and binds and unbinds one', async () => {
    const code = src(`import { clip } from './clip.feature.js'`, ``, `clip({ size: holeSize, head: 'plain' })`);
    const edit = (values: CustomFeatureOptions['values']) => applyFeatureEdit(code, {
      feature: 'custom', filePath: MODEL, producers: [], parts: [], imports: [],
      edit: { line: 3, column: 0, custom: { id: 'acme.clip', values } },
    }, { callees: catalog() });
    const kept = await edit({ size: { kind: 'keep' }, head: { kind: 'literal', value: 'counterbore' } });
    expect(kept.error).toBeUndefined();
    expect(kept.newCode).toContain(`clip({ size: holeSize, head: 'counterbore' })`);
    const unbound = await edit({ size: { kind: 'literal', value: 'm3' }, head: { kind: 'keep' } });
    expect(unbound.newCode).toContain(`clip({ size: 'm3', head: 'plain' })`);
    const rebound = await edit({ size: { kind: 'value', value: 'inst.properties.kind' }, head: { kind: 'value', value: 'headKind' } });
    expect(rebound.newCode).toContain(`clip({ size: inst.properties.kind, head: headKind })`);
  });

  it('binds a multi-select to a list-valued variable, written bare and read back', async () => {
    expect(list.source(FINISHES, { ref: 'coats' })).toEqual({ kind: 'value', value: 'coats' });
    expect(list.source(FINISHES, { ref: 'inst.properties.coats' })).toEqual({ kind: 'value', value: 'inst.properties.coats' });
    const written = await applyFeatureEdit(PLATE, {
      feature: 'custom', filePath: MODEL, producers: [], parts: [], imports: [],
      custom: {
        id: 'acme.rim', exportName: 'rim', modulePath: '/ws/rim.feature.js', shape: CustomFeatureStatement.shapeOf(RIM_META),
        values: { coats: { kind: 'value', value: 'chosen' }, finishes: { kind: 'list', values: ['deburr'] } },
      },
    }, { callees: catalog() });
    expect(written.error).toBeUndefined();
    expect(written.newCode).toContain(`rim(chosen, ['deburr'])`);
    const line = written.newCode.split('\n').findIndex(row => row.includes('rim(')) + 1;
    const parsed = await parseFeatureStatement(written.newCode, line, await catalog().calleesFor(written.newCode, MODEL));
    expect(parsed.ok && parsed.parsed).toMatchObject({ values: { coats: { ref: 'chosen' }, finishes: ['deburr'] } });
  });
});
