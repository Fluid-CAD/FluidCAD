import { expect } from "vitest";
import { SceneObject } from "../../common/scene-object.js";

/**
 * The fields every scene object has that may hold another scene object
 * without it being an operand: its place in the scene, and the fusion scope
 * `.scope()` sets.
 */
const STRUCTURAL_FIELDS = new Set(['_parent', 'children', '_cloneSource', '_fusionScope', 'state']);

/** The scene objects a feature holds in its own fields, directly or in a list. */
function heldObjects(feature: SceneObject): Set<SceneObject> {
  const held = new Set<SceneObject>();
  const collect = (value: unknown, depth: number) => {
    if (value instanceof SceneObject) {
      held.add(value);
    } else if (Array.isArray(value) && depth < 2) {
      value.forEach(entry => collect(entry, depth + 1));
    }
  };
  for (const [key, value] of Object.entries(feature)) {
    if (!STRUCTURAL_FIELDS.has(key)) {
      collect(value, 0);
    }
  }
  return held;
}

/** Another object of the same class holding the same fields: what a repeat's copy of an operand is to the tool. */
function standIn<T extends SceneObject>(operand: T): T {
  return Object.assign(Object.create(Object.getPrototypeOf(operand)), operand) as T;
}

/**
 * Checks that a tool carries each of its chained options through the four
 * methods that must know every option. One missing from any of them breaks
 * `repeat()`, the build cache or the edit dialog with nothing failing.
 *
 * `make` creates the tool with every option at its default, from the same
 * operands on every call. Each entry of `options` sets one option, to a
 * value other than its default, on the instance it is given. For each:
 *
 * - `serialize()` shows the option: the changed instance does not serialize
 *   as the default one does;
 * - `compareTo()` sees it: the changed instance and the default one do not
 *   compare equal, either way round;
 * - `createCopy()` carries it: a copy serializes as the changed instance
 *   and compares equal to it;
 * - a scene object the option hands the tool is among `getDependencies()`,
 *   and `createCopy(remap)` takes the remapped object in its place.
 *
 * No scene is needed and nothing is built.
 */
export function expectOptionsCarried<T extends SceneObject>(
  make: () => T,
  options: Record<string, (feature: T) => void>,
): void {
  expect(make().compareTo(make()), `two default instances compare equal`).toBe(true);

  for (const [name, set] of Object.entries(options)) {
    const base = make();
    const changed = make();
    set(changed);
    const again = make();
    set(again);

    expect(changed.serialize(), `serialize() shows .${name}()`).not.toEqual(base.serialize());

    expect(changed.compareTo(base), `compareTo() sees .${name}() on the instance compared`).toBe(false);
    expect(base.compareTo(changed), `compareTo() sees .${name}() on the other instance`).toBe(false);
    expect(changed.compareTo(again), `two instances with the same .${name}() compare equal`).toBe(true);

    const copy = changed.createCopy(new Map());
    expect(copy.serialize(), `createCopy() carries .${name}() into serialize()`).toEqual(changed.serialize());
    expect(copy.compareTo(changed), `createCopy() carries .${name}(): the copy compares equal`).toBe(true);
    expect(copy.compareTo(base), `createCopy() carries .${name}(): the copy differs from the default`).toBe(false);

    const baseHeld = heldObjects(base);
    const given = [...heldObjects(changed)].filter(object => !baseHeld.has(object));
    const dependencies = changed.getDependencies();
    for (const operand of given) {
      expect(dependencies, `getDependencies() lists the ${operand.getType()} given to .${name}()`).toContain(operand);
    }

    const remap = new Map<SceneObject, SceneObject>(given.map(operand => [operand, standIn(operand)]));
    const remapped = changed.createCopy(remap);
    for (const operand of given) {
      const copied = remapped.getDependencies();
      expect(copied, `createCopy(remap) remaps the ${operand.getType()} given to .${name}()`).toContain(remap.get(operand));
      expect(copied, `createCopy(remap) leaves the original ${operand.getType()} given to .${name}() behind`).not.toContain(operand);
    }
  }
}
