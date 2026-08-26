import { SceneParserContext, registerBuilder } from "../../index.js";
import { ISceneObject } from "../interfaces.js";
import { ConstraintTarget, emitConstraint, toRef } from "./common.js";
import type { ConstraintSpec } from "../../sketch-solver/index.js";

/**
 * Constrains a line to be horizontal, or two or more points to share a
 * y value. Every point after the first is aligned to the first.
 * @param a - A line, or the first point
 * @param b - The second point (point form)
 * @param rest - Further points to align to the first
 */
function build(context: SceneParserContext) {
  return function horizontal(
    a: ConstraintTarget,
    b?: ConstraintTarget,
    ...rest: ConstraintTarget[]
  ): ISceneObject {
    return emitConstraint(context, 'horizontal', undefined, (): ConstraintSpec => (
      b !== undefined
        ? {
            kind: 'horizontal', a: toRef(a, 'horizontal'), b: toRef(b, 'horizontal'),
            ...(rest.length > 0 ? { others: rest.map(t => toRef(t, 'horizontal')) } : {}),
          }
        : { kind: 'horizontal', a: toRef(a, 'horizontal') }
    ), [a, b, ...rest]);
  };
}

export default registerBuilder(build);
