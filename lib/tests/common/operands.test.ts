import { describe, it, expect } from "vitest";
import { SceneObject } from "../../common/scene-object.js";
import { Operands } from "../../common/operands.js";

/** A scene object that stands for its key: two with one key compare equal. */
class Tagged extends SceneObject {
  constructor(readonly key: string) {
    super();
  }

  override getType(): string {
    return "tagged";
  }

  override build(): void {}

  override compareTo(other: SceneObject): boolean {
    return other instanceof Tagged && super.compareTo(other) && other.key === this.key;
  }

  serialize() {
    return { key: this.key };
  }
}

describe("Operands", () => {
  const a = new Tagged("a");
  const b = new Tagged("b");
  const c = new Tagged("c");

  it("lists every operand of the lists and the single slots in order, the empty slots left out", () => {
    expect(Operands.all([a, b], null, c, [])).toEqual([a, b, c]);
    expect(Operands.all()).toEqual([]);
  });

  it("compares lists pair by pair, in order and in length", () => {
    expect(Operands.same([a, b], [new Tagged("a"), new Tagged("b")])).toBe(true);
    expect(Operands.same([a, b], [b, a])).toBe(false);
    expect(Operands.same([a, b], [a])).toBe(false);
    expect(Operands.same([], [])).toBe(true);
  });

  it("compares single slots: both empty, or holding operands that compare", () => {
    expect(Operands.sameOne(null, null)).toBe(true);
    expect(Operands.sameOne(a, null)).toBe(false);
    expect(Operands.sameOne(null, a)).toBe(false);
    expect(Operands.sameOne(a, new Tagged("a"))).toBe(true);
    expect(Operands.sameOne(a, b)).toBe(false);
  });

  it("remaps each operand that has a copy and keeps the others", () => {
    const copyOfA = new Tagged("a'");
    const remap = new Map<SceneObject, SceneObject>([[a, copyOfA]]);
    const list = [a, b];

    expect(Operands.remap(list, remap)).toEqual([copyOfA, b]);
    expect(Operands.remap(list, remap)).not.toBe(list);
    expect(Operands.remapOne(a, remap)).toBe(copyOfA);
    expect(Operands.remapOne(b, remap)).toBe(b);
    expect(Operands.remapOne(null, remap)).toBeNull();
  });

  it("serializes a list operand by operand and a single slot as its operand, or null", () => {
    expect(Operands.serialize([a, b])).toEqual([{ key: "a" }, { key: "b" }]);
    expect(Operands.serializeOne(c)).toEqual({ key: "c" });
    expect(Operands.serializeOne(null)).toBeNull();
  });
});
