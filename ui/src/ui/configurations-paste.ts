/**
 * A spreadsheet range pasted into the Manage-configurations grid, matched to
 * the grid's rows and columns and checked before anything changes.
 *
 * - With a header row (its first line names at least one parameter), the
 *   columns match by label in any order, and the first column, if it names
 *   no parameter, holds the configuration names. Each row then lands on the
 *   configuration of that name, or adds one.
 * - In a grid whose columns come from several parts (`GridColumns`), a
 *   title names a part's parameter as `Part · Label` (also `Part / Label`,
 *   `Part: Label` or `Part.Label`, any case). A bare label still names the
 *   one column with that label; a label two parts declare is ambiguous on
 *   its own and refuses the paste, naming the titles that would match.
 * - Without one, the range lands where it is pasted: from the anchor cell
 *   rightwards and downwards. Rows past the last
 *   configuration are added.
 *
 * Columns that match no parameter, or run past the grid's last one, are
 * ignored with a warning, as are expression cells (edit them in the code)
 * and a pasted Default row. A value its parameter cannot take, or a name
 * that is reserved or taken, refuses the whole paste: nothing changes.
 */

import type { CatalogParamValue } from '../api';
import type { UIParamDefinition } from '../types';
import { configurationNameProblem } from './configuration-dialogs';
import { DEFAULT_CONFIGURATION, GridColumns, type GridCellRef, type GridRow } from './configurations-grid-model';
import { ParamTextParser } from './param-text-parser';

/** What the paste does to one grid row. */
export type PastedRow = {
  /** The row it lands on, or null to add one. */
  target: GridRow | null;
  /** The name it gives the row; absent keeps the target's, or leaves a new row to be named by the grid. */
  name?: string;
  /** Column key (part + label) → the literal to set, or null to clear the cell back to inherit. */
  cells: Map<string, CatalogParamValue | null>;
};

export type PastePlan = { rows: PastedRow[]; warnings: string[] };

type Column =
  | { kind: 'name' }
  | { kind: 'param'; param: UIParamDefinition }
  | { kind: 'extra'; title: string };

type Columns = { header: boolean; list: Column[]; warnings: string[] };

/** What a header title names: one column, several (a label two parts declare), or none. */
type TitleMatch = { param: UIParamDefinition } | { ambiguous: UIParamDefinition[] } | undefined;

export class ConfigurationsPaste {
  /** How many ignored column titles a warning names before it says "…". */
  private static readonly LISTED_TITLES = 3;
  /** What may stand between a part's name and a label in a title: `Plate · Width`, `Plate / Width`, `Plate: Width`, `Plate.Width`. */
  private static readonly PART_SEPARATORS = ['·', '/', ':', '.'];

  /** The grid's columns, grouped by part. */
  private readonly grid: GridColumns;
  private readonly params: UIParamDefinition[];

  constructor(
    params: UIParamDefinition[],
    private readonly rows: readonly GridRow[],
  ) {
    this.grid = new GridColumns(params);
    this.params = this.grid.params;
  }

