import type { CatalogParamValue } from '../api';

/** The reserved row: the `param()` literals — shown pinned, never a row of the table. */
export const DEFAULT_CONFIGURATION = 'Default';

/** What a grid cell holds: nothing (inherits the literal), a literal, or an expression kept as its source text. */
export type Cell =
  | { kind: 'inherit' }
  | { kind: 'literal'; value: CatalogParamValue }
  | { kind: 'expr'; text: string };

/** One configuration row of the Manage grid. */
export type GridRow = {
  /** The row's name in the source table, or null for a row added in the grid. */
  original: string | null;
  name: string;
  /** Label → cell, for the grid's columns; a column the row does not set is absent (inherit). */
  cells: Map<string, Cell>;
  /** The cells as opened — what a commit diffs against. Empty for a new row. */
  initial: Map<string, Cell>;
};

/** A cell of the grid: a row's index among the configurations, and a column — 0 is the names, 1… the parameters. */
export type GridCellRef = { row: number; column: number };
