import type { NewVariable, Translation, ValueExpr } from '../../api';
import { resolveExpressionValue, type VariableInfo } from '../../ui/expression-core';

/** One world axis — the index of its distance field and of its vector component. */
export type TranslateAxis = 0 | 1 | 2;

export const TRANSLATE_AXES: readonly TranslateAxis[] = [0, 1, 2];

/** One distance field as the dialog reads it: its value, and a declaration it carries. */
export type DistanceRead = { value: ValueExpr; newVariable?: NewVariable };

/**
 * The server's reading of the distances a ghost was stamped at: the values it
 * was asked for, and the numbers it resolved them to where the statement sits.
 */
export type TranslationStamp = { exprs: Translation; values: [number, number, number] };

/**
 * The number one distance field stands for. A literal is itself. An
 * expression reads as the server resolved it for the last ghost while the
 * field still holds that very text — the truth where the statement sits, a
 * configuration's parameter values included — and otherwise as the client's
 * own best-effort arithmetic over the in-scope variables and the field's
 * pending declaration. Null when neither can say.
 */
export function distanceValue(
  read: DistanceRead,
  axis: TranslateAxis,
  variables: VariableInfo[],
  stamp: TranslationStamp | null,
): number | null {
  if (typeof read.value === 'number') {
    return read.value;
  }
  if (stamp && stamp.exprs[axis] === read.value) {
    return stamp.values[axis];
  }
  return resolveExpressionValue(read.value, variables, read.newVariable ?? null);
}

/**
 * The value a distance travels to the ghost as. A field declaring a variable
 * (`gap = 20`) names something the file doesn't hold yet — the server would
 * refuse the name, so the ghost gets the number it is being declared as.
 * Null when that number can't be worked out.
 */
export function ghostDistance(read: DistanceRead, variables: VariableInfo[]): ValueExpr | null {
  if (!read.newVariable) {
    return read.value;
  }
  return resolveExpressionValue(String(read.value), variables, read.newVariable);
}

/** Every distance a literal zero: the dialog at rest — a statement that would move nothing. */
export function isAtRest(translation: Translation): boolean {
  return translation.every(value => value === 0);
}