  plan(table: string[][], anchor: GridCellRef): PastePlan | { error: string } {
    const columns = this.columns(table, anchor);
    if ('error' in columns) {
      return columns;
    }
    const body = columns.header ? table.slice(1) : table;
    const byName = columns.header && columns.list[0]?.kind === 'name';
    const nameColumn = columns.list.findIndex((column) => column.kind === 'name');
    const errors: string[] = [];
    const pastedNames = new Set<string>();
    const rows: PastedRow[] = [];
    let expressionsKept = 0;
    let defaultSkipped = false;

    body.forEach((cells, index) => {
      const blank = cells.every((text) => text.trim() === '');
      const nameText = nameColumn >= 0 ? (cells[nameColumn] ?? '').trim() : '';
      let target: GridRow | null;
      if (byName) {
        if (blank) {
          return;
        }
        if (nameText === DEFAULT_CONFIGURATION) {
          defaultSkipped = true;
          return;
        }
        if (nameText !== '' && pastedNames.has(nameText)) {
          errors.push(`“${nameText}” is pasted twice.`);
          return;
        }
        pastedNames.add(nameText);
        target = nameText === '' ? null : this.rows.find((row) => row.name.trim() === nameText) ?? null;
      } else {
        target = this.rows[anchor.row + index] ?? null;
        if (target === null && blank) {
          return;
        }
      }

      const row: PastedRow = { target, cells: new Map() };
      if (nameText !== '' && nameText !== target?.name.trim()) {
        row.name = nameText;
      }
      const rowLabel = nameText || target?.name.trim() || `Pasted row ${index + 1}`;
      columns.list.forEach((column, j) => {
        const text = cells[j];
        if (column.kind !== 'param' || text === undefined) {
          return;
        }
        const key = GridColumns.keyOf(column.param);
        if (target?.cells.get(key)?.kind === 'expr') {
          expressionsKept++;
          return;
        }
        const parsed = ParamTextParser.parse(column.param, text);
        if ('error' in parsed) {
          errors.push(`${rowLabel}, ${this.grid.title(column.param)}: ${parsed.error}.`);
        } else {
          row.cells.set(key, parsed.value);
        }
      });
      rows.push(row);
    });

    errors.push(...this.nameProblems(rows));
    if (errors.length > 0) {
      const more = errors.length > 1 ? ` (${ConfigurationsPaste.count(errors.length - 1, 'more problem')})` : '';
      return { error: `Nothing was pasted — ${errors[0]}${more}` };
    }

    const warnings = [...columns.warnings];
    if (defaultSkipped) {
      warnings.push(`Skipped the ${DEFAULT_CONFIGURATION} row — it is the parameters' own values.`);
    }
    if (expressionsKept > 0) {
      warnings.push(`Kept ${ConfigurationsPaste.count(expressionsKept, 'expression cell')} — edit them in the code.`);
    }
    return { rows, warnings };
  }

  // -------------------------------------------------------------------------
  // Columns
  // -------------------------------------------------------------------------

  private columns(table: string[][], anchor: GridCellRef): Columns | { error: string } {
    const header = table.length > 1 && table[0].some((title) => this.match(title) !== undefined);
    return header ? this.headerColumns(table) : this.positionalColumns(table, anchor.column);
  }

  /** A header row: each title names a parameter, the names (first column only), or nothing the grid has. */
  private headerColumns(table: string[][]): Columns | { error: string } {
    const titles = table[0];
    const width = ConfigurationsPaste.width(table);
    const list: Column[] = [];
    const seen = new Set<string>();
    for (let j = 0; j < width; j++) {
      const title = (titles[j] ?? '').trim();
      const match = this.match(title);
      if (match && 'ambiguous' in match) {
        const choices = match.ambiguous.map((param) => `“${this.grid.title(param)}”`).join(' or ');
        const parts = match.ambiguous.map((param) => param.body).join(' and ');
        return { error: `Nothing was pasted — “${title}” is a parameter of ${parts}: title the column ${choices}.` };
      }
      if (match && 'param' in match) {
        const { param } = match;
        const key = GridColumns.keyOf(param);
        if (seen.has(key)) {
          return { error: `Nothing was pasted — the column “${this.grid.title(param)}” is pasted twice.` };
        }
        seen.add(key);
        list.push({ kind: 'param', param });
      } else if (j === 0) {
        list.push({ kind: 'name' });
      } else {
        list.push({ kind: 'extra', title });
      }
    }
    const ignored = list
      .map((column, j) => ({ column, j }))
      .filter(({ column, j }) => column.kind === 'extra' && ConfigurationsPaste.hasContent(table, j));
    const warnings: string[] = [];
    if (ignored.length > 0) {
      const titles = ignored.map(({ column }) => (column.kind === 'extra' && column.title !== '' ? `“${column.title}”` : 'an untitled one'));
      const listed = titles.slice(0, ConfigurationsPaste.LISTED_TITLES).join(', ')
        + (titles.length > ConfigurationsPaste.LISTED_TITLES ? ', …' : '');
      warnings.push(`Ignored ${ConfigurationsPaste.count(ignored.length, 'column')} that match no parameter: ${listed}.`);
    }
    return { header: true, list, warnings };
  }

