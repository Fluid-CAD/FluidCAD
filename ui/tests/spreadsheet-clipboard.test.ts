import { describe, expect, it } from 'vitest';

// The text/plain a spreadsheet copy puts on the clipboard: tab-separated
// cells, one line per row, quoted cells for tabs / line breaks / quotes.

import { SpreadsheetClipboard } from '../src/ui/spreadsheet-clipboard';

describe('SpreadsheetClipboard.parse', () => {
  it('splits rows on line breaks and cells on tabs, dropping the trailing line break', () => {
    expect(SpreadsheetClipboard.parse('Name\tWidth\r\nWide\t1400\r\n')).toEqual([['Name', 'Width'], ['Wide', '1400']]);
  });

  it('keeps empty cells, leading and trailing', () => {
    expect(SpreadsheetClipboard.parse('\ta\t\n\t\t')).toEqual([['', 'a', ''], ['', '', '']]);
  });

  it('reads quoted cells holding tabs, line breaks and doubled quotes', () => {
    expect(SpreadsheetClipboard.parse('"two\nlines"\t"a\tb"\t"say ""hi"""\n')).toEqual([['two\nlines', 'a\tb', 'say "hi"']]);
  });

  it('leaves a quote inside an unquoted cell as it is', () => {
    expect(SpreadsheetClipboard.parse('5" pipe\tx')).toEqual([['5" pipe', 'x']]);
  });

  it('is empty for empty text', () => {
    expect(SpreadsheetClipboard.parse('')).toEqual([]);
  });
});

describe('SpreadsheetClipboard.isRange', () => {
  const range = (text: string) => SpreadsheetClipboard.isRange(text, SpreadsheetClipboard.parse(text));

  it('is a range for several cells, or one copied cell with its line break', () => {
    expect(range('a\tb')).toBe(true);
    expect(range('a\nb')).toBe(true);
    expect(range('650\r\n')).toBe(true);
  });

  it('is plain text for a word typed or copied from elsewhere', () => {
    expect(range('650')).toBe(false);
    expect(range('')).toBe(false);
  });
});
