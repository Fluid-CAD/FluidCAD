import { describe, it, expect } from "vitest";
import { FeatureDocs, snapshotFeatureMeta } from "../../index.js";
import { Feature, type FeatureMeta } from "../../sdk/index.js";
import type { Shape } from "../../sdk/kernel.js";
import { FeatureMetas } from "../../sdk/meta.js";

/** A tool feature class with the given id: it leaves build() to the base. */
function toolClass(id = 'standoff') {
  return class extends Feature {
    static id = id;
    buildTool(): Shape[] {
      return [];
    }
  };
}

/** A standoff's metadata; `params` and the rest patched per test. */
function standoffMeta(patch: Record<string, unknown> = {}): FeatureMeta {
  return {
    class: toolClass(),
    label: 'Standoff',
    description: 'A boss with a bore through it, standing on a planar face',
    group: 'create',
    kind: 'tool',
    params: {
      face: { picker: 'face', label: 'On face', surface: 'planar', description: 'The planar face the standoff stands on, at its centre.' },
      height: { type: 'length', default: 10, min: 0 },
      outer: { type: 'length', default: 6, min: 0, label: 'Boss diameter', description: 'Boss diameter' },
      holeDiameter: { type: 'length', default: 3, min: 0, description: '  hole-DIAMETER! ' },
    },
    call: ['face', { height: 'height', outer: 'outer', holeDiameter: 'holeDiameter' }],
    ...patch,
  } as FeatureMeta;
}

describe('FeatureDocs.isDocumented', () => {
  it('takes a description that says something', () => {
    expect(FeatureDocs.isDocumented('How tall the boss stands above the face.', 'Height', 'height')).toBe(true);
    expect(FeatureDocs.reasonOf('How tall the boss stands above the face.', 'Height', 'height')).toBeNull();
  });

  it('refuses a missing, empty or blank one', () => {
    for (const text of [undefined, null, '', '   \n\t ']) {
      expect(FeatureDocs.reasonOf(text, 'Height', 'height')).toBe('missing');
      expect(FeatureDocs.isDocumented(text, 'Height', 'height')).toBe(false);
    }
  });

  it('refuses one that repeats the label', () => {
    expect(FeatureDocs.reasonOf('Boss diameter', 'Boss diameter', 'outer')).toBe('repeats-label');
    expect(FeatureDocs.reasonOf('boss diameter.', 'Boss diameter', 'outer')).toBe('repeats-label');
  });

  it('refuses one that repeats the name made readable, in another case and with other punctuation', () => {
    expect(FeatureDocs.reasonOf('Hole diameter', 'Bore', 'holeDiameter')).toBe('repeats-label');
    expect(FeatureDocs.reasonOf('  hole-DIAMETER! ', 'Bore', 'holeDiameter')).toBe('repeats-label');
    expect(FeatureDocs.reasonOf('hole_diameter', 'Bore', 'holeDiameter')).toBe('repeats-label');
    // Saying more than the name is documentation.
    expect(FeatureDocs.reasonOf('Hole diameter, through the whole boss', 'Bore', 'holeDiameter')).toBeNull();
  });

  it('takes 1,000 characters and refuses 1,001, counted once trimmed', () => {
    expect(FeatureDocs.reasonOf('a'.repeat(1000), 'Height', 'height')).toBeNull();
    expect(FeatureDocs.reasonOf(`  ${'a'.repeat(1000)}  `, 'Height', 'height')).toBeNull();
    expect(FeatureDocs.reasonOf('a'.repeat(1001), 'Height', 'height')).toBe('too-long');
  });
});

