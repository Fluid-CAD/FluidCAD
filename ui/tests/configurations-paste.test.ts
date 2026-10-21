import { describe, expect, it } from 'vitest';

// A spreadsheet range planned onto the Manage-configurations grid: header
// rows match columns by label and rows by name, header-less ranges land at
// the anchor cell; extra columns are a warning, bad values and names
// refuse the whole paste.

import { ConfigurationsPaste, type PastedRow } from '../src/ui/configurations-paste';
import type { Cell, GridRow } from '../src/ui/configurations-grid-model';
import type { UIParamDefinition } from '../src/types';

const PARAMS: UIParamDefinition[] = [
  { label: 'Width', kind: 'assembly', defaultValue: 700, currentValue: 700, controlType: 'number', min: 100, max: 2000 },
  { label: 'Lid', kind: 'assembly', defaultValue: true, currentValue: true, controlType: 'checkbox' },
  {
    label: 'Finish', kind: 'assembly', defaultValue: 'raw', currentValue: 'raw', controlType: 'select',
    options: [{ label: 'Raw', value: 'raw' }, { label: 'Painted', value: 'paint' }],
  },
];

function gridRow(name: string, cells: Record<string, Cell> = {}): GridRow {
  const map = new Map(Object.entries(cells));
  return { original: name, name, cells: map, initial: new Map(map) };
}

function rows(): GridRow[] {
  return [
    gridRow('Compact', { Width: { kind: 'literal', value: 500 } }),
    gridRow('Wide', { Width: { kind: 'expr', text: 'base * 2' } }),
  ];
}

/** A plan's rows as plain data: the target's name (or null), the new name, the cells. */
function summary(pasted: PastedRow[]) {
  return pasted.map((row) => ({
    target: row.target?.name ?? null,
    ...(row.name !== undefined ? { name: row.name } : {}),
    cells: Object.fromEntries(row.cells),
  }));
}

function plan(table: string[][], anchor = { row: 0, column: 0 }, grid = rows()) {
  return new ConfigurationsPaste(PARAMS, grid).plan(table, anchor);
}

describe('ConfigurationsPaste with a header row', () => {
  it('matches columns by label in any order and rows by name, adding the unknown ones', () => {
    const result = plan([
      ['Configuration', 'finish', 'Width'],
      ['Compact', 'Painted', '600'],
      ['Tall', 'raw', ''],
    ]);
    if ('error' in result) {
      throw new Error(result.error);
    }
    expect(summary(result.rows)).toEqual([
      { target: 'Compact', cells: { Finish: 'paint', Width: 600 } },
      { target: null, name: 'Tall', cells: { Finish: 'raw', Width: null } },
    ]);
    expect(result.warnings).toEqual([]);
  });

  it('ignores columns that match no parameter, with a warning naming them', () => {
    const result = plan([
      ['Name', 'Width', 'Colour', 'Notes', '', 'Cost', 'Weight'],
      ['Compact', '650', 'red', 'small', '', '3', '9'],
    ]);
    if ('error' in result) {
      throw new Error(result.error);
    }
    expect(summary(result.rows)).toEqual([{ target: 'Compact', cells: { Width: 650 } }]);
    expect(result.warnings).toEqual(['Ignored 4 columns that match no parameter: “Colour”, “Notes”, “Cost”, ….']);
  });

  it('skips a pasted Default row and blank rows, keeps expression cells, and says so', () => {
    const result = plan([
      ['Configuration', 'Width', 'Lid'],
      ['Default', '700', 'yes'],
      ['', '', ''],
      ['Wide', '1400', 'no'],
    ]);
    if ('error' in result) {
      throw new Error(result.error);
    }
    expect(summary(result.rows)).toEqual([{ target: 'Wide', cells: { Lid: false } }]);
    expect(result.warnings).toEqual([
      'Skipped the Default row — it is the parameters\' own values.',
      'Kept 1 expression cell — edit them in the code.',
    ]);
  });

  it('without a name column, lays the rows from the anchor row down', () => {
    const result = plan([['Lid', 'Width'], ['no', '900'], ['yes', '950']], { row: 1, column: 3 });
    if ('error' in result) {
      throw new Error(result.error);
    }
    expect(summary(result.rows)).toEqual([
      { target: 'Wide', cells: { Lid: false } },
      { target: null, cells: { Lid: true, Width: 950 } },
    ]);
  });

  it('refuses a column pasted twice, and a row pasted twice', () => {
    expect(plan([['Name', 'Width', 'width'], ['Compact', '1', '2']])).toEqual({
      error: 'Nothing was pasted — the column “Width” is pasted twice.',
    });
    expect(plan([['Name', 'Width'], ['Compact', '600'], ['Compact', '650']])).toEqual({
      error: 'Nothing was pasted — “Compact” is pasted twice.',
    });
  });
});

