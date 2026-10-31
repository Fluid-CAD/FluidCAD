// Parsing loft conditions and connections.

import type { ChoiceSlot, LoftConditionType } from '../../apply-feature-edit/index.ts';
import { GhostSlots } from './slots.ts';
import { isValueExpr, type ValueExpr } from './values.ts';
import { CONDITION_TYPES } from './vocabulary.ts';

/**
 * What a condition's type may come to for the preview: the two the kernel
 * takes, and `'none'` — an expression that evaluates to it previews as no
 * condition, the way the literal reads in the source.
 */
export const CONDITION_CHOICES = ['none', ...CONDITION_TYPES] as ('none' | LoftConditionType)[];

/** A takeoff condition before its type is resolved to one of the kernel's and its magnitude to a number. */
export type RawCondition = { type: ChoiceSlot<LoftConditionType>; magnitude: ValueExpr };

/**
 * A takeoff condition; 'none' never travels as a literal, so absent means
 * unconstrained. The type is a typed-in slot — a literal of the two, or a
 * reference or an expression the router resolves once the scope is open.
 */
export function parseCondition(value: unknown): RawCondition | null | 'invalid' {
  if (value === null || value === undefined) {
    return null;
  }
  const condition = value as { type?: unknown; magnitude?: unknown };
  if (!GhostSlots.shaped(condition.type, literal => typeof literal === 'string' && CONDITION_TYPES.includes(literal))
    || !isValueExpr(condition.magnitude)) {
    return 'invalid';
  }
  return { type: condition.type as RawCondition['type'], magnitude: condition.magnitude };
}

/** Connections travel as resolved world points, never source expressions. */
export function parseLoftConnections(raw: unknown, profiles: number): [number, number, number][][] | null {
  if (raw === undefined) {
    return [];
  }
  if (!Array.isArray(raw) || !raw.every(connection => Array.isArray(connection)
    && connection.length === profiles && connection.every(point => Array.isArray(point)
      && point.length === 3 && point.every(value => typeof value === 'number' && Number.isFinite(value))))) {
    return null;
  }
  return raw as [number, number, number][][];
}
