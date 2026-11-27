import { SceneObject } from "../common/scene-object.js";
import { SelectSceneObject } from "../features/select.js";
import type { SceneParserContext } from "../index.js";

/** One operand argument of a tool's call, as its refusals speak of it. */
export type OperandArgument = {
  /** What it takes, as "must be … or a list of them" says it: `faces, a surface or a solid,`. */
  takes: string;
  /** What an empty list is asked to hold: `the faces to intersect`. */
  wants: string;
};

/**
 * A call whose arguments are operand lists, one per argument — as in
 * `intersect(first, second)` — and the words its refusals use.
 */
export type OperandCall<A extends string> = {
  /** The callee every refusal starts with. */
  callee: string;
  /** The arguments in the order written, by the name the refusals give each. */
  arguments: Readonly<Record<A, OperandArgument>>;
  /** The refusal of a call with fewer arguments. */
  missing: string;
  /** The refusal of a call with more, given how many it has. */
  tooMany: (count: number) => string;
};

/**
 * How a builder reads the operands a tool takes as its arguments — each one
 * scene object, or a non-empty list of them — and adds the tool and its
 * operands to the scene. The words of each refusal are the tool's own.
 */
export class OperandArguments {
  /**
   * The operand lists of a call that takes exactly the named arguments, by
   * name: one object becomes a list of one. Fewer or more arguments than
   * named, an empty list, or an item that is not a scene object is refused.
   */
  static read<A extends string>(args: readonly unknown[], call: OperandCall<A>): Record<A, SceneObject[]> {
    const names = Object.keys(call.arguments) as A[];
    if (args.length < names.length) {
      throw new Error(call.missing);
    }
    if (args.length > names.length) {
      throw new Error(call.tooMany(args.length));
    }
    const lists = {} as Record<A, SceneObject[]>;
    names.forEach((name, i) => {
      lists[name] = OperandArguments.list(args[i], { callee: call.callee, name, ...call.arguments[name] });
    });
    return lists;
  }

  /**
   * One argument as a list of scene objects: the object itself, or the
   * items of a list. An empty list, or an item that is not a scene object,
   * is refused, naming the argument.
   */
  static list(arg: unknown, at: OperandArgument & { callee: string; name: string }): SceneObject[] {
    const list: unknown[] = Array.isArray(arg) ? arg : [arg];
    if (list.length === 0) {
      throw new Error(`${at.callee}: the ${at.name} argument is an empty list; give it ${at.wants}.`);
    }
    for (const item of list) {
      if (!(item instanceof SceneObject)) {
        throw new Error(`${at.callee}: the ${at.name} argument must be ${at.takes} or a list of them; got ${OperandArguments.describe(item)}.`);
      }
    }
    return list as SceneObject[];
  }

  /**
   * Adds a tool made by `create` to the scene after its operands, so they
   * build before it, then claims the selections among them with the tool's
   * own location: `registerBuilder` claims a selection passed bare, but not
   * one inside a list.
   */
  static addTool<T extends SceneObject>(context: SceneParserContext, operands: SceneObject[], create: () => T): T {
    context.addSceneObjects(operands);
    const tool = create();
    context.addSceneObject(tool);
    SelectSceneObject.claimOperands(operands, tool.getSourceLocation());
    return tool;
  }

  /** A value that is not a scene object, as a refusal names it. */
  private static describe(value: unknown): string {
    if (value === null || value === undefined) {
      return String(value);
    }
    if (typeof value === 'string') {
      return `'${value}'`;
    }
    return Array.isArray(value) ? 'a nested list' : typeof value === 'object' ? 'an object' : String(value);
  }
}
