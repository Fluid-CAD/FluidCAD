// offset curve request validation.

import {
  OFFSET_CURVE_ROWS,
  offsetCurveDistanceError,
  type OffsetCurveRow,
  type ValueExpr,
} from '../../../apply-feature-edit/index.ts';
import { OperandInputs, type RowInputs } from '../operand-inputs.ts';

/**
 * The offset curve request: its distance — a number or an expression, its
 * sign the side — and the picks of its edges row (sketches and curves whole
 * by their statements' call sites, edges of bodies) and its `on` row
 * (surfaces whole, faces of bodies).
 */
export type OffsetCurveRequest = {
  rows: RowInputs<OffsetCurveRow>;
  distance: ValueExpr;
};

/** An edit of an offset curve: the rows re-picked, and the distance; each absent keeps the statement's own. */
export type OffsetCurveEditRequest = {
  rows: Partial<RowInputs<OffsetCurveRow>>;
  distance?: ValueExpr;
};

/** The distance field of a request body, as sent. */
type DistanceField = { distance?: unknown } | null | undefined;

export function validateOffsetCurve(body: unknown): OffsetCurveRequest | { error: string } {
  const rows = OperandInputs.validateRows(body, OFFSET_CURVE_ROWS.kinds);
  if ('error' in rows) {
    return rows;
  }
  const distance = (body as DistanceField)?.distance;
  const refusal = offsetCurveDistanceError(distance);
  return refusal !== null ? { error: refusal } : { rows, distance: distance as ValueExpr };
}

/**
 * An edit's rows and distance: each row absent or `{kind: "keep"}` to keep
 * the statement's own argument, else its new picks; the distance absent or
 * null to keep the statement's own, else written in its place. A literal
 * zero is refused in the engine's words.
 */
export function validateOffsetCurveEdit(body: unknown): OffsetCurveEditRequest | { error: string } {
  const rows = OperandInputs.validateRowEdits(body, OFFSET_CURVE_ROWS.kinds);
  if ('error' in rows) {
    return rows;
  }
  const distance = (body as DistanceField)?.distance;
  if (distance === undefined || distance === null) {
    return { rows };
  }
  const refusal = offsetCurveDistanceError(distance);
  return refusal !== null ? { error: refusal } : { rows, distance: distance as ValueExpr };
}
