// The parameters panel writing `param()` declarations back to the source.
// Values the panel sets are runtime overrides and never touch the file; the
// declaration itself — its label, its control, its very existence — only lives
// in the code, so editing one from the panel is a source transform with the
// same refusal contract as every other: anything it cannot do safely leaves
// the file byte-identical and says why.

import { describe, it, expect } from 'vitest';
import { ParamEditor, type ParamSpec } from '../src/param-edit.ts';

const CODE = [
  `import { param, sketch, circle, extrude } from 'fluidcad/core';`,
  ``,
  `const width = param('Width', 100);`,
  `const rounded = param('Rounded', true);`,
  ``,
  `sketch('xy', () => {`,
  `  circle(width / 2);`,
  `});`,
  ``,
  `extrude(width);`,
  ``,
].join('\n');

/** Line numbers of the two declarations in CODE, 1-indexed. */
const WIDTH_LINE = 3;
const ROUNDED_LINE = 4;

function spec(overrides: Partial<ParamSpec> = {}): ParamSpec {
  return { label: 'Width', defaultValue: 100, type: 'number', ...overrides };
}

describe('ParamEditor.add', () => {
  it('declares the param after the imports and pulls the import in', async () => {
    const bare = `import { sketch } from 'fluidcad/core';\n\nsketch('xy', () => {});\n`;
    const result = await ParamEditor.apply(bare, {
      kind: 'add', param: spec({ label: 'Depth', defaultValue: 25 }),
    });
    expect(result.error).toBeUndefined();
    expect(result.newCode).toContain(`import { param, sketch } from 'fluidcad/core';\nconst depth = param('Depth', 25);`);
  });

  it('omits the type argument when param() would infer it anyway', async () => {
    const cases: [ParamSpec, string][] = [
      [spec({ label: 'A', defaultValue: 5, type: 'number' }), `param('A', 5)`],
      [spec({ label: 'B', defaultValue: true, type: 'checkbox' }), `param('B', true)`],
      [spec({ label: 'C', defaultValue: 'hi', type: 'text' }), `param('C', 'hi')`],
    ];
    for (const [input, expected] of cases) {
      const result = await ParamEditor.apply(CODE, { kind: 'add', param: input });
      expect(result.error).toBeUndefined();
      expect(result.newCode).toContain(`= ${expected};`);
    }
  });

  it('writes the type and options object for a slider', async () => {
    const result = await ParamEditor.apply(CODE, {
      kind: 'add', param: spec({ label: 'Depth', defaultValue: 25, type: 'slider', min: 0, max: 50, step: 5 }),
    });
    expect(result.newCode).toContain(`const depth = param('Depth', 25, 'slider', { min: 0, max: 50, step: 5 });`);
  });

  it('emits the type even when inferred, once an options object rides along', async () => {
    const result = await ParamEditor.apply(CODE, {
      kind: 'add', param: spec({ label: 'Depth', defaultValue: 25, type: 'number', group: 'Body' }),
    });
    expect(result.newCode).toContain(`param('Depth', 25, 'number', { group: 'Body' })`);
  });

  it('writes select options, and multi only where it means something', async () => {
    const result = await ParamEditor.apply(CODE, {
      kind: 'add', param: {
        label: 'Finish',
        defaultValue: ['matte'],
        type: 'select',
        multi: true,
        multiControlType: 'chips',
        options: [{ label: 'Matte', value: 'matte' }, { label: 'Gloss', value: 'gloss' }],
      },
    });
    expect(result.error).toBeUndefined();
    expect(result.newCode).toContain(
      `const finish = param('Finish', ['matte'], 'select', `
      + `{ options: [{ label: 'Matte', value: 'matte' }, { label: 'Gloss', value: 'gloss' }], `
      + `multi: true, multiControlType: 'chips' });`,
    );
  });

  it('escapes quotes in a label', async () => {
    const result = await ParamEditor.apply(CODE, {
      kind: 'add', param: spec({ label: "Bob's width", defaultValue: 1 }),
    });
    expect(result.newCode).toContain(`param('Bob\\'s width', 1)`);
  });

  it('refuses a label the model already uses', async () => {
    const result = await ParamEditor.apply(CODE, { kind: 'add', param: spec() });
    expect(result.error).toContain('already has a parameter labelled "Width"');
    expect(result.newCode).toBe(CODE);
  });

  it('camel-cases the label into the variable it binds', async () => {
    const result = await ParamEditor.apply(CODE, {
      kind: 'add', param: spec({ label: 'Wall thickness', defaultValue: 2 }),
    });
    expect(result.newCode).toContain(`const wallThickness = param('Wall thickness', 2);`);
  });

  it('steps past a name the file already declares instead of refusing', async () => {
    // `width` is taken by the existing declaration — the new one gets its own
    // name rather than shadowing a variable the model is reading.
    const result = await ParamEditor.apply(CODE, {
      kind: 'add', param: spec({ label: 'width', defaultValue: 7 }),
    });
    expect(result.error).toBeUndefined();
    expect(result.newCode).toContain(`const width2 = param('width', 7);`);
    expect(result.newCode).toContain(`const width = param('Width', 100);`);
  });

  it('keeps stepping while the name stays taken', async () => {
    const crowded = CODE.replace(
      `const rounded = param('Rounded', true);`,
      `const rounded = param('Rounded', true);\nconst width2 = 3;`,
    );
    const result = await ParamEditor.apply(crowded, {
      kind: 'add', param: spec({ label: 'width', defaultValue: 7 }),
    });
    expect(result.newCode).toContain(`const width3 = param('width', 7);`);
  });

  it.each([
    ['2nd offset', 'p2ndOffset'],
    ['###', 'p'],
    ['const', 'pconst'],
  ])('turns the label %s into a legal name', async (label, variable) => {
    const result = await ParamEditor.apply(CODE, {
      kind: 'add', param: spec({ label, defaultValue: 1 }),
    });
    expect(result.error).toBeUndefined();
    expect(result.newCode).toContain(`const ${variable} = param(`);
  });
});

