import type { SourceLocation } from "../common/scene-object.js";
import type { ParamVal } from "../param-registry.js";
import { isParamValue } from "./param-overrides.js";

/**
 * One `property('Label', 'name', value)` declaration of a part body — a
 * value the part computes from its parameters and publishes as its scalar
 * interface, under a name the code reads it by and a label the panel shows.
 * Stored on the built `Part` variant (never a scene object: it has no
 * geometry and no build order), so an inserted variant's properties are the
 * values ITS parameters produced. Numbers are handed over verbatim, in the
 * part file's unit, like a `param()` override — converting is the
 * consumer's business.
 */
export type PartProperty = {
  /** What the parameters panel shows for the row. */
  label: string;
  /** The identifier `instance.properties.<name>` / `def.properties.<name>` read. */
  name: string;
  value: ParamVal;
  /** Where the `property()` call was authored — what the parameters panel addresses. */
  sourceLocation?: SourceLocation;
};

/**
 * The record `instance.properties` / `def.properties` serve: each value a
 * `property()` published, by name. Every value IS a {@link ParamVal} at
 * runtime, but the record types each one as `any`: which name holds a
 * number and which a string is decided inside the part's callback, where
 * no static type flows back to the definition, and typing every value as
 * the whole union would refuse the arithmetic these values exist for
 * (`box1.properties.internalWidth - 20`) in every checked assembly file.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type PropertyValues = Record<string, any>;

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
