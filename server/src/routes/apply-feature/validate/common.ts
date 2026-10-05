// Request fields shared across features: thin offsets, new variable declarations, profile kinds and kept slots.

import { validValueExpr, type ValueExpr } from '../../../apply-feature-edit/index.ts';

/** One or two non-zero `.thin()` offsets (signs pick sides); absent means a plain feature. */
export function validateThinOffsets(thin: unknown): { offsets: [ValueExpr] | [ValueExpr, ValueExpr] | null } | { error: string } {
  if (thin === undefined || thin === null) {
    return { offsets: null };
  }
  const valid = Array.isArray(thin) && thin.length >= 1 && thin.length <= 2
    && thin.every((t: unknown) => validValueExpr(t, { nonzero: true }));
  if (!valid) {
    return { error: 'thin must be one or two non-zero offsets or expressions' };
  }
  return { offsets: thin.length === 1 ? [thin[0]] : [thin[0], thin[1]] };
}

const NEW_VAR_NAME_RE = /^[a-zA-Z_$][\w$]*$/;

/**
 * The `newVariables` a dialog's expression fields committed (`myVar = 50`):
 * declarations to write directly before the statement. Absent/empty is fine.
 */
export function validateNewVariables(
  raw: unknown,
): { newVariables: { name: string; initializer: string }[] | undefined } | { error: string } {
  if (raw === undefined || raw === null) {
    return { newVariables: undefined };
  }
  if (!Array.isArray(raw) || raw.length > 16) {
    return { error: 'newVariables must be up to 16 {name, initializer} declarations' };
  }
  const newVariables: { name: string; initializer: string }[] = [];
  for (const entry of raw as { name?: unknown; initializer?: unknown }[]) {
    if (typeof entry?.name !== 'string' || !NEW_VAR_NAME_RE.test(entry.name)
      || !validValueExpr(entry?.initializer)
      || typeof entry.initializer !== 'string' || entry.initializer.trim() === '') {
      return { error: 'each newVariables entry must be a valid {name, initializer}' };
    }
    newVariables.push({ name: entry.name, initializer: entry.initializer.trim() });
  }
  return { newVariables: newVariables.length > 0 ? newVariables : undefined };
}

/**
 * The extrude profile's callee: a sketch (the default), or a top-level face
 * offset — extrudable exactly like a sketch, bound with its own hint.
 */
export function validateProfileFeature(raw: unknown): 'sketch' | 'offset' | null {
  if (raw === undefined || raw === null || raw === 'sketch') {
    return 'sketch';
  }
  return raw === 'offset' ? 'offset' : null;
}

/** A `keep`-or-absent slot value: true when the field re-sources nothing. */
export function isKeepSlot(raw: any): boolean {
  return raw === undefined || raw === null
    || raw?.mode === 'keep' || raw?.kind === 'keep';
}
