// The configurations panel writing the `configurations({ … })` table back to
// the source: rows and cells as literal rewrites, expressions left as they
// are, the statement created first in the body and removed with its last row.

import { describe, it, expect } from 'vitest';
import { ConfigurationEditor } from '../src/configuration-edit.ts';

const TABLE = [
  `import { assembly, configurations, param, insert } from 'fluidcad/core';`,
  ``,
  `export const frame = assembly('frame', () => {`,
  `  const configuration = configurations({`,
  `    Compact: { Width: 500, Depth: 600, Lid: false },`,
  `    'Extra Wide': { Width: base * 2, Note: 'it\\'s wide', Holes: [1, 2, 'x'] },`,
  `  });`,
  `  const width = param('Width', 700);`,
  `  if (configuration === 'Compact') {`,
  `    insert(lid);`,
  `  }`,
  `});`,
  ``,
].join('\n');

const NO_TABLE = [
  `import { assembly, param, insert } from 'fluidcad/core';`,
  ``,
  `export const frame = assembly('frame', () => {`,
  `  // sizes`,
  `  const width = param('Width', 700);`,
  `  insert(lid);`,
  `});`,
  ``,
].join('\n');

function ok(result: { newCode: string } | { error: string }): string {
  expect(result).not.toHaveProperty('error');
  return (result as { newCode: string }).newCode;
}

function failure(result: { newCode: string } | { error: string }): string {
  expect(result).toHaveProperty('error');
  return (result as { error: string }).error;
}

describe('ConfigurationEditor.readTables', () => {
  it('reads literal cells as values and expression cells as source text, quoted names included', async () => {
    const tables = await ConfigurationEditor.readTables(TABLE);
    expect(tables).toEqual([{
      body: 'frame',
      line: 4,
      rows: {
        Compact: {
          Width: { literal: 500, text: '500' },
          Depth: { literal: 600, text: '600' },
          Lid: { literal: false, text: 'false' },
        },
        'Extra Wide': {
          Width: { text: 'base * 2' },
          Note: { literal: "it's wide", text: `'it\\'s wide'` },
          Holes: { literal: [1, 2, 'x'], text: `[1, 2, 'x']` },
        },
      },
    }]);
  });

  it('reads a negative number and a shorthand cell', async () => {
    const code = `part('p', () => {\n  configurations({ A: { Offset: -5, Width } });\n});\n`;
    const tables = await ConfigurationEditor.readTables(code);
    expect(tables[0]?.rows).toEqual({ A: { Offset: { literal: -5, text: '-5' }, Width: { text: 'Width' } } });
  });

  it('is empty without a table, without a body, or for a non-literal argument', async () => {
    expect(await ConfigurationEditor.readTables(NO_TABLE)).toEqual([]);
    expect(await ConfigurationEditor.readTables(`const x = 1;\n`)).toEqual([]);
    expect(await ConfigurationEditor.readTables(`assembly('a', () => {\n  configurations(rows);\n});\n`)).toEqual([]);
  });

  it('finds the table in a single part() body too', async () => {
    const code = `import { part, configurations } from 'fluidcad/core';\nexport const p = part('p', () => {\n  configurations({ Wide: { Width: 1 } });\n});\n`;
    expect(await ConfigurationEditor.readTables(code)).toEqual([
      { body: 'p', line: 3, rows: { Wide: { Width: { literal: 1, text: '1' } } } },
    ]);
  });
});

