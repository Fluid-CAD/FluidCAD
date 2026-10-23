import type { CatalogParamValue } from '../api';
import type { UIParamDefinition } from '../types';
import { paramRowKey } from './param-row';

/** The reserved row: the `param()` literals — shown pinned, never a row of the table. */
export const DEFAULT_CONFIGURATION = 'Default';

/** What a grid cell holds: nothing (inherits the literal), a literal, or an expression kept as its source text. */
export type Cell =
  | { kind: 'inherit' }
  | { kind: 'literal'; value: CatalogParamValue }
  | { kind: 'expr'; text: string };

/** One configuration row of the Manage grid. */
export type GridRow = {
  /** The row's name in the source tables, or null for a row added in the grid. */
  original: string | null;
  name: string;
  /**
   * Column key ({@link GridColumns.keyOf}: the parameter's part + label) →
   * cell; a column the row does not set is absent (inherit).
   */
  cells: Map<string, Cell>;
  /** The cells as opened — what a commit diffs against. Empty for a new row. */
  initial: Map<string, Cell>;
};

/** A cell of the grid: a row's index among the configurations, and a column — 0 is the names, 1… the parameters. */
export type GridCellRef = { row: number; column: number };

/** One part's run of columns: its definition name, and its parameters in grid order. */
export type GridColumnGroup = { body: string | null; params: UIParamDefinition[] };

/**
 * The Manage grid's columns: every parameter a configuration can set,
 * grouped by the part that declares it (plans/part-configurations-research.md
 * D1). Two parts may both declare `Width`, so a column is keyed by part +
 * label — the Parameters panel's row key — and so are the grid's cells and
 * the commit. A grid whose columns all come from one body (a single part,
 * an assembly) is ungrouped: no part header, titles are the bare labels.
 */
export class GridColumns {
  /** The columns, left to right — each part's run kept together, in first-seen order. */
  readonly params: UIParamDefinition[];
  readonly groups: GridColumnGroup[];

  constructor(params: UIParamDefinition[]) {
    const groups: GridColumnGroup[] = [];
    for (const param of params) {
      const body = param.body ?? null;
      const group = groups.find((g) => g.body === body);
      if (group) {
        group.params.push(param);
      } else {
        groups.push({ body, params: [param] });
      }
    }
    this.groups = groups;
    this.params = groups.flatMap((group) => group.params);
  }

  /** A column's key — its parameter's part + label, the label alone for a parameter without a part. */
  static keyOf(param: Pick<UIParamDefinition, 'label' | 'body'>): string {
    return paramRowKey(param);
  }

  /** Whether the header names the parts: the columns come from more than one. */
  get grouped(): boolean {
    return this.groups.length > 1;
  }

  /** The column a key names. */
  byKey(key: string): UIParamDefinition | undefined {
    return this.params.find((param) => GridColumns.keyOf(param) === key);
  }

  /** A column's title where a message names it: `Plate · Width` in a grouped grid, else the label. */
  title(param: UIParamDefinition): string {
    return this.grouped && param.body !== undefined ? `${param.body} · ${param.label}` : param.label;
  }

  /**
   * The column a table's cell goes in. A table filed under a part the grid
   * has columns for matches that part's own parameter only — a stale cell
   * of a part never lands in another part's column. A table with no part
   * the grid knows (a render or source that names none) matches a label
   * exactly one column has.
   */
  keyFor(body: string | null | undefined, label: string): string | undefined {
    if (body !== null && body !== undefined && this.params.some((param) => param.body === body)) {
      const own = this.params.find((param) => param.body === body && param.label === label);
      return own ? GridColumns.keyOf(own) : undefined;
    }
    const matches = this.params.filter((param) => param.label === label);
    return matches.length === 1 ? GridColumns.keyOf(matches[0]) : undefined;
  }
}
