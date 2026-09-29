// The parameters panel writing `property()` declarations back to the source.
// A property is the value a part publishes — its declaration only lives in
// the code, so adding, rewriting or deleting one from the panel is a source
// transform with the same refusal contract as the param editor: anything it
// cannot do safely leaves the file byte-identical and says why.

import { describe, it, expect } from 'vitest';
import { PropertyEditor, type PropertySpec } from '../src/property-edit.ts';

const CODE = [
  `import { part, param, sketch, circle, extrude, property } from 'fluidcad/core';`,
  ``,
  `export const housing = part('Housing', () => {`,
  `  const width = param('Width', 60);`,
  `  const wall = param('Wall', 4);`,
  ``,
  `  sketch('xy', () => {`,
  `    circle(width);`,
  `  });`,
  `  extrude(25);`,
  `  property('pocketDiameter', width - 2 * wall);`,
  `  const bolts = property('boltCount', 4);`,
  `});`,
  ``,
  `export const lid = part('Lid', () => {`,
  `  property('pocketDiameter', 10);`,
  `});`,
  ``,
].join('\n');

const HOUSING = { line: 3, column: 0 };
const LID = { line: 15, column: 0 };
const POCKET_LINE = 11;
const BOLTS_LINE = 12;

function spec(overrides: Partial<PropertySpec> = {}): PropertySpec {
  return { name: 'pocketDepth', expression: '25 - wall', ...overrides };
}

describe('PropertyEditor.add', () => {
  it('appends the property at the end of the part body and pulls the import in', async () => {
    const bare = `import { part, param, sketch } from 'fluidcad/core';\n\nexport const p = part('P', () => {\n  const w = param('W', 10);\n  sketch('xy', () => {});\n});\n`;
    const result = await PropertyEditor.apply(bare, {
      kind: 'add', property: spec({ name: 'inner', expression: 'w - 2' }), part: { line: 3, column: 0 },
    });
    expect(result.error).toBeUndefined();
    expect(result.newCode).toContain(`import { property, part, param, sketch } from 'fluidcad/core';`);
    expect(result.newCode).toContain(`  sketch('xy', () => {});\n  property('inner', w - 2);\n});`);
  });

  it('opens an empty single-line body around the statement', async () => {
    const empty = `import { part } from 'fluidcad/core';\n\nexport const p = part('P', () => {});\n`;
    const result = await PropertyEditor.apply(empty, {
      kind: 'add', property: spec({ name: 'n', expression: '4' }), part: { line: 3, column: 0 },
    });
    expect(result.error).toBeUndefined();
    expect(result.newCode).toContain(`part('P', () => {\n  property('n', 4);\n});`);
  });

  it('writes a quoted string value verbatim', async () => {
    const result = await PropertyEditor.apply(CODE, { kind: 'add', property: spec({ name: 'finish', expression: "'anodised'" }), part: HOUSING });
    expect(result.error).toBeUndefined();
    expect(result.newCode).toContain(`  const bolts = property('boltCount', 4);\n  property('finish', 'anodised');\n});`);
  });

  it('refuses a name the same part already declares, but allows it in another part', async () => {
    const dup = await PropertyEditor.apply(CODE, { kind: 'add', property: spec({ name: 'boltCount', expression: '2' }), part: HOUSING });
    expect(dup.error).toContain('already declares a property named "boltCount"');
    expect(dup.newCode).toBe(CODE);
    const other = await PropertyEditor.apply(CODE, { kind: 'add', property: spec({ name: 'boltCount', expression: '2' }), part: LID });
    expect(other.error).toBeUndefined();
    expect(other.newCode).toContain(`  property('pocketDiameter', 10);\n  property('boltCount', 2);\n});`);
  });

  it('refuses an add that names no part', async () => {
    const result = await PropertyEditor.apply(CODE, { kind: 'add', property: spec() } as any);
    expect(result.error).toContain('needs the part it goes in');
    expect(result.newCode).toBe(CODE);
  });

  it('refuses a part line the file has no part() at', async () => {
    const result = await PropertyEditor.apply(CODE, { kind: 'add', property: spec(), part: { line: 7, column: 0 } });
    expect(result.error).toContain('no part() call found at line 7');
    expect(result.newCode).toBe(CODE);
  });

  it('refuses a bad name, an empty value and a multi-statement value', async () => {
    const cases: [PropertySpec, RegExp][] = [
      [spec({ name: 'pocket depth' }), /plain identifier/],
      [spec({ name: '1st' }), /plain identifier/],
      [spec({ expression: '   ' }), /needs a value/],
      [spec({ expression: 'a; b' }), /single expression/],
      [spec({ expression: 'a, b' }), /single expression/],
    ];
    for (const [property, message] of cases) {
      const result = await PropertyEditor.apply(CODE, { kind: 'add', property, part: HOUSING });
      expect(result.error).toMatch(message);
      expect(result.newCode).toBe(CODE);
    }
  });
});

