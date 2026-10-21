// The global-parameters catalog's wire types — what `GET /api/global-params`
// answers and what the `global-params` WebSocket message carries
// (`docs/global-parameters-plan.md` §2.6). The UI codes against these.

import type { LengthUnit } from '../project-config.ts';

/** The control a `param()` declaration asks for — `param()`'s own `type` argument. */
export type GlobalParamControlType = 'number' | 'slider' | 'text' | 'select' | 'checkbox' | 'color';

/** A `param()` default or value: the literal shapes a declaration can hold. */
export type GlobalParamValue = string | number | boolean | (string | number)[];

/** One exported binding of a `*.params.js` file, as the Parameters panel lists it. */
export type GlobalParam = {
  /** Absolute, normalized (`normalizePath`). */
  file: string;
  /** Workspace-relative, forward slashes — what an import names. */
  relPath: string;
  /** The exported identifier — the token an expression reads and an import binds. */
  name: string;
  /** The `param()` label; for a derived export, the same as `name`. */
  label: string;
  controlType: GlobalParamControlType;
  /**
   * The declared default literal. For a derived export this is its evaluated
   * value when one could be read, else the initializer text.
   */
  defaultValue: GlobalParamValue;
  /**
   * What the binding holds: the default for a `param()`, the evaluated
   * initializer for a derived export — null when a derived value could not be
   * evaluated statically (it is computed at render).
   */
  value: GlobalParamValue | null;
  /** `export const x = <expr>` that is not a `param()` call — read-only in the panel. */
  derived: boolean;
  /** The derived initializer's source text. */
  expression?: string;
  /** Whether the value is a number (a `number`/`slider` param, a numeric derived export). */
  numeric: boolean;
  options?: { label: string; value: string | number }[];
  multi?: boolean;
  multiControlType?: 'select' | 'checkboxes' | 'chips';
  min?: number;
  max?: number;
  step?: number;
  group?: string;
  description?: string;
  /** 1-based line of the `param()` call / the initializer. */
  line: number;
  /** 0-based column of the `param()` call / the initializer. */
  column: number;
  /** Lint findings for this row (`docs/global-parameters-plan.md` §2.2). */
  problems?: string[];
};

/** One `*.params.js` file: its rows and the findings that belong to no row. */
export type GlobalParamsFile = {
  file: string;
  relPath: string;
  params: GlobalParam[];
  problems: string[];
};

/** Everything the panel shows: every params file, and the unit its numbers are in (§2.7). */
export type GlobalParamsSnapshot = {
  files: GlobalParamsFile[];
  projectUnit: LengthUnit;
};
