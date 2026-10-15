import { describe, it, expect } from 'vitest';
import {
  applyFeatureEdit,
  parseFeatureStatement,
  type ApplyFeatureEditSpec,
} from '../src/apply-feature-edit/index.ts';

// split() statements: the create rendering and placement for each cut
// kind, the seed line's staged sketch export, the parse round-trip, and
// in-place edits of the options object, the cut and the targets.

const FILE = '/ws/model.fluid.js';

const base = [
  `import { sketch, ellipse, extrude, cut } from 'fluidcad/core'`,
  ``,
  `sketch('xy', () => { ellipse(100, 50) })`,
  `extrude(30)`,
  `sketch('xy', () => { ellipse(10, 10) })`,
  `cut(5)`,
].join('\n');

function splitSpec(
  split: NonNullable<ApplyFeatureEditSpec['split']>,
  overrides: Partial<ApplyFeatureEditSpec> = {},
): ApplyFeatureEditSpec {
  return {
    feature: 'split',
    split,
    filePath: FILE,
    producers: [{ line: 4, column: 0, featureType: 'feature', nameHint: 'f', bind: true }],
    parts: [],
    imports: [],
    ...overrides,
  };
}

describe('split statement templates', () => {
  it('binds two bare targets and appends a split at a standard plane with its options', async () => {
    const result = await applyFeatureEdit(`${base}\n`, splitSpec({
      plane: { kind: 'standard', plane: 'yz' },
      keep: 'front',
      offset: 5,
      targets: [{ producer: 0 }, { producer: 1 }],
    }, {
      producers: [
        { line: 4, column: 0, featureType: 'feature', nameHint: 'f', bind: true },
        { line: 6, column: 0, featureType: 'feature', nameHint: 'f', bind: true },
      ],
    }));
    expect(result.error).toBeUndefined();
    expect(result.newCode).toBe([
      `import { split, sketch, ellipse, extrude, cut } from 'fluidcad/core'`,
      ``,
      `sketch('xy', () => { ellipse(100, 50) })`,
      `const f = extrude(30)`,
      `sketch('xy', () => { ellipse(10, 10) })`,
      `const f2 = cut(5)`,
      `split('yz', { keep: 'front', offset: 5 }, f, f2)`,
      ``,
    ].join('\n'));
  });

  it('appends an implicit split of every solid at the end of the file', async () => {
    const result = await applyFeatureEdit(`${base}\n`, splitSpec({
      plane: { kind: 'standard', plane: 'xz' },
      keep: 'both',
      offset: null,
      targets: [],
    }, { producers: [] }));
    expect(result.error).toBeUndefined();
    expect(result.newCode.endsWith(`cut(5)\nsplit('xz')\n`)).toBe(true);
    expect(result.newCode).toContain(`import { split, sketch`);
  });

  describe('with an active part', () => {
    // A split of every solid cuts the solids built before it in its scope.
    // part() is lazy — a top-level statement after the part builds before
    // it — so with nothing pinning a scope the split lands at the end of
    // the timeline's active part, the home of the other unpinned creates.
    const partCode = [
      `import { sketch, ellipse, extrude, part, plane } from 'fluidcad/core'`,
      ``,
      `const p = plane('yz', 40)`,
      `part('Body', () => {`,
      `  sketch('xy', () => { ellipse(100, 50) })`,
      `  extrude(30)`,
      `})`,
      ``,
    ].join('\n');
    const activePart = { line: 4, column: 0 };

    it('appends a standard-plane split of every solid inside the active part', async () => {
      const result = await applyFeatureEdit(partCode, splitSpec({
        plane: { kind: 'standard', plane: 'xz' },
        keep: 'both',
        offset: null,
        targets: [],
      }, { producers: [], activePart }));
      expect(result.error).toBeUndefined();
      expect(result.newCode.endsWith(`  extrude(30)\n  split('xz')\n})\n`)).toBe(true);
    });

    it('appends a plane-feature split of every solid inside the active part', async () => {
      const result = await applyFeatureEdit(partCode, splitSpec({
        plane: { kind: 'plane', producer: 0 },
        keep: 'front',
        offset: null,
        targets: [],
      }, {
        producers: [{ line: 3, column: 10, featureType: 'plane', nameHint: 'p', bind: true }],
        activePart,
      }));
      expect(result.error).toBeUndefined();
      expect(result.newCode.endsWith(`  extrude(30)\n  split(p, { keep: 'front' })\n})\n`)).toBe(true);
    });

    it('keeps a split with a target beside that target inside the part', async () => {
      const result = await applyFeatureEdit(partCode, splitSpec({
        plane: { kind: 'standard', plane: 'xz' },
        keep: 'both',
        offset: null,
        targets: [{ producer: 0 }],
      }, {
        producers: [{ line: 6, column: 2, featureType: 'feature', nameHint: 'f', bind: true }],
        activePart,
      }));
      expect(result.error).toBeUndefined();
      expect(result.newCode).toContain(`  const f = extrude(30)\n  split('xz', f)\n})\n`);
    });
  });

  it('renders an existing plane feature as its bound variable', async () => {
    const code = [
      `import { sketch, ellipse, extrude, plane } from 'fluidcad/core'`,
      ``,
      `const p = plane('yz', 40)`,
      `sketch('xy', () => { ellipse(100, 50) })`,
      `const e = extrude(30)`,
      ``,
    ].join('\n');
    const result = await applyFeatureEdit(code, splitSpec({
      plane: { kind: 'plane', producer: 1 },
      keep: 'both',
      offset: null,
      targets: [{ producer: 0 }],
    }, {
      producers: [
        { line: 5, column: 10, featureType: 'feature', nameHint: 'f', bind: true },
        { line: 3, column: 10, featureType: 'plane', nameHint: 'p', bind: true },
      ],
    }));
    expect(result.error).toBeUndefined();
    expect(result.newCode).toContain(`split(p, e)`);
  });

  it('exports a seed line through its sketch return and names it from outside', async () => {
    const code = [
      `import { sketch, ellipse, line, extrude } from 'fluidcad/core'`,
      ``,
      `sketch('xy', () => { ellipse(100, 50) })`,
      `const e = extrude(30)`,
      `sketch('xy', () => {`,
      `  line([0, -60], [0, 60]).guide()`,
      `})`,
      ``,
    ].join('\n');
    const result = await applyFeatureEdit(code, splitSpec({
      plane: { kind: 'sketchLine', producer: 1, target: { line: 6 } },
      keep: 'back',
      offset: null,
      targets: [{ producer: 0 }],
    }, {
      producers: [
        { line: 4, column: 10, featureType: 'feature', nameHint: 'f', bind: true },
        { line: 5, column: 0, featureType: 'sketch', nameHint: 's', bind: true },
      ],
    }));
    expect(result.error).toBeUndefined();
    expect(result.newCode).toBe([
      `import { split, sketch, ellipse, line, extrude } from 'fluidcad/core'`,
      ``,
      `sketch('xy', () => { ellipse(100, 50) })`,
      `const e = extrude(30)`,
      `const s = sketch('xy', () => {`,
      `  const l1 = line([0, -60], [0, 60]).guide()`,
      `  return { l1 };`,
      `})`,
      `split(s.geometries.l1, { keep: 'back' }, e)`,
      ``,
    ].join('\n'));
  });

  it('binds a color() statement as the target when it holds the solid', async () => {
    const code = [
      `import { sketch, ellipse, extrude, color } from 'fluidcad/core'`,
      ``,
      `sketch('xy', () => { ellipse(100, 50) })`,
      `extrude(30)`,
      `color('red')`,
      ``,
    ].join('\n');
    const result = await applyFeatureEdit(code, splitSpec({
      plane: { kind: 'standard', plane: 'yz' },
      keep: 'both',
      offset: null,
      targets: [{ producer: 0 }],
    }, {
      producers: [{ line: 5, column: 0, featureType: 'feature', nameHint: 'f', bind: true }],
    }));
    expect(result.error).toBeUndefined();
    expect(result.newCode).toContain(`const f = color('red')\nsplit('yz', f)\n`);
  });

  it('refuses a malformed cut', async () => {
    const result = await applyFeatureEdit(`${base}\n`, splitSpec({
      plane: { kind: 'standard', plane: 'zz' as never },
      keep: 'both',
      offset: null,
      targets: [{ producer: 0 }],
    }));
    expect(result.error).toContain('malformed split edit spec');
  });
});

