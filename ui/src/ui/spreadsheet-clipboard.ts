/**
 * The text a spreadsheet puts on the clipboard for a copied range: one line
 * per row, cells separated by tabs. Excel, Numbers and Google Sheets quote a
 * cell that holds a tab, a line break or a quote (`"two\nlines"`, quotes
 * doubled inside), and Excel ends the range with a line break.
 */
export class SpreadsheetClipboard {
  /** The range as rows of cells — ragged when the source rows are. */
  static parse(text: string): string[][] {
    const source = text.replace(/\r\n?/g, '\n');
    const rows: string[][] = [];
    let row: string[] = [];
    let cell = '';
    let quoted = false;
    for (let i = 0; i < source.length; i++) {
      const ch = source[i];
      if (quoted) {
        if (ch !== '"') {
          cell += ch;
        } else if (source[i + 1] === '"') {
          cell += '"';
          i++;
        } else {
          quoted = false;
        }
        continue;
      }
      if (ch === '"' && cell === '') {
        quoted = true;
      } else if (ch === '\t') {
        row.push(cell);
        cell = '';
      } else if (ch === '\n') {
        row.push(cell);
        rows.push(row);
        row = [];
        cell = '';
      } else {
        cell += ch;
      }
    }
    if (cell !== '' || row.length > 0) {
      row.push(cell);
      rows.push(row);
    }
    return rows;
  }

  /**
   * Whether a paste is a spreadsheet range rather than text typed into one
   * field: several cells, or one copied cell (which carries the line break
   * a range ends with).
   */
  static isRange(text: string, table: string[][]): boolean {
    if (table.length === 0) {
      return false;
    }
    return table.length > 1 || table[0].length > 1 || /[\t\n\r]/.test(text);
  }
}