describe('ConfigurationEditor.addRow', () => {
  it('creates the statement first in the body, above the param(), and pulls the import in', async () => {
    const newCode = ok(await ConfigurationEditor.addRow(NO_TABLE, 'Wide', { Width: 1200, Lid: true }));
    expect(newCode).toBe([
      `import { configurations, assembly, param, insert } from 'fluidcad/core';`,
      ``,
      `export const frame = assembly('frame', () => {`,
      `  // sizes`,
      `  const configuration = configurations({`,
      `    Wide: { Width: 1200, Lid: true },`,
      `  });`,
      `  const width = param('Width', 700);`,
      `  insert(lid);`,
      `});`,
      ``,
    ].join('\n'));
  });

  it('opens an empty body around the statement', async () => {
    const code = `import { part } from 'fluidcad/core';\nexport const p = part('p', () => {});\n`;
    const newCode = ok(await ConfigurationEditor.addRow(code, 'Wide'));
    expect(newCode).toBe([
      `import { configurations, part } from 'fluidcad/core';`,
      `export const p = part('p', () => {`,
      `  const configuration = configurations({`,
      `    Wide: {},`,
      `  });`,
      `});`,
      ``,
    ].join('\n'));
  });

  it('writes the statement unbound when the body already uses the name', async () => {
    const code = NO_TABLE.replace(`  insert(lid);`, `  const configuration = 'x';\n  insert(lid);`);
    const newCode = ok(await ConfigurationEditor.addRow(code, 'Wide', { Width: 1200 }));
    expect(newCode).toContain(`  configurations({\n    Wide: { Width: 1200 },\n  });\n  const width`);
  });

  it('appends a row to an existing multi-line table, quoting a non-identifier name', async () => {
    const newCode = ok(await ConfigurationEditor.addRow(TABLE, 'Tall one', { Depth: 900, Label: "it's" }));
    expect(newCode).toContain([
      `    'Extra Wide': { Width: base * 2, Note: 'it\\'s wide', Holes: [1, 2, 'x'] },`,
      `    'Tall one': { Depth: 900, Label: 'it\\'s' },`,
      `  });`,
    ].join('\n'));
  });

  it('appends to a multi-line table without trailing commas, and to a one-line table', async () => {
    const noComma = `assembly('a', () => {\n  configurations({\n    A: { X: 1 }\n  });\n});\n`;
    expect(ok(await ConfigurationEditor.addRow(noComma, 'B', { X: 2 })))
      .toBe(`assembly('a', () => {\n  configurations({\n    A: { X: 1 },\n    B: { X: 2 }\n  });\n});\n`);
    const oneLine = `assembly('a', () => {\n  configurations({ A: { X: 1 } });\n});\n`;
    expect(ok(await ConfigurationEditor.addRow(oneLine, 'B')))
      .toBe(`assembly('a', () => {\n  configurations({ A: { X: 1 }, B: {} });\n});\n`);
    const empty = `assembly('a', () => {\n  configurations({});\n});\n`;
    expect(ok(await ConfigurationEditor.addRow(empty, 'B', { X: 2 })))
      .toBe(`assembly('a', () => {\n  configurations({ B: { X: 2 } });\n});\n`);
  });

  it('refuses a duplicate name, the reserved Default, an empty name and a bad value', async () => {
    expect(failure(await ConfigurationEditor.addRow(TABLE, 'Compact'))).toBe('a configuration named "Compact" already exists');
    expect(failure(await ConfigurationEditor.addRow(TABLE, 'Default')))
      .toBe('"Default" is reserved for the param() literals — pick another name');
    expect(failure(await ConfigurationEditor.addRow(TABLE, '  '))).toBe('a configuration needs a name');
    expect(failure(await ConfigurationEditor.addRow(TABLE, 'X', { Width: NaN }))).toBe("Parameter 'Width' has an unsupported value.");
  });

  it('refuses a file without a definition body, two assembly() bodies, and a non-literal table', async () => {
    expect(failure(await ConfigurationEditor.addRow(`const x = 1;\n`, 'Wide')))
      .toBe('Editing configurations requires a part() or assembly() callback body in the current file.');
    const two = `assembly('a', () => {});\nassembly('b', () => {});\n`;
    expect(failure(await ConfigurationEditor.addRow(two, 'Wide')))
      .toBe('Editing configurations requires a single assembly() callback body in the current file.');
    expect(failure(await ConfigurationEditor.addRow(`assembly('a', () => {\n  configurations(rows);\n});\n`, 'Wide')))
      .toBe('the configurations() table is not an object literal — edit it in the code instead');
  });
});

