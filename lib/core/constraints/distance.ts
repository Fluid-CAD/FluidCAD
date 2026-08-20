import { SceneParserContext, registerBuilder } from "../../index.js";
import { IDistance } from "../interfaces.js";
import { type NumberParam, resolveParam } from "../param.js";
import { SolvedDistance } from "../../features/2d/constraints/solved/distance.js";
import { SketchDatum } from "../../features/2d/solved/datum.js";
import { SolvedGeometryBase } from "../../features/2d/solved/solved-base.js";
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
      // Line–line distance measures b's midpoint to a's infinite line; an
      // axis datum has no meaningful midpoint, so it always takes the a
      // slot (the measurement is symmetric for a parallel-lines dim, and
      // every other form is order-agnostic).
      let ta = a;
      let tb = b;
      if (tb instanceof SketchDatum && tb.isAxis
        && ta instanceof SolvedGeometryBase && ta.solverKind === 'line') {
        [ta, tb] = [tb, ta];
      }
      const spec: Extract<ConstraintSpec, { kind: 'distance' }> = {
        kind: 'distance',
        a: toRef(ta, 'distance'),
        b: toRef(tb, 'distance'),
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
