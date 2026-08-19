import { SceneParserContext, registerBuilder } from "../../index.js";
import { ISceneObject } from "../interfaces.js";
import { ConstraintTarget, emitConstraint, toRef } from "./common.js";
import type { ConstraintSpec } from "../../sketch-solver/index.js";

/**
 * Constrains a line to be horizontal, or two points to share a y value.
 * @param a - A line, or the first point
 * @param b - The second point (point-pair form)
 */
function build(context: SceneParserContext) {
  return function horizontal(a: ConstraintTarget, b?: ConstraintTarget): ISceneObject {
    return emitConstraint(context, 'horizontal', undefined, (): ConstraintSpec => (
      b !== undefined
        ? { kind: 'horizontal', a: toRef(a, 'horizontal'), b: toRef(b, 'horizontal') }
        : { kind: 'horizontal', a: toRef(a, 'horizontal') }
    ), [a, b]);
  };
}

export default registerBuilder(build);
