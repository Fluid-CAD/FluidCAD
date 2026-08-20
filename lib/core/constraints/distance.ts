import { SceneParserContext, registerBuilder } from "../../index.js";
import { IDistance } from "../interfaces.js";
import { type NumberParam, resolveParam } from "../param.js";
import { SolvedDistance } from "../../features/2d/constraints/solved/distance.js";
import {
  ConstraintTarget, emitConstraint, isRoundEntityTarget, requireValue, toRef,
} from "./common.js";
import type { ConstraintSpec } from "../../sketch-solver/index.js";

/**
 * Distance dimension. Forms by what the targets resolve to: point–point
 * (optionally measured along one axis), point–line (perpendicular),
 * point–circle/arc (to the circumference), line–line (pair with parallel),
 * line–circle/arc (perpendicular to the circumference), circle–circle
 * (gap between circumferences). Circle/arc measurements take the NEAR
 * side of the circumference by default; chain `.max()` for the far side.
 * @param a - First point/entity
 * @param b - Second point/entity
 * @param value - The distance value
 * @param axis - Optional 'x' or 'y' to measure along one axis (point–point)
 */
function build(context: SceneParserContext) {
  return function distance(
    a: ConstraintTarget,
    b: ConstraintTarget,
    value: NumberParam,
    axis?: 'x' | 'y',
  ): IDistance {
    const resolved = resolveParam(value);
    const hasRound = isRoundEntityTarget(a) || isRoundEntityTarget(b);
    const statement = new SolvedDistance(resolved, hasRound);
    return emitConstraint(context, 'distance', resolved, (): ConstraintSpec => {
      if (axis !== undefined && axis !== 'x' && axis !== 'y') {
        throw new Error(`distance: axis must be 'x' or 'y', got '${axis}'`);
      }
      const spec: Extract<ConstraintSpec, { kind: 'distance' }> = {
        kind: 'distance',
        a: toRef(a, 'distance'),
        b: toRef(b, 'distance'),
        value: requireValue(resolved, 'distance'),
      };
      if (axis !== undefined) {
        spec.axis = axis;
      }
      return spec;
    }, [a, b], statement) as IDistance;
  };
}

export default registerBuilder(build);
