import { SceneObject } from "./scene-object.js";

/**
 * The operands a tool takes, as the four methods that carry them read them
 * (`getDependencies`, `createCopy`, `compareTo`, `serialize`): an
 * argument's list, in the order written, and an object a chained method
 * holds, null while the method is left out (`.direction(…)`). One wording
 * of each, so a tool's methods name its operands and nothing else, and an
 * operand missing from one of them stands out.
 */
export class Operands {
  /**
   * Every operand of the lists and the single slots, in the order given,
   * the empty slots left out: what `getDependencies()` answers.
   */
  static all(...slots: (readonly SceneObject[] | SceneObject | null)[]): SceneObject[] {
    return slots.flatMap(slot => slot === null ? [] : slot instanceof SceneObject ? [slot] : [...slot]);
  }

  /** Whether two lists hold the same operands in the same order, each pair by `compareTo`. */
  static same(a: readonly SceneObject[], b: readonly SceneObject[]): boolean {
    return a.length === b.length && a.every((operand, i) => operand.compareTo(b[i]));
  }

  /** Whether two single slots are both empty, or hold operands that `compareTo` each other. */
  static sameOne(a: SceneObject | null, b: SceneObject | null): boolean {
    return a === null || b === null ? a === b : a.compareTo(b);
  }

  /** The list for a copy (`createCopy`): each operand replaced by its copy where `remap` has one. */
  static remap(list: readonly SceneObject[], remap: Map<SceneObject, SceneObject>): SceneObject[] {
    return list.map(operand => remap.get(operand) ?? operand);
  }

  /** A single slot for a copy: its operand's copy where `remap` has one; empty stays empty. */
  static remapOne(operand: SceneObject | null, remap: Map<SceneObject, SceneObject>): SceneObject | null {
    return operand === null ? null : remap.get(operand) ?? operand;
  }

  /** The list as `serialize()` writes it: each operand's own serialization, in order. */
  static serialize(list: readonly SceneObject[]): unknown[] {
    return list.map(operand => operand.serialize());
  }

  /** A single slot as `serialize()` writes it: its operand's serialization, or null when empty. */
  static serializeOne(operand: SceneObject | null): unknown {
    return operand === null ? null : operand.serialize();
  }
}
