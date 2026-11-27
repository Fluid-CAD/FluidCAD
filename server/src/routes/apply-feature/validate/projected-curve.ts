// projected curve request validation.

import {
  DIRECTION_WITH_NORMAL,
  PROJECTED_CURVE_ROWS,
  PROJECTION_KEEP,
  PROJECTION_MODE,
  type ProjectedCurveRow,
  type ProjectionKeep,
  type ProjectionMode,
} from '../../../apply-feature-edit/index.ts';
import { DirectionInputs, type DirectionEditInput, type DirectionInput } from '../direction-inputs.ts';
import { OperandInputs, type RowInputs } from '../operand-inputs.ts';

/**
 * The projected curve request: the picks of its source row (sketches and
 * curves whole by their statements' call sites, edges of bodies) and its
 * target row (surfaces whole, faces of bodies), how each point travels,
 * the direction — null for none, the normal of the plane the source lies
 * in — and which images stay.
 */
export type ProjectedCurveRequest = {
  rows: RowInputs<ProjectedCurveRow>;
  mode: ProjectionMode;
  direction: DirectionInput | null;
  keep: ProjectionKeep;
};

/**
 * An edit's direction: absent, null or `{kind: "keep"}` keeps the
 * statement's own `.direction(…)` as written, `{kind: "cleared"}` drops it,
 * anything else is the new direction.
 */
export type ProjectedCurveDirectionInput = DirectionEditInput;

/** An edit of a projected curve: the rows re-picked, and each option absent keeps the statement's own. */
export type ProjectedCurveEditRequest = {
  rows: Partial<RowInputs<ProjectedCurveRow>>;
  mode?: ProjectionMode;
  direction?: ProjectedCurveDirectionInput;
  keep?: ProjectionKeep;
};

/** The option fields of a request body, as sent. */
type OptionFields = { mode?: unknown; keep?: unknown; direction?: unknown } | null | undefined;

export function validateProjectedCurve(body: unknown): ProjectedCurveRequest | { error: string } {
  const rows = OperandInputs.validateRows(body, PROJECTED_CURVE_ROWS.kinds);
  if ('error' in rows) {
    return rows;
  }
  const options = body as OptionFields;
  const mode = PROJECTION_MODE.fromRequest(options?.mode);
  if ('error' in mode) {
    return mode;
  }
  const keep = PROJECTION_KEEP.fromRequest(options?.keep);
  if ('error' in keep) {
    return keep;
  }
  let direction: DirectionInput | null = null;
  if (options?.direction !== undefined && options?.direction !== null) {
    const valid = DirectionInputs.validate(options.direction);
    if ('error' in valid) {
      return valid;
    }
    direction = valid;
  }
  // The engine refuses the pair, so the request is refused in its words.
  if (mode.value === 'normal' && direction !== null) {
    return { error: DIRECTION_WITH_NORMAL };
  }
  return { rows, mode: mode.value, direction, keep: keep.value };
}

/**
 * An edit's rows, options and direction: each row absent or `{kind:
 * "keep"}` to keep the statement's own argument, else its new picks; the
 * mode and what is kept absent to keep the statement's; the direction kept,
 * cleared or new. A new direction sent with mode `'normal'` is refused in
 * the engine's words; a kept one is the edit renderer's to refuse, since
 * only the statement says whether it has one.
 */
export function validateProjectedCurveEdit(body: unknown): ProjectedCurveEditRequest | { error: string } {
  const rows = OperandInputs.validateRowEdits(body, PROJECTED_CURVE_ROWS.kinds);
  if ('error' in rows) {
    return rows;
  }
  const request: ProjectedCurveEditRequest = { rows };
  const options = body as OptionFields;
  const mode = PROJECTION_MODE.editFromRequest(options?.mode);
  if ('error' in mode) {
    return mode;
  }
  const keep = PROJECTION_KEEP.editFromRequest(options?.keep);
  if ('error' in keep) {
    return keep;
  }
  if (mode.value !== undefined) {
    request.mode = mode.value;
  }
  if (keep.value !== undefined) {
    request.keep = keep.value;
  }
  const direction = DirectionInputs.validateEdit(options?.direction);
  if ('error' in direction) {
    return direction;
  }
  if (direction.edit !== undefined) {
    if (direction.edit.kind !== 'cleared' && request.mode === 'normal') {
      return { error: DIRECTION_WITH_NORMAL };
    }
    request.direction = direction.edit;
  }
  return request;
}
