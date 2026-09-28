import { captureSourceLocation } from "../index.js";
import { getCurrentScene } from "../scene-manager.js";
import { SceneObject } from "../common/scene-object.js";
import { MEMBER_NAME_PATTERN } from "../selection/types.js";
import type { ParamVal } from "../param-registry.js";
import { isPropertyValue } from "../features/part-property.js";
import type { PartProperty } from "../features/part-property.js";

/**
 * Publishes a named value computed by the part — the part's scalar
 * interface, the outbound counterpart of `param()` (values in), beside
 * `connector()` (mate frames out) and `expose()` (geometry out). Declared
 * inside a `part(...)` block, the property is recorded on the variant the
 * body is building, so an insert with overrides reads the values its own
 * parameters produced:
 *
 *     export const bushing = part('Bushing', () => {
 *       const width = param('Width', 40);
 *       const wall = param('Wall', 3);
 *       ...
 *       property('internalWidth', width - 2 * wall);
 *       property('boltCount', 4);
 *     });
 *
 *     // assembly:
 *     const b = insert(bushing, { Width: 60 });
 *     insert(plate, { Width: b.properties.internalWidth });   // 54
 *
 *     // another part (the default variant):
 *     const w = bushing.properties.internalWidth;
 *
 * Values are plain: a number, string, boolean, or an array of numbers or
 * strings. Numbers are handed over verbatim, in the part file's unit, like
 * a `param()` override. Geometry is not a value — publish it with
 * `expose()`. Nothing is built while the body runs, so a property is
 * computed from the part's parameters and arithmetic, never measured from
 * its shapes.
 *
 * @param name - Identifier the property is registered under, unique within the part.
 * @param value - The value to publish. Returned unchanged, so the statement
 *   doubles as the declaration of a local: `const w = property('w', ...)`.
 */
export default function property<T extends ParamVal>(name: string, value: T): T {
  const scene = getCurrentScene();
  const part = scene?.getActivePart() ?? null;
  if (!part) {
    throw new Error(
      "property() must be called inside a part() block — properties are the part's "
      + "value interface; consumers read them as instance.properties.<name>.",
    );
  }
  if (typeof name !== "string" || !MEMBER_NAME_PATTERN.test(name)) {
    const got = typeof name === "string" ? JSON.stringify(name) : `a ${typeof name}`;
    throw new Error(
      `property(): the first argument is the property's name — a plain identifier like 'internalWidth' (got ${got}).`,
    );
  }
  if (part.getProperties().some(p => p.name === name)) {
    throw new Error(
      `property(): the part "${part.partName}" already declares "${name}" — names must be unique within a part.`,
    );
  }
  if (value instanceof SceneObject) {
    throw new Error(
      `property('${name}'): geometry is not a value — publish a sketch, selection, plane, axis or feature with expose('${name}', source).`,
    );
  }
  if (!isPropertyValue(value)) {
    const got = value === null ? "null" : typeof value;
    throw new Error(
      `property('${name}'): the value must be a number, string, boolean, or array of numbers/strings — got ${got}. `
      + "Properties are computed from the part's parameters; nothing is built while the body runs.",
    );
  }

  const record: PartProperty = { name, value };
  const sourceLocation = captureSourceLocation();
  if (sourceLocation) {
    record.sourceLocation = sourceLocation;
  }
  part.addProperty(record);
  return value;
}
