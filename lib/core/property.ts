import { captureSourceLocation } from "../index.js";
import { getCurrentScene } from "../scene-manager.js";
import { SceneObject } from "../common/scene-object.js";
import { MEMBER_NAME_PATTERN } from "../selection/types.js";
import type { ParamVal } from "../param-registry.js";
import { isLengthValue, isPropertyValue, PROPERTY_KINDS } from "../features/part-property.js";
import type { PartProperty, PropertyKind } from "../features/part-property.js";

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
 *       property('internalWidth', width - 2 * wall, 'length');
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
 * strings. Geometry is not a value — publish it with `expose()`. Nothing is
 * built while the body runs, so a property is computed from the part's
 * parameters and arithmetic, never measured from its shapes.
 *
 * @param name - Identifier the property is registered under, unique within the part.
 * @param value - The value to publish. Returned unchanged, so the statement
 *   doubles as the declaration of a local: `const w = property('w', ...)`.
 * @param kind - `'length'` marks a number (or number array) in the part
 *   file's unit; consumers in another unit read it rescaled. Untagged
 *   values are handed over verbatim.
 */
export default function property<T extends ParamVal>(name: string, value: T, kind?: PropertyKind): T {
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
  if (kind !== undefined && !PROPERTY_KINDS.has(kind)) {
    throw new Error(
      `property('${name}'): unknown kind ${JSON.stringify(kind)} — the only kind is 'length'.`,
    );
  }
  if (kind === 'length' && !isLengthValue(value)) {
    throw new Error(
      `property('${name}'): a 'length' property must be a finite number or an array of them.`,
    );
  }

  const record: PartProperty = { name, value };
  if (kind) {
    record.kind = kind;
  }
  const sourceLocation = captureSourceLocation();
  if (sourceLocation) {
    record.sourceLocation = sourceLocation;
  }
  part.addProperty(record);
  return value;
}
