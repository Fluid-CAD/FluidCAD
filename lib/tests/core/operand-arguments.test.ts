import { describe, it, expect } from "vitest";
import { SceneObject } from "../../common/scene-object.js";
import { SelectSceneObject } from "../../features/select.js";
import { OperandArguments, type OperandCall } from "../../core/operand-arguments.js";
import type { SceneParserContext } from "../../index.js";

/** A scene object with nothing to build. */
class Plain extends SceneObject {
  override getType(): string {
    return "plain";
  }

  override build(): void {}

  serialize() {
    return {};
  }
}

/** A call of two operand arguments, worded as a fixture. */
const JOIN: OperandCall<'left' | 'right'> = {
  callee: 'join',
  arguments: {
    left: { takes: 'curves,', wants: 'the curves to join' },
    right: { takes: 'faces,', wants: 'the faces to join onto' },
  },
  missing: 'join: give two arguments.',
  tooMany: count => `join: takes two arguments, got ${count}.`,
};

describe("OperandArguments.read", () => {
  const a = new Plain();
  const b = new Plain();
  const c = new Plain();

  it("reads each argument by name, one object as a list of one and a list as its items", () => {
    expect(OperandArguments.read([a, [b, c]], JOIN)).toEqual({ left: [a], right: [b, c] });
  });

  it("refuses too few and too many arguments in the call's own words", () => {
    expect(() => OperandArguments.read([a], JOIN)).toThrow("join: give two arguments.");
    expect(() => OperandArguments.read([a, b, c], JOIN)).toThrow("join: takes two arguments, got 3.");
  });

  it("refuses an empty list, naming the argument and what it is asked to hold", () => {
    expect(() => OperandArguments.read([a, []], JOIN)).toThrow("join: the right argument is an empty list; give it the faces to join onto.");
  });

  it("refuses an item that is not a scene object, naming the argument, what it takes and what it got", () => {
    const got = (value: unknown) => {
      try {
        OperandArguments.read([value, b], JOIN);
      } catch (error) {
        return (error as Error).message;
      }
      throw new Error("expected a refusal");
    };
    expect(got(3)).toBe("join: the left argument must be curves, or a list of them; got 3.");
    expect(got('xy')).toBe("join: the left argument must be curves, or a list of them; got 'xy'.");
    expect(got(null)).toBe("join: the left argument must be curves, or a list of them; got null.");
    expect(got(undefined)).toBe("join: the left argument must be curves, or a list of them; got undefined.");
    expect(got({})).toBe("join: the left argument must be curves, or a list of them; got an object.");
    expect(got([a, [b]])).toBe("join: the left argument must be curves, or a list of them; got a nested list.");
  });
});

describe("OperandArguments.list", () => {
  it("reads one argument on its own, in the words given", () => {
    const a = new Plain();
    const at = { callee: 'offset', name: 'edges', takes: 'edges,', wants: 'the edges to offset' };
    expect(OperandArguments.list(a, at)).toEqual([a]);
    expect(() => OperandArguments.list([], at)).toThrow("offset: the edges argument is an empty list; give it the edges to offset.");
  });
});

describe("OperandArguments.addTool", () => {
  it("adds the operands, then the tool it creates, and claims the selections among them", () => {
    const order: string[] = [];
    const context = {
      addSceneObjects: (objects: SceneObject[]) => order.push(`operands ${objects.length}`),
      addSceneObject: (object: SceneObject) => order.push(object.getType()),
    } as Pick<SceneParserContext, 'addSceneObjects' | 'addSceneObject'> as SceneParserContext;
    const selection = new SelectSceneObject([]);
    const other = new Plain();

    const tool = OperandArguments.addTool(context, [other, selection], () => {
      order.push('created');
      return new Plain();
    });

    expect(tool).toBeInstanceOf(Plain);
    expect(order).toEqual(['operands 2', 'created', 'plain']);
    expect(selection.isClaimed()).toBe(true);
  });
});
