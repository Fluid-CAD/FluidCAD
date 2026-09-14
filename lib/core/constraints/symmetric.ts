import { SceneParserContext, registerBuilder } from "../../index.js";
import { ISceneObject } from "../interfaces.js";
import { ConstraintTarget, emitConstraint, toRef } from "./common.js";
import type { ConstraintSpec } from "../../sketch-solver/index.js";

/**
 * Constrains a and b to mirror across line l: two points (2 dims), or two
 * entities of one kind — two lines (4), two circles (3: centers mirror,
 * equal radii), two arcs (5: centers and starts mirror, the ends reflect).
 * The entity forms are what the sketch Mirror tool writes, one statement
 * per mirrored entity.
 * @param a - The first point or entity
 * @param b - The second point or entity (same kind as a)
 * @param l - The mirror line — a sketched line or `xAxis()` / `yAxis()`
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
