// intersection curve request validation.

import { OperandInputs, type OperandInput } from '../operand-inputs.ts';
import { isKeepSlot } from './common.ts';

/**
 * The intersection curve request: the picks of its two rows, each a
 * surface whole (by its statement's call site) or a face of a body. The
 * tool has no options.
 */
export type IntersectionCurveRequest = {
  first: OperandInput[];
  second: OperandInput[];
};

export function validateIntersectionCurve(body: any): IntersectionCurveRequest | { error: string } {
  const first = OperandInputs.validate(body?.first, 'surface', 'first');
  if ('error' in first) {
    return first;
  }
  const second = OperandInputs.validate(body?.second, 'surface', 'second');
  if ('error' in second) {
    return second;
  }
  return { first, second };
}

/**
 * An edit's two rows: each absent or `{kind: "keep"}` to keep the
 * statement's own argument, else its new picks.
 */
export function validateIntersectionCurveEdit(
  body: any,
): { first?: OperandInput[]; second?: OperandInput[] } | { error: string } {
  const slots: { first?: OperandInput[]; second?: OperandInput[] } = {};
  for (const slot of ['first', 'second'] as const) {
    if (isKeepSlot(body?.[slot])) {
      continue;
    }
    const inputs = OperandInputs.validate(body[slot], 'surface', slot);
    if ('error' in inputs) {
      return inputs;
    }
    slots[slot] = inputs;
  }
  return slots;
}
