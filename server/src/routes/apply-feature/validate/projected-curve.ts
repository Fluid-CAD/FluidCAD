// projected curve request validation.

import {
  DIRECTION_WITH_NORMAL,
  PROJECTION_KEEPS,
  PROJECTION_MODES,
  type ProjectionKeep,
  type ProjectionMode,
} from '../../../apply-feature-edit/index.ts';
import { DirectionInputs, type DirectionInput } from '../direction-inputs.ts';
import { OperandInputs, type OperandInput } from '../operand-inputs.ts';
import { isKeepSlot } from './common.ts';

/**
 * The projected curve request: the picks of its source row (sketches and
 * curves whole by their statements' call sites, edges of bodies) and its
 * target row (surfaces whole, faces of bodies), how each point travels,
 * the direction — null for none, the normal of the plane the source lies
 * in — and which images stay.
 */
export type ProjectedCurveRequest = {
  source: OperandInput[];
  target: OperandInput[];
  mode: ProjectionMode;
  direction: DirectionInput | null;
  keep: ProjectionKeep;
};

/**
 * An edit's direction: absent, null or `{kind: "keep"}` keeps the
 * statement's own `.direction(…)` as written, `{kind: "cleared"}` drops it,
 * anything else is the new direction.
 */
export type ProjectedCurveDirectionInput = DirectionInput | { kind: 'cleared' };

/** An edit of a projected curve: each part absent keeps the statement's own. */
export type ProjectedCurveEditRequest = {
  source?: OperandInput[];
  target?: OperandInput[];
  mode?: ProjectionMode;
  direction?: ProjectedCurveDirectionInput;
  keep?: ProjectionKeep;
};

/** `.mode()` / `.keep()`: absent reads as the default (the first word); anything else must be one of the words. */
function validateChoice<T extends string>(
  raw: unknown,
  name: string,
  choices: readonly T[],
  fallback: T | undefined,
): { value: T | undefined } | { error: string } {
  if (raw === undefined || raw === null) {
    return { value: fallback };
  }
  return (choices as readonly unknown[]).includes(raw)
    ? { value: raw as T }
    : { error: `${name} must be ${choices.map(choice => `"${choice}"`).join(' or ')}` };
}

export function validateProjectedCurve(body: any): ProjectedCurveRequest | { error: string } {
  const source = OperandInputs.validate(body?.source, 'curve', 'source');
  if ('error' in source) {
    return source;
  }
  const target = OperandInputs.validate(body?.target, 'surface', 'target');
  if ('error' in target) {
    return target;
  }
  const mode = validateChoice(body?.mode, 'mode', PROJECTION_MODES, PROJECTION_MODES[0]);
  if ('error' in mode) {
    return mode;
  }
  const keep = validateChoice(body?.keep, 'keep', PROJECTION_KEEPS, PROJECTION_KEEPS[0]);
  if ('error' in keep) {
    return keep;
  }
  let direction: DirectionInput | null = null;
  if (body?.direction !== undefined && body?.direction !== null) {
    const valid = DirectionInputs.validate(body.direction);
    if ('error' in valid) {
      return valid;
    }
    direction = valid;
  }
  // The engine refuses the pair, so the request is refused in its words.
  if (mode.value === 'normal' && direction !== null) {
    return { error: DIRECTION_WITH_NORMAL };
  }
  return { source, target, mode: mode.value!, direction, keep: keep.value! };
}

/**
 * An edit's rows, options and direction: each row absent or `{kind:
 * "keep"}` to keep the statement's own argument, else its new picks; the
 * mode and what is kept absent to keep the statement's; the direction kept,
 * cleared or new. A new direction sent with mode `'normal'` is refused in
 * the engine's words; a kept one is the edit renderer's to refuse, since
 * only the statement says whether it has one.
 */
export function validateProjectedCurveEdit(body: any): ProjectedCurveEditRequest | { error: string } {
  const request: ProjectedCurveEditRequest = {};
  for (const slot of ['source', 'target'] as const) {
    if (isKeepSlot(body?.[slot])) {
      continue;
    }
    const inputs = OperandInputs.validate(body[slot], slot === 'source' ? 'curve' : 'surface', slot);
    if ('error' in inputs) {
      return inputs;
    }
    request[slot] = inputs;
  }
  const mode = validateChoice(body?.mode, 'mode', PROJECTION_MODES, undefined);
  if ('error' in mode) {
    return mode;
  }
  const keep = validateChoice(body?.keep, 'keep', PROJECTION_KEEPS, undefined);
  if ('error' in keep) {
    return keep;
  }
  if (mode.value !== undefined) {
    request.mode = mode.value;
  }
  if (keep.value !== undefined) {
    request.keep = keep.value;
  }
  if (body?.direction?.kind === 'cleared') {
    request.direction = { kind: 'cleared' };
  } else if (!isKeepSlot(body?.direction)) {
    const direction = DirectionInputs.validate(body.direction);
    if ('error' in direction) {
      return direction;
    }
    if (request.mode === 'normal') {
      return { error: DIRECTION_WITH_NORMAL };
    }
    request.direction = direction;
  }
  return request;
}
