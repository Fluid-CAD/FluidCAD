import type { ParamDefinition, ParamOverrides, ParamScope, ParamVal } from "../param-registry.js";

/**
 * Shared plumbing for definition parameter overrides — used by
 * `PartDefinition`, `Assembly`, and `insert()` so parts and sub-assemblies
 * validate, merge, key, and warn identically.
 */

function isOverrideValue(value: unknown): value is ParamVal {
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return true;
  }
  if (Array.isArray(value)) {
    return value.every(v => typeof v === 'string' || typeof v === 'number');
  }
  return false;
}

/** Reject override maps whose values could never come out of a `param()` call. */
export function validateParamOverrides(context: string, overrides: ParamOverrides): void {
  if (overrides === null || typeof overrides !== 'object' || Array.isArray(overrides)) {
    throw new Error(`${context}: parameter overrides must be a plain object of { label: value }.`);
  }
  for (const [label, value] of Object.entries(overrides)) {
    if (!isOverrideValue(value)) {
      throw new Error(
        `${context}: parameter '${label}' must be a number, string, boolean, `
        + `or array of numbers/strings — got ${value === null ? 'null' : typeof value}.`,
      );
    }
  }
}

/** The map a definition build's scope runs under. */
export function toOverrideMap(overrides?: ParamOverrides): Map<string, ParamVal> {
  return new Map(overrides ? Object.entries(overrides) : []);
}

/**
 * Stable identity of one parameter assignment — the variant cache key.
 * Label-sorted so `{A, B}` and `{B, A}` share a template.
 */
export function canonicalVariantKey(overrides: ReadonlyMap<string, ParamVal>): string {
  const entries = Array.from(overrides.entries()).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return JSON.stringify(entries);
}

/**
 * Wire-shape a build's collected definitions: sourceLocation points into the
 * defining file and serves the params PANEL's declaration edits — the
 * template/occurrence payloads only need the control metadata.
 */
export function serializableParamDefs(defs: Iterable<ParamDefinition>): Omit<ParamDefinition, 'sourceLocation'>[] {
  return Array.from(defs, ({ sourceLocation: _sourceLocation, ...def }) => def);
}

/** label → resolved value of a build's collected definitions. */
export function collectedParamValues(scope: ParamScope): Record<string, ParamVal> {
  const values: Record<string, ParamVal> = {};
  for (const [label, def] of scope.collected) {
    values[label] = def.currentValue;
  }
  return values;
}

/**
 * Override keys the build never resolved. A warning, not an error: a key can
 * legitimately target a `param()` in a branch the current values don't take
 * (e.g. `Length` declared only under one `Size`).
 */
export function warnUnknownOverrides(kind: 'part' | 'assembly', name: string, scope: ParamScope): void {
  const unknown = Array.from(scope.overrides.keys()).filter(label => !scope.consumed.has(label));
  if (unknown.length === 0) {
    return;
  }
  const declared = Array.from(scope.consumed);
  console.warn(
    `${kind} '${name}': unknown parameter override${unknown.length > 1 ? 's' : ''} `
    + `${unknown.map(l => `'${l}'`).join(', ')} — this build declared `
    + `${declared.length > 0 ? declared.map(l => `'${l}'`).join(', ') : 'no parameters'}.`,
  );
}