describe('ConfigurationEditor.setCells', () => {
  it('rewrites named cells as literals and adds missing ones, leaving expressions alone', async () => {
    const newCode = ok(await ConfigurationEditor.setCells(TABLE, 'Extra Wide', { Note: 'wide', Depth: 800 }));
    expect(newCode).toContain(`    'Extra Wide': { Width: base * 2, Note: 'wide', Holes: [1, 2, 'x'], Depth: 800 },`);
    expect(newCode).toContain(`    Compact: { Width: 500, Depth: 600, Lid: false },`);
  });

  it('replaces an expression cell when that label is set, and fills an empty row', async () => {
    const replaced = ok(await ConfigurationEditor.setCells(TABLE, 'Extra Wide', { Width: 1400 }));
    expect(replaced).toContain(`    'Extra Wide': { Width: 1400, Note: 'it\\'s wide', Holes: [1, 2, 'x'] },`);
    const empty = `assembly('a', () => {\n  configurations({ A: {} });\n});\n`;
    expect(ok(await ConfigurationEditor.setCells(empty, 'A', { 'Guide Width': 12 })))
      .toBe(`assembly('a', () => {\n  configurations({ A: { 'Guide Width': 12 } });\n});\n`);
  });

  it('rewrites a shorthand cell into a pair', async () => {
    const code = `part('p', () => {\n  configurations({ A: { Width } });\n});\n`;
    expect(ok(await ConfigurationEditor.setCells(code, 'A', { Width: 3 })))
      .toBe(`part('p', () => {\n  configurations({ A: { Width: 3 } });\n});\n`);
  });

  it('refuses an unknown row, a file without a table, and a row that is no literal', async () => {
    expect(failure(await ConfigurationEditor.setCells(TABLE, 'Wide', { Width: 1 })))
      .toBe('no configuration named "Wide" — is the file in sync with the last render?');
    expect(failure(await ConfigurationEditor.setCells(NO_TABLE, 'Wide', { Width: 1 })))
      .toBe('this file has no configurations() table yet');
    const ref = `assembly('a', () => {\n  configurations({ A: rowA });\n});\n`;
    expect(failure(await ConfigurationEditor.setCells(ref, 'A', { Width: 1 })))
      .toBe('the configuration "A" is not written as an object literal — edit it in the code instead');
  });
});

describe('ConfigurationEditor.unsetCells', () => {
  it('removes cells wherever they sit, and leaves an emptied row as {}', async () => {
    const first = ok(await ConfigurationEditor.unsetCells(TABLE, 'Compact', ['Width', 'Missing']));
    expect(first).toContain(`    Compact: { Depth: 600, Lid: false },`);
    const last = ok(await ConfigurationEditor.unsetCells(TABLE, 'Extra Wide', ['Holes']));
    expect(last).toContain(`    'Extra Wide': { Width: base * 2, Note: 'it\\'s wide' },`);
    const all = ok(await ConfigurationEditor.unsetCells(TABLE, 'Compact', ['Width', 'Depth', 'Lid']));
    expect(all).toContain(`    Compact: {},`);
    expect(all).toContain(`'Extra Wide': { Width: base * 2,`);
  });

  it('takes a cell on its own line with the line', async () => {
    const code = `part('p', () => {\n  configurations({\n    A: {\n      X: 1,\n      Y: 2,\n    },\n  });\n});\n`;
    expect(ok(await ConfigurationEditor.unsetCells(code, 'A', ['X'])))
      .toBe(`part('p', () => {\n  configurations({\n    A: {\n      Y: 2,\n    },\n  });\n});\n`);
  });
});

describe('ConfigurationEditor.renameRow', () => {
  it('rewrites the key, bare or quoted as the new name needs', async () => {
    const quoted = ok(await ConfigurationEditor.renameRow(TABLE, 'Compact', 'Small box'));
    expect(quoted).toContain(`    'Small box': { Width: 500, Depth: 600, Lid: false },`);
    const bare = ok(await ConfigurationEditor.renameRow(TABLE, 'Extra Wide', 'Wide'));
    expect(bare).toContain(`    Wide: { Width: base * 2, Note: 'it\\'s wide', Holes: [1, 2, 'x'] },`);
  });

  it('refuses a taken name, Default, and a missing row', async () => {
    expect(failure(await ConfigurationEditor.renameRow(TABLE, 'Compact', 'Extra Wide')))
      .toBe('a configuration named "Extra Wide" already exists');
    expect(failure(await ConfigurationEditor.renameRow(TABLE, 'Compact', 'Default')))
      .toBe('"Default" is reserved for the param() literals — pick another name');
    expect(failure(await ConfigurationEditor.renameRow(TABLE, 'Nope', 'X')))
      .toBe('no configuration named "Nope" — is the file in sync with the last render?');
  });
});

