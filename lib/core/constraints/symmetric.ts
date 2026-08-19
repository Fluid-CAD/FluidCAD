import { SceneParserContext, registerBuilder } from "../../index.js";
import { ISceneObject } from "../interfaces.js";
import { ConstraintTarget, emitConstraint, toRef } from "./common.js";
import type { ConstraintSpec } from "../../sketch-solver/index.js";

/**
 * Constrains points a and b to mirror across line l (2 dims).
 * @param a - The first point
 * @param b - The second point
 * @param l - The mirror line
 */
function build(context: SceneParserContext) {
  return function symmetric(a: ConstraintTarget, b: ConstraintTarget, l: ConstraintTarget): ISceneObject {
    return emitConstraint(context, 'symmetric', undefined, (): ConstraintSpec => ({
      kind: 'symmetric',
      a: toRef(a, 'symmetric'),
      b: toRef(b, 'symmetric'),
      l: toRef(l, 'symmetric'),
    }), [a, b, l]);
  };
}

export default registerBuilder(build);
