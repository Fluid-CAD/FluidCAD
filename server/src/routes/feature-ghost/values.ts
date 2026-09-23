// Ghost request value slots: numbers or expression text, and the thin-wall pair.

/** A dialog numeric slot on the wire: a number, or verbatim expression text. */
export type ValueExpr = number | string;

export function isValueExpr(value: unknown): value is ValueExpr {
  return (typeof value === 'number' && Number.isFinite(value))
    || (typeof value === 'string' && value.trim() !== '');
}

export function isValueExprOrNull(value: unknown): value is ValueExpr | null {
  return value === null || value === undefined || isValueExpr(value);
}

export function isThin(value: unknown): value is [ValueExpr] | [ValueExpr, ValueExpr] | null {
  if (value === null || value === undefined) {
    return true;
  }
  return Array.isArray(value) && value.length >= 1 && value.length <= 2 && value.every(isValueExpr);
}