const splitEditBase = [
  `import { sketch, ellipse, extrude, cut, split } from 'fluidcad/core'`,
  ``,
  `sketch('xy', () => { ellipse(100, 50) })`,
  `const e = extrude(30)`,
  `sketch('xy', () => { ellipse(10, 10) })`,
  `const c = cut(5)`,
].join('\n');

describe('parseFeatureStatement — split', () => {
  it('reads the cut, the options and identifier targets with their refs', async () => {
    const code = `${splitEditBase}\nsplit('yz', { keep: 'front', offset: 5 }, e, c)\n`;
    const result = await parseFeatureStatement(code, 7);
    expect(result).toEqual({
      ok: true,
      parsed: {
        feature: 'split', planeText: `'yz'`, keep: 'front', offset: 5, targetTexts: ['e', 'c'],
        targetRefs: [{ line: 4, column: 10 }, { line: 6, column: 10 }],
      },
      statement: `split('yz', { keep: 'front', offset: 5 }, e, c)`,
    });
  });

  it('reads an implicit split with no options as the defaults', async () => {
    const result = await parseFeatureStatement(`${splitEditBase}\nsplit(s.geometries.l)\n`, 7);
    expect(result).toMatchObject({
      ok: true,
      parsed: { feature: 'split', planeText: 's.geometries.l', keep: 'both', offset: null, targetTexts: [] },
    });
  });

  it('refuses options the dialog cannot read back', async () => {
    const unknown = await parseFeatureStatement(`${splitEditBase}\nsplit('yz', { flip: true }, e)\n`, 7);
    expect(unknown).toMatchObject({ ok: false });
    const badKeep = await parseFeatureStatement(`${splitEditBase}\nsplit('yz', { keep: side }, e)\n`, 7);
    expect(badKeep).toMatchObject({ ok: false });
  });
});

