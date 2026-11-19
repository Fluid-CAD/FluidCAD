import { SceneParserContext, registerBuilder } from "../../index.js";
import { IDimension } from "../interfaces.js";
import { SolvedDimension } from "../../features/2d/constraints/solved/dimension.js";
import { type NumberParam, resolveParam } from "../param.js";
import { ConstraintTarget, emitConstraint, requireValue, toRef } from "./common.js";
import type { ConstraintSpec } from "../../sketch-solver/index.js";

/**
 * Dimensions the diameter of a circle or arc.
 * @param c - The circle or arc
 * @param value - The diameter value
 */
function build(context: SceneParserContext) {
  return function diameter(c: ConstraintTarget, value: NumberParam): IDimension {
    const resolved = resolveParam(value);
    return emitConstraint(context, 'diameter', resolved, (): ConstraintSpec => ({
      kind: 'diameter',
      a: toRef(c, 'diameter'),
      value: requireValue(resolved, 'diameter'),
    }), [c], new SolvedDimension('diameter', resolved)) as IDimension;
  };
}

export default registerBuilder(build);
