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
      `split('yz', { keep: 'front' }, f, f2).name('Split 1')`,
      ``,
    ].join('\n'));
  });

  it('appends an implicit split of every solid at the end of the file', async () => {
    const result = await applyFeatureEdit(`${base}\n`, splitSpec({
      plane: { kind: 'standard', plane: 'xz' },
      keep: 'both',
      targets: [],
    }, { producers: [] }));
    expect(result.error).toBeUndefined();
    expect(result.newCode.endsWith(`cut(5)\nsplit('xz').name('Split 1')\n`)).toBe(true);
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
        targets: [],
      }, { producers: [], activePart }));
      expect(result.error).toBeUndefined();
      expect(result.newCode.endsWith(`  extrude(30)\n  split('xz').name('Split 1')\n})\n`)).toBe(true);
    });

    it('appends a plane-feature split of every solid inside the active part', async () => {
      const result = await applyFeatureEdit(partCode, splitSpec({
        plane: { kind: 'plane', producer: 0 },
        keep: 'front',
        targets: [],
      }, {
        producers: [{ line: 3, column: 10, featureType: 'plane', nameHint: 'p', bind: true }],
        activePart,
      }));
      expect(result.error).toBeUndefined();
      expect(result.newCode.endsWith(`  extrude(30)\n  split(p, { keep: 'front' }).name('Split 1')\n})\n`)).toBe(true);
    });

    it('keeps a split with a target beside that target inside the part', async () => {
      const result = await applyFeatureEdit(partCode, splitSpec({
        plane: { kind: 'standard', plane: 'xz' },
        keep: 'both',
        targets: [{ producer: 0 }],
      }, {
        producers: [{ line: 6, column: 2, featureType: 'feature', nameHint: 'f', bind: true }],
        activePart,
      }));
      expect(result.error).toBeUndefined();
      expect(result.newCode).toContain(`  const f = extrude(30)\n  split('xz', f).name('Split 1')\n})\n`);
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
      plane: { kind: 'sketchEdge', producer: 1, target: { line: 6 } },
      keep: 'back',
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
      `split(s.geometries.l1, { keep: 'back' }, e).name('Split 1')`,
      ``,
    ].join('\n'));
  });

  it('exports a curved seed — a circle — the same way, named after its kind', async () => {
    const code = [
      `import { sketch, ellipse, circle, extrude } from 'fluidcad/core'`,
      ``,
      `sketch('xy', () => { ellipse(100, 50) })`,
      `const e = extrude(30)`,
      `sketch('xy', () => {`,
      `  circle([0, 0], 40).guide()`,
      `})`,
      ``,
    ].join('\n');
    const result = await applyFeatureEdit(code, splitSpec({
      plane: { kind: 'sketchEdge', producer: 1, target: { line: 6 } },
      keep: 'front',
      targets: [{ producer: 0 }],
    }, {
      producers: [
        { line: 4, column: 10, featureType: 'feature', nameHint: 'f', bind: true },
        { line: 5, column: 0, featureType: 'sketch', nameHint: 's', bind: true },
      ],
    }));
    expect(result.error).toBeUndefined();
    expect(result.newCode).toContain(`  const c1 = circle([0, 0], 40).guide()\n  return { c1 };\n})\nsplit(s.geometries.c1, { keep: 'front' }, e).name('Split 1')\n`);
  });

  it('exports a bezier seed, which is geometry but no solver entity', async () => {
    const code = [
      `import { sketch, ellipse, bezier, extrude } from 'fluidcad/core'`,
      ``,
      `sketch('xy', () => { ellipse(100, 50) })`,
      `const e = extrude(30)`,
      `sketch('xy', () => {`,
      `  bezier([-20, -60], [-30, 0], [30, 0], [20, 60]).guide()`,
      `})`,
      ``,
    ].join('\n');
    const result = await applyFeatureEdit(code, splitSpec({
      plane: { kind: 'sketchEdge', producer: 1, target: { line: 6 } },
      keep: 'both',
      targets: [{ producer: 0 }],
    }, {
      producers: [
        { line: 4, column: 10, featureType: 'feature', nameHint: 'f', bind: true },
        { line: 5, column: 0, featureType: 'sketch', nameHint: 's', bind: true },
      ],
    }));
    expect(result.error).toBeUndefined();
    expect(result.newCode).toContain(`  const bz1 = bezier([-20, -60], [-30, 0], [30, 0], [20, 60]).guide()\n  return { bz1 };\n})\nsplit(s.geometries.bz1, e).name('Split 1')\n`);
  });

  it('binds the feature that built a painted body, not the color() that painted it', async () => {
    // A colour writes face records on the extrude's holder and holds no body
    // of its own, so the pick attributes to the extrude and the split lands
    // after the paint (the selection resolves on the final model).
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
      targets: [{ producer: 0 }],
    }, {
      producers: [{ line: 4, column: 0, featureType: 'feature', nameHint: 'f', bind: true }],
    }));
    expect(result.error).toBeUndefined();
    expect(result.newCode).toContain(`const f = extrude(30)\ncolor('red')\nsplit('yz', f).name('Split 1')\n`);
  });

  it('refuses a color() statement as the target: it holds no body', async () => {
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
      targets: [{ producer: 0 }],
    }, {
      producers: [{ line: 5, column: 0, featureType: 'feature', nameHint: 'f', bind: true }],
    }));
    expect(result.error).toContain('color(');
    expect(result.newCode).toBe(code);
  });

  it('refuses a malformed cut', async () => {
    const result = await applyFeatureEdit(`${base}\n`, splitSpec({
      plane: { kind: 'standard', plane: 'zz' as never },
      keep: 'both',
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
    const code = `${splitEditBase}\nsplit('yz', { keep: 'front' }, e, c)\n`;
    const result = await parseFeatureStatement(code, 7);
    expect(result).toEqual({
      ok: true,
      parsed: {
        feature: 'split', planeText: `'yz'`, keep: 'front', targetTexts: ['e', 'c'],
        targetRefs: [{ line: 4, column: 10 }, { line: 6, column: 10 }],
      },
      statement: `split('yz', { keep: 'front' }, e, c)`,
    });
  });

  it('reads an implicit split with no options as the defaults', async () => {
    const result = await parseFeatureStatement(`${splitEditBase}\nsplit(s.geometries.l)\n`, 7);
    expect(result).toMatchObject({
      ok: true,
      parsed: { feature: 'split', planeText: 's.geometries.l', keep: 'both', targetTexts: [] },
    });
  });

  it('refuses options the dialog cannot read back', async () => {
    const unknown = await parseFeatureStatement(`${splitEditBase}\nsplit('yz', { flip: true }, e)\n`, 7);
    expect(unknown).toMatchObject({ ok: false });
    const offset = await parseFeatureStatement(`${splitEditBase}\nsplit('yz', { offset: 5 }, e)\n`, 7);
    expect(offset).toMatchObject({ ok: false });
    // A literal that is no side is refused — the dropdown has nothing to show
    // for it; a name or an expression in its place reads as the slot it is.
    const badKeep = await parseFeatureStatement(`${splitEditBase}\nsplit('yz', { keep: 'top' }, e)\n`, 7);
    expect(badKeep).toMatchObject({ ok: false });
    const named = await parseFeatureStatement(`${splitEditBase}\nsplit('yz', { keep: side }, e)\n`, 7);
    expect(named).toMatchObject({ ok: true, parsed: { keep: { ref: 'side' } } });
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
    const result = await applyFeatureEdit(code, editSpec({ plane: { kind: 'keep' }, keep: 'back' }));
    expect(result.error).toBeUndefined();
    expect(result.newCode).toContain(`split('yz', { keep: 'back' }, e)\n`);
    const plain = await applyFeatureEdit(code, editSpec({ plane: { kind: 'keep' }, keep: 'both' }));
    expect(plain.newCode).toContain(`split('yz', e)\n`);
  });

  it('re-sources the cut and replaces the targets', async () => {
    const result = await applyFeatureEdit(code, editSpec({
      plane: { kind: 'standard', plane: 'xz' },
      keep: 'back',
      targets: [{ kind: 'verbatim', sourceIndex: 0 }, { kind: 'feature', producer: 0 }],
    }, {
      producers: [{ line: 6, column: 10, featureType: 'feature', nameHint: 'f', bind: true }],
    }));
    expect(result.error).toBeUndefined();
    expect(result.newCode).toContain(`split('xz', { keep: 'back' }, e, c)\n`);
  });

  it('makes the split implicit with an empty target list', async () => {
    const result = await applyFeatureEdit(code, editSpec({ plane: { kind: 'keep' }, keep: 'front', targets: [] }));
    expect(result.error).toBeUndefined();
    expect(result.newCode).toContain(`split('yz', { keep: 'front' })\n`);
  });
});

// The Keep dropdown is a typed-in slot: a statement computing the side
// (`{ keep: flag ? 'front' : 'back' }`) opens in the dialog with the
// expression, an edit of another row writes it back as it was (whatever its
// text — two lines included), a typed expression replaces it bare, a side
// writes as before (the default `both` eliding the object only as a
// literal), and typed text is checked as a number row's expression is.
describe('split keep as an expression', () => {
  function editSpec(split: NonNullable<NonNullable<ApplyFeatureEditSpec['edit']>['split']>, expectedStatement: string): ApplyFeatureEditSpec {
    return {
      feature: 'split',
      filePath: FILE,
      producers: [],
      parts: [],
      imports: [],
      edit: { line: 7, column: 0, expectedStatement, split },
    };
  }

  it('reads a computed keep, keeps it through an edit, and writes a typed one bare', async () => {
    const statement = `split('yz', { keep: flag ? 'front' : 'back' }, e)`;
    const code = `${splitEditBase}\n${statement}\n`;
    const result = await parseFeatureStatement(code, 7);
    expect(result).toMatchObject({ ok: true, parsed: { feature: 'split', keep: { expr: "flag ? 'front' : 'back'" } } });

    const kept = await applyFeatureEdit(code, editSpec({ plane: { kind: 'keep' }, keep: { expr: "flag ? 'front' : 'back'" }, targets: [] }, statement));
    expect(kept.error).toBeUndefined();
    expect(kept.newCode).toContain(`split('yz', { keep: flag ? 'front' : 'back' })\n`);
    const typed = await applyFeatureEdit(code, editSpec({ plane: { kind: 'keep' }, keep: { expr: 'side' } }, statement));
    expect(typed.newCode).toContain(`split('yz', { keep: side }, e)\n`);
    const named = await applyFeatureEdit(code, editSpec({ plane: { kind: 'keep' }, keep: { ref: 'side' } }, statement));
    expect(named.newCode).toContain(`split('yz', { keep: side }, e)\n`);
    const literal = await applyFeatureEdit(code, editSpec({ plane: { kind: 'keep' }, keep: 'back' }, statement));
    expect(literal.newCode).toContain(`split('yz', { keep: 'back' }, e)\n`);
    const plain = await applyFeatureEdit(code, editSpec({ plane: { kind: 'keep' }, keep: 'both' }, statement));
    expect(plain.newCode).toContain(`split('yz', e)\n`);
    // Only the literal default drops the object — an expression may come to anything.
    const defaulted = await applyFeatureEdit(code, editSpec({ plane: { kind: 'keep' }, keep: { expr: "'both'" } }, statement));
    expect(defaulted.newCode).toContain(`split('yz', { keep: 'both' }, e)\n`);
    const bad = await applyFeatureEdit(code, editSpec({ plane: { kind: 'keep' }, keep: { expr: 'a, b' } }, statement));
    expect(bad.error).toBeTruthy();
    const unknown = await applyFeatureEdit(code, editSpec({ plane: { kind: 'keep' }, keep: 'top' as never }, statement));
    expect(unknown.error).toBeTruthy();
  });

  it('keeps a two-line expression as the statement had it', async () => {
    const statement = `split('yz', { keep: flag\n  ? 'front' : 'back' }, e)`;
    const code = `${splitEditBase}\n${statement}\n`;
    const read = await parseFeatureStatement(code, 7);
    expect(read).toMatchObject({ ok: true, parsed: { keep: { expr: "flag\n  ? 'front' : 'back'" } } });
    const kept = await applyFeatureEdit(code, editSpec({ plane: { kind: 'keep' }, keep: { expr: "flag\n  ? 'front' : 'back'" }, targets: [] }, statement));
    expect(kept.error).toBeUndefined();
    expect(kept.newCode).toContain(`split('yz', { keep: flag\n  ? 'front' : 'back' })\n`);
  });

  it('still refuses a spread and an options object that is no literal', async () => {
    expect(await parseFeatureStatement(`${splitEditBase}\nsplit('yz', { keep: ...sides }, e)\n`, 7)).toMatchObject({ ok: false });
    expect(await parseFeatureStatement(`${splitEditBase}\nsplit('yz', options, e)\n`, 7)).toMatchObject({ ok: true, parsed: { keep: 'both', targetTexts: ['options', 'e'] } });
  });
});