describe('split in-place edits', () => {
  const code = `${splitEditBase}\nsplit('yz', { keep: 'front' }, e)\n`;

  function editSpec(split: NonNullable<NonNullable<ApplyFeatureEditSpec['edit']>['split']>, overrides: Partial<ApplyFeatureEditSpec> = {}): ApplyFeatureEditSpec {
    return {
      feature: 'split',
      filePath: FILE,
      producers: [],
      parts: [],
      imports: [],
      edit: {
        line: 7, column: 0,
        expectedStatement: `split('yz', { keep: 'front' }, e)`,
        split,
      },
      ...overrides,
    };
  }

  it('rewrites the options object keeping the cut and targets', async () => {
    const result = await applyFeatureEdit(code, editSpec({ plane: { kind: 'keep' }, keep: 'both', offset: 3 }));
    expect(result.error).toBeUndefined();
    expect(result.newCode).toContain(`split('yz', { offset: 3 }, e)\n`);
    const plain = await applyFeatureEdit(code, editSpec({ plane: { kind: 'keep' }, keep: 'both', offset: null }));
    expect(plain.newCode).toContain(`split('yz', e)\n`);
  });

  it('re-sources the cut and replaces the targets', async () => {
    const result = await applyFeatureEdit(code, editSpec({
      plane: { kind: 'standard', plane: 'xz' },
      keep: 'back',
      offset: null,
      targets: [{ kind: 'verbatim', sourceIndex: 0 }, { kind: 'feature', producer: 0 }],
    }, {
      producers: [{ line: 6, column: 10, featureType: 'feature', nameHint: 'f', bind: true }],
    }));
    expect(result.error).toBeUndefined();
    expect(result.newCode).toContain(`split('xz', { keep: 'back' }, e, c)\n`);
  });

  it('makes the split implicit with an empty target list', async () => {
    const result = await applyFeatureEdit(code, editSpec({ plane: { kind: 'keep' }, keep: 'front', offset: null, targets: [] }));
    expect(result.error).toBeUndefined();
    expect(result.newCode).toContain(`split('yz', { keep: 'front' })\n`);
  });
});
