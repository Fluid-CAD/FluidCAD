// Dialog value slots: the number-or-expression type every option field uses, its validators and its renderers.

import { isExpressionText } from '../code-editor.ts';

/**
 * A dialog numeric slot: a plain number, or verbatim expression text
 * (`height`, `h * 2`) committed by a dialog's expression field. Expressions
 * render as-is into the statement; the build surfaces evaluation errors.
 */
export type ValueExpr = number | string;

/**
 * One `.region()` argument: a key naming a region by the statements on its
 * outer loop (`'b r t l'`), or a position in the sketch's region list.
 */
export type RegionKey = string | number;

/** A repeat count slot: an integer of at least 2, or safe expression text. */
export function validCountValue(value: unknown): value is ValueExpr {
  if (typeof value === 'number') {
    return Number.isInteger(value) && value >= 2;
  }
  return isExpressionText(value);
}

/**
 * Validate one ValueExpr slot: a finite number meeting the constraints, or
 * safe expression text (constraints can't be checked statically there — the
 * build reports them).
 */
export function validValueExpr(
  value: unknown,
  opts: { nonzero?: boolean; positive?: boolean } = {},
): value is ValueExpr {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      return false;
    }
    if (opts.nonzero && value === 0) {
      return false;
    }
    if (opts.positive && value <= 0) {
      return false;
    }
    return true;
  }
  return isExpressionText(value);
}

export function formatNumber(value: number | undefined): string {
  return Number.isFinite(value) ? String(value) : '1';
}

/** A ValueExpr slot's rendering: a number literal, or the expression verbatim. */
export function formatValue(value: ValueExpr | undefined | null): string {
  if (typeof value === 'string') {
    return value.trim();
  }
  return formatNumber(value ?? undefined);
}

export function validEditThin(thin: unknown): thin is [ValueExpr] | [ValueExpr, ValueExpr] | null {
  if (thin === null) {
    return true;
  }
  return Array.isArray(thin) && thin.length >= 1 && thin.length <= 2
    && thin.every(t => validValueExpr(t, { nonzero: true }));
}

/** A sweep `.extend()` amount: absent or null writes no chain; a value must be positive. */
export function validEditExtend(amount: unknown): amount is ValueExpr | null | undefined {
  return amount === undefined || amount === null || validValueExpr(amount, { positive: true });
}

export function validNonzeroOrNull(value: unknown): value is ValueExpr | null {
  return value === null || validValueExpr(value, { nonzero: true });
}

/** A nullable ValueExpr slot: null (the option is omitted) or a valid value. */
export function validValueExprOrNull(
  value: unknown,
  opts: { nonzero?: boolean; positive?: boolean } = {},
): value is ValueExpr | null {
  return value === null || validValueExpr(value, opts);
}