describe('ConfigurationsPaste without a header row', () => {
  it('lands at the anchor cell, renaming through the name column and adding rows past the end', () => {
    const result = plan([['Small', '400'], ['Big', '1800'], ['Huge', '2000']], { row: 0, column: 0 });
    if ('error' in result) {
      throw new Error(result.error);
    }
    expect(summary(result.rows)).toEqual([
      { target: 'Compact', name: 'Small', cells: { Width: 400 } },
      { target: 'Wide', name: 'Big', cells: {} },
      { target: null, name: 'Huge', cells: { Width: 2000 } },
    ]);
    expect(result.warnings).toEqual(['Kept 1 expression cell — edit them in the code.']);
  });

  it('ignores the columns past the last parameter, with a warning', () => {
    const result = plan([['yes', 'raw', 'x', 'y'], ['no', 'paint', '', 'z']], { row: 0, column: 2 });
    if ('error' in result) {
      throw new Error(result.error);
    }
    expect(summary(result.rows)).toEqual([
      { target: 'Compact', cells: { Lid: true, Finish: 'raw' } },
      { target: 'Wide', cells: { Lid: false, Finish: 'paint' } },
    ]);
    expect(result.warnings).toEqual(['Ignored 2 columns past “Finish”, the grid\'s last column.']);
  });

  it('does not warn about blank columns past the end, nor add rows for blank lines', () => {
    const result = plan([['yes', 'raw', ''], ['', '', '']], { row: 1, column: 2 });
    if ('error' in result) {
      throw new Error(result.error);
    }
    expect(summary(result.rows)).toEqual([{ target: 'Wide', cells: { Lid: true, Finish: 'raw' } }]);
    expect(result.warnings).toEqual([]);
  });

  it('leaves the cells a short row does not reach', () => {
    const result = plan([['650', 'no', 'raw'], ['1200']], { row: 0, column: 1 });
    if ('error' in result) {
      throw new Error(result.error);
    }
    expect(summary(result.rows)).toEqual([
      { target: 'Compact', cells: { Width: 650, Lid: false, Finish: 'raw' } },
      { target: 'Wide', cells: {} },
    ]);
  });
});

describe('ConfigurationsPaste validation', () => {
  it('refuses the whole paste over a value its parameter cannot take, counting the rest', () => {
    expect(plan([['Name', 'Width', 'Lid'], ['Compact', 'wide', 'maybe'], ['Tall', '5000', 'yes']])).toEqual({
      error: 'Nothing was pasted — Compact, Width: “wide” is not a number. (2 more problems)',
    });
  });

  it('names a header-less row by its target when it carries no name', () => {
    expect(plan([['maybe']], { row: 0, column: 2 })).toEqual({
      error: 'Nothing was pasted — Compact, Lid: “maybe” is not yes or no.',
    });
  });

  it('refuses names that are reserved or taken once the paste lands', () => {
    expect(plan([['Default']], { row: 1, column: 0 })).toEqual({
      error: 'Nothing was pasted — Default is reserved — it is the parameters\' own values.',
    });
    expect(plan([['Wide', '600']], { row: 0, column: 0 })).toEqual({
      error: 'Nothing was pasted — A configuration named “Wide” already exists.',
    });
  });

  it('allows names that only swap between the pasted rows', () => {
    const result = plan([['Wide'], ['Compact']], { row: 0, column: 0 });
    expect('error' in result).toBe(false);
  });
});
