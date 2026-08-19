import { SceneParserContext, registerBuilder } from "../../index.js";
import { rad } from "../../helpers/math-helpers.js";
import { ISceneObject } from "../interfaces.js";
import { type NumberParam, resolveParam } from "../param.js";
import { ConstraintTarget, emitConstraint, requireValue, toRef } from "./common.js";
import type { ConstraintSpec } from "../../sketch-solver/index.js";

/**
 * Dimensions the counterclockwise angle from line a to line b, in degrees
 * (0–360). Each argument is a line or one of its endpoint accessors, which
 * orients the line toward that endpoint — `angle(l1, l2.start(), 45)`
 * measures to l2 pointing at its start. A bare line points at its end.
 * There are no negative angles: a clockwise angle is the counterclockwise
 * angle of the swapped pair.
 * @param a - The first line, optionally oriented via .start()/.end()
 * @param b - The second line, optionally oriented via .start()/.end()
 * @param degrees - The angle in degrees, 0 (inclusive) to 360 (exclusive)
 */
function build(context: SceneParserContext) {
  return function angle(a: ConstraintTarget, b: ConstraintTarget, degrees: NumberParam): ISceneObject {
    const value = resolveParam(degrees);
    return emitConstraint(context, 'angle', value, (): ConstraintSpec => {
      const deg = requireValue(value, 'angle');
      if (deg < 0) {
        throw new Error(
          `angle: expected degrees in [0, 360) — there are no negative angles; ` +
          `a clockwise angle is the counterclockwise angle of the swapped pair: angle(b, a, ${-deg})`,
        );
      }
      if (deg >= 360) {
        throw new Error(`angle: expected degrees in [0, 360), got ${deg}`);
      }
      return {
        kind: 'angle',
        a: toRef(a, 'angle'),
        b: toRef(b, 'angle'),
        value: rad(deg),
      };
    }, [a, b]);
  };
}

export default registerBuilder(build);
