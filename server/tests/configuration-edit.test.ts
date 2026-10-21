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

describe('ConfigurationEditor.readTable', () => {
  it('reads literal cells as values and expression cells as source text, quoted names included', async () => {
    const table = await ConfigurationEditor.readTable(TABLE);
    expect(table).toEqual({
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
    });
  });

  it('reads a negative number and a shorthand cell', async () => {
    const code = `part('p', () => {\n  configurations({ A: { Offset: -5, Width } });\n});\n`;
    const table = await ConfigurationEditor.readTable(code);
    expect(table?.rows).toEqual({ A: { Offset: { literal: -5, text: '-5' }, Width: { text: 'Width' } } });
  });

  it('is null without a table, without a single body, or for a non-literal argument', async () => {
    expect(await ConfigurationEditor.readTable(NO_TABLE)).toBeNull();
    expect(await ConfigurationEditor.readTable(`const x = 1;\n`)).toBeNull();
    expect(await ConfigurationEditor.readTable(`assembly('a', () => {\n  configurations(rows);\n});\n`)).toBeNull();
  });

  it('finds the table in a single part() body too', async () => {
    const code = `import { part, configurations } from 'fluidcad/core';\nexport const p = part('p', () => {\n  configurations({ Wide: { Width: 1 } });\n});\n`;
    expect((await ConfigurationEditor.readTable(code))?.rows).toEqual({ Wide: { Width: { literal: 1, text: '1' } } });
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

  it('refuses a file without a single definition body, and a non-literal table', async () => {
    expect(failure(await ConfigurationEditor.addRow(`const x = 1;\n`, 'Wide')))
      .toBe('Editing configurations requires a single part() or assembly() callback body in the current file.');
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
