import type { SourceLocation } from "../common/scene-object.js";
import type { ParamVal } from "../param-registry.js";
import { isParamValue } from "./param-overrides.js";

/**
 * How a property's number reads across units. A `'length'` property is in
 * the defining file's unit and is rescaled into the consumer's unit on
 * every read (an inch part's `internalWidth` reads ×25.4 in a millimetre
 * assembly); an untagged value is handed over verbatim, like a `param()`
 * override.
 */
export type PropertyKind = 'length';

export const PROPERTY_KINDS: ReadonlySet<string> = new Set<PropertyKind>(['length']);

/**
 * One `property('name', value)` declaration of a part body — a value the
 * part computes from its parameters and publishes as its scalar interface.
 * Stored on the built `Part` variant (never a scene object: it has no
 * geometry and no build order), so an inserted variant's properties are the
 * values ITS parameters produced.
 */
export type PartProperty = {
  name: string;
  value: ParamVal;
  kind?: PropertyKind;
  /** Where the `property()` call was authored — a future "show in source" hook. */
  sourceLocation?: SourceLocation;
};

/** Whether `value` is something a property may publish: a number, string, boolean, or array of numbers/strings. */
export function isPropertyValue(value: unknown): value is ParamVal {
  return isParamValue(value);
}

/** Whether every element a `'length'` property carries is a finite number. */
export function isLengthValue(value: ParamVal): value is number | number[] {
  if (typeof value === 'number') {
    return Number.isFinite(value);
  }
  return Array.isArray(value) && value.every(v => typeof v === 'number' && Number.isFinite(v));
}

/**
 * The value a consumer reads: a `'length'` property scaled by `factor`
 * (definition unit → consuming unit), anything else verbatim.
 */
export function readPropertyValue(property: PartProperty, factor: number): ParamVal {
  if (property.kind !== 'length' || factor === 1) {
    return property.value;
  }
  const value = property.value;
  if (Array.isArray(value)) {
    return value.map(v => (typeof v === 'number' ? v * factor : v));
  }
  return typeof value === 'number' ? value * factor : value;
}

/** name → consumer-facing value of every property, in declaration order. */
export function propertyValues(properties: Iterable<PartProperty>, factor: number): Record<string, ParamVal> {
  const out: Record<string, ParamVal> = {};
  for (const property of properties) {
    out[property.name] = readPropertyValue(property, factor);
  }
  return out;
}

/** The wire form of a part's properties: the consumer-facing values, or `undefined` when it declares none. */
export function serializedProperties(part: { getPropertyValues(): Record<string, ParamVal> }): Record<string, ParamVal> | undefined {
  const values = part.getPropertyValues();
  return Object.keys(values).length > 0 ? values : undefined;
}