describe('ParamEditor.update', () => {
  it('renames the label and leaves the variable alone', async () => {
    const result = await ParamEditor.apply(CODE, {
      kind: 'update',
      line: WIDTH_LINE,
      expectedLabel: 'Width',
      param: spec({ label: 'Overall width' }),
    });
    expect(result.error).toBeUndefined();
    expect(result.newCode).toContain(`const width = param('Overall width', 100);`);
    // The model reads `width`; renaming the label must not touch it.
    expect(result.newCode).toContain('circle(width / 2);');
    expect(result.newCode).toContain('extrude(width);');
  });

  it('changes the control type and its options in place', async () => {
    const result = await ParamEditor.apply(CODE, {
      kind: 'update',
      line: WIDTH_LINE,
      expectedLabel: 'Width',
      param: spec({ type: 'slider', min: 10, max: 200, step: 10, description: 'Outer width' }),
    });
    expect(result.newCode).toContain(
      `const width = param('Width', 100, 'slider', { description: 'Outer width', min: 10, max: 200, step: 10 });`,
    );
  });

  it('drops options the new type has no use for', async () => {
    const sliderCode = CODE.replace(
      `param('Width', 100)`,
      `param('Width', 100, 'slider', { min: 0, max: 500 })`,
    );
    const result = await ParamEditor.apply(sliderCode, {
      kind: 'update',
      line: WIDTH_LINE,
      expectedLabel: 'Width',
      param: spec({ defaultValue: 'wide', type: 'text' }),
    });
    expect(result.newCode).toContain(`const width = param('Width', 'wide');`);
    expect(result.newCode).not.toContain('min:');
  });

  it('resolves a declaration whose line moved since the render', async () => {
    const shifted = `// a comment the user just typed\n${CODE}`;
    const result = await ParamEditor.apply(shifted, {
      kind: 'update',
      line: WIDTH_LINE,
      expectedLabel: 'Width',
      param: spec({ label: 'Width mm' }),
    });
    expect(result.error).toBeUndefined();
    expect(result.newCode).toContain(`param('Width mm', 100)`);
  });

  it('refuses a label the file no longer declares', async () => {
    const result = await ParamEditor.apply(CODE, {
      kind: 'update',
      line: WIDTH_LINE,
      expectedLabel: 'Gone',
      param: spec({ label: 'Gone' }),
    });
    expect(result.error).toContain('is the file in sync');
    expect(result.newCode).toBe(CODE);
  });

  it('refuses a rename onto a label that already exists', async () => {
    const result = await ParamEditor.apply(CODE, {
      kind: 'update',
      line: WIDTH_LINE,
      expectedLabel: 'Width',
      param: spec({ label: 'Rounded' }),
    });
    expect(result.error).toContain('already has a parameter labelled "Rounded"');
    expect(result.newCode).toBe(CODE);
  });

  it('refuses a call with a chained method rather than dropping the chain', async () => {
    const chained = CODE.replace(`param('Width', 100)`, `param('Width', 100).number()`);
    const result = await ParamEditor.apply(chained, {
      kind: 'update',
      line: WIDTH_LINE,
      expectedLabel: 'Width',
      param: spec({ label: 'W' }),
    });
    expect(result.error).toContain('chained method');
    expect(result.newCode).toBe(chained);
  });

  it('refuses a select with no options, and a default outside them', async () => {
    const empty = await ParamEditor.apply(CODE, {
      kind: 'update',
      line: WIDTH_LINE,
      expectedLabel: 'Width',
      param: spec({ defaultValue: 'a', type: 'select', options: [] }),
    });
    expect(empty.error).toContain('at least one option');

    const stray = await ParamEditor.apply(CODE, {
      kind: 'update',
      line: WIDTH_LINE,
      expectedLabel: 'Width',
      param: spec({ defaultValue: 'c', type: 'select', options: [{ label: 'A', value: 'a' }] }),
    });
    expect(stray.error).toContain('not one of the options');
  });

  it('refuses an empty label and a reversed min/max', async () => {
    const blank = await ParamEditor.apply(CODE, {
      kind: 'update',
      line: WIDTH_LINE,
      expectedLabel: 'Width',
      param: spec({ label: '  ' }),
    });
    expect(blank.error).toContain('needs a label');

    const reversed = await ParamEditor.apply(CODE, {
      kind: 'update',
      line: WIDTH_LINE,
      expectedLabel: 'Width',
      param: spec({ type: 'slider', min: 100, max: 10 }),
    });
    expect(reversed.error).toContain('greater than the maximum');
  });
});

