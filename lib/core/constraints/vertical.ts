import { SceneParserContext, registerBuilder } from "../../index.js";
import { ISceneObject } from "../interfaces.js";
import { ConstraintTarget, emitConstraint, toRef } from "./common.js";
import type { ConstraintSpec } from "../../sketch-solver/index.js";

/**
 * Constrains a line to be vertical, or two points to share an x value.
 * @param a - A line, or the first point
 * @param b - The second point (point-pair form)
 */
function build(context: SceneParserContext) {
  return function vertical(a: ConstraintTarget, b?: ConstraintTarget): ISceneObject {
    return emitConstraint(context, 'vertical', undefined, (): ConstraintSpec => (
      b !== undefined
        ? { kind: 'vertical', a: toRef(a, 'vertical'), b: toRef(b, 'vertical') }
        : { kind: 'vertical', a: toRef(a, 'vertical') }
    ), [a, b]);
  };
}

export default registerBuilder(build);
