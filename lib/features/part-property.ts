import type { SourceLocation } from "../common/scene-object.js";
import type { ParamVal } from "../param-registry.js";
import { isParamValue } from "./param-overrides.js";

/**
 * One `property('name', value)` declaration of a part body — a value the
 * part computes from its parameters and publishes as its scalar interface.
 * Stored on the built `Part` variant (never a scene object: it has no
 * geometry and no build order), so an inserted variant's properties are the
 * values ITS parameters produced. Numbers are handed over verbatim, in the
 * part file's unit, like a `param()` override — converting is the
 * consumer's business.
 */
export type PartProperty = {
  name: string;
  value: ParamVal;
  /** Where the `property()` call was authored — what the parameters panel addresses. */
  sourceLocation?: SourceLocation;
};

/** Whether `value` is something a property may publish: a number, string, boolean, or array of numbers/strings. */
export function isPropertyValue(value: unknown): value is ParamVal {
  return isParamValue(value);
}

/** name → value of every property, in declaration order. */
export function propertyValues(properties: Iterable<PartProperty>): Record<string, ParamVal> {
  const out: Record<string, ParamVal> = {};
  for (const property of properties) {
    out[property.name] = property.value;
  }
  return out;
}

/** The wire form of a part's properties: the values by name, or `undefined` when it declares none. */
export function serializedProperties(part: { getPropertyValues(): Record<string, ParamVal> }): Record<string, ParamVal> | undefined {
  const values = part.getPropertyValues();
  return Object.keys(values).length > 0 ? values : undefined;
}