describe('ConfigurationEditor.removeRow', () => {
  it('removes a row with its line', async () => {
    const newCode = ok(await ConfigurationEditor.removeRow(TABLE, 'Compact'));
    expect(newCode).toContain([
      `  const configuration = configurations({`,
      `    'Extra Wide': { Width: base * 2, Note: 'it\\'s wide', Holes: [1, 2, 'x'] },`,
      `  });`,
    ].join('\n'));
    expect(newCode).not.toContain('Compact:');
  });

  it('removes a row of a one-line table with its separator', async () => {
    const code = `assembly('a', () => {\n  configurations({ A: { X: 1 }, B: { X: 2 } });\n});\n`;
    expect(ok(await ConfigurationEditor.removeRow(code, 'B')))
      .toBe(`assembly('a', () => {\n  configurations({ A: { X: 1 } });\n});\n`);
    expect(ok(await ConfigurationEditor.removeRow(code, 'A')))
      .toBe(`assembly('a', () => {\n  configurations({ B: { X: 2 } });\n});\n`);
  });

  it('leaves configurations({}) when the last row goes but the body reads the result', async () => {
    const one = ok(await ConfigurationEditor.removeRow(TABLE, 'Extra Wide'));
    const newCode = ok(await ConfigurationEditor.removeRow(one, 'Compact'));
    expect(newCode).toContain(`  const configuration = configurations({});\n  const width = param('Width', 700);`);
    expect(newCode).toContain(`import { assembly, configurations, param, insert } from 'fluidcad/core';`);
  });

  it('removes the statement and its import with the last row when the result is unbound', async () => {
    const code = [
      `import { assembly, configurations, param } from 'fluidcad/core';`,
      ``,
      `export const frame = assembly('frame', () => {`,
      `  configurations({`,
      `    Wide: { Width: 1200 },`,
      `  });`,
      `  const width = param('Width', 700);`,
      `});`,
      ``,
    ].join('\n');
    expect(ok(await ConfigurationEditor.removeRow(code, 'Wide'))).toBe([
      `import { assembly, param } from 'fluidcad/core';`,
      ``,
      `export const frame = assembly('frame', () => {`,
      `  const width = param('Width', 700);`,
      `});`,
      ``,
    ].join('\n'));
  });

  it('removes the statement with the last row when the binding is never read', async () => {
    const code = TABLE.replace(`  if (configuration === 'Compact') {\n    insert(lid);\n  }\n`, `  insert(lid);\n`);
    const one = ok(await ConfigurationEditor.removeRow(code, 'Compact'));
    const newCode = ok(await ConfigurationEditor.removeRow(one, 'Extra Wide'));
    expect(newCode).toBe([
      `import { assembly, param, insert } from 'fluidcad/core';`,
      ``,
      `export const frame = assembly('frame', () => {`,
      `  const width = param('Width', 700);`,
      `  insert(lid);`,
      `});`,
      ``,
    ].join('\n'));
  });

  it('keeps the import when another configurations() call remains in the file', async () => {
    const code = `import { assembly, configurations } from 'fluidcad/core';\nconst other = () => configurations({});\nexport const a = assembly('a', () => {\n  configurations({ Wide: {} });\n});\n`;
    const newCode = ok(await ConfigurationEditor.removeRow(code, 'Wide'));
    expect(newCode).toBe(`import { assembly, configurations } from 'fluidcad/core';\nconst other = () => configurations({});\nexport const a = assembly('a', () => {\n});\n`);
  });

  it('refuses a missing row', async () => {
    expect(failure(await ConfigurationEditor.removeRow(TABLE, 'Nope')))
      .toBe('no configuration named "Nope" — is the file in sync with the last render?');
  });
});

