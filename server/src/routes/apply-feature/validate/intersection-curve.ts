// intersection curve request validation.

import { INTERSECTION_CURVE_ROWS, type IntersectionCurveRow } from '../../../apply-feature-edit/index.ts';
import { OperandInputs, type RowInputs } from '../operand-inputs.ts';

/**
 * The intersection curve request: the picks of its two rows, each a
 * surface whole (by its statement's call site) or a face of a body. The
 * tool has no options.
 */
export type IntersectionCurveRequest = {
  rows: RowInputs<IntersectionCurveRow>;
};

/** An edit of an intersection curve: the rows re-picked; an absent row keeps the statement's own. */
export type IntersectionCurveEditRequest = {
  rows: Partial<RowInputs<IntersectionCurveRow>>;
};

export function validateIntersectionCurve(body: unknown): IntersectionCurveRequest | { error: string } {
  const rows = OperandInputs.validateRows(body, INTERSECTION_CURVE_ROWS.kinds);
  return 'error' in rows ? rows : { rows };
}

/**
 * An edit's two rows: each absent or `{kind: "keep"}` to keep the
 * statement's own argument, else its new picks.
 */
export function validateIntersectionCurveEdit(body: unknown): IntersectionCurveEditRequest | { error: string } {
  const rows = OperandInputs.validateRowEdits(body, INTERSECTION_CURVE_ROWS.kinds);
  return 'error' in rows ? rows : { rows };
}