describe('PropertyEditor.update', () => {
  it('rewrites the arguments in place, keeping the binding and the semicolon', async () => {
    const result = await PropertyEditor.apply(CODE, {
      kind: 'update', expectedName: 'boltCount', property: { name: 'boltCount', expression: '6' },
    });
    expect(result.error).toBeUndefined();
    expect(result.newCode).toContain(`  const bolts = property('boltCount', 6);\n`);
  });

  it('renames and changes the expression in one edit', async () => {
    const result = await PropertyEditor.apply(CODE, {
      kind: 'update', line: POCKET_LINE, expectedName: 'pocketDiameter',
      property: { name: 'innerDiameter', expression: 'width - wall * 2' },
    });
    expect(result.error).toBeUndefined();
    expect(result.newCode).toContain(`  property('innerDiameter', width - wall * 2);\n  const bolts`);
    expect(result.newCode).toContain(`  property('pocketDiameter', 10);\n`);
  });

  it('needs the line to pick between two parts declaring the same name', async () => {
    const ambiguous = await PropertyEditor.apply(CODE, {
      kind: 'update', expectedName: 'pocketDiameter', property: { name: 'pocketDiameter', expression: '1' },
    });
    expect(ambiguous.error).toContain('declared 2 times');
    const lidOne = await PropertyEditor.apply(CODE, {
      kind: 'update', line: 16, expectedName: 'pocketDiameter', property: { name: 'pocketDiameter', expression: '12' },
    });
    expect(lidOne.error).toBeUndefined();
    expect(lidOne.newCode).toContain(`  property('pocketDiameter', 12);\n});`);
    expect(lidOne.newCode).toContain(`property('pocketDiameter', width - 2 * wall);`);
  });

  it('renames the property through the file\'s reads, and the bound const with it', async () => {
    const read = CODE
      .replace(`  const bolts = property('boltCount', 4);`, `  const bolts = property('boltCount', 4);\n  extrude(bolts);`)
      + `const h = insert(housing).grounded();\nextrude(h.properties.boltCount + housing.properties.boltCount);\n`;
    const result = await PropertyEditor.apply(read, {
      kind: 'update', expectedName: 'boltCount', property: { name: 'boltTotal', expression: '4' }, variable: 'boltTotal',
    });
    expect(result.error).toBeUndefined();
    expect(result.newCode).toContain(`const boltTotal = property('boltTotal', 4);\n  extrude(boltTotal);`);
    expect(result.newCode).toContain('extrude(h.properties.boltTotal + housing.properties.boltTotal);');
    expect(result.newCode).not.toContain('bolt' + 'Count');
  });

  it('refuses a rename onto a name the part already declares', async () => {
    const result = await PropertyEditor.apply(CODE, {
      kind: 'update', line: POCKET_LINE, expectedName: 'pocketDiameter',
      property: { name: 'boltCount', expression: '1' },
    });
    expect(result.error).toContain('already declares a property named "boltCount"');
    expect(result.newCode).toBe(CODE);
  });

  it('refuses a name the file no longer declares', async () => {
    const result = await PropertyEditor.apply(CODE, {
      kind: 'update', expectedName: 'gone', property: { name: 'gone', expression: '1' },
    });
    expect(result.error).toContain('no property() call named "gone"');
    expect(result.newCode).toBe(CODE);
  });

  it('refuses a chained call', async () => {
    const chained = CODE.replace(`property('boltCount', 4);`, `property('boltCount', 4).toFixed();`);
    const result = await PropertyEditor.apply(chained, {
      kind: 'update', expectedName: 'boltCount', property: { name: 'boltCount', expression: '5' },
    });
    expect(result.error).toContain('chained method');
    expect(result.newCode).toBe(chained);
  });
});

