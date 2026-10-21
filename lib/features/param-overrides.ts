import { getParamRegistry, type ParamDefinition, type ParamOverrides, type ParamScope, type ParamVal } from "../param-registry.js";

/**
 * Shared plumbing for definition parameter overrides — used by
 * `PartDefinition`, `Assembly`, and `insert()` so parts and sub-assemblies
 * validate, merge, key, and warn identically.
 */

/** Whether `value` has the shape a `param()` can produce: a scalar or an array of numbers/strings. */
export function isParamValue(value: unknown): value is ParamVal {
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
    if (!isParamValue(value)) {
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
 * (e.g. `Length` declared only under one `Size`). A key that names a project
 * parameter (a `*.params.js` global the live registry holds) is called out
 * as such: a global's value is its declaration's literal, edited in the
 * Parameters panel, and cannot be set per instance.
 */
export function warnUnknownOverrides(kind: 'part' | 'assembly', name: string, scope: ParamScope): void {
  const unknown = Array.from(scope.overrides.keys()).filter(label => !scope.consumed.has(label));
  if (unknown.length > 0) {
    console.warn(
      `${kind} '${name}': unknown parameter override${unknown.length > 1 ? 's' : ''} `
      + `${unknown.map(l => `'${l}'`).join(', ')} — this build declared `
      + `${declaredList(scope.consumed)}.${globalsHint(unknown)}`,
    );
  }
  if (scope.configuration === undefined) {
    return;
  }
  // The name `insert(def, 'Name')` asked for never met a configurations():
  // the body has no table, so nothing could look the row up (a name a table
  // does not declare throws from the body instead).
  if (!scope.configurationValues) {
    console.warn(
      `${kind} '${name}': inserted with configuration '${scope.configuration}', but its body declares no configurations() — the literals were built.`,
    );
    return;
  }
  // The same rule for the row the insert picked: a cell whose label the
  // body never read, with the configuration named so the author knows which
  // table to fix.
  const unread = Array.from(scope.configurationValues.keys()).filter(label => !scope.consumed.has(label));
  if (unread.length > 0) {
    console.warn(
      `${kind} '${name}': configuration '${scope.configuration}' sets unknown parameter${unread.length > 1 ? 's' : ''} `
      + `${unread.map(l => `'${l}'`).join(', ')} — this build declared `
      + `${declaredList(scope.consumed)}.${globalsHint(unread)}`,
    );
  }
}

/**
 * The root-run counterpart: after an entry file rendered with a
 * configuration active, the cells its bodies never resolved through the
 * registry. The host calls this once the evaluation is over, when every
 * `param()` has had its chance to read.
 */
export function warnUnknownConfigurationCells(registry = getParamRegistry()): void {
  const unread = registry.getUnconsumedConfigurationKeys();
  const active = registry.getActiveConfiguration();
  if (unread.length === 0 || active === null) {
    return;
  }
  const declared = new Set(registry.getDefinitions().filter(d => d.kind !== 'global').map(d => d.label));
  console.warn(
    `configuration '${active}' sets unknown parameter${unread.length > 1 ? 's' : ''} `
    + `${unread.map(l => `'${l}'`).join(', ')} — this render declared `
    + `${declaredList(declared)}.${globalsHint(unread, registry)}`,
  );
}

function declaredList(declared: Iterable<string>): string {
  const labels = Array.from(declared);
  return labels.length > 0 ? labels.map(l => `'${l}'`).join(', ') : 'no parameters';
}

/** A key naming a project parameter is called out: a global is never set per instance or per row. */
function globalsHint(labels: string[], registry = getParamRegistry()): string {
  const globals = labels.filter(label => registry.hasGlobal(label));
  if (globals.length === 0) {
    return '';
  }
  return ' '
    + `${globals.map(l => `'${l}'`).join(', ')} `
    + (globals.length > 1 ? 'are project parameters — edit them' : 'is a project parameter — edit it')
    + ' in the Parameters panel, not per instance.';
}
