import { SceneParserContext, registerBuilder } from "../../index.js";
import { ISceneObject } from "../interfaces.js";
import { type NumberParam, resolveParam } from "../param.js";
import { ConstraintTarget, emitConstraint, requireValue, toRef } from "./common.js";
import type { ConstraintSpec } from "../../sketch-solver/index.js";

/**
 * Dimensions the radius of a circle or arc.
 * @param c - The circle or arc
 * @param value - The radius value
 */
function build(context: SceneParserContext) {
  return function radius(c: ConstraintTarget, value: NumberParam): ISceneObject {
    const resolved = resolveParam(value);
    return emitConstraint(context, 'radius', resolved, (): ConstraintSpec => ({
      kind: 'radius',
      a: toRef(c, 'radius'),
      value: requireValue(resolved, 'radius'),
    }), [c]);
  };
}

export default registerBuilder(build);