describe('PropertyEditor.remove', () => {
  it('deletes the whole statement, bound or bare', async () => {
    const bare = await PropertyEditor.apply(CODE, { kind: 'remove', line: POCKET_LINE, expectedName: 'pocketDiameter' });
    expect(bare.error).toBeUndefined();
    expect(bare.newCode).not.toContain(`width - 2 * wall`);
    expect(bare.newCode).toContain(`  extrude(25);\n  const bolts = property('boltCount', 4);\n});`);
    const bound = await PropertyEditor.apply(CODE, { kind: 'remove', expectedName: 'boltCount' });
    expect(bound.error).toBeUndefined();
    expect(bound.newCode).not.toContain('boltCount');
  });

  it('stands the value in for the bound variable and every .properties read of it', async () => {
    const read = CODE
      .replace(`  const bolts = property('boltCount', 4);`, `  const bolts = property('boltCount', 4);\n  extrude(bolts);`)
      .replace(`  property('pocketDiameter', 10);`, `  extrude(housing.properties.boltCount * 2);`)
      + `const h = insert(housing, { Width: 80 }).grounded();\nextrude(h.properties.boltCount);\n`;
    const result = await PropertyEditor.apply(read, { kind: 'remove', expectedName: 'boltCount' });
    expect(result.error).toBeUndefined();
    expect(result.newCode).not.toContain('boltCount');
    expect(result.newCode).not.toContain('bolts');
    expect(result.newCode).toContain(`  property('pocketDiameter', width - 2 * wall);\n  extrude(4);\n});`);
    expect(result.newCode).toContain('extrude(4 * 2);');
    expect(result.newCode).toContain('extrude(4);\n');
  });

  it('refuses when another part reads a value that names this part\'s own parameters', async () => {
    const read = CODE.replace(`  property('pocketDiameter', 10);`, `  extrude(housing.properties.pocketDiameter);`);
    const result = await PropertyEditor.apply(read, { kind: 'remove', line: POCKET_LINE, expectedName: 'pocketDiameter' });
    expect(result.error).toContain('the value of "pocketDiameter" (width - 2 * wall) reads names that are out of scope at this file (line 16)');
    expect(result.newCode).toBe(read);
  });

  it('refuses a call nested inside another expression', async () => {
    const nested = CODE.replace(`const bolts = property('boltCount', 4);`, `extrude(property('boltCount', 4));`);
    const result = await PropertyEditor.apply(nested, { kind: 'remove', expectedName: 'boltCount' });
    expect(result.error).toContain('nested inside another expression');
    expect(result.newCode).toBe(nested);
  });
});

describe('PropertyEditor.inspect', () => {
  it('reports the value source text, the binding and its readers', async () => {
    const withReader = CODE.replace(`  const bolts = property('boltCount', 4);`, `  const bolts = property('boltCount', 4);\n  extrude(bolts);`);
    const pocket = await PropertyEditor.inspect(withReader, 'pocketDiameter', POCKET_LINE);
    expect(pocket).toMatchObject({ expression: 'width - 2 * wall', variable: null, references: 0, editable: true });
    const bolts = await PropertyEditor.inspect(withReader, 'boltCount', BOLTS_LINE);
    expect(bolts).toMatchObject({ expression: '4', variable: 'bolts', references: 1, referenceLines: [13], editable: true });
  });

  it('flags a missing declaration, or one with extra arguments, as not editable', async () => {
    const missing = await PropertyEditor.inspect(CODE, 'gone');
    expect(missing.editable).toBe(false);
    expect(missing.expression).toBeNull();
    const extra = CODE.replace(`property('boltCount', 4)`, `property('boltCount', 4, 'length')`);
    const inspected = await PropertyEditor.inspect(extra, 'boltCount');
    expect(inspected.editable).toBe(false);
    expect(inspected.reason).toContain('extra arguments');
  });
});