describe('ConfigurationEditor.applyTable', () => {
  it('composes sets, unsets, a rename and a new row into one rewrite, expressions untouched', async () => {
    const newCode = ok(await ConfigurationEditor.applyTable(TABLE, {
      renames: { Compact: 'Small' },
      rows: {
        Small: { Width: 450, Lid: null },
        'Extra Wide': { Depth: 900 },
        Tall: { Height: 2000, Lid: true, Ignored: null },
      },
    }));
    expect(newCode).toContain([
      `  const configuration = configurations({`,
      `    Small: { Width: 450, Depth: 600 },`,
      `    'Extra Wide': { Width: base * 2, Note: 'it\\'s wide', Holes: [1, 2, 'x'], Depth: 900 },`,
      `    Tall: { Height: 2000, Lid: true },`,
      `  });`,
    ].join('\n'));
    expect(newCode).not.toContain('Ignored');
  });

  it('is the same code as the primitives applied one after another', async () => {
    let expected = ok(await ConfigurationEditor.renameRow(TABLE, 'Compact', 'Small'));
    expected = ok(await ConfigurationEditor.setCells(expected, 'Small', { Depth: 650 }));
    expected = ok(await ConfigurationEditor.unsetCells(expected, 'Small', ['Lid']));
    expect(ok(await ConfigurationEditor.applyTable(TABLE, {
      renames: { Compact: 'Small' },
      rows: { Small: { Depth: 650, Lid: null } },
    }))).toBe(expected);
  });

  it('turns null into an unset — the row keeps {} — and leaves rows it does not name alone', async () => {
    const newCode = ok(await ConfigurationEditor.applyTable(TABLE, { rows: { Compact: { Width: null, Depth: null, Lid: null } } }));
    expect(newCode).toContain(`    Compact: {},`);
    expect(newCode).toContain(`    'Extra Wide': { Width: base * 2, Note: 'it\\'s wide', Holes: [1, 2, 'x'] },`);
  });

  it('writes an expression cell the grid did change, verbatim', async () => {
    const newCode = ok(await ConfigurationEditor.applyTable(TABLE, { rows: { Compact: { Width: { expr: 'base + 10' } } } }));
    expect(newCode).toContain(`    Compact: { Width: base + 10, Depth: 600, Lid: false },`);
  });

  it('removes rows, swaps two names, and lets a removed name be reused', async () => {
    const swapped = ok(await ConfigurationEditor.applyTable(TABLE, {
      renames: { Compact: 'Extra Wide', 'Extra Wide': 'Compact' },
      rows: {},
    }));
    expect(swapped).toContain(`    'Extra Wide': { Width: 500, Depth: 600, Lid: false },\n    Compact: { Width: base * 2,`);
    const reused = ok(await ConfigurationEditor.applyTable(TABLE, {
      removed: ['Compact'],
      renames: { 'Extra Wide': 'Compact' },
      rows: { Compact: { Depth: 1 } },
    }));
    expect(reused).toContain(`  const configuration = configurations({\n    Compact: { Width: base * 2, Note: 'it\\'s wide', Holes: [1, 2, 'x'], Depth: 1 },\n  });`);
  });

  it('creates the statement for the first row, and is a no-op on an empty commit', async () => {
    const created = ok(await ConfigurationEditor.applyTable(NO_TABLE, { rows: { Wide: { Width: 1200, Lid: null } } }));
    expect(created).toContain(`  const configuration = configurations({\n    Wide: { Width: 1200 },\n  });`);
    expect(ok(await ConfigurationEditor.applyTable(TABLE, { rows: {} }))).toBe(TABLE);
  });

  it('refuses up front — unknown rows, clashes, reserved names, bad values — leaving the code untouched', async () => {
    expect(failure(await ConfigurationEditor.applyTable(TABLE, { rows: {}, removed: ['Nope'] })))
      .toBe('no configuration named "Nope" — is the file in sync with the last render?');
    expect(failure(await ConfigurationEditor.applyTable(TABLE, { rows: {}, renames: { Compact: 'Extra Wide' } })))
      .toBe('a configuration named "Extra Wide" already exists');
    expect(failure(await ConfigurationEditor.applyTable(TABLE, { rows: {}, renames: { Compact: 'Default' } })))
      .toBe('"Default" is reserved for the param() literals — pick another name');
    expect(failure(await ConfigurationEditor.applyTable(TABLE, { rows: { Default: { Width: 1 } } })))
      .toBe('"Default" is reserved for the param() literals — pick another name');
    expect(failure(await ConfigurationEditor.applyTable(TABLE, { rows: {}, renames: { Compact: 'X' }, removed: ['Compact'] })))
      .toBe('the configuration "Compact" cannot be both renamed and removed');
    expect(failure(await ConfigurationEditor.applyTable(TABLE, { rows: { Compact: { Width: Number.NaN } } })))
      .toBe(`Parameter 'Width' has an unsupported value.`);
    const ref = `assembly('a', () => {\n  configurations(rows);\n});\n`;
    expect(failure(await ConfigurationEditor.applyTable(ref, { rows: { A: { X: 1 } } })))
      .toBe('the configurations() table is not an object literal — edit it in the code instead');
  });

  it('rides apply() as the table kind', async () => {
    const result = await ConfigurationEditor.apply(TABLE, { kind: 'table', rows: { Compact: { Depth: 610 } } });
    expect(result.error).toBeUndefined();
    expect(result.newCode).toContain(`    Compact: { Width: 500, Depth: 610, Lid: false },`);
  });
});

