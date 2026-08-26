import { SceneParserContext, registerBuilder } from "../../index.js";
import { ISceneObject } from "../interfaces.js";
import { ConstraintTarget, emitConstraint, toRef } from "./common.js";
import type { ConstraintSpec } from "../../sketch-solver/index.js";

/**
 * Constrains a line to be vertical, or two or more points to share an
 * x value. Every point after the first is aligned to the first.
 * @param a - A line, or the first point
 * @param b - The second point (point form)
 * @param rest - Further points to align to the first
 */
function build(context: SceneParserContext) {
  return function vertical(
    a: ConstraintTarget,
    b?: ConstraintTarget,
    ...rest: ConstraintTarget[]
  ): ISceneObject {
    return emitConstraint(context, 'vertical', undefined, (): ConstraintSpec => (
      b !== undefined
        ? {
            kind: 'vertical', a: toRef(a, 'vertical'), b: toRef(b, 'vertical'),
            ...(rest.length > 0 ? { others: rest.map(t => toRef(t, 'vertical')) } : {}),
          }
        : { kind: 'vertical', a: toRef(a, 'vertical') }
    ), [a, b, ...rest]);
  };
}

export default registerBuilder(build);