  /** No header: the columns run from the anchor's, and those past the last parameter are dropped. */
  private positionalColumns(table: string[][], start: number): Columns {
    const width = ConfigurationsPaste.width(table);
    const list: Column[] = [];
    for (let j = 0; j < width; j++) {
      const column = start + j;
      if (column === 0) {
        list.push({ kind: 'name' });
      } else if (column <= this.params.length) {
        list.push({ kind: 'param', param: this.params[column - 1] });
      } else {
        list.push({ kind: 'extra', title: '' });
      }
    }
    const ignored = list.filter((column, j) => column.kind === 'extra' && ConfigurationsPaste.hasContent(table, j)).length;
    const last = this.params.length > 0 ? `“${this.grid.title(this.params[this.params.length - 1])}”` : 'the names';
    const warnings = ignored > 0
      ? [`Ignored ${ConfigurationsPaste.count(ignored, 'column')} past ${last}, the grid's last column.`]
      : [];
    return { header: false, list, warnings };
  }

  /**
   * The column a title names: a part's parameter as `Part · Label` (any of
   * the {@link PART_SEPARATORS}, spaces around it optional, any case), else
   * a bare label — exact, else ignoring case — which is ambiguous when two
   * parts' columns carry it.
   */
  private match(title: string): TitleMatch {
    const text = title.trim();
    const lower = text.toLowerCase();
    if (this.grid.grouped) {
      const qualified = this.params.find((param) => param.body !== undefined
        && ConfigurationsPaste.PART_SEPARATORS.some((separator) =>
          ConfigurationsPaste.qualifiedTitle(param.body!, separator, param.label) === ConfigurationsPaste.squeeze(lower, separator)));
      if (qualified) {
        return { param: qualified };
      }
    }
    for (const same of [(param: UIParamDefinition) => param.label === text, (param: UIParamDefinition) => param.label.toLowerCase() === lower]) {
      const found = this.params.filter(same);
      if (found.length === 1) {
        return { param: found[0] };
      }
      if (found.length > 1) {
        return { ambiguous: found };
      }
    }
    return undefined;
  }

  /** `part<separator>label` lower-cased, with no space around the separator — what {@link squeeze} makes of a title. */
  private static qualifiedTitle(part: string, separator: string, label: string): string {
    return `${part.trim()}${separator}${label.trim()}`.toLowerCase();
  }

  /** A lower-cased title with the spaces around its first `separator` dropped. */
  private static squeeze(title: string, separator: string): string {
    const at = title.indexOf(separator);
    if (at === -1) {
      return title;
    }
    return `${title.slice(0, at).trim()}${separator}${title.slice(at + separator.length).trim()}`;
  }

  // -------------------------------------------------------------------------
  // Rows
  // -------------------------------------------------------------------------

  /** Every name the paste gives, checked against the names the grid would hold after it. */
  private nameProblems(pasted: PastedRow[]): string[] {
    const finalNames = new Map<GridRow, string>(this.rows.map((row) => [row, row.name.trim()]));
    for (const row of pasted) {
      if (row.target && row.name !== undefined) {
        finalNames.set(row.target, row.name);
      }
    }
    const names = [
      ...finalNames.values(),
      ...pasted.filter((row) => row.target === null && row.name !== undefined).map((row) => row.name!),
    ];
    const problems = new Set<string>();
    for (const row of pasted) {
      if (row.name === undefined) {
        continue;
      }
      const others = [...names];
      others.splice(others.indexOf(row.name), 1);
      const problem = configurationNameProblem(row.name, others);
      if (problem) {
        problems.add(problem);
      }
    }
    return Array.from(problems);
  }

  // -------------------------------------------------------------------------
  // Text
  // -------------------------------------------------------------------------

  private static width(table: string[][]): number {
    return table.reduce((width, row) => Math.max(width, row.length), 0);
  }

  private static hasContent(table: string[][], column: number): boolean {
    return table.some((row) => (row[column] ?? '').trim() !== '');
  }

  private static count(n: number, noun: string): string {
    return `${n} ${noun}${n === 1 ? '' : 's'}`;
  }
}