describe('ParamEditor.remove', () => {
  it('deletes the whole declaration statement', async () => {
    const result = await ParamEditor.apply(CODE, {
      kind: 'remove',
      line: ROUNDED_LINE,
      expectedLabel: 'Rounded',
    });
    expect(result.error).toBeUndefined();
    expect(result.newCode).not.toContain('Rounded');
    expect(result.newCode).toContain(`const width = param('Width', 100);`);
  });

  it('leaves the references behind for the user to resolve', async () => {
    const result = await ParamEditor.apply(CODE, {
      kind: 'remove',
      line: WIDTH_LINE,
      expectedLabel: 'Width',
    });
    expect(result.error).toBeUndefined();
    expect(result.newCode).not.toContain(`param('Width'`);
    expect(result.newCode).toContain('extrude(width);');
  });

  it('refuses a param written inline inside another call', async () => {
    const inline = [
      `import { param, extrude } from 'fluidcad/core';`,
      ``,
      `extrude(param('Depth', 10));`,
      ``,
    ].join('\n');
    const result = await ParamEditor.apply(inline, { kind: 'remove', line: 3, expectedLabel: 'Depth' });
    expect(result.error).toContain('nested inside another expression');
    expect(result.newCode).toBe(inline);
  });

  it('refuses a label the file no longer declares', async () => {
    const result = await ParamEditor.apply(CODE, { kind: 'remove', line: 3, expectedLabel: 'Gone' });
    expect(result.error).toContain('is the file in sync');
    expect(result.newCode).toBe(CODE);
  });
});

describe('ParamEditor.inspect', () => {
  it('reports the bound variable and every place that reads it', async () => {
    const usage = await ParamEditor.inspect(CODE, 'Width', WIDTH_LINE);
    expect(usage.variable).toBe('width');
    expect(usage.editable).toBe(true);
    expect(usage.references).toBe(2);
    expect(usage.referenceLines).toEqual([7, 10]);
  });

  it('reports an unused param as safe to delete', async () => {
    const usage = await ParamEditor.inspect(CODE, 'Rounded', ROUNDED_LINE);
    expect(usage.variable).toBe('rounded');
    expect(usage.references).toBe(0);
  });

  it('does not count a property or an object key that spells the name', async () => {
    const shadowed = [
      `import { param } from 'fluidcad/core';`,
      ``,
      `const width = param('Width', 100);`,
      `const box = { width: 4 };`,
      `const other = box.width;`,
      ``,
    ].join('\n');
    const usage = await ParamEditor.inspect(shadowed, 'Width', 3);
    expect(usage.references).toBe(0);
  });

  it('marks a chained declaration as not editable, with the reason', async () => {
    const chained = CODE.replace(`param('Width', 100)`, `param('Width', 100).number()`);
    const usage = await ParamEditor.inspect(chained, 'Width', WIDTH_LINE);
    expect(usage.editable).toBe(false);
    expect(usage.reason).toContain('chained method');
  });

  it('picks the right declaration when a label is used twice', async () => {
    const twice = CODE.replace(
      `const rounded = param('Rounded', true);`,
      `const rounded = param('Width', true);`,
    );
    const first = await ParamEditor.inspect(twice, 'Width', WIDTH_LINE);
    expect(first.variable).toBe('width');
    const second = await ParamEditor.inspect(twice, 'Width', ROUNDED_LINE);
    expect(second.variable).toBe('rounded');
  });

  it('refuses to guess when a duplicated label has no line to disambiguate', async () => {
    const twice = CODE.replace(
      `const rounded = param('Rounded', true);`,
      `const rounded = param('Width', true);`,
    );
    const usage = await ParamEditor.inspect(twice, 'Width');
    expect(usage.editable).toBe(false);
    expect(usage.reason).toContain('declared 2 times');
  });
});