// A part file with two part() bodies (plans/part-configurations-research.md
// D1): one table per body, rows file-wide, each body's cells in its own
// table. Plate and Lid both declare Width — two parameters.
const TWO_PARTS = [
  `import { part, param, configurations, extrude } from 'fluidcad/core';`,
  ``,
  `export const plate = part('Plate', () => {`,
  `  const configuration = configurations({`,
  `    Wide: { Width: 80 },`,
  `    Thin: { Depth: 2 },`,
  `  });`,
  `  const width = param('Width', 40);`,
  `  const depth = param('Depth', 5);`,
  `  extrude(width);`,
  `});`,
  ``,
  `export const lid = part('Lid', () => {`,
  `  const width = param('Width', 20);`,
  `  extrude(width);`,
  `});`,
  ``,
].join('\n');

/** Lid with its own table: Wide (also Plate's) and Cap (Lid's alone). */
const BOTH_TABLES = TWO_PARTS.replace(
  `export const lid = part('Lid', () => {\n`,
  `export const lid = part('Lid', () => {\n  configurations({\n    Wide: { Width: 30 },\n    Cap: { Width: 25 },\n  });\n`,
);

describe('ConfigurationEditor — several part() bodies', () => {
  it('reads one table per body, named by its part', async () => {
    const tables = await ConfigurationEditor.readTables(BOTH_TABLES);
    expect(tables.map((t) => [t.body, t.line, Object.keys(t.rows)])).toEqual([
      ['Plate', 4, ['Wide', 'Thin']],
      ['Lid', 14, ['Wide', 'Cap']],
    ]);
    expect(tables[1].rows.Wide).toEqual({ Width: { literal: 30, text: '30' } });
  });

  it('adds a row with each part\'s cells in its own table, creating the table a part lacks first in its body', async () => {
    const newCode = ok(await ConfigurationEditor.addRow(TWO_PARTS, 'Big', [
      { body: 'Plate', values: { Width: 90 } },
      { body: 'Lid', values: { Width: 45 } },
    ]));
    expect(newCode).toBe([
      `import { part, param, configurations, extrude } from 'fluidcad/core';`,
      ``,
      `export const plate = part('Plate', () => {`,
      `  const configuration = configurations({`,
      `    Wide: { Width: 80 },`,
      `    Thin: { Depth: 2 },`,
      `    Big: { Width: 90 },`,
      `  });`,
      `  const width = param('Width', 40);`,
      `  const depth = param('Depth', 5);`,
      `  extrude(width);`,
      `});`,
      ``,
      `export const lid = part('Lid', () => {`,
      `  const configuration = configurations({`,
      `    Big: { Width: 45 },`,
      `  });`,
      `  const width = param('Width', 20);`,
      `  extrude(width);`,
      `});`,
      ``,
    ].join('\n'));
  });

  it('leaves out of a part\'s table a row that sets nothing there, and pulls the import in for a first table', async () => {
    const bare = TWO_PARTS.replace(/  const configuration = configurations\(\{\n[^]*?\n  \}\);\n/, '')
      .replace('param, configurations, extrude', 'param, extrude');
    const newCode = ok(await ConfigurationEditor.addRow(bare, 'Big', [{ body: 'Lid', values: { Width: 45 } }]));
    expect(newCode).toContain(`import { configurations, part, param, extrude } from 'fluidcad/core';`);
    expect(newCode).toContain(`export const plate = part('Plate', () => {\n  const width = param('Width', 40);`);
    expect(newCode).toContain(`export const lid = part('Lid', () => {\n  const configuration = configurations({\n    Big: { Width: 45 },\n  });`);
  });

  it('puts a row with no cells into the named part — by name or by its part() line — and refuses one with no home', async () => {
    const byName = ok(await ConfigurationEditor.addRow(TWO_PARTS, 'Blank', [], { body: 'Lid' }));
    expect(byName).toContain(`part('Lid', () => {\n  const configuration = configurations({\n    Blank: {},\n  });`);
    const byLine = ok(await ConfigurationEditor.addRow(TWO_PARTS, 'Blank', {}, { part: { line: 13, column: 20 } }));
    expect(byLine).toBe(byName);
    const toPlate = ok(await ConfigurationEditor.addRow(TWO_PARTS, 'Blank', {}, { body: 'Plate' }));
    expect(toPlate).toContain(`    Thin: { Depth: 2 },\n    Blank: {},\n  });`);
    expect(failure(await ConfigurationEditor.addRow(TWO_PARTS, 'Blank')))
      .toBe('this file has several part() bodies — name the part whose configurations() table to write');
    expect(failure(await ConfigurationEditor.addRow(TWO_PARTS, 'Blank', {}, { body: 'Hinge' })))
      .toBe('no part() named "Hinge" in this file — is the file in sync with the last render?');
  });

  it('refuses a name any table has', async () => {
    expect(failure(await ConfigurationEditor.addRow(BOTH_TABLES, 'Cap', [], { body: 'Plate' })))
      .toBe('a configuration named "Cap" already exists');
  });

  it('saves into a row file-wide: set where a table has it, added where a table lacks it', async () => {
    const newCode = ok(await ConfigurationEditor.setCells(BOTH_TABLES, 'Thin', [
      { body: 'Plate', values: { Depth: 3 } },
      { body: 'Lid', values: { Width: 18 } },
    ]));
    expect(newCode).toContain(`    Thin: { Depth: 3 },\n  });\n  const width = param('Width', 40);`);
    expect(newCode).toContain(`    Cap: { Width: 25 },\n    Thin: { Width: 18 },\n  });`);
    expect(failure(await ConfigurationEditor.setCells(BOTH_TABLES, 'Huge', [{ body: 'Lid', values: { Width: 1 } }])))
      .toBe('no configuration named "Huge" — is the file in sync with the last render?');
  });

  it('renames a row in every table that has it, refusing a name any table has', async () => {
    const newCode = ok(await ConfigurationEditor.renameRow(BOTH_TABLES, 'Wide', 'Broad'));
    expect(newCode).toContain(`    Broad: { Width: 80 },\n    Thin: { Depth: 2 },`);
    expect(newCode).toContain(`    Broad: { Width: 30 },\n    Cap: { Width: 25 },`);
    expect(newCode).not.toContain('Wide');
    expect(failure(await ConfigurationEditor.renameRow(BOTH_TABLES, 'Thin', 'Cap')))
      .toBe('a configuration named "Cap" already exists');
    expect(failure(await ConfigurationEditor.renameRow(BOTH_TABLES, 'Cap', 'Thin')))
      .toBe('a configuration named "Thin" already exists');
  });

  it('removes a row from every table; a table it empties goes, and the import stays while another body has one', async () => {
    const lidOnlyWide = BOTH_TABLES.replace(`    Cap: { Width: 25 },\n`, '');
    const newCode = ok(await ConfigurationEditor.removeRow(lidOnlyWide, 'Wide'));
    expect(newCode).toContain(`import { part, param, configurations, extrude } from 'fluidcad/core';`);
    expect(newCode).toContain(`  const configuration = configurations({\n    Thin: { Depth: 2 },\n  });`);
    expect(newCode).toContain(`export const lid = part('Lid', () => {\n  const width = param('Width', 20);`);
  });

  it('drops the import once the last table of the file goes', async () => {
    const code = [
      `import { part, param, configurations } from 'fluidcad/core';`,
      `export const a = part('A', () => {`,
      `  configurations({ Wide: { Width: 2 } });`,
      `  const width = param('Width', 1);`,
      `});`,
      `export const b = part('B', () => {`,
      `  configurations({ Wide: { Width: 4 } });`,
      `  const width = param('Width', 3);`,
      `});`,
      ``,
    ].join('\n');
    expect(ok(await ConfigurationEditor.removeRow(code, 'Wide'))).toBe([
      `import { part, param } from 'fluidcad/core';`,
      `export const a = part('A', () => {`,
      `  const width = param('Width', 1);`,
      `});`,
      `export const b = part('B', () => {`,
      `  const width = param('Width', 3);`,
      `});`,
      ``,
    ].join('\n'));
  });

  it('commits a grid across both tables as one rewrite', async () => {
    const newCode = ok(await ConfigurationEditor.applyTable(BOTH_TABLES, {
      renames: { Wide: 'Broad' },
      removed: ['Cap'],
      bodies: [
        { body: 'Plate', rows: { Broad: { Width: null, Depth: 4 }, Tall: { Depth: 9 } } },
        { body: 'Lid', rows: { Thin: { Width: 15 }, Broad: { Width: 33 }, Empty: { Width: null } } },
      ],
      home: { body: 'Lid' },
    }));
    expect(newCode).toContain([
      `  const configuration = configurations({`,
      `    Broad: { Depth: 4 },`,
      `    Thin: { Depth: 2 },`,
      `    Tall: { Depth: 9 },`,
      `  });`,
    ].join('\n'));
    expect(newCode).toContain([
      `  configurations({`,
      `    Broad: { Width: 33 },`,
      `    Thin: { Width: 15 },`,
      `    Empty: {},`,
      `  });`,
    ].join('\n'));
  });

  it('refuses a grid commit whose rename clashes in another table, untouched', async () => {
    expect(failure(await ConfigurationEditor.applyTable(BOTH_TABLES, { rows: {}, renames: { Thin: 'Cap' } })))
      .toBe('a configuration named "Cap" already exists');
  });

  it('refuses a file whose parts cannot be told apart', async () => {
    const twins = TWO_PARTS.replace(`part('Lid'`, `part('Plate'`);
    const message = 'Two part() bodies in this file are named "Plate", so their configurations cannot be told apart — give each part its own name to edit configurations.';
    expect(failure(await ConfigurationEditor.addRow(twins, 'Big', [{ body: 'Plate', values: { Width: 1 } }]))).toBe(message);
    expect(failure(await ConfigurationEditor.renameRow(twins, 'Wide', 'Broad'))).toBe(message);
    expect(await ConfigurationEditor.readTables(twins)).toEqual([]);
  });

  it('rides apply() with per-body cells and a home', async () => {
    const added = await ConfigurationEditor.apply(TWO_PARTS, {
      kind: 'add', name: 'Big', bodies: [{ body: 'Lid', part: { line: 13, column: 20 }, values: { Width: 45 } }],
    });
    expect(added.error).toBeUndefined();
    expect(added.newCode).toContain(`    Big: { Width: 45 },`);
    const saved = await ConfigurationEditor.apply(TWO_PARTS, { kind: 'set', name: 'Wide', bodies: [{ part: { line: 13, column: 20 }, values: { Width: 50 } }] });
    expect(saved.error).toBeUndefined();
    expect(saved.newCode).toContain(`part('Lid', () => {\n  const configuration = configurations({\n    Wide: { Width: 50 },\n  });`);
  });
});

