// Parsing loft conditions and connections.

import { isValueExpr, type ValueExpr } from './values.ts';
import { CONDITION_TYPES } from './vocabulary.ts';

/** A takeoff condition before its magnitude is resolved to a number. */
type RawCondition = { type: 'normal' | 'tangent'; magnitude: ValueExpr };

/** A takeoff condition; 'none' never travels, so absent means unconstrained. */
export function parseCondition(value: unknown): RawCondition | null | 'invalid' {
  if (value === null || value === undefined) {
    return null;
  }
  const condition = value as { type?: unknown; magnitude?: unknown };
  if (typeof condition.type !== 'string' || !CONDITION_TYPES.includes(condition.type)
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