describe('FeatureDocs.missing', () => {
  it('lists the feature, then each value in declaration order, with why', () => {
    const gaps = FeatureDocs.missing(standoffMeta({ description: '  ' }));
    expect(gaps).toEqual([
      { kind: 'feature', owner: 'standoff', name: 'standoff', label: 'Standoff', reason: 'missing' },
      { kind: 'value', owner: 'standoff', name: 'height', label: 'Height', reason: 'missing' },
      { kind: 'value', owner: 'standoff', name: 'outer', label: 'Boss diameter', reason: 'repeats-label' },
      { kind: 'value', owner: 'standoff', name: 'holeDiameter', label: 'Hole diameter', reason: 'repeats-label' },
    ]);
  });

  it('lists nothing for a documented feature, and takes another owner', () => {
    const documented = standoffMeta({
      params: {
        face: { picker: 'face', description: 'The planar face to stand on.' },
        height: { type: 'length', default: 10, description: 'How tall the boss stands above the face.' },
      },
      call: ['face', { height: 'height' }],
    });
    expect(FeatureDocs.missing(documented)).toEqual([]);
    expect(FeatureDocs.missing(standoffMeta(), 'post')[0]).toMatchObject({ owner: 'post', name: 'height' });
  });

  it('never asks a choice\'s options for a description: only the value itself', () => {
    const meta = standoffMeta({
      params: {
        size: {
          type: 'select', default: 'm3', description: 'The screw the hole clears.',
          options: [{ label: 'M3', value: 'm3' }, { label: 'M4', value: 'm4' }],
        },
        head: { type: 'radio', options: [{ label: 'Plain', value: 'plain' }] },
      },
      call: [{ size: 'size', head: 'head' }],
    });
    expect(FeatureDocs.missing(meta).map((g) => g.name)).toEqual(['head']);
  });

  it('gives the same answer for the metadata, the resolved metadata and the snapshot', () => {
    const meta = standoffMeta({ description: 'Standoff' });
    const resolved = FeatureMetas.resolve(meta);
    const snapshot = snapshotFeatureMeta(resolved);
    const fromMeta = FeatureDocs.missing(meta);
    expect(fromMeta.map((g) => g.name)).toEqual(['standoff', 'height', 'outer', 'holeDiameter']);
    expect(FeatureDocs.missing(resolved)).toEqual(fromMeta);
    expect(FeatureDocs.missing(snapshot)).toEqual(fromMeta);
    expect(FeatureDocs.missing(JSON.parse(JSON.stringify(snapshot)))).toEqual(fromMeta);
  });
});

describe('FeatureDocs.missingParams', () => {
  it('lists a part\'s parameters without a useful description, in order', () => {
    const params = [
      { label: 'numberOfHoles', description: 'How many bolt holes ring the second hub.' },
      { label: 'spacing' },
      { label: 'Length', description: 'length' },
      { label: 'Width', description: '' },
    ];
    expect(FeatureDocs.missingParams(params, 'plateStack')).toEqual([
      { kind: 'param', owner: 'plateStack', name: 'spacing', label: 'spacing', reason: 'missing' },
      { kind: 'param', owner: 'plateStack', name: 'Length', label: 'Length', reason: 'repeats-label' },
      { kind: 'param', owner: 'plateStack', name: 'Width', label: 'Width', reason: 'missing' },
    ]);
    expect(FeatureDocs.missingParams([], 'plateStack')).toEqual([]);
  });
});

describe('FeatureDocs.describe', () => {
  it('words one warning for a module, grouped by owner', () => {
    const gaps = [
      ...FeatureDocs.missing(standoffMeta({ description: '' })),
      ...FeatureDocs.missingParams([{ label: 'spacing' }, { label: 'notes', description: 'x'.repeat(1001) }], 'plateStack'),
    ];
    expect(FeatureDocs.describe(gaps, 'features/standoff.feature.js')).toBe(
      'features/standoff.feature.js: 6 fields without a description — ' +
        'standoff: the feature itself, height, outer (repeats its label), holeDiameter (repeats its label); ' +
        'plateStack: spacing, notes (over 1,000 characters). Give each a `description`.',
    );
    expect(FeatureDocs.describe(gaps.slice(1, 2), 'x.js')).toMatch(/^x\.js: 1 field without a description — standoff: height\. Give it a `description`\.$/);
    expect(FeatureDocs.describe([], 'x.js')).toBe('');
  });
});