describe('ConfigurationEditor — a single body is written as before', () => {
  it('a single part() file takes its row the same with or without the part named', async () => {
    const code = `import { part, param } from 'fluidcad/core';\nexport const p = part('Plate', () => {\n  const w = param('Width', 1);\n});\n`;
    const plain = ok(await ConfigurationEditor.addRow(code, 'Wide', { Width: 2 }));
    expect(plain).toBe(`import { configurations, part, param } from 'fluidcad/core';\nexport const p = part('Plate', () => {\n  const configuration = configurations({\n    Wide: { Width: 2 },\n  });\n  const w = param('Width', 1);\n});\n`);
    expect(ok(await ConfigurationEditor.addRow(code, 'Wide', [{ body: 'Plate', part: { line: 2, column: 17 }, values: { Width: 2 } }]))).toBe(plain);
  });

  it('an assembly file\'s table is the assembly body\'s, whatever name the request gives it', async () => {
    const plain = ok(await ConfigurationEditor.addRow(NO_TABLE, 'Wide', { Width: 1200 }));
    expect(ok(await ConfigurationEditor.addRow(NO_TABLE, 'Wide', [{ body: 'frame', values: { Width: 1200 } }]))).toBe(plain);
    expect(ok(await ConfigurationEditor.addRow(NO_TABLE, 'Wide', [{ body: 'Frame', values: { Width: 1200 } }]))).toBe(plain);
  });
});
