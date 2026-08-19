import { SceneParserContext, registerBuilder } from "../../index.js";
import { rad } from "../../helpers/math-helpers.js";
import { ISceneObject } from "../interfaces.js";
import { type NumberParam, resolveParam } from "../param.js";
import { ConstraintTarget, emitConstraint, requireValue, toRef } from "./common.js";
import type { ConstraintSpec } from "../../sketch-solver/index.js";

/**
 * Dimensions the directed angle from line a to line b.
 * @param a - The first line
 * @param b - The second line
 * @param degrees - The angle in degrees
 */
function build(context: SceneParserContext) {
  return function angle(a: ConstraintTarget, b: ConstraintTarget, degrees: NumberParam): ISceneObject {
    const value = resolveParam(degrees);
    return emitConstraint(context, 'angle', value, (): ConstraintSpec => ({
      kind: 'angle',
      a: toRef(a, 'angle'),
      b: toRef(b, 'angle'),
      value: rad(requireValue(value, 'angle')),
    }), [a, b]);
  };
}

export default registerBuilder(build);
